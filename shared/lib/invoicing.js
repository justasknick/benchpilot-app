// lib/invoicing.js - timesheets, the invoice tracker and commission estimates on placements (staffing "Later" items F1, F2 and G4 of
// docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md). Pure: no DOM, no chrome.*, no network. One implementation for the extension (a person's
// own placements, storage schema 21) and the web app's team workspace (migration 0055), like lib/placements.js.
//
// This is a tracker, not an accounting system: BenchPilot never sends an invoice, never takes a payment and never files anything. A person
// prints the invoice (or saves it as a PDF from the browser), opens an email draft and presses Send themselves.
//
//   BP.Timesheets.weekStartOf('2026-11-12') -> '2026-11-09' (the Monday)      weekLabel('2026-11-09') -> '9 Nov - 15 Nov 2026'
//   BP.Timesheets.cleanTimesheet(input, { before, placement }) -> { ok, timesheet } | { ok:false, error }
//   BP.Timesheets.upsertTimesheet(list, input, opts) -> { ok, timesheets, timesheet }   removeTimesheet(list, id) -> { ok, timesheets }
//   BP.Timesheets.expectedWeeks(placement, today, max) -> ['YYYY-MM-DD' Mondays]: finished weeks the placement ran in, newest first
//   BP.Timesheets.missingWeeks(placement, timesheets, today, max) -> the expected weeks with no timesheet at all (the reminder)
//   BP.Invoices.invoiceStatus(inv, today) -> 'draft' | 'sent' | 'overdue' | 'paid'   (overdue = sent and past the due date; never stored)
//   BP.Invoices.invoiceable(timesheets, { from, to }) -> approved weeks not on an invoice yet
//   BP.Invoices.buildInvoice({ placement, timesheets, vendor, number, issuedOn, otRate, id, now }) -> { ok, invoice } | { ok:false, error }
//   BP.Invoices.updateInvoice(inv, patch, { today, now }) -> { ok, invoice }   (status, sent / paid dates, due date, note)
//   BP.Invoices.nextNumber(numbers, { prefix, year }) -> 'INV-2026-0007'
//   BP.Invoices.summary(list, today) -> { outstanding, overdue, overdueCount, sentCount, draftCount, paidThisMonth }
//   BP.Invoices.csvRows(rows, { dateFormat }) -> [{ column: value }]   CSV_HEADERS: one line per invoice line, for QuickBooks / Zoho Books / Tally
//   BP.Invoices.printDoc(inv, ctx) -> the printable invoice as data (each side renders it with its own markup and a print stylesheet)
//   BP.Invoices.emailDraft(inv, ctx) -> { subject, body }   (the person attaches the PDF and presses Send)
//   BP.Commission.cleanRule(input) -> { ok, rule }   ruleFor(rules, memberId) -> the person's rule, else the default, else null
//   BP.Commission.report(rows, rules, 'YYYY-MM') -> { lines, people, total, missing }   (estimates, never payroll)
//   BP.Commission.csvRows(report, month, nameOf) -> [{ column: value }]   CSV_HEADERS
(function (root) {
  'use strict';
  if (!(root.BP && root.BP.tierOf) && typeof require === 'function') { require('./shared.js'); }
  if (!(root.BP && root.BP.dayKeyOf) && typeof require === 'function') { require('./today.js'); }
  if (!(root.BP && root.BP.Submissions) && typeof require === 'function') { require('./submissions.js'); }
  if (!(root.BP && root.BP.Placements) && typeof require === 'function') { require('./placements.js'); }
  const BP = root.BP;
  const S = BP.Submissions;
  const P = BP.Placements;

  const DAY = 86400000;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad2 = (n) => String(n).padStart(2, '0');
  const plain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const clip = (v, max) => (v === null || v === undefined ? '' : String(v).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max));
  const oneLine = (v, max) => clip(v, max).replace(/\s+/g, ' ');
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const dayNum = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; };
  const fromNum = (n) => { const d = new Date(n * DAY); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
  const addDays = (k, n) => fromNum(dayNum(k) + n);
  const todayOf = (today) => S.cleanDay(today) || BP.dayKeyOf(Date.now(), 'Asia/Kolkata');
  const nowIso = (now) => { const ms = typeof now === 'number' ? now : Date.parse(now || ''); return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString(); };
  const newId = (prefix, now) => `${prefix}_${Date.parse(nowIso(now)).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Timesheets: one row per placement and week (Monday to Sunday). Hours only: no files, no client logins. ──
  const TS_STATUSES = ['draft', 'submitted', 'approved'];
  const TS_LABELS = { draft: 'Draft', submitted: 'Submitted', approved: 'Approved' };
  const MAX_WEEK_HOURS = 168;
  const APPROVER_MAX = 120;
  const MISSING_WEEKS = 8;          // the reminder looks back this many finished weeks

  function weekStartOf(day) {
    const d = S.cleanDay(day);
    if (!d) return '';
    const wd = new Date(dayNum(d) * DAY).getUTCDay();   // 0 = Sunday
    return addDays(d, wd === 0 ? -6 : 1 - wd);
  }
  function weekEndOf(weekStart) { const w = weekStartOf(weekStart); return w ? addDays(w, 6) : ''; }
  function shortDay(k) { const [, m, d] = k.split('-').map(Number); return `${d} ${MON[m - 1]}`; }
  function weekLabel(weekStart) {
    const w = weekStartOf(weekStart);
    if (!w) return '';
    const e = addDays(w, 6);
    return `${shortDay(w)} - ${shortDay(e)} ${e.slice(0, 4)}`;
  }
  function hoursOf(v, label) {
    if (v === null || v === undefined || v === '') return { ok: true, n: 0 };
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''));
    if (!Number.isFinite(n) || n < 0 || n > MAX_WEEK_HOURS) return { ok: false, error: `${label} are a number of hours from 0 to ${MAX_WEEK_HOURS}.` };
    return { ok: true, n: round2(n) };
  }
  // Does a week overlap the placement's dates?
  function weekInPlacement(weekStart, placement) {
    const p = plain(placement) ? placement : null;
    if (!p) return true;
    const start = S.cleanDay(p.startOn), end = S.cleanDay(p.endOn);
    const wEnd = addDays(weekStart, 6);
    return !(start && wEnd < start) && !(end && weekStart > end);
  }
  // input: { id?, weekStart (any day of the week), regular, ot, approvedBy, status }. `before`: the saved row (an edit keeps the rest).
  // An approved week needs the approver's name. A week on an invoice is locked: remove the invoice first.
  function cleanTimesheet(input, opts) {
    const o = opts || {};
    const i = plain(input) ? input : {};
    const b = plain(o.before) ? o.before : null;
    if (b && b.invoiceId) return { ok: false, error: 'This week is on an invoice. Remove the invoice first to change the hours.' };
    const pick = (k) => (i[k] !== undefined ? i[k] : b ? b[k] : undefined);
    const weekStart = weekStartOf(pick('weekStart'));
    if (!weekStart) return { ok: false, error: 'Pick the week.' };
    if (!weekInPlacement(weekStart, o.placement)) return { ok: false, error: 'That week is outside the placement dates.' };
    const reg = hoursOf(pick('regular'), 'Regular hours');
    if (!reg.ok) return reg;
    const ot = hoursOf(pick('ot'), 'Overtime hours');
    if (!ot.ok) return ot;
    if (reg.n + ot.n > MAX_WEEK_HOURS) return { ok: false, error: `A week has ${MAX_WEEK_HOURS} hours. Check the numbers.` };
    const status = TS_STATUSES.includes(pick('status')) ? pick('status') : 'draft';
    const approvedBy = oneLine(pick('approvedBy'), APPROVER_MAX);
    if (status === 'approved' && !approvedBy) return { ok: false, error: 'Add who approved the hours (for example the client manager).' };
    if (status === 'approved' && reg.n + ot.n <= 0) return { ok: false, error: 'An approved week needs some hours.' };
    return { ok: true, timesheet: { id: (b && b.id) || oneLine(i.id, 80) || newId('ts', o.now), weekStart, regular: reg.n, ot: ot.n, approvedBy, status,
      invoiceId: (b && b.invoiceId) || '', updatedAt: nowIso(o.now) } };
  }
  function cleanTimesheetList(list) {
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
      if (!plain(x)) continue;
      const r = cleanTimesheet({ ...x, invoiceId: undefined }, { now: x.updatedAt });
      if (!r.ok || out.some((y) => y.weekStart === r.timesheet.weekStart)) continue;
      out.push({ ...r.timesheet, id: oneLine(x.id, 80) || r.timesheet.id, invoiceId: oneLine(x.invoiceId, 80), updatedAt: oneLine(x.updatedAt, 40) || r.timesheet.updatedAt });
    }
    return out.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));
  }
  function upsertTimesheet(list, input, opts) {
    const o = opts || {};
    const rows = Array.isArray(list) ? list.filter(plain) : [];
    const id = plain(input) && input.id ? String(input.id) : '';
    const before = id ? rows.find((x) => x.id === id) : null;
    if (id && !before) return { ok: false, error: 'That timesheet was not found. It may have been removed.' };
    const r = cleanTimesheet(input, { ...o, before });
    if (!r.ok) return r;
    if (rows.some((x) => x.weekStart === r.timesheet.weekStart && x.id !== r.timesheet.id)) {
      return { ok: false, error: `There is already a timesheet for ${weekLabel(r.timesheet.weekStart)}. Edit that one.` };
    }
    const next = before ? rows.map((x) => (x.id === before.id ? r.timesheet : x)) : rows.concat([r.timesheet]);
    return { ok: true, timesheets: next.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0)), timesheet: r.timesheet };
  }
  function removeTimesheet(list, id) {
    const rows = Array.isArray(list) ? list.filter(plain) : [];
    const x = rows.find((r) => r.id === id);
    if (!x) return { ok: false, error: 'That timesheet was not found. It may have been removed.' };
    if (x.invoiceId) return { ok: false, error: 'This week is on an invoice. Remove the invoice first.' };
    return { ok: true, timesheets: rows.filter((r) => r.id !== id) };
  }
  // Finished weeks (Sunday before today) the placement ran in, newest first, at most `max`. A placement that fell through has none.
  function expectedWeeks(placement, today, max) {
    const p = plain(placement) ? placement : null;
    if (!p || p.status === 'fell_through') return [];
    const start = S.cleanDay(p.startOn);
    if (!start) return [];
    const t = todayOf(today);
    const limit = Math.max(1, Math.min(52, Math.round(Number(max) || MISSING_WEEKS)));
    const out = [];
    for (let w = addDays(weekStartOf(t), -7); out.length < limit; w = addDays(w, -7)) {
      if (addDays(w, 6) < start) break;
      if (weekInPlacement(w, p)) out.push(w);
    }
    return out;
  }
  function missingWeeks(placement, timesheets, today, max) {
    const have = new Set((Array.isArray(timesheets) ? timesheets : []).filter(plain).map((x) => weekStartOf(x.weekStart)));
    return expectedWeeks(placement, today, max).filter((w) => !have.has(w));
  }
  function hoursTotal(list) {
    let regular = 0, ot = 0;
    for (const x of Array.isArray(list) ? list : []) if (plain(x)) { regular += Number(x.regular) || 0; ot += Number(x.ot) || 0; }
    return { regular: round2(regular), ot: round2(ot), total: round2(regular + ot) };
  }

  // ── Invoices: generated from approved weeks x the placement's hourly bill rate. Status draft / sent / paid; overdue is derived. ──
  const INV_STATUSES = ['draft', 'sent', 'paid'];
  const INV_LABELS = { draft: 'Draft', sent: 'Sent', overdue: 'Overdue', paid: 'Paid' };
  const NUMBER_MAX = 40;
  const NOTE_MAX = 300;
  const DEFAULT_PREFIX = 'INV-';

  function invoiceStatus(inv, today) {
    const x = plain(inv) ? inv : {};
    if (x.status === 'paid') return 'paid';
    if (x.status !== 'sent') return 'draft';
    const due = S.cleanDay(x.dueOn);
    return due && due < todayOf(today) ? 'overdue' : 'sent';
  }
  function amountOf(inv) {
    const x = plain(inv) ? inv : {};
    const bill = Number(x.billRate) || 0;
    const otr = x.otRate === null || x.otRate === undefined || x.otRate === '' ? bill : Number(x.otRate) || 0;
    return round2((Number(x.regularHours) || 0) * bill + (Number(x.otHours) || 0) * otr);
  }
  function invoiceable(timesheets, range) {
    const r = range || {};
    const from = weekStartOf(r.from), to = S.cleanDay(r.to);
    return (Array.isArray(timesheets) ? timesheets : []).filter((x) => plain(x) && x.status === 'approved' && !x.invoiceId
      && (!from || x.weekStart >= from) && (!to || x.weekStart <= to))
      .sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0));
  }
  function cleanNumber(v) { return oneLine(v, NUMBER_MAX); }
  // The next number in the prefix-year-sequence form, after the highest one already used with that prefix and year.
  function nextNumber(numbers, opts) {
    const o = opts || {};
    const prefix = oneLine(o.prefix === undefined ? DEFAULT_PREFIX : o.prefix, 12);
    const year = /^\d{4}$/.test(String(o.year || '')) ? String(o.year) : todayOf(o.today).slice(0, 4);
    const head = `${prefix}${year}-`;
    let max = 0;
    for (const n of Array.isArray(numbers) ? numbers : []) {
      const s = String(n || '');
      if (s.startsWith(head)) { const k = Number(s.slice(head.length)); if (Number.isInteger(k) && k > max) max = k; }
    }
    return head + String(max + 1).padStart(4, '0');
  }
  // o: { placement { id, startOn, endOn, billRate, rateUnit, status }, timesheets (the weeks to bill: approved, not invoiced), vendor (net terms),
  //      number, issuedOn, otRate ('' = the bill rate), id, now }
  function buildInvoice(o) {
    const x = o || {};
    const p = plain(x.placement) ? x.placement : null;
    if (!p) return { ok: false, error: 'Placement not found.' };
    if ((p.rateUnit || 'hr') !== 'hr') return { ok: false, error: 'Invoices from timesheets need an hourly bill rate. This placement is billed per ' + p.rateUnit + '.' };
    const bill = S.cleanRate(p.billRate);
    if (bill === null) return { ok: false, error: 'Add the bill rate to the placement first.' };
    const weeks = (Array.isArray(x.timesheets) ? x.timesheets : []).filter((t) => plain(t) && t.status === 'approved' && !t.invoiceId);
    if (!weeks.length) return { ok: false, error: 'No approved week to invoice. Approve the timesheets first.' };
    let otRate = bill;
    if (x.otRate !== undefined && x.otRate !== null && x.otRate !== '') {
      otRate = S.cleanRate(x.otRate);
      if (otRate === null) return { ok: false, error: 'Enter the overtime rate as a number, for example 97.50.' };
    }
    const number = cleanNumber(x.number);
    if (!number) return { ok: false, error: 'Enter the invoice number.' };
    const issuedOn = S.cleanDay(x.issuedOn) || todayOf(x.today);
    const hours = hoursTotal(weeks);
    const starts = weeks.map((t) => t.weekStart).sort();
    let periodFrom = starts[0], periodTo = addDays(starts[starts.length - 1], 6);
    if (S.cleanDay(p.startOn) && p.startOn > periodFrom) periodFrom = p.startOn;
    if (S.cleanDay(p.endOn) && p.endOn < periodTo) periodTo = p.endOn;
    const netTerms = P.netTermsOf(x.vendor);
    const inv = {
      id: oneLine(x.id, 80) || newId('inv', x.now), placementId: oneLine(p.id, 80), number, periodFrom, periodTo,
      regularHours: hours.regular, otHours: hours.ot, billRate: bill, otRate, amount: 0, currency: 'USD',
      issuedOn, dueOn: addDays(issuedOn, netTerms), netTerms, status: 'draft', sentOn: '', paidOn: '', note: '',
      timesheetIds: weeks.map((t) => t.id), createdAt: nowIso(x.now), updatedAt: nowIso(x.now)
    };
    inv.amount = amountOf(inv);
    if (!(inv.amount > 0)) return { ok: false, error: 'The approved weeks have no hours to invoice.' };
    return { ok: true, invoice: inv };
  }
  // patch: { status?, sentOn?, paidOn?, dueOn?, note? }. Sent stamps the day it went (today unless given); Paid needs the day the money
  // came in (today unless given) and never before the invoice date; back to Sent or Draft clears the paid day.
  function updateInvoice(inv, patch, opts) {
    const o = opts || {};
    if (!plain(inv)) return { ok: false, error: 'Invoice not found.' };
    const p = plain(patch) ? patch : {};
    const t = todayOf(o.today);
    const out = { ...inv };
    if (p.dueOn !== undefined) {
      const d = S.cleanDay(p.dueOn);
      if (!d || d < out.issuedOn) return { ok: false, error: 'The due date must be a real date on or after the invoice date.' };
      out.dueOn = d;
    }
    if (p.note !== undefined) out.note = clip(p.note, NOTE_MAX);
    if (p.status !== undefined) {
      if (!INV_STATUSES.includes(p.status)) return { ok: false, error: 'Unknown invoice status.' };
      out.status = p.status;
      if (p.status === 'draft') { out.sentOn = ''; out.paidOn = ''; }
      if (p.status === 'sent') { out.paidOn = ''; out.sentOn = S.cleanDay(p.sentOn) || S.cleanDay(inv.sentOn) || t; }
      if (p.status === 'paid') {
        out.sentOn = S.cleanDay(p.sentOn) || S.cleanDay(inv.sentOn) || out.issuedOn;
        out.paidOn = S.cleanDay(p.paidOn) || t;
      }
    } else if (p.paidOn !== undefined && out.status === 'paid') {
      out.paidOn = S.cleanDay(p.paidOn) || out.paidOn;
    }
    if (out.status === 'paid' && out.paidOn < out.issuedOn) return { ok: false, error: 'The payment date is before the invoice date. Check the date.' };
    out.updatedAt = nowIso(o.now);
    return { ok: true, invoice: out };
  }
  function cleanInvoiceList(list) {
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
      if (!plain(x) || !oneLine(x.id, 80) || !cleanNumber(x.number) || !S.cleanDay(x.issuedOn)) continue;
      const inv = {
        id: oneLine(x.id, 80), placementId: oneLine(x.placementId, 80), number: cleanNumber(x.number),
        periodFrom: S.cleanDay(x.periodFrom), periodTo: S.cleanDay(x.periodTo),
        regularHours: Math.max(0, round2(Number(x.regularHours) || 0)), otHours: Math.max(0, round2(Number(x.otHours) || 0)),
        billRate: S.cleanRate(x.billRate) || 0, otRate: S.cleanRate(x.otRate), amount: 0, currency: 'USD',
        issuedOn: S.cleanDay(x.issuedOn), dueOn: S.cleanDay(x.dueOn) || S.cleanDay(x.issuedOn), netTerms: P.NET_TERMS.includes(Number(x.netTerms)) ? Number(x.netTerms) : P.DEFAULT_NET_TERMS,
        status: INV_STATUSES.includes(x.status) ? x.status : 'draft', sentOn: S.cleanDay(x.sentOn), paidOn: S.cleanDay(x.paidOn), note: clip(x.note, NOTE_MAX),
        timesheetIds: (Array.isArray(x.timesheetIds) ? x.timesheetIds : []).map((v) => oneLine(v, 80)).filter(Boolean),
        createdAt: oneLine(x.createdAt, 40), updatedAt: oneLine(x.updatedAt, 40)
      };
      if (inv.otRate === null) inv.otRate = inv.billRate;
      if (inv.status === 'paid' && !inv.paidOn) inv.paidOn = inv.dueOn;
      inv.amount = amountOf(inv);
      if (!out.some((y) => y.id === inv.id)) out.push(inv);
    }
    return out;
  }
  function summary(list, today) {
    const t = todayOf(today);
    const month = t.slice(0, 7);
    const s = { outstanding: 0, overdue: 0, overdueCount: 0, sentCount: 0, draftCount: 0, paidThisMonth: 0, paidCount: 0 };
    for (const inv of Array.isArray(list) ? list : []) {
      if (!plain(inv)) continue;
      const st = invoiceStatus(inv, t);
      const a = Number(inv.amount) || amountOf(inv);
      if (st === 'draft') s.draftCount++;
      if (st === 'sent' || st === 'overdue') { s.outstanding += a; s.sentCount++; }
      if (st === 'overdue') { s.overdue += a; s.overdueCount++; }
      if (st === 'paid' && String(inv.paidOn || '').slice(0, 7) === month) { s.paidThisMonth += a; s.paidCount++; }
    }
    for (const k of ['outstanding', 'overdue', 'paidThisMonth']) s[k] = round2(s[k]);
    return s;
  }
  // Timesheet weeks with no invoice and placements with weeks missing, for Today: { missing: [{ placementId, weeks }], missingCount }
  function reminders(items, today, max) {
    const out = { missing: [], missingCount: 0 };
    for (const it of Array.isArray(items) ? items : []) {
      if (!plain(it) || !plain(it.placement)) continue;
      const weeks = missingWeeks(it.placement, it.timesheets, today, max);
      if (weeks.length) { out.missing.push({ placementId: it.placement.id, weeks, item: it }); out.missingCount += weeks.length; }
    }
    return out;
  }

  // The CSV: one line per invoice line (regular hours, then overtime), the columns QuickBooks Online, Zoho Books and Tally importers map.
  const CSV_HEADERS = ['Invoice number', 'Customer', 'Invoice date', 'Due date', 'Terms', 'Product/Service', 'Description', 'Quantity', 'Rate', 'Amount',
    'Invoice total', 'Currency', 'Status', 'Paid on', 'PO number', 'Service period'];
  const DATE_FORMATS = { us: 'MM/DD/YYYY (QuickBooks US)', iso: 'YYYY-MM-DD (Zoho Books)', in: 'DD-MM-YYYY (Tally, India)' };
  function fmtDate(d, f) {
    const x = S.cleanDay(d);
    if (!x) return '';
    const [y, m, dd] = [x.slice(0, 4), x.slice(5, 7), x.slice(8, 10)];
    return f === 'iso' ? x : f === 'in' ? `${dd}-${m}-${y}` : `${m}/${dd}/${y}`;
  }
  // rows: [{ invoice, consultantName, vendorName, endClient, role, poRef }]
  function csvRows(rows, opts) {
    const o = opts || {};
    const f = DATE_FORMATS[o.dateFormat] ? o.dateFormat : 'us';
    const t = todayOf(o.today);
    const out = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !plain(r.invoice)) continue;
      const inv = r.invoice;
      const period = `${fmtDate(inv.periodFrom, f)} to ${fmtDate(inv.periodTo, f)}`;
      const base = {
        'Invoice number': inv.number, 'Customer': oneLine(r.vendorName, 120), 'Invoice date': fmtDate(inv.issuedOn, f), 'Due date': fmtDate(inv.dueOn, f),
        'Terms': 'Net ' + (inv.netTerms || P.DEFAULT_NET_TERMS), 'Product/Service': oneLine(r.consultantName, 120),
        'Invoice total': (Number(inv.amount) || amountOf(inv)).toFixed(2), 'Currency': inv.currency || 'USD',
        'Status': INV_LABELS[invoiceStatus(inv, t)], 'Paid on': fmtDate(inv.paidOn, f), 'PO number': oneLine(r.poRef, P.PO_MAX), 'Service period': period
      };
      const what = [oneLine(r.role, 120), oneLine(r.endClient, 120)].filter(Boolean).join(' at ');
      const line = (label, qty, rate) => ({ ...base, 'Description': [label, what].filter(Boolean).join(', '), 'Quantity': String(qty), 'Rate': Number(rate).toFixed(2), 'Amount': round2(qty * rate).toFixed(2) });
      out.push(line('Regular hours', Number(inv.regularHours) || 0, Number(inv.billRate) || 0));
      if (Number(inv.otHours) > 0) out.push(line('Overtime hours', Number(inv.otHours), Number(inv.otRate === null || inv.otRate === undefined ? inv.billRate : inv.otRate)));
    }
    return out;
  }

  // ── The firm's details printed on the invoice (team branding in the web app, Settings in the extension) ──
  const PROFILE_LIMITS = { companyName: 80, address: 300, email: 120, phone: 40, taxId: 40, paymentDetails: 500, prefix: 12 };
  function cleanProfile(input) {
    const i = plain(input) ? input : {};
    const out = {};
    for (const [k, max] of Object.entries(PROFILE_LIMITS)) {
      out[k] = k === 'address' || k === 'paymentDetails' ? clip(i[k], max).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : oneLine(i[k], max);
    }
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return { ok: false, error: 'Enter the billing email as an address, for example accounts@example.com.' };
    if (i.prefix === undefined) out.prefix = DEFAULT_PREFIX;
    return { ok: true, profile: out };
  }
  const longDay = (d) => S.dayLabel(d);
  // ctx: { profile, consultantName, vendorName, endClient, role, poRef }. Returns what the print view shows; nothing is computed by the view.
  function printDoc(inv, ctx) {
    const c = ctx || {};
    const pr = cleanProfile(c.profile).profile || {};
    const x = plain(inv) ? inv : {};
    const what = [oneLine(c.role, 120), oneLine(c.endClient, 120) ? 'at ' + oneLine(c.endClient, 120) : ''].filter(Boolean).join(' ');
    const sep = oneLine(c.role, 120) ? ', ' : ' ';
    const period = `${longDay(x.periodFrom)} to ${longDay(x.periodTo)}`;
    const otr = x.otRate === null || x.otRate === undefined ? x.billRate : x.otRate;
    const lines = [{ description: `${oneLine(c.consultantName, 120) || 'Consultant'}: regular hours${what ? sep + what : ''}`, sub: period, qty: Number(x.regularHours) || 0, rate: Number(x.billRate) || 0 }];
    if (Number(x.otHours) > 0) lines.push({ description: `${oneLine(c.consultantName, 120) || 'Consultant'}: overtime hours`, sub: period, qty: Number(x.otHours), rate: Number(otr) || 0 });
    for (const l of lines) { l.amount = round2(l.qty * l.rate); l.qtyText = `${l.qty} h`; l.rateText = money(l.rate) + '/h'; l.amountText = money(l.amount); }
    return {
      title: 'Invoice', number: x.number || '', status: x.status || 'draft',
      from: { name: pr.companyName || 'Your company name', lines: [pr.address, pr.email, pr.phone, pr.taxId ? 'Tax ID: ' + pr.taxId : ''].filter(Boolean) },
      billTo: { name: oneLine(c.vendorName, 120) || 'Vendor', lines: [] },
      meta: [['Invoice number', x.number || ''], ['Invoice date', longDay(x.issuedOn)], ['Due date', longDay(x.dueOn)], ['Terms', 'Net ' + (x.netTerms || P.DEFAULT_NET_TERMS)],
        ...(oneLine(c.poRef, P.PO_MAX) ? [['PO number', oneLine(c.poRef, P.PO_MAX)]] : []), ['Service period', period]],
      lines, total: round2(lines.reduce((a, l) => a + l.amount, 0)), totalText: money(lines.reduce((a, l) => a + l.amount, 0)), currency: x.currency || 'USD',
      paymentDetails: pr.paymentDetails || '', note: clip(x.note, NOTE_MAX),
      missingProfile: !pr.companyName
    };
  }
  function emailDraft(inv, ctx) {
    const c = ctx || {};
    const x = plain(inv) ? inv : {};
    const pr = cleanProfile(c.profile).profile || {};
    const who = oneLine(c.consultantName, 120) || 'our consultant';
    const first = oneLine(c.contactName, 80).split(' ')[0];
    const amount = money(Number(x.amount) || amountOf(x));
    return {
      subject: `Invoice ${x.number || ''} - ${who} - ${longDay(x.periodFrom)} to ${longDay(x.periodTo)}`,
      body: `Hi ${first || 'team'},\n\nPlease find attached invoice ${x.number || ''} for ${who}'s hours from ${longDay(x.periodFrom)} to ${longDay(x.periodTo)}`
        + `${oneLine(c.poRef, P.PO_MAX) ? ' (PO ' + oneLine(c.poRef, P.PO_MAX) + ')' : ''}.\n\nAmount: ${amount}\nDue date: ${longDay(x.dueOn)} (Net ${x.netTerms || P.DEFAULT_NET_TERMS})\n\n`
        + (pr.paymentDetails ? `Payment details:\n${pr.paymentDetails}\n\n` : '') + `Thank you,\n${pr.companyName || ''}`.trim()
    };
  }

  // ── Commission estimates: a rule per recruiter or a default; % of the margin or a fixed amount per placement; an optional lead share. ──
  // Estimates for a commission sheet. BenchPilot does not run payroll: the firm's own rule and its accountant decide what is paid.
  const BASES = ['margin_pct', 'fixed'];
  const BASIS_LABELS = { margin_pct: '% of margin', fixed: 'Fixed per placement' };
  function cleanRule(input) {
    const i = plain(input) ? input : {};
    const basis = BASES.includes(i.basis) ? i.basis : '';
    if (!basis) return { ok: false, error: 'Pick % of margin or a fixed amount per placement.' };
    const num = (v) => (v === '' || v === null || v === undefined ? null : Number(String(v).replace(/[$,%\s]/g, '')));
    const pct = num(i.pct), fixed = num(i.fixed), share = num(i.leadSharePct);
    if (basis === 'margin_pct' && !(Number.isFinite(pct) && pct > 0 && pct <= 100)) return { ok: false, error: 'Enter the percentage of margin, from 0.01 to 100.' };
    if (basis === 'fixed' && !(Number.isFinite(fixed) && fixed > 0 && fixed < 1000000)) return { ok: false, error: 'Enter the fixed amount per placement, for example 500.' };
    const memberId = oneLine(i.memberId, 80);
    const leadMemberId = oneLine(i.leadMemberId, 80);
    if (leadMemberId && leadMemberId === memberId) return { ok: false, error: 'The lead must be someone other than the recruiter.' };
    if (share !== null && !(Number.isFinite(share) && share >= 0 && share <= 100)) return { ok: false, error: 'The lead share is a percentage from 0 to 100.' };
    if (leadMemberId && !(share > 0)) return { ok: false, error: 'Enter the lead share, or remove the lead.' };
    return { ok: true, rule: { id: oneLine(i.id, 80), memberId, basis, pct: basis === 'margin_pct' ? round2(pct) : null, fixed: basis === 'fixed' ? round2(fixed) : null,
      leadMemberId: leadMemberId || '', leadSharePct: leadMemberId ? round2(share) : 0 } };
  }
  function ruleFor(rules, memberId) {
    const list = (Array.isArray(rules) ? rules : []).filter(plain);
    return list.find((r) => memberId && r.memberId === memberId) || list.find((r) => !r.memberId) || null;
  }
  function ruleText(rule) {
    if (!plain(rule)) return 'No rule';
    const base = rule.basis === 'fixed' ? `${money(rule.fixed)} per placement` : `${rule.pct}% of margin`;
    return rule.leadMemberId && rule.leadSharePct > 0 ? `${base}, ${rule.leadSharePct}% to the lead` : base;
  }
  // rows: [{ recruiterId, placement (with payRate when the viewer may see pay), consultantName }]. For each placement in the month:
  //   % of margin: the month's gross margin estimate (BP.Placements.monthMargin: 8 hours each weekday it runs) x the percentage;
  //   fixed: the amount, once, in the month the placement starts (a placement that fell through earns nothing).
  // The lead's share comes out of the commission. A placement without both rates is listed with no amount (missing).
  function report(rows, rules, month) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
    const empty = { lines: [], people: [], total: 0, missing: 0 };
    if (!m) return empty;
    const lines = [];
    let missing = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!plain(r) || !plain(r.placement) || r.placement.sample === true) continue;
      const p = r.placement;
      const rule = ruleFor(rules, r.recruiterId || '');
      if (!rule) continue;
      let base = null, commission = null, note = '';
      if (rule.basis === 'fixed') {
        if (p.status === 'fell_through' || String(p.startOn || '').slice(0, 7) !== month) continue;
        commission = round2(rule.fixed);
        note = 'Started this month';
      } else {
        const mm = P.monthMargin([p], month);
        if (!mm.counted && !mm.missing) continue;   // did not run in the month
        if (!mm.counted) { missing++; note = 'Add the bill and pay rate'; }
        else { base = mm.total; commission = round2(mm.total * rule.pct / 100); note = mm.rows[0] ? `${mm.rows[0].days} working days` : ''; }
      }
      const leadShare = commission !== null && rule.leadMemberId ? round2(commission * rule.leadSharePct / 100) : 0;
      lines.push({ placementId: p.id || '', recruiterId: r.recruiterId || '', consultantName: oneLine(r.consultantName, 120), rule, basis: rule.basis, base, commission,
        recruiterShare: commission === null ? null : round2(commission - leadShare), leadId: rule.leadMemberId || '', leadShare, note });
    }
    const people = new Map();
    const add = (id, amount) => { if (!people.has(id)) people.set(id, { memberId: id, amount: 0, placements: 0 }); const x = people.get(id); x.amount = round2(x.amount + amount); x.placements++; };
    for (const l of lines) {
      if (l.commission === null) continue;
      add(l.recruiterId, l.recruiterShare);
      if (l.leadId && l.leadShare > 0) add(l.leadId, l.leadShare);
    }
    const ppl = [...people.values()].sort((a, b) => b.amount - a.amount);
    return { lines, people: ppl, total: round2(lines.reduce((a, l) => a + (l.commission || 0), 0)), missing };
  }
  const COMMISSION_HEADERS = ['Month', 'Recruiter', 'Consultant', 'Rule', 'Margin estimate (USD)', 'Commission estimate (USD)', 'Recruiter share (USD)', 'Lead', 'Lead share (USD)', 'Note'];
  function commissionCsvRows(rep, month, nameOf) {
    const name = typeof nameOf === 'function' ? nameOf : (id) => id;
    const n2 = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(2));
    return (plain(rep) && Array.isArray(rep.lines) ? rep.lines : []).map((l) => ({
      'Month': month, 'Recruiter': name(l.recruiterId) || 'No recruiter', 'Consultant': l.consultantName, 'Rule': ruleText(l.rule),
      'Margin estimate (USD)': n2(l.base), 'Commission estimate (USD)': n2(l.commission), 'Recruiter share (USD)': n2(l.recruiterShare),
      'Lead': l.leadId ? name(l.leadId) : '', 'Lead share (USD)': l.leadId ? n2(l.leadShare) : '', 'Note': l.note
    }));
  }
  const ESTIMATE_NOTE = 'Estimates for your commission sheet, not payroll. Margin is the 8-hours-a-weekday estimate; your firm’s own rule and accountant decide what is paid.';

  // ── On an extension submission record (storage schema 21: timesheets[] and invoices[] next to placement). The worker saves what these return. ──
  function withTimesheet(sub, input, opts) {
    if (!plain(sub)) return { ok: false, error: 'Submission not found.' };
    if (!plain(sub.placement)) return { ok: false, error: 'Add the placement (start date and rates) first.' };
    const r = upsertTimesheet(sub.timesheets, input, { ...(opts || {}), placement: sub.placement });
    if (!r.ok) return r;
    return { ok: true, submission: { ...sub, timesheets: r.timesheets, updatedAt: nowIso((opts || {}).now) }, timesheet: r.timesheet };
  }
  function withoutTimesheet(sub, id, opts) {
    if (!plain(sub)) return { ok: false, error: 'Submission not found.' };
    const r = removeTimesheet(sub.timesheets, id);
    if (!r.ok) return r;
    return { ok: true, submission: { ...sub, timesheets: r.timesheets, updatedAt: nowIso((opts || {}).now) } };
  }
  // input: { from, to, number, issuedOn, otRate } (a new invoice from the approved weeks in the range) | { id, status, paidOn, dueOn, note } (an edit)
  function withInvoice(sub, input, opts) {
    const o = opts || {};
    if (!plain(sub)) return { ok: false, error: 'Submission not found.' };
    const list = Array.isArray(sub.invoices) ? sub.invoices.filter(plain) : [];
    const i = plain(input) ? input : {};
    if (i.id) {
      const at = list.findIndex((x) => x.id === i.id);
      if (at < 0) return { ok: false, error: 'That invoice was not found. It may have been removed.' };
      const r = updateInvoice(list[at], i, o);
      if (!r.ok) return r;
      const next = list.slice(); next[at] = r.invoice;
      return { ok: true, submission: { ...sub, invoices: next, updatedAt: nowIso(o.now) }, invoice: r.invoice };
    }
    if (!plain(sub.placement)) return { ok: false, error: 'Add the placement (start date and rates) first.' };
    const number = cleanNumber(i.number);
    if (number && (o.usedNumbers || list.map((x) => x.number)).some((n) => String(n).toLowerCase() === number.toLowerCase())) {
      return { ok: false, error: `Invoice number ${number} is already used. Pick another.` };
    }
    const weeks = invoiceable(sub.timesheets, { from: i.from, to: i.to });
    const r = buildInvoice({ placement: { ...sub.placement, id: sub.id }, timesheets: weeks, vendor: o.vendor, number, issuedOn: i.issuedOn, otRate: i.otRate, now: o.now, today: o.today });
    if (!r.ok) return r;
    const ids = new Set(r.invoice.timesheetIds);
    const timesheets = (sub.timesheets || []).map((t) => (ids.has(t.id) ? { ...t, invoiceId: r.invoice.id } : t));
    return { ok: true, submission: { ...sub, timesheets, invoices: list.concat([r.invoice]), updatedAt: nowIso(o.now) }, invoice: r.invoice };
  }
  // Removing an invoice frees its weeks (they can be invoiced again).
  function withoutInvoice(sub, id, opts) {
    if (!plain(sub)) return { ok: false, error: 'Submission not found.' };
    const list = Array.isArray(sub.invoices) ? sub.invoices.filter(plain) : [];
    if (!list.some((x) => x.id === id)) return { ok: false, error: 'That invoice was not found. It may have been removed.' };
    const timesheets = (sub.timesheets || []).map((t) => (t && t.invoiceId === id ? { ...t, invoiceId: '' } : t));
    return { ok: true, submission: { ...sub, timesheets, invoices: list.filter((x) => x.id !== id), updatedAt: nowIso((opts || {}).now) } };
  }

  BP.Timesheets = {
    STATUSES: TS_STATUSES, STATUS_LABELS: TS_LABELS, MAX_WEEK_HOURS, APPROVER_MAX, MISSING_WEEKS,
    weekStartOf, weekEndOf, weekLabel, cleanTimesheet, cleanTimesheetList, upsertTimesheet, removeTimesheet, expectedWeeks, missingWeeks, hoursTotal,
    withTimesheet, withoutTimesheet
  };
  BP.Invoices = {
    STATUSES: INV_STATUSES, STATUS_LABELS: INV_LABELS, NUMBER_MAX, NOTE_MAX, DEFAULT_PREFIX, CSV_HEADERS, DATE_FORMATS, PROFILE_LIMITS,
    invoiceStatus, amountOf, invoiceable, nextNumber, buildInvoice, updateInvoice, cleanInvoiceList, summary, reminders, csvRows, fmtDate,
    cleanProfile, printDoc, emailDraft, withInvoice, withoutInvoice, money
  };
  BP.Commission = { BASES, BASIS_LABELS, CSV_HEADERS: COMMISSION_HEADERS, ESTIMATE_NOTE, cleanRule, ruleFor, ruleText, report, csvRows: commissionCsvRows };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
