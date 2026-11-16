// webapp/js/screens/bench-cap.js - the Team · 5 bench cap note (migration 0038: up to 25 consultants on tier 'starter'; pilot, Team · 15 and · 40
// unlimited). The server refuses the 26th consultant with 'starter_consultant_cap'; this note says why and points at the plan.
import { lockNote } from '../ui.js';
import { consultantCap, CONSULTANT_CAP_NOTE } from '../plan-gate.js';

/** True when the team is on a capped plan and its bench (every consultant, any status) is at or over the cap. */
export function benchFull(ctx, count) {
  const cap = consultantCap(ctx && ctx.team && ctx.team.billing);
  return cap !== null && count >= cap;
}

/**
 * The cap as a plan lock (ui.js lockNote): the badge, the note, and the upgrade path (the owner gets "Choose a plan" to Plan and
 * billing, everyone else is told to ask the owner). kind 'danger' = a save was just refused (announced as an alert).
 */
export function capNote(ctx, kind) {
  const el = lockNote(ctx, { badge: 'Team · 5', text: CONSULTANT_CAP_NOTE, plan: true });
  if (kind === 'danger') { el.classList.add('lock-note-danger'); el.setAttribute('role', 'alert'); }
  return el;
}
