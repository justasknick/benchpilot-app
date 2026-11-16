// Placements (staffing P3, migration 0051): every placement of the team with its margin per hour and per month, the gross margin this
// month (an estimate: 8 hours each weekday a placement runs), "Ending in 30 days" (consultants coming back to the bench), the funnel
// (submitted -> interview -> offer -> placed) and the CSV for QuickBooks or another accounting tool (Customer = the vendor you invoice,
// Product/Service = the consultant, the rate, the PO and the vendor's net terms; staffing P6's terms when recorded, else Net 30).
// Pay rates and margin: owners and managers, recruiters when the owner allows it (perms 'see_pay'; RLS on placement_pay). The CSV follows
// the workspace export policy (perms 'export'), and its pay columns the same pay rule.

import { h, clear } from '../dom.js';
import { pageHeader, card, table, chip, empty, emptyState, sampleDataButton, button, toast, select, field } from '../ui.js';
import { loadDraftLib } from '../bp-lib.js';
import { placementForm, PLACEMENT_KIND } from '../p3-ui.js';
import { toCsv } from '../export-zip.js';
import { filterByDesk } from '../desks.js';
import { deskFilterField } from '../desk-ui.js';

const money = (n) => '$' + Number(n).toLocaleString('en-US', Number.isInteger(Number(n)) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });   // $2,400 or $2.50

/** The rows the screen and the CSV share: one per placement, with the names and the vendor (for its net terms). */
export function placementRows(ctx, placements, submissions, vendors) {
  const subs = new Map(submissions.map((s) => [s.id, s]));
  const vend = new Map(vendors.map((v) => [v.id, v]));
  return placements.map((p) => {
    const s = subs.get(p.submissionId) || {};
    const vendorId = p.vendorCompanyId || s.vendorCompanyId || '';
    return { placement: p, submission: s, consultantName: ctx.lk.consultantName(p.consultantId), vendorName: ctx.lk.vendorName(vendorId), vendor: vend.get(vendorId) || null,
      role: ((ctx.lk.requirements || []).find((r) => r.id === s.requirementId) || {}).title || '', endClient: p.endClient || s.endClient || '', recruiterId: s.recruiterId || '' };
  });
}

/** The CSV text for QuickBooks (BP.Placements.quickbooksRows, in its column order). canPay adds the pay and margin columns. */
export function quickbooksCsv(BP, rows, canPay, today) {
  return toCsv(BP.Placements.quickbooksRows(rows, { canPay, today }));
}

export async function render(ctx) {
  const BP = await loadDraftLib();
  const P = BP.Placements;
  ctx.lk.requirements = ctx.lk.requirements || await ctx.store.listRequirements();
  const [placements, submissions, interviews, vendors] = await Promise.all([ctx.store.listPlacements(), ctx.store.listSubmissions({}), ctx.store.listInterviews({}), ctx.store.listVendors()]);
  const today = ctx.session.today;
  const canPay = ctx.can('see_pay');
  const f = { status: '', deskId: '' };
  const formBox = h('div');
  const listBox = h('div', { 'aria-live': 'polite' });
  const all = placementRows(ctx, placements, submissions, vendors);

  // The numbers over the whole team (the filters only narrow the list).
  const withRates = placements.map((p) => ({ ...p, payRate: canPay ? p.payRate : null }));
  const month = today.slice(0, 7);
  const mm = P.monthMargin(withRates, month);
  const ending = P.endingWithin(placements, today, 30);
  const active = placements.filter((p) => P.placementStatus(p, today) === 'active').length;
  const ivBySub = new Map();
  for (const iv of interviews) { if (!ivBySub.has(iv.submissionId)) ivBySub.set(iv.submissionId, []); ivBySub.get(iv.submissionId).push(iv); }
  const plBySub = new Map(placements.map((p) => [p.submissionId, p]));
  const funnel = P.funnel(submissions.map((s) => ({ stage: s.stage, interviews: ivBySub.get(s.id) || [], placement: plBySub.get(s.id) || null })));
  const monthName = new Date(month + '-15T00:00:00Z').toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const tile = (n, label, sub) => h('div', { class: 'tile' }, h('span', { class: 'tile-num' }, String(n)), h('span', { class: 'tile-label' }, label), sub ? h('span', { class: 'tile-hint' }, sub) : null);
  const tiles = h('div', { class: 'tiles tiles--4' },
    tile(active, 'Active placements'),
    canPay ? tile(money(mm.total), `Gross margin in ${monthName}`, mm.counted ? `Estimate: ${mm.counted} placement${mm.counted === 1 ? '' : 's'}, 8 h a weekday` + (mm.missing ? `, ${mm.missing} without rates` : '') : 'Add pay rates to see it')
      : tile(placements.length, 'Placements in total', 'Margin is visible to owners and managers'),
    tile(ending.length, 'Ending in 30 days', ending.length ? 'Back on the bench soon' : ''),
    tile(funnel.placed, `Placed of ${funnel.submitted} submitted`, funnel.submitted ? `${funnel.rates.interview}% got an interview · ${funnel.rates.offer}% of those an offer` : ''));

  function funnelCard() {
    const steps = [['Submitted', funnel.submitted], ['Interview', funnel.interview], ['Offer', funnel.offer], ['Placed', funnel.placed]];
    const max = Math.max(1, funnel.submitted);
    return card('Funnel: submission to placement', h('div', { class: 'p3-funnel', role: 'list' }, steps.map(([label, n]) => h('div', { class: 'p3-funnel-row', role: 'listitem' },
      h('span', { class: 'p3-funnel-l' }, label),
      h('span', { class: 'p3-funnel-bar', 'aria-hidden': 'true' }, h('span', { class: 'p3-funnel-fill', style: `width:${Math.round((n / max) * 100)}%` })),
      h('span', { class: 'p3-funnel-n' }, String(n))))),
    { class: 'p3-funnel-card' });
  }

  function endingCard() {
    return card('Ending in 30 days', ending.length ? h('ul', { class: 'p3-ending' }, ending.map((p) => h('li', null,
      h('a', { href: '#consultant-' + p.consultantId }, ctx.lk.consultantName(p.consultantId)),
      h('span', { class: 'muted' }, ` ends ${BP.Submissions.dayLabel(p.endOn)}` + (p.endClient ? ' at ' + p.endClient : ''))))) : empty('No placement ends in the next 30 days.'));
  }

  function openEdit(r) {
    clear(formBox);
    formBox.append(placementForm(ctx, BP, r.submission.id ? r.submission : { id: r.placement.submissionId, consultantId: r.placement.consultantId, endClient: r.endClient }, r.placement, {
      onDone: () => ctx.refresh(), onCancel: () => clear(formBox) }));
    formBox.scrollIntoView({ block: 'nearest' });
  }

  function drawList() {
    let rows = all.filter((r) => !f.status || P.placementStatus(r.placement, today) === f.status);
    rows = filterByDesk('submission', rows, f.deskId, ctx.lk.deskIdx);   // a row carries its submission's recruiterId
    clear(listBox);
    if (!placements.length) {
      listBox.append(emptyState({ icon: 'placements', title: 'No placements yet',
        text: 'When a consultant starts, set the submission to Placed and add the start date and rates. Margin and end dates then show here.',
        action: h('a', { class: 'btn btn-primary', href: '#submissions' }, 'Open submissions'), secondary: sampleDataButton(ctx) }));
      return;
    }
    listBox.append(rows.length ? table([
      { label: 'Consultant', cell: (r) => h('div', null, h('a', { href: '#consultant-' + r.placement.consultantId, class: 'strong' }, r.consultantName), r.role ? h('div', { class: 'muted' }, r.role) : null) },
      { label: 'End client and vendor', cell: (r) => h('div', null, r.endClient || '-', h('div', { class: 'muted' }, (r.vendorName || 'No vendor') + ' · Net ' + P.netTermsOf(r.vendor))) },
      { label: 'Dates', class: 'nowrap', cell: (r) => h('div', null, BP.Submissions.dayLabel(r.placement.startOn), h('div', { class: 'muted' }, r.placement.endOn ? 'to ' + BP.Submissions.dayLabel(r.placement.endOn) : 'Open-ended')) },
      { label: 'Bill rate', class: 'num', cell: (r) => h('span', { class: 'mono' }, BP.Submissions.rateText(r.placement.billRate, r.placement.rateUnit) || '-') },
      { label: 'Margin', class: 'num', cell: (r) => {
        if (r.placement.payHidden) return h('span', { class: 'muted' }, 'Hidden');
        const m = P.placementMargin(r.placement);
        return m.valid ? h('div', null, h('span', { class: m.loss ? 'margin-loss mono' : 'mono' }, `${money(m.margin)}/h · ${m.marginPct}%`),
          m.monthly !== null ? h('div', { class: 'muted' }, money(m.monthly) + ' a month') : null) : h('span', { class: 'muted' }, '-');
      } },
      { label: 'Status', cell: (r) => { const st = P.placementStatus(r.placement, today); return h('div', null, chip(P.STATUS_LABELS[st], PLACEMENT_KIND[st]), ending.some((x) => x.id === r.placement.id) ? [' ', chip('Ends soon', 'warn')] : null); } },
      { label: 'PO', cell: (r) => r.placement.poRef || '-' },
      { label: '', class: 'right', cell: (r) => button('Edit', { variant: 'ghost', disabled: !ctx.can('edit_records'), 'aria-label': 'Edit the placement of ' + r.consultantName, onclick: () => openEdit(r) }) }
    ], rows, { caption: 'Placements, newest start first' }) : empty('No placement matches these filters.'));
  }

  function exportCsv() {
    if (!ctx.can('export')) { toast('Your workspace owner has turned off exports for your role.'); return; }
    if (!all.length) { toast('No placements to export yet.'); return; }
    const text = quickbooksCsv(BP, all, canPay, today);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
    const a = h('a', { href: url, download: `benchpilot_placements_${today}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${all.length} placement${all.length === 1 ? '' : 's'}.`);
  }

  const filters = h('div', { class: 'filters p3-filters' },
    field('Status', select({ '': 'All', upcoming: 'Starting soon', active: 'Active', ended: 'Ended', fell_through: 'Fell through' }, '', { onchange: (e) => { f.status = e.target.value; drawList(); } })),
    deskFilterField(ctx, (v) => { f.deskId = v; drawList(); }));
  drawList();
  return h('div', { class: 'stack' },
    pageHeader('Placements', 'Who is working where, the margin, and who comes back to the bench',
      button('Export for QuickBooks (CSV)', { variant: 'secondary', disabled: !ctx.can('export'), title: ctx.can('export') ? null : 'Exports are turned off for your role.', onclick: exportCsv })),
    tiles,
    h('div', { class: 'cols' }, funnelCard(), endingCard()),
    formBox, filters, listBox,
    h('p', { class: 'hint' }, `Margin uses the rate calculator's formula (W2 includes the employer cost). The month's gross margin is an estimate: 8 hours each weekday a placement runs. Net terms come from the vendor's payment terms when recorded, otherwise Net ${P.DEFAULT_NET_TERMS}. The CSV opens in QuickBooks, Excel or any accounting tool.`));
}
