// webapp/js/p4-ui.js - staffing P4 (docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md, migration 0052) in the team workspace: progress against
// targets, the leaderboard, and the targets editor (owners and managers). The counting rules are the extension's lib/targets.js and
// lib/placements.js (BP.Targets, BP.Placements through loadDraftLib) and js/stats.js teamReport, so the extension's Insights, Today, Reports
// and the morning report all count the same way. Duplicates caught are a quality number next to the ranking, never a penalty.

import { h, clear } from './dom.js';
import { field, input, select, button, card, table, empty, chip, toast, lockNote } from './ui.js';
import { hasFeature, FEATURE_FROM } from './plan-gate.js';
import { teamReport, reportRange } from './stats.js';
import { deskLabel } from './desks.js';

/** The team's zone (settings.timeZone, default India) and its day. The demo keeps its own fixed day so the sample data lines up. */
export function teamZone(ctx) { return (ctx.team && ctx.team.settings && ctx.team.settings.timeZone) || 'Asia/Kolkata'; }
export function teamToday(ctx, T) { return ctx.live ? T.dayIn(Date.now(), teamZone(ctx)) : ctx.session.today; }
export const targetsOn = (ctx) => hasFeature(ctx.team && ctx.team.billing, 'targets');

/** Everything the leaderboard and the reports read (what this person may read: RLS decides on the live server). */
export async function loadReportData(ctx, range) {
  const [submissions, interviews, placements, targets, catches, requirements] = await Promise.all([
    ctx.store.listSubmissions({}), ctx.store.listInterviews({}), ctx.store.listPlacements(), ctx.store.listTargets(),
    ctx.store.listGuardCatches(range ? { from: range.from, to: range.to } : {}),
    ctx.store.listRequirements({}).catch(() => [])     // the funnel by skill family reads each requirement's title and skills
  ]);
  return { members: ctx.lk.members, consultants: ctx.lk.consultants, submissions, interviews, placements, targets, catches, requirements };
}

/** teamReport with the screen's context filled in. */
export function buildReport(ctx, BP, data, o) {
  const today = teamToday(ctx, BP.Targets);
  const range = o.range || reportRange(BP.Targets, o.rangeKey || 'week', today);
  return { range, today, ...teamReport(data, { T: BP.Targets, P: BP.Placements, today, tz: teamZone(ctx), range, period: o.period || 'week', by: o.by, deskIdx: ctx.lk.deskIdx }) };
}

/** Progress bars for BP.Targets.progress rows ("7 / 10"), each a real progressbar for screen readers. */
export function progressList(rows) {
  if (!rows.length) return null;
  return h('div', { class: 'p4-progress' }, rows.map((r) => h('div', { class: 'p4-progress-row' },
    h('span', { class: 'p4-progress-l' }, r.label),
    h('span', { class: 'p4-progress-bar', role: 'progressbar', 'aria-label': `${r.label}: ${r.done} of ${r.target}`, 'aria-valuemin': '0', 'aria-valuemax': String(r.target), 'aria-valuenow': String(Math.min(r.done, r.target)) },
      h('span', { class: 'p4-progress-fill' + (r.met ? ' is-met' : ''), style: `width:${Math.max(2, Math.min(100, r.pct))}%` })),
    h('span', { class: 'p4-progress-n' }, `${r.done} / ${r.target}`))));
}

const PERIOD_TEXT = { day: 'today', week: 'the last 7 days', month: 'this month' };

/** "Team target" (owners and managers) or "Your target" (a recruiter): progress for the period, or how to set one. */
export function targetCard(ctx, row, opts) {
  const o = opts || {};
  const title = o.mine ? 'Your target' : 'Team target';
  const period = o.period || 'week';
  if (!targetsOn(ctx)) return card(title, lockNote(ctx, { badge: FEATURE_FROM.targets, text: 'Targets and the leaderboard come with ' + FEATURE_FROM.targets + '.', plan: true }), { class: 'p4-target-card' });
  if (!row || !row.target) {
    return card(title, h('div', { class: 'stack' },
      empty(o.mine ? 'No target set for you yet. Your owner or manager sets it on Reports.' : 'No team target for the week yet.'),
      !o.mine && ctx.can('set_targets') ? h('a', { class: 'btn btn-secondary', href: '#reports' }, 'Set targets') : null), { class: 'p4-target-card' });
  }
  return card(title, h('div', { class: 'stack' },
    progressList(row.progress),
    h('p', { class: 'hint' }, `Counted over ${PERIOD_TEXT[period]}: submissions on the day sent, interviews on the day held, placements on the start day.`)),
  { class: 'p4-target-card' });
}

/**
 * The leaderboard: ranked by placements, then interviews, then submissions. Duplicates caught sit beside it as a quality number.
 * Owners and managers, and recruiters unless the owner turned it off (perms 'see_leaderboard'); otherwise "Your numbers" (one row).
 */
export function leaderboardCard(ctx, report, opts) {
  const o = opts || {};
  if (!targetsOn(ctx)) return '';
  const me = ctx.session.user.id;
  const all = ctx.can('see_leaderboard');
  const rows = all ? report.rows : report.rows.filter((r) => r.key === me);
  const title = all ? 'Leaderboard, ' + (o.rangeText || 'last 7 days') : 'Your numbers, ' + (o.rangeText || 'last 7 days');
  const pct = (r) => (r.progress.length ? Math.round(r.progress.reduce((a, p) => a + Math.min(100, p.pct), 0) / r.progress.length) : null);
  return card(title, h('div', { class: 'stack' },
    rows.length ? table([
      ...(all ? [{ label: '#', class: 'num p4-rank', cell: (r) => String(r.rank) }] : []),
      { label: 'Recruiter', cell: (r) => h('span', { class: r.key === me ? 'strong' : null }, r.name, r.key === me ? h('span', { class: 'muted' }, ' (you)') : null) },
      { label: 'Placed', class: 'num', cell: (r) => String(r.placements) },
      { label: 'Interviews', class: 'num', cell: (r) => String(r.interviews) },
      { label: 'Submitted', class: 'num', cell: (r) => String(r.submissions) },
      { label: 'Duplicates caught', class: 'num', cell: (r) => (r.duplicates ? chip(String(r.duplicates), 'ok') : h('span', { class: 'muted' }, '0')) },
      { label: 'Target', class: 'num', cell: (r) => (pct(r) === null ? h('span', { class: 'muted' }, '-') : chip(pct(r) + '%', pct(r) >= 100 ? 'ok' : 'neutral')) }
    ], rows, { caption: title, rowClass: (r) => (r.key === me ? 'is-me' : null) }) : empty('No numbers yet for this period.'),
    h('p', { class: 'hint' }, 'Ranked by placements, then interviews, then submissions. Duplicates caught is how often the "already submitted" check stopped a double submission: a good habit, never a penalty.'
      + (all ? '' : ' Your owner shows each recruiter only their own numbers.'))), { class: 'p4-leaderboard' });
}

/** The targets editor (owners and managers): the team's, each desk's and each person's day, week and month targets. */
export function targetsEditor(ctx, BP, targets, onDone) {
  const T = BP.Targets;
  const canSet = ctx.can('set_targets');
  const box = h('div', { class: 'stack' });
  const members = ctx.lk.members.filter((m) => !m.removedAt);
  const scopeName = (t) => (t.memberId ? (ctx.lk.memberName(t.memberId) || 'Former member') : t.deskId ? 'Desk: ' + ((ctx.lk.desks || []).find((d) => d.id === t.deskId) ? deskLabel(ctx.lk.desks.find((d) => d.id === t.deskId)) : 'Removed desk') : 'Whole team');
  const scopes = { team: 'Whole team' };
  for (const d of ctx.lk.desks || []) scopes['desk:' + d.id] = 'Desk: ' + deskLabel(d);
  for (const m of members) scopes['member:' + m.id] = m.name;
  const formBox = h('div');

  function form(existing) {
    clear(formBox);
    const scopeSel = select(scopes, existing ? (existing.memberId ? 'member:' + existing.memberId : existing.deskId ? 'desk:' + existing.deskId : 'team') : 'team', { disabled: Boolean(existing) });
    const periodSel = select({ day: 'A day', week: 'A week (last 7 days)', month: 'A month' }, existing ? existing.period : 'week', { disabled: Boolean(existing) });
    const num = (k) => input({ type: 'number', inputmode: 'numeric', min: '0', max: String(T.TARGET_MAX), step: '1', value: existing && existing[k] ? String(existing[k]) : '', class: 'p4-num' });
    const ins = { submissions: num('submissions'), interviews: num('interviews'), placements: num('placements') };
    const err = h('p', { class: 'p4-err', role: 'alert', hidden: true });
    const save = async (e) => {
      e.preventDefault();
      const scope = scopeSel.value;
      const raw = { period: periodSel.value, submissions: ins.submissions.value.trim(), interviews: ins.interviews.value.trim(), placements: ins.placements.value.trim() };
      const c = T.cleanTarget(raw);
      if (!c.ok) { err.textContent = c.error; err.hidden = false; return; }
      const row = { ...c.target, id: existing ? existing.id : undefined,
        memberId: scope.startsWith('member:') ? scope.slice(7) : '', deskId: scope.startsWith('desk:') ? scope.slice(5) : '' };
      try { await ctx.store.saveTarget(row); toast('Target saved.'); clear(formBox); onDone(); } catch (x) { err.textContent = x.message; err.hidden = false; }
    };
    formBox.append(h('form', { class: 'form p4-target-form', novalidate: true, 'aria-label': existing ? 'Edit target' : 'New target', onsubmit: save },
      h('div', { class: 'grid p4-target-grid' },
        field('For', scopeSel), field('Period', periodSel),
        field('Submissions', ins.submissions), field('Interviews', ins.interviews), field('Placements', ins.placements)),
      err,
      h('div', { class: 'row-end' }, button('Cancel', { variant: 'ghost', onclick: () => clear(formBox) }), h('button', { type: 'submit', class: 'btn btn-primary' }, existing ? 'Save target' : 'Add target'))));
    scopeSel.focus();
  }

  const order = { day: 0, week: 1, month: 2 };
  const rows = targets.slice().sort((a, b) => (a.memberId ? 2 : a.deskId ? 1 : 0) - (b.memberId ? 2 : b.deskId ? 1 : 0) || scopeName(a).localeCompare(scopeName(b)) || order[a.period] - order[b.period]);
  box.append(
    h('p', { class: 'hint' }, "A person's own target counts first, then their desk's, then the whole team's. A week is the last 7 days, a month the calendar month in the team's time zone."),
    rows.length ? table([
      { label: 'For', cell: (t) => scopeName(t) },
      { label: 'Period', cell: (t) => ({ day: 'Day', week: 'Week', month: 'Month' })[t.period] },
      { label: 'Submissions', class: 'num', cell: (t) => String(t.submissions || '-') },
      { label: 'Interviews', class: 'num', cell: (t) => String(t.interviews || '-') },
      { label: 'Placements', class: 'num', cell: (t) => String(t.placements || '-') },
      { label: '', class: 'right', cell: (t) => (canSet ? h('div', { class: 'row-end' },
        button('Edit', { variant: 'ghost', 'aria-label': `Edit the ${t.period} target for ${scopeName(t)}`, onclick: () => form(t) }),
        button('Remove', { variant: 'ghost', 'aria-label': `Remove the ${t.period} target for ${scopeName(t)}`, onclick: async () => {
          try { await ctx.store.deleteTarget(t.id); toast('Target removed.'); onDone(); } catch (x) { toast(x.message); }
        } })) : null) }
    ], rows, { caption: 'Targets' }) : empty('No targets yet. Start with a week target for the whole team.'),
    formBox,
    canSet ? h('div', { class: 'row-end' }, button('Add a target', { variant: 'secondary', onclick: () => form(null) })) : '');
  return card('Targets', box, { class: 'p4-targets' });
}
