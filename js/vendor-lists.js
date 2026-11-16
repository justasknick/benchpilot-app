// webapp/js/vendor-lists.js - smart lists in the team vendor book (backlog W5). Pure: no DOM, no storage; the clock is passed in.
// A list is a NAME and a RULE in the extension's own rule shape (lib/vendor-book.js sanitizeRules); every count and every row comes from
// the extension's own evaluator BP.VendorBook.evaluateList over the team book (team-p2.js vendorBookState + the contacts).
// Built-in lists are the extension's four (VENDOR_BOOK_SPEC section 3.5); saved lists are the team's (migration 0027, team_smart_lists).
//
//   BUILT_IN_LISTS                          [{ id, name, rules }]   Hot now, Cold 60+ days, Replied in 30 days, Missing phone
//   listState(data)                         -> { companies, allLeads (= contacts), postLogs, submissions } for evaluateList
//   evaluate(VB, list, state, nowMs, stats) -> { ids:Set<companyId>, count, stale }   never throws
//   rulesFromForm(VB, form)                 -> clean rules ({} when nothing is chosen)
//   checkName(name, lists)                  -> '' | the problem in words

import { vendorBookState } from './team-p2.js';

export const SMART_LIST_MAX = 25;
export const SMART_LIST_NAME_MAX = 40;
export const BUILT_IN_LISTS = [
  { id: 'builtin:hot', name: 'Hot now', rules: { heat: ['hot'] } },
  { id: 'builtin:cold', name: 'Cold 60+ days', rules: { heat: ['cold'] } },
  { id: 'builtin:replied30', name: 'Replied in 30 days', rules: { repliedWithinDays: 30 } },
  // A vendor where no contact has a phone (the extension's vendor rule hasPhone: "at least one recruiter at the vendor has it").
  { id: 'builtin:noPhone', name: 'Missing phone', rules: { hasPhone: false } }
];

// Team tiers in the extension's words: avoid is a trust label; prime and direct client are vendor types (vendorTypeOf reads `tier`).
const TYPE_OF_TIER = { prime: 'prime-vendor', direct_client: 'direct-client' };

/** @param {{vendors:object[], contacts:object[], requirements:object[], submissions:object[]}} data  the team book (store rows) */
export function listState(data) {
  const d = data || {};
  const base = vendorBookState(d);
  const byId = new Map((d.vendors || []).map((v) => [v.id, v]));
  return {
    ...base,
    companies: base.companies.map((c) => {
      const v = byId.get(c.id) || {};
      return { ...c, label: v.tier === 'avoid' ? 'avoid' : '', tier: TYPE_OF_TIER[v.tier] || '' };
    }),
    // The recruiters of each vendor are its contacts (phone rule). Emails are only keys here; nothing leaves the browser.
    allLeads: (d.contacts || []).filter((c) => c && c.companyId && c.email).map((c) => ({ email: c.email, companyId: c.companyId, phone: c.phone || '' }))
  };
}

/** The list's companies. `stats` is vendorHeat's map (the heat the table shows), so a list and the Heat column always agree. */
export function evaluate(VB, list, state, nowMs, stats) {
  try {
    const r = VB.evaluateList({ id: 'list', scope: 'vendors', name: 'List', rules: (list && list.rules) || {} }, state, nowMs, stats);
    return { ids: new Set(r.ids), count: r.count, stale: r.stale || [] };
  } catch (e) { return { ids: new Set(), count: 0, stale: [] }; }
}

/**
 * The "Save a list" form in rules. form: { heat: ''|'hot'|'active'|'cold', family: '' | a role family, replied: ''|'30'|'90',
 * notSeen: ''|'30'|'60'|'90', phone: ''|'has'|'missing' }.
 */
export function rulesFromForm(VB, form) {
  const f = form || {};
  const rules = {};
  if (f.heat) rules.heat = [f.heat];
  if (f.family) rules.families = [f.family];
  if (Number(f.replied) > 0) rules.repliedWithinDays = Number(f.replied);
  if (Number(f.notSeen) > 0) rules.notSeenDays = Number(f.notSeen);
  if (f.phone === 'has') rules.hasPhone = true;
  if (f.phone === 'missing') rules.hasPhone = false;
  return VB.sanitizeRules(rules);
}

export function checkName(name, lists) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return 'Give the list a name.';
  if (n.length > SMART_LIST_NAME_MAX) return `Keep the name to ${SMART_LIST_NAME_MAX} characters.`;
  const all = [...BUILT_IN_LISTS, ...(lists || [])];
  if (all.some((l) => String(l.name).trim().toLowerCase() === n.toLowerCase())) return 'A list with that name already exists.';
  return '';
}
