// webapp/js/guard.js - the team-wide "already submitted?" guard (docs/specs/TEAM_WORKSPACE_SPEC.md section 4).
//
// RULE: a submission matches when it has the SAME consultant AND at least one of
//   - the same normalised end client,
//   - the same requirement,
//   - the same job reference,
// and it was made within the last 90 days.
//
// Pure functions: no DOM, no storage, no clock (the caller passes `today`). The demo store runs it locally; the live store asks the server
// (`team` function, action `guard`), which runs the same rule in the SQL function
// bp_team_guard(); keep the two in step and keep tests/guard.test.mjs as the shared examples.

import { diffDays, fmtShort } from './dates.js';

export const GUARD_DAYS = 90;
export const MIN_REASON_LENGTH = 8;

const SUFFIXES = new Set(['inc', 'llc', 'corp', 'ltd', 'technologies']);

/**
 * End-client key: lower case, trimmed, punctuation removed, then the trailing words
 * inc / llc / corp / ltd / technologies removed.
 * "BrightField Bank, Inc." and "Brightfield Bank" both become "brightfield bank".
 */
export function normalizeEndClient(name) {
  let s = String(name == null ? '' : name).toLowerCase().trim();
  s = s.replace(/\./g, '');                       // "L.L.C." -> "llc", "Corp." -> "corp"
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, ' ');       // other punctuation separates words
  const words = s.split(/\s+/).filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  if (words.length === 1 && SUFFIXES.has(words[0])) return '';
  return words.join(' ');
}

/** Job reference key: lower case letters and digits only ("BF-2291" == "bf 2291"). */
export function normalizeJobRef(ref) {
  return String(ref == null ? '' : ref).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * @param {{consultantId:string, endClient?:string, requirementId?:string, jobRef?:string, excludeId?:string}} query
 * @param {Array} submissions  rows with consultantId, endClient, requirementId, jobRef, submittedOn (ISO day)
 * @param {{today:string, days?:number}} opts
 * @returns {Array<{submission:object, reasons:string[], daysAgo:number}>} newest first; reasons are
 *          'end_client' | 'requirement' | 'job_ref'
 */
export function checkGuard(query, submissions, opts) {
  const q = query || {};
  if (!q.consultantId || !Array.isArray(submissions)) return [];
  const today = opts && opts.today;
  const days = (opts && opts.days) || GUARD_DAYS;
  const client = normalizeEndClient(q.endClient);
  const job = normalizeJobRef(q.jobRef);
  const out = [];
  for (const s of submissions) {
    if (!s || s.consultantId !== q.consultantId) continue;
    if (q.excludeId && s.id === q.excludeId) continue;
    if (!s.submittedOn) continue;
    const daysAgo = diffDays(today, s.submittedOn);
    if (Math.abs(daysAgo) > days) continue;
    const reasons = [];
    if (client && normalizeEndClient(s.endClient) === client) reasons.push('end_client');
    if (q.requirementId && s.requirementId === q.requirementId) reasons.push('requirement');
    if (job && normalizeJobRef(s.jobRef) === job) reasons.push('job_ref');
    if (reasons.length) out.push({ submission: s, reasons, daysAgo });
  }
  out.sort((a, b) => a.daysAgo - b.daysAgo);
  return out;
}

export const REASON_LABELS = {
  end_client: 'Same end client',
  requirement: 'Same requirement',
  job_ref: 'Same job reference'
};

/** "Ravi K. was submitted to Brightfield Bank by Priya S. on 28 Oct through Northbay Staffing." */
export function describeMatch(match, names) {
  const s = match.submission;
  const n = names || {};
  const who = n.consultant || 'This consultant';
  const to = s.endClient || n.vendor || 'another company';
  const by = n.recruiter ? ` by ${n.recruiter}` : '';
  // 0046: the whole vendor chain of the earlier submission ("through Northbay Staffing → Apex Prime → Infosys"). The rule above already
  // matches the same end client through ANY vendor, so a different chain is still caught; the text shows which chain it went through.
  const chain = Array.isArray(s.chain) ? s.chain.filter((x) => typeof x === 'string' && x.trim()) : [];
  const path = [n.vendor, ...chain].filter(Boolean).join(' → ');
  const via = path ? ` through ${path}` : '';
  return `${who} was submitted to ${to}${by} on ${fmtShort(s.submittedOn)}${via}.`;
}

/** A reason typed to continue past a match must be at least 8 characters (the extension's rule). */
export function reasonOk(reason) {
  return String(reason == null ? '' : reason).trim().length >= MIN_REASON_LENGTH;
}
