// webapp/js/dates.js - day-level date helpers. Every date in the web app is an ISO day string, "YYYY-MM-DD".
// Pure, no DOM. UTC arithmetic on whole days so tests do not depend on the machine's time zone.

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isISODay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

export function parseISO(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
export function toISO(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function addDays(iso, n) { return toISO(parseISO(iso) + n * DAY); }
/** Whole days from b to a (a - b). */
export function diffDays(a, b) { return Math.round((parseISO(a) - parseISO(b)) / DAY); }

/** The local calendar day of a Date, as an ISO day string. */
export function todayISO(date) {
  const d = date || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "28 Oct" */
export function fmtShort(iso) {
  if (!isISODay(iso)) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}
/** "28 Oct 2026" */
export function fmtLong(iso) {
  return isISODay(iso) ? `${fmtShort(iso)} ${iso.slice(0, 4)}` : '';
}
