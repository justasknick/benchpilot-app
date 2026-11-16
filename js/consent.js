// webapp/js/consent.js - staffing P5 in the team web app (docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md): a consultant's consent to be
// marketed, the typed contact log, and the one-consultant export. Pure: no DOM, no network, no storage.
//
// The extension keeps the same lists and rules in its lib/consent.js (BP.Consent). The web app needs them synchronously
// (the demo store, Today's nudge, the hotlist warning) before the extension's code is loaded, so they live here too;
// webapp/tests/consent.test.mjs runs both on the same cases so they can never drift. The data-notice email is NOT copied: the screen
// loads the extension's BP.Consent.noticeEmail through bp-lib.js loadConsentLib(), so the text is the same word for word.
// The server keeps the same limits (migration 0049: consultants.consent_*, contact_notes).
//
// A person types every contact note: nothing is read from WhatsApp, the phone or any other app, and BenchPilot never sends anything.

export const CONSENT_SOURCES = ['email_reply', 'signed_form', 'verbal_logged', 'other'];
export const CONSENT_SOURCE_LABELS = { email_reply: 'Email reply', signed_form: 'Signed form', verbal_logged: 'Verbal, logged by me', other: 'Other',
  consultant_link: 'Consultant link' };
/** Kept when it comes in, never offered in a picker: 'consultant_link' = the consultant gave it on the self-service link (migration 0056). */
export const RECORDED_SOURCES = CONSENT_SOURCES.concat(['consultant_link']);
export const CONSENT_NOTE_MAX = 200;
export const CONTACT_KINDS = ['call', 'whatsapp', 'meeting', 'email', 'note'];
export const CONTACT_KIND_LABELS = { call: 'Call', whatsapp: 'WhatsApp', meeting: 'Meeting', email: 'Email', note: 'Note' };
/** The team's two kinds of record a note can belong to (0049 contact_notes.entity). The extension's 'lead' is the team's 'vendor_contact'. */
export const NOTE_ENTITIES = ['consultant', 'vendor_contact'];
export const CONTACT_NOTE_MAX = 1000;
export const ERASED_NAME = 'Erased consultant';
export const NOT_LEGAL_ADVICE = 'A draft to adapt, not legal advice. Fill in the parts in [brackets] and check it with your own adviser.';
export const NOTE_EMPTY = 'Write what was said, then save.';
/** The erase answers (0049 bp_consultant_erase and the consultant_erased trigger), the same in both stores. */
export const ERASE_MISMATCH = "The name you typed does not match. Type the consultant's name exactly as shown.";
export const ERASED_READ_ONLY = 'This consultant was erased. The record is kept only for the counts and cannot be changed.';
/** Team statuses that count as "being marketed" (stats.js BENCH_STATUSES; the extension's BP.onBench). */
export const MARKETED = ['marketing', 'interviewing', 'on_hold'];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v) => ISO_DAY.test(String(v || '')) && Number.isFinite(Date.parse(v));
const line = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const clip = (v, n) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, n);
const isoOf = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };

/** The three consent fields, cleaned (BP.Consent.cleanConsent). A source or note without a date is kept (the date can follow). */
export function cleanConsent(c) {
  const x = c || {};
  return {
    consentOn: isDay(x.consentOn) ? String(x.consentOn) : '',
    consentSource: RECORDED_SOURCES.includes(x.consentSource) ? x.consentSource : '',
    consentNote: line(x.consentNote, CONSENT_NOTE_MAX)
  };
}
export function hasConsent(c) { return Boolean(c && isDay(c.consentOn)); }

/** "Recorded 3 Nov 2026 (Email reply)" or '' (BP.Consent.consentText). */
export function consentText(c) {
  if (!hasConsent(c)) return '';
  const [y, m, d] = String(c.consentOn).split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const src = CONSENT_SOURCE_LABELS[c.consentSource];
  return `Recorded ${d} ${months[m - 1]} ${y}` + (src ? ` (${src})` : '');
}

/** Being marketed (Marketing, In interview, On hold) with no consent date: Today's soft nudge and the hotlist warning. */
export function needsConsent(c) {
  return Boolean(c) && !c.erased && MARKETED.includes(c.status) && !hasConsent(c);
}

/**
 * One typed note, cleaned for the team (0049 contact_notes); null when it cannot be kept (no entity, no record, no text).
 * `at` (when the call or chat happened) defaults to now; a time more than two days ahead becomes now, like the extension.
 */
export function cleanNoteInput(n, now) {
  const x = n || {};
  const entity = NOTE_ENTITIES.includes(x.entity) ? x.entity : '';
  const entityId = line(x.entityId, 80);
  const body = clip(x.body, CONTACT_NOTE_MAX);
  if (!entity || !entityId || !body) return null;
  const stamp = isoOf(now === undefined ? Date.now() : now) || new Date().toISOString();
  let at = isoOf(x.at) || stamp;
  if (Date.parse(at) > Date.parse(stamp) + 2 * 86400000) at = stamp;
  return { entity, entityId, kind: CONTACT_KINDS.includes(x.kind) ? x.kind : 'note', at, body };
}

/** Notes newest first. */
export function sortNotes(list) {
  return (Array.isArray(list) ? list : []).slice().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || String(b.id).localeCompare(String(a.id)));
}

const RESUME_META = ['id', 'fileName', 'size', 'mime', 'uploadedAt'];
/**
 * Everything the team keeps about one consultant (the "Export this consultant" file; the same format as the extension's
 * BP.Consent.consultantExport, with the team's resume versions and without the personal Match marks).
 * parts: { consultant, resumes: [versions], submissions: [...], contactNotes: [...], interviews: [...], placements: [...] } (the last two: staffing P3).
 * A placement's pay rate is in it only when the person may see pay (the store reads it under the 0046 / 0051 rule).
 */
export function consultantExport(parts, now) {
  const p = parts || {};
  if (!p.consultant) return null;
  return {
    format: 'benchpilot-consultant-export', version: 1, exportedAt: isoOf(now === undefined ? Date.now() : now) || new Date().toISOString(),
    consultant: { ...p.consultant },
    resumeFiles: (Array.isArray(p.resumes) ? p.resumes : []).filter(Boolean).map((r) => Object.fromEntries(RESUME_META.map((k) => [k, r[k] === undefined ? '' : r[k]]))),
    submissions: (Array.isArray(p.submissions) ? p.submissions : []).map((x) => ({ ...x })),
    contactNotes: sortNotes(p.contactNotes).map((x) => ({ ...x })),
    interviews: (Array.isArray(p.interviews) ? p.interviews : []).map((x) => ({ ...x })),
    placements: (Array.isArray(p.placements) ? p.placements : []).map((x) => ({ ...x }))
  };
}

/** The extension's BP.csvCell: quoted, and a cell that starts like a formula gets a leading quote. */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=@\t\r]/.test(s) || /^[+\-](?![\d\s(])/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
/** The export as one CSV: section, item, field, value (BP.Consent.consultantCsv: one row per value; lists joined with "; "). */
export function consultantCsv(exp) {
  if (!exp) return '';
  const val = (v) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join('; ')
    : v && typeof v === 'object' ? JSON.stringify(v) : v == null ? '' : String(v));
  const rows = [['section', 'item', 'field', 'value']];
  const add = (section, item, obj) => { for (const [k, v] of Object.entries(obj || {})) rows.push([section, item, k, val(v)]); };
  add('consultant', 1, exp.consultant);
  (exp.resumeFiles || []).forEach((r, i) => add('resume file', i + 1, r));
  (exp.submissions || []).forEach((r, i) => add('submission', i + 1, r));
  (exp.contactNotes || []).forEach((r, i) => add('contact note', i + 1, r));
  (exp.interviews || []).forEach((r, i) => add('interview', i + 1, r));
  (exp.placements || []).forEach((r, i) => add('placement', i + 1, r));
  return '﻿' + rows.map((r) => r.map((x) => csvCell(x)).join(',')).join('\r\n') + '\r\n';
}

/** The file name of a one-consultant export: "benchpilot_consultant_ravi-k_2026-11-14.json". */
export function exportFileName(name, today, ext) {
  const slug = String(name || 'consultant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'consultant';
  return `benchpilot_consultant_${slug}_${today}.${ext}`;
}

// ── the consultant's name in other records' free text (staffing leftovers, migration 0053) ──
// The same rule as the extension's BP.Consent.nameRegex and the database's bp_name_regex: the full name as whole words, any case, any
// spacing between its parts; never the first name alone; nothing under 3 characters. tests/consent.test.mjs runs both on the same cases.
export const NAME_REMOVED = '[name removed]';
export function nameRegex(name) {
  const n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (n.length < 3 || n.toLowerCase() === ERASED_NAME.toLowerCase()) return null;
  const body = n.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp('(^|[^\\p{L}\\p{N}_])(' + body + ')(?=$|[^\\p{L}\\p{N}_])', 'giu');
}
export function hasName(text, name) {
  const re = nameRegex(name);
  return Boolean(re && typeof text === 'string' && text && re.test(text));
}
export function scrubName(text, name) {
  const re = nameRegex(name);
  return re && typeof text === 'string' ? text.replace(re, (m, pre) => pre + NAME_REMOVED) : text;
}
/** One line of text around the first match ('' when there is none). */
export function nameSnippet(text, name, radius) {
  const re = nameRegex(name);
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ');
  const m = re ? re.exec(t) : null;
  if (!m) return '';
  const r = Number(radius) > 0 ? Number(radius) : 50;
  const at = m.index + m[1].length;
  const from = Math.max(0, at - r), to = Math.min(t.length, at + m[2].length + r);
  return (from > 0 ? '…' : '') + t.slice(from, to).trim() + (to < t.length ? '…' : '');
}

/** What the erase confirm says goes and stays (one source for the dialog and the tests). */
export function eraseExplain(name, submissions) {
  const n = Number(submissions) || 0;
  return {
    goes: ['the profile: name, role, skills, work authorisation, rates, location, availability and consent record',
      'every resume file', 'every contact log note about them'],
    stays: n
      ? [`${n === 1 ? 'their submission stays' : `their ${n} submissions stay`} for the team's counts and reports, shown as "${ERASED_NAME}", with any guard reason cleared`]
      : ['nothing: they have no submissions, so the record is deleted completely'],
    confirm: `Type ${String(name || '').trim()} to confirm`
  };
}
