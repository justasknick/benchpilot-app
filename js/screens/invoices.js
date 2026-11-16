// Invoices (migration 0055, staffing F2): an invoice tracker, not an accounting system. An invoice is made from a placement's approved
// timesheet weeks x its hourly bill rate (overtime at its own rate), due on the invoice date + the vendor's net terms (P6, default Net 30).
// Status draft -> sent -> paid; overdue = sent and past the due date (never stored). The printable invoice carries the firm's details
// (team branding); "Print or save as PDF" is the browser's own print dialog and "Email draft" opens the person's mail app: BenchPilot never
// sends an invoice. The CSV (one line per invoice line) imports into QuickBooks, Zoho Books or Tally. Owners and managers (perms 'invoices';
// RLS invoices_*). Team plans (plan-gate 'invoicing'). Every rule is lib/invoicing.js (BP.Invoices).

import { h, clear } from '../dom.js';
import { pageHeader, card, table, chip, empty, emptyState, button, toast, select, field, input, note, lockNote, plural } from '../ui.js';
import { loadDraftLib } from '../bp-lib.js';
import { FEATURE_FROM } from '../plan-gate.js';
import { placementInfo, placementLabel, invoicingOn, money, hoursText, INVOICE_KIND, invoiceDocument, emailDraftLink, downloadText, csvText, printInvoice } from '../invoicing-ui.js';

export async function render(ctx) {
  if (!invoicingOn(ctx)) {
    return h('div', { class: 'stack' }, pageHeader('Invoices', 'Invoices from approved timesheets, and who still owes you'),
      card('Timesheets, invoices and commission', lockNote(ctx, { badge: FEATURE_FROM.invoicing,
        text: 'Turn approved weeks into invoices with the vendor’s net terms, see what is overdue, print or save a PDF, and export for QuickBooks, Zoho Books or Tally. Included from ' + FEATURE_FROM.invoicing + '.', plan: true })));
  }
  if (!ctx.can('invoices')) {
    return h('div', { class: 'stack' }, pageHeader('Invoices', 'Invoices from approved timesheets'),
      card(null, lockNote(ctx, { badge: 'Owners and managers', text: 'Invoices are kept by the owner and managers. Record the weekly hours on Timesheets; they turn the approved weeks into invoices.' })));
  }
  const BP = await loadDraftLib();
  const I = BP.Invoices, T = BP.Timesheets;
  ctx.lk.requirements = ctx.lk.requirements || await ctx.store.listRequirements();
  const [placements, submissions, sheets, invoices, profile] = await Promise.all([ctx.store.listPlacements(), ctx.store.listSubmissions({}),
    ctx.store.listTimesheets({}), ctx.store.listInvoices(), ctx.store.getInvoiceProfile()]);
  const today = ctx.session.today;
  const info = placementInfo(ctx, placements, submissions);
  // An invoice whose placement is no longer listed (fell through later) still shows, with what the invoice itself says.
  const byId = new Map(placementInfo(ctx, placements.map((p) => ({ ...p, status: p.status === 'fell_through' ? 'ended' : p.status })), submissions).map((r) => [r.id, r]));
  const canWrite = ctx.can('manage_invoices');
  const view = { status: ['draft', 'sent', 'overdue', 'paid'].includes(ctx.route.params.status) ? ctx.route.params.status : '', dateFormat: 'us' };

  if (ctx.route.params.print) return printView(ctx, BP, invoices.find((i) => i.id === ctx.route.params.print), byId, profile);

  const formBox = h('div');
  const listBox = h('div', { 'aria-live': 'polite' });

  // Ready to invoice: approved weeks not on an invoice, per placement.
  const ready = info.map((r) => ({ ...r, weeks: I.invoiceable(sheets.filter((t) => t.placementId === r.id), {}) })).filter((r) => r.weeks.length);
  const numbers = invoices.map((i) => i.number);

  function openCreate(r) {
    clear(formBox);
    const p = r.placement;
    const hours = T.hoursTotal(r.weeks);
    const el = {
      number: input({ value: I.nextNumber(numbers, { prefix: profile.prefix, today }), maxlength: String(I.NUMBER_MAX), class: 'mono' }),
      issuedOn: input({ type: 'date', value: today }),
      otRate: input({ inputmode: 'decimal', value: p.billRate ? String(p.billRate) : '', class: 'rate-in' })
    };
    const preview = h('p', { class: 'inv-preview', 'aria-live': 'polite' });
    const paint = () => {
      const b = I.buildInvoice({ placement: p, timesheets: r.weeks, vendor: r.vendor, number: el.number.value || 'x', issuedOn: el.issuedOn.value, otRate: el.otRate.value, today });
      preview.textContent = b.ok ? `${plural(r.weeks.length, 'week')}, ${hoursText(b.invoice.regularHours)} regular${b.invoice.otHours ? ' and ' + hoursText(b.invoice.otHours) + ' overtime' : ''}: ${money(b.invoice.amount)}, due ${BP.Submissions.dayLabel(b.invoice.dueOn)} (Net ${b.invoice.netTerms}).` : b.error;
    };
    for (const k of ['number', 'issuedOn', 'otRate']) el[k].addEventListener('input', paint);
    const msg = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create invoice');
    const form = h('form', { class: 'inv-form', novalidate: true, 'aria-label': 'New invoice for ' + r.consultantName },
      h('h3', { class: 'form-title' }, 'New invoice: ' + placementLabel(r)),
      h('p', { class: 'muted' }, `The approved weeks not invoiced yet: ${r.weeks.map((w) => T.weekLabel(w.weekStart)).join(', ')} (${hoursText(hours.total)}). Bill rate ${BP.Submissions.rateText(p.billRate, p.rateUnit) || 'not set'}.`),
      h('div', { class: 'grid' }, field('Invoice number', el.number), field('Invoice date', el.issuedOn),
        field('Overtime rate ($/h)', el.otRate, { hint: 'The bill rate unless your agreement says otherwise.' })),
      preview, msg,
      h('div', { class: 'row-end' }, button('Cancel', { variant: 'ghost', onclick: () => clear(formBox) }), save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(msg);
      const b = I.buildInvoice({ placement: p, timesheets: r.weeks, vendor: r.vendor, number: el.number.value, issuedOn: el.issuedOn.value, otRate: el.otRate.value, today });
      if (!b.ok) { msg.append(note('danger', b.error)); return; }
      save.disabled = true;
      try {
        const inv = await ctx.store.createInvoice({ placementId: p.id, number: b.invoice.number, issuedOn: b.invoice.issuedOn, otRate: el.otRate.value });
        toast(`Invoice ${inv.number} created as a draft.`); ctx.refresh();
      } catch (err) { msg.append(note('danger', err.message)); save.disabled = false; }
    });
    paint();
    formBox.append(card(null, form, { class: 'form-card' }));
    el.number.focus();
  }

  async function setStatus(inv, status) {
    const u = I.updateInvoice(inv, { status }, { today });
    if (!u.ok) { toast(u.error); return; }
    try { await ctx.store.updateInvoice(inv.id, u.invoice); toast(status === 'paid' ? `Invoice ${inv.number} marked paid today.` : status === 'sent' ? `Invoice ${inv.number} marked sent.` : `Invoice ${inv.number} is a draft again.`); ctx.refresh(); }
    catch (err) { toast(err.message); }
  }
  function openPaid(inv) {
    clear(formBox);
    const paidOn = input({ type: 'date', value: today });
    const msg = h('div', { 'aria-live': 'polite' });
    const form = h('form', { class: 'inv-form', novalidate: true, 'aria-label': 'Payment received for ' + inv.number },
      h('h3', { class: 'form-title' }, `Payment received: ${inv.number} (${money(inv.amount)})`),
      h('div', { class: 'grid' }, field('Payment received on', paidOn)), msg,
      h('div', { class: 'row-end' }, button('Cancel', { variant: 'ghost', onclick: () => clear(formBox) }), h('button', { type: 'submit', class: 'btn btn-primary' }, 'Mark paid')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(msg);
      const u = I.updateInvoice(inv, { status: 'paid', paidOn: paidOn.value }, { today });
      if (!u.ok) { msg.append(note('danger', u.error)); return; }
      try { await ctx.store.updateInvoice(inv.id, u.invoice); toast(`Invoice ${inv.number} marked paid.`); ctx.refresh(); } catch (err) { msg.append(note('danger', err.message)); }
    });
    formBox.append(card(null, form, { class: 'form-card' }));
    paidOn.focus();
  }
  async function remove(inv) {
    if (!window.confirm(`Remove invoice ${inv.number}? Its weeks can be invoiced again.`)) return;
    try { await ctx.store.deleteInvoice(inv.id); toast(`Invoice ${inv.number} removed. Its weeks are free again.`); ctx.refresh(); } catch (err) { toast(err.message); }
  }

  const s = I.summary(invoices, today);
  const readyHours = ready.reduce((a, r) => a + T.hoursTotal(r.weeks).total, 0);
  const tile = (n, label, sub, kind) => h('div', { class: 'tile' + (kind ? ' tile-' + kind : '') }, h('span', { class: 'tile-num' }, String(n)), h('span', { class: 'tile-label' }, label), sub ? h('span', { class: 'tile-hint' }, sub) : null);
  const tiles = h('div', { class: 'tiles tiles--4' },
    tile(money(s.outstanding), 'Outstanding', plural(s.sentCount, 'invoice') + ' sent, not paid'),
    tile(money(s.overdue), 'Overdue', s.overdueCount ? plural(s.overdueCount, 'invoice') + ' past the due date' : 'Nothing overdue', s.overdueCount ? 'danger' : ''),
    tile(money(s.paidThisMonth), 'Paid this month', plural(s.paidCount, 'invoice')),
    tile(hoursText(readyHours), 'Ready to invoice', plural(ready.length, 'placement')));

  const readyCard = ready.length ? card('Ready to invoice', table([
    { label: 'Placement', cell: (r) => h('div', null, h('span', { class: 'strong' }, r.consultantName), h('div', { class: 'muted' }, [...new Set([r.endClient, r.vendorName].filter(Boolean))].join(' · '))) },
    { label: 'Approved weeks', cell: (r) => r.weeks.length === 1 ? T.weekLabel(r.weeks[0].weekStart) : `${T.weekLabel(r.weeks[0].weekStart).split(' - ')[0]} to ${T.weekLabel(r.weeks[r.weeks.length - 1].weekStart).split(' - ')[1]} (${r.weeks.length})` },
    { label: 'Hours', class: 'num', cell: (r) => h('span', { class: 'mono' }, hoursText(T.hoursTotal(r.weeks).total)) },
    { label: 'About', class: 'num', cell: (r) => { const b = I.buildInvoice({ placement: r.placement, timesheets: r.weeks, vendor: r.vendor, number: 'x', today }); return b.ok ? h('span', { class: 'mono' }, money(b.invoice.amount)) : h('span', { class: 'muted' }, b.error); } },
    { label: '', class: 'right', cell: (r) => button('Create invoice', { variant: 'secondary', disabled: !canWrite, 'aria-label': 'Create an invoice for ' + r.consultantName, onclick: () => openCreate(r) }) }
  ], ready, { caption: 'Placements with approved weeks not invoiced yet' })) : null;

  function drawList() {
    clear(listBox);
    if (!invoices.length) {
      listBox.append(emptyState({ icon: 'file', title: 'No invoices yet', text: ready.length ? 'Create the first one from the approved weeks above.' : 'Approve some timesheet weeks first. They show above, ready to invoice.',
        action: h('a', { class: 'btn btn-secondary', href: '#timesheets' }, 'Open timesheets') }));
      return;
    }
    const rows = invoices.filter((i) => !view.status || I.invoiceStatus(i, today) === view.status);
    listBox.append(rows.length ? table([
      { label: 'Invoice', class: 'nowrap', cell: (i) => h('a', { href: '#invoices?print=' + i.id, class: 'strong mono' }, i.number) },
      { label: 'Placement', cell: (i) => { const r = byId.get(i.placementId); return r ? h('div', null, r.consultantName, h('div', { class: 'muted' }, r.vendorName || 'No vendor')) : h('span', { class: 'muted' }, 'Removed placement'); } },
      { label: 'Period', class: 'nowrap', cell: (i) => h('div', null, BP.Submissions.dayLabel(i.periodFrom), h('div', { class: 'muted' }, 'to ' + BP.Submissions.dayLabel(i.periodTo))) },
      { label: 'Amount', class: 'num', cell: (i) => h('div', null, h('span', { class: 'mono strong' }, money(i.amount)), h('div', { class: 'muted' }, hoursText(i.regularHours + i.otHours))) },
      { label: 'Due', class: 'nowrap', cell: (i) => h('div', null, BP.Submissions.dayLabel(i.dueOn), h('div', { class: 'muted' }, 'Net ' + i.netTerms)) },
      { label: 'Status', cell: (i) => { const st = I.invoiceStatus(i, today); return h('div', null, chip(I.STATUS_LABELS[st], INVOICE_KIND[st]), st === 'paid' && i.paidOn ? h('div', { class: 'muted' }, 'on ' + BP.Submissions.dayLabel(i.paidOn)) : null); } },
      { label: '', class: 'right', cell: (i) => {
        const st = I.invoiceStatus(i, today);
        return h('div', { class: 'row-end inv-actions' },
          h('a', { class: 'btn btn-ghost', href: '#invoices?print=' + i.id, 'aria-label': 'Open invoice ' + i.number + ' to print' }, 'Print'),
          st === 'draft' ? button('Mark sent', { variant: 'secondary', disabled: !canWrite, onclick: () => setStatus(i, 'sent') }) : null,
          st === 'sent' || st === 'overdue' ? button('Mark paid', { variant: 'secondary', disabled: !canWrite, onclick: () => openPaid(i) }) : null,
          st === 'paid' ? button('Undo paid', { variant: 'ghost', disabled: !canWrite, onclick: () => setStatus(i, 'sent') }) : null,
          canWrite ? button('Remove', { variant: 'ghost', 'aria-label': 'Remove invoice ' + i.number, onclick: () => remove(i) }) : null);
      } }
    ], rows, { caption: 'Invoices, newest first' }) : empty('No invoice matches this filter.'));
  }

  function exportCsv() {
    if (!ctx.can('export')) { toast('Your workspace owner has turned off exports for your role.'); return; }
    if (!invoices.length) { toast('No invoices to export yet.'); return; }
    const rows = I.csvRows(invoices.map((inv) => { const r = byId.get(inv.placementId) || {}; return { invoice: inv, consultantName: r.consultantName, vendorName: r.vendorName, endClient: r.endClient, role: r.role, poRef: r.poRef }; }),
      { dateFormat: view.dateFormat, today });
    downloadText(csvText(rows, I.CSV_HEADERS), `benchpilot_invoices_${today}.csv`);
    toast(`Exported ${plural(invoices.length, 'invoice')}.`);
  }

  function profileCard() {
    const P = I.PROFILE_LIMITS;
    const el = {
      companyName: input({ value: profile.companyName || '', maxlength: String(P.companyName) }),
      prefix: input({ value: profile.prefix, maxlength: String(P.prefix), class: 'mono rate-in' }),
      email: input({ type: 'email', value: profile.email || '', maxlength: String(P.email), placeholder: 'accounts@yourfirm.com' }),
      phone: input({ value: profile.phone || '', maxlength: String(P.phone) }),
      taxId: input({ value: profile.taxId || '', maxlength: String(P.taxId), placeholder: 'EIN, GSTIN or PAN' }),
      address: h('textarea', { rows: 3, maxlength: String(P.address) }, profile.address || ''),
      paymentDetails: h('textarea', { rows: 3, maxlength: String(P.paymentDetails), placeholder: 'Bank, ACH or wire details printed on every invoice' }, profile.paymentDetails || '')
    };
    if (!canWrite) for (const x of Object.values(el)) x.disabled = true;
    const msg = h('div', { 'aria-live': 'polite' });
    const form = h('form', { class: 'inv-profile', novalidate: true, 'aria-label': 'Your invoice details' },
      h('div', { class: 'grid' }, field('Company name', el.companyName), field('Invoice number prefix', el.prefix, { hint: 'For example INV- or NW-' }),
        field('Billing email', el.email), field('Phone', el.phone), field('Tax ID', el.taxId),
        field('Address', el.address, { wide: true }), field('Payment details', el.paymentDetails, { wide: true })),
      msg, canWrite ? h('div', { class: 'row-end' }, h('button', { type: 'submit', class: 'btn btn-secondary' }, 'Save invoice details')) : null);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(msg);
      const c = I.cleanProfile(Object.fromEntries(Object.entries(el).map(([k, x]) => [k, x.value])));
      if (!c.ok) { msg.append(note('danger', c.error)); return; }
      try { await ctx.store.saveInvoiceProfile(c.profile); toast('Invoice details saved.'); ctx.refresh(); } catch (err) { msg.append(note('danger', err.message)); }
    });
    const details = h('details', { class: 'inv-profile-box', open: !profile.address && !profile.paymentDetails ? true : null },
      h('summary', null, 'Your invoice details', h('span', { class: 'muted' }, profile.address || profile.paymentDetails ? ' · printed on every invoice' : ' · add them before you print the first invoice')), form);
    return card(null, details);
  }

  const filters = h('div', { class: 'filters' },
    field('Status', select({ '': 'All', draft: 'Draft', sent: 'Sent', overdue: 'Overdue', paid: 'Paid' }, view.status, { onchange: (e) => { view.status = e.target.value; drawList(); } })),
    field('CSV dates', select(I.DATE_FORMATS, view.dateFormat, { onchange: (e) => { view.dateFormat = e.target.value; } })));
  drawList();
  return h('div', { class: 'stack' },
    pageHeader('Invoices', 'Invoices from approved timesheets, and who still owes you',
      button('Export CSV', { variant: 'secondary', disabled: !ctx.can('export'), title: ctx.can('export') ? 'One line per invoice line, for QuickBooks, Zoho Books or Tally' : 'Exports are turned off for your role.', onclick: exportCsv })),
    tiles, formBox, readyCard, filters, listBox, profileCard(),
    h('p', { class: 'hint' }, 'BenchPilot does not send invoices or take payments. Print or save the PDF, attach it to the email draft, and press Send yourself. Amounts are in USD from the hours and rates on file; check them before you send. This is a tracker, not accounting or tax advice.'));
}

/** One invoice, ready to print: the document and, outside it (not printed), the way back, Print and Email draft. */
async function printView(ctx, BP, inv, byId, profile) {
  if (!inv) return h('div', { class: 'stack' }, pageHeader('Invoice', ''), emptyState({ icon: 'file', title: 'Invoice not found', text: 'It may have been removed.', action: h('a', { class: 'btn btn-secondary', href: '#invoices' }, 'Back to invoices') }));
  const r = byId.get(inv.placementId) || { consultantName: '', vendorName: '', endClient: '', role: '', poRef: '' };
  const doc = BP.Invoices.printDoc(inv, { profile, consultantName: r.consultantName, vendorName: r.vendorName, endClient: r.endClient, role: r.role, poRef: r.poRef });
  const contact = (ctx.lk.contacts || []).find((c) => c.id === r.vendorContactId) || null;
  const st = BP.Invoices.invoiceStatus(inv, ctx.session.today);
  return h('div', { class: 'stack inv-print-page' },
    h('div', { class: 'inv-toolbar no-print' },
      h('a', { class: 'btn btn-ghost', href: '#invoices' }, 'Back to invoices'),
      chip(BP.Invoices.STATUS_LABELS[st], INVOICE_KIND[st]),
      h('div', { class: 'row-end' },
        h('a', { class: 'btn btn-secondary', href: emailDraftLink(BP, inv, r, profile, contact), target: '_blank', rel: 'noopener' }, 'Email draft'),
        button('Print or save as PDF', { variant: 'primary', onclick: printInvoice }))),
    doc.missingProfile ? h('p', { class: 'note note-warn no-print', role: 'status' }, 'Add your company name, address and payment details under "Your invoice details" on the Invoices screen before you send this.') : null,
    invoiceDocument(doc),
    h('p', { class: 'hint no-print' }, 'In the print dialog choose "Save as PDF" to get a file. Email draft opens your mail app with the text; attach the PDF and press Send yourself.'));
}
