// webapp/js/plan-gate.js - which team billing tier gets which P2 feature (docs/specs/TEAM_P2_SPEC.md section 2).
// The tier is billing.tier from the server (bp_team_billing: 'pilot' | 'starter' | 'team' | 'agency'). The server's weekly and per-desk
// report gate is the same table in SQL (migration 0023 bp_report_extras): keep the two in step. The pilot gets everything.

export const FEATURE_TIERS = {
  vendorHeat: ['pilot', 'team', 'agency'],
  // Smart lists in the vendor book (backlog W5): the same tiers as heat (they are built on it). Migration 0027 bp_team_smart_list_gate says the same.
  smartLists: ['pilot', 'team', 'agency'],
  weeklyReport: ['pilot', 'team', 'agency'],
  deskReport: ['pilot', 'agency'],
  // Desks / offices (backlog W10): the same tiers as the per-desk report. Migration 0036 bp_team_desk_gate says the same.
  desks: ['pilot', 'agency'],
  // Targets, the leaderboard and the funnel reports (staffing P4): Team and Agency; per desk on Agency. Migration 0052 bp_team_target_check
  // refuses a target on Starter.
  targets: ['pilot', 'team', 'agency'],
  deskReports: ['pilot', 'agency'],
  // Timesheets, invoices and commission estimates (staffing F1/F2/G4): the P4 tiers. Migration 0055 bp_team_invoicing_allowed says the same.
  invoicing: ['pilot', 'team', 'agency'],
  matches: ['pilot', 'starter', 'team', 'agency'],
  reminders: ['pilot', 'starter', 'team', 'agency']
};

/** The plan a feature starts on, for the upgrade note. */
// Display names on the one ladder (brief G2): the server tiers starter / team / agency show as Team · 5 / Team · 15 / Team · 40.
export const FEATURE_FROM = { vendorHeat: 'Team · 15', smartLists: 'Team · 15', weeklyReport: 'Team · 15', deskReport: 'Team · 40', desks: 'Team · 40', matches: 'Team · 5', reminders: 'Team · 5', targets: 'Team · 15', deskReports: 'Team · 40', invoicing: 'Team · 15' };

/** Team · 5's shared bench (final plan section 8). Migration 0038 bp_team_consultant_cap says the same: keep the two in step. */
export const STARTER_CONSULTANT_CAP = 25;
export const CONSULTANT_CAP_NOTE = 'Team · 5 includes up to 25 consultants. Upgrade to Team · 15 for an unlimited bench.';
/**
 * The plan refusals the database raises (code -> hint), worded on the one ladder. Migration 0053 sets the same hints on the gate triggers
 * (tests/plan-names.test.mjs ties the two); live-map explain() and the demo store show these.
 */
export const PLAN_HINTS = {
  starter_consultant_cap: CONSULTANT_CAP_NOTE,
  smart_lists_plan: 'Saved lists come with ' + FEATURE_FROM.smartLists + ' and ' + FEATURE_FROM.desks + '.',
  desks_plan: 'Desks come with ' + FEATURE_FROM.desks + '.',
  targets_plan: 'Targets and the leaderboard come with ' + FEATURE_FROM.targets + '.'
};
/** How many consultants the team's bench may hold; null = unlimited (pilot, Team, Agency). */
export function consultantCap(billing) { return billing && billing.tier === 'starter' ? STARTER_CONSULTANT_CAP : null; }

/** @param {{tier?:string}|null} billing  ctx.team.billing */
export function hasFeature(billing, feature) {
  const tier = (billing && billing.tier) || 'pilot';
  return (FEATURE_TIERS[feature] || []).includes(tier);
}

/** The plan cards' feature lines, one per gated feature (the same table as FEATURE_TIERS, so a card never promises what the gate refuses). */
export const FEATURE_LABELS = {
  matches: 'Matches at 60% or more',
  reminders: 'Follow-up reminders',
  vendorHeat: 'Vendor heat and response stats',
  smartLists: 'Smart lists in the vendor book',
  weeklyReport: 'Weekly summary in the morning report',
  desks: 'Desks and offices',
  deskReport: 'Morning report per desk',
  targets: 'Targets, a leaderboard and funnel reports',
  deskReports: 'Funnel reports per desk',
  invoicing: 'Timesheets, invoices and commission estimates'
};
/** Team inbox addresses per paid tier (the plan limit the Team page states: none on Starter, one on Team, three on Agency). */
export const INBOX_ADDRESSES = { starter: 0, team: 1, agency: 3 };

/** What a paid tier includes, for its plan card: the bench size, the inbox addresses, then every gated feature it has. */
export function planHighlights(tier) {
  const out = [tier === 'starter' ? 'Shared bench of up to ' + STARTER_CONSULTANT_CAP + ' consultants' : 'Unlimited shared bench'];
  const n = INBOX_ADDRESSES[tier] || 0;
  if (n) out.push(n === 1 ? 'One team inbox address' : n + ' team inbox addresses');
  for (const [f, label] of Object.entries(FEATURE_LABELS)) if ((FEATURE_TIERS[f] || []).includes(tier)) out.push(label);
  return out;
}
