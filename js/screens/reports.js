// Reports (staffing P4, migration 0052): targets, the leaderboard and the funnel per recruiter or per desk (submission -> interview -> offer ->
// placement, with rates), the funnel by skill family (stats.js familyFunnel: the extension's Insights rule), average bench days, duplicates caught, margin per placement, and the "margin per recruiter per month" CSV for a
// commission sheet. Owners and managers see the whole team (perms 'reports'); a recruiter sees their own numbers and, unless the owner turned
// it off, the leaderboard. Per desk: Agency and the pilot (plan-gate 'deskReports'). The CSV: owners and managers who may see pay and export
// (perms 'margin_export'); it is an estimate from the rates on file, not a commission calculation.

import { h, clear } from '../dom.js';
import { pageHeader, card, table, empty, chip, field, select, button, toast, lockNote } from '../ui.js';
import { loadDraftLib } from '../bp-lib.js';
import { hasFeature, FEATURE_FROM } from '../plan-gate.js';
import { reportRange, familyFunnel } from '../stats.js';
import { loadReportData, buildReport, teamToday, targetsOn, leaderboardCard, targetsEditor, targetCard } from '../p4-ui.js';
import { toCsv } from '../export-zip.js';

export const RANGES = { week: 'Last 7 days', month: 'This month', '30d': 'Last 30 days', '90d': 'Last 90 days' };
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rate = (n, of) => (of ? Math.round((n / of) * 100) + '%' : '');
const withRate = (n, of) => h('span', null, String(n), of ? h('span', { class: 'muted' }, ' · ' + rate(n, of)) : null);

/** The average margin per hour of the placements that started in the range, per group key (the rate calculator's formula). */
export function marginPerPlacement(P, rows, range, keyOf) {
  const out = new Map();
  for (const r of rows) {
    if (!r.placement || r.placement.status === 'fell_through' || !(r.placement.startOn >= range.from && r.placement.startOn <= range.to)) continue;
    const m = P.placementMargin(r.placement);
    if (!m.valid || m.unit !== 'hr') continue;
    const k = keyOf(r);
    const cur = out.get(k) || { sum: 0, n: 0 };
    cur.sum += m.margin; cur.n += 1;
    out.set(k, cur);
  }
  return new Map([...out].map(([k, v]) => [k, Math.round((v.sum / v.n) * 100) / 100]));
}

/** The commission-sheet CSV text for a month (BP.Placements.marginByRecruiter + marginCsvRows). */
export function marginCsv(P, placementRows, month, nameOf) {
  return toCsv(P.marginCsvRows(P.marginByRecruiter(placementRows, month), month, nameOf));
}

export async function render(ctx) {
  const BP = await loadDraftLib();
  const T = BP.Targets, P = BP.Placements;
  const lead = ctx.can('reports');
  const me = ctx.session.user.id;
  const header = pageHeader('Reports', lead ? 'Targets, the funnel per recruiter and the margin for your commission sheet' : 'Your targets and your funnel');
  if (!targetsOn(ctx)) {
    return h('div', { class: 'stack' }, header,
      card('Targets, a leaderboard and funnel reports', lockNote(ctx, { badge: FEATURE_FROM.targets, text: 'Set targets per person, desk or team, rank the desk and see where submissions stop. Included from ' + FEATURE_FROM.targets + '.', plan: true })));
  }
  const today = teamToday(ctx, T);
  const deskOk = lead && hasFeature(ctx.team.billing, 'deskReports') && (ctx.lk.desks || []).length > 0;
  const view = { range: 'month', by: 'recruiter', month: today.slice(0, 7) };
  const data = await loadReportData(ctx, null);
  const subs = new Map(data.submissions.map((s) => [s.id, s]));
  const placementRows = data.placements.map((p) => ({ recruiterId: (subs.get(p.submissionId) || {}).recruiterId || '', placement: p }));
  const canPay = ctx.can('see_pay');
  const body = h('div', { class: 'stack' });

  function draw() {
    clear(body);
    const range = reportRange(T, view.range, today);
    const rep = buildReport(ctx, BP, data, { range, by: view.by, period: 'week' });
    const rows = lead ? rep.rows : rep.rows.filter((r) => r.key === me);
    const mine = rep.rows.find((r) => r.key === me) || null;
    const f = lead ? rep.total.funnel : (mine ? mine.funnel : P.funnel([]));
    const margins = canPay ? marginPerPlacement(P, placementRows, range,
      (r) => (view.by === 'desk' ? ctx.lk.deskIdx.userDesk(r.recruiterId) || 'none' : r.recruiterId)) : null;
    const tile = (n, label, sub) => h('div', { class: 'tile' }, h('span', { class: 'tile-num' }, String(n)), h('span', { class: 'tile-label' }, label), sub ? h('span', { class: 'tile-hint' }, sub) : null);
    body.append(
      h('div', { class: 'tiles tiles--4' },
        tile(f.submitted, 'Submitted', RANGES[view.range]),
        tile(f.interview, 'Reached an interview', f.submitted ? rate(f.interview, f.submitted) + ' of submissions' : ''),
        tile(f.offer, 'Reached an offer', f.interview ? rate(f.offer, f.interview) + ' of interviews' : ''),
        tile(f.placed, 'Placed', f.submitted ? rate(f.placed, f.submitted) + ' of submissions' : '')),
      h('div', { class: 'cols p4-cols' },
        lead ? targetCard(ctx, { target: rep.total.target, progress: rep.total.progress }, { period: 'week' }) : targetCard(ctx, mine, { mine: true, period: 'week' }),
        leaderboardCard(ctx, buildReport(ctx, BP, data, { rangeKey: 'week', period: 'week' }), { rangeText: 'last 7 days' })),
      card(lead ? (view.by === 'desk' ? 'Funnel by desk' : 'Funnel by recruiter') : 'Your funnel', rows.length ? table([
        { label: view.by === 'desk' ? 'Desk' : 'Recruiter', cell: (r) => h('span', { class: 'strong' }, r.name) },
        { label: 'Submitted', class: 'num', cell: (r) => String(r.funnel.submitted) },
        { label: 'Interview', class: 'num', cell: (r) => withRate(r.funnel.interview, r.funnel.submitted) },
        { label: 'Offer', class: 'num', cell: (r) => withRate(r.funnel.offer, r.funnel.interview) },
        { label: 'Placed', class: 'num', cell: (r) => withRate(r.funnel.placed, r.funnel.submitted) },
        { label: 'Avg bench days', class: 'num', cell: (r) => (r.benchCount ? String(r.avgBenchDays) : h('span', { class: 'muted' }, '-')) },
        { label: 'Duplicates caught', class: 'num', cell: (r) => (r.duplicates ? chip(String(r.duplicates), 'ok') : h('span', { class: 'muted' }, '0')) },
        ...(margins ? [{ label: 'Margin per placement', class: 'num', cell: (r) => (margins.has(r.key) ? h('span', { class: 'mono' }, money(margins.get(r.key)) + '/h') : h('span', { class: 'muted' }, '-')) }] : [])
      ], rows, { caption: 'Funnel ' + RANGES[view.range].toLowerCase() }) : empty('No numbers for this period yet.'),
      h('p', { class: 'hint' }, `Submissions sent ${RANGES[view.range].toLowerCase()}, and how far each got. Rates: interview and placed of submissions, offer of interviews. Average bench days counts consultants still on the bench.`
        + (margins ? ' Margin per placement: the average margin per hour of placements that started in the period (W2 includes the employer cost).' : ''))));
    const fam = familyFunnel(data, { T, P, BP, range, keep: lead ? null : (s) => s.recruiterId === me });
    body.append(card(lead ? 'Funnel by skill family' : 'Your funnel by skill family', h('div', { class: 'stack' }, fam.length ? table([
      { label: 'Skill family', cell: (r) => h('span', { class: 'strong' }, r.key) },
      { label: 'Submitted', class: 'num', cell: (r) => String(r.submitted) },
      { label: 'Interview', class: 'num', cell: (r) => withRate(r.interview, r.submitted) },
      { label: 'Offer', class: 'num', cell: (r) => withRate(r.offer, r.interview) },
      { label: 'Placed', class: 'num', cell: (r) => withRate(r.placed, r.submitted) }
    ], fam, { caption: 'Funnel by skill family ' + RANGES[view.range].toLowerCase() }) : empty('No submissions in this period yet.'),
    h('p', { class: 'hint' }, 'Each submission counts under its requirement\'s skill family (Java / J2EE, Data engineer, Salesforce ...), or the consultant\'s when the requirement says nothing. The same families as Insights in the extension.'))));
    if (lead) body.append(targetsEditor(ctx, BP, data.targets, async () => { data.targets = await ctx.store.listTargets(); draw(); }));
    if (ctx.can('margin_export')) body.append(marginCard());
  }

  function marginCard() {
    const months = { [view.month]: 'This month', [T.prevMonth(today.slice(0, 7))]: 'Last month' };
    const list = P.marginByRecruiter(placementRows, view.month);
    const monthSel = select(months, view.month, { onchange: (e) => { view.month = e.target.value; draw(); } });
    const download = () => {
      if (!list.length) { toast('No placement with rates ran in that month.'); return; }
      const text = marginCsv(P, placementRows, view.month, (id) => (id ? ctx.lk.memberName(id) : ''));
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
      const a = h('a', { href: url, download: `benchpilot_margin_by_recruiter_${view.month}.csv` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Exported ${list.length} recruiter${list.length === 1 ? '' : 's'}.`);
    };
    return card('Margin per recruiter, for your commission sheet', h('div', { class: 'stack' },
      h('div', { class: 'p4-inline-filter' }, field('Month', monthSel)),
      list.length ? table([
        { label: 'Recruiter', cell: (r) => (r.recruiterId ? ctx.lk.memberName(r.recruiterId) : 'No recruiter') },
        { label: 'Placements running', class: 'num', cell: (r) => String(r.placements) },
        { label: 'With both rates', class: 'num', cell: (r) => String(r.counted) },
        { label: 'Gross margin estimate', class: 'num', cell: (r) => h('span', { class: 'mono' }, money(r.margin)) }
      ], list, { caption: 'Margin per recruiter' }) : empty('No placement with rates ran in that month.'),
      h('div', { class: 'row-end' }, button('Download CSV', { variant: 'secondary', onclick: download })),
      h('p', { class: 'hint' }, 'An estimate from the bill and pay rates on file: 8 hours each weekday a placement runs, W2 with the employer cost. Pay rates stay with owners and managers. ', ctx.can('commission') ? h('a', { href: '#commission' }, 'Commission applies your rules to it.') : null)));
  }

  const filters = h('div', { class: 'filters p4-filters' },
    field('Period', select(RANGES, view.range, { onchange: (e) => { view.range = e.target.value; draw(); } })),
    deskOk ? field('Group by', select({ recruiter: 'Recruiter', desk: 'Desk' }, view.by, { onchange: (e) => { view.by = e.target.value; draw(); } })) : null);
  draw();
  return h('div', { class: 'stack' }, header, filters, body);
}
