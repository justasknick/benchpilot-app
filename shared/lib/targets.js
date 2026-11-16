// lib/targets.js - staffing P4 (docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md): targets, the leaderboard and the funnel reports.
// Pure functions only (no DOM, no chrome.*). One implementation for the extension (Insights: a Solo user's own targets, stored locally as
// `targets`, storage schema 19) and the web app's team workspace (table team_targets, migration 0052; webapp/js/bp-lib.js loads this file),
// so both count and say the same thing. Needs lib/shared.js only (lib/today.js when loaded, for the day in a zone).
//
// Periods (the same rule as webapp/js/stats.js and the morning report):
//   day   = today;  week = the last 7 days including today (a rolling week, so the numbers never jump on a Monday);
//   month = the calendar month so far (the 1st to today). "Today" is the team's day (its time zone) in the web app, the person's in E.
//
//   BP.Targets.cleanTarget({ period, submissions, interviews, placements }) -> { ok, target } | { ok:false, error }
//   BP.Targets.cleanPersonal(value) -> { week?: {submissions, interviews, placements}, month?: {...} }   (E storage; junk is dropped)
//   BP.Targets.periodRange(period, today) -> { from, to } | null          inRange(day, range) -> boolean
//   BP.Targets.events({ submissions:[{id, day, recruiterId}], interviews:[{submissionId, at}], placements:[{submissionId, startOn, status}] }, { tz })
//     -> [{ kind: 'submissions'|'interviews'|'placements', day, recruiterId }]   (an interview or placement counts for its submission's recruiter;
//        an interview on the day it is held, in tz; a placement on its start day; a placement that fell through never counts)
//   BP.Targets.personalEvents(extensionSubmissions, { tz }) -> the same events from E records (interviews[] and placement{} on a submission)
//   BP.Targets.counts(events, range, keep?) -> { submissions, interviews, placements }
//   BP.Targets.targetFor(targets, { memberId, deskId }, period) -> the most specific target: the person's, else their desk's, else the team's
//   BP.Targets.progress(target, done) -> [{ metric, label, target, done, pct, met }]   (only metrics with a target above 0)
//   BP.Targets.rankLeaderboard(rows) -> rows sorted by placements, then interviews, then submissions (then name), each with `rank`
//     (ties share a rank). Duplicates caught are a quality number shown next to it, never a penalty: they never change the order.
//   The funnel per recruiter / desk and the margin per recruiter live with the funnel itself, in lib/placements.js (funnelBy, marginByRecruiter).

(function (root) {
  'use strict';
  if (!(root.BP && root.BP.tierOf) && typeof require === 'function') { require('./shared.js'); }
  const BP = root.BP;

  const PERIODS = ['day', 'week', 'month'];
  const PERSONAL_PERIODS = ['week', 'month'];
  const PERIOD_LABELS = { day: 'Today', week: 'Last 7 days', month: 'This month' };
  const PERIOD_PER = { day: 'a day', week: 'a week', month: 'a month' };
  const METRICS = ['submissions', 'interviews', 'placements'];
  const METRIC_LABELS = { submissions: 'Submissions', interviews: 'Interviews', placements: 'Placements' };
  const TARGET_MAX = 1000;
    const DAY = 86400000;

  const plain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const pad2 = (n) => String(n).padStart(2, '0');
  function cleanDay(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v === null || v === undefined ? '' : v).trim());
    if (!m) return '';
    const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return t.getUTCFullYear() === Number(m[1]) && t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]) ? m[0] : '';
  }
  function addDays(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d) + n * DAY);
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  }
  function toMs(v) {
    if (typeof v === 'number') return v;
    const t = Date.parse(String(v === null || v === undefined ? '' : v));
    return Number.isFinite(t) ? t : NaN;
  }
  // A moment's day in a zone (BP.dayKeyOf from lib/today.js when loaded; otherwise Intl directly; UTC as the last resort).
  function dayIn(ms, tz) {
    if (!Number.isFinite(ms)) return '';
    if (typeof BP.dayKeyOf === 'function') { try { return BP.dayKeyOf(ms, tz || 'Asia/Kolkata'); } catch (e) { /* fall through */ } }
    try {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
      if (cleanDay(p)) return p;
    } catch (e) { /* fall through */ }
    return new Date(ms).toISOString().slice(0, 10);
  }

  // ── targets ──
  function cleanCount(v) {
    if (v === null || v === undefined || v === '') return { ok: true, n: 0 };
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isInteger(n) || n < 0 || n > TARGET_MAX) return { ok: false };
    return { ok: true, n };
  }
  function cleanTarget(input) {
    const i = plain(input) ? input : {};
    const period = PERIODS.includes(i.period) ? i.period : '';
    if (!period) return { ok: false, error: 'Pick a period: day, week or month.' };
    const target = { period };
    for (const k of METRICS) {
      const c = cleanCount(i[k]);
      if (!c.ok) return { ok: false, error: `${METRIC_LABELS[k]}: enter a whole number from 0 to ${TARGET_MAX}.` };
      target[k] = c.n;
    }
    if (!METRICS.some((k) => target[k] > 0)) return { ok: false, error: 'Set at least one number above 0.' };
    return { ok: true, target };
  }
  // The extension keeps one target per period ({ week, month }); a period with no number above 0 is no target.
  function cleanPersonal(v) {
    const out = {};
    if (!plain(v)) return out;
    for (const p of PERSONAL_PERIODS) {
      const r = cleanTarget({ ...(plain(v[p]) ? v[p] : {}), period: p });
      if (r.ok) out[p] = { submissions: r.target.submissions, interviews: r.target.interviews, placements: r.target.placements };
    }
    return out;
  }

  function periodRange(period, today) {
    const t = cleanDay(today);
    if (!t || !PERIODS.includes(period)) return null;
    if (period === 'day') return { from: t, to: t };
    if (period === 'week') return { from: addDays(t, -6), to: t };
    return { from: t.slice(0, 8) + '01', to: t };
  }
  const inRange = (day, r) => Boolean(r && day && day >= r.from && day <= r.to);

  // ── what counts ──
  function events(data, opts) {
    const d = plain(data) ? data : {};
    const tz = (opts && opts.tz) || 'Asia/Kolkata';
    const out = [];
    const recruiterOf = new Map();
    for (const s of Array.isArray(d.submissions) ? d.submissions : []) {
      if (!plain(s)) continue;
      recruiterOf.set(s.id, s.recruiterId || '');
      const day = cleanDay(s.day);
      if (day) out.push({ kind: 'submissions', day, recruiterId: s.recruiterId || '' });
    }
    for (const iv of Array.isArray(d.interviews) ? d.interviews : []) {
      if (!plain(iv) || !recruiterOf.has(iv.submissionId)) continue;
      const day = dayIn(toMs(iv.at), tz);
      if (day) out.push({ kind: 'interviews', day, recruiterId: recruiterOf.get(iv.submissionId) });
    }
    for (const p of Array.isArray(d.placements) ? d.placements : []) {
      if (!plain(p) || p.status === 'fell_through' || !recruiterOf.has(p.submissionId)) continue;
      const day = cleanDay(p.startOn);
      if (day) out.push({ kind: 'placements', day, recruiterId: recruiterOf.get(p.submissionId) });
    }
    return out;
  }
  // E: one person's book. A submission's day is submittedOn when recorded, else the day of submittedAt in tz. Samples and drafts never count.
  function personalEvents(list, opts) {
    const tz = (opts && opts.tz) || 'Asia/Kolkata';
    const submissions = [], interviews = [], placements = [];
    for (const s of Array.isArray(list) ? list : []) {
      if (!plain(s) || s.sample === true || s.draft === true || !s.id) continue;
      submissions.push({ id: s.id, day: cleanDay(s.submittedOn) || dayIn(toMs(s.submittedAt || s.createdAt), tz), recruiterId: 'me' });
      for (const iv of Array.isArray(s.interviews) ? s.interviews : []) if (plain(iv)) interviews.push({ submissionId: s.id, at: iv.at });
      if (plain(s.placement)) placements.push({ submissionId: s.id, startOn: s.placement.startOn, status: s.placement.status });
    }
    return events({ submissions, interviews, placements }, { tz });
  }
  function counts(evts, range, keep) {
    const out = { submissions: 0, interviews: 0, placements: 0 };
    for (const e of Array.isArray(evts) ? evts : []) {
      if (!e || !inRange(e.day, range) || (keep && !keep(e))) continue;
      if (out[e.kind] !== undefined) out[e.kind]++;
    }
    return out;
  }

  // The person's own target, else their desk's, else the team's (member and desk both empty). Targets are cleaned rows with memberId / deskId.
  function targetFor(targets, who, period) {
    const list = (Array.isArray(targets) ? targets : []).filter((t) => plain(t) && t.period === period);
    const w = plain(who) ? who : {};
    return (w.memberId && list.find((t) => t.memberId === w.memberId))
      || (w.deskId && list.find((t) => !t.memberId && t.deskId === w.deskId))
      || list.find((t) => !t.memberId && !t.deskId)
      || null;
  }
  function progress(target, done) {
    if (!plain(target)) return [];
    const d = plain(done) ? done : {};
    return METRICS.filter((k) => Number(target[k]) > 0).map((k) => {
      const t = Number(target[k]), n = Number(d[k]) || 0;
      return { metric: k, label: METRIC_LABELS[k], target: t, done: n, pct: Math.round((n / t) * 100), met: n >= t };
    });
  }

  // ── the leaderboard ──
  function rankLeaderboard(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter(plain).map((r) => ({ ...r,
      placements: Number(r.placements) || 0, interviews: Number(r.interviews) || 0, submissions: Number(r.submissions) || 0 }));
    list.sort((a, b) => b.placements - a.placements || b.interviews - a.interviews || b.submissions - a.submissions
      || String(a.name || '').localeCompare(String(b.name || '')));
    let rank = 0;
    list.forEach((r, i) => {
      const p = list[i - 1];
      if (!p || p.placements !== r.placements || p.interviews !== r.interviews || p.submissions !== r.submissions) rank = i + 1;
      r.rank = rank;
    });
    return list;
  }

  // The month before 'YYYY-MM' (the commission sheet is usually for the month that just ended).
  function prevMonth(month) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
    if (!m) return '';
    const y = Number(m[1]), mo = Number(m[2]);
    return mo === 1 ? `${y - 1}-12` : `${y}-${pad2(mo - 1)}`;
  }

  BP.Targets = {
    PERIODS, PERSONAL_PERIODS, PERIOD_LABELS, PERIOD_PER, METRICS, METRIC_LABELS, TARGET_MAX,
    cleanTarget, cleanPersonal, periodRange, inRange, events, personalEvents, counts, targetFor, progress,
    rankLeaderboard, prevMonth, addDays, dayIn
  };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
