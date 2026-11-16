// lib/today.js - the "Today" data layer (v1.6.0): today summary, Leads filters and the in-product match highlight rules.
// Pure functions only (no DOM, no chrome.*, no clock unless `nowMs` is left out). The service worker
// (single writer) loads it with importScripts and applies the results; the dashboard / drawer can call the
// pure helpers directly. Needs lib/shared.js, lib/posted.js and lib/roles.js loaded first.
// Field and message reference: docs/specs/V1_6_DATA_API.md
//
//   BP.todaySummary(state, nowMs, tz = 'Asia/Kolkata', opts)
//   BP.filterLeadsByPosted(leads, '24h'|'3d'|'7d', nowMs, { strict })     BP.filterLeadsByRole(leads, family)
//   BP.isCapturedToday(lead, nowMs, tz)                                    BP.dayKeyOf(ms, tz)
//   BP.normalizeAlertSettings(raw)   BP.planMatchAlerts({ leads, consultants, settings, state, nowMs }) -> { state, unseenCount, added }

(function (root) {
  'use strict';
  if (!(root.BP && root.BP.tierOf) && typeof require === 'function') { require('./shared.js'); }
  if (!(root.BP && root.BP.postedAgo) && typeof require === 'function') { require('./posted.js'); }
  if (!(root.BP && root.BP.roleFamily) && typeof require === 'function') { require('./roles.js'); }
  const BP = root.BP;

  const HOUR = 3600000, DAY = 86400000;
  const IST = 'Asia/Kolkata';
  const IST_OFFSET_MS = 19800000;   // +05:30, no DST

  const pad2 = (n) => String(n).padStart(2, '0');

  // ── Time zone helpers (IST fast path, Intl for anything else) ─────────────
  const intlCache = {};
  function partsOf(ms, tz) {
    if (!tz || tz === IST) {
      const d = new Date(ms + IST_OFFSET_MS);
      return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
    }
    const f = intlCache[tz] || (intlCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
    }));
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
    return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute };
  }
  function dayKeyOf(ms, tz) {
    const p = partsOf(ms, tz);
    return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
  }
  function dayDiff(aKey, bKey) {   // a - b in whole days
    const t = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((t(aKey) - t(bKey)) / DAY);
  }

  function isRequirementLead(l) {
    return BP.isHiringLead(l);
  }
  function savedMsOf(l) { return BP.leadSavedMs(l); }
  function isCapturedToday(lead, nowMs, tz) {
    const ms = savedMsOf(lead);
    return Number.isFinite(ms) && dayKeyOf(ms, tz) === dayKeyOf(Number.isFinite(nowMs) ? nowMs : Date.now(), tz);
  }

  // ── Today summary ─────────────────────────────────────────────────────────
  function dominantFamily(counts) {
    let best = 'Other', bestN = 0;
    for (const f of BP.ROLE_FAMILIES) {
      const n = counts.get(f) || 0;
      // 'Other' only wins when nothing else was seen
      if (n > bestN && (f !== 'Other' || bestN === 0)) { best = f; bestN = n; }
    }
    return best;
  }

  // state: { allLeads, consultants, jobOpenings }. Captured time = savedAt. "Today" = calendar day in `tz` (IST).
  // Hotlists / bench sellers / recruiter-jobs never count as requirements; "Jobs for you" are counted apart.
  function todaySummary(state, nowMs, tz, opts) {
    const st = state || {};
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const zone = tz || IST;
    const o = opts || {};
    const matchLimit = Number.isFinite(o.matchLimit) ? o.matchLimit : 10;
    const recentLimit = Number.isFinite(o.recentLimit) ? o.recentLimit : 8;
    const today = dayKeyOf(now, zone);
    const month = today.slice(0, 7);
    const leads = Array.isArray(st.allLeads) ? st.allLeads : [];

    const byHour = new Array(24).fill(0);
    const roleMap = new Map();      // family -> { family, total, c2c, remote, local }
    const todayLeads = [];
    const vendors = new Map();      // key -> { company, companyId, count, families: Map }
    const pipeline = { New: 0, Contacted: 0, Responded: 0, Interview: 0, Closed: 0 };
    const followItems = [];
    let total = 0, last2h = 0, c2c = 0, remote = 0, localOnly = 0, hotlistsSkipped = 0, late = 0, followCount = 0;
    const weekAgo = now - 7 * DAY;

    for (const l of leads) {
      if (!l || l.sample === true) continue;   // sample data (v1.7 M4) never counts
      if (l.postType === 'recruiter-job') continue;
      const closed = BP.normalizeStatus(l.status) === 'Closed';
      if (l.followUpDate && !closed && l.followUpDate <= today && l.postType !== 'hotlist') {
        followCount++;
        const daysLate = Math.max(0, dayDiff(today, l.followUpDate));
        if (daysLate > 0) late++;
        followItems.push({ email: l.email, recruiterName: l.recruiterName || '', companyName: l.companyName || '', followUpDate: l.followUpDate, daysLate });
      }
      const ms = savedMsOf(l);
      const isToday = Number.isFinite(ms) && dayKeyOf(ms, zone) === today;
      if (!isRequirementLead(l)) {
        if (isToday) hotlistsSkipped++;
        continue;
      }
      if (!Number.isFinite(ms)) continue;

      // Pipeline this month: touched (saved or last contacted) in the current month.
      const lc = typeof l.lastContactDate === 'string' ? l.lastContactDate : '';
      if (dayKeyOf(ms, zone).slice(0, 7) === month || lc.slice(0, 7) === month) pipeline[BP.normalizeStatus(l.status)]++;

      let family = null;
      const fam = () => family || (family = BP.roleFamily(l));

      if (ms >= weekAgo && ms <= now + HOUR) {
        const key = l.companyId || String(l.companyName || '').trim().toLowerCase();
        if (key && key !== 'staffing partner') {
          let v = vendors.get(key);
          if (!v) vendors.set(key, v = { company: l.companyName || '', companyId: l.companyId || '', count: 0, families: new Map() });
          v.count++;
          v.families.set(fam(), (v.families.get(fam()) || 0) + 1);
        }
      }

      if (!isToday) continue;
      total++;
      if (ms >= now - 2 * HOUR) last2h++;
      byHour[partsOf(ms, zone).h]++;
      const isC2c = Array.isArray(l.engagement) && l.engagement.includes('c2c');
      const isRemote = l.workMode === 'remote';
      const isLocal = l.localOnly === true;
      if (isC2c) c2c++;
      if (isRemote) remote++;
      if (isLocal) localOnly++;
      let r = roleMap.get(fam());
      if (!r) roleMap.set(fam(), r = { family: fam(), total: 0, c2c: 0, remote: 0, local: 0 });
      r.total++;
      if (isC2c) r.c2c++;
      if (isRemote) r.remote++;
      if (isLocal) r.local++;
      todayLeads.push({ lead: l, ms, family: fam() });
    }

    const order = (f) => BP.ROLE_FAMILIES.indexOf(f);
    const byRole = [...roleMap.values()].sort((a, b) => b.total - a.total || order(a.family) - order(b.family));

    // Bench matches: only today's requirements are scored (keeps 2,000+ leads fast).
    const consultants = (Array.isArray(st.consultants) ? st.consultants : []).filter(c => BP.isMatchable(c, now));
    const matchRows = [];
    let matchCount = 0;       // distinct posts that match at least one consultant
    let matchPairs = 0;       // post x consultant pairs
    if (consultants.length) {
      for (const t of todayLeads) {
        if (!BP.inMatchPool(t.lead, now)) continue;   // the one match pool (v1.17): closed, stale or old posts are not matched
        const ms = BP.matchConsultants(t.lead, consultants);
        if (ms.length) matchCount++;
        for (const m of ms) {
          matchPairs++;
          matchRows.push({
            leadId: t.lead.email, email: t.lead.email, consultantId: m.consultant.id, consultantName: m.consultant.name || '',
            percent: m.percent, reasons: m.reasons.slice(), requirement: t.lead.requirement || '', companyName: t.lead.companyName || '',
            location: t.lead.location || '', family: t.family, savedAt: t.lead.savedAt || ''
          });
        }
      }
      matchRows.sort((a, b) => b.percent - a.percent || (Date.parse(b.savedAt) || 0) - (Date.parse(a.savedAt) || 0));
    }

    followItems.sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));
    const hotVendors = [...vendors.values()].sort((a, b) => b.count - a.count || a.company.localeCompare(b.company)).slice(0, 3)
      .map(v => ({ company: v.company, companyId: v.companyId, count: v.count, family: dominantFamily(v.families) }));

    const jobs = Array.isArray(st.jobOpenings) ? st.jobOpenings : [];
    let jobsToday = 0;
    for (const j of jobs) { const ms = Date.parse(j && j.savedAt); if (Number.isFinite(ms) && dayKeyOf(ms, zone) === today) jobsToday++; }

    const recent = todayLeads.sort((a, b) => b.ms - a.ms).slice(0, recentLimit).map(t => ({
      email: t.lead.email, recruiterName: t.lead.recruiterName || '', companyName: t.lead.companyName || '', requirement: t.lead.requirement || '',
      location: t.lead.location || '', family: t.family, savedAt: t.lead.savedAt || '', postedAt: t.lead.postedAt || '', postedLabel: t.lead.postedLabel || ''
    }));

    return {
      date: today, tz: zone, total, last2h, byHour, byRole, c2c, remote, localOnly, hotlistsSkipped,
      matchCount, matchPairs, matches: matchRows.slice(0, matchLimit),
      followUpsDue: { count: followCount, late, items: followItems.slice(0, 50) },
      hotVendors, pipeline, jobsForYou: { today: jobsToday, total: jobs.length }, recent
    };
  }

  // ── Leads filters ────────────────────────────────────────────────────────
  const POSTED_WINDOWS = { '24h': DAY, '3d': 3 * DAY, '7d': 7 * DAY };

  // Leads whose post (or, without a posted date, save) time is inside the window. strict:true drops leads
  // that have no postedAt instead of falling back to the save time.
  function filterLeadsByPosted(leads, windowKey, nowMs, opts) {
    const span = POSTED_WINDOWS[windowKey];
    const list = Array.isArray(leads) ? leads : [];
    if (!span) return list;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const strict = Boolean(opts && opts.strict);
    return list.filter(l => {
      let ms = BP.leadPostedMs(l);
      if (!Number.isFinite(ms)) { if (strict) return false; ms = savedMsOf(l); }
      return Number.isFinite(ms) && ms >= now - span && ms <= now + HOUR;
    });
  }

  function filterLeadsByRole(leads, family) {
    const list = Array.isArray(leads) ? leads : [];
    if (!family || family === 'all') return list;
    return list.filter(l => BP.roleFamily(l) === family);
  }

  // ── Match highlights (in-product only; BenchPilot never shows desktop notifications) ──────────────────
  const ALERT_DEFAULTS = Object.freeze({ enabled: true });
  const ALERT_MIN_PERCENT = 75;              // weaker matches stay visible in the app but are not counted as "new strong matches"
  const ALERT_MAX_POST_AGE_MS = 48 * HOUR;   // a post LinkedIn says is older than this is not "new"
  const ALERT_DEDUPE_MAX = 3000;
  const ALERT_DEDUPE_TTL_MS = 30 * DAY;

  function normalizeAlertSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return { enabled: r.enabled === undefined ? ALERT_DEFAULTS.enabled : r.enabled !== false && r.enabled !== 'false' };
  }

  // Count newly saved leads that match an active bench consultant at ALERT_MIN_PERCENT or more. Pure: returns the
  // next alertState (persist it) and the number of unseen strong matches today.
  // state = { dedupe: {key: ms}, unseenDay, unseen: [key] }.
  // Rules: requirements only; active consultants without alertsOff; one count per lead+consultant ever; the global
  // switch off counts nothing. "Unseen" resets each IST day and when the user opens the matches (MARK_MATCHES_SEEN).
  function planMatchAlerts(input) {
    const inp = input || {};
    const now = Number.isFinite(inp.nowMs) ? inp.nowMs : Date.now();
    const settings = normalizeAlertSettings(inp.settings);
    const prev = inp.state && typeof inp.state === 'object' ? inp.state : {};
    const day = dayKeyOf(now, IST);
    const st = {
      dedupe: Object.assign({}, prev.dedupe),
      unseenDay: day,
      unseen: prev.unseenDay === day && Array.isArray(prev.unseen) ? prev.unseen.slice() : []
    };
    const out = { state: st, unseenCount: st.unseen.length, added: 0 };
    if (!settings.enabled) return out;

    const consultants = (Array.isArray(inp.consultants) ? inp.consultants : []).filter(c => BP.isMatchable(c, now) && c.alertsOff !== true);
    if (!consultants.length) return out;

    for (const lead of Array.isArray(inp.leads) ? inp.leads : []) {
      if (!lead || lead.postType !== 'requirement' || !lead.email) continue;
      const posted = BP.leadPostedMs(lead);
      if (Number.isFinite(posted) && now - posted > ALERT_MAX_POST_AGE_MS) continue;
      for (const m of BP.matchConsultants(lead, consultants)) {
        if (m.percent < ALERT_MIN_PERCENT) continue;
        const key = `${lead.email}|${m.consultant.id}`;
        if (st.dedupe[key]) continue;
        st.dedupe[key] = now;
        if (!st.unseen.includes(key)) { st.unseen.push(key); out.added++; }
      }
    }

    // Prune the dedupe map: drop old keys, then cap the size (oldest first).
    const keys = Object.keys(st.dedupe);
    if (keys.length > ALERT_DEDUPE_MAX / 2) {
      for (const k of keys) if (now - st.dedupe[k] > ALERT_DEDUPE_TTL_MS) delete st.dedupe[k];
      const left = Object.keys(st.dedupe);
      if (left.length > ALERT_DEDUPE_MAX) {
        left.sort((a, b) => st.dedupe[a] - st.dedupe[b]).slice(0, left.length - ALERT_DEDUPE_MAX).forEach(k => delete st.dedupe[k]);
      }
    }
    out.unseenCount = st.unseen.length;
    return out;
  }

  Object.assign(BP, {
    dayKeyOf, isCapturedToday, todaySummary, POSTED_WINDOWS, filterLeadsByPosted, filterLeadsByRole,
    ALERT_DEFAULTS, ALERT_MIN_PERCENT, ALERT_MAX_POST_AGE_MS, normalizeAlertSettings, planMatchAlerts
  });
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
