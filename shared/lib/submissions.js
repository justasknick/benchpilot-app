// lib/submissions.js - v1.7 submissions and the duplicate / RTR guard (spec: docs/specs/V1_7_SPEC.md sections 5, 6, 7).
// Pure functions only (no DOM, no chrome.*, no clock unless `now` is left out), like lib/today.js. The service worker
// (single writer) loads it with importScripts; the drawer, dashboard and tests share the same rules.
// Needs lib/shared.js, lib/roles.js, lib/requirement.js and lib/today.js loaded first.
//
//   BP.Submissions.createSubmission(input, { now, id, followUpDays })   -> { ok, submission } | { ok:false, error }
//   BP.Submissions.updateStatus(sub, status, { note, now, followUpDays }) -> { ok, submission } | { ok:false, error }
//   BP.Submissions.nextFollowUp(sub, { today, followUpDays, snooze })    -> 'YYYY-MM-DD' | ''
//   BP.Submissions.checkDuplicate(newReq, consultantId, submissions, now, opts) -> { level, matches, message, ... }
//   BP.Submissions.requirementSnapshot(lead)                              -> the requirement fields a record keeps
//   BP.Submissions.seedSubmissionsFromPitches(state, now)                 -> records for the v3 migration
//   BP.Submissions.rateHint({ consultantRate, ask, payRate, postedRate, name, taxTerms, rateMin, rateUnit }) -> { lines: [{ text, tone }] }   margin hint
//   BP.Submissions.fillSubmitEmail({ template, lead, consultant, senderName, ask, rtrOn, rtrUntil, rtrNote }) -> { subject, body }
//   BP.Submissions.composeGate({ level, override, reason, rtrOn, to, billRate, payRate, rtrRate, rtrUntil, today }) -> { ok, why, warnings }
//
// P2 (RTR, rate confirmation and the vendor chain; docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md). The web app's team workspace loads
// this file too (webapp/js/bp-lib.js), so these rules are the same in both places:
//   BP.Submissions.cleanRate(v) -> number | null        cleanDay(v) -> 'YYYY-MM-DD' | ''        cleanChain(v) -> [name, ...] (at most 4)
//   BP.Submissions.rtrOf(sub, today) -> { state: 'none'|'requested'|'signed'|'expired', on, until, rate, requestedOn, daysLeft }
//   BP.Submissions.submissionMargin({ billRate, payRate, taxTerms, rateUnit }) -> { valid, margin, marginPct, monthly, unit, loss }
//   BP.Submissions.rateChecks({ billRate, payRate, rtrOn, rtrUntil, rtrRate, rateUnit, name, today }) -> [{ code, tone, text }]
//   BP.Submissions.fillRtrEmail({ template, consultant, role, endClient, vendor, chain, rate, rateUnit, taxTerms, validUntil, senderName }) -> { subject, body }
//   BP.Submissions.marginSummary(subs, { from, to }) -> { counted, avgMargin, avgMarginPct, monthlyPlaced, placedCounted }
//   BP.Submissions.undoAllowed(sub, entry, { now, tabId, fromPage, windowMs }) -> { ok, error }
//   BP.Submissions.followUpLabel('2026-10-09') -> 'Fri 9 Oct'
//   BP.Submissions.markSent(sub, { now, followUpDays, tz })   a draft (draft: true) becomes sent: sentAt, history line, follow-up date
//   BP.Submissions.isDraft(sub)                                 opened as an email draft and not yet marked as sent (v1.19)
//   BP.Submissions.compactSubmissions(list, cap)   past `cap` full records the oldest Closed ones shrink -> { list, compacted, over }

(function (root) {
  'use strict';
  if (!(root.BP && root.BP.tierOf) && typeof require === 'function') { require('./shared.js'); }
  if (!(root.BP && root.BP.roleFamily) && typeof require === 'function') { require('./roles.js'); }
  if (!(root.BP && root.BP.normalizeCompanyKey) && typeof require === 'function') { require('./requirement.js'); }
  if (!(root.BP && root.BP.dayKeyOf) && typeof require === 'function') { require('./today.js'); }
  const BP = root.BP;

  const DAY = 86400000;
  const IST = 'Asia/Kolkata';

  // Pipeline (spec section 5): Submitted -> Vendor replied -> Interview -> Offer / Placed -> Rejected / Closed.
  const STATUSES = ['Submitted', 'Vendor replied', 'Interview', 'Offer', 'Placed', 'Rejected', 'Closed'];
  const CLOSED_STATUSES = ['Rejected', 'Closed'];   // follow-up date clears here
  const SOURCES = ['logged', 'seeded'];
  const GUARD_LEVELS = ['none', 'soft', 'hard'];

  const MAX_SUBMISSIONS = 5000;
  const MAX_TOTAL = 20000;      // full + compacted records together: past this, saving stops and the user is told
  const MAX_HISTORY = 40;

  // Guard windows (spec 6.2).
  const HARD_CLIENT_DAYS = 90;
  const HARD_JOBID_DAYS = 180;
  const SOFT_DAYS = 30;
  const MIN_OVERRIDE_REASON = 8;

  const SNOOZE_DAYS = { '1d': 1, '3d': 3, '1w': 7 };

  // P2: rates, terms, the RTR and the vendor chain.
  const RATE_UNITS = ['hr', 'day', 'month', 'year'];
  const UNIT_SUFFIX = { hr: '/hr', day: '/day', month: '/month', year: '/year' };
  const TAX_TERMS = ['C2C', 'W2', '1099'];
  const RTR_STATES = ['none', 'requested', 'signed', 'expired'];
  const MAX_CHAIN = 4;
  const CHAIN_NAME_MAX = 120;

  const clip = (v, max) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
  const lc = (v) => String(v || '').trim().toLowerCase();

  function toMs(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string' && v) return Date.parse(v);
    return NaN;
  }
  const isoOf = (ms) => new Date(ms).toISOString();

  function normalizeStatus(s) {
    const k = lc(s);
    return STATUSES.find(x => x.toLowerCase() === k) || '';
  }
  function isClosedStatus(s) { return CLOSED_STATUSES.includes(s); }

  // ── Dates (UTC arithmetic on YYYY-MM-DD, so results never depend on the computer's zone) ──
  const pad2 = (n) => String(n).padStart(2, '0');
  function addDaysStr(dayKey, days) {
    const [y, m, d] = String(dayKey).split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(ms, tz) {
    const [, m, d] = BP.dayKeyOf(ms, tz).split('-').map(Number);
    return `${d} ${MON[m - 1]}`;
  }

  // ── P2: rates, dates, the RTR and the vendor chain (pure; the drawer, the dashboard, the worker and the web app share them) ──
  // A rate as a number: 65, "65", "$65.50", "$65/hr C2C". Null when empty, not a rate, zero or below, or absurdly large.
  function cleanRate(v) {
    if (v === null || v === undefined || v === '') return null;
    let n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n)) n = BP.parseRate(v);
    if (n === null || !Number.isFinite(n) || n <= 0 || n >= 1000000) return null;
    return Math.round(n * 100) / 100;
  }
  // A real calendar day as 'YYYY-MM-DD' (2026-02-30 is refused), or ''.
  function cleanDay(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v === null || v === undefined ? '' : v).trim());
    if (!m) return '';
    const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return t.getUTCFullYear() === Number(m[1]) && t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]) ? m[0] : '';
  }
  const dayNum = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; };
  const cleanUnit = (u) => (RATE_UNITS.includes(u) ? u : 'hr');
  const cleanTerms = (t) => { const u = String(t || '').trim().toUpperCase(); return TAX_TERMS.includes(u) ? u : ''; };
  // The vendor chain between us and the end client, nearest first: "Northbay Staffing -> Apex Prime -> Infosys" (implementation
  // partner, prime vendor, tier 1 ...). A list, or text split on arrows, ">", commas, semicolons or new lines. At most 4 names, no repeats.
  function cleanChain(v) {
    const raw = Array.isArray(v) ? v : String(v === null || v === undefined ? '' : v).split(/\s*(?:→|->|>|,|;|\n)\s*/);
    const out = [];
    const seen = new Set();
    for (const x of raw) {
      if (typeof x !== 'string' && typeof x !== 'number') continue;
      const name = String(x).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAIN_NAME_MAX);
      const k = name.toLowerCase();
      if (!name || seen.has(k)) continue;
      seen.add(k);
      out.push(name);
      if (out.length >= MAX_CHAIN) break;
    }
    return out;
  }
  const chainText = (chain) => cleanChain(chain).join(' → ');
  function moneyText(n) {
    const r = Math.round(n * 100) / 100;
    return '$' + (Number.isInteger(r) ? String(r) : r.toFixed(2));
  }
  function rateText(n, unit) { const r = cleanRate(n); return r === null ? '' : moneyText(r) + UNIT_SUFFIX[cleanUnit(unit)]; }
  function dayLabel(dayKey) {
    const d = cleanDay(dayKey);
    if (!d) return '';
    const [y, m, dd] = d.split('-').map(Number);
    return `${dd} ${MON[m - 1]} ${y}`;
  }

  // The RTR of a submission (extension record or web-app row): signed on a date, optionally until a date and at a rate. 'expired' is
  // computed here, never stored: signed, with an end date before today. 'requested': asked for (rtrRequestedOn, or the web app's
  // rtrStatus 'requested') and not signed yet.
  function rtrOf(sub, today) {
    const s = sub || {};
    let on = cleanDay(s.rtrOn);
    // Compatibility read: a record synced from a computer still on storage schema 14 or older has only the old tick box.
    if (!on && s.rtrConfirmed === true) { const t = toMs(s.submittedAt); on = Number.isFinite(t) ? BP.dayKeyOf(t, IST) : ''; }
    const until = cleanDay(s.rtrUntil);
    const requestedOn = cleanDay(s.rtrRequestedOn);
    const t = cleanDay(today) || BP.dayKeyOf(Date.now(), IST);
    let state = on ? 'signed' : (requestedOn || s.rtrStatus === 'requested' ? 'requested' : 'none');
    if (on && until && until < t) state = 'expired';
    const daysLeft = on && until ? dayNum(until) - dayNum(t) : null;
    return { state, on, until, rate: cleanRate(s.rtrRate), requestedOn, daysLeft };
  }

  // Margin of a submission: the rate calculator's own formula (BP.rateMargin, lib/shared.js) with the submission's tax terms
  // (W2 adds the calculator's default employer burden; C2C and 1099 have none). margin is per rate unit; monthly only for hourly rates.
  function submissionMargin(o) {
    const i = o || {};
    const bill = cleanRate(i.billRate), pay = cleanRate(i.payRate);
    const unit = cleanUnit(i.rateUnit);
    if (bill === null || pay === null) return { valid: false, margin: 0, marginPct: 0, monthly: null, unit, loss: false };
    const m = BP.rateMargin({ type: cleanTerms(i.taxTerms) || 'C2C', pay, bill });
    const margin = Math.round(m.marginHr * 100) / 100;
    return { valid: true, margin, marginPct: Math.round(m.marginPct * 10) / 10, monthly: unit === 'hr' ? Math.round(m.monthly) : null, unit, loss: margin < 0 };
  }

  // Soft warnings about the rate and the RTR, each naming the fix. They never block: composeGate decides what blocks.
  function rateChecks(o) {
    const i = o || {};
    const out = [];
    const unit = cleanUnit(i.rateUnit);
    const first = clip(i.name, 60).split(/\s+/)[0] || 'the consultant';
    const r = rtrOf({ rtrOn: i.rtrOn, rtrUntil: i.rtrUntil, rtrRate: i.rtrRate }, i.today);
    const bill = cleanRate(i.billRate), pay = cleanRate(i.payRate);
    if (r.state === 'expired') out.push({ code: 'rtr_expired', tone: 'warn', text: `The RTR ended on ${dayLabel(r.until)}. Ask ${first} for a new RTR before you submit.` });
    if (r.on && r.rate !== null && bill !== null && r.rate !== bill) {
      out.push({ code: 'rtr_rate', tone: 'warn', text: `Rate differs from the RTR rate: you submit at ${rateText(bill, unit)}, the RTR says ${rateText(r.rate, unit)}. Get a new RTR at ${rateText(bill, unit)}.` });
    }
    if (bill !== null && pay !== null && pay > bill) out.push({ code: 'pay_over_bill', tone: 'warn', text: `The pay rate (${rateText(pay, unit)}) is above the bill rate (${rateText(bill, unit)}). Raise the bill rate or lower the pay rate.` });
    return out;
  }

  // The built-in "Request RTR" email. The person sends it from their own Gmail or Outlook; the consultant replies "I confirm".
  // A plain consent email, not a contract: the screens show NOT_LEGAL_ADVICE next to the buttons.
  const RTR_TEMPLATE = {
    id: 'rtr_request',
    name: 'Request RTR',
    subject: 'Right to represent: {role} at {end_client}',
    body: 'Hi {consultant},\n\n' +
      'I would like to submit your profile for the role below. Before I do, please reply to this email with "I confirm" to give me the right to represent you for it.\n\n' +
      'Role: {role}\nEnd client: {end_client}\nSubmitted through: {chain}\nRate: {rate} {rate_terms}\nValid until: {valid_until}\n\n' +
      'By replying "I confirm", you agree that only I submit you for this role at this end client while this RTR is valid, and that no one else has submitted you for it.\n\n' +
      'Thanks & Regards,\n{myName}'
  };
  const RTR_PLACEHOLDERS = ['consultant', 'role', 'end_client', 'chain', 'rate', 'rate_terms', 'valid_until', 'myName'];
  const NOT_LEGAL_ADVICE = "This template is not legal advice; use your firm's RTR wording if you have one.";

  function fillRtrEmail(o) {
    const i = o || {};
    const tpl = i.template && typeof i.template === 'object' ? i.template : RTR_TEMPLATE;
    const c = i.consultant || {};
    const vars = {
      consultant: clip(c.name || i.consultantName, 120).split(/\s+/)[0] || '',
      role: clip(i.role, 120), end_client: clip(i.endClient, 120), chain: [clip(i.vendor, CHAIN_NAME_MAX)].concat(cleanChain(i.chain)).filter((x, k, a) => x && a.findIndex(y => y.toLowerCase() === x.toLowerCase()) === k).join(' \u2192 '),
      rate: rateText(i.rate, i.rateUnit), rate_terms: cleanTerms(i.taxTerms), valid_until: dayLabel(i.validUntil),
      myName: clip(i.senderName, 120)
    };
    const fill = (text) => String(text || '').replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : ''));
    const subject = fill(tpl.subject).replace(/\s+/g, ' ').replace(/\s+at\s*$/, '').replace(/\s*[-:|,]\s*$/, '').trim();
    // A "Label:" line with nothing after it is dropped, as in the Submit draft; "Hi ," (no name) becomes "Hi,".
    const body = fill(tpl.body).replace(/[ \t]+$/gm, '').replace(/^[A-Za-z][A-Za-z ]{0,24}:\n/gm, '').replace(/^(Hi|Hello|Dear) ,/m, '$1,').replace(/\n{3,}/g, '\n\n').trim();
    return { subject, body };
  }

  // Margin over a set of submissions (the reports): only records with both rates count. Placed and Offer records give the
  // monthly gross margin (hourly rates, 160 hours). from / to: optional 'YYYY-MM-DD' bounds on the submitted day.
  function marginSummary(list, opts) {
    const o = opts || {};
    const from = cleanDay(o.from), to = cleanDay(o.to);
    let n = 0, sum = 0, sumPct = 0, monthly = 0, placed = 0;
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || s.sample === true) continue;
      const day = cleanDay(s.submittedOn) || (Number.isFinite(toMs(s.submittedAt)) ? BP.dayKeyOf(toMs(s.submittedAt), IST) : '');
      if ((from && (!day || day < from)) || (to && (!day || day > to))) continue;
      const m = submissionMargin(s);
      if (!m.valid) continue;
      n++; sum += m.margin; sumPct += m.marginPct;
      const st = String(s.status || s.stage || '').toLowerCase();
      if ((st === 'placed' || st === 'offer') && m.monthly !== null) { monthly += m.monthly; placed++; }
    }
    return { counted: n, avgMargin: n ? Math.round((sum / n) * 100) / 100 : 0, avgMarginPct: n ? Math.round((sumPct / n) * 10) / 10 : 0, monthlyPlaced: Math.round(monthly), placedCounted: placed };
  }

  // ── Names and requirement similarity ─────────────────────────────────────
  const keyCache = new Map();
  function clientKey(name) {
    const raw = String(name || '');
    if (!raw) return '';
    let k = keyCache.get(raw);
    if (k === undefined) {
      k = BP.isUnknownClientName(raw) ? '' : BP.normalizeCompanyKey(raw);
      if (keyCache.size > 20000) keyCache.clear();
      keyCache.set(raw, k);
    }
    return k;
  }
  const normalizeClient = clientKey;
  function normalizeVendor(name) { return BP.normalizeCompanyKey(name); }

  // The shorter name is a whole-word prefix of the longer one ("Toyota" / "Toyota Motor North America"): fuzzy, never HARD.
  const GENERIC_CLIENT_WORDS = new Set(['bank', 'first', 'american', 'national', 'united', 'global', 'capital', 'general', 'group', 'systems', 'technologies',
    'solutions', 'services', 'health', 'healthcare', 'financial', 'insurance', 'international', 'federal', 'state', 'city', 'county', 'university']);
  function fuzzyClientMatch(a, b) {
    if (!a || !b || a === b) return false;
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    return s.length >= 4 && !GENERIC_CLIENT_WORDS.has(s) && l.startsWith(s + ' ');
  }

  const jobIdKey = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const vendorIdOf = (x) => lc(x.companyId || BP.companyIdForEmail(x.recruiterEmail || x.leadEmail || x.email) || '');
  function sameVendor(a, b) {
    const ca = vendorIdOf(a), cb = vendorIdOf(b);
    if (ca && cb) return ca === cb;
    const na = normalizeVendor(a.vendorName), nb = normalizeVendor(b.vendorName);
    return Boolean(na && nb && na === nb);
  }

  function familyOf(x) {
    if (x.roleFamily) return x.roleFamily;
    const f = BP.roleFamily({ requirement: x.role || x.requirement || '', technologies: Array.isArray(x.skills) ? x.skills.join(', ') : (x.technologies || ''), notes: '' });
    return f || 'Other';
  }
  function skillSet(x) {
    const listed = Array.isArray(x.skills) ? x.skills : String(x.technologies || '').split(/[,;|]/);
    const out = new Set();
    for (const s of BP.extractSkills([listed.join(', '), x.role || x.requirement || ''].join(', '))) out.add(s.toLowerCase());
    return out;
  }
  const titleKey = (x) => lc(x.role || x.requirement).replace(/[^a-z0-9+#.\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // "Similar role" (spec 6.2): the same role family and at least one shared core skill.
  function similarRole(a, b) {
    const fa = familyOf(a), fb = familyOf(b);
    if (fa !== fb) return false;
    const sa = skillSet(a), sb = skillSet(b);
    if (sa.size && sb.size) { for (const s of sa) if (sb.has(s)) return true; return false; }
    // One side lists no skills: only an identical title (in a real family) counts.
    return fa !== 'Other' && Boolean(titleKey(a)) && titleKey(a) === titleKey(b);
  }
  function sameFamily(a, b) { const fa = familyOf(a); return fa !== 'Other' && fa === familyOf(b); }

  function stateOf(x) {
    const s = String(x.state || x.localState || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(s)) return s;
    return BP.usStateOf(x.location || '') || '';
  }

  // ── Records ────────────────────────────────────────────────────────────────
  // The fields of a requirement a submission keeps, so deleting the lead never weakens the guard (spec section 7).
  function requirementSnapshot(lead) {
    const l = lead || {};
    const role = clip(l.requirement || l.role || '', 120);
    const skills = BP.extractSkills([l.technologies || '', role].join(', ')).slice(0, 12);
    return {
      leadEmail: lc(l.email || l.leadEmail),
      postKey: clip(l.postKey || l.postUrn, 120),
      companyId: lc(l.companyId || (l.email ? BP.companyIdForEmail(l.email) : '') || ''),
      vendorName: clip(l.companyName || l.vendorName, 120),
      recruiterEmail: lc(l.recruiterEmail || l.email),
      role,
      roleFamily: l.roleFamily || BP.roleFamily({ requirement: role, technologies: l.technologies || '', notes: l.notes || '' }),
      skills,
      location: clip(l.location, 120),
      endClient: clip(l.endClient, 60),
      jobId: clip(l.jobId, 24),
      rate: l.rate && typeof l.rate === 'object' ? l.rate : null
    };
  }

  let idCounter = 0;
  function newId(ms) {
    idCounter = (idCounter + 1) % 1679616;
    return 'sub_' + ms.toString(36) + BP.randomIdPart(8) + idCounter.toString(36);   // lib/shared.js
  }

  // The P2 fields of a record or an edit, checked the same way on create and on update (RTR dates in order, pay never above bill).
  function rateFieldsError(f) {
    const on = cleanDay(f.rtrOn), until = cleanDay(f.rtrUntil);
    if (on && until && until < on) return 'The RTR end date is before the day it was given. Check the dates.';
    const bill = cleanRate(f.billRate), pay = cleanRate(f.payRate);
    if (bill !== null && pay !== null && pay > bill) return 'The pay rate is above the bill rate. Raise the bill rate or lower the pay rate.';
    return '';
  }

  // input: the snapshot fields above plus consultantId, consultantName, rateAsked, visa, matchPercent, rtrOn, rtrUntil, rtrRate,
  // rtrRequestedOn, rtrNote, billRate, payRate, rateUnit, taxTerms, chain, endClientSource ('post'|'user'), overrideReason, guardLevel,
  // mailTo, source, status, submittedAt, followUpDate.
  function createSubmission(input, opts) {
    const o = opts || {};
    const i = input || {};
    const consultantId = clip(i.consultantId, 80);
    if (!consultantId) return { ok: false, error: 'Choose a consultant for this submission.' };
    const role = clip(i.role || i.requirement, 120);
    const leadEmail = lc(i.leadEmail || i.email);
    if (!role && !leadEmail && !clip(i.vendorName, 120)) return { ok: false, error: 'This submission needs a role, a vendor or a recruiter email.' };
    const bad = rateFieldsError({ ...i, billRate: i.billRate !== undefined && i.billRate !== null && i.billRate !== '' ? i.billRate : i.rateAsked });
    if (bad) return { ok: false, error: bad };

    const nowMs = Number.isFinite(toMs(o.now)) ? toMs(o.now) : Date.now();
    let submittedMs = toMs(i.submittedAt);
    if (!Number.isFinite(submittedMs)) submittedMs = nowMs;
    const status = normalizeStatus(i.status) || 'Submitted';
    const source = SOURCES.includes(i.source) ? i.source : 'logged';
    const snap = requirementSnapshot({ ...i, requirement: role, email: leadEmail });
    const guardLevel = GUARD_LEVELS.includes(i.guardLevel) ? i.guardLevel : 'none';
    const sub = {
      id: clip(o.id || i.id, 80) || newId(nowMs),
      consultantId,
      consultantName: clip(i.consultantName, 120),
      leadEmail: snap.leadEmail,
      postKey: snap.postKey,
      companyId: snap.companyId,
      vendorName: snap.vendorName,
      recruiterEmail: lc(i.recruiterEmail) || snap.leadEmail,
      role: snap.role,
      roleFamily: snap.roleFamily,
      skills: Array.isArray(i.skills) ? i.skills.filter(s => typeof s === 'string').map(s => clip(s, 40)).slice(0, 12) : snap.skills,
      location: snap.location,
      endClient: snap.endClient,
      endClientSource: snap.endClient ? (i.endClientSource === 'user' ? 'user' : 'post') : '',
      jobId: snap.jobId,
      rate: snap.rate,
      rateAsked: clip(i.rateAsked, 40) || rateText(i.billRate, i.rateUnit),
      visa: clip(i.visa, 40),
      matchPercent: Math.max(0, Math.min(100, Math.round(Number(i.matchPercent) || 0))),
      // P2 (storage schema 15): the RTR is a date (signed on), an optional end date and the agreed rate; it replaced the old tick box.
      rtrOn: cleanDay(i.rtrOn),
      rtrUntil: cleanDay(i.rtrOn) ? cleanDay(i.rtrUntil) : '',
      rtrRate: cleanDay(i.rtrOn) ? cleanRate(i.rtrRate) : null,
      rtrRequestedOn: cleanDay(i.rtrRequestedOn),
      rtrNote: clip(i.rtrNote, 300),
      // Bill rate (to the vendor), pay rate (to the consultant), their unit and tax terms, and the vendor chain to the end client.
      billRate: cleanRate(i.billRate !== undefined && i.billRate !== null && i.billRate !== '' ? i.billRate : i.rateAsked),
      payRate: cleanRate(i.payRate),
      rateUnit: cleanUnit(i.rateUnit),
      taxTerms: cleanTerms(i.taxTerms),
      chain: cleanChain(i.chain),
      // P3 (storage schema 18; lib/placements.js): interviews and the placement are added later, from the board or the detail panel.
      interviews: [],
      placement: null,
      overrideReason: clip(i.overrideReason, 300),
      guardLevel,
      status,
      history: [{ at: isoOf(submittedMs), status, note: clip(i.historyNote, 200) }],
      followUpDate: '',
      submittedAt: isoOf(submittedMs),
      updatedAt: isoOf(nowMs),
      mailTo: lc(i.mailTo || snap.recruiterEmail),
      source,
      seeded: source === 'seeded'
    };
    const fu = /^\d{4}-\d{2}-\d{2}$/.test(String(i.followUpDate || ''))
      ? String(i.followUpDate)
      : nextFollowUp(sub, { followUpDays: o.followUpDays, today: BP.dayKeyOf(nowMs, o.tz) });
    sub.followUpDate = isClosedStatus(status) ? '' : fu;
    // v1.19: the drawer opens an email draft; BenchPilot cannot know it was sent. The record waits as a draft (still counted by
    // the duplicate guard and the match pool) and its follow-up starts only when the user marks it as sent.
    if (i.draft === true && !isClosedStatus(status)) { sub.draft = true; sub.followUpDate = ''; }
    return { ok: true, submission: sub };
  }

  const isDraft = (sub) => Boolean(sub && sub.draft === true && !isClosedStatus(sub.status));

  // "Mark as sent": a draft becomes a sent submission, with its follow-up counted from today. Not a draft: nothing changes.
  function markSent(sub, opts) {
    const o = opts || {};
    if (!sub || typeof sub !== 'object') return { ok: false, error: 'Submission not found.' };
    if (sub.draft !== true) return { ok: true, submission: sub, changed: false };
    const nowMs = Number.isFinite(toMs(o.now)) ? toMs(o.now) : Date.now();
    const out = { ...sub, sentAt: isoOf(nowMs), updatedAt: isoOf(nowMs) };
    delete out.draft;
    out.history = (Array.isArray(sub.history) ? sub.history : []).concat([{ at: isoOf(nowMs), status: sub.status, note: 'Marked as sent' }]).slice(-MAX_HISTORY);
    out.followUpDate = isClosedStatus(out.status) ? '' : nextFollowUp(out, { followUpDays: o.followUpDays, today: BP.dayKeyOf(nowMs, o.tz) });
    return { ok: true, submission: out, changed: true };
  }

  // Follow-up date for a submission. snooze '1d' | '3d' | '1w' counts from `today`; otherwise `followUpDays`
  // (default 3) after `today`. Rejected / Closed have none.
  function nextFollowUp(sub, opts) {
    const o = opts || {};
    if (sub && isClosedStatus(sub.status)) return '';
    const today = /^\d{4}-\d{2}-\d{2}$/.test(String(o.today || '')) ? o.today : BP.dayKeyOf(Date.now(), o.tz);
    const days = o.snooze !== undefined && SNOOZE_DAYS[o.snooze] ? SNOOZE_DAYS[o.snooze] : Math.max(1, Math.min(60, Math.round(Number(o.followUpDays) || 3)));
    return addDaysStr(today, days);
  }

  // Moves a submission to a new status: adds a history line, clears the follow-up on Rejected / Closed.
  function updateStatus(sub, status, opts) {
    const o = opts || {};
    const next = normalizeStatus(status);
    if (!sub || typeof sub !== 'object') return { ok: false, error: 'Submission not found.' };
    if (!next) return { ok: false, error: 'Unknown status.' };
    const nowMs = Number.isFinite(toMs(o.now)) ? toMs(o.now) : Date.now();
    const note = clip(o.note, 200);
    if (next === sub.status && !note) return { ok: true, submission: sub, changed: false };
    const history = (Array.isArray(sub.history) ? sub.history : []).concat([{ at: isoOf(nowMs), status: next, note }]).slice(-MAX_HISTORY);
    const out = { ...sub, status: next, history, updatedAt: isoOf(nowMs) };
    if (isClosedStatus(next)) out.followUpDate = '';
    // A vendor reply, an interview or an offer means the draft did go out (v1.19).
    if (sub.draft === true && next !== 'Submitted' && !isClosedStatus(next)) { delete out.draft; out.sentAt = out.sentAt || isoOf(nowMs); }
    return { ok: true, submission: out, changed: next !== sub.status };
  }

  // ── The guard ──────────────────────────────────────────────────────────────
  // newReq: { endClient, jobId, companyId, vendorName, role|requirement, roleFamily?, skills|technologies, location, state?, sample? }
  // Returns { level: 'none'|'soft'|'hard', matches: [...], message, endClientKnown, overrideNeeded }
  //   HARD  same consultant and same end client within 90 days, or same consultant and same job id within 180 days
  //   SOFT  same consultant, same vendor and a similar role within 30 days; or the end client is unknown and the same
  //         consultant went to the same role family in the same state within 30 days
  // An unknown end client is never HARD. Seeded records (old pitch history) are only ever SOFT. Samples never count.
  function checkDuplicate(newReq, consultantId, submissions, now, opts) {
    const none = { level: 'none', matches: [], message: '', endClientKnown: false, overrideNeeded: false };
    const req = newReq || {};
    const cid = String(consultantId || '');
    if (!cid || req.sample === true || !Array.isArray(submissions) || !submissions.length) {
      return { ...none, endClientKnown: Boolean(clientKey(req.endClient)) };
    }
    const nowMs = Number.isFinite(toMs(now)) ? toMs(now) : Date.now();
    const tz = (opts && opts.tz) || IST;
    const clientNew = clientKey(req.endClient);
    const jobNew = jobIdKey(req.jobId);
    const stateNew = stateOf(req);
    const matches = [];

    for (const s of submissions) {
      if (!s || s.consultantId !== cid || s.sample === true) continue;
      const at = toMs(s.submittedAt || s.createdAt);
      if (!Number.isFinite(at)) continue;
      const days = Math.abs(nowMs - at) / DAY;
      if (days > HARD_JOBID_DAYS) continue;
      const seeded = s.seeded === true || s.source === 'seeded';
      const found = [];

      // Same end client within 90 days.
      const clientOld = clientKey(s.endClient);
      if (clientNew && clientOld && days <= HARD_CLIENT_DAYS) {
        if (clientNew === clientOld) found.push({ rule: 'endClient', level: seeded ? 'soft' : 'hard' });
        else if (fuzzyClientMatch(clientNew, clientOld)) found.push({ rule: 'similarClient', level: 'soft' });
      }
      // Same job id within 180 days (only with a known end client: an unknown client is never HARD).
      if (jobNew && jobIdKey(s.jobId) === jobNew) {
        found.push({ rule: 'jobId', level: seeded || !clientNew ? 'soft' : 'hard' });
      }
      if (days <= SOFT_DAYS) {
        if (sameVendor(req, s) && similarRole(req, s)) found.push({ rule: 'vendorRole', level: 'soft' });
        else if (!clientNew && stateNew && stateOf(s) === stateNew && sameFamily(req, s)) found.push({ rule: 'unknownClientRole', level: 'soft' });
      }
      if (!found.length) continue;
      const top = found.find(f => f.level === 'hard') || found[0];
      matches.push({
        id: s.id, rule: top.rule, level: top.level, rules: found.map(f => f.rule),
        submittedAt: s.submittedAt || s.createdAt, daysAgo: Math.floor(days), status: s.status || 'Submitted',
        consultantName: s.consultantName || '', vendorName: s.vendorName || s.companyId || '', endClient: s.endClient || '',
        role: s.role || '', jobId: s.jobId || '', seeded
      });
    }
    if (!matches.length) return { ...none, endClientKnown: Boolean(clientNew) };

    matches.sort((a, b) => (a.level === b.level ? 0 : a.level === 'hard' ? -1 : 1) || a.daysAgo - b.daysAgo);
    const level = matches[0].level;
    const m = matches[0];
    const who = (m.consultantName || 'This consultant').split(/\s+/)[0];
    const when = shortDate(toMs(m.submittedAt), tz);
    const vendor = m.vendorName || 'another vendor';
    let message;
    if (level === 'hard') {
      const to = m.endClient ? `${m.endClient} via ${vendor}` : vendor;
      message = m.rule === 'jobId'
        ? `Already submitted. ${who} went to job ${m.jobId} via ${vendor} on ${when} (status: ${m.status}). Submitting again through another vendor can get both rejected.`
        : `Already submitted. ${who} went to ${to} on ${when} (status: ${m.status}). Submitting again through another vendor can get both rejected.`;
    } else if (m.rule === 'similarClient') {
      message = `Possible repeat. ${who} went to ${m.endClient} (similar to this client) via ${vendor} on ${when}. Check this is a different job.`;
    } else if (m.rule === 'jobId') {
      message = `Possible repeat. ${who} was sent to job ${m.jobId} via ${vendor} on ${when}. Check this is a different job.`;
    } else {
      const role = m.role ? ` for a ${m.role} role` : '';
      message = `Possible repeat. ${who} was sent to ${vendor}${role} on ${when}. Check this is a different job.`;
    }
    if (!clientNew && level === 'soft') message += " The client isn't named in this post, so I can only compare the vendor and role.";
    // One line for the closed card, after "Already submitted" / "Possible repeat" (the full message is in the open card
    // and the draft sheet). No name: the button under it names the consultant, and first names can clash.
    const short = level === 'hard'
      ? (m.rule === 'jobId' ? `to job ${m.jobId} via ${vendor} on ${when}` : `to ${m.endClient ? m.endClient + ' via ' + vendor : vendor} on ${when}`)
      : `sent to ${vendor} on ${when}`;
    return { level, matches, message, short, endClientKnown: Boolean(clientNew), overrideNeeded: level === 'hard' };
  }

  // A HARD match can be overridden only with a typed reason of 8+ characters (spec 6.2).
  function overrideReasonOk(reason) { return clip(reason, 300).length >= MIN_OVERRIDE_REASON; }

  // ── Submit sheet helpers (pure: the drawer and the tests share them) ─────────────────────────────
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function followUpLabel(dayKey) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
    if (!m) return '';
    const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return `${WEEKDAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MON[t.getUTCMonth()]}`;
  }

  const money = (n) => '$' + (Math.round(n * 100) / 100).toString();
  // Margin hint under the rate boxes. ask: the bill rate the user will quote (number or text); payRate: what the consultant is paid
  // (number; falls back to consultantRate, the consultant's own rate as text); postedRate: the rate in the post, when there is one.
  // The margin is submissionMargin (the rate calculator's formula with the tax terms), so the hint, the board and the reports agree.
  // rateMin / rateUnit: the consultant's minimum (staffing P1). Asking less shows a soft warning first; nothing is blocked.
  function rateHint(o) {
    const i = o || {};
    const ask = cleanRate(i.ask);
    const pay = cleanRate(i.payRate !== undefined && i.payRate !== null && i.payRate !== '' ? i.payRate : BP.parseRate(i.consultantRate));
    const posted = typeof i.postedRate === 'number' ? i.postedRate : BP.parseRate(i.postedRate);
    const first = clip(i.name, 60).split(/\s+/)[0] || 'the consultant';
    const lines = [];
    if (ask === null) {
      if (posted) lines.push({ text: `The post offers about ${money(posted)}/h.`, tone: 'muted' });
      return { lines };
    }
    const below = BP.belowRateMin ? BP.belowRateMin(ask, { rateMin: i.rateMin, rateUnit: i.rateUnit }) : null;
    if (below) lines.push({ text: `Below ${first}'s minimum of ${money(below.min)}/h${BP.normalizeRateUnit(i.rateUnit) === 'hr' ? '' : ' (' + BP.rateMinText({ rateMin: i.rateMin, rateUnit: i.rateUnit }) + ')'}. Check with ${first} before you send.`, tone: 'warn' });
    if (pay !== null) {
      const m = submissionMargin({ billRate: ask, payRate: pay, taxTerms: i.taxTerms });
      if (m.margin > 0) lines.push({ text: `Your margin is about ${money(m.margin)}/h (${m.marginPct}%), ${money(m.monthly)} a month at 160 hours.`, tone: 'ok' });
      else if (m.margin === 0) lines.push({ text: `Same as ${first}'s rate of ${money(pay)}/h, so no margin.`, tone: 'muted' });
      else lines.push({ text: `Below ${first}'s rate of ${money(pay)}/h. You would lose ${money(-m.margin)}/h.`, tone: 'warn' });
    }
    if (posted) {
      lines.push(ask > posted
        ? { text: `Vendor pays ${money(posted)}/h, you ask ${money(ask)}/h. That is above the posted rate.`, tone: 'warn' }
        : { text: `Vendor pays ${money(posted)}/h, you ask ${money(ask)}/h.`, tone: 'muted' });
    }
    return { lines };
  }

  // Subject and body from the user's template (BP.fillTemplate with the consultant and the requirement), the asked rate in
  // place of the consultant's own, and one Right to Represent line when the RTR date is given. Unknown placeholders are left blank.
  function fillSubmitEmail(o) {
    const i = o || {};
    const tpl = i.template || {};
    const askNum = cleanRate(i.ask);
    const c = { ...(i.consultant || {}) };
    if (clip(i.ask, 40)) c.rate = askNum !== null ? `${money(askNum)}/hr ${cleanTerms(i.taxTerms) || 'C2C'}` : clip(i.ask, 40);
    const lead = i.lead || {};
    const subject = BP.fillTemplate(tpl.subject, lead, i.senderName, c).replace(/\{\w+\}/g, '').replace(/\s+/g, ' ').replace(/\s*[-|,]\s*$/, '').trim();
    // A line like "Experience:" with nothing after it (the consultant has no value for it) is dropped, not sent blank.
    let body = BP.fillTemplate(tpl.body, lead, i.senderName, c).replace(/\{\w+\}/g, '').replace(/^[A-Za-z][A-Za-z ]{0,24}:[ \t]*\n/gm, '').replace(/\n{3,}/g, '\n\n');
    const on = cleanDay(i.rtrOn);
    if (on) {
      const until = cleanDay(i.rtrUntil);
      const note = clip(i.rtrNote, 200);
      const line = `Right to Represent: received on ${dayLabel(on)}` + (until && until >= on ? `, valid until ${dayLabel(until)}` : '') + (note ? ` (${note})` : '');
      const lines = body.split('\n');
      let at = -1;
      lines.forEach((l, k) => { if (/^(availability|rate|visa|location)\s*:/i.test(l.trim())) at = k; });
      if (at >= 0) { lines.splice(at + 1, 0, line); body = lines.join('\n'); }
      else body = body.replace(/\s+$/, '') + '\n\n' + line;
    }
    return { subject, body };
  }

  // May the Gmail / Outlook buttons work yet? A HARD match needs "Submit anyway" chosen and a typed reason of 8+ characters;
  // the RTR date must be given (it replaced the old tick box); there must be an address for the draft. A SOFT duplicate warning
  // never blocks, and neither do the rate warnings (`warnings`: rateChecks, e.g. "rate differs from the RTR rate: get a new RTR").
  function composeGate(o) {
    const i = o || {};
    const warnings = rateChecks(i);
    if (i.level === 'hard') {
      if (i.override !== true) return { ok: false, why: 'duplicate', warnings };
      if (!overrideReasonOk(i.reason)) return { ok: false, why: 'reason', warnings };
    }
    if (!cleanDay(i.rtrOn)) return { ok: false, why: 'rtr', warnings };
    if (i.to !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(i.to || '').trim())) return { ok: false, why: 'to', warnings };
    return { ok: true, why: '', warnings };
  }

  // Edit the RTR, the rates, the terms or the chain of a saved record (dashboard, web app My book). Same checks as createSubmission.
  // A record still carrying the old tick box gets its RTR date from it first, so an edit never loses the RTR.
  const RATE_PATCH_KEYS = ['rtrOn', 'rtrUntil', 'rtrRate', 'rtrRequestedOn', 'billRate', 'payRate', 'rateUnit', 'taxTerms', 'chain'];
  function updateRates(sub, patch, opts) {
    const o = opts || {};
    if (!sub || typeof sub !== 'object') return { ok: false, error: 'Submission not found.' };
    const p = patch && typeof patch === 'object' ? patch : {};
    if (!RATE_PATCH_KEYS.some(k => p[k] !== undefined)) return { ok: true, submission: sub, changed: false };
    const next = { ...sub };
    if (next.rtrConfirmed !== undefined) { next.rtrOn = rtrOf(sub).on; delete next.rtrConfirmed; }
    if (p.rtrOn !== undefined) next.rtrOn = cleanDay(p.rtrOn);
    if (p.rtrUntil !== undefined) next.rtrUntil = cleanDay(p.rtrUntil);
    if (p.rtrRate !== undefined) next.rtrRate = cleanRate(p.rtrRate);
    if (p.rtrRequestedOn !== undefined) next.rtrRequestedOn = cleanDay(p.rtrRequestedOn);
    if (p.rateUnit !== undefined) next.rateUnit = cleanUnit(p.rateUnit);
    if (p.billRate !== undefined) next.billRate = cleanRate(p.billRate);
    if (p.payRate !== undefined) next.payRate = cleanRate(p.payRate);
    if (p.taxTerms !== undefined) next.taxTerms = cleanTerms(p.taxTerms);
    if (p.chain !== undefined) next.chain = cleanChain(p.chain);
    if (!next.rtrOn) { next.rtrUntil = ''; next.rtrRate = null; }
    // The shown rate text follows the bill rate when that (or its unit) really changed; an untouched old text ("DOE") stays.
    if (next.billRate !== (sub.billRate === undefined ? null : sub.billRate) || (p.rateUnit !== undefined && next.rateUnit !== sub.rateUnit)) next.rateAsked = rateText(next.billRate, next.rateUnit);
    const bad = rateFieldsError(next);
    if (bad) return { ok: false, error: bad };
    const nowMs = Number.isFinite(toMs(o.now)) ? toMs(o.now) : Date.now();
    next.updatedAt = isoOf(nowMs);
    return { ok: true, submission: next, changed: true };
  }

  // Undo (spec 5.7: 30 seconds on screen; the worker allows 60). entry: what the worker remembered when it saved the record
  // ({ tabId, at }); sub: the saved record. Only an untouched, drawer-made record can be removed, and only by the tab that made it.
  function undoAllowed(sub, entry, ctx) {
    const c = ctx || {};
    const windowMs = c.windowMs || 60000;
    const now = Number.isFinite(toMs(c.now)) ? toMs(c.now) : Date.now();
    if (!sub || !entry) return { ok: false, error: 'This submission can no longer be undone.' };
    if (now - entry.at > windowMs || now < entry.at) return { ok: false, error: 'The undo time has passed.' };
    if (sub.source !== 'logged' || sub.status !== 'Submitted' || (Array.isArray(sub.history) && sub.history.length > 1)) return { ok: false, error: 'This submission has changed, so it cannot be undone.' };
    if (!c.fromPage && (entry.tabId === null || entry.tabId === undefined || entry.tabId !== c.tabId)) return { ok: false, error: 'Undo is only available in the tab that sent it.' };
    return { ok: true, error: '' };
  }

  // ── Size cap ───────────────────────────────────────────────────────────────
  // Over the cap, the oldest Closed / Rejected records shrink to what the guard needs (nothing is deleted). When that
  // is not enough, `over` is true and the caller tells the user instead of dropping records.
  function compactOne(s) {
    return { id: s.id, consultantId: s.consultantId, consultantName: s.consultantName, leadEmail: s.leadEmail, companyId: s.companyId,
      vendorName: s.vendorName, recruiterEmail: s.recruiterEmail, role: s.role, roleFamily: s.roleFamily, skills: s.skills, location: s.location,
      endClient: s.endClient, endClientSource: s.endClientSource, jobId: s.jobId, status: s.status, submittedAt: s.submittedAt,
      updatedAt: s.updatedAt, followUpDate: '', source: s.source, seeded: s.seeded === true, compacted: true, history: [] };
  }
  function compactSubmissions(list, cap) {
    const max = cap || MAX_SUBMISSIONS;
    const all = Array.isArray(list) ? list : [];
    const full = all.filter(s => s && !s.compacted).length;
    if (full <= max) return { list: all, compacted: 0, over: all.length > MAX_TOTAL };
    const out = all.slice();
    const order = out.map((s, i) => i).filter(i => out[i] && isClosedStatus(out[i].status) && !out[i].compacted)
      .sort((x, y) => (toMs(out[x].submittedAt) || 0) - (toMs(out[y].submittedAt) || 0));
    let compacted = 0;
    let excess = full - max;
    for (const i of order) {
      if (excess <= 0) break;
      out[i] = compactOne(out[i]);
      compacted++;
      excess--;
    }
    return { list: out, compacted, over: excess > 0 || out.length > MAX_TOTAL };
  }

  // ── Migration seed (spec section 7): old pitch history becomes SOFT-only records ──
  // state: { allLeads, companies, consultants, submissions }. Leads with lastPitchedConsultant become 'seeded' submissions.
  // Idempotent: a seeded id already present is not added twice. Copes with missing activity, empty names, deleted consultants.
  function seedSubmissionsFromPitches(state, now) {
    const s = state || {};
    const nowMs = Number.isFinite(toMs(now)) ? toMs(now) : Date.now();
    const leads = Array.isArray(s.allLeads) ? s.allLeads : [];
    const consultants = Array.isArray(s.consultants) ? s.consultants : [];
    const companies = Array.isArray(s.companies) ? s.companies : [];
    const have = new Set((Array.isArray(s.submissions) ? s.submissions : []).map(x => x && x.id));
    const out = [];
    for (const l of leads) {
      if (!l || typeof l !== 'object') continue;
      const name = clip(l.lastPitchedConsultant, 120);
      if (!name) continue;
      const email = lc(l.email);
      const id = 'seed_' + (email || 'noemail') + '|' + name.toLowerCase().replace(/\s+/g, ' ');
      if (have.has(id)) continue;
      have.add(id);

      const acts = Array.isArray(l.activity) ? l.activity.filter(a => a && a.type === 'pitch') : [];
      const named = acts.filter(a => String(a.text || '').trim().toLowerCase() === ('pitched ' + name).toLowerCase());
      const act = (named.length ? named : acts).slice(-1)[0];
      const candidates = [act && act.at, l.lastContactDate && /^\d{4}-\d{2}-\d{2}$/.test(l.lastContactDate) ? l.lastContactDate + 'T00:00:00.000Z' : '', l.savedAt, l.extractedAt];
      let at = NaN;
      for (const c of candidates) { const t = toMs(c); if (Number.isFinite(t) && t <= nowMs + DAY) { at = t; break; } }
      if (!Number.isFinite(at)) at = nowMs;

      const consultant = consultants.find(c => c && lc(c.name) === name.toLowerCase());
      const company = companies.find(c => c && c.id === l.companyId);
      const res = createSubmission({
        id,
        consultantId: consultant ? consultant.id : 'deleted:' + name.toLowerCase().replace(/\s+/g, '-').slice(0, 60),
        consultantName: consultant ? consultant.name : name,
        leadEmail: email, companyId: l.companyId || '', vendorName: (company && company.name) || l.companyName || '',
        recruiterEmail: email, role: l.requirement, technologies: l.technologies, location: l.location, notes: l.notes,
        endClient: l.endClient, jobId: l.jobId, source: 'seeded', status: 'Submitted', submittedAt: at,
        historyNote: 'Imported from pitch history', mailTo: email
      }, { now: nowMs });
      if (!res.ok) continue;
      res.submission.followUpDate = '';   // a seeded record never brings a follow-up back
      out.push(res.submission);
    }
    return out;
  }

  Object.assign(BP, {
    Submissions: {
      STATUSES, CLOSED_STATUSES, SOURCES, GUARD_LEVELS, MAX_SUBMISSIONS, MAX_TOTAL, HARD_CLIENT_DAYS, HARD_JOBID_DAYS, SOFT_DAYS, MIN_OVERRIDE_REASON,
      normalizeStatus, isClosedStatus, normalizeClient, normalizeVendor, requirementSnapshot, createSubmission, updateStatus, nextFollowUp,
      checkDuplicate, overrideReasonOk, similarRole, compactSubmissions, seedSubmissionsFromPitches,
      rateHint, fillSubmitEmail, composeGate, undoAllowed, followUpLabel, markSent, isDraft,
      // P2
      RATE_UNITS, TAX_TERMS, RTR_STATES, MAX_CHAIN, RTR_TEMPLATE, RTR_PLACEHOLDERS, NOT_LEGAL_ADVICE, RATE_PATCH_KEYS,
      cleanRate, cleanDay, cleanChain, chainText, rateText, dayLabel, rtrOf, submissionMargin, rateChecks, fillRtrEmail, marginSummary,
      updateRates, rateFieldsError
    },
    seedSubmissionsFromPitches
  });
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
