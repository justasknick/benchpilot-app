// webapp/js/personal-plan.js - the signed-in person's own plan (Solo, Pro ...) in the web app. Pure.
// The plan comes from the `team` function's `my-plan` action (the same effective plan as the extension's GET /me). Solo is bought and
// renewed in the extension only: the web app has no Solo checkout, it says where to renew.

import { diffDays, fmtLong } from './dates.js';

export const PERSONAL_TIER_LABELS = { free: 'Free', basic: 'Basic', pro: 'Pro', solo: 'Solo' };
/** Plans that include the encrypted sync, so My book has data to open (server: plans.js canSync). */
export const SYNC_TIERS = ['solo', 'pro'];
/** The Renew note shows this many days before the plan ends. */
export const RENEW_NOTE_DAYS = 14;
export const RENEW_WHERE = 'Renew in the extension: Plans.';

/** Days left on the plan (0 on the last day), or null for the free plan / no date. */
export function daysLeft(plan, today) {
  if (!plan || plan.tier === 'free' || !plan.planUntil) return null;
  return Math.max(0, diffDays(plan.planUntil, today));
}

/**
 * Where a signed-in person with no team starts: My book when their plan includes sync (Solo, Pro), otherwise the
 * Create your workspace page. A failed plan lookup (null) keeps the workspace page.
 * @returns {'book'|'welcome'}
 */
export function noTeamHome(plan) {
  return plan && SYNC_TIERS.includes(plan.tier) ? 'book' : 'welcome';
}

/** The plan line on Your account. */
export function planLine(plan, today) {
  if (!plan || plan.tier === 'free') return 'Free plan.';
  const left = daysLeft(plan, today);
  return (PERSONAL_TIER_LABELS[plan.tier] || plan.tier) + ' plan, paid until ' + fmtLong(plan.planUntil) + (left == null ? '.' : ' (' + (left === 1 ? '1 day' : left + ' days') + ' left).');
}

/** The Renew note: '' until RENEW_NOTE_DAYS before the end. Plans do not renew by themselves. */
export function renewNote(plan, today) {
  const left = daysLeft(plan, today);
  if (left == null || left > RENEW_NOTE_DAYS) return '';
  return (left === 0 ? 'Your plan ends today. ' : 'Your plan ends in ' + (left === 1 ? '1 day' : left + ' days') + '. ') + 'It does not renew by itself. ' + RENEW_WHERE;
}
