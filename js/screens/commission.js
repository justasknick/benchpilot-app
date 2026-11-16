// Commission (migration 0055, staffing G4): the owner sets a default rule and one per recruiter (% of the margin, or a fixed amount per
// placement, with an optional share for a lead), and sees the estimate per person for a month, with a CSV for the commission sheet.
// Estimates, never payroll: the margin is the 8-hours-a-weekday estimate from the rates on file (BP.Placements.monthMargin); a fixed amount
// counts in the month the placement starts. Owners and managers who may see pay (perms 'commission'; RLS commission_rules; pay rates
// through placement_pay, 0046 / 0051). Team plans (plan-gate 'invoicing'). Every rule is lib/invoicing.js (BP.Commission).

import { h, clear } from '../dom.js';
import { pageHeader, card, table, chip, empty, button, toast, select, field, input, note, lockNote, plural } from '../ui.js';
import { loadDraftLib } from '../bp-lib.js';
import { FEATURE_FROM } from '../plan-gate.js';
import { invoicingOn, money, downloadText, csvText } from '../invoicing-ui.js';

export async function render(ctx) {
  const header = pageHeader('Commission', 'Your commission rules and the estimate per person, for your commission sheet');
  if (!invoicingOn(ctx)) {
    return h('div', { class: 'stack' }, header, card('Timesheets, invoices and commission', lockNote(ctx, { badge: FEATURE_FROM.invoicing,
      text: 'Set a commission rule per recruiter or for the team and get a monthly estimate per person. Included from ' + FEATURE_FROM.invoicing + '.', plan: true })));
  }
  if (!ctx.can('commission')) {
    return h('div', { class: 'stack' }, header, card(null, lockNote(ctx, { badge: 'Owners and managers', text: 'Commission rules and estimates are for the owner and managers who can see pay rates.' })));
  }
  const BP = await loadDraftLib();
  const C = BP.Commission, T = BP.Targets;
  const [placements, submissions, rules] = await Promise.all([ctx.store.listPlacements(), ctx.store.listSubmissions({}), ctx.store.listCommissionRules()]);
  const today = ctx.session.today;
  const subs = new Map(submissions.map((s) => [s.id, s]));
  const rows = placements.map((p) => ({ recruiterId: (subs.get(p.submissionId) || {}).recruiterId || '', placement: p, consultantName: ctx.lk.consultantName(p.consultantId) }));
  const members = (ctx.lk.members || []).filter((m) => !m.removedAt);
  const nameOf = (id) => (id ? ctx.lk.memberName(id) : 'No recruiter');
  const canWrite = ctx.can('set_commission');
  const months = { [today.slice(0, 7)]: 'This month', [T.prevMonth(today.slice(0, 7))]: 'Last month', [T.prevMonth(T.prevMonth(today.slice(0, 7)))]: 'Two months ago' };
  const view = { month: today.slice(0, 7) };
  const body = h('div', { class: 'stack', 'aria-live': 'polite' });
  const formBox = h('div');

  function openRule(rule) {
    clear(formBox);
    const x = rule || { memberId: rules.some((r) => !r.memberId) ? (members.find((m) => !rules.some((r) => r.memberId === m.id)) || {}).id || '' : '', basis: 'margin_pct', pct: '', fixed: '', leadMemberId: '', leadSharePct: '' };
    const free = { '': 'Everyone (the default rule)', ...Object.fromEntries(members.map((m) => [m.id, m.name])) };
    const el = {
      member: rule ? null : select(free, x.memberId || ''),
      basis: select(C.BASIS_LABELS, x.basis),
      pct: input({ inputmode: 'decimal', value: x.pct === null || x.pct === undefined ? '' : String(x.pct), placeholder: '10', class: 'rate-in' }),
      fixed: input({ inputmode: 'decimal', value: x.fixed === null || x.fixed === undefined ? '' : String(x.fixed), placeholder: '500', class: 'rate-in' }),
      lead: select({ '': 'No lead share', ...Object.fromEntries(members.map((m) => [m.id, m.name])) }, x.leadMemberId || ''),
      share: input({ inputmode: 'decimal', value: x.leadSharePct ? String(x.leadSharePct) : '', placeholder: '20', class: 'rate-in' })
    };
    const pctF = field('% of the margin', el.pct), fixedF = field('Amount per placement ($)', el.fixed), shareF = field('Lead share (% of the commission)', el.share);
    const paint = () => { pctF.hidden = el.basis.value !== 'margin_pct'; fixedF.hidden = el.basis.value !== 'fixed'; shareF.hidden = !el.lead.value; };
    el.basis.addEventListener('change', paint); el.lead.addEventListener('change', paint);
    const msg = h('div', { 'aria-live': 'polite' });
    const form = h('form', { class: 'cm-form', novalidate: true, 'aria-label': rule ? 'Change a commission rule' : 'New commission rule' },
      h('h3', { class: 'form-title' }, rule ? 'Rule for ' + (rule.memberId ? nameOf(rule.memberId) : 'everyone') : 'New rule'),
      h('div', { class: 'grid' }, el.member ? field('For', el.member) : null, field('Rule', el.basis), pctF, fixedF, field('Lead', el.lead), shareF),
      msg, h('div', { class: 'row-end' }, button('Cancel', { variant: 'ghost', onclick: () => clear(formBox) }), h('button', { type: 'submit', class: 'btn btn-primary' }, rule ? 'Save rule' : 'Add rule')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(msg);
      const c = C.cleanRule({ memberId: rule ? rule.memberId : el.member.value, basis: el.basis.value, pct: el.pct.value, fixed: el.fixed.value, leadMemberId: el.lead.value, leadSharePct: el.share.value });
      if (!c.ok) { msg.append(note('danger', c.error)); return; }
      try { await ctx.store.saveCommissionRule({ ...c.rule, id: rule ? rule.id : undefined }); toast('Rule saved.'); ctx.refresh(); } catch (err) { msg.append(note('danger', err.message)); }
    });
    paint();
    formBox.append(card(null, form, { class: 'form-card' }));
  }
  async function removeRule(rule) {
    if (!confirm('Remove this rule? Estimates for ' + (rule.memberId ? nameOf(rule.memberId) : 'everyone without their own rule') + ' change at once.')) return;
    try { await ctx.store.deleteCommissionRule(rule.id); toast('Rule removed.'); ctx.refresh(); } catch (err) { toast(err.message); }
  }

  function draw() {
    clear(body);
    const rep = C.report(rows, rules, view.month);
    const tile = (n, label, sub) => h('div', { class: 'tile' }, h('span', { class: 'tile-num' }, String(n)), h('span', { class: 'tile-label' }, label), sub ? h('span', { class: 'tile-hint' }, sub) : null);
    body.append(
      h('div', { class: 'tiles tiles--4' },
        tile(money(rep.total), 'Commission estimate', months[view.month]),
        tile(rep.people.length, 'People', 'with an estimate'),
        tile(rep.lines.filter((l) => l.commission !== null).length, 'Placements counted', 'running or started in the month'),
        tile(rep.missing, 'Missing rates', rep.missing ? 'Add bill and pay rates' : 'Every placement has rates')),
      h('div', { class: 'cols' },
        card('Per person', rep.people.length ? table([
          { label: 'Person', cell: (p) => h('span', { class: 'strong' }, nameOf(p.memberId)) },
          { label: 'Placements', class: 'num', cell: (p) => String(p.placements) },
          { label: 'Estimate', class: 'num', cell: (p) => h('span', { class: 'mono' }, money(p.amount)) }
        ], rep.people, { caption: 'Commission estimate per person' }) : empty(rules.length ? 'No placement ran in that month.' : 'Add a rule to see estimates.')),
        card('Rules', h('div', { class: 'stack' },
          rules.length ? table([
            { label: 'For', cell: (r) => h('span', { class: 'strong' }, r.memberId ? nameOf(r.memberId) : 'Everyone (default)') },
            { label: 'Rule', cell: (r) => C.ruleText(r) + (r.leadMemberId ? ' (' + nameOf(r.leadMemberId) + ')' : '') },
            { label: '', class: 'right', cell: (r) => canWrite ? h('div', { class: 'row-end' }, button('Edit', { variant: 'ghost', onclick: () => openRule(r) }), button('Remove', { variant: 'ghost', onclick: () => removeRule(r) })) : null }
          ], rules.slice().sort((a, b) => (a.memberId ? 1 : 0) - (b.memberId ? 1 : 0)), { caption: 'Commission rules' }) : empty('No rule yet. Start with a default for everyone.'),
          canWrite ? h('div', { class: 'row-end' }, button('Add a rule', { variant: 'secondary', onclick: () => openRule(null) })) : null))),
      card('Placements in ' + months[view.month].toLowerCase(), rep.lines.length ? table([
        { label: 'Recruiter', cell: (l) => nameOf(l.recruiterId) },
        { label: 'Consultant', cell: (l) => l.consultantName },
        { label: 'Rule', cell: (l) => C.ruleText(l.rule) },
        { label: 'Margin estimate', class: 'num', cell: (l) => (l.base === null ? h('span', { class: 'muted' }, '-') : h('span', { class: 'mono' }, money(l.base))) },
        { label: 'Commission', class: 'num', cell: (l) => (l.commission === null ? chip(l.note, 'warn') : h('span', { class: 'mono strong' }, money(l.commission))) },
        { label: 'Lead share', class: 'num', cell: (l) => (l.leadId && l.commission !== null ? h('span', null, nameOf(l.leadId) + ' ', h('span', { class: 'mono' }, money(l.leadShare))) : h('span', { class: 'muted' }, '-')) }
      ], rep.lines, { caption: 'Commission estimate per placement' }) : empty('No placement counts in that month.')));
  }

  function exportCsv() {
    if (!ctx.can('export')) { toast('Your workspace owner has turned off exports for your role.'); return; }
    const rep = C.report(rows, rules, view.month);
    if (!rep.lines.length) { toast('Nothing to export for that month.'); return; }
    downloadText(csvText(C.csvRows(rep, view.month, nameOf), C.CSV_HEADERS), `benchpilot_commission_estimate_${view.month}.csv`);
    toast(`Exported ${plural(rep.lines.length, 'line')}.`);
  }

  draw();
  return h('div', { class: 'stack' },
    pageHeader('Commission', 'Your commission rules and the estimate per person, for your commission sheet',
      button('Download CSV', { variant: 'secondary', disabled: !ctx.can('export'), title: ctx.can('export') ? null : 'Exports are turned off for your role.', onclick: exportCsv })),
    h('p', { class: 'note note-info', role: 'status' }, C.ESTIMATE_NOTE),
    h('div', { class: 'filters' }, field('Month', select(months, view.month, { onchange: (e) => { view.month = e.target.value; draw(); } }))),
    formBox, body,
    h('p', { class: 'hint' }, '% of margin: the month’s gross margin estimate of each placement (8 hours each weekday it runs; W2 includes the employer cost) times the percentage. Fixed: the amount once, in the month the placement starts. A lead share comes out of the recruiter’s commission. Only owners and managers see this page.'));
}
