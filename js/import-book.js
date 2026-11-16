// webapp/js/import-book.js - Excel/CSV import for the team book (spec section 5.3). Pure: no DOM, no network.
// Reading files and matching vendor columns reuse the extension's own lib/import.js and lib/xlsx-reader.js (loaded by bp-lib.js
// loadImportLib() and passed in as `lib`), so a sheet the extension imports is read the same way here. Consultant columns
// (visa, rate, availability ...) are not in the extension's import, so they are matched here with the same header rules.
//
//   readSheets(file, lib)   -> [{ name, rows, rowNumbers }]
//   planSheet(sheet, lib)   -> { name, kind: 'vendors'|'consultants'|'skip', headerRow, headers, vMapping, cMapping, rows, rowNumbers }
//   buildBook(plans, lib, today) -> { vendors: [...], consultants: [...], skipped }   duplicates merged (vendors by lower-case email,
//                                                                                    consultants by name)
//   previewRows(plan, lib, 20)  -> { columns: [label], rows: [[text]] }

export const MAX_IMPORT_ROWS = 5000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Free-mail domains are never a vendor company key (same list as the server, migrations 0013/0014). */
export const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'rocketmail.com', 'outlook.com',
  'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'proton.me', 'rediffmail.com', 'zoho.com',
  'zohomail.com', 'gmx.com', 'mail.com', 'yandex.com']);

export const CONSULTANT_LABELS = {
  name: 'Name', title: 'Title', skills: 'Skills', visa: 'Visa', taxTerms: 'Tax terms', rate: 'Rate', location: 'Location',
  relocation: 'Relocation', availableOn: 'Available on', status: 'Status'
};
export const VENDOR_LABELS = { recruiterName: 'Name', companyName: 'Company', designation: 'Title', email: 'Email', phone: 'Phone', linkedinProfile: 'LinkedIn', tierLevel: 'Tier' };

const C_EXACT = {
  name: ['name', 'consultant', 'consultant name', 'candidate', 'candidate name', 'full name', 'resource', 'resource name', 'employee', 'employee name'],
  title: ['title', 'job title', 'role', 'designation', 'position'],
  skills: ['skills', 'skill', 'skill set', 'skillset', 'technologies', 'technology', 'tech stack', 'primary skills', 'key skills'],
  visa: ['visa', 'visa status', 'work authorization', 'work authorisation', 'work auth', 'immigration status', 'visa type'],
  taxTerms: ['tax terms', 'tax term', 'terms', 'employment type', 'engagement', 'c2c w2', 'tax'],
  rate: ['rate', 'bill rate', 'pay rate', 'expected rate', 'hourly rate', 'rate hr'],
  location: ['location', 'current location', 'city', 'state', 'city state'],
  relocation: ['relocation', 'relocate', 'open to relocation', 'willing to relocate', 'open to relocate'],
  availableOn: ['available', 'availability', 'available on', 'available from', 'start date', 'availability date'],
  status: ['status', 'bench status', 'marketing status']
};
const C_CONTAINS = [
  ['visa', /visa|work auth/], ['relocation', /relocat/], ['availableOn', /availab/], ['rate', /\brate\b/],
  ['taxTerms', /tax|c2c|\bw2\b/], ['skills', /skill|technolog/], ['location', /location/], ['name', /\bname\b|consultant|candidate/]
];
const C_SPECIFIC = ['visa', 'taxTerms', 'rate', 'relocation', 'availableOn'];

const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (v) => String(v == null ? '' : v).replace(/ /g, ' ').trim().replace(/^'(?=[=@+\-])/, '').trim();

function consultantField(header) {
  const n = norm(header);
  if (!n || n.length > 60) return '';
  for (const [f, names] of Object.entries(C_EXACT)) if (names.includes(n)) return f;
  if (/@/.test(n)) return '';
  for (const [f, re] of C_CONTAINS) if (re.test(n)) return f;
  return '';
}

function consultantMapping(headers) {
  const used = new Set();
  return (headers || []).map((h) => { const f = consultantField(h); if (!f || used.has(f)) return ''; used.add(f); return f; });
}

function consultantHeaderRow(rows) {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const m = consultantMapping(rows[i]).filter(Boolean);
    if (m.includes('name') && m.length >= 2) return i;
  }
  return -1;
}

/** File -> sheets. CSV (any delimiter the extension sniffs) or .xlsx. Throws an Error with a short message for anything else. */
export async function readSheets(file, lib) {
  const name = String(file && file.name || '');
  if (!file || !file.size) throw new Error('That file is empty.');
  if (file.size > MAX_FILE_BYTES) throw new Error('That file is larger than 10 MB. Split it and import each part.');
  if (/\.xls$/i.test(name)) throw new Error('Old .xls files cannot be read. Save it as .xlsx or CSV and try again.');
  if (/\.(csv|txt|tsv)$/i.test(name)) {
    const { rows, rowNumbers } = lib.Import.compactRows(lib.Import.parseCsv(await file.text()));
    return [{ name: name.replace(/\.[^.]+$/, ''), rows, rowNumbers }];
  }
  if (/\.xlsx$/i.test(name)) {
    const sheets = await lib.readXlsx(new Uint8Array(await file.arrayBuffer()));
    return sheets.map((s) => ({ name: s.name, rows: s.rows, rowNumbers: s.rowNumbers }));
  }
  throw new Error('Pick an .xlsx or .csv file.');
}

/** Decide what a sheet holds. The user can change `kind` before importing. */
export function planSheet(sheet, lib) {
  const rows = sheet.rows || [];
  const hv = lib.Import.detectHeaderRow(rows);
  const hc = consultantHeaderRow(rows);
  const vMap = hv >= 0 ? lib.Import.suggestMapping(rows[hv]) : [];
  const cMap = hc >= 0 ? consultantMapping(rows[hc]) : [];
  const hasEmail = vMap.includes('email');
  const consultantish = cMap.includes('name') && cMap.some((f) => C_SPECIFIC.includes(f));
  const tabSaysConsultants = /consultant|candidate|resource|hotlist|\bbench\b/i.test(sheet.name) && !/seller|vendor/i.test(sheet.name);
  let kind = 'skip';
  if (consultantish && (!hasEmail || tabSaysConsultants || cMap.includes('visa'))) kind = 'consultants';
  else if (hasEmail) kind = 'vendors';
  else if (cMap.includes('name') && tabSaysConsultants) kind = 'consultants';
  return { name: sheet.name, kind, hv, hc, vMapping: vMap, cMapping: cMap, rows, rowNumbers: sheet.rowNumbers || [] };
}

export function headerRow(plan) { return plan.kind === 'consultants' ? plan.hc : plan.hv; }

/** Data rows of a sheet for its kind (blank rows dropped). */
function dataRows(plan) {
  const hr = headerRow(plan);
  if (hr < 0) return [];
  return plan.rows.slice(hr + 1).filter((r) => r.some((c) => clean(c)));
}

export function rowCount(plan) { return plan.kind === 'skip' ? 0 : dataRows(plan).length; }

function tierFrom(text, tabLabel) {
  const t = norm(text);
  if (t) {
    if (/avoid|red|black|dnc|do not/.test(t)) return 'avoid';
    if (/prime/.test(t)) return 'prime';
    if (/direct/.test(t)) return 'direct_client';
    if (/\b(1|one|i)\b|tier ?1/.test(t)) return 'tier1';
    if (/\b(2|two|ii)\b|tier ?2/.test(t)) return 'tier2';
  }
  return { avoid: 'avoid', 'prime-vendor': 'prime', 'direct-client': 'direct_client' }[tabLabel] || '';
}

function vendorFromRow(cells, plan, lib, tabLabel) {
  const { lead, reason } = lib.Import.rowToLead(cells, plan.vMapping);
  if (reason) return null;
  const phone = lead.phone ? (lead.phone + (lead.phoneExt ? ' x' + lead.phoneExt : '')).slice(0, 40) : '';
  const url = String(lead.linkedinProfile || '');
  return {
    email: String(lead.email).toLowerCase(), name: lead.recruiterName || '', phone, title: lead.designation || '', companyName: lead.companyName || '',
    linkedinUrl: /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(url) ? url : '', tier: tierFrom(lead.tierLevel, tabLabel)
  };
}

function isoDay(v, lib) {
  const s = clean(v);
  const iso = lib.Import.toIsoDate(s);
  if (iso) return iso;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);       // US style M/D/YYYY, as US firms write it
  if (m) { const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2])); if (!isNaN(d)) return d.toISOString().slice(0, 10); }
  return '';
}

function consultantFromRow(cells, plan, lib) {
  const raw = {};
  plan.cMapping.forEach((f, i) => { if (f && !raw[f]) { const v = clean(cells[i]); if (v) raw[f] = v; } });
  const name = String(raw.name || '').replace(/\s+/g, ' ').slice(0, 120);
  if (!name || /@/.test(name)) return null;
  const tax = (/\bc2c\b|corp/i.test(raw.taxTerms || '') && 'C2C') || (/\bw-?2\b/i.test(raw.taxTerms || '') && 'W2') || (/1099/.test(raw.taxTerms || '') && '1099') || '';
  const st = String(raw.status || '').toLowerCase();
  const status = /interview/.test(st) ? 'interviewing' : /hold/.test(st) ? 'on_hold' : /placed|project|engaged/.test(st) ? 'placed'
    : /inactive|left|not available/.test(st) ? 'inactive' : st ? 'marketing' : '';
  return {
    name, title: (raw.title || '').slice(0, 120), skills: String(raw.skills || '').split(/[,;|\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 60),
    visa: (raw.visa || '').slice(0, 60), taxTerms: tax, rate: (raw.rate || '').slice(0, 60), location: (raw.location || '').slice(0, 120),
    relocation: /^(y|yes|true|open|willing|ok|any)/i.test(raw.relocation || ''), availableOn: isoDay(raw.availableOn, lib), status
  };
}

/** Fill the empty fields of `a` from `b` (the first row wins, like the server's merge). */
function fill(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(v)) { if (!a[k] || !a[k].length) a[k] = v; } else if (v && !a[k]) a[k] = v;
  }
  return a;
}

/** All planned sheets -> one book with duplicates merged. `skipped` counts rows with no usable email (vendors) or name (consultants). */
export function buildBook(plans, lib) {
  const vendors = new Map();
  const consultants = new Map();
  let skipped = 0;
  for (const p of plans) {
    if (p.kind === 'skip') continue;
    const label = lib.Import.suggestLabel(p.name);
    for (const cells of dataRows(p)) {
      if (p.kind === 'vendors') {
        const v = vendorFromRow(cells, p, lib, label);
        if (!v) { skipped += 1; continue; }
        vendors.set(v.email, vendors.has(v.email) ? fill(vendors.get(v.email), v) : v);
      } else {
        const c = consultantFromRow(cells, p, lib);
        if (!c) { skipped += 1; continue; }
        const key = c.name.toLowerCase();
        consultants.set(key, consultants.has(key) ? fill(consultants.get(key), c) : c);
      }
    }
  }
  return { vendors: [...vendors.values()], consultants: [...consultants.values()], skipped };
}

/** The first `n` data rows of a sheet, with only the matched columns. */
export function previewRows(plan, n) {
  const map = plan.kind === 'consultants' ? plan.cMapping : plan.vMapping;
  const labels = plan.kind === 'consultants' ? CONSULTANT_LABELS : VENDOR_LABELS;
  const cols = map.map((f, i) => ({ f, i })).filter((x) => x.f && labels[x.f]);
  return {
    columns: cols.map((x) => labels[x.f]),
    rows: dataRows(plan).slice(0, n || 20).map((r) => cols.map((x) => clean(r[x.i])))
  };
}

/** Company key for a vendor email: its domain, or '' for a free-mail address. */
export function companyDomain(email) {
  const d = String(email || '').toLowerCase().split('@')[1] || '';
  return d && !FREE_MAIL.has(d) && d.length >= 3 ? d : '';
}
