// lib/import.js - Pure logic for the Excel/CSV import wizard (v1.5). Nothing here touches the DOM
// or chrome.storage; the dashboard uses it for the preview and the service worker for the real run
// (BP.Import.applyImport / applyUndo), so both always agree.
//
//   header detection, column synonyms, tab-name -> company label, row normalisation,
//   merge / conflict computation, company-label plan, import + undo.
//
// Lead state shape follows lib/migrations.js: { allLeads: [...], companies: [...] }.

(function (root) {
  'use strict';

  // Node tests load this file directly; extension pages / the worker have shared.js + migrations.js first.
  if (!root.BP && typeof require === 'function') require('./shared.js');
  if (root.BP && !root.BP.ensureCompany && typeof require === 'function') require('./migrations.js');
  const BP = root.BP;

  // ── Fields a column can be mapped to ──────────────────────────────────────
  const FIELDS = [
    { key: 'recruiterName', label: 'Recruiter name' },
    { key: 'companyName', label: 'Company' },
    { key: 'designation', label: 'Designation' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'officePhone', label: 'Office phone' },
    { key: 'linkedinProfile', label: 'LinkedIn' },
    { key: 'location', label: 'Location' },
    { key: 'notes', label: 'Notes' },
    { key: 'technologies', label: 'Skills / technologies' },
    { key: 'requirement', label: 'Requirement' },
    { key: 'directClientVms', label: 'Client type' },
    { key: 'tierLevel', label: 'Tier' },
    { key: 'status', label: 'Status' },
    { key: 'followUpDate', label: 'Follow-up date' },
    { key: 'lastContactDate', label: 'Last contact date' }
  ];
  const FIELD_KEYS = FIELDS.map(f => f.key);

  // Exact (normalised) header names. Anything not found falls through to CONTAINS below.
  const SYNONYMS = {
    recruiterName: ['recruiter', 'recruiter name', 'name', 'contact name', 'contact person', 'contact', 'full name', 'person', 'poc', 'spoc', 'person name'],
    companyName: ['company', 'company name', 'vendor', 'vendor name', 'organization', 'organisation', 'org', 'employer', 'firm', 'client', 'client name'],
    designation: ['designation', 'title', 'job title', 'role', 'position'],
    email: ['email', 'e mail', 'email id', 'mail id', 'email address', 'mail', 'e mail id', 'e mail address'],
    phone: ['phone', 'phone number', 'phone no', 'mobile', 'mobile no', 'mobile number', 'cell', 'cell phone', 'cell no', 'contact no', 'contact number', 'telephone', 'tel', 'ph', 'ph no'],
    officePhone: ['office', 'office phone', 'office number', 'office no', 'desk', 'desk phone', 'desk number', 'landline', 'work phone', 'board'],
    linkedinProfile: ['linkedin', 'linkedin profile', 'linkedin url', 'linkedin link', 'linkedin id', 'profile', 'profile url'],
    location: ['location', 'city', 'state', 'city state', 'region', 'place', 'address'],
    notes: ['notes', 'note', 'remarks', 'remark', 'comments', 'comment', 'notes follow up'],
    technologies: ['skills', 'skill', 'technologies', 'technology', 'tech', 'tech stack', 'technologies they hire for', 'primary skills'],
    requirement: ['requirement', 'requirements', 'job requirement'],
    directClientVms: ['direct client vms', 'client type', 'direct client', 'vms'],
    tierLevel: ['tier', 'tier level'],
    status: ['status'],
    followUpDate: ['follow up date', 'follow up', 'followup date', 'next follow up'],
    lastContactDate: ['last contact date', 'last contact', 'last contacted']
  };
  const EXACT = new Map();
  for (const [field, names] of Object.entries(SYNONYMS)) for (const n of names) EXACT.set(n, field);

  // Looser matches, tried in order, for headers like "Recruiter Email ID" or "Direct Mobile No".
  const CONTAINS = [
    ['email', /(^| )(e ?)?mail( |$)|email/],
    ['linkedinProfile', /linkedin/],
    ['officePhone', /\b(office|desk|landline|work)\b.*\b(phone|no|number|tel|line|ext)\b/],
    ['phone', /phone|mobile|\bcell\b|\btel\b|contact (no|number)/],
    ['location', /location|\bcity\b|\bstate\b/],
    ['companyName', /company|vendor|organi[sz]ation|employer/],
    ['designation', /designation|\btitle\b|\brole\b|\bposition\b/],
    ['notes', /\bnotes?\b|remark|comment/],
    ['technologies', /skill|technolog|tech stack/],
    ['recruiterName', /recruiter|\bname\b/]
  ];

  function normHeader(h) {
    return String(h === null || h === undefined ? '' : h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Field a header suggests, or '' when it is not recognised.
  function suggestField(header) {
    const n = normHeader(header);
    if (!n || n.length > 60) return '';
    if (EXACT.has(n)) return EXACT.get(n);
    if (/\btype\b/.test(n)) return '';
    for (const [field, re] of CONTAINS) if (re.test(n)) return field;
    return '';
  }

  // One field per column (first column wins when two headers suggest the same field).
  function suggestMapping(headers) {
    const used = new Set();
    return (headers || []).map(h => {
      const f = suggestField(h);
      if (!f || used.has(f)) return '';
      used.add(f);
      return f;
    });
  }

  // First row in the first `scan` rows with at least two distinct recognised headers, else -1.
  function detectHeaderRow(rows, scan = 10) {
    const n = Math.min(scan, (rows || []).length);
    for (let i = 0; i < n; i++) {
      const fields = new Set();
      for (const cell of rows[i]) {
        if (/@/.test(String(cell))) continue; // a data row, not a header
        const f = suggestField(cell);
        if (f) fields.add(f);
      }
      if (fields.size >= 2) return i;
    }
    return -1;
  }

  // ── Tab name -> company label ─────────────────────────────────────────────
  // Order matters: "tier-Red" must read as Avoid before anything else is tried.
  const LABEL_RULES = [
    ['avoid', /\b(red|avoid|avoided|black|blacklist|blacklisted|dnc|dnr|bad)\b|do not/],
    ['trusted', /\b(white|trusted|trust|good|preferred|approved|green)\b/],
    ['direct-client', /\b(client|clients|direct|company|companies)\b/],
    ['prime-vendor', /\bprime\b/],
    ['implementation-partner', /\b(implementation|implementing|ip|impl)\b/],
    ['bench-seller', /\b(bench|hotlist|hot list|seller|sellers)\b/]
  ];

  function suggestLabel(tabName) {
    const n = String(tabName || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    for (const [label, re] of LABEL_RULES) if (re.test(n)) return label;
    return 'none';
  }

  // ── Rows -> leads ─────────────────────────────────────────────────────────
  function cleanCell(v) {
    const s = String(v === null || v === undefined ? '' : v).replace(/ /g, ' ').trim();
    // CSV exports from BenchPilot prefix risky cells with an apostrophe.
    return s.replace(/^'(?=[=@+\-])/, '').trim();
  }

  // Excel serial day numbers (e.g. 46300) and ISO dates -> YYYY-MM-DD; anything else -> ''.
  function toIsoDate(v) {
    const s = cleanCell(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{5}(\.\d+)?$/.test(s)) {
      const n = Math.floor(Number(s));
      if (n >= 20000 && n <= 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
    }
    return '';
  }

  function firstEmail(value) {
    const parts = String(value || '').split(/[;,\s]+/).filter(Boolean);
    for (const p of parts) { const e = BP.normalizeEmail(p); if (e) return e; }
    return '';
  }

  // cells + mapping (one field key or '' per column) -> { lead, reason }.
  // reason: '' (usable email) | 'missing' (no email) | 'invalid' (something there, but not an email).
  function rowToLead(cells, mapping) {
    const raw = {};
    mapping.forEach((field, i) => {
      if (!field) return;
      const v = cleanCell(cells[i]);
      if (v && !raw[field]) raw[field] = v;
    });
    const lead = {};
    for (const key of FIELD_KEYS) {
      if (key === 'email' || key === 'phone' || key === 'officePhone' || !raw[key]) continue;
      if (key === 'followUpDate' || key === 'lastContactDate') { const d = toIsoDate(raw[key]); if (d) lead[key] = d; continue; }
      if (key === 'linkedinProfile') { lead[key] = /^https?:\/\//i.test(raw[key]) || !/linkedin\.com/i.test(raw[key]) ? raw[key] : 'https://' + raw[key]; continue; }
      lead[key] = raw[key];
    }
    const email = firstEmail(raw.email);
    if (email) lead.email = email;

    const direct = splitPhone(raw.phone);
    const office = splitPhone(raw.officePhone);
    if (direct.phone) {
      lead.phone = direct.phone;
      if (direct.ext) { lead.phoneExt = direct.ext; lead.phoneType = 'office'; }
      // A second number is never dropped: it goes to the notes.
      if (office.phone) lead.notes = [lead.notes, 'Office: ' + office.phone + (office.ext ? ' x' + office.ext : '')].filter(Boolean).join(' | ');
    } else if (office.phone) {
      lead.phone = office.phone;
      lead.phoneType = 'office';
      if (office.ext) lead.phoneExt = office.ext;
    }
    return { lead, reason: email ? '' : (raw.email ? 'invalid' : 'missing') };
  }

  function splitPhone(v) {
    const s = cleanCell(v);
    if (!s || s === '—' || s === '-') return { phone: '', ext: '' };
    return BP.splitPhoneExt(s);
  }

  // rows (string[][]) of a sheet -> { leads: [{ lead, row }], invalid: [{ row, reason, cells }] }.
  // headerRow is the 0-based index of the header row (rows above it are ignored). rowNumbers (optional)
  // gives each row's real sheet row number for messages; otherwise index + 1.
  function prepareSheet(rows, { headerRow = 0, mapping = [], rowNumbers = null } = {}) {
    const leads = [];
    const invalid = [];
    for (let i = headerRow + 1; i < rows.length; i++) {
      const cells = rows[i];
      if (!cells.some(c => cleanCell(c))) continue;
      const row = rowNumbers ? rowNumbers[i] : i + 1;
      const r = rowToLead(cells, mapping);
      if (r.reason) invalid.push({ row, reason: r.reason, cells: cells.map(cleanCell) });
      else leads.push({ lead: r.lead, row });
    }
    return { leads, invalid };
  }

  // CSV text of the skipped rows: [{ sheet, row, reason, cells }] -> text for a download.
  function invalidRowsCsv(items) {
    const width = items.reduce((m, it) => Math.max(m, it.cells.length), 0);
    const head = ['Sheet', 'Row', 'Why skipped', ...Array.from({ length: width }, (_, i) => 'Column ' + (i + 1))];
    const lines = [head.map(BP.csvCell).join(',')];
    for (const it of items) {
      const why = it.reason === 'missing' ? 'No email' : 'Not a valid email';
      lines.push([it.sheet, it.row, why, ...it.cells].map(BP.csvCell).join(','));
    }
    return lines.join('\r\n');
  }

  // ── CSV text -> rows (RFC 4180; sniffs comma, semicolon or tab) ───────────
  function parseCsv(text) {
    text = String(text || '').replace(/^﻿/, '');
    const first = text.split(/\r\n|\n|\r/).find(l => l.trim()) || '';
    let delim = ',';
    let best = (first.match(/,/g) || []).length;
    for (const d of [';', '\t']) {
      const c = first.split(d).length - 1;
      if (c > best) { best = c; delim = d; }
    }
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  // Drops blank rows, pads to equal width. -> { rows, rowNumbers } (rowNumbers = original 1-based rows).
  function compactRows(rows) {
    const out = [], nums = [];
    rows.forEach((r, i) => { if (r.some(c => String(c).trim())) { out.push(r.map(String)); nums.push(i + 1); } });
    const w = out.reduce((m, r) => Math.max(m, r.length), 0);
    for (const r of out) while (r.length < w) r.push('');
    return { rows: out, rowNumbers: nums };
  }

  // ── Merge into an existing lead ───────────────────────────────────────────
  // Which stored fields the file may fill or change. Phone travels with its type and extension.
  const MERGE_FIELDS = ['recruiterName', 'companyName', 'designation', 'requirement', 'phone', 'location', 'technologies',
    'directClientVms', 'tierLevel', 'status', 'notes', 'linkedinProfile', 'followUpDate', 'lastContactDate'];
  const PHONE_GROUP = ['phone', 'phoneType', 'phoneExt'];

  const isEmptyValue = (v) => { const s = String(v === null || v === undefined ? '' : v).trim(); return s === '' || s === '—'; };
  function sameValue(field, a, b) {
    if (field === 'phone') return String(a).replace(/\D/g, '') === String(b).replace(/\D/g, '');
    const n = (v) => String(v).trim().toLowerCase().replace(/\s+/g, ' ').replace(/\/+$/, '');
    return n(a) === n(b);
  }

  function policyFor(policy, field) {
    const p = policy || {};
    return (p[field] || p['*']) === 'file' ? 'file' : 'keep';
  }

  // stored lead + sanitised incoming lead -> { patch, prev, filled, conflicts }.
  //  patch/prev: field -> new/old value (prev null = field was absent). Empty stored fields are filled;
  //  differing non-empty ones are conflicts, resolved per field by `policy` ('keep' default, or 'file').
  function computeMerge(stored, incoming, policy) {
    const patch = {}, prev = {}, filled = [], conflicts = [];
    const set = (k, v) => { patch[k] = v; prev[k] = stored[k] === undefined ? null : stored[k]; };
    for (const f of MERGE_FIELDS) {
      const next = incoming[f];
      if (isEmptyValue(next)) continue;
      const mine = stored[f];
      const apply = () => {
        set(f, next);
        if (f === 'phone') for (const k of ['phoneType', 'phoneExt']) { if (incoming[k] !== undefined) set(k, incoming[k]); }
      };
      if (isEmptyValue(mine)) { apply(); filled.push(f); continue; }
      if (sameValue(f, mine, next)) continue;
      const resolution = policyFor(policy, f);
      conflicts.push({ field: f, mine, file: next, resolution });
      if (resolution === 'file') apply();
    }
    return { patch, prev, filled, conflicts };
  }

  // ── Company label plan ────────────────────────────────────────────────────
  function companyOfEmail(state, email, byEmail) {
    const existing = byEmail.get(email);
    if (existing && existing.companyId !== undefined) return existing.companyId; // null = user chose no company
    return BP.resolveCompanyId(state.companies || [], email) || BP.companyIdForEmail(email);
  }

  // sheets: [{ label, leads: [lead...] }] (included tabs only). Returns
  //  { labels: { companyId: label }  -> safe to apply (company has no other label; when two tabs
  //                                     disagree the first tab's label is the default),
  //    conflicts: [{ companyId, name, current, wanted, source: 'existing' | 'tabs' }]  -> the caller
  //                                     adds labels[companyId] = wanted for the ones the user switches,
  //    skippedNoCompany: n }  -> leads whose email is free-mail so they have no company to label.
  function planLabels(sheets, state) {
    const companies = state.companies || [];
    const byId = new Map(companies.map(c => [c.id, c]));
    const byEmail = new Map((state.allLeads || []).map(l => [String(l.email || '').toLowerCase(), l]));
    const labels = {}, firstWanted = {}, names = {}, conflictMap = new Map();
    let skippedNoCompany = 0;
    const noCo = new Set();
    for (const sh of sheets) {
      const wanted = sh.label;
      if (!wanted || wanted === 'none' || !BP.COMPANY_LABEL_KEYS.includes(wanted)) continue;
      for (const lead of sh.leads) {
        const email = BP.normalizeEmail(lead.email);
        if (!email) continue;
        const id = companyOfEmail(state, email, byEmail);
        if (!id) { noCo.add(email); continue; }
        const co = byId.get(id);
        if (!names[id]) names[id] = (co && co.name) || lead.companyName || id;
        const current = co && co.label && co.label !== 'none' ? co.label : '';
        if (current && current !== wanted) {
          conflictMap.set(id, { companyId: id, name: names[id], current, wanted, source: 'existing' });
        } else if (firstWanted[id] && firstWanted[id] !== wanted) {
          if (!conflictMap.has(id)) conflictMap.set(id, { companyId: id, name: names[id], current: firstWanted[id], wanted, source: 'tabs' });
        } else if (!current) {
          firstWanted[id] = wanted;
          labels[id] = wanted;
        }
      }
    }
    skippedNoCompany = noCo.size;
    return { labels, conflicts: [...conflictMap.values()], skippedNoCompany };
  }

  // ── Run an import (preview and real run share this) ───────────────────────
  // state: { allLeads, companies, tierLevelDefault?, clientTypeDefault? }
  // incoming: normalised leads (each with .email). options: { conflictPolicy, companyLabels, fileName }.
  // deps: { sanitize(lead) -> clean lead (the worker passes its sanitizeLead), now, today }.
  // Returns { allLeads, companies, snapshot, report }. The state passed in is not modified.
  function applyImport(state, incoming, options, deps) {
    const opts = options || {};
    const d = deps || {};
    const sanitize = d.sanitize || ((l) => ({ ...l }));
    const now = d.now || new Date().toISOString();
    const today = d.today || BP.todayStr();

    const all = (state.allLeads || []).slice();
    const companies = (state.companies || []).map(c => ({ ...c, aliases: (c.aliases || []).slice() }));
    const originalCompanyIds = new Set(companies.map(c => c.id));
    const index = new Map(all.map((l, i) => [String(l.email || '').toLowerCase(), i]));
    let maxSno = all.reduce((m, l) => Math.max(m, Number(l.sno) || 0), 0);

    const report = { added: 0, matched: 0, updated: 0, filled: 0, replaced: 0, keptMine: 0, duplicatesInFile: 0,
      invalid: 0, labelsApplied: 0, newCompanies: 0, conflicts: [] };

    // 1. Validate and collapse duplicates inside the file (later rows only fill what is still empty).
    const unique = new Map();
    for (const raw of incoming || []) {
      const email = BP.normalizeEmail(raw && raw.email);
      if (!email) { report.invalid++; continue; }
      const clean = { ...sanitize(raw), email };
      const seen = unique.get(email);
      if (!seen) { unique.set(email, clean); continue; }
      report.duplicatesInFile++;
      for (const [k, v] of Object.entries(clean)) if (isEmptyValue(seen[k]) && !isEmptyValue(v)) seen[k] = v;
    }

    const snapshot = { version: 1, at: now, fileName: opts.fileName || '', added: [], addedCompanies: [], changed: [], labels: [] };

    // 2. Insert new leads, merge existing ones.
    for (const [email, clean] of unique) {
      const at = index.get(email);
      if (at === undefined) {
        const lead = {
          ...clean,
          email,
          companyId: BP.ensureCompany(companies, email, clean.companyName, now),
          bounced: false,
          sno: ++maxSno,
          status: BP.normalizeStatus(clean.status),
          // Unknown stays unknown (v1.17): the user's Settings default when set, else blank.
          tierLevel: String(clean.tierLevel || '').trim() || state.tierLevelDefault || '',
          directClientVms: String(clean.directClientVms || '').trim() || state.clientTypeDefault || '',
          lastContactDate: clean.lastContactDate || today,
          savedAt: now,
          activity: [{ at: now, type: 'saved', text: 'Imported from file' }]
        };
        index.set(email, all.length);
        all.push(lead);
        snapshot.added.push(email);
        report.added++;
        continue;
      }
      report.matched++;
      const stored = all[at];
      const m = computeMerge(stored, clean, opts.conflictPolicy);
      for (const c of m.conflicts) report.conflicts.push({ email, name: stored.recruiterName || email, ...c });
      const keys = Object.keys(m.patch);
      if (!keys.length) { report.keptMine += m.conflicts.filter(c => c.resolution === 'keep').length; continue; }
      all[at] = { ...stored, ...m.patch };
      snapshot.changed.push({ email, prev: m.prev, next: m.patch });
      report.updated++;
      report.filled += m.filled.length;
      report.replaced += m.conflicts.filter(c => c.resolution === 'file').length;
      report.keptMine += m.conflicts.filter(c => c.resolution === 'keep').length;
    }

    // 3. Company labels (already resolved by the caller: only labels the user accepted).
    for (const [id, label] of Object.entries(opts.companyLabels || {})) {
      const ci = companies.findIndex(c => c.id === id);
      if (ci === -1 || !BP.COMPANY_LABEL_KEYS.includes(label) || companies[ci].label === label) continue;
      snapshot.labels.push({ id, prev: companies[ci].label || 'none', next: label, prevUpdatedAt: companies[ci].updatedAt || '' });
      companies[ci] = { ...companies[ci], label, updatedAt: now };
      report.labelsApplied++;
    }

    for (const c of companies) if (!originalCompanyIds.has(c.id)) snapshot.addedCompanies.push(c.id);
    report.newCompanies = snapshot.addedCompanies.length;
    return { allLeads: all, companies, snapshot, report };
  }

  // Reverts exactly what `snapshot` recorded. A value the user changed after the import is left alone
  // (counted in report.skipped). Returns { allLeads, companies, report }.
  function applyUndo(state, snapshot) {
    const snap = snapshot || {};
    const removed = new Set(snap.added || []);
    let all = (state.allLeads || []).filter(l => !removed.has(String(l.email || '').toLowerCase()));
    const report = { removed: (state.allLeads || []).length - all.length, restored: 0, skipped: 0, labelsReverted: 0, companiesRemoved: 0 };

    const byEmail = new Map(all.map((l, i) => [String(l.email || '').toLowerCase(), i]));
    for (const ch of snap.changed || []) {
      const i = byEmail.get(ch.email);
      if (i === undefined) continue;
      const lead = { ...all[i] };
      let touched = false;
      for (const k of Object.keys(ch.prev)) {
        const current = lead[k] === undefined ? null : lead[k];
        if (current !== ch.next[k]) { report.skipped++; continue; }
        if (ch.prev[k] === null) delete lead[k]; else lead[k] = ch.prev[k];
        touched = true;
      }
      if (touched) { all[i] = lead; report.restored++; }
    }

    let companies = (state.companies || []).slice();
    for (const lb of snap.labels || []) {
      const i = companies.findIndex(c => c.id === lb.id);
      if (i === -1) continue;
      if ((companies[i].label || 'none') !== lb.next) { report.skipped++; continue; }
      companies[i] = { ...companies[i], label: lb.prev, updatedAt: lb.prevUpdatedAt || companies[i].updatedAt };
      report.labelsReverted++;
    }
    const inUse = new Set(all.map(l => l.companyId).filter(Boolean));
    const drop = new Set((snap.addedCompanies || []).filter(id => !inUse.has(id)));
    if (drop.size) { companies = companies.filter(c => !drop.has(c.id)); report.companiesRemoved = drop.size; }
    return { allLeads: all, companies, report };
  }

  BP.Import = {
    FIELDS, FIELD_KEYS, MERGE_FIELDS, PHONE_GROUP,
    suggestField, suggestMapping, detectHeaderRow, suggestLabel,
    rowToLead, prepareSheet, invalidRowsCsv, parseCsv, compactRows,
    computeMerge, planLabels, applyImport, applyUndo, toIsoDate
  };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
