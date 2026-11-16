// webapp/js/desks.js - desks / offices for the Agency plan (backlog W10, migration 0036). Pure, no DOM.
//
// A desk is a name and an optional office. Owners and managers create desks, seat each recruiter on at most one desk, and may put a
// consultant on a desk of their own; a consultant without one counts on their recruiter's desk (the same rule as the server's
// bp_report_desks). The screens filter by desk:
//   Bench and Matches  consultants whose desk (their own, else their recruiter's) is the chosen one
//   Requirements       added by someone on the desk
//   Submissions        logged by someone on the desk
//   Activity log       done by someone on the desk (listAudit({actorIds}))
// NO_DESK picks what sits on no desk. The filters show only on plans with 'desks' (plan-gate.js) and once a desk exists.

export const DESK_MAX = 50;
export const DESK_NAME_MAX = 60;
export const DESK_OFFICE_MAX = 80;
export const NO_DESK = 'none';

const CNTRL = /[\u0000-\u001f\u007f]/;

/**
 * Check a desk before it is saved (the database checks the same: 0036 team_desks).
 * @param {{id?:string, name?:string, office?:string}} row
 * @param {{id:string, name:string}[]} existing  the team's desks
 * @returns {{name:string, office:string}}  throws Error with a plain message
 */
export function cleanDesk(row, existing) {
  const r = row || {};
  const name = String(r.name == null ? '' : r.name).trim();
  const office = String(r.office == null ? '' : r.office).trim();
  if (!name) throw new Error('A desk needs a name.');
  if (name.length > DESK_NAME_MAX) throw new Error(`Keep the desk name under ${DESK_NAME_MAX + 1} characters.`);
  if (office.length > DESK_OFFICE_MAX) throw new Error(`Keep the office under ${DESK_OFFICE_MAX + 1} characters.`);
  if (CNTRL.test(name) || CNTRL.test(office)) throw new Error('Use plain text for the desk name and office.');
  const list = existing || [];
  if (list.some((d) => d.id !== r.id && String(d.name).trim().toLowerCase() === name.toLowerCase())) throw new Error(`A desk called "${name}" already exists.`);
  if (!r.id && list.length >= DESK_MAX) throw new Error(`A team keeps at most ${DESK_MAX} desks. Delete one first.`);
  return { name, office };
}

/** "Java desk (Hyderabad)" or "Java desk". */
export function deskLabel(d) {
  if (!d) return '';
  return d.office ? `${d.name} (${d.office})` : d.name;
}

/**
 * The lookup the screens use.
 * @param {{id:string, name:string, office?:string, memberIds?:string[]}[]} desks
 */
export function deskIndex(desks) {
  const list = Array.isArray(desks) ? desks : [];
  const byId = new Map(list.map((d) => [d.id, d]));
  const byUser = new Map();
  for (const d of list) for (const u of d.memberIds || []) byUser.set(u, d.id);
  return {
    list,
    byId,
    byUser,
    /** The desk id a member sits on, or ''. */
    userDesk: (userId) => byUser.get(userId) || '',
    /** A consultant's desk: their own, else their recruiter's, else ''. */
    consultantDesk: (c) => (c && c.deskId && byId.has(c.deskId) ? c.deskId : (c && byUser.get(c.ownerRecruiterId)) || ''),
    name: (id) => (byId.has(id) ? deskLabel(byId.get(id)) : '')
  };
}

/** True when `deskId` ('' = all, NO_DESK = none) picks the desk `actual` ('' = none). */
export function deskPicks(deskId, actual) {
  if (!deskId) return true;
  if (deskId === NO_DESK) return !actual;
  return actual === deskId;
}

/**
 * Keep the rows of one desk.
 * @param {'consultant'|'requirement'|'submission'} kind
 * @param {object[]} rows
 * @param {string} deskId  '' = all rows, NO_DESK = rows on no desk
 * @param {ReturnType<typeof deskIndex>} idx
 */
export function filterByDesk(kind, rows, deskId, idx) {
  if (!deskId || !idx) return rows;
  const of = {
    consultant: (c) => idx.consultantDesk(c),
    requirement: (r) => idx.userDesk(r.createdBy),
    submission: (s) => idx.userDesk(s.recruiterId)
  }[kind];
  if (!of) throw new Error('Unknown desk filter: ' + kind);
  return rows.filter((r) => deskPicks(deskId, of(r)));
}

/**
 * The members of a desk, for the activity log filter (ids). NO_DESK = active members on no desk. '' = null (no filter).
 * @param {{id:string, removedAt?:string}[]} members
 */
export function deskActorIds(deskId, idx, members) {
  if (!deskId || !idx) return null;
  return (members || []).filter((m) => deskPicks(deskId, idx.userDesk(m.id))).map((m) => m.id);
}

/** The choices of the desk filter: All desks, each desk, No desk. */
export function deskOptions(desks) {
  const out = { '': 'All desks' };
  for (const d of desks || []) out[d.id] = deskLabel(d);
  out[NO_DESK] = 'No desk';
  return out;
}
