// webapp/js/invoicing-ui.js - shared pieces of the timesheet, invoice and commission screens (migration 0055; staffing "Later" items F1, F2,
// G4): the placement rows with their names, the printable invoice (BP.Invoices.printDoc rendered with h(), printed by the browser), the
// email draft link, the CSV download and Today's "Timesheets and invoices" card. Every rule is the extension's lib/invoicing.js (BP.Timesheets,
// BP.Invoices, BP.Commission through loadDraftLib), so the extension and the team workspace say the same thing.
// BenchPilot never sends an invoice: "Print or save as PDF" is the browser's print dialog, "Email draft" opens the person's own mail app.

import { h } from './dom.js';
import { card, table, chip, empty, button, toast, plural } from './ui.js';
import { hasFeature } from './plan-gate.js';
import { loadDraftLib } from './bp-lib.js';
import { toCsv } from './export-zip.js';
import { applyTheme } from './shell.js';

export const INVOICE_KIND = { draft: 'neutral', sent: 'accent', overdue: 'danger', paid: 'ok' };
export const TIMESHEET_KIND = { draft: 'neutral', submitted: 'warn', approved: 'ok' };
export const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const hoursText = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' h';

/** Timesheets, invoices and commission come with the team plans (plan-gate 'invoicing'). */
export const invoicingOn = (ctx) => hasFeature(ctx.team && ctx.team.billing, 'invoicing');

/** One row per placement with its names, vendor (for net terms) and recruiter; fell-through placements are left out. */
export function placementInfo(ctx, placements, submissions) {
  const subs = new Map((submissions || []).map((s) => [s.id, s]));
  return (placements || []).filter((p) => p.status !== 'fell_through').map((p) => {
    const s = subs.get(p.submissionId) || {};
    const vendorId = p.vendorCompanyId || s.vendorCompanyId || '';
    return {
      placement: p, submission: s, id: p.id, recruiterId: s.recruiterId || '', consultantName: ctx.lk.consultantName(p.consultantId),
      vendorName: ctx.lk.vendorName(vendorId), vendor: (ctx.lk.vendors || []).find((v) => v.id === vendorId) || null, vendorContactId: s.vendorContactId || '',
      endClient: p.endClient || s.endClient || '', role: ((ctx.lk.requirements || []).find((r) => r.id === s.requirementId) || {}).title || '', poRef: p.poRef || ''
    };
  });
}
/** "Ravi K. at Orchard Systems" for a picker. */
export const placementLabel = (r) => r.consultantName + (r.endClient ? ' at ' + r.endClient : '') + (r.vendorName ? ' (' + r.vendorName + ')' : '');

/** Download text as a file (a Blob; nothing leaves the computer). */
export function downloadText(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || 'text/csv;charset=utf-8;' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function csvText(rows, headers) {
  return rows.length ? toCsv(rows) : headers.join(',') + '\r\n';
}

/** The printable invoice: the firm's details, the vendor, the dates, the lines and the total. Printed with the print stylesheet (.inv-doc). */
export function invoiceDocument(doc) {
  return h('article', { class: 'inv-doc', 'aria-label': 'Invoice ' + doc.number },
    h('header', { class: 'inv-head' },
      h('div', { class: 'inv-from' }, h('p', { class: 'inv-firm' }, doc.from.name), doc.from.lines.map((l) => h('p', { class: 'inv-line' }, l))),
      h('div', { class: 'inv-title' }, h('p', { class: 'inv-word' }, doc.title), h('p', { class: 'inv-num mono' }, doc.number))),
    h('div', { class: 'inv-parties' },
      h('div', null, h('p', { class: 'inv-label' }, 'Bill to'), h('p', { class: 'inv-firm' }, doc.billTo.name)),
      h('dl', { class: 'inv-meta' }, doc.meta.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))),
    h('table', { class: 'inv-lines' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Description'), h('th', { scope: 'col', class: 'num' }, 'Hours'),
        h('th', { scope: 'col', class: 'num' }, 'Rate'), h('th', { scope: 'col', class: 'num' }, 'Amount'))),
      h('tbody', null, doc.lines.map((l) => h('tr', null,
        h('td', null, h('span', { class: 'inv-desc' }, l.description), h('span', { class: 'inv-sub' }, l.sub)),
        h('td', { class: 'num mono' }, l.qtyText), h('td', { class: 'num mono' }, l.rateText), h('td', { class: 'num mono' }, l.amountText)))),
      h('tfoot', null, h('tr', null, h('th', { scope: 'row', colspan: '3', class: 'num' }, 'Total due (' + doc.currency + ')'), h('td', { class: 'num mono inv-total' }, doc.totalText)))),
    doc.paymentDetails ? h('div', { class: 'inv-pay' }, h('p', { class: 'inv-label' }, 'Payment details'), doc.paymentDetails.split('\n').map((l) => h('p', { class: 'inv-line' }, l))) : null,
    doc.note ? h('p', { class: 'inv-note' }, doc.note) : null);
}

/** The browser's print dialog ("Save as PDF" makes the file), always on the light theme so the paper copy is dark text on white. */
export function printInvoice() {
  const root = document.documentElement;
  root.setAttribute('data-theme', 'light');
  try { window.print(); } finally { applyTheme(); }
}

/** "Email draft": the person's own mail app (a mailto: link) with the subject and text; they attach the PDF and press Send. */
export function emailDraftLink(BP, inv, info, profile, to) {
  const d = BP.Invoices.emailDraft(inv, { profile, consultantName: info.consultantName, contactName: to ? to.name : '', poRef: info.poRef });
  return 'mailto:' + encodeURIComponent((to && to.email) || '') + '?subject=' + encodeURIComponent(d.subject) + '&body=' + encodeURIComponent(d.body);
}

/**
 * Today: timesheet weeks missing (a recruiter: on their own placements) and, for owners and managers, invoices overdue. null when there is
 * nothing to say or the plan has no timesheets. Never throws.
 */
export async function billingTodayCard(ctx, mineOnly) {
  if (!invoicingOn(ctx)) return null;
  try {
    const [BP, placements, submissions, timesheets, invoices] = await Promise.all([loadDraftLib(), ctx.store.listPlacements(), ctx.store.listSubmissions({}),
      ctx.store.listTimesheets({}), ctx.can('invoices') ? ctx.store.listInvoices() : Promise.resolve([])]);
    const today = ctx.session.today;
    const me = ctx.session.user.id;
    const info = placementInfo(ctx, placements, submissions).filter((r) => !mineOnly || r.recruiterId === me);
    const bySheet = new Map();
    for (const t of timesheets) { if (!bySheet.has(t.placementId)) bySheet.set(t.placementId, []); bySheet.get(t.placementId).push(t); }
    // A placement is on timesheets once it has its first week (so a team that does not use them is never nagged); the server's report agrees.
    const rem = BP.Invoices.reminders(info.filter((r) => bySheet.has(r.id)).map((r) => ({ ...r, timesheets: bySheet.get(r.id) })), today, BP.Timesheets.MISSING_WEEKS);
    const overdue = invoices.filter((i) => BP.Invoices.invoiceStatus(i, today) === 'overdue');
    if (!rem.missingCount && !overdue.length) return null;
    const rows = rem.missing.map((m) => ({ kind: 'week', label: placementLabel(m.item), text: plural(m.weeks.length, 'week') + ' missing, oldest ' + BP.Timesheets.weekLabel(m.weeks[m.weeks.length - 1]), href: '#timesheets?placement=' + m.placementId }))
      .concat(overdue.map((i) => ({ kind: 'invoice', label: 'Invoice ' + i.number, text: money(i.amount) + ', due ' + BP.Submissions.dayLabel(i.dueOn), href: '#invoices?status=overdue' })));
    return card('Timesheets and invoices', h('div', { class: 'stack' },
      table([
        { label: 'What', cell: (r) => chip(r.kind === 'week' ? 'Timesheet missing' : 'Overdue', r.kind === 'week' ? 'warn' : 'danger') },
        { label: 'For', cell: (r) => h('a', { href: r.href, class: 'strong' }, r.label) },
        { label: 'Detail', cell: (r) => r.text }
      ], rows.slice(0, 8), { caption: 'Timesheet weeks missing and invoices overdue' }),
      h('div', { class: 'row-end' },
        rows.length > 8 ? h('span', { class: 'muted' }, `and ${rows.length - 8} more`) : null,
        rem.missingCount ? h('a', { class: 'btn btn-secondary', href: '#timesheets' }, 'Open timesheets') : null,
        overdue.length ? h('a', { class: 'btn btn-secondary', href: '#invoices?status=overdue' }, 'Open invoices') : null)), { class: 'billing-today' });
  } catch (e) { return null; }
}

/** The plan note shown instead of a screen on Starter. */
export function planNote(text) { return empty(text); }
export { button, toast };
