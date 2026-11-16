// webapp/js/record-delete.js - who may delete a record from the team book, and what the confirm dialog says. Pure.
// The database already lets owners and managers delete consultants, requirements, vendor companies, contacts and submissions
// (0011_team_book.sql, the `<table>_delete` policies); this is the same rule for the screens and the demo store.
// A read-only workspace (0016) refuses every change, so nothing can be deleted then either (the bp_0_writable trigger).

export const DELETE_ROLES = ['owner', 'manager'];

/** @param {string} role  @param {boolean} [writable]  false = the workspace is read-only */
export function canDeleteRecords(role, writable) {
  return writable !== false && DELETE_ROLES.includes(role);
}

/** The text of the confirm dialog for each kind of record. `extra` = the number of contacts (company) when it matters. */
export function deleteConfirmText(kind, name, extra) {
  const n = String(name || '').trim() || 'this record';
  switch (kind) {
    case 'consultant': return `Delete ${n}? Their profile and resume files are removed for the whole team. This cannot be undone.`;
    case 'requirement': return `Delete the requirement "${n}"? Submissions made for it stay, without the link. This cannot be undone.`;
    case 'vendor': {
      const c = Number(extra) || 0;
      return `Delete ${n}` + (c ? ` and its ${c === 1 ? 'contact' : c + ' contacts'}` : '') + '? Requirements and submissions keep their other details. This cannot be undone.';
    }
    case 'contact': return `Delete the contact ${n}? This cannot be undone.`;
    case 'submission': return `Delete this submission (${n})? It no longer counts in the guard or the reports. This cannot be undone.`;
    default: return `Delete ${n}? This cannot be undone.`;
  }
}

/** The message when a consultant still has submissions (the submissions_consultant_fk has no ON DELETE: they must stay). */
export const CONSULTANT_HAS_SUBMISSIONS = 'This consultant has submissions, so they cannot be deleted. Set their status to Inactive instead.';
