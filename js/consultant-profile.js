// webapp/js/consultant-profile.js - the consultant profile rules of staffing P1 (docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md):
// work-authorisation type and end date, minimum rate, availability. Pure: no DOM, no storage; `today` is an ISO day passed in.
//
// The extension has the same rules in lib/shared.js (BP.normalizeVisa, BP.workAuthAlert, BP.expiringWorkAuth, BP.belowRateMin,
// BP.availabilityOf). The web app needs them synchronously (Today numbers, the demo store), before the extension's code is loaded, so
// they live here too; webapp/tests/consultant-profile.test.mjs runs both on the same cases so they can never drift. The server reads the
// type the same way (public.bp_consultant_visa_type, migration 0045).
//
// Only the work-authorisation TYPE and END DATE are kept: never a document, a number or a copy of a card.

import { visaFromText } from './req-tags.js';
import { diffDays, isISODay } from './dates.js';

/** The fixed list (BP.VISA_TYPES; the 0045 check constraint on consultants.visa_type). */
export const VISA_TYPES = ['USC', 'GC', 'GC-EAD', 'H1B', 'H4-EAD', 'L2-EAD', 'OPT', 'CPT', 'STEM OPT', 'TN', 'Other'];

/** Free text -> one VISA_TYPES code ('' when empty): the first code the requirement-tag reader finds, a bare EAD or no code = 'Other'. */
export function normalizeVisa(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '';
  const exact = VISA_TYPES.find((t) => t.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  return visaFromText(s).filter((c) => c !== 'EAD')[0] || 'Other';
}
/** The saved type, else read from the free-text visa note. */
export function consultantVisaType(c) {
  const x = c || {};
  return VISA_TYPES.includes(x.visaType) ? x.visaType : normalizeVisa(x.visa);
}

// ── work authorisation end date ──────────────────────────────────────────────────────────────────────────────────────────
export const WORK_AUTH_STEPS = [120, 90, 60, 30, 7, 0];
/** Consultants who still count for reminders: on the bench (stats.js BENCH_STATUSES). */
const ON_BENCH = ['marketing', 'interviewing', 'on_hold'];

/** -> null, or { days, step, expired, label } once the end date is 120 days away or closer (BP.workAuthAlert). */
export function workAuthAlert(until, today) {
  if (!isISODay(until) || !isISODay(today)) return null;
  const days = diffDays(until, today);
  if (days > WORK_AUTH_STEPS[0]) return null;
  const step = days <= 0 ? 0 : WORK_AUTH_STEPS.filter((s) => s >= days).pop();
  const label = days < 0 ? `Ended ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'Ends today' : `Ends in ${days} day${days === 1 ? '' : 's'}`;
  return { days, step, expired: days < 0, label };
}

/** Bench consultants whose work authorisation ends within `within` days (default 120) or has ended, soonest first (BP.expiringWorkAuth). */
export function expiringWorkAuth(consultants, today, within) {
  const max = Number.isFinite(within) ? within : WORK_AUTH_STEPS[0];
  const out = [];
  for (const c of consultants || []) {
    if (!c || !ON_BENCH.includes(c.status)) continue;
    const a = workAuthAlert(c.workAuthUntil, today);
    if (!a || a.days > max) continue;
    out.push({ id: c.id, name: c.name || '', ownerRecruiterId: c.ownerRecruiterId || '', visaType: consultantVisaType(c), until: c.workAuthUntil, ...a });
  }
  return out.sort((a, b) => a.days - b.days || String(a.name).localeCompare(String(b.name)));
}

// ── minimum rate ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const RATE_UNITS = ['hr', 'day', 'month', 'year'];
export const RATE_UNIT_LABELS = { hr: 'per hour', day: 'per day', month: 'per month', year: 'per year' };
const HOURS_PER = { hr: 1, day: 8, month: 2080 / 12, year: 2080 };
export const normalizeRateUnit = (u) => (RATE_UNITS.includes(u) ? u : 'hr');
export function cleanRateMin(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
}
export function rateMinHourly(c) {
  const n = cleanRateMin(c && c.rateMin);
  return n === null ? null : Math.round((n / HOURS_PER[normalizeRateUnit(c.rateUnit)]) * 100) / 100;
}
export function rateMinText(c) {
  const n = cleanRateMin(c && c.rateMin);
  return n === null ? '' : '$' + n.toLocaleString('en-US') + '/' + normalizeRateUnit(c.rateUnit);
}
/** An hourly rate read from text, as BP.parseRate: null for yearly / monthly wording and for anything not between 0 and 1000. */
export function parseRate(text) {
  const t = String(text == null ? '' : text).toLowerCase();
  if (!t.trim()) return null;
  if (/(\/\s*(yr|year|annum|mo|month)|\bper\s*(year|annum|month)|\d\s*k\b|\blpa\b|annual)/.test(t)) return null;
  const m = /(\d{1,3}(?:\.\d{1,2})?)(?![\d,])/.exec(t.replace(/(\d),(?=\d{3})/g, '$1'));
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n < 1000 ? n : null;
}
/** The asked rate against the consultant's minimum: null, or { min, ask } per hour when below it (a soft warning, never a block). */
export function belowRateMin(ask, c) {
  const a = typeof ask === 'number' ? ask : parseRate(ask);
  const min = rateMinHourly(c);
  return a !== null && a > 0 && min !== null && a < min ? { min, ask: a } : null;
}

// ── availability ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const AVAILABLE_SOON_DAYS = 30;
/** 'now' | 'soon' (within 30 days) | 'later' | 'unknown' (no date), as BP.availabilityOf. */
export function availabilityOf(c, today) {
  const on = c && c.availableOn;
  if (!isISODay(on) || !isISODay(today)) return { state: 'unknown', days: null };
  const days = diffDays(on, today);
  return { state: days <= 0 ? 'now' : days <= AVAILABLE_SOON_DAYS ? 'soon' : 'later', days: Math.max(0, days) };
}
/** Free only later (more than 30 days away): held out of matching and the hotlist until then. */
export const availableLater = (c, today) => availabilityOf(c, today).state === 'later';
