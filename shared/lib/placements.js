// lib/placements.js - staffing P3 (docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md): interviews and placements on a submission.
// Pure functions only (no DOM, no chrome.*, no clock unless `now` is left out), like lib/submissions.js. One implementation for the
// extension (a submission record carries interviews[] and placement{}; storage schema 18) and the web app's team workspace (tables
// submission_interviews and placements, migration 0051; webapp/js/bp-lib.js loads this file), so both say and compute the same thing.
// Needs lib/shared.js, lib/today.js and lib/submissions.js loaded first.
//
// Interviews (round, date and time in a time zone, mode, panel, feedback, outcome):
//   BP.Placements.zonedToUtc('2026-11-16T10:30', 'America/New_York') -> ms (NaN when not a real time)
//   BP.Placements.utcToZoned(ms, tz) -> 'YYYY-MM-DDTHH:MM'          zoneAbbr(ms, tz) -> 'EST' | 'IST' | 'GMT+4'
//   BP.Placements.interviewTimeText(at, viewerTz, { today, withZone }) -> 'Mon 16 Nov, 10:30 EST' | 'Today, 21:00 IST'
//   BP.Placements.cleanInterview(input, { now, id, existing }) -> { ok, interview } | { ok:false, error }
//   BP.Placements.upsertInterview(list, input, opts) -> { ok, interviews, interview }   removeInterview(list, id) -> list
//   BP.Placements.upcomingInterviews(items, { now, tz, days }) -> today and the next `days - 1` days, soonest first
//   BP.Placements.buildIcs({ uid, startMs, minutes, summary, description, location, stampMs }) -> VCALENDAR text (RFC 5545, UTC times)
//   BP.Placements.interviewIcs({ interview, consultantName, role, endClient, vendorName, stampMs }) -> { filename, text }
//   BP.Placements.calendarLinks({ interview, consultantName, role, endClient, vendorName }) -> { google, outlook }   "Add to Google Calendar" /
//                    "Add to Outlook" template links (the same event as the .ics; no calendar API, no OAuth scope)
// Placements (start, end, bill and pay rate, PO, status) and the money:
//   BP.Placements.cleanPlacement(input, { today, before }) -> { ok, placement } | { ok:false, error }
//   BP.Placements.placementStatus(p, today) -> 'upcoming' | 'active' | 'ended' | 'fell_through'   (the dates decide unless ended / fell through by hand)
//   BP.Placements.placementMargin(p) -> BP.Submissions.submissionMargin (the rate calculator's formula: one function, E and W)
//   BP.Placements.monthMargin(placements, 'YYYY-MM') -> { total, counted, missing, rows }   gross margin estimate for a calendar month
//   BP.Placements.endingWithin(placements, today, days) / startingWithin(placements, today, days)
//   BP.Placements.netTermsOf(vendor) -> 15 | 30 | 45 | 60 | 90 (the vendor's net terms from P6 when recorded, else DEFAULT_NET_TERMS)
//   BP.Placements.expectedPaymentDate(invoiceDay, netTerms) -> 'YYYY-MM-DD'
//   BP.Placements.quickbooksRows(rows, { canPay }) -> [{ column: value }]   QB_HEADERS / QB_PAY_HEADERS: the CSV for an accounting tool
// On an extension submission record: withInterview(sub, input, opts) / withoutInterview(sub, id) / withPlacement(sub, input | null, opts)
//   -> { ok, submission } (the history gets a line; an interview moves Submitted / Vendor replied to Interview; a placement moves it to Placed)
// The funnel (submission -> interview -> offer -> placement):
//   BP.Placements.funnelStage({ status|stage, history, interviews, placement }) -> 'submitted' | 'interview' | 'offer' | 'placed'
//   BP.Placements.funnel(items) -> { submitted, interview, offer, placed, rates: { interview, offer, placed } }
// Staffing P4 (the web app's Reports):
//   BP.Placements.funnelBy(items, keyOf) -> [{ key, submitted, interview, offer, placed, rates }]   (funnel per group; keyOf null = left out)
//   BP.Placements.funnelByFamily(items) -> funnelBy(items, x => x.family) with the most submissions first and 'Other' last (each item
//     carries `family`: BP.submissionFamily; the funnel by skill family on Insights (E) and Reports (W))
//   BP.Placements.marginByRecruiter([{ recruiterId, placement }], 'YYYY-MM') -> [{ recruiterId, placements, counted, missing, margin }]
//   BP.Placements.marginCsvRows(list, month, nameOf) -> [{ column: value }]   MARGIN_HEADERS: "for your commission sheet" (not a calculator)

(function (root) {
  'use strict';
  if (!(root.BP && root.BP.tierOf) && typeof require === 'function') { require('./shared.js'); }
  if (!(root.BP && root.BP.dayKeyOf) && typeof require === 'function') { require('./today.js'); }
  if (!(root.BP && root.BP.Submissions) && typeof require === 'function') { require('./submissions.js'); }
  const BP = root.BP;
  const S = BP.Submissions;

  const DAY = 86400000;
  const MODES = ['phone', 'video', 'onsite'];
  const MODE_LABELS = { phone: 'Phone', video: 'Video', onsite: 'Onsite' };
  const OUTCOMES = ['pending', 'passed', 'failed', 'no_show'];
  const OUTCOME_LABELS = { pending: 'Pending', passed: 'Passed', failed: 'Not selected', no_show: 'No-show' };
  const STATUSES = ['upcoming', 'active', 'ended', 'fell_through'];
  const STATUS_LABELS = { upcoming: 'Starting soon', active: 'Active', ended: 'Ended', fell_through: 'Fell through' };
  const MAX_INTERVIEWS = 20;
  const MAX_ROUND = 10;
  const WITH_MAX = 120;
  const FEEDBACK_MAX = 1000;
  const PO_MAX = 100;
  const INTERVIEW_MINUTES = 60;
  const NET_TERMS = [15, 30, 45, 60, 90];
  const DEFAULT_NET_TERMS = 30;
  const HOURS_PER_DAY = 8;
  // The zones a bench desk books interviews in, first; the person's own zone is added by the screens when it is not here.
  const ZONES = [
    ['America/New_York', 'Eastern (ET)'], ['America/Chicago', 'Central (CT)'], ['America/Denver', 'Mountain (MT)'],
    ['America/Phoenix', 'Arizona (MST)'], ['America/Los_Angeles', 'Pacific (PT)'], ['Asia/Kolkata', 'India (IST)'], ['UTC', 'UTC']
  ];
  const IST = 'Asia/Kolkata';

  const pad2 = (n) => String(n).padStart(2, '0');
  const clip = (v, max) => (v === null || v === undefined ? '' : String(v).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max));
  const oneLine = (v, max) => clip(v, max).replace(/\s+/g, ' ');
  const plain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  function toMs(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string' && v) return Date.parse(v);
    return NaN;
  }
  const dayNum = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; };
  const dayOfNum = (n) => { const t = new Date(n * DAY); return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`; };
  const addDays = (k, n) => dayOfNum(dayNum(k) + n);
  const todayOf = (today) => S.cleanDay(today) || BP.dayKeyOf(Date.now(), IST);

  // ── Time zones (Intl only: every browser and Node have it) ──
  const fmtCache = {};
  function validZone(tz) {
    if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
  }
  function viewerZone() {
    try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; return validZone(z) ? z : IST; } catch (_) { return IST; }
  }
  function partsIn(ms, tz) {
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short'
    }));
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = p.value;
    return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute), s: Number(o.second), wd: o.weekday };
  }
  function offsetMs(ms, tz) {
    const p = partsIn(ms, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  }
  // A wall-clock time in a zone -> the instant. A time that does not exist (the hour skipped when clocks go forward) is refused.
  function zonedToUtc(local, tz) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(local || '').trim());
    if (!m || !validZone(tz)) return NaN;
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    if (h > 23 || mi > 59 || !S.cleanDay(`${m[1]}-${m[2]}-${m[3]}`)) return NaN;
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    let ms = guess - offsetMs(guess, tz);
    ms = guess - offsetMs(ms, tz);
    return utcToZoned(ms, tz) === `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` ? ms : NaN;
  }
  function utcToZoned(ms, tz) {
    if (!Number.isFinite(ms) || !validZone(tz)) return '';
    const p = partsIn(ms, tz);
    return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}`;
  }
  const ABBR = { 'Asia/Kolkata': 'IST', 'Asia/Calcutta': 'IST', UTC: 'UTC', 'Etc/UTC': 'UTC' };
  function zoneAbbr(ms, tz) {
    if (ABBR[tz]) return ABBR[tz];
    if (!validZone(tz)) return '';
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(Number.isFinite(ms) ? ms : Date.now()));
      const n = p.find(x => x.type === 'timeZoneName');
      return n ? n.value : '';
    } catch (_) { return ''; }
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // "Mon 16 Nov, 10:30 EST", or "Today, 21:00 IST" / "Tomorrow, ..." when `today` (the viewer's day) is given.
  function interviewTimeText(at, tz, opts) {
    const o = opts || {};
    const ms = toMs(at);
    const zone = validZone(tz) ? tz : viewerZone();
    if (!Number.isFinite(ms)) return '';
    const p = partsIn(ms, zone);
    const day = `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
    const t = S.cleanDay(o.today);
    const when = t && day === t ? 'Today' : t && day === addDays(t, 1) ? 'Tomorrow' : `${p.wd} ${p.d} ${MON[p.mo - 1]}${t && day.slice(0, 4) !== t.slice(0, 4) ? ' ' + p.y : ''}`;
    return `${when}, ${pad2(p.h)}:${pad2(p.mi)}` + (o.withZone === false ? '' : ' ' + zoneAbbr(ms, zone));
  }

  // ── Interviews ──
  let idCounter = 0;
  function newId(prefix, ms) {
    idCounter = (idCounter + 1) % 1679616;
    return prefix + ms.toString(36) + BP.randomIdPart(6) + idCounter.toString(36);
  }
  function nextRound(list) {
    let max = 0;
    for (const i of Array.isArray(list) ? list : []) if (i && Number(i.round) > max) max = Number(i.round);
    return Math.min(MAX_ROUND, max + 1);
  }
  // input: { id?, round, local ('YYYY-MM-DDTHH:MM' in tz) or at (an instant), tz, mode, withWhom, feedback, outcome }.
  function cleanInterview(input, opts) {
    const o = opts || {};
    const i = plain(input) ? input : {};
    const tz = validZone(i.tz) ? i.tz : viewerZone();
    let ms = i.local !== undefined && i.local !== '' ? zonedToUtc(i.local, tz) : toMs(i.at);
    if (!Number.isFinite(ms)) return { ok: false, error: 'Enter the interview date and time.' };
    ms = Math.round(ms / 60000) * 60000;
    if (ms < Date.UTC(2000, 0, 1) || ms > Date.UTC(2100, 0, 1)) return { ok: false, error: 'Enter the interview date and time.' };
    const round = Math.round(Number(i.round));
    if (i.round !== undefined && i.round !== '' && i.round !== null && !(round >= 1 && round <= MAX_ROUND)) return { ok: false, error: `The round is a number from 1 to ${MAX_ROUND}.` };
    const nowMs = Number.isFinite(toMs(o.now)) ? toMs(o.now) : Date.now();
    const before = plain(o.existing) ? o.existing : null;
    return {
      ok: true,
      interview: {
        id: clip(i.id || (before && before.id) || o.id, 80) || newId('int_', nowMs),
        round: round >= 1 && round <= MAX_ROUND ? round : nextRound(o.list),
        at: new Date(ms).toISOString(),
        tz,
        mode: MODES.includes(i.mode) ? i.mode : 'video',
        withWhom: oneLine(i.withWhom, WITH_MAX),
        feedback: clip(i.feedback, FEEDBACK_MAX),
        outcome: OUTCOMES.includes(i.outcome) ? i.outcome : 'pending',
        updatedAt: new Date(nowMs).toISOString()
      }
    };
  }
  // Add or replace (same id) one interview in a list, kept in time order. At most MAX_INTERVIEWS per submission.
  function upsertInterview(list, input, opts) {
    const cur = (Array.isArray(list) ? list : []).filter(plain);
    const id = plain(input) ? clip(input.id, 80) : '';
    const existing = id ? cur.find(x => x.id === id) : null;
    if (id && !existing) return { ok: false, error: 'That interview was not found. It may have been removed.' };
    if (!existing && cur.length >= MAX_INTERVIEWS) return { ok: false, error: `A submission keeps up to ${MAX_INTERVIEWS} interviews.` };
    const r = cleanInterview(input, { ...(opts || {}), existing, list: cur });
    if (!r.ok) return r;
    const out = cur.filter(x => x.id !== r.interview.id).concat([r.interview]).sort((a, b) => (toMs(a.at) || 0) - (toMs(b.at) || 0));
    return { ok: true, interviews: out, interview: r.interview };
  }
  function removeInterview(list, id) { return (Array.isArray(list) ? list : []).filter(x => plain(x) && x.id !== id); }
  // A stored list from an older or edited record: only well-formed interviews, in time order.
  function cleanInterviewList(list) {
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
      if (!plain(x) || out.length >= MAX_INTERVIEWS) continue;
      const r = cleanInterview({ ...x, local: undefined }, { now: x.updatedAt || x.at, id: x.id });
      if (r.ok) out.push({ ...r.interview, updatedAt: clip(x.updatedAt, 40) || r.interview.updatedAt });
    }
    return out.sort((a, b) => (toMs(a.at) || 0) - (toMs(b.at) || 0));
  }

  // items: [{ interview, ...anything the screen needs }]. Today and the next days - 1 days in the viewer's zone, soonest first. Interviews
  // already over by more than an hour, and ones with an outcome, are left out.
  function upcomingInterviews(items, opts) {
    const o = opts || {};
    const now = Number.isFinite(toMs(o.now)) ? toMs(o.now) : Date.now();
    const tz = validZone(o.tz) ? o.tz : viewerZone();
    const days = Math.max(1, Math.min(14, Math.round(Number(o.days) || 2)));
    const today = utcToZoned(now, tz).slice(0, 10);
    const last = addDays(today, days - 1);
    const out = [];
    for (const it of Array.isArray(items) ? items : []) {
      const iv = it && it.interview;
      const ms = iv ? toMs(iv.at) : NaN;
      if (!Number.isFinite(ms) || (iv.outcome && iv.outcome !== 'pending') || ms < now - 3600000) continue;
      const day = utcToZoned(ms, tz).slice(0, 10);
      if (day < today || day > last) continue;
      out.push({ ...it, day, ms, isToday: day === today });
    }
    return out.sort((a, b) => a.ms - b.ms);
  }

  // ── .ics (RFC 5545): a local file the person opens in Google Calendar, Outlook or Apple Calendar. No calendar API, no account. ──
  function icsText(v) { return String(v === null || v === undefined ? '' : v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  function icsStamp(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`; }
  // Lines longer than 75 octets are folded (CRLF + one space), never inside a UTF-8 character.
  function fold(line) {
    const enc = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length);
    if (enc(line) <= 75) return line;
    const out = [];
    let cur = '', size = 0, limit = 75;
    for (const ch of line) {
      const n = enc(ch);
      if (size + n > limit) { out.push(cur); cur = ''; size = 0; limit = 74; }
      cur += ch; size += n;
    }
    out.push(cur);
    return out.join('\r\n ');
  }
  function buildIcs(o) {
    const i = o || {};
    const start = toMs(i.startMs);
    if (!Number.isFinite(start)) return '';
    const minutes = Math.max(5, Math.min(600, Math.round(Number(i.minutes) || INTERVIEW_MINUTES)));
    const stamp = Number.isFinite(toMs(i.stampMs)) ? toMs(i.stampMs) : Date.now();
    const uid = String(i.uid || 'bp').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'bp';
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BenchPilot//Interviews//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid}@benchpilot.app`,
      `DTSTAMP:${icsStamp(stamp)}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(start + minutes * 60000)}`,
      `SUMMARY:${icsText(oneLine(i.summary, 200))}`
    ];
    if (i.description) lines.push(`DESCRIPTION:${icsText(clip(i.description, 1500))}`);
    if (i.location) lines.push(`LOCATION:${icsText(oneLine(i.location, 200))}`);
    lines.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Interview in 30 minutes', 'TRIGGER:-PT30M', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }
  // One interview as a calendar event: the same title, text and times for the .ics file and the "Add to Google Calendar / Outlook" links.
  // The feedback stays out (it is the firm's own note, not for a calendar). null when the time is missing.
  function interviewEvent(o) {
    const i = o || {};
    const iv = i.interview || {};
    const ms = toMs(iv.at);
    if (!Number.isFinite(ms)) return null;
    const who = oneLine(i.consultantName, 120) || 'Consultant';
    const role = oneLine(i.role, 120);
    const client = oneLine(i.endClient, 120);
    const round = Number(iv.round) >= 1 ? `round ${Number(iv.round)}` : '';
    const summary = `Interview: ${who}` + (role ? ` - ${role}` : '') + (client ? ` at ${client}` : '') + (round ? ` (${round})` : '');
    const tz = validZone(iv.tz) ? iv.tz : IST;
    const description = [
      `${who}` + (role ? `, ${role}` : '') + (client ? `, end client ${client}` : ''),
      i.vendorName ? `Through: ${oneLine(i.vendorName, 120)}` : '',
      iv.withWhom ? `With: ${oneLine(iv.withWhom, WITH_MAX)}` : '',
      `Mode: ${MODE_LABELS[iv.mode] || 'Video'}` + (round ? ` · ${round[0].toUpperCase()}${round.slice(1)}` : ''),
      `Time booked: ${interviewTimeText(ms, tz)}`,
      'Added from BenchPilot.'
    ].filter(Boolean).join('\n');
    const slug = (who + '-' + (client || role || 'interview')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'interview';
    return { uid: iv.id || 'int', startMs: ms, endMs: ms + INTERVIEW_MINUTES * 60000, summary, description, location: MODE_LABELS[iv.mode] || '',
      day: utcToZoned(ms, tz).slice(0, 10), slug };
  }
  // The interview as an .ics file.
  function interviewIcs(o) {
    const e = interviewEvent(o);
    if (!e) return null;
    return {
      filename: `interview-${e.slug}-${e.day}.ics`,
      text: buildIcs({ uid: e.uid, startMs: e.startMs, summary: e.summary, description: e.description, location: e.location, stampMs: (o || {}).stampMs })
    };
  }
  // "Add to Google Calendar" and "Add to Outlook": template links that open the person's own calendar with the event filled in, for
  // them to save. No calendar API, no OAuth scope, nothing sent by BenchPilot (the browser opens the calendar's own page). Times in UTC.
  //   calendarLinks({ interview, consultantName, role, endClient, vendorName }) -> { google, outlook } | null
  const GOOGLE_CALENDAR = 'https://calendar.google.com/calendar/render';
  const OUTLOOK_CALENDAR = 'https://outlook.office.com/calendar/deeplink/compose';
  function calendarLinks(o) {
    const e = interviewEvent(o);
    if (!e) return null;
    const q = (pairs) => pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const summary = oneLine(e.summary, 200);
    const details = clip(e.description, 1500);
    return {
      google: `${GOOGLE_CALENDAR}?` + q([['action', 'TEMPLATE'], ['text', summary], ['dates', `${icsStamp(e.startMs)}/${icsStamp(e.endMs)}`],
        ['details', details], ['location', e.location]]),
      outlook: `${OUTLOOK_CALENDAR}?` + q([['path', '/calendar/action/compose'], ['rru', 'addevent'], ['subject', summary],
        ['startdt', iso(e.startMs)], ['enddt', iso(e.endMs)], ['body', details], ['location', e.location]])
    };
  }

  // ── Placements ──
  // The dates decide the status (starts after today: upcoming; ended before today: ended; else active) unless the person marked it
  // ended early or fell through. The server's trigger (0051 bp_team_placement) and the morning report's roll use the same rule.
  function placementStatus(p, today) {
    const x = plain(p) ? p : {};
    if (x.status === 'fell_through' || x.status === 'ended') return x.status;
    const t = todayOf(today);
    const start = S.cleanDay(x.startOn), end = S.cleanDay(x.endOn);
    if (start && start > t) return 'upcoming';
    if (end && end < t) return 'ended';
    return 'active';
  }
  function placementError(p) {
    if (!S.cleanDay(p.startOn)) return 'Enter the start date.';
    if (p.endOn && p.endOn < p.startOn) return 'The end date is before the start date. Check the dates.';
    if (p.billRate !== null && p.payRate !== null && p.payRate > p.billRate) return 'The pay rate is above the bill rate. Raise the bill rate or lower the pay rate.';
    return '';
  }
  // input: { startOn, endOn, billRate, payRate, rateUnit, taxTerms, poRef, status }. `before`: the saved placement (an edit keeps what
  // is not in the input). An explicit status 'upcoming' / 'active' means "follow the dates".
  function cleanPlacement(input, opts) {
    const o = opts || {};
    const i = plain(input) ? input : {};
    const b = plain(o.before) ? o.before : {};
    const pick = (k) => (i[k] !== undefined ? i[k] : b[k]);
    for (const k of ['billRate', 'payRate']) {
      const v = i[k];
      if (v !== undefined && v !== null && v !== '' && S.cleanRate(v) === null) return { ok: false, error: 'Enter rates as numbers, for example 65.' };
    }
    if (i.endOn !== undefined && i.endOn !== '' && i.endOn !== null && !S.cleanDay(i.endOn)) return { ok: false, error: 'Enter the end date as a real date.' };
    const p = {
      startOn: S.cleanDay(pick('startOn')),
      endOn: S.cleanDay(pick('endOn')),
      billRate: S.cleanRate(pick('billRate')),
      payRate: S.cleanRate(pick('payRate')),
      rateUnit: S.RATE_UNITS.includes(pick('rateUnit')) ? pick('rateUnit') : 'hr',
      taxTerms: S.TAX_TERMS.includes(String(pick('taxTerms') || '').toUpperCase()) ? String(pick('taxTerms')).toUpperCase() : '',
      poRef: oneLine(pick('poRef'), PO_MAX),
      status: STATUSES.includes(pick('status')) ? pick('status') : 'active'
    };
    const bad = placementError(p);
    if (bad) return { ok: false, error: bad };
    if (p.status === 'upcoming' || p.status === 'active') p.status = 'active';
    p.status = placementStatus(p, o.today);
    const nowMs = Number.isFinite(toMs(o.now)) ? toMs(o.now) : Date.now();
    p.updatedAt = new Date(nowMs).toISOString();
    return { ok: true, placement: p };
  }
  // The placement's margin: the submission's own formula (the rate calculator's, W2 with its employer cost).
  function placementMargin(p) { return S.submissionMargin(p || {}); }

  // Monday to Friday between two days, both included.
  function weekdaysBetween(from, to) {
    const a = S.cleanDay(from), b = S.cleanDay(to);
    if (!a || !b || b < a) return 0;
    let n = 0;
    for (let d = dayNum(a), end = dayNum(b); d <= end; d++) { const wd = new Date(d * DAY).getUTCDay(); if (wd !== 0 && wd !== 6) n++; }
    return n;
  }
  // Gross margin estimate for a calendar month: each placement's margin times the working days (Mon-Fri, 8 hours) it runs in that month.
  // Hourly: margin x hours; daily: margin x days; monthly: the month's margin, prorated by working days; yearly: a twelfth, prorated.
  // Placements that fell through, or without both rates, are not counted (missing = how many lack a rate).
  function monthMargin(list, month) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
    if (!m) return { total: 0, counted: 0, missing: 0, rows: [] };
    const first = `${m[1]}-${m[2]}-01`;
    const last = addDays(`${Number(m[2]) === 12 ? Number(m[1]) + 1 : m[1]}-${pad2(Number(m[2]) === 12 ? 1 : Number(m[2]) + 1)}-01`, -1);
    const monthDays = weekdaysBetween(first, last);
    let total = 0, counted = 0, missing = 0;
    const rows = [];
    for (const p of Array.isArray(list) ? list : []) {
      if (!plain(p) || p.status === 'fell_through' || p.sample === true) continue;
      const start = S.cleanDay(p.startOn);
      if (!start || start > last) continue;
      const end = S.cleanDay(p.endOn);
      if (end && end < first) continue;
      const from = start > first ? start : first;
      const to = end && end < last ? end : last;
      const days = weekdaysBetween(from, to);
      const mg = placementMargin(p);
      if (!mg.valid) { missing++; continue; }
      const unit = mg.unit;
      const amount = unit === 'hr' ? mg.margin * days * HOURS_PER_DAY : unit === 'day' ? mg.margin * days
        : unit === 'month' ? mg.margin * (monthDays ? days / monthDays : 0) : mg.margin / 12 * (monthDays ? days / monthDays : 0);
      const r = Math.round(amount * 100) / 100;
      rows.push({ id: p.id || '', days, hours: unit === 'hr' ? days * HOURS_PER_DAY : null, amount: r });
      total += r; counted++;
    }
    return { total: Math.round(total * 100) / 100, counted, missing, rows };
  }
  // Running placements whose end date falls within `days` of today: these consultants come back to the bench. Soonest first.
  function endingWithin(list, today, days) {
    const t = todayOf(today);
    const last = addDays(t, Math.max(0, Math.round(Number(days) || 30)));
    return (Array.isArray(list) ? list : []).filter(p => plain(p) && placementStatus(p, t) !== 'fell_through' && p.status !== 'ended'
      && S.cleanDay(p.endOn) && p.endOn >= t && p.endOn <= last).sort((a, b) => (a.endOn < b.endOn ? -1 : a.endOn > b.endOn ? 1 : 0));
  }
  function startingWithin(list, today, days) {
    const t = todayOf(today);
    const last = addDays(t, Math.max(0, Math.round(Number(days) || 7)));
    return (Array.isArray(list) ? list : []).filter(p => plain(p) && p.status !== 'fell_through' && p.status !== 'ended'
      && S.cleanDay(p.startOn) && p.startOn >= t && p.startOn <= last).sort((a, b) => (a.startOn < b.startOn ? -1 : a.startOn > b.startOn ? 1 : 0));
  }
  // The vendor's payment terms (staffing P6 records them on the vendor as netTerms; the server column is net_terms). Default Net 30.
  function netTermsOf(vendor) {
    const v = plain(vendor) ? vendor : {};
    const n = Number(v.netTerms !== undefined && v.netTerms !== null ? v.netTerms : v.net_terms);
    return NET_TERMS.includes(n) ? n : DEFAULT_NET_TERMS;
  }
  function expectedPaymentDate(invoiceDay, netTerms) {
    const d = S.cleanDay(invoiceDay);
    if (!d) return '';
    const n = NET_TERMS.includes(Number(netTerms)) ? Number(netTerms) : DEFAULT_NET_TERMS;
    return addDays(d, n);
  }

  // ── On an extension submission record (storage schema 18: interviews[] and placement{}). The worker saves what these return. ──
  // An interview on a record still at Submitted / Vendor replied moves it to Interview (the funnel and the board agree with the record).
  const EARLY = ['Submitted', 'Vendor replied'];
  function withInterview(sub, input, opts) {
    const o = opts || {};
    if (!plain(sub)) return { ok: false, error: 'Submission not found.' };
    const isNew = !(plain(input) && input.id);
    const r = upsertInterview(sub.interviews, input, o);
    if (!r.ok) return r;
    let out = { ...sub, interviews: r.interviews };
    const note = (isNew ? 'Interview added' : 'Interview updated') + ` (round ${r.interview.round})`;
    const moved = S.updateStatus(out, EARLY.includes(out.status) ? 'Interview' : out.status, { note, now: o.now });
    if (moved.ok) out = moved.submission;
    return { ok: true, submission: out, interview: r.interview };
  }
  function withoutInterview(sub, id, opts) {
    if (!plain(sub)) return { ok: false, error: 'Submission not found.' };
    const list = Array.isArray(sub.interviews) ? sub.interviews : [];
    if (!list.some(x => plain(x) && x.id === id)) return { ok: false, error: 'That interview was not found. It may have been removed.' };
    const nowMs = Number.isFinite(toMs((opts || {}).now)) ? toMs(opts.now) : Date.now();
    return { ok: true, submission: { ...sub, interviews: removeInterview(list, id), updatedAt: new Date(nowMs).toISOString() } };
  }
  // input null: the placement is removed. Otherwise saved (an edit keeps what it does not change); the rates start from the submission's.
  // A placement that did not fall through moves the record to Placed.
  function withPlacement(sub, input, opts) {
    const o = opts || {};
    if (!plain(sub)) return { ok: false, error: 'Submission not found.' };
    const nowMs = Number.isFinite(toMs(o.now)) ? toMs(o.now) : Date.now();
    // Removing the placement takes its timesheet weeks with it; a placement with invoices stays (schema 21; 0055 invoices_placement_fk).
    if (input === null) {
      if (Array.isArray(sub.invoices) && sub.invoices.length) return { ok: false, error: 'This placement has invoices. Remove them first, or set the placement to Ended instead.' };
      return { ok: true, submission: { ...sub, placement: null, timesheets: [], updatedAt: new Date(nowMs).toISOString() } };
    }
    const before = plain(sub.placement) ? sub.placement : { billRate: sub.billRate, payRate: sub.payRate, rateUnit: sub.rateUnit, taxTerms: sub.taxTerms };
    const r = cleanPlacement(input, { ...o, before, now: nowMs });
    if (!r.ok) return r;
    let out = { ...sub, placement: r.placement };
    const note = plain(sub.placement) ? 'Placement updated' : 'Placement recorded';
    const moved = S.updateStatus(out, r.placement.status !== 'fell_through' ? 'Placed' : out.status, { note, now: nowMs });
    if (moved.ok) out = moved.submission;
    return { ok: true, submission: out, placement: r.placement };
  }

  // ── The CSV for an accounting tool (QuickBooks first: Customer = the vendor you invoice, Product/Service = the consultant) ──
  // US date order (MM/DD/YYYY), as QuickBooks Online US imports it. Pay and margin columns only for people who may see pay.
  const QB_HEADERS = ['Customer', 'Product/Service', 'Description', 'Rate', 'Unit', 'PO number', 'Terms', 'Start date', 'End date', 'Status', 'End client', 'Tax terms'];
  const QB_PAY_HEADERS = ['Pay rate', 'Margin per unit', 'Margin %', 'Estimated margin a month'];
  const usDate = (d) => { const x = S.cleanDay(d); return x ? `${x.slice(5, 7)}/${x.slice(8, 10)}/${x.slice(0, 4)}` : ''; };
  const UNIT_WORD = { hr: 'Hour', day: 'Day', month: 'Month', year: 'Year' };
  // rows: [{ placement, consultantName, vendorName, vendor (for net terms), role, endClient }]
  function quickbooksRows(rows, opts) {
    const o = opts || {};
    const t = todayOf(o.today);
    return (Array.isArray(rows) ? rows : []).filter(r => r && plain(r.placement)).map((r) => {
      const p = r.placement;
      const mg = placementMargin(p);
      const out = {
        'Customer': oneLine(r.vendorName, 120),
        'Product/Service': oneLine(r.consultantName, 120),
        'Description': [oneLine(r.role, 120), oneLine(r.endClient, 120)].filter(Boolean).join(' at '),
        'Rate': p.billRate === null || p.billRate === undefined ? '' : String(p.billRate),
        'Unit': UNIT_WORD[p.rateUnit] || 'Hour',
        'PO number': oneLine(p.poRef, PO_MAX),
        'Terms': 'Net ' + netTermsOf(r.vendor),
        'Start date': usDate(p.startOn),
        'End date': usDate(p.endOn),
        'Status': STATUS_LABELS[placementStatus(p, t)],
        'End client': oneLine(r.endClient, 120),
        'Tax terms': p.taxTerms || ''
      };
      if (o.canPay) {
        out['Pay rate'] = p.payRate === null || p.payRate === undefined ? '' : String(p.payRate);
        out['Margin per unit'] = mg.valid ? String(mg.margin) : '';
        out['Margin %'] = mg.valid ? String(mg.marginPct) : '';
        out['Estimated margin a month'] = mg.valid && mg.monthly !== null ? String(mg.monthly) : '';
      }
      return out;
    });
  }

  // ── The funnel: how far a submission got. The extension's statuses and the web app's stages both read here. ──
  const STAGE_RANK = { submitted: 0, vendor_replied: 0, vendor_screen: 0, interview: 1, client_interview: 1, offer: 2, placed: 3 };
  const rankOfStatus = (s) => { const k = String(s || '').trim().toLowerCase().replace(/\s+/g, '_'); return STAGE_RANK[k] === undefined ? -1 : STAGE_RANK[k]; };
  function funnelStage(x) {
    const r = plain(x) ? x : {};
    let rank = Math.max(0, rankOfStatus(r.status || r.stage));
    for (const h of Array.isArray(r.history) ? r.history : []) if (h) rank = Math.max(rank, rankOfStatus(h.status));
    if (Array.isArray(r.interviews) && r.interviews.some(plain)) rank = Math.max(rank, 1);
    if (plain(r.placement) && r.placement.status !== 'fell_through') rank = 3;
    else if (plain(r.placement)) rank = Math.max(rank, 2);
    return ['submitted', 'interview', 'offer', 'placed'][rank];
  }
  // Counts of submissions that reached each step (a placed one also counts as interviewed and offered), and the step rates in %.
  function funnel(items) {
    const n = { submitted: 0, interview: 0, offer: 0, placed: 0 };
    for (const x of Array.isArray(items) ? items : []) {
      if (!plain(x) || x.sample === true || x.draft === true) continue;
      const st = funnelStage(x);
      n.submitted++;
      if (st !== 'submitted') n.interview++;
      if (st === 'offer' || st === 'placed') n.offer++;
      if (st === 'placed') n.placed++;
    }
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    return { ...n, rates: { interview: pct(n.interview, n.submitted), offer: pct(n.offer, n.interview), placed: pct(n.placed, n.submitted) } };
  }

  // ── staffing P4: the funnel per recruiter or desk, and the margin per recruiter for a month (the web app's Reports) ──
  const MARGIN_HEADERS = ['Month', 'Recruiter', 'Placements running in the month', 'With bill and pay rate', 'Gross margin estimate (USD)'];
  function funnelBy(items, keyOf) {
    const groups = new Map();
    for (const x of Array.isArray(items) ? items : []) {
      if (!plain(x)) continue;
      const k = keyOf(x);
      if (k === null || k === undefined) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    }
    return [...groups].map(([key, list]) => ({ key, ...funnel(list) }));
  }
  function funnelByFamily(items) {
    return funnelBy(items, (x) => String(x.family || 'Other')).sort((a, b) => ((a.key === 'Other') - (b.key === 'Other')) || (b.submitted - a.submitted)
      || (b.placed - a.placed) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  // rows: [{ recruiterId, placement }] (placement carries billRate, payRate, rateUnit, taxTerms, startOn, endOn, status).
  function marginByRecruiter(rows, month) {
    const groups = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!plain(r) || !plain(r.placement)) continue;
      const k = r.recruiterId || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r.placement);
    }
    const out = [];
    for (const [recruiterId, list] of groups) {
      const m = monthMargin(list, month);
      if (!m.counted && !m.missing) continue;   // no placement of theirs ran in that month
      out.push({ recruiterId, placements: m.counted + m.missing, counted: m.counted, missing: m.missing, margin: Math.round(m.total * 100) / 100 });
    }
    return out.sort((a, b) => b.margin - a.margin);
  }
  function marginCsvRows(list, month, nameOf) {
    const name = typeof nameOf === 'function' ? nameOf : (id) => id;
    return (Array.isArray(list) ? list : []).map((r) => ({
      [MARGIN_HEADERS[0]]: month, [MARGIN_HEADERS[1]]: name(r.recruiterId) || 'No recruiter', [MARGIN_HEADERS[2]]: r.placements,
      [MARGIN_HEADERS[3]]: r.counted, [MARGIN_HEADERS[4]]: (Math.round(r.margin * 100) / 100).toFixed(2)
    }));
  }
  BP.Placements = {
    MODES, MODE_LABELS, OUTCOMES, OUTCOME_LABELS, STATUSES, STATUS_LABELS, MAX_INTERVIEWS, MAX_ROUND, WITH_MAX, FEEDBACK_MAX, PO_MAX,
    INTERVIEW_MINUTES, NET_TERMS, DEFAULT_NET_TERMS, HOURS_PER_DAY, ZONES, QB_HEADERS, QB_PAY_HEADERS,
    validZone, viewerZone, zonedToUtc, utcToZoned, zoneAbbr, interviewTimeText,
    nextRound, cleanInterview, cleanInterviewList, upsertInterview, removeInterview, upcomingInterviews, buildIcs, interviewIcs, interviewEvent, calendarLinks,
    GOOGLE_CALENDAR, OUTLOOK_CALENDAR,
    placementStatus, cleanPlacement, placementMargin, weekdaysBetween, monthMargin, endingWithin, startingWithin, netTermsOf, expectedPaymentDate,
    quickbooksRows, funnelStage, funnel, addDays, withInterview, withoutInterview, withPlacement,
    MARGIN_HEADERS, funnelBy, funnelByFamily, marginByRecruiter, marginCsvRows
  };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
