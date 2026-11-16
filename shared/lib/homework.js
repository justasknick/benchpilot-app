// lib/homework.js - "Today's homework": the recruiter's daily plan (spec: docs/specs/TODAY_HOMEWORK_SPEC.md).
// Pure functions only (no DOM, no chrome.*, no clock unless `now` is left out), like lib/today.js and lib/radar.js.
// The service worker builds the plan on every GET_RADAR (BP.Homework.plan) from the radar it just built and writes the
// two small keys back; the drawer and the dashboard only paint `radar.homework`. No AI, nothing new is collected,
// nothing leaves the browser, no desktop notifications.
//
// Two storage keys (new keys only, so no data migration):
//   homework     { shiftStart: 'HH:MM', done: { id: dayKey }, snoozed: { id: untilDayKey }, cleared: [dayKey] }
//                What the user chose. Backed up and synced (lib/sync-merge.js SETTINGS_KEYS).
//   homeworkDay  { day, shown: { id: { kind, title, meta, at } }, auto: { id: ms }, prev: { day, done, total } }
//                What was on today's list, so an item the user finished somewhere else stays ticked. Valid only on this
//                install: never backed up or synced (lib/backup.js EXCLUDED_KEYS).
//
//   BP.Homework.dayOf(ms, shiftStart, tz)          the homework day ('YYYY-MM-DD' of the shift's start)
//   BP.Homework.normalizePrefs(raw)                 -> a clean `homework` value
//   BP.Homework.candidates(input)                   -> ordered items for today (before done / snooze)
//   BP.Homework.plan(input)                         -> { view, prefs, dayState, prefsChanged, dayChanged }
//   BP.Homework.act(prefs, { id, op }, day)         -> next prefs (op: 'done' | 'undo' | 'snooze' | 'skip-week')
//   BP.Homework.streakOf(cleared, day)              days in a row with an empty list (today or up to yesterday)
//   BP.Homework.yesterday(state, now, opts)         the Solo morning summary: yesterday's numbers, computed locally
//   BP.Homework.checkInDraft(item, senderName)      -> { to, subject, body } for a quiet vendor (opened in the mail app, never sent)

(function (root) {
  'use strict';
  if (!(root.BP && root.BP.tierOf) && typeof require === 'function') { require('./shared.js'); }
  const BP = root.BP;

  const DAY = 86400000;
  const IST = 'Asia/Kolkata';
  const IST_OFFSET_MS = 19800000;
  const DEFAULT_SHIFT = '18:00';        // decision 14 Nov (open question 1): an evening shift for the US desk
  const MAX_OPEN = 12;                  // spec 3: at most 12 open items, so the list stays doable
  const CAPS = { interview: 5, match: 5, follow: 5, workauth: 3, push: 3, vendor: 2, cleanup: 1, backup: 1 };
  const KIND_ORDER = ['interview', 'match', 'follow', 'workauth', 'push', 'vendor', 'cleanup', 'backup'];   // a booked time first, money, then dates that cannot slip, then hygiene
  const PUSH_DAYS = 30;                 // on the bench this long with no submission this week
  const QUIET_DAYS = 14;                // a Trusted vendor that has not answered a submission for this long
  const BACKUP_LEADS = 50, BACKUP_DAYS = 7;
  const CLEARED_KEEP = 60;
  // Opening these is the job itself; the others tick when the thing is done (a submission logged, a follow-up moved ...).
  const DONE_ON_OPEN = { match: true, vendor: true };

  const pad2 = (n) => String(n).padStart(2, '0');
  const plain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const lc = (s) => String(s || '').trim().toLowerCase();
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
  const isDayKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // ── The homework day ──────────────────────────────────────────────────────
  const fmtCache = {};
  function partsOf(ms, tz) {
    if (!tz || tz === IST) {
      const d = new Date(ms + IST_OFFSET_MS);
      return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
    }
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
    }));
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
    return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute };
  }
  function addDays(key, n) {
    const [y, m, d] = key.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d) + n * DAY);
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  }
  function normalizeShift(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return DEFAULT_SHIFT;
    const h = Number(m[1]), mi = Number(m[2]);
    return h <= 23 && mi <= 59 ? `${pad2(h)}:${pad2(mi)}` : DEFAULT_SHIFT;
  }
  const shiftMinutes = (s) => { const [h, m] = normalizeShift(s).split(':').map(Number); return h * 60 + m; };
  // The day a moment belongs to: the local date of the shift it falls in. With an 18:00 start, 02:00 on the 15th is still
  // the 14th's list, so an evening shift that runs past midnight is one day, not two. Wall-clock based, so DST is fine.
  function dayOf(ms, shiftStart, tz) {
    const p = partsOf(Number.isFinite(ms) ? ms : Date.now(), tz);
    const key = `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
    return p.h * 60 + p.mi < shiftMinutes(shiftStart) ? addDays(key, -1) : key;
  }
  // "6:00 pm" for "18:00".
  function shiftLabel(s) {
    const [h, m] = normalizeShift(s).split(':').map(Number);
    return `${h % 12 === 0 ? 12 : h % 12}:${pad2(m)} ${h < 12 ? 'am' : 'pm'}`;
  }

  // ── The stored choices ────────────────────────────────────────────────────
  function normalizePrefs(raw) {
    const r = plain(raw) ? raw : {};
    const map = (o) => {
      const out = {};
      if (plain(o)) for (const [k, v] of Object.entries(o)) if (typeof k === 'string' && k && k.length <= 300 && isDayKey(v)) out[k] = v;
      return out;
    };
    const cleared = Array.isArray(r.cleared) ? [...new Set(r.cleared.filter(isDayKey))].sort().slice(-CLEARED_KEEP) : [];
    return { shiftStart: normalizeShift(r.shiftStart), done: map(r.done), snoozed: map(r.snoozed), cleared };
  }
  // Ticks belong to one day; a snooze lasts until its day. Returns a new object.
  function pruneFor(prefs, day) {
    const p = normalizePrefs(prefs);
    for (const [k, v] of Object.entries(p.done)) if (v !== day) delete p.done[k];
    for (const [k, v] of Object.entries(p.snoozed)) if (v <= day) delete p.snoozed[k];
    return p;
  }
  // op: 'done' (tick), 'undo' (untick), 'snooze' (back at the next shift), 'skip-week' (back in 7 days).
  function act(prefs, input, day) {
    const p = pruneFor(prefs, day);
    const id = typeof (input && input.id) === 'string' ? input.id.slice(0, 300) : '';
    if (!id || !isDayKey(day)) return p;
    const op = input.op;
    if (op === 'done') { p.done[id] = day; delete p.snoozed[id]; }
    else if (op === 'undo') delete p.done[id];
    else if (op === 'snooze') { p.snoozed[id] = addDays(day, 1); delete p.done[id]; }
    else if (op === 'skip-week') { p.snoozed[id] = addDays(day, 7); delete p.done[id]; }
    return p;
  }
  function streakOf(cleared, day) {
    const set = new Set(Array.isArray(cleared) ? cleared : []);
    let d = set.has(day) ? day : addDays(day, -1);
    let n = 0;
    while (set.has(d)) { n++; d = addDays(d, -1); }
    return n;
  }

  // ── The items (spec 3) ────────────────────────────────────────────────────
  const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';
  const title = (t) => (BP.displayTitle ? BP.displayTitle(t) : String(t || '')) || 'Requirement';
  const savedMs = (l) => (BP.leadSavedMs ? BP.leadSavedMs(l) : Date.parse(l && l.savedAt));

  // input: { radar, submissions, companies, consultants, bookCheck, leadCount, lastBackupAt, tier, now, shiftStart, tz, viewerTz }
  // viewerTz: the zone interview times are shown in (default: this computer's zone).
  // Returns { items, locked: { vendor } } in spec order (items carry their own caps; the open limit is applied by plan()).
  function candidates(input) {
    const inp = input || {};
    const r = plain(inp.radar) ? inp.radar : {};
    const now = Number.isFinite(inp.now) ? inp.now : Date.now();
    const shift = normalizeShift(inp.shiftStart), tz = inp.tz || IST;
    const day = dayOf(now, shift, tz);
    const out = [];
    const add = (kind, list) => { for (const it of list.slice(0, CAPS[kind])) out.push({ kind, doneOnOpen: Boolean(DONE_ON_OPEN[kind]), ...it }); };

    // Interview (staffing P3, lib/placements.js): today's and tomorrow's interviews, at the time in the person's own zone ("Interview at 21:00 IST:
    // Ravi -> Harborline Bank"). The item goes away once the interview is over or has an outcome.
    if (BP.Placements) {
      const ivTz = inp.viewerTz || BP.Placements.viewerZone();
      const ivDay = BP.Placements.utcToZoned(now, ivTz).slice(0, 10);
      const ivItems = [];
      for (const s of Array.isArray(inp.submissions) ? inp.submissions : []) {
        if (!s || s.sample === true || BP.Submissions.isClosedStatus(s.status)) continue;
        for (const iv of Array.isArray(s.interviews) ? s.interviews : []) ivItems.push({ interview: iv, sub: s });
      }
      add('interview', BP.Placements.upcomingInterviews(ivItems, { now, tz: ivTz, days: 2 }).map(x => ({
        id: 'interview|' + x.interview.id, subId: x.sub.id, consultantId: x.sub.consultantId,
        title: `Interview ${x.isToday ? '' : 'tomorrow '}at ${BP.Placements.interviewTimeText(x.ms, ivTz, { today: ivDay }).replace(/^(Today|Tomorrow), /, '')}: ${first(x.sub.consultantName) || 'Your consultant'} → ${x.sub.endClient || x.sub.vendorName || title(x.sub.role)}`,
        meta: [`Round ${x.interview.round}`, BP.Placements.MODE_LABELS[x.interview.mode], x.interview.withWhom ? 'with ' + x.interview.withWhom : '', title(x.sub.role)].filter(Boolean).join(' · '),
        cta: 'Open'
      })));
    }

    // New match: a strong match on a requirement saved during today's shift.
    add('match', (Array.isArray(r.matches) ? r.matches : []).filter(m => m && !m.sample && m.percent >= (BP.MATCH_THRESHOLD || 60) && m.lead
      && Number.isFinite(savedMs(m.lead)) && dayOf(savedMs(m.lead), shift, tz) === day)
      .map(m => ({
        id: 'match|' + lc(m.email) + '|' + m.consultantId, key: m.key, email: lc(m.email), consultantId: m.consultantId,
        title: `${first(m.consultantName) || 'Your consultant'} → ${title(m.lead.requirement)}`,
        meta: [m.percent + '% match', m.lead.companyName && m.lead.companyName !== 'Staffing Partner' ? m.lead.companyName : '', m.lead.location || ''].filter(Boolean).join(' · '),
        cta: 'Open'
      })));

    // Follow-up due: drafts to mark as sent, then submissions and leads due today or late (the radar's own list and order).
    add('follow', (Array.isArray(r.followUps) ? r.followUps : []).filter(f => f && f.id).map(f => {
      const who = [first(f.consultantName), f.vendorName || 'Recruiter'].filter(Boolean).join(' → ');
      const when = f.kind === 'draft' ? 'not marked as sent' : f.daysLate > 0 ? `${f.daysLate} day${f.daysLate === 1 ? '' : 's'} late` : 'due today';
      return {
        id: 'follow|' + (f.kind || '') + '|' + f.id, followKind: f.kind || '', followId: f.id, email: lc(f.email),
        title: (f.kind === 'draft' ? 'Mark as sent: ' : 'Follow up: ') + who,
        meta: [f.role ? title(f.role) : '', when].filter(Boolean).join(' · '), cta: f.kind === 'draft' ? 'Review' : 'Follow up'
      };
    }));

    // Work authorisation ending (staffing P1): at 120, 90, 60, 30 and 7 days before the end date, on the day and after it. The id carries the
    // reminder step, so an item ticked off at 90 days comes back at 60. Only the type and the date are known; no document is involved.
    add('workauth', (BP.expiringWorkAuth ? BP.expiringWorkAuth(inp.consultants, day) : []).map(x => ({
      id: 'workauth|' + x.id + '|' + x.step + '|' + x.until, consultantId: x.id,
      title: x.expired ? `${first(x.name) || 'A consultant'}'s work authorisation has ended` : x.days === 0 ? `${first(x.name) || 'A consultant'}'s work authorisation ends today`
        : `${first(x.name) || 'A consultant'}'s work authorisation ends in ${x.days} day${x.days === 1 ? '' : 's'}`,
      meta: [x.visaType, 'until ' + (BP.planDate ? BP.planDate(x.until) : x.until), 'check the renewal and update the date'].filter(Boolean).join(' · '),
      cta: 'Update'
    })));

    // Push a consultant: on the bench 30+ days, nothing submitted in the last 7 days. Longest wait first.
    add('push', (Array.isArray(r.bench) ? r.bench : []).filter(c => c && c.id && Number(c.daysOnBench) >= PUSH_DAYS && !(c.submissionsThisWeek > 0))
      .sort((a, b) => b.daysOnBench - a.daysOnBench).map(c => ({
        id: 'push|' + c.id, consultantId: c.id, bestEmail: c.best && !c.best.sample ? c.best.email : '',
        title: `Push ${c.name || 'a consultant'}`,
        meta: `${c.daysOnBench} days on the bench · no submission this week` + (c.best && !c.best.sample ? ` · best open match ${c.best.percent}%` : ''),
        cta: c.best && !c.best.sample ? 'Best match' : 'Find work'
      })));

    // Quiet vendor (Solo): a Trusted vendor with a submission that has had no reply for 14+ days.
    const quiet = quietVendors(inp.submissions, inp.companies, now);
    if (BP.can(inp.tier, 'vendorCheckins')) add('vendor', quiet);
    const locked = { vendor: BP.can(inp.tier, 'vendorCheckins') ? 0 : quiet.length };

    // Clean up: the Vendor Book's "things to check" (possible duplicates, bench sellers, wrong owners, bounced).
    const check = Math.max(0, Math.floor(Number(inp.bookCheck) || 0));
    if (check) add('cleanup', [{ id: 'cleanup|book', title: `Check ${check} thing${check === 1 ? '' : 's'} in your Vendor Book`, meta: 'Possible duplicates and contacts to review', cta: 'Review' }]);

    // Back up: 50+ recruiters and no backup in 7 days (the rule the popup and dashboard reminders use).
    const leads = Math.max(0, Math.floor(Number(inp.leadCount) || 0));
    const last = Number(inp.lastBackupAt) || 0;
    if (leads >= BACKUP_LEADS && (!last || now - last >= BACKUP_DAYS * DAY)) {
      add('backup', [{ id: 'backup|now', title: 'Back up your data', meta: `${leads} recruiters saved · ` + (last ? `last backup ${Math.floor((now - last) / DAY)} days ago` : 'never backed up'), cta: 'Back up' }]);
    }
    return { items: out, locked };
  }

  function quietVendors(submissions, companies, now) {
    const trusted = new Map();
    for (const c of Array.isArray(companies) ? companies : []) if (c && c.id && c.label === 'trusted') trusted.set(c.id, c);
    if (!trusted.size) return [];
    const byVendor = new Map();
    for (const s of Array.isArray(submissions) ? submissions : []) {
      if (!s || s.sample === true || s.draft === true || !s.companyId || !trusted.has(s.companyId)) continue;
      if ((s.status || 'Submitted') !== 'Submitted') continue;   // any reply moves it on (Vendor replied, Interview, Rejected ...)
      const at = Date.parse(s.submittedAt);
      if (!Number.isFinite(at) || now - at < QUIET_DAYS * DAY) continue;
      const v = byVendor.get(s.companyId);
      if (!v || at > v.at) byVendor.set(s.companyId, { at, s, n: (v ? v.n : 0) + 1 }); else v.n++;
    }
    return [...byVendor.entries()].sort((a, b) => a[1].at - b[1].at).map(([id, v]) => {
      const days = Math.floor((now - v.at) / DAY);
      const name = trusted.get(id).name || v.s.vendorName || id;
      return {
        id: 'vendor|' + id, companyId: id, email: lc(v.s.leadEmail), consultantName: v.s.consultantName || '', role: v.s.role || '',
        sentOn: v.s.submittedAt || '', title: `Check in with ${name}`,
        meta: `Trusted · no reply for ${days} days` + (v.s.consultantName ? ` · ${first(v.s.consultantName)}` : '') + (v.n > 1 ? ` and ${v.n - 1} more` : ''),
        cta: 'Draft check-in'
      };
    });
  }

  function checkInDraft(item, senderName) {
    const it = item || {};
    const role = it.role ? title(it.role) : 'the role';
    const when = isDayKey(String(it.sentOn).slice(0, 10)) ? ' on ' + String(it.sentOn).slice(0, 10) : '';
    const who = it.consultantName ? it.consultantName : 'my consultant';
    const lines = ['Hi,', '', `I submitted ${who} for ${role}${when}. Is there any update from the client?`, '', 'Happy to share more consultants if this one is no longer open.', '', 'Thanks,'];
    if (senderName) lines.push(String(senderName));
    return { to: it.email || '', subject: `Checking in: ${role}`, body: lines.join('\n') };
  }

  // ── The day's list ────────────────────────────────────────────────────────
  // input: candidates input + { prefs (homework), dayState (homeworkDay) }.
  // Rules: ticked (done) and snoozed items leave the open list; an item shown earlier today that is no longer a candidate
  // (and was not snoozed) was finished somewhere else, so it stays in the list, ticked. Items already shown keep their place;
  // new ones fill up to 12 open. Returns the next prefs / dayState and whether each changed (the worker writes only then).
  function plan(input) {
    const inp = input || {};
    const now = Number.isFinite(inp.now) ? inp.now : Date.now();
    const tz = inp.tz || IST;
    const prefsIn = normalizePrefs(inp.prefs);
    const day = dayOf(now, prefsIn.shiftStart, tz);
    const prefs = pruneFor(prefsIn, day);
    const prevDs = plain(inp.dayState) ? inp.dayState : {};
    const sameDay = prevDs.day === day;
    const ds = {
      day,
      shown: sameDay && plain(prevDs.shown) ? { ...prevDs.shown } : {},
      auto: sameDay && plain(prevDs.auto) ? { ...prevDs.auto } : {},
      prev: sameDay ? (plain(prevDs.prev) ? prevDs.prev : null) : (isDayKey(prevDs.day) && plain(prevDs.shown)
        ? { day: prevDs.day, total: Object.keys(prevDs.shown).length, done: countDone(prevDs, inp.prefs) } : null)
    };
    if (!ds.prev) delete ds.prev;

    const { items, locked } = candidates({ ...inp, now, tz, shiftStart: prefs.shiftStart });
    const live = new Map(items.map(i => [i.id, i]));
    // Finished elsewhere: shown today, gone now, not snoozed.
    for (const id of Object.keys(ds.shown)) {
      if (!live.has(id) && !prefs.snoozed[id] && !prefs.done[id] && !ds.auto[id]) ds.auto[id] = now;
      if (live.has(id) && ds.auto[id]) delete ds.auto[id];   // came back (a follow-up moved to today again): open again
    }
    const isDone = (id) => Boolean(prefs.done[id] || ds.auto[id]);
    const rank = (i) => KIND_ORDER.indexOf(i.kind);
    const open = [];
    const seen = items.filter(i => ds.shown[i.id] && !isDone(i.id) && !prefs.snoozed[i.id]);
    const fresh = items.filter(i => !ds.shown[i.id] && !isDone(i.id) && !prefs.snoozed[i.id]);
    for (const i of seen) if (open.length < MAX_OPEN) open.push(i);
    for (const i of fresh) if (open.length < MAX_OPEN) open.push(i);
    open.sort((a, b) => rank(a) - rank(b) || items.indexOf(a) - items.indexOf(b));
    for (const i of open) if (!ds.shown[i.id]) ds.shown[i.id] = { kind: i.kind, title: clip(i.title, 160), meta: clip(i.meta, 200), at: now };
    // Ticked today: from the snapshot (the item may be gone) or the live item when the user ticked it by hand.
    const done = Object.keys(ds.shown).filter(isDone).map(id => {
      const live1 = live.get(id);
      const snap = ds.shown[id];
      return { ...(live1 || { id, kind: snap.kind, title: snap.title, meta: snap.meta }), id, done: true, manual: Boolean(prefs.done[id]) };
    }).sort((a, b) => rank(a) - rank(b));
    // A hand tick on an item that was never shown (ticked straight from the drawer card) still counts.
    for (const id of Object.keys(prefs.done)) {
      if (ds.shown[id] || !live.has(id)) continue;
      const i = live.get(id);
      ds.shown[id] = { kind: i.kind, title: clip(i.title, 160), meta: clip(i.meta, 200), at: now };
      done.push({ ...i, done: true, manual: true });
    }

    // Streak (spec 4): a day counts once its list is empty with at least one item done.
    if (!open.length && done.length && !prefs.cleared.includes(day)) prefs.cleared = [...prefs.cleared, day].sort().slice(-CLEARED_KEEP);
    const view = {
      day, shiftStart: prefs.shiftStart, shiftLabel: shiftLabel(prefs.shiftStart), tz,
      open, done, total: open.length + done.length, doneCount: done.length,
      snoozedCount: items.filter(i => prefs.snoozed[i.id]).length,
      streak: streakOf(prefs.cleared, day), lockedVendors: locked.vendor,
      empty: !open.length
    };
    return {
      view, prefs, dayState: ds,
      prefsChanged: JSON.stringify(prefs) !== JSON.stringify(normalizePrefs(inp.prefs)),
      dayChanged: JSON.stringify(ds) !== JSON.stringify(prevDs)
    };
  }
  function countDone(ds, prefs) {
    const p = normalizePrefs(prefs);
    return Object.keys(ds.shown || {}).filter(id => (ds.auto && ds.auto[id]) || p.done[id] === ds.day).length;
  }

  // ── The Solo morning summary (final plan 8b): yesterday's numbers, computed in the browser ──
  // state: { allLeads, submissions, homeworkDay }. Yesterday = the previous homework day (shift to shift).
  function yesterday(state, now, opts) {
    const st = state || {};
    const o = opts || {};
    const t = Number.isFinite(now) ? now : Date.now();
    const shift = normalizeShift(o.shiftStart), tz = o.tz || IST;
    const y = addDays(dayOf(t, shift, tz), -1);
    const inY = (ms) => Number.isFinite(ms) && dayOf(ms, shift, tz) === y;
    const isReq = (l) => (BP.isHiringLead ? BP.isHiringLead(l) : l.postType === 'requirement');
    let saved = 0;
    for (const l of Array.isArray(st.allLeads) ? st.allLeads : []) if (l && l.sample !== true && isReq(l) && inY(savedMs(l))) saved++;
    let sent = 0, replies = 0, interviews = 0;
    for (const s of Array.isArray(st.submissions) ? st.submissions : []) {
      if (!s || s.sample === true) continue;
      if (s.draft !== true && inY(Date.parse(s.submittedAt))) sent++;
      for (const h of Array.isArray(s.history) ? s.history : []) {
        if (!h || !h.status || h.status === 'Submitted' || !inY(Date.parse(h.at))) continue;
        if (h.status === 'Interview') interviews++;
        else if (h.status !== 'Closed') replies++;
      }
    }
    const ds = plain(st.homeworkDay) ? st.homeworkDay : {};
    const prev = plain(ds.prev) && ds.prev.day === y ? ds.prev : null;
    const parts = [`${saved} requirement${saved === 1 ? '' : 's'} saved`, `${sent} submission${sent === 1 ? '' : 's'} sent`,
      `${replies} vendor repl${replies === 1 ? 'y' : 'ies'}`];
    if (interviews) parts.push(`${interviews} interview${interviews === 1 ? '' : 's'}`);
    if (prev && prev.total) parts.push(`homework ${prev.done} of ${prev.total} done`);
    return { day: y, saved, sent, replies, interviews, homework: prev ? { done: prev.done, total: prev.total } : null, text: 'Yesterday: ' + parts.join(' · ') + '.' };
  }

  BP.Homework = {
    DEFAULT_SHIFT, MAX_OPEN, CAPS, KIND_ORDER, PUSH_DAYS, QUIET_DAYS, DONE_ON_OPEN,
    dayOf, addDays, normalizeShift, shiftLabel, normalizePrefs, pruneFor, act, streakOf, candidates, quietVendors, plan, yesterday, checkInDraft
  };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
