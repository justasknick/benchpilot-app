// webapp/js/perms.js - who can do what (docs/specs/TEAM_WORKSPACE_SPEC.md section 3). Pure.
// The UI hides or disables controls with can(); the store also checks it, and in Sprint 1 the database policies enforce it.

export const ROLES = ['owner', 'manager', 'recruiter'];
export const ROLE_LABELS = { owner: 'Owner', manager: 'Manager', recruiter: 'Recruiter' };

const ALWAYS = new Set(['view', 'edit_records']);
// edit_agreements: vendor MSA / NDA status, dates and payment terms (staffing P6). Recruiters see them read-only; trigger bp_team_restrict
// (migration 0050) refuses the same change from a recruiter.
// audit_log: the "who changed what" screen (#audit). Owners and managers run the team, so they read it; RLS (0040) lets only owners
// and managers read activity_log, so the database keeps the same rule.
// set_targets / reports (staffing P4, migration 0052): owners and managers set the team's, desks' and people's targets (RLS on team_targets)
// and read the team's funnel per recruiter and per desk and the margin export. A recruiter sees their own numbers.
const OWNER_AND_MANAGER = new Set(['set_vendor_tier', 'reassign', 'invite', 'change_roles', 'remove_member', 'import', 'delete_resume', 'audit_log', 'edit_templates', 'manage_smart_lists', 'manage_desks', 'edit_agreements', 'erase_consultant', 'set_targets', 'reports', 'consultant_links',
  'invoices', 'manage_invoices']);
// invoices / manage_invoices (0055): the invoice tracker is back office: owners and managers read and change invoices (RLS invoices_*);
// everyone records timesheets (edit_records). commission (0055): the commission rules and estimates, owners and managers who may see pay.
// consultant_links (0056): make, list and cancel a consultant's self-service link (RLS on consultant_links: owners and managers only).
// erase_consultant (staffing P5, 0049 bp_consultant_erase): a consultant's data-rights request. Owners and managers, and it stays open on a
// read-only workspace (a deletion request cannot wait for payment), so it is NOT in READ_ONLY_BLOCKED.
// inbox_addresses = create or replace an address (refused while read-only); disable_inbox_address = turn one off, which only stops mail
// and stays open on a read-only workspace (the server allows it, 0020 bp_inbox_address_disable).
const OWNER_ONLY = new Set(['billing', 'delete_workspace', 'transfer_ownership', 'team_settings', 'inbox_addresses', 'disable_inbox_address']);

/**
 * @param {'owner'|'manager'|'recruiter'} role
 * @param {string} action
 * @param {{exportPolicy?:{manager?:boolean, recruiter?:boolean}, payPolicy?:{recruiter?:boolean}, leaderboardPolicy?:{others?:boolean}}} [ctx]
 *        the workspace settings (for 'export', 'see_pay', 'see_leaderboard')
 */
export function can(role, action, ctx) {
  if (!ROLES.includes(role)) return false;
  if (ALWAYS.has(action)) return true;
  if (role === 'owner') return true;
  if (OWNER_ONLY.has(action)) return false;
  if (OWNER_AND_MANAGER.has(action)) return role === 'manager';
  // see_pay (migration 0046): pay rates and margin. Owners and managers always; recruiters only when the owner turns on
  // settings.payPolicy.recruiter. The database keeps the same rule (RLS on submission_pay).
  if (action === 'see_pay') return role === 'manager' || Boolean(ctx && ctx.payPolicy && ctx.payPolicy.recruiter === true);
  // see_leaderboard (0052): everyone's numbers on the leaderboard. Owners and managers always; recruiters unless the owner turns off
  // settings.leaderboardPolicy.others (default on). Off, a recruiter sees only their own row ("my numbers").
  if (action === 'see_leaderboard') return role === 'manager' || !(ctx && ctx.leaderboardPolicy && ctx.leaderboardPolicy.others === false);
  // margin_export (0052): margin per recruiter per month for a commission sheet. Owners and managers only, when they may see pay and export.
  if (action === 'margin_export') return role === 'manager' && can(role, 'see_pay', ctx) && can(role, 'export', ctx);
  if (action === 'commission' || action === 'set_commission') return role === 'manager' && can(role, 'see_pay', ctx);
  if (action === 'export') {
    const p = (ctx && ctx.exportPolicy) || {};
    return role === 'manager' ? p.manager !== false : p.recruiter === true;
  }
  return false;
}

/**
 * Actions refused while the workspace is read-only (the plan ended and is not paid yet; migration 0016). Viewing, export, billing,
 * removing a member, transferring ownership, deleting the workspace and turning off an inbox address stay open. The server enforces the same rule.
 */
export const READ_ONLY_BLOCKED = new Set(['edit_records', 'set_vendor_tier', 'reassign', 'invite', 'change_roles', 'import', 'team_settings', 'inbox_addresses', 'delete_resume', 'edit_templates', 'manage_smart_lists', 'manage_desks', 'edit_agreements', 'set_targets', 'consultant_links', 'manage_invoices', 'set_commission']);

/** can() plus the read-only rule. `writable` comes from the team's billing (false = read-only). */
export function canNow(role, action, ctx, writable) {
  if (writable === false && READ_ONLY_BLOCKED.has(action)) return false;
  return can(role, action, ctx);
}

/**
 * A manager may change recruiters and other managers, never an owner, and nobody changes or removes their own row (0040: the server
 * answers same_user / use_leave). A manager or recruiter leaves with canLeave instead.
 */
export function canChangeMember(role, targetRole, isSelf) {
  if (isSelf === true) return false;
  if (role === 'owner') return targetRole !== 'owner';
  if (role === 'manager') return targetRole !== 'owner';
  return false;
}

/** "Leave this workspace" (0040): managers and recruiters, also on a read-only workspace. The owner transfers ownership or deletes it first. */
export function canLeave(role) {
  return role === 'manager' || role === 'recruiter';
}
