// webapp/js/stats.js - the numbers on the Today screen (spec section 5, item 4). Pure: takes plain rows and an ISO day.
// "This week" means the last 7 days including today (a rolling week), so the numbers do not jump on a Monday.

import { addDays, diffDays } from './dates.js';
import { isHeld } from './team-p2.js';
import { expiringWorkAuth } from './consultant-profile.js';

// Work authorisations ending (staffing P1): the reminder list (120 days, the Today card) and the morning report's 30-day count.
export { expiringWorkAuth };
export const WORK_AUTH_REPORT_DAYS = 30;

export const BENCH_STATUSES = ['marketing', 'interviewing', 'on_hold'];   // consultants who are still on the bench
export const ACTIVE_STATUSES = ['marketing', 'interviewing'];             // consultants who should be getting submitted

export function benchDays(consultant, today) {
  return consultant.benchSince ? Math.max(0, diffDays(today, consultant.benchSince)) : 0;
}

function inLastDays(iso, today, n) {
  if (!iso) return false;
  const d = diffDays(today, iso);
  return d >= 0 && d < n;
}

/**
 * @param {{consultants:Array, submissions:Array, members:Array, companies:Array, contacts:Array, requirements:Array, activity:Array}} data
 * @param {string} today ISO day
 */
export function computeToday(data, today) {
  const { consultants = [], submissions = [], members = [], companies = [], contacts = [], requirements = [], activity = [] } = data;
  const yesterday = addDays(today, -1);

  const submissionsYesterday = submissions.filter((s) => s.submittedOn === yesterday);
  const submissionsWeek = submissions.filter((s) => inLastDays(s.submittedOn, today, 7));
  const interviews = submissions.filter((s) => s.stage === 'client_interview');

  const onBench = consultants.filter((c) => BENCH_STATUSES.includes(c.status));
  const withSubmissionThisWeek = new Set(submissionsWeek.map((s) => s.consultantId));
  // Interview hold (backlog W4): a consultant in interview is not someone to pitch, so they are listed apart (heldThisWeek), not in zeroThisWeek.
  const noSubmission = consultants
    .filter((c) => ACTIVE_STATUSES.includes(c.status) && !withSubmissionThisWeek.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, ownerRecruiterId: c.ownerRecruiterId, benchDays: benchDays(c, today), held: isHeld(c) }))
    .sort((a, b) => b.benchDays - a.benchDays);
  const zeroThisWeek = noSubmission.filter((c) => !c.held);
  const heldThisWeek = noSubmission.filter((c) => c.held);
  const benchOver30 = onBench
    .filter((c) => benchDays(c, today) > 30)
    .map((c) => ({ id: c.id, name: c.name, ownerRecruiterId: c.ownerRecruiterId, benchDays: benchDays(c, today) }))
    .sort((a, b) => b.benchDays - a.benchDays);
  const days = onBench.map((c) => benchDays(c, today));
  const avgBenchDays = days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : 0;

  const newCompanies = companies.filter((c) => inLastDays(c.createdOn, today, 7));
  const newContacts = contacts.filter((c) => inLastDays(c.createdOn, today, 7));
  const guardOverrides = activity.filter((a) => a.action === 'guard_override' && inLastDays(a.at, today, 7)).length;

  const byRecruiter = members
    .filter((m) => m.role !== 'owner' || submissions.some((s) => s.recruiterId === m.id))
    .map((m) => ({
      recruiterId: m.id,
      name: m.name,
      yesterday: submissionsYesterday.filter((s) => s.recruiterId === m.id).length,
      week: submissionsWeek.filter((s) => s.recruiterId === m.id).length
    }));

  return {
    date: today,
    submissionsYesterday: submissionsYesterday.length,
    submissionsWeek: submissionsWeek.length,
    interviews: interviews.length,
    zeroThisWeek,
    heldThisWeek,
    benchOver30,
    avgBenchDays,
    benchCount: onBench.length,
    newVendors: { companies: newCompanies.length, contacts: newContacts.length },
    openRequirements: requirements.filter((r) => r.status === 'open').length,
    guardOverrides,
    byRecruiter,
    workAuth: expiringWorkAuth(consultants, today)
  };
}

// ── Staffing P4 (migration 0052): the leaderboard and the funnel report, per recruiter or per desk ──
// One pure builder for Today's leaderboard and the Reports screen. The counting rules are the extension's own (BP.Targets: an interview on
// the day it is held in the team's zone, a placement on its start day, fell through never; BP.Placements.funnel: submitted -> interview ->
// offer -> placed), passed in as `T` and `P` so this file stays synchronous and testable.

/** The ISO days of a report range: a target period ('day' | 'week' | 'month', BP.Targets.periodRange) or the last N days ('30d', '90d'). */
export function reportRange(T, key, today) {
  const m = /^(\d+)d$/.exec(String(key || ''));
  if (m) return { from: addDays(today, -(Number(m[1]) - 1)), to: today };
  return T.periodRange(key, today);
}

/**
 * @param {{members:Array, consultants:Array, submissions:Array, interviews:Array, placements:Array, catches:Array, targets:Array}} data
 *        catches: listGuardCatches rows; targets: listTargets rows (what the caller may read)
 * @param {{T:object, P:object, today:string, tz:string, range:{from:string,to:string}, period?:string, by?:'recruiter'|'desk', deskIdx?:object}} opts
 *        period: the target period to measure progress against (default 'week'); by 'desk' needs deskIdx (js/desks.js deskIndex)
 * @returns {{rows:Array, total:object}} rows: { key, name, submissions, interviews, placements, duplicates, funnel, avgBenchDays, benchCount,
 *          target, progress, rank } ranked by BP.Targets.rankLeaderboard; total: the same numbers for everyone
 */
export function teamReport(data, opts) {
  const { T, P, today, tz, range } = opts;
  const by = opts.by === 'desk' && opts.deskIdx ? 'desk' : 'recruiter';
  const period = opts.period || 'week';
  const d = data || {};
  const members = (d.members || []).filter((m) => !m.removedAt);
  const subs = d.submissions || [];
  const keyOfUser = by === 'desk' ? (u) => opts.deskIdx.userDesk(u) || 'none' : (u) => u || '';
  const keyOfConsultant = by === 'desk' ? (c) => opts.deskIdx.consultantDesk(c) || 'none' : (c) => c.ownerRecruiterId || '';
  const evts = T.events({
    submissions: subs.map((s) => ({ id: s.id, day: s.submittedOn, recruiterId: s.recruiterId })),
    interviews: d.interviews || [],
    placements: (d.placements || []).map((p) => ({ submissionId: p.submissionId, startOn: p.startOn, status: p.status }))
  }, { tz });
  const ivBySub = new Map();
  for (const iv of d.interviews || []) { if (!ivBySub.has(iv.submissionId)) ivBySub.set(iv.submissionId, []); ivBySub.get(iv.submissionId).push(iv); }
  const plBySub = new Map((d.placements || []).map((p) => [p.submissionId, p]));
  const funnelItems = subs.filter((s) => T.inRange(s.submittedOn, range))
    .map((s) => ({ key: keyOfUser(s.recruiterId), stage: s.stage, interviews: ivBySub.get(s.id) || [], placement: plBySub.get(s.id) || null }));
  const funnels = new Map(P.funnelBy(funnelItems, (x) => x.key).map((f) => [f.key, f]));
  const emptyFunnel = P.funnel([]);

  // Who gets a row: every active member who is not an owner (owners only when they submit), as the Today screen; per desk: every desk,
  // plus "No desk" when someone has none.
  let groups;
  if (by === 'desk') {
    groups = opts.deskIdx.list.map((x) => ({ key: x.id, name: opts.deskIdx.name(x.id), deskId: x.id }));
    if (members.some((m) => !opts.deskIdx.userDesk(m.id))) groups.push({ key: 'none', name: 'No desk', deskId: '' });
  } else {
    groups = members.filter((m) => m.role !== 'owner' || subs.some((s) => s.recruiterId === m.id))
      .map((m) => ({ key: m.id, name: m.name, memberId: m.id, deskId: opts.deskIdx ? opts.deskIdx.userDesk(m.id) : '' }));
  }
  const bench = (d.consultants || []).filter((c) => BENCH_STATUSES.includes(c.status) && !c.erased);
  const periodRange = T.periodRange(period, today);
  const sumCatches = (keep) => (d.catches || []).filter((c) => T.inRange(c.day, range) && keep(c)).reduce((a, c) => a + (Number(c.warned) || 0), 0);
  const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : 0);
  const rows = groups.map((g) => {
    const mine = (e) => keyOfUser(e.recruiterId) === g.key;
    const benchMine = bench.filter((c) => keyOfConsultant(c) === g.key).map((c) => benchDays(c, today));
    const target = by === 'desk'
      ? (g.deskId && (d.targets || []).find((t) => !t.memberId && t.period === period && t.deskId === g.deskId)) || null
      : T.targetFor(d.targets, { memberId: g.memberId, deskId: g.deskId }, period);
    return { key: g.key, name: g.name, ...T.counts(evts, range, mine), duplicates: sumCatches((c) => keyOfUser(c.userId) === g.key),
      funnel: funnels.get(g.key) || emptyFunnel, avgBenchDays: avg(benchMine), benchCount: benchMine.length,
      target, progress: target ? T.progress(target, T.counts(evts, periodRange, mine)) : [] };
  });
  const teamTarget = T.targetFor(d.targets, {}, period);
  const total = { ...T.counts(evts, range), duplicates: sumCatches(() => true), funnel: P.funnel(funnelItems),
    avgBenchDays: avg(bench.map((c) => benchDays(c, today))), benchCount: bench.length,
    target: teamTarget, progress: teamTarget ? T.progress(teamTarget, T.counts(evts, periodRange)) : [] };
  return { rows: T.rankLeaderboard(rows), total };
}

/**
 * The funnel by skill family (Reports): the range's submissions grouped by BP.submissionFamily (the requirement's title and skills, else the
 * consultant's), the same rule and order as the extension's Insights (BP.Placements.funnelByFamily). `keep(sub)` narrows the submissions
 * (a recruiter sees their own). @returns [{ key: family, submitted, interview, offer, placed, rates }]
 */
export function familyFunnel(data, opts) {
  const { T, P, BP, range } = opts;
  const keep = opts.keep || (() => true);
  const d = data || {};
  const reqs = new Map((d.requirements || []).map((r) => [r.id, r]));
  const cons = new Map((d.consultants || []).map((c) => [c.id, c]));
  const ivBySub = new Map();
  for (const iv of d.interviews || []) { if (!ivBySub.has(iv.submissionId)) ivBySub.set(iv.submissionId, []); ivBySub.get(iv.submissionId).push(iv); }
  const plBySub = new Map((d.placements || []).map((p) => [p.submissionId, p]));
  const items = (d.submissions || []).filter((s) => T.inRange(s.submittedOn, range) && keep(s)).map((s) => ({
    family: BP.submissionFamily(s, { requirement: reqs.get(s.requirementId) || null, consultant: cons.get(s.consultantId) || null }),
    stage: s.stage, interviews: ivBySub.get(s.id) || [], placement: plBySub.get(s.id) || null
  }));
  return P.funnelByFamily(items);
}
