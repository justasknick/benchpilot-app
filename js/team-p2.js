// webapp/js/team-p2.js - the team P2 helpers (docs/specs/TEAM_P2_SPEC.md): adapters from the team book to the extension's own pure code,
// plus the counts the extension has no counterpart for. Pure: no DOM, no storage; the clock is passed in (nowMs, today).
//
//   vendorHeat(VB, data, nowMs)          -> Map companyId -> extension vendorStats entry (heat, posts30, tags ...)   (BP.VendorBook)
//   vendorBookState(data)                -> the team book as the extension's Vendor Book state { companies, allLeads, postLogs, submissions }
//   responseStats(submissions, today, days) -> Map companyId -> { sent, replied, interviews, placed, replyRate, interviewRate, placementRate }
//   requirementLead(BP, r, nowMs)        -> an extension lead for BP.scoreMatch
//   consultantForMatch(c)                -> an extension consultant for BP.scoreMatch
//   sameRoleGroups(SR, requirements)     -> Map requirementId -> { id, requirements, vendorCount }   (BP.SameRole, the extension's v1.18 grouping)
//   collapseSameRole(rows, groups, idOf) -> one { row, group } per same-role group
//   isHeld(c)                            -> true for a consultant in interview: held out of Matches and pitch lists (backlog W4)
//   teamMatches(BP, data, opts)          -> { requirements: [{ requirement, matches, sameRole }], consultants: [{ consultant, matches }], held,
//                                           hidden: [{ requirement, consultant, reason }] (work authorisation not taken), notYet: [consultant] }
//   reminders(data, nowMs, opts)         -> [{ kind, recruiterId, hours, submission | requirement, sameRole? }]

import { checkGuard } from './guard.js';
import { diffDays } from './dates.js';
import { consultantVisaType, availableLater } from './consultant-profile.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** An ISO day is read as the start of that local day; a timestamp as itself. NaN when neither. */
export function timeOf(v) {
  if (isDay(v)) { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
  const t = typeof v === 'string' && v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : NaN;
}
const isoOf = (v) => { const t = timeOf(v); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };

// ── 1. Vendor heat (the extension's BP.VendorBook.vendorStats on the team model) ───────────────────────────────────────────────
/** Team stage -> the extension's submission status (lib/vendor-book.js reads 'Submitted' as "no reply"; Interview/Offer/Placed lift heat). */
export const STAGE_TO_STATUS = {
  submitted: 'Submitted', no_response: 'Submitted', vendor_screen: 'Screening', client_interview: 'Interview', offer: 'Offer', placed: 'Placed', rejected: 'Rejected'
};
const vendorKey = (id) => 'vendor-' + lc(id) + '@team.invalid';

/**
 * @param {object} VB    BP.VendorBook (loaded by bp-lib loadHeatLib)
 * @param {{vendors:object[], requirements:object[], submissions:object[]}} data  the team book (store rows)
 */
export function vendorHeat(VB, data, nowMs) {
  return VB.vendorStats(vendorBookState(data), nowMs);
}

/** The team book in the shape BP.VendorBook reads (vendorStats; smart lists in vendor-lists.js add the contacts). */
export function vendorBookState(data) {
  const d = data || {};
  const vendors = d.vendors || [];
  const postLogs = {};
  for (const v of vendors) postLogs[vendorKey(v.id)] = [];
  for (const r of d.requirements || []) {
    const log = r.vendorCompanyId ? postLogs[vendorKey(r.vendorCompanyId)] : null;
    const at = isoOf(r.postedOn) || isoOf(r.createdAt);
    if (log && at) log.push({ k: 'req:' + r.id, at, requirement: r.title || '', technologies: (r.skills || []).join(', ') });
  }
  return {
    // A team company without a domain was named by the team itself, so it is eligible (the free-mail check is for real domains only).
    companies: vendors.map((v) => ({ id: v.id, domain: lc(v.domain) || lc(v.id) + '.team.invalid' })),
    allLeads: vendors.map((v) => ({ email: vendorKey(v.id), companyId: v.id, savedAt: isoOf(v.createdOn) })),
    postLogs,
    submissions: (d.submissions || []).filter((s) => s.vendorCompanyId).map((s) => ({
      companyId: s.vendorCompanyId, status: STAGE_TO_STATUS[s.stage] || 'Submitted',
      updatedAt: isoOf(s.updatedAt) || isoOf(s.submittedOn), submittedAt: isoOf(s.submittedOn)
    }))
  };
}

// ── Response stats (no extension counterpart: the team log has stages) ──────────────────────────────────────────────────────────
const REPLIED = new Set(['vendor_screen', 'client_interview', 'offer', 'placed', 'rejected']);
const INTERVIEW = new Set(['client_interview', 'offer', 'placed']);
const pct = (n, of) => (of > 0 ? Math.round((100 * n) / of) : null);

/** Submissions per vendor company made in the last `days` days (today included). */
export function responseStats(submissions, today, days) {
  const out = new Map();
  for (const s of submissions || []) {
    if (!s || !s.vendorCompanyId || !isDay(s.submittedOn)) continue;
    const ago = diffDays(today, s.submittedOn);
    if (ago < 0 || ago >= days) continue;
    let v = out.get(s.vendorCompanyId);
    if (!v) out.set(s.vendorCompanyId, v = { sent: 0, replied: 0, interviews: 0, placed: 0 });
    v.sent++;
    if (REPLIED.has(s.stage)) v.replied++;
    if (INTERVIEW.has(s.stage)) v.interviews++;
    if (s.stage === 'placed') v.placed++;
  }
  for (const v of out.values()) Object.assign(v, { replyRate: pct(v.replied, v.sent), interviewRate: pct(v.interviews, v.sent), placementRate: pct(v.placed, v.sent) });
  return out;
}

// ── Same role from several vendors (backlog W2: the extension's BP.SameRole.groupSameRole on the team book) ───────────────────
/** The time a requirement was posted (posted_on, else created_at), for the 14-day same-role window. */
const postedMs = (r) => { const t = timeOf(r.postedOn); return Number.isFinite(t) ? t : timeOf(r.createdAt); };

/**
 * @param {object|null} SR  BP.SameRole (lib/shared.js, loaded by bp-lib loadBP / loadMatchLib); null -> every requirement is its own group
 * @returns {Map<string, {id:string, requirements:object[], vendorCount:number}>} every requirement id -> its group. vendorCount counts
 *          distinct vendor companies (a post with no company counts as one vendor), so "Same role from N vendors" never counts a vendor twice.
 */
export function sameRoleGroups(SR, requirements) {
  const list = requirements || [];
  const groups = SR && SR.groupSameRole
    ? SR.groupSameRole(list.map((r) => ({ title: r.title, endClient: r.endClient, jobId: r.jobRef, ms: postedMs(r) || 0 })))
    : list.map((_, i) => ({ id: 'g' + i, indexes: [i] }));
  const out = new Map();
  for (const g of groups) {
    const reqs = g.indexes.map((i) => list[i]);
    const vendors = new Set(reqs.map((r, i) => r.vendorCompanyId || '#' + i));
    const group = { id: g.id, requirements: reqs, vendorCount: vendors.size };
    for (const r of reqs) out.set(r.id, group);
  }
  return out;
}

/** One { row, group } per same-role group: the first row of each group, in the given order. */
export function collapseSameRole(rows, groups, idOf) {
  const key = idOf || ((r) => r.id);
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const g = groups.get(key(row)) || null;
    const gid = g ? g.id : 'solo:' + key(row);
    if (seen.has(gid)) continue;
    seen.add(gid);
    out.push({ row, group: g });
  }
  return out;
}

// ── 2. Matching across the whole bench (the extension's BP.scoreMatch) ─────────────────────────────────────────────────────────
/** Consultants who are matched: the ones being marketed (and, with "show held", the ones in interview). */
export const MATCH_STATUSES = ['marketing', 'interviewing'];
/** Interview hold (backlog W4): a consultant in interview is held out of Matches and pitch lists until "show held" is on. */
export const HELD_STATUSES = ['interviewing'];
export const isHeld = (c) => Boolean(c) && HELD_STATUSES.includes(c.status);
export const MATCHES_SHOWN = 5;

export function requirementLead(BP, r, nowMs) {
  const skills = (r.skills || []).join(', ');
  const text = [r.title, r.rawText, skills ? 'Skills: ' + skills : '', r.rateText ? 'Rate: ' + r.rateText : '', r.visaText ? 'Visa: ' + r.visaText : '',
    r.taxTerms, r.workMode, r.location ? 'Location: ' + r.location : '', r.duration ? 'Duration: ' + r.duration : ''].filter(Boolean).join('\n');
  let tags = {};
  let f = {};
  try { tags = BP.extractPostTags ? BP.extractPostTags(text) || {} : {}; } catch (e) { tags = {}; }
  try { f = BP.parseRequirementFields ? BP.parseRequirementFields(text, { now: nowMs }) || {} : {}; } catch (e) { f = {}; }
  return {
    ...tags,
    email: 'req-' + lc(r.id) + '@team.invalid', requirement: r.title || '', technologies: skills, notes: text, location: r.location || '',
    workMode: lc(r.workMode) || tags.workMode || '', postedAt: isoOf(r.postedOn) || isoOf(r.createdAt),
    // The requirement's own visa tags (0026, editable on the requirement) decide; text reading is only for a row that has none.
    rate: f.rate || null, deadline: f.deadline || '',
    ...visaRules(r, f),
    closed: Boolean(BP.hasClosedWording && BP.hasClosedWording(r.rawText || ''))
  };
}

/** The visa rules a requirement row carries (visaAllowed / visaNotAllowed, migration 0026), else what the text says. */
export function visaRules(r, parsed) {
  const has = Array.isArray(r.visaAllowed) && Array.isArray(r.visaNotAllowed) && (r.visaAllowed.length || r.visaNotAllowed.length);
  return has ? { visaAllowed: r.visaAllowed.slice(), visaNotAllowed: r.visaNotAllowed.slice() }
    : { visaAllowed: (parsed && parsed.visaAllowed) || [], visaNotAllowed: (parsed && parsed.visaNotAllowed) || [] };
}

export function consultantForMatch(c) {
  return {
    // visaType (0045) is what the matcher compares with a requirement's visa rules; visa stays the free-text note.
    id: c.id, name: c.name || '', title: c.title || '', skills: (c.skills || []).join(', '), visa: c.visa || '', visaType: consultantVisaType(c), taxTerms: c.taxTerms || '',
    rate: c.rate || '', location: c.location || '', relocation: c.relocation ? 'Yes' : '', active: true
  };
}

/**
 * @param {object} BP   the extension's shared BP (scoreMatch, requirementState, BP.extractPostTags, BP.parseRequirementFields, BP.SameRole)
 * @param {{requirements:object[], consultants:object[], submissions:object[]}} data
 * @param {{today:string, nowMs:number, shown?:number, showHeld?:boolean}} opts
 * Every match carries `guard`: the newest team submission of that consultant to that requirement / end client / job ref in 90 days, or null,
 * and `held` (the consultant is in interview). Consultants in interview are left out unless opts.showHeld; `held` lists them either way.
 * The same role posted by several vendors is one entry (the best-matching copy) with `sameRole` = { count, others } (the other copies).
 */
export function teamMatches(BP, data, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  const shown = o.shown || MATCHES_SHOWN;
  const d = data || {};
  const subs = d.submissions || [];
  const reqs = (d.requirements || []).filter((r) => r.status !== 'closed')
    .map((r) => ({ r, lead: requirementLead(BP, r, now) }))
    .filter((x) => BP.requirementState(x.lead, now).state === 'open');
  const held = (d.consultants || []).filter(isHeld);
  // Availability (staffing P1): a consultant free only more than 30 days from now is not pitched yet; listed as notYet.
  const today = o.today || '';
  const notYet = (d.consultants || []).filter((c) => MATCH_STATUSES.includes(c.status) && today && availableLater(c, today));
  const bench = (d.consultants || []).filter((c) => MATCH_STATUSES.includes(c.status) && (o.showHeld || !isHeld(c)) && !notYet.includes(c))
    .map((c) => ({ c, ext: consultantForMatch(c) }));
  const hidden = [];
  const groups = sameRoleGroups(BP.SameRole || null, reqs.map((x) => x.r));
  const byReq = new Map(reqs.map((x) => [x.r.id, []]));
  const byCon = new Map(bench.map((x) => [x.c.id, []]));
  for (const { r, lead } of reqs) {
    for (const { c, ext } of bench) {
      const m = BP.scoreMatch(lead, ext, { now, explain: true });
      if (!m) continue;
      if (m.blocked) {
        // A work authorisation the requirement does not take: hidden, with the reason, so nobody wonders where the consultant went.
        const visa = (m.blockers || []).find((b) => /^visa\b/.test(b));
        if (visa) hidden.push({ requirement: r, consultant: c, reason: `Work authorisation ${ext.visaType} is not taken by this requirement` });
        continue;
      }
      const hits = checkGuard({ consultantId: c.id, endClient: r.endClient, requirementId: r.id, jobRef: r.jobRef }, subs, { today: o.today });
      const row = { requirement: r, consultant: c, percent: m.percent, reasons: m.reasons.filter(Boolean), missing: m.missing, needsLook: Boolean(m.needsLook),
        guard: hits.length ? hits[0].submission : null, held: isHeld(c) };
      byReq.get(r.id).push(row);
      byCon.get(c.id).push(row);
    }
  }
  // Not yet submitted first, then the best score.
  const order = (a, b) => (Boolean(a.guard) - Boolean(b.guard)) || (b.percent - a.percent);
  const pack = (map, key, list) => list.map((x) => ({ [key]: x, total: map.get(x.id).length, matches: map.get(x.id).sort(order) }))
    .filter((x) => x.total > 0)
    .sort((a, b) => (b.matches[0].percent - a.matches[0].percent));
  const sameRole = (r) => {
    const g = groups.get(r.id);
    return g && g.requirements.length > 1 ? { count: g.vendorCount, others: g.requirements.filter((x) => x.id !== r.id) } : null;
  };
  // By requirement: one entry per role (the copy with the best match, as sorted).
  const byRole = collapseSameRole(pack(byReq, 'requirement', reqs.map((x) => x.r)), groups, (x) => x.requirement.id)
    .map(({ row }) => ({ ...row, matches: row.matches.slice(0, shown), sameRole: sameRole(row.requirement) }));
  // By consultant: one match per role (the best-scoring copy), carrying the same-role count.
  const byConsultant = pack(byCon, 'consultant', bench.map((x) => x.c)).map((x) => {
    const one = collapseSameRole(x.matches, groups, (m) => m.requirement.id).map(({ row }) => ({ ...row, sameRole: sameRole(row.requirement) }));
    return { ...x, total: one.length, matches: one.slice(0, shown) };
  });
  return { requirements: byRole, consultants: byConsultant, held, hidden, notYet };
}

// ── 3. 24/48-hour reminders ───────────────────────────────────────────────────────────────────────────────────────────────────
export const REMIND = { vendorHours: 24, clientHours: 48, requirementHours: 24, maxDays: 14, shown: 50 };
const CLIENT_STAGES = new Set(['vendor_screen', 'client_interview']);

/** The last change to a submission: updated_at, else created_at, else the submission day. */
export function lastUpdateMs(s) {
  const t = timeOf(s.updatedAt);
  if (Number.isFinite(t)) return t;
  const c = timeOf(s.createdAt);
  return Number.isFinite(c) ? c : timeOf(s.submittedOn);
}

/**
 * @param {{submissions:object[], requirements:object[]}} data
 * @param {{sameRole?:object}} [opts]  sameRole: BP.SameRole. The same role from several vendors is one "No submission yet" reminder (the oldest
 *          copy, with sameRole = { count }), and a submission to any copy of the role clears it.
 * @returns {Array<{kind:'vendor'|'client'|'requirement', recruiterId:string, hours:number, submission?:object, requirement?:object, sameRole?:object}>}
 *          oldest first. Nothing is sent: the Today screen lists them.
 */
export function reminders(data, nowMs, opts) {
  const d = data || {};
  const out = [];
  const tooOld = (t) => nowMs - t > REMIND.maxDays * DAY;
  for (const s of d.submissions || []) {
    const due = s.stage === 'submitted' ? REMIND.vendorHours : CLIENT_STAGES.has(s.stage) ? REMIND.clientHours : 0;
    if (!due) continue;
    const t = lastUpdateMs(s);
    if (!Number.isFinite(t) || tooOld(t)) continue;
    const hours = Math.floor((nowMs - t) / HOUR);
    if (hours >= due) out.push({ kind: s.stage === 'submitted' ? 'vendor' : 'client', recruiterId: s.recruiterId || '', hours, submission: s });
  }
  const submitted = new Set((d.submissions || []).map((s) => s.requirementId).filter(Boolean));
  const open = (d.requirements || []).filter((r) => r.status !== 'closed');
  const groups = sameRoleGroups((opts && opts.sameRole) || null, open);
  const roleDone = new Set(open.filter((r) => submitted.has(r.id)).map((r) => groups.get(r.id).id));
  const roleSeen = new Set();
  const createdMs = (r) => (Number.isFinite(timeOf(r.createdAt)) ? timeOf(r.createdAt) : timeOf(r.postedOn));
  for (const r of open.slice().sort((a, b) => (createdMs(a) || 0) - (createdMs(b) || 0))) {
    const g = groups.get(r.id);
    if (roleDone.has(g.id) || roleSeen.has(g.id)) continue;
    const t = createdMs(r);
    if (!Number.isFinite(t) || tooOld(t)) continue;
    const hours = Math.floor((nowMs - t) / HOUR);
    if (hours < REMIND.requirementHours) continue;
    roleSeen.add(g.id);
    out.push({ kind: 'requirement', recruiterId: r.createdBy || '', hours, requirement: r, ...(g.requirements.length > 1 ? { sameRole: { count: g.vendorCount } } : {}) });
  }
  return out.sort((a, b) => b.hours - a.hours);
}
