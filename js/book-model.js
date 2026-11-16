// webapp/js/book-model.js - "My book" (Solo personal web workspace, docs/specs/SOLO_WEB_WORKSPACE_SPEC.md): what each list shows, how it is
// searched and filtered, and the safe edits (spec section 2 and 4). Pure: no DOM, no network. Lead statuses and vendor labels come from the
// extension's own lib/shared.js (BP), passed in by the caller, so the web app never keeps a second copy of them.

import { RECORDED_SOURCES, CONSENT_SOURCE_LABELS, CONSENT_NOTE_MAX } from './consent.js';

/** The lists, in menu order. `dataset` is the sync data set name (lib/sync-merge.js DATASETS). */
export const SECTIONS = [
  { name: 'leads', dataset: 'leads', label: 'Recruiters', one: 'recruiter' },
  { name: 'vendors', dataset: 'companies', label: 'Vendors', one: 'vendor' },
  { name: 'consultants', dataset: 'consultants', label: 'Consultants', one: 'consultant' },
  { name: 'submissions', dataset: 'submissions', label: 'Submissions', one: 'submission' },
  { name: 'notes', dataset: 'notes', label: 'Notes', one: 'note' },
  { name: 'jobs', dataset: 'jobs', label: 'Jobs', one: 'job' },
  { name: 'templates', dataset: 'templates', label: 'Templates', one: 'template' },
  { name: 'resumes', dataset: 'resumes', label: 'Resume files', one: 'resume file' }
];
/** What the vault reads: every list above, plus `settings` (read only: the homework shift start and the follow-up days the extension syncs). */
export const BOOK_DATASETS = [...SECTIONS.map((s) => s.dataset), 'settings'];
export const sectionByName = (name) => SECTIONS.find((s) => s.name === name) || SECTIONS[0];
/** The extension's homework day zone (background/service-worker.js HOMEWORK_ZONE): the morning summary uses the same days. */
export const HOMEWORK_ZONE = 'Asia/Kolkata';

const str = (v) => (v == null ? '' : Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').join(', ') : typeof v === 'object' ? '' : String(v));
const lower = (v) => str(v).toLowerCase();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const day = (v) => str(v).slice(0, 10);
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const cap = (v) => { const s = str(v); return s ? s[0].toUpperCase() + s.slice(1) : ''; };
const fileType = (t) => (t === 'application/pdf' ? 'PDF' : t ? 'Word (.docx)' : '');
const fileSize = (n) => (Number.isFinite(n) && n > 0 ? (n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB') : '');
/** Filter options built from the values present in the list (submission and job statuses), so no status list is copied here. */
const presentValues = (all, field, label) => (rows) => {
  const vals = [...new Set(rows.map(({ r }) => str(r[field])).filter(Boolean))].sort();
  return Object.fromEntries([['', all], ...vals.map((v) => [v, label ? label(v) : v])]);
};

/**
 * The model for one BP (the extension's lib/shared.js object).
 * @param {{STATUSES:string[], normalizeStatus:(s:string)=>string, COMPANY_LABELS:object}} BP
 */
export function createBookModel(BP) {
  const LEAD_STATUSES = BP.STATUSES.slice();
  const normStatus = (s) => BP.normalizeStatus(s);
  const companyLabel = (k) => BP.COMPANY_LABELS[k] || BP.COMPANY_LABELS.none;

  // Per list: title / subtitle of a row, the table columns, the text the search box looks in, the filter, and every field of the detail view.
  const VIEWS = {
    leads: {
      title: (r) => str(r.recruiterName) || str(r.email),
      columns: [
        { label: 'Recruiter', cell: (r) => str(r.recruiterName) || str(r.email) },
        { label: 'Company', cell: (r) => str(r.companyName) },
        { label: 'Status', cell: (r) => normStatus(r.status) },
        { label: 'Follow-up', cell: (r) => str(r.followUpDate) },
        { label: 'Saved', cell: (r) => day(r.savedAt) }
      ],
      search: (r) => [r.recruiterName, r.email, r.companyName, r.requirement, r.location, r.technologies, r.notes, r.phone, r.endClient],
      filter: { label: 'Status', options: () => Object.fromEntries([['', 'All statuses'], ...LEAD_STATUSES.map((s) => [s, s])]), test: (r, v) => normStatus(r.status) === v },
      fields: [['Email', 'email'], ['Name', 'recruiterName'], ['Company', 'companyName'], ['Phone', 'phone'], ['Status', (r) => normStatus(r.status)],
        ['Follow-up date', 'followUpDate'], ['Last contact', 'lastContactDate'], ['Requirement', 'requirement'], ['End client', 'endClient'],
        ['Location', 'location'], ['Skills', 'technologies'], ['Job ID', 'jobId'], ['Post', 'sourceUrl'], ['Saved', (r) => day(r.savedAt)], ['Notes', 'notes']]
    },
    companies: {
      title: (r) => str(r.name) || str(r.domain) || str(r.id),
      columns: [
        { label: 'Vendor', cell: (r) => str(r.name) || str(r.id) },
        { label: 'Domain', cell: (r) => str(r.domain) },
        { label: 'Label', cell: (r) => companyLabel(r.label) }
      ],
      search: (r) => [r.name, r.domain, r.id, r.notes, r.aliases],
      filter: { label: 'Label', options: () => ({ '': 'All labels', ...BP.COMPANY_LABELS }), test: (r, v) => (r.label || 'none') === v },
      fields: [['Name', 'name'], ['Domain', 'domain'], ['Label', (r) => companyLabel(r.label)], ['Other names', 'aliases'],
        ['Agreements', (r) => (BP.Agreements ? BP.Agreements.summary(r, todayIso()) : '')], ['Payment note', 'paymentNote'], ['Notes', 'notes']]
    },
    consultants: {
      title: (r) => str(r.name),
      columns: [
        { label: 'Name', cell: (r) => str(r.name) },
        { label: 'Title', cell: (r) => str(r.title) },
        { label: 'Work auth.', cell: (r) => BP.consultantVisaType(r) },
        { label: 'Rate', cell: (r) => str(r.rate) },
        { label: 'Available', cell: (r) => BP.availabilityText(r, BP.todayStr()) || str(r.availability) },
        { label: 'Status', cell: (r) => BP.BENCH_STATUS_LABELS[BP.benchStatusOf(r)] }
      ],
      search: (r) => [r.name, r.title, r.skills, r.visa, r.location, r.email, r.notes],
      filter: { label: 'Show', options: () => ({ '': 'Everyone', ...BP.BENCH_STATUS_LABELS }), test: (r, v) => BP.benchStatusOf(r) === v },
      fields: [['Name', 'name'], ['Title', 'title'], ['Skills', 'skills'], ['Experience (years)', 'experienceYears'],
        ['Work authorisation', (r) => BP.consultantVisaType(r)], ['Authorised until', (r) => (r.workAuthUntil ? BP.planDate(r.workAuthUntil) : '')], ['Visa note', 'visa'],
        ['Tax terms', 'taxTerms'], ['Rate', 'rate'], ['Minimum rate', (r) => BP.rateMinText(r)], ['Location', 'location'], ['Relocation', 'relocation'],
        ['Available from', (r) => (r.availableOn ? BP.planDate(r.availableOn) : '')], ['Availability', 'availability'], ['On bench since', 'benchStart'],
        ['Email', 'email'], ['Phone', 'phone'], ['Status', (r) => BP.BENCH_STATUS_LABELS[BP.benchStatusOf(r)]],
        // Staffing P5 (schema 17): the consent record, the same three fields as the extension and the team web app
        ['Consent given on', (r) => (r.consentOn ? BP.planDate(r.consentOn) : '')], ['Consent how', (r) => CONSENT_SOURCE_LABELS[r.consentSource] || ''],
        ['Consent note', 'consentNote'], ['Notes', 'notes']]
    },
    submissions: {
      title: (r) => str(r.role) || 'Submission',
      columns: [
        { label: 'Consultant', cell: (r) => str(r.consultantName) },
        { label: 'Role', cell: (r) => str(r.role) },
        { label: 'Vendor', cell: (r) => str(r.vendorName) },
        { label: 'Status', cell: (r) => str(r.status) },
        { label: 'Submitted', cell: (r) => day(r.submittedAt) }
      ],
      search: (r) => [r.consultantName, r.role, r.vendorName, r.endClient, r.leadEmail, r.recruiterEmail, r.jobId, r.status],
      filter: { label: 'Status', options: presentValues('All statuses', 'status'), test: (r, v) => r.status === v },
      fields: [['Consultant', 'consultantName'], ['Role', 'role'], ['Vendor', 'vendorName'], ['Recruiter email', 'leadEmail'], ['End client', 'endClient'],
        ['Job ID', 'jobId'], ['Location', 'location'], ['Rate asked', 'rateAsked'], ['Status', 'status'], ['Follow-up date', 'followUpDate'],
        ['Submitted', (r) => day(r.submittedAt)],
        // P2: the RTR, the rates, the margin (the rate calculator's formula) and the vendor chain, from the extension's own rules
        ['RTR', (r) => rtrText(r)], ['Bill rate', (r) => subs().rateText(r.billRate, r.rateUnit)], ['Pay rate', (r) => subs().rateText(r.payRate, r.rateUnit)],
        ['Margin', (r) => marginText(r)], ['Vendor chain', (r) => (Array.isArray(r.chain) ? r.chain.join(' → ') : '')], ['RTR note', 'rtrNote']]
    },
    notes: {
      title: (r) => str(r.title) || 'Note',
      columns: [
        { label: 'Title', cell: (r) => str(r.title) },
        { label: 'Updated', cell: (r) => day(r.updatedAt || r.createdAt) }
      ],
      search: (r) => [r.title, r.text],
      filter: null,
      fields: [['Title', 'title'], ['Text', 'text'], ['Updated', (r) => day(r.updatedAt || r.createdAt)]]
    },
    jobs: {
      title: (r) => str(r.title) || 'Job',
      columns: [
        { label: 'Title', cell: (r) => str(r.title) },
        { label: 'Company', cell: (r) => str(r.company) },
        { label: 'Status', cell: (r) => cap(r.status) },
        { label: 'Saved', cell: (r) => day(r.savedAt) }
      ],
      search: (r) => [r.title, r.company, r.email, r.location, r.notes],
      filter: { label: 'Status', options: presentValues('All statuses', 'status', cap), test: (r, v) => r.status === v },
      fields: [['Title', 'title'], ['Company', 'company'], ['Email', 'email'], ['Location', 'location'], ['Status', (r) => cap(r.status)],
        ['Post', 'postUrl'], ['Saved', (r) => day(r.savedAt)], ['Notes', 'notes']]
    },
    templates: {
      title: (r) => str(r.name) || 'Template',
      columns: [
        { label: 'Name', cell: (r) => str(r.name) || str(r.id) },
        { label: 'Subject', cell: (r) => str(r.subject) }
      ],
      search: (r) => [r.name, r.subject, r.body],
      filter: null,
      fields: [['Name', 'name'], ['Subject', 'subject'], ['Body', 'body']]
    },
    resumes: {
      title: (r) => str(r.fileName) || 'Resume file',
      columns: [
        { label: 'File', cell: (r) => str(r.fileName) || 'Resume file' },
        { label: 'Type', cell: (r) => fileType(r.type) },
        { label: 'Size', cell: (r) => fileSize(r.size) },
        { label: 'Uploaded', cell: (r) => day(r.uploadedAt) }
      ],
      search: (r) => [r.fileName],
      filter: null,
      fields: [['File', 'fileName'], ['Type', (r) => fileType(r.type)], ['Size', (r) => fileSize(r.size)], ['Uploaded', (r) => day(r.uploadedAt)]]
    }
  };

  /** [{ label, value }] for the detail view; empty fields are left out. */
  function detailFields(dataset, r) {
    const v = VIEWS[dataset];
    return v.fields.map(([label, f]) => ({ label, value: typeof f === 'function' ? f(r) : str(r[f]) })).filter((x) => x.value !== '');
  }

  /** rows = [{ id, r }]; query = free text (every word must match); filter = the filter value ('' = all). Newest list order kept. */
  function filterRows(dataset, rows, query, filter) {
    const v = VIEWS[dataset];
    const words = lower(query).split(/\s+/).filter(Boolean);
    return rows.filter(({ r }) => {
      if (filter && v.filter && !v.filter.test(r, filter)) return false;
      if (!words.length) return true;
      const hay = v.search(r).map(lower).join(' \u0001 ');
      return words.every((w) => hay.includes(w));
    });
  }

  // ── safe edits (spec section 2): the fields and their limits are the extension's own (sanitizeLead / sanitizeConsultant in the service
  // worker; lib/migrations.js updateCompany; lib/submissions.js updateStatus; lib/shared.js sanitizeQuickNote; the Settings template editor) ──
  const clip = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
  const EDITABLE = {
    leads: ['status', 'notes', 'followUpDate'],
    consultants: ['title', 'skills', 'visaType', 'workAuthUntil', 'visa', 'rate', 'rateMin', 'rateUnit', 'location', 'availableOn', 'availability', 'notes', 'benchStatus', 'active',
      'consentOn', 'consentSource', 'consentNote'],
    // Vendor agreements (staffing P6, lib/vendor-agreements.js): checked and stored by the extension's own updateCompany ({ agreement }).
    companies: ['name', 'label', 'notes', 'msaStatus', 'msaSignedOn', 'msaUntil', 'ndaStatus', 'ndaSignedOn', 'ndaUntil', 'netTerms', 'paymentNote'],
    submissions: ['status', 'followUpDate', 'rateAsked', 'rtrNote', 'rtrOn', 'rtrUntil', 'rtrRate', 'billRate', 'payRate', 'chain'],
    notes: ['title', 'text'],
    templates: ['name', 'subject', 'body']
  };
  /** Lists a record can be added to in the web app, and deleted from (templates and resume files stay in the extension). */
  const ADDABLE = ['leads', 'companies', 'consultants', 'submissions', 'notes', 'jobs'];
  const canEdit = (dataset) => Boolean(EDITABLE[dataset]);
  const canAdd = (dataset) => ADDABLE.includes(dataset);
  const canDelete = canAdd;
  const need = (ok, what) => { if (!ok) throw new Error('Could not load the extension\'s ' + what + ' rules. Reload the page.'); };
  const dateOk = (d) => DATE_RE.test(d) && Number.isFinite(Date.parse(d));
  const subs = () => { need(BP.Submissions && BP.Submissions.updateStatus, 'submission'); return BP.Submissions; };
  // P2: "Given 10 Nov 2026 · until 10 Dec 2026", "Ended 2 Nov 2026", "Asked 13 Nov 2026" or "" (BP.Submissions.rtrOf; a legacy tick reads as given).
  const rtrText = (r) => {
    const x = subs().rtrOf(r);
    if (x.state === 'expired') return 'Ended ' + subs().dayLabel(x.until);
    if (x.state === 'signed') return 'Given ' + subs().dayLabel(x.on) + (x.until ? ' · until ' + subs().dayLabel(x.until) : '') + (x.rate !== null ? ' · ' + subs().rateText(x.rate, r.rateUnit) : '');
    if (x.state === 'requested') return 'Asked ' + subs().dayLabel(x.requestedOn);
    return '';
  };
  const marginText = (r) => { const m = subs().submissionMargin(r); return m.valid ? `$${m.margin}/h (${m.marginPct}%)` : ''; };
  const jobsLib = () => { need(BP.Jobs && BP.Jobs.sanitizeJobInput, 'job'); return BP.Jobs; };

  /** The cleaned patch, or throws an Error with a message to show. Only fields in EDITABLE are kept. */
  function cleanEdit(dataset, patch) {
    const allowed = EDITABLE[dataset];
    if (!allowed) throw new Error('This list cannot be changed in the web app.');
    const p = patch && typeof patch === 'object' ? patch : {};
    const out = {};
    for (const k of allowed) {
      if (p[k] === undefined) continue;
      if (dataset === 'leads') {
        if (k === 'status') { if (!LEAD_STATUSES.includes(p[k])) throw new Error('Choose a status from the list.'); out[k] = p[k]; }
        else if (k === 'notes') out[k] = clip(p[k], 2000);
        else if (k === 'followUpDate') {
          const d = clip(p[k], 10);
          if (d && !dateOk(d)) throw new Error('Enter the follow-up date as a date, or leave it empty.');
          out[k] = d;
        }
      } else if (dataset === 'consultants') {
        if (k === 'active') out[k] = p[k] !== false;
        // Staffing P1: the same checks as the extension's sanitizeConsultant (a type from the list, dates, a number, a status).
        else if (k === 'visaType') { const v = clip(p[k], 20); if (v && !BP.VISA_TYPES.includes(v)) throw new Error('Choose a work authorisation from the list.'); out[k] = v; }
        // Staffing P5: the extension's BP.Consent.cleanConsent limits (a date, a source from the list, a note up to 200 characters).
        else if (k === 'consentSource') { if (p[k] && !RECORDED_SOURCES.includes(p[k])) throw new Error('Choose how the consultant agreed from the list.'); out[k] = p[k] || ''; }
        else if (k === 'consentNote') out[k] = clip(String(p[k]).replace(/\s+/g, ' '), CONSENT_NOTE_MAX);
        else if (k === 'workAuthUntil' || k === 'availableOn' || k === 'consentOn') {
          const d = clip(p[k], 10);
          if (d && !dateOk(d)) throw new Error('Enter the date as a date, or leave it empty.');
          out[k] = d;
        } else if (k === 'rateMin') {
          const n = BP.cleanRateMin(p[k]);
          if (clip(p[k], 20) && n === null) throw new Error('Enter the minimum rate as a number, for example 60.');
          out[k] = n;
        } else if (k === 'rateUnit') out[k] = BP.normalizeRateUnit(p[k]);
        else if (k === 'benchStatus') {
          if (!BP.BENCH_STATUS.includes(p[k])) throw new Error('Choose a status from the list.');
          out[k] = p[k];
          out.active = BP.onBench({ benchStatus: p[k] });
        } else out[k] = clip(p[k], k === 'notes' || k === 'skills' ? 1000 : 120);
      } else if (dataset === 'companies') {
        if (k === 'name') { out[k] = clip(p[k], 120); if (!out[k]) throw new Error('Company name cannot be empty.'); }
        else if (k === 'label') { if (!BP.COMPANY_LABEL_KEYS.includes(p[k])) throw new Error('Unknown company label.'); out[k] = p[k]; }
        else if (k === 'notes') out[k] = clip(p[k], 2000);
        else out[k] = p[k];             // an agreement field: lib/vendor-agreements.js validates it in patchRecord
      } else if (dataset === 'submissions') {
        if (k === 'status') { const s = subs().normalizeStatus(p[k]); if (!s) throw new Error('Unknown status.'); out[k] = s; }
        else if (k === 'followUpDate' || k === 'rtrOn' || k === 'rtrUntil') {
          const d = clip(p[k], 10);
          if (d && !subs().cleanDay(d)) throw new Error(k === 'followUpDate' ? 'Enter the follow-up date as a date, or leave it empty.' : 'Enter the RTR dates as dates, or leave them empty.');
          out[k] = d;
        } else if (k === 'rtrRate' || k === 'billRate' || k === 'payRate') {
          const v = clip(p[k], 12);
          if (v && subs().cleanRate(v) === null) throw new Error('Enter rates as numbers, for example 65.');
          out[k] = v;
        } else if (k === 'chain') out[k] = Array.isArray(p[k]) ? p[k] : clip(p[k], 400);
        else out[k] = clip(p[k], k === 'rateAsked' ? 40 : 300);
      } else if (dataset === 'notes') {
        const n = BP.sanitizeQuickNote({ title: k === 'title' ? p[k] : 'x', text: k === 'text' ? p[k] : 'x' });
        out[k] = n[k];
        if (!out[k]) throw new Error(k === 'title' ? 'Give the note a title.' : 'The note text is empty.');
      } else if (dataset === 'templates') {
        // The Settings template editor: an empty name becomes "Untitled"; subject and body are kept as typed (cut to a sane size).
        out[k] = k === 'name' ? (clip(p[k], 120) || 'Untitled') : String(p[k] == null ? '' : p[k]).slice(0, k === 'subject' ? 500 : 10000);
      }
    }
    if (!Object.keys(out).length) throw new Error('Nothing to save.');
    return out;
  }

  /** The record after the patch, through the extension's own update rules where the extension has one. */
  function patchRecord(dataset, before, patch, nowMs) {
    const iso = new Date(nowMs).toISOString();
    if (dataset === 'companies') {
      need(typeof BP.updateCompany === 'function', 'vendor');
      const A = BP.Agreements;
      const agreement = A ? Object.fromEntries(A.FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]])) : {};
      const rest = Object.fromEntries(Object.entries(patch).filter(([k]) => !(k in agreement)));
      const r = BP.updateCompany([before], before.id, Object.keys(agreement).length ? { ...rest, agreement } : rest, iso);
      if (!r.ok) throw new Error(r.error);
      return r.company;
    }
    if (dataset === 'submissions') {
      let next = { ...before };
      if (patch.status !== undefined) {
        const r = subs().updateStatus(next, patch.status, { now: nowMs });
        if (!r.ok) throw new Error(r.error);
        next = { ...r.submission };
      }
      if (patch.followUpDate !== undefined && !subs().isClosedStatus(next.status)) next.followUpDate = patch.followUpDate;
      if (patch.rateAsked !== undefined) next.rateAsked = patch.rateAsked;
      if (patch.rtrNote !== undefined) next.rtrNote = patch.rtrNote;
      const rates = {};
      for (const k of subs().RATE_PATCH_KEYS) if (patch[k] !== undefined) rates[k] = patch[k];
      if (Object.keys(rates).length) {
        const r = subs().updateRates(next, rates, { now: nowMs });
        if (!r.ok) throw new Error(r.error);
        next = { ...r.submission };
      }
      if (sameRecord(next, before)) return before;
      next.updatedAt = iso;
      return next;
    }
    if (dataset === 'notes') {
      const next = { ...before, ...patch };
      return sameRecord(next, before) ? before : { ...next, updatedAt: iso };
    }
    const next = { ...before, ...patch };
    if (dataset === 'leads' && patch.status && patch.status !== normStatus(before.status)) {
      const list = Array.isArray(before.activity) ? before.activity.slice(-49) : [];
      list.push({ at: iso, type: 'status', text: `Status → ${patch.status}` });
      next.activity = list;
    }
    return next;
  }
  /** Equal apart from the "last changed" time (so saving the same values is "Nothing changed", not a new version). */
  function sameRecord(a, b) {
    const strip = (r) => { const o = { ...r }; delete o.updatedAt; return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])); };
    return strip(a) === strip(b);
  }

  const liveEntry = (snap, id) => {
    const e = snap && snap.records && Object.prototype.hasOwnProperty.call(snap.records, id) ? snap.records[id] : null;
    return e && !e.x && e.r ? e : null;
  };
  const deletedError = () => { const err = new Error('This record was deleted on another computer.'); err.code = 'deleted'; return err; };

  /**
   * The snapshot with one record edited (spec section 4, step 1). Pure: returns a new snapshot.
   * Throws { code:'deleted' } when the record is gone or a deletion in `snap`; { code:'unchanged' } when the patch changes nothing.
   */
  function applyEdit(snap, dataset, id, patch, { nowMs, deviceId, hashRecord }) {
    const e = liveEntry(snap, id);
    if (!e) throw deletedError();
    const r = patchRecord(dataset, e.r, patch, nowMs);
    if (r === e.r || hashRecord(r) === hashRecord(e.r) || sameRecord(r, e.r)) { const err = new Error('Nothing changed.'); err.code = 'unchanged'; throw err; }
    return { ...snap, records: { ...snap.records, [id]: { u: Math.max(nowMs, e.u + 1), d: deviceId, r } } };
  }

  /** "Use the other version" of a conflict: the whole record is replaced (a normal edit, so it syncs), as the extension's resolveConflict. */
  function applyReplace(snap, dataset, id, record, { nowMs, deviceId, hashRecord }) {
    const e = liveEntry(snap, id);
    if (!e) throw deletedError();
    if (hashRecord(record) === hashRecord(e.r)) { const err = new Error('That version is already the current one.'); err.code = 'unchanged'; throw err; }
    return { ...snap, records: { ...snap.records, [id]: { u: Math.max(nowMs, e.u + 1), d: deviceId, r: record } } };
  }

  /**
   * The snapshot with one new record (the Solo inbox's "Add to my book", the Add forms). Pure. A live record under that id is never overwritten:
   * throws { code:'exists' }. A deleted one (tombstone) is re-created with a newer stamp, so every computer takes it.
   */
  function applyAdd(snap, dataset, id, record, { nowMs, deviceId }) {
    const recs = (snap && snap.records) || {};
    const e = Object.prototype.hasOwnProperty.call(recs, id) ? recs[id] : null;
    if (e && !e.x && e.r) { const err = new Error('Already in your book.'); err.code = 'exists'; throw err; }
    return { ...snap, v: snap && snap.v ? snap.v : 1, records: { ...recs, [id]: { u: Math.max(nowMs, e ? e.u + 1 : 0), d: deviceId, r: record } } };
  }

  /**
   * The snapshot with one record deleted: the extension's own deletion format (lib/sync-merge.js stamp / snapshotOf), a tombstone
   * { u, d, x: true } with a newer stamp than the record, so the extension's merge takes the deletion (remote newer wins) and removes the
   * record on its next pull. Tombstones are forgotten after 30 days by the extension's prune(), as for a deletion made on a computer.
   */
  function applyDelete(snap, dataset, id, { nowMs, deviceId }) {
    const e = liveEntry(snap, id);
    if (!e) throw deletedError();
    return { ...snap, records: { ...snap.records, [id]: { u: Math.max(nowMs, e.u + 1), d: deviceId, x: true } } };
  }

  // ── new records (Add forms): the shapes and rules of the extension's own save paths ──
  const liveList = (snap) => Object.values((snap && snap.records) || {}).filter((e) => e && !e.x && e.r).map((e) => e.r);

  /**
   * { id, record } of a new record from a form, or throws an Error with a message to show. snap = the data set now (duplicates, plan limits),
   * ctx = { nowMs, settings: { followUpDays }, submissions: [records] (the guard), consultants: [records] (the submission's consultant) }.
   */
  function newRecord(dataset, input, snap, ctx) {
    const i = input && typeof input === 'object' ? input : {};
    const nowMs = ctx.nowMs;
    const iso = new Date(nowMs).toISOString();
    const list = liveList(snap);
    if (dataset === 'leads') {
      const email = clip(i.email, 254).toLowerCase();
      if (!jobsLib().isValidEmail(email)) throw new Error('Enter the recruiter\'s email address.');
      const fu = clip(i.followUpDate, 10);
      if (fu && !dateOk(fu)) throw new Error('Enter the follow-up date as a date, or leave it empty.');
      const record = leadFromForm(i, email, fu, iso);
      return { id: email, record };
    }
    if (dataset === 'companies') {
      const domain = clip(i.domain, 253).toLowerCase().replace(/^@/, '').replace(/^www\./, '');
      const id = BP.companyIdForEmail('x@' + domain);
      if (!id) throw new Error('Enter the vendor\'s business email domain, for example acme-staffing.com (not gmail.com).');
      const name = clip(i.name, 120) || id;
      const label = i.label === undefined || i.label === '' ? 'none' : i.label;
      if (!BP.COMPANY_LABEL_KEYS.includes(label)) throw new Error('Unknown company label.');
      // lib/migrations.js ensureCompany's shape: id = domain = the business domain of the vendor's emails.
      return { id, record: { id, domain: id, name, label, notes: clip(i.notes, 2000), aliases: [], createdAt: iso, updatedAt: iso } };
    }
    if (dataset === 'consultants') {
      // background/service-worker.js sanitizeConsultant + saveConsultant (name required, the plan's consultant limit, a new BP.newId('c')).
      const out = {};
      for (const f of ['name', 'title', 'skills', 'experienceYears', 'visa', 'rate', 'location', 'relocation', 'availability', 'notes', 'phone']) out[f] = clip(i[f], f === 'notes' || f === 'skills' ? 1000 : 120);
      if (!out.name) throw new Error('Consultant name is required.');
      const limit = BP.limit('solo', 'consultants');
      if (list.length >= limit) throw new Error(`You can keep up to ${limit} consultants.`);
      out.resumeUrl = '';
      const email = clip(i.email, 254).toLowerCase();
      out.email = email && jobsLib().isValidEmail(email) ? email : '';
      out.active = true;
      out.taxTerms = BP.normalizeTaxTerms(i.taxTerms || BP.defaultTaxTerms(''));
      // Schema 14 profile fields, as lib/migrations.js migrateToV14 gives every consultant.
      Object.assign(out, { visaType: BP.normalizeVisa(out.visa), workAuthUntil: '', availableOn: BP.availableOnFromText(out.availability, BP.todayStr()),
        rateMin: null, rateUnit: 'hr', benchStatus: 'marketing' });
      const id = BP.newId('c');
      return { id, record: { id, ...out, createdAt: iso } };
    }
    if (dataset === 'submissions') {
      const S = subs();
      const c = (ctx.consultants || []).find((x) => x && x.id === i.consultantId);
      if (!c) throw new Error('Choose a consultant for this submission.');
      const req = { role: i.role, requirement: i.role, vendorName: i.vendorName, leadEmail: i.leadEmail, endClient: i.endClient, jobId: i.jobId, location: i.location };
      // The extension's duplicate guard: a HARD duplicate (same consultant, same end client in 90 days or same job id in 180) is refused here;
      // the extension can log it with an override reason.
      const g = S.checkDuplicate(req, c.id, ctx.submissions || [], nowMs);
      if (g.level === 'hard') throw new Error(g.message + ' Log it in the extension if you still want to (it asks for a reason).');
      const r = S.createSubmission({ ...req, consultantId: c.id, consultantName: c.name, visa: BP.consultantVisaType(c) || c.visa, rateAsked: i.rateAsked, rtrNote: i.rtrNote,
        billRate: i.billRate, payRate: i.payRate, rtrOn: i.rtrOn, rtrUntil: i.rtrUntil, rtrRate: i.rtrOn ? i.billRate : '', chain: i.chain,
        taxTerms: String(c.taxTerms || '').toUpperCase(), rateUnit: 'hr',
        status: i.status, submittedAt: i.submittedAt || undefined, source: 'logged', guardLevel: g.level, historyNote: 'Logged in the web app' },
      { now: nowMs, followUpDays: ctx.settings && ctx.settings.followUpDays });
      if (!r.ok) throw new Error(r.error);
      if (list.length >= S.MAX_TOTAL) throw new Error(`You can keep up to ${S.MAX_TOTAL} submissions.`);
      return { id: r.submission.id, record: r.submission, guard: g.level === 'soft' ? g.message : '' };
    }
    if (dataset === 'notes') {
      const v = BP.validateQuickNote(i);
      if (!v.ok) throw new Error(v.error);
      const id = BP.newQuickNoteId();
      return { id, record: { id, ...v.note, createdAt: iso, updatedAt: iso, order: list.length } };
    }
    if (dataset === 'jobs') {
      const J = jobsLib();
      const clean = J.sanitizeJobInput(i);
      if (!clean) throw new Error('Give the job a title, an email or a post link.');
      if (J.findDuplicate(list, clean)) { const err = new Error('Already in your book.'); err.code = 'exists'; throw err; }
      if (list.length >= J.MAX_JOBS) throw new Error(`You can keep up to ${J.MAX_JOBS} jobs.`);
      const job = J.newJob(clean, iso);
      if (i.notes) job.notes = clip(i.notes, 2000);
      return { id: job.id, record: job };
    }
    throw new Error('Records cannot be added to this list in the web app.');
  }

  /** A recruiter added by hand: the inbox lead's shape (leadFromInbox), with its own note and timeline line. */
  function leadFromForm(i, email, followUpDate, iso) {
    const t = (v, max = 600) => clip(v, max);
    const lead = {
      email,
      recruiterName: t(i.recruiterName),
      companyName: t(i.companyName),
      phone: t(i.phone),
      requirement: t(i.requirement),
      endClient: t(i.endClient, 120),
      location: t(i.location),
      technologies: t(i.technologies),
      status: 'New',
      bounced: false,
      tierLevel: '',
      directClientVms: '',
      followUpDate,
      lastContactDate: iso.slice(0, 10),
      savedAt: iso,
      notes: t(i.notes, 2000),
      activity: [{ at: iso, type: 'saved', text: 'Added in the web app' }]
    };
    for (const k of Object.keys(lead)) if (lead[k] === '' && !['status', 'tierLevel', 'directClientVms'].includes(k)) delete lead[k];
    return lead;
  }

  /**
   * The Solo morning summary, computed in this tab from the decrypted book with the extension's own BP.Homework.yesterday (lib/homework.js):
   * the same definitions and the same homework day (shift start from the synced `homework` setting, IST). The "homework N of M done" part
   * needs the day's list, which stays on each computer (homeworkDay is never synced), so the web app leaves it out.
   */
  function morningSummary({ leads, submissions, settings }, nowMs) {
    need(BP.Homework && BP.Homework.yesterday, 'morning summary');
    const prefs = BP.Homework.normalizePrefs(settings && settings.homework);
    return BP.Homework.yesterday({ allLeads: leads || [], submissions: submissions || [], homeworkDay: null }, nowMs, { shiftStart: prefs.shiftStart, tz: HOMEWORK_ZONE });
  }

  /**
   * The person's own targets (staffing P4: set on Insights in the extension, synced as the `targets` setting), measured the extension's way
   * (BP.Targets.personalEvents over the synced submissions: an interview on its day, a placement on its start day) in the viewer's zone.
   * @returns [{ period: 'week' | 'month', title, progress: BP.Targets.progress rows }] for the periods that have a target, week first
   */
  function personalTargets({ submissions, settings }, nowMs) {
    need(BP.Targets && BP.Targets.cleanPersonal, 'targets');
    const T = BP.Targets;
    const set = T.cleanPersonal(settings && settings.targets);
    const tz = BP.Placements && BP.Placements.viewerZone ? BP.Placements.viewerZone() : HOMEWORK_ZONE;
    const today = T.dayIn(nowMs, tz);
    const events = T.personalEvents(submissions || [], { tz });
    return T.PERSONAL_PERIODS.filter((p) => set[p]).map((p) => ({
      period: p, title: p === 'week' ? 'Last 7 days' : 'This month', progress: T.progress(set[p], T.counts(events, T.periodRange(p, today)))
    })).filter((x) => x.progress.length);
  }

  /**
   * A new recruiter (lead) from an inbox email, in the shape the extension's saveLeads makes, cut to its sanitizeLead limits (600 characters,
   * notes 2,000). contact = { email, name, phone } (inbox-lib contactFromMessage), fields = parsePastedRequirement's, subject = the email's.
   * companyId, sno and the recruiter type are left for the extension to fill when it next saves the lead (as for an imported lead).
   * A job from a job-board alert (lib/jobboard-mail.js) also passes its board (`board`, e.g. "Dice") and the job's link (`sourceUrl`, kept only
   * when it fits the extension's 600-character field and is an http(s) link).
   */
  function leadFromInbox(contact, fields, { subject, companyName, nowMs, board, sourceUrl }) {
    const t = (v, max = 600) => clip(v, max);
    const f = fields || {};
    const iso = new Date(nowMs).toISOString();
    const lead = {
      email: t(contact.email, 254).toLowerCase(),
      recruiterName: t(contact.name),
      companyName: t(companyName),
      phone: t(contact.phone),
      requirement: t(f.title),
      endClient: t(f.endClient, 120),
      location: t(f.location),
      technologies: t(Array.isArray(f.skills) ? f.skills.join(', ') : f.skills),
      jobId: t(f.jobRef, 80),
      status: 'New',
      bounced: false,
      tierLevel: '',
      directClientVms: '',
      lastContactDate: iso.slice(0, 10),
      savedAt: iso,
      notes: t((board ? 'From a ' + board + ' job alert in your inbox' : 'From your inbox') + (subject ? ': ' + subject : ''), 2000),
      sourceUrl: /^https?:\/\//i.test(String(sourceUrl || '')) && String(sourceUrl).length <= 600 ? String(sourceUrl) : '',
      activity: [{ at: iso, type: 'saved', text: board ? 'Added from a ' + clip(board, 40) + ' job alert in your inbox' : 'Added from your inbox' }]
    };
    if (['remote', 'hybrid', 'onsite'].includes(String(f.workMode || '').toLowerCase())) lead.workMode = String(f.workMode).toLowerCase();
    for (const k of Object.keys(lead)) if (lead[k] === '' && !['status', 'tierLevel', 'directClientVms'].includes(k)) delete lead[k];
    return lead;
  }

  return { LEAD_STATUSES, VIEWS, EDITABLE, ADDABLE, canEdit, canAdd, canDelete, detailFields, filterRows, cleanEdit, patchRecord, applyEdit, applyReplace, applyAdd,
    applyDelete, newRecord, leadFromInbox, morningSummary, personalTargets };
}
