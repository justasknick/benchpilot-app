// lib/vendor-agreements.js - vendor agreements (staffing package P6, docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md H1/H2/F2).
// Pure: no DOM, no chrome.*, no clock (every function takes `today` as 'YYYY-MM-DD'). Exposes BP.Agreements.
// ONE implementation for both places: the extension's Vendor Book (schema 16, a company record carries these fields; lib/migrations.js
// cleans them, sync carries them as part of the company) and the web app team workspace (vendor_companies columns from migration 0050;
// webapp/js/bp-lib.js loads this very file).
//
// Status and dates only. No agreement file is stored anywhere, and nothing here is legal advice.
//
//   Fields (camelCase on a company; snake_case columns in the team table, see fromRow / toRow):
//     msaStatus   'none' | 'sent' | 'signed' | 'expired'     ndaStatus  the same
//     msaSignedOn 'YYYY-MM-DD' | ''                          ndaSignedOn
//     msaUntil    'YYYY-MM-DD' | ''  (end date; '' = open-ended) ndaUntil
//     netTerms    15 | 30 | 45 | 60 | 90 | null  (days after the invoice date the vendor pays)
//     paymentNote text, at most 300 characters
//
//   A signed agreement whose end date has passed counts as Expired (effective status) without anyone editing it. An agreement the user
//   marked Expired by hand is acknowledged: it is no longer a reminder.
(function (root) {
  'use strict';
  const BP = root.BP = root.BP || {};

  const STATUSES = ['none', 'sent', 'signed', 'expired'];
  const STATUS_LABELS = { none: 'Not on file', sent: 'Sent', signed: 'Signed', expired: 'Expired' };
  const NET_TERMS = [15, 30, 45, 60, 90];
  const NOTE_MAX = 300;
  const SOON_DAYS = 30;
  const FIELDS = ['msaStatus', 'msaSignedOn', 'msaUntil', 'ndaStatus', 'ndaSignedOn', 'ndaUntil', 'netTerms', 'paymentNote'];
  const COLUMNS = { msaStatus: 'msa_status', msaSignedOn: 'msa_signed_on', msaUntil: 'msa_until', ndaStatus: 'nda_status',
    ndaSignedOn: 'nda_signed_on', ndaUntil: 'nda_until', netTerms: 'net_terms', paymentNote: 'payment_note' };
  const EMPTY = Object.freeze({ msaStatus: 'none', msaSignedOn: '', msaUntil: '', ndaStatus: 'none', ndaSignedOn: '', ndaUntil: '', netTerms: null, paymentNote: '' });
  /** Vendor book filters, same keys and words in the extension and the web app. */
  const FILTERS = [['no_msa', 'No signed MSA'], ['expiring', `Ends within ${SOON_DAYS} days`], ['ended', 'Agreement ended']];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const DAY_MS = 86400000;

  function isDate(s) {
    const m = typeof s === 'string' && DATE_RE.exec(s);
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }
  const dateOrBlank = (v) => {
    const s = v == null ? '' : String(v).trim().slice(0, 10);
    return isDate(s) ? s : '';
  };
  const ms = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  function daysBetween(fromIso, toIso) { return Math.round((ms(toIso) - ms(fromIso)) / DAY_MS); }
  function addDays(iso, n) { return new Date(ms(iso) + n * DAY_MS).toISOString().slice(0, 10); }
  function fmtDate(iso) { return isDate(iso) ? `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : ''; }
  const termsOrNull = (v) => { const n = Number(v); return v !== '' && v != null && NET_TERMS.includes(n) ? n : null; };

  /** A clean, complete agreement from anything (a damaged value becomes its default). Never throws. */
  function clean(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = { ...EMPTY };
    for (const p of ['msa', 'nda']) {
      const st = r[p + 'Status'];
      out[p + 'Status'] = STATUSES.includes(st) ? st : 'none';
      out[p + 'SignedOn'] = dateOrBlank(r[p + 'SignedOn']);
      out[p + 'Until'] = dateOrBlank(r[p + 'Until']);
      if (out[p + 'SignedOn'] && out[p + 'Until'] && out[p + 'Until'] < out[p + 'SignedOn']) out[p + 'Until'] = '';
    }
    out.netTerms = termsOrNull(r.netTerms);
    out.paymentNote = typeof r.paymentNote === 'string' ? r.paymentNote.trim().slice(0, NOTE_MAX) : '';
    return out;
  }

  /** What a user typed: { ok, value } or { ok:false, error } with words for the form. Missing fields keep `prev`'s value. */
  function validate(input, prev) {
    const base = clean(prev);
    const r = input && typeof input === 'object' ? input : {};
    const v = { ...base };
    for (const k of FIELDS) if (k in r) v[k] = r[k];
    for (const p of ['msa', 'nda']) {
      const P = p.toUpperCase();
      if (!STATUSES.includes(v[p + 'Status'])) return { ok: false, error: `Pick a status for the ${P}.` };
      for (const [k, label] of [['SignedOn', 'signed date'], ['Until', 'end date']]) {
        const s = v[p + k] == null ? '' : String(v[p + k]).trim();
        if (s && !isDate(s)) return { ok: false, error: `The ${P} ${label} is not a date.` };
        v[p + k] = s;
      }
      if (v[p + 'SignedOn'] && v[p + 'Until'] && v[p + 'Until'] < v[p + 'SignedOn']) return { ok: false, error: `The ${P} end date is before the date it was signed.` };
    }
    if (v.netTerms === '' || v.netTerms == null) v.netTerms = null;
    else if (!NET_TERMS.includes(Number(v.netTerms))) return { ok: false, error: 'Payment terms are Net 15, 30, 45, 60 or 90.' };
    else v.netTerms = Number(v.netTerms);
    v.paymentNote = v.paymentNote == null ? '' : String(v.paymentNote).trim();
    if (v.paymentNote.length > NOTE_MAX) return { ok: false, error: `Keep the payment note under ${NOTE_MAX} characters.` };
    return { ok: true, value: v };
  }

  /** True when anything about the agreement is recorded. */
  function has(rec) {
    const a = clean(rec);
    return FIELDS.some((k) => a[k] !== EMPTY[k]);
  }
  /** Only the fields that differ from the defaults, so a company with nothing recorded stays as it was (extension storage). */
  function compact(rec) {
    const a = clean(rec);
    const out = {};
    for (const k of FIELDS) if (a[k] !== EMPTY[k]) out[k] = a[k];
    return out;
  }

  /** One document's state today: { status (effective), label, until, daysLeft (null = open-ended or not signed), soon, ended }. */
  function docState(rec, kind, today) {
    const a = clean(rec);
    const p = kind === 'nda' ? 'nda' : 'msa';
    const until = a[p + 'Until'];
    let status = a[p + 'Status'];
    let daysLeft = null;
    if (status === 'signed' && until && isDate(today)) {
      daysLeft = daysBetween(today, until);
      if (daysLeft < 0) status = 'expired';
    }
    const autoEnded = a[p + 'Status'] === 'signed' && status === 'expired';
    return { status, label: STATUS_LABELS[status], signedOn: a[p + 'SignedOn'], until, daysLeft,
      soon: status === 'signed' && daysLeft !== null && daysLeft <= SOON_DAYS, ended: autoEnded };
  }

  function hasSignedMsa(rec, today) { return docState(rec, 'msa', today).status === 'signed'; }

  /** True when the book uses agreements at all (any company has something recorded). Until then the submit warning stays quiet. */
  function tracking(records) { return (records || []).some(has); }

  /**
   * The soft line shown when submitting to a vendor: '' when there is nothing to say. Never blocks.
   * Quiet while the book records no agreement at all (`isTracking` false), so a recruiter who does not use the feature sees nothing.
   */
  function msaWarning(vendorName, rec, today, isTracking) {
    if (!isTracking) return '';
    const name = String(vendorName || '').trim() || 'this vendor';
    const s = docState(rec, 'msa', today);
    if (s.status === 'signed') return '';
    if (s.status === 'expired') return `The MSA with ${name} has ended${s.until ? ' (' + fmtDate(s.until) + ')' : ''}. You can still submit.`;
    return `No signed MSA with ${name} on file. You can still submit.`;
  }

  /**
   * Agreements that need a look: signed ones ending within `days` (default 30) and signed ones whose end date has passed.
   * items: [{ id, name, ...agreement fields }]. Returns [{ id, name, kind: 'MSA'|'NDA', until, daysLeft, ended }] soonest first.
   */
  function reminders(items, today, days) {
    const win = Number.isFinite(days) ? days : SOON_DAYS;
    const out = [];
    for (const it of items || []) {
      if (!it) continue;
      for (const kind of ['msa', 'nda']) {
        const s = docState(it, kind, today);
        if (s.ended || (s.status === 'signed' && s.daysLeft !== null && s.daysLeft <= win)) {
          out.push({ id: it.id, name: String(it.name || it.id || ''), kind: kind.toUpperCase(), until: s.until, daysLeft: s.daysLeft, ended: s.ended });
        }
      }
    }
    return out.sort((x, y) => x.until.localeCompare(y.until) || x.name.localeCompare(y.name));
  }
  /** Counts only (the morning report and the Today line): { soon, ended, total }. */
  function counts(items, today) {
    const r = reminders(items, today);
    const ended = r.filter((x) => x.ended).length;
    return { soon: r.length - ended, ended, total: r.length };
  }
  /** Words for one reminder: "MSA ends in 12 days (26 Nov 2026)" / "NDA ended 3 days ago (11 Nov 2026)". */
  function reminderText(r) { return `${r.kind} ${reminderWhen(r)}`; }
  /** The same without the kind: "ends in 12 days (26 Nov 2026)". */
  function reminderWhen(r) {
    const when = r.ended ? `ended ${plural(-r.daysLeft, 'day')} ago` : r.daysLeft === 0 ? 'ends today' : `ends in ${plural(r.daysLeft, 'day')}`;
    return `${when} (${fmtDate(r.until)})`;
  }
  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  /** The vendor book filter: 'no_msa' | 'expiring' | 'ended' ('' keeps everything). */
  function matches(rec, filter, today) {
    if (!filter) return true;
    const m = docState(rec, 'msa', today), n = docState(rec, 'nda', today);
    if (filter === 'no_msa') return m.status !== 'signed';
    if (filter === 'expiring') return m.soon || n.soon;
    if (filter === 'ended') return m.status === 'expired' || n.status === 'expired';
    return true;
  }

  /** The planned payment date: invoice date + net terms days ('' when either is missing). Planning only: no invoice is made. */
  function expectedPaymentDate(invoiceIso, netTerms) {
    const d = dateOrBlank(invoiceIso);
    const n = termsOrNull(netTerms);
    return d && n ? addDays(d, n) : '';
  }
  function termsLabel(n) { const t = termsOrNull(n); return t ? 'Net ' + t : ''; }

  /** One line for a row or a chip: "MSA signed, ends 3 Mar 2027 · NDA sent · Net 45". */
  function summary(rec, today) {
    const a = clean(rec);
    const part = (kind) => {
      const s = docState(a, kind, today);
      if (s.status === 'none') return '';
      const K = kind.toUpperCase();
      if (s.status === 'signed') return `${K} signed${s.until ? ', ends ' + fmtDate(s.until) : ''}`;
      if (s.status === 'expired') return `${K} ended${s.until ? ' ' + fmtDate(s.until) : ''}`;
      return `${K} ${s.label.toLowerCase()}`;
    };
    return [part('msa'), part('nda'), termsLabel(a.netTerms)].filter(Boolean).join(' · ');
  }

  /** Team table row (snake_case, dates as 'YYYY-MM-DD' or null) <-> agreement. */
  function fromRow(row) {
    const r = row || {};
    const raw = {};
    for (const k of FIELDS) raw[k] = r[COLUMNS[k]];
    return clean(raw);
  }
  function toRow(rec) {
    const a = clean(rec);
    const out = {};
    for (const k of FIELDS) out[COLUMNS[k]] = (a[k] === '' ? null : a[k]);
    out.msa_status = a.msaStatus; out.nda_status = a.ndaStatus;
    return out;
  }

  BP.Agreements = {
    STATUSES, STATUS_LABELS, NET_TERMS, NOTE_MAX, SOON_DAYS, FIELDS, COLUMNS, EMPTY, FILTERS,
    clean, validate, has, compact, docState, hasSignedMsa, tracking, msaWarning, reminders, counts, reminderText, reminderWhen, matches,
    expectedPaymentDate, termsLabel, summary, fromRow, toRow, fmtDate, isDate
  };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP.Agreements;
}
