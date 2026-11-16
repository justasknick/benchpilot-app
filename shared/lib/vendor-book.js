// lib/vendor-book.js - the Vendor Book (docs/specs/VENDOR_BOOK_SPEC.md, schema 13): a vendor book that keeps itself up to date.
// Pure functions only (no DOM, no chrome.*, no clock unless `now` is left out). Loaded by the service worker (the single writer),
// every page that runs the storage migration, the dashboard and the LinkedIn drawer, and by node tests. Exposes BP.VendorBook.
//
// What lives on a saved lead (all optional; absent = "not known yet" / empty):
//   lastSeenAt    ISO: the newest post BenchPilot has seen from this address
//   fieldHistory  [{ f, from, to, at, src, k? }] newest last, max 30. src: 'post' (BenchPilot read it in a post) | 'user'
//   userLocks     ['designation' | 'phone' | 'linkedinProfile']: fields the user set by hand; BenchPilot never changes them
//   pending       { designation | phone: { v, keys: [postKey], at } }: a new value seen in one post, waiting for a second post
// The posts themselves are in the v1.19 post log (`postLogs`, lib/post-log.js) plus the lead's own first post.
// Heat, role tags, health counts and the built-in lists are computed every time, never stored.
//
//   refresh(allLeads, pageLeads, now, opts)  -> { allLeads, changed, updated }   one pass per page scan; same array back when nothing changed
//   lockOnEdit(before, after, now)           -> lead with userLocks / history for the fields the user changed by hand
//   restoreField(lead, index, now)           -> { ok, lead, error }   writes an old value back and locks the field
//   unlockField(lead, f)                     -> lead
//   postsOf(lead, postLogs)                  -> [{ k, ms, f }]  the recruiter's posts (own first post + post log), for heat and tags
//   vendorStats(state, now)                  -> Map companyId -> { heat, posts14, posts30, posts60, lastPostMs, tags, more, seenOnce, ... }
//   heatOf(input, now)                       -> 'active' | 'cold' | ''   one vendor's own level (Hot is relative: rankHeat)
//   heatScore(input, now) / rankHeat(rows)   -> Hot = the busiest 20% of the vendors that posted in 30 days (vendorStats calls both)
//   roleTags(posts, now)                     -> { tags: [{ family, count }], more, seenOnce: [family] }
//   health(state, now)                       -> { rows: [{ key, count }], total, recruiters, vendors, updated: [...] }
//   listCounts(state, now, stats)            -> built-in smart lists { hot, cold, replied30, noPhone }
// Slices 2 and 3 (job changes, saved smart lists, batch merge):
//   detectMoves(allLeads, pageLeads, vendorMoves, now, { own, dismissed }) -> { vendorMoves, changed, found }  same array when nothing changed
//   profileMove(lead, { url, name, company, title }, now, { dismissed })  -> entry | null   (the user opened the profile; slice 4 signal)
//   pendingMoves({ allLeads, vendorMoves, cleanupDismissed })            -> suggestions that still apply, with action move | merge | profile
//   applyMove(lead, entry, now)                                           -> { ok, lead }   history src 'move', previousEmails, activity line
//   safeGroups(findDuplicateGroups result)                                -> the groups "Merge safe ones" may merge
//   sanitizeSmartLists(raw), evaluateList(list, state, now, stats), listEmails(...), rulesFromView(scope, view), staleRefs(list)
// Slice 4: moveSummary(pendingMove) (the banner text the dashboard and drawer share), drawerMoves(state, max) (GET_RADAR `moves`),
//   moveForEmail(moves, email), vendorTimeline(state, companyId, { group, max }) (posts, contacts, submissions and replies, newest first)
// Stored by the worker, not here: vendorMoves (derived, not backed up or synced), smartLists (backed up, synced as smart_lists),
// lastMoveUndo / lastBatchUndo (one-step undo snapshots, not backed up).
(function (root) {
  'use strict';
  if (!root.BP && typeof require === 'function') require('./shared.js');
  if (!(root.BP && root.BP.PostLog) && typeof require === 'function') { try { require('./post-log.js'); } catch (_) { /* optional */ } }
  const BP = root.BP = root.BP || {};

  const DAY = 86400000;
  // Heat thresholds in one table (spec 3.3 and open question 4; UX audit A8, 14 Nov 2026).
  // Hot is RELATIVE: the busiest fifth (hotShare) of the vendors that posted in the last 30 days, and only those with at least
  // hotMinPosts30 posts in 30 days (or one post plus a reply / good submission in liftDays). The old fixed "2 posts in 14 days"
  // made every vendor of a normal book Hot, so the label said nothing. Active and Cold stay absolute.
  const HEAT = { hotShare: 0.2, hotMinPosts30: 2, activeDays: 60, coldQuietDays: 60, newVendorDays: 30, liftDays: 30, replyActiveDays: 60 };
  const HEAT_LABELS = { hot: 'Hot', active: 'Active', cold: 'Cold' };
  const HEAT_RANK = { hot: 3, active: 2, cold: 1, '': 0 };
  const TAGS = { days: 90, min: 2, top: 3 };
  const HISTORY_MAX = 30;
  const PENDING_DAYS = 30;
  const SWITCHBOARD = 40;            // = CLEANUP_MAX_SHARED_PHONE in lib/shared.js: a number on more saved recruiters is a switchboard
  const LOCKABLE = ['designation', 'phone', 'linkedinProfile'];
  const FIELD_LABELS = { designation: 'Title', phone: 'Phone', linkedinProfile: 'LinkedIn profile', companyName: 'Company', email: 'Email' };
  // History entries Restore can write back. The email of a job change goes back with Undo (it regroups the vendor), not with Restore;
  // the company name is never refreshed from posts, so restoring it locks nothing.
  const RESTORABLE = [...LOCKABLE, 'companyName'];
  // content.js writes these when a post has no headline: they never replace a real title (spec 3.1).
  const GENERIC_TITLES = new Set(['recruiter', 'us it recruiter', 'staffing partner']);
  const GOOD_SUB = new Set(['Interview', 'Offer', 'Placed']);

  const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const plain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ms = (iso) => { const t = typeof iso === 'string' && iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : NaN; };
  const isoOf = (now) => (typeof now === 'string' && Number.isFinite(Date.parse(now)) ? new Date(Date.parse(now)).toISOString()
    : new Date(Number.isFinite(now) ? now : Date.now()).toISOString());
  const nowMsOf = (now) => (typeof now === 'string' ? Date.parse(now) : Number.isFinite(now) ? now : Date.now());

  function isPlaceholder(v) {
    const s = String(v == null ? '' : v).trim();
    return !s || s === '—' || s === '-' || s === 'Staffing Partner';
  }
  function isGenericTitle(v) { return GENERIC_TITLES.has(normTitle(v)); }
  function phoneKey(v) { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }
  function profileKey(v) { const u = BP.canonicalProfileUrl ? BP.canonicalProfileUrl(v) : ''; return u ? u.toLowerCase() : ''; }
  function fieldValue(lead, f) { const v = lead && lead[f]; return isPlaceholder(v) ? '' : String(v).trim(); }
  function sameValue(f, a, b) {
    if (f === 'phone') return (phoneKey(a) || lc(a)) === (phoneKey(b) || lc(b));
    if (f === 'linkedinProfile') return (profileKey(a) || lc(a)) === (profileKey(b) || lc(b));
    return normTitle(a) === normTitle(b);
  }
  const locks = (lead) => (Array.isArray(lead && lead.userLocks) ? lead.userLocks.filter(f => LOCKABLE.includes(f)) : []);
  const isLocked = (lead, f) => locks(lead).includes(f);

  function pushHistory(lead, entry) {
    const list = Array.isArray(lead.fieldHistory) ? lead.fieldHistory.filter(plain) : [];
    list.push(entry);
    return list.slice(-HISTORY_MAX);
  }
  function pushActivity(lead, at, text) {
    const list = Array.isArray(lead.activity) ? lead.activity.slice(-49) : [];
    list.push({ at, type: 'updated', text: clip(text, 200) });
    return list;
  }

  // ── Was this post written by someone else? The recruiter's own first post counts as a post only when it came from LinkedIn ──
  function imported(lead) {
    return (Array.isArray(lead && lead.activity) ? lead.activity : []).some(a => a && a.type === 'saved' && /^Imported/i.test(String(a.text || '')));
  }
  // Recruiters whose posts feed Heat: not samples, not bench sellers or job seekers (they are not hiring).
  function hiringRecruiter(lead) {
    const l = lead || {};
    return Boolean(l.email) && l.sample !== true && l.benchSeller !== true && l.recruiterType !== 'bench' && l.candidate !== 'yes';
  }
  // When the lead's own first post went up (ms), or NaN: a CSV import, a profile save or a hotlist is not a requirement post.
  function firstPostMs(lead) {
    const l = lead || {};
    if (!normTitle(l.requirement) || l.postType === 'hotlist' || l.postType === 'recruiter-job') return NaN;
    const p = ms(l.postedAt);
    if (Number.isFinite(p)) return p;
    if (imported(l)) return NaN;
    const s = ms(l.savedAt);
    return Number.isFinite(s) ? s : ms(l.extractedAt);
  }
  const familyOf = (x) => {
    if (typeof BP.roleFamily !== 'function') return '';
    const f = BP.roleFamily({ requirement: x.requirement || '', technologies: x.technologies || '', notes: x.notes || '' });
    return f && f !== 'Other' ? f : '';
  };

  // The recruiter's distinct posts: the saved (first) post plus the post log. [{ k, ms, f }]
  function postsOf(lead, postLogs) {
    if (!hiringRecruiter(lead)) return [];
    const out = [];
    const seen = new Set();
    const own = firstPostMs(lead);
    if (Number.isFinite(own)) {
      const k = (BP.PostLog && BP.PostLog.keyOf(lead)) || 'own:' + lc(lead.email);
      seen.add(k);
      out.push({ k, ms: own, f: familyOf(lead) });
    }
    const list = plain(postLogs) ? postLogs[lc(lead.email)] : null;
    for (const e of Array.isArray(list) ? list : []) {
      if (!plain(e) || !e.k || seen.has(e.k)) continue;
      const t = ms(e.at);
      if (!Number.isFinite(t)) continue;
      seen.add(e.k);
      out.push({ k: e.k, ms: t, f: familyOf(e) });
    }
    return out;
  }

  // ── Auto-refresh of saved recruiters (spec 3.1) ──────────────────────────────────────────────────────────────────────
  // Same rules as the post log's eligible sighting (BP.PostLog.isEligible), plus: the user's own record is never touched.
  function eligible(pageLead, saved, own) {
    if (!(BP.PostLog && BP.PostLog.isEligible(pageLead, saved))) return false;
    return !(own && BP.isOwnLead && BP.isOwnLead(saved, own));
  }

  // One new value seen in a post. Returns the lead (changed or the same object) and what changed.
  function applyValue(lead, f, value, key, at, extra, changes) {
    const cur = fieldValue(lead, f);
    if (cur && sameValue(f, cur, value)) {
      if (lead.pending && lead.pending[f]) { const p = { ...lead.pending }; delete p[f]; lead = { ...lead, pending: p }; if (!Object.keys(p).length) delete lead.pending; }
      return lead;
    }
    const fill = !cur || (f === 'designation' && isGenericTitle(cur) && !isGenericTitle(value));
    if (!fill) {
      if (f === 'designation' && isGenericTitle(value)) return lead;   // a fallback never replaces a real title
      if (f === 'linkedinProfile') return lead;                          // a different profile is never written over
      const pend = lead.pending && lead.pending[f];
      const fresh = pend && Number.isFinite(ms(pend.at)) && ms(at) - ms(pend.at) <= PENDING_DAYS * DAY;
      if (!(fresh && sameValue(f, pend.v, value) && Array.isArray(pend.keys) && !pend.keys.includes(key))) {
        if (fresh && sameValue(f, pend.v, value)) return lead;            // the same post again: nothing new
        return { ...lead, pending: { ...(plain(lead.pending) ? lead.pending : {}), [f]: { v: clip(value, 200), keys: [key], at } } };
      }
    }
    const next = { ...lead, [f]: value, ...extra };
    if (plain(next.pending) && next.pending[f]) { next.pending = { ...next.pending }; delete next.pending[f]; if (!Object.keys(next.pending).length) delete next.pending; }
    next.fieldHistory = pushHistory(lead, { f, from: cur, to: value, at, src: 'post', k: key });
    if (cur) next.activity = pushActivity(lead, at, `${FIELD_LABELS[f]} updated from a post: ${clip(cur, 60)} → ${clip(value, 60)}`);
    changes.push(f);
    return next;
  }

  function refreshLead(saved, pageLead, nowIso, ctx) {
    const changes = [];
    const key = (BP.PostLog && BP.PostLog.keyOf(pageLead)) || '';
    const postedMs = ms(pageLead.postedAt);
    const at = Number.isFinite(postedMs) && postedMs <= ms(nowIso) + 3600000 ? new Date(postedMs).toISOString() : nowIso;
    let lead = saved;
    if (!(ms(lead.lastSeenAt) >= ms(at))) lead = { ...lead, lastSeenAt: at };
    // A marked-bounced address or a shared inbox (hr@, jobs@) only gets "last seen": its title and phone are not one person's.
    if (lead.bounced === true || !(BP.emailLooksPersonal && BP.emailLooksPersonal(lead.email)) || !key) return { lead, changes };
    const pProfile = BP.safeHttpUrl ? BP.safeHttpUrl(pageLead.linkedinProfile) : '';
    const sProfile = fieldValue(lead, 'linkedinProfile');
    if (pProfile && sProfile && profileKey(pProfile) && profileKey(sProfile) && profileKey(pProfile) !== profileKey(sProfile)) return { lead, changes };
    if (pProfile && !sProfile && !isLocked(lead, 'linkedinProfile')) lead = applyValue(lead, 'linkedinProfile', pProfile, key, nowIso, {}, changes);
    const title = clip(pageLead.designation, 120);
    if (title && !isPlaceholder(title) && !isLocked(lead, 'designation')) lead = applyValue(lead, 'designation', title, key, nowIso, {}, changes);
    const phone = clip(pageLead.phone, 40);
    const pk = phoneKey(phone);
    if (pk && !isLocked(lead, 'phone') && !ctx.switchboard(pk)) {
      const extra = {};
      if (pageLead.phoneType !== undefined && BP.normalizePhoneType) extra.phoneType = BP.normalizePhoneType(pageLead.phoneType);
      if (pageLead.phoneExt) extra.phoneExt = clip(pageLead.phoneExt, 12);
      lead = applyValue(lead, 'phone', phone, key, nowIso, extra, changes);
    }
    return { lead, changes };
  }

  // One pass per page scan. Returns the SAME array when nothing changed, so the caller writes nothing.
  function refresh(allLeads, pageLeads, now, opts) {
    const list = Array.isArray(allLeads) ? allLeads : [];
    const pages = Array.isArray(pageLeads) ? pageLeads : [];
    const nowIso = isoOf(now);
    if (!pages.length || !list.length) return { allLeads: list, changed: 0, updated: [] };
    const wanted = new Set(pages.map(p => lc(p && p.email)).filter(Boolean));
    const idx = new Map();
    list.forEach((l, i) => { const e = lc(l && l.email); if (wanted.has(e) && !idx.has(e)) idx.set(e, i); });
    if (!idx.size) return { allLeads: list, changed: 0, updated: [] };
    let phones = null;   // built once, only when a phone is about to be written
    const ctx = {
      switchboard(pk) {
        if (!phones) { phones = new Map(); for (const l of list) { const k = phoneKey(l && l.phone); if (k) phones.set(k, (phones.get(k) || 0) + 1); } }
        return (phones.get(pk) || 0) > SWITCHBOARD;
      }
    };
    const own = opts && opts.own;
    let out = null;
    const updated = new Set();
    let changed = 0;
    for (const p of pages) {
      const e = lc(p && p.email);
      if (!idx.has(e)) continue;
      const i = idx.get(e);
      const saved = (out || list)[i];
      if (!eligible(p, saved, own)) continue;
      const r = refreshLead(saved, p, nowIso, ctx);
      if (r.lead === saved) continue;
      if (!out) out = list.slice();
      out[i] = r.lead;
      changed++;
      if (r.changes.length) updated.add(e);
    }
    return out ? { allLeads: out, changed, updated: [...updated] } : { allLeads: list, changed: 0, updated: [] };
  }

  // ── Locks, Restore, Unlock ─────────────────────────────────────────────────────────────────────────────────────────
  // UPDATE_LEAD by hand (not Cleanup's bulk fill): a changed title, phone or profile is the user's, so BenchPilot stops updating it.
  function lockOnEdit(before, after, now) {
    const at = isoOf(now);
    let next = after;
    for (const f of LOCKABLE) {
      const a = fieldValue(before, f), b = fieldValue(after, f);
      if (a === b || (a && b && sameValue(f, a, b))) continue;
      if (next === after) next = { ...after };
      if (!isLocked(next, f)) next.userLocks = locks(next).concat(f);
      next.fieldHistory = pushHistory(next, { f, from: a, to: b, at, src: 'user' });
      if (plain(next.pending) && next.pending[f]) { next.pending = { ...next.pending }; delete next.pending[f]; if (!Object.keys(next.pending).length) delete next.pending; }
    }
    return next;
  }

  // History entry `index` (in lead.fieldHistory) goes back: its old value is written, the change is recorded, and the field is locked.
  function restoreField(lead, index, now) {
    const list = Array.isArray(lead && lead.fieldHistory) ? lead.fieldHistory : [];
    const h = Number.isInteger(index) ? list[index] : null;
    if (!plain(h) || !RESTORABLE.includes(h.f)) return { ok: false, error: 'That change is no longer in the history.' };
    const at = isoOf(now);
    const cur = fieldValue(lead, h.f);
    const old = typeof h.from === 'string' ? h.from : '';
    const next = { ...lead, [h.f]: h.f === 'phone' && !old ? '—' : old };
    if (LOCKABLE.includes(h.f) && !isLocked(next, h.f)) next.userLocks = locks(next).concat(h.f);
    next.fieldHistory = pushHistory(lead, { f: h.f, from: cur, to: old, at, src: 'user' });
    if (plain(next.pending) && next.pending[h.f]) { next.pending = { ...next.pending }; delete next.pending[h.f]; if (!Object.keys(next.pending).length) delete next.pending; }
    return { ok: true, lead: next };
  }

  function unlockField(lead, f) {
    if (!isLocked(lead, f)) return lead;
    const next = { ...lead, userLocks: locks(lead).filter(x => x !== f) };
    if (!next.userLocks.length) delete next.userLocks;
    return next;
  }

  // ── Heat and role tags (spec 3.3, 3.4) ─────────────────────────────────────────────────────────────────────────────
  // input: { posts: [{ ms }], firstSavedMs, replyMs, goodSubMs, eligible }
  // heatOf is ONE vendor's own level: 'active' | 'cold' | ''. It never says 'hot': Hot compares a vendor with the rest of the
  // book, so only rankHeat (called by vendorStats with every vendor) gives it.
  function heatOf(input, now) {
    const x = input || {};
    if (x.eligible === false) return '';
    const t = nowMsOf(now);
    const within = (m, days) => Number.isFinite(m) && m > 0 && t - m < days * DAY;
    const posts = Array.isArray(x.posts) ? x.posts : [];
    if (posts.some(p => within(p.ms, HEAT.activeDays)) || within(x.replyMs, HEAT.replyActiveDays)) return 'active';
    if (Number.isFinite(x.firstSavedMs) && t - x.firstSavedMs >= HEAT.newVendorDays * DAY) return 'cold';
    return '';
  }

  // How strongly one vendor competes for Hot: { posts30, score }. score 0 = cannot be Hot (too few posts, or not eligible).
  function heatScore(input, now) {
    const x = input || {};
    const t = nowMsOf(now);
    const within = (m, days) => Number.isFinite(m) && m > 0 && t - m < days * DAY;
    const posts = Array.isArray(x.posts) ? x.posts : [];
    const posts30 = x.eligible === false ? 0 : posts.filter(p => within(p.ms, 30)).length;
    const lifted = within(x.replyMs, HEAT.liftDays) || within(x.goodSubMs, HEAT.liftDays);
    const candidate = posts30 >= HEAT.hotMinPosts30 || (lifted && posts30 >= 1);
    return { posts30, score: candidate ? posts30 + (lifted ? 1 : 0) : 0 };
  }

  // rows: [{ id, posts30, score, lastPostMs }] for the whole book -> Set of the ids that are Hot: the top hotShare (at least one)
  // of the vendors that posted in 30 days, picked among the candidates; ties go to the newest post, then the id.
  function rankHeat(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
    const posting = list.filter(r => r.posts30 > 0).length;
    if (!posting) return new Set();
    const slots = Math.max(1, Math.round(posting * HEAT.hotShare));
    const ranked = list.filter(r => r.score > 0)
      .sort((a, b) => (b.score - a.score) || ((b.lastPostMs || 0) - (a.lastPostMs || 0)) || String(a.id).localeCompare(String(b.id)));
    return new Set(ranked.slice(0, slots).map(r => r.id));
  }

  // The rule in words, for every screen that explains Heat (dashboard Vendors, the team web app).
  function heatRuleText() {
    return `Hot: the busiest ${Math.round(HEAT.hotShare * 100)}% of the vendors that posted in the last 30 days (at least ${HEAT.hotMinPosts30} requirements, `
      + `or one plus a reply within ${HEAT.liftDays} days). Active: a requirement or a reply in ${HEAT.activeDays} days. Cold: nothing for ${HEAT.activeDays} days.`;
  }

  function roleTags(posts, now) {
    const t = nowMsOf(now);
    const counts = new Map();
    for (const p of Array.isArray(posts) ? posts : []) {
      if (!p || !p.f || p.f === 'Other' || !(t - p.ms < TAGS.days * DAY)) continue;
      counts.set(p.f, (counts.get(p.f) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const real = ranked.filter(([, c]) => c >= TAGS.min);
    return {
      tags: real.slice(0, TAGS.top).map(([family, count]) => ({ family, count })),
      more: Math.max(0, real.length - TAGS.top),
      seenOnce: ranked.filter(([, c]) => c < TAGS.min).map(([f]) => f)
    };
  }
  function tagsText(tags, more) {
    const list = (tags || []).map(x => `${x.family} (${x.count})`).join(', ');
    return list ? list + (more ? ` +${more} more` : '') : '';
  }

  function lastReplyMs(sub) {
    let at = 0;
    for (const h of Array.isArray(sub && sub.history) ? sub.history : []) {
      if (h && h.status && h.status !== 'Submitted') { const x = ms(h.at); if (x > at) at = x; }
    }
    if (!at && sub && sub.status && sub.status !== 'Submitted') { const x = ms(sub.updatedAt) || ms(sub.submittedAt); if (x > 0) at = x; }
    return at;
  }
  function goodSubMs(sub) {
    let at = 0;
    for (const h of Array.isArray(sub && sub.history) ? sub.history : []) if (h && GOOD_SUB.has(h.status)) { const x = ms(h.at); if (x > at) at = x; }
    if (!at && sub && GOOD_SUB.has(sub.status)) { const x = ms(sub.updatedAt) || ms(sub.submittedAt); if (x > 0) at = x; }
    return at;
  }

  // state: { allLeads, companies, postLogs, submissions }. One entry per company that has at least one saved recruiter.
  function vendorStats(state, now) {
    const st = state || {};
    const t = nowMsOf(now);
    const comp = new Map();
    for (const c of Array.isArray(st.companies) ? st.companies : []) if (c && c.id) comp.set(c.id, c);
    const out = new Map();
    const get = (id) => {
      let v = out.get(id);
      if (!v) out.set(id, v = { posts: [], keys: new Set(), firstSavedMs: Infinity, replyMs: 0, goodSubMs: 0, recruiters: 0 });
      return v;
    };
    for (const l of Array.isArray(st.allLeads) ? st.allLeads : []) {
      if (!l || l.sample === true || !l.companyId) continue;
      const v = get(l.companyId);
      v.recruiters++;
      const saved = ms(l.savedAt);
      if (Number.isFinite(saved) && saved < v.firstSavedMs) v.firstSavedMs = saved;
      for (const p of postsOf(l, st.postLogs)) {
        if (v.keys.has(p.k)) continue;
        v.keys.add(p.k);
        v.posts.push(p);
      }
    }
    for (const s of Array.isArray(st.submissions) ? st.submissions : []) {
      if (!s || s.sample === true || !s.companyId || !out.has(s.companyId)) continue;
      const v = out.get(s.companyId);
      const r = lastReplyMs(s); if (r > v.replyMs) v.replyMs = r;
      const g = goodSubMs(s); if (g > v.goodSubMs) v.goodSubMs = g;
    }
    const res = new Map();
    const contest = [];   // every eligible vendor, ranked together for Hot
    for (const [id, v] of out) {
      const c = comp.get(id);
      const eligible = !(c && c.label === 'bench-seller') && Boolean(BP.companyIdForEmail ? BP.companyIdForEmail('x@' + (c && c.domain || id)) : true);
      const within = (days) => v.posts.filter(p => t - p.ms < days * DAY).length;
      const tags = roleTags(v.posts, t);
      const input = { posts: v.posts, firstSavedMs: Number.isFinite(v.firstSavedMs) ? v.firstSavedMs : NaN, replyMs: v.replyMs, goodSubMs: v.goodSubMs, eligible };
      const row = {
        heat: heatOf(input, t),
        posts14: within(14), posts30: within(30), posts60: within(60), postsTotal: v.posts.length,
        lastPostMs: v.posts.reduce((m, p) => Math.max(m, p.ms), 0), replyMs: v.replyMs, recruiters: v.recruiters,
        tags: tags.tags, more: tags.more, seenOnce: tags.seenOnce
      };
      res.set(id, row);
      if (eligible) contest.push({ id, lastPostMs: row.lastPostMs, ...heatScore(input, t) });
    }
    for (const id of rankHeat(contest)) res.get(id).heat = 'hot';
    return res;
  }

  // The recruiter's own role tags (Recruiters tab, lead panel).
  function recruiterTags(lead, postLogs, now) { return roleTags(postsOf(lead, postLogs), now); }

  // Sort helper: Heat first (Hot, Active, Cold, none), then the newest post.
  function compareHeat(a, b) {
    return (HEAT_RANK[b.heat || ''] - HEAT_RANK[a.heat || '']) || ((b.lastPostMs || 0) - (a.lastPostMs || 0));
  }

  // ── Health card (spec 3.6): counts from the SAME helpers Fix my data uses, plus the new rows ─────────────────────────────
  function recentlyUpdated(leads, now, days) {
    const t = nowMsOf(now);
    const span = (days || 7) * DAY;
    const out = [];
    for (const l of Array.isArray(leads) ? leads : []) {
      if (!l || l.sample === true) continue;
      const h = Array.isArray(l.fieldHistory) ? l.fieldHistory : [];
      h.forEach((e, index) => {
        if (plain(e) && e.src === 'post' && t - ms(e.at) < span) out.push({ email: l.email, name: (BP.cleanPersonName && BP.cleanPersonName(l.recruiterName)) || l.email, index, f: e.f, from: e.from, to: e.to, at: e.at });
      });
    }
    return out.sort((a, b) => ms(b.at) - ms(a.at));
  }

  // state: { allLeads, companies, cleanupDismissed, postLogs, submissions }. stats: vendorStats result (computed when left out).
  function health(state, now, stats) {
    const st = state || {};
    const leads = (Array.isArray(st.allLeads) ? st.allLeads : []).filter(l => l && l.sample !== true);
    const vs = stats || vendorStats(st, now);
    const safe = (fn, dflt) => { try { return fn(); } catch (_) { return dflt; } };
    const missing = BP.missingDataCounts ? BP.missingDataCounts(leads) : {};
    const updated = recentlyUpdated(leads, now, 7);
    const groups = safe(() => BP.findDuplicateGroups(leads, st.cleanupDismissed), []);
    const rows = [
      { key: 'moves', count: pendingMoves(st).length },
      { key: 'duplicates', count: groups.length },
      { key: 'cold', count: [...vs.values()].filter(v => v.heat === 'cold').length },
      { key: 'noPhone', count: missing.noPhone || 0 },
      { key: 'noCompany', count: missing.noCompany || 0 },
      { key: 'benchSellers', count: safe(() => BP.benchSellerSuspects(leads, st.companies).length, 0) },
      { key: 'emailOwner', count: safe(() => BP.emailOwnerSuspects(leads, st.companies).length, 0) },
      { key: 'bounced', count: leads.filter(l => l.bounced === true).length }
    ];
    // "Things to check" = rows that need a decision (missing phones fill themselves as posts are seen, so they are not counted).
    const total = rows.filter(r => ['moves', 'duplicates', 'benchSellers', 'emailOwner', 'bounced'].includes(r.key)).reduce((n, r) => n + r.count, 0);
    const withProfile = leads.filter(l => BP.safeHttpUrl && BP.safeHttpUrl(l.linkedinProfile)).length;
    return { rows, total, recruiters: leads.length, vendors: vs.size, withProfile, updated, updatedContacts: new Set(updated.map(u => lc(u.email))).size,
      safeGroups: safeGroups(groups).length };
  }

  // Built-in smart lists (spec 3.5): always current, nothing stored.
  function listCounts(state, now, stats) {
    const st = state || {};
    const t = nowMsOf(now);
    const vs = stats || vendorStats(st, now);
    let hot = 0, cold = 0, replied30 = 0;
    for (const v of vs.values()) {
      if (v.heat === 'hot') hot++;
      if (v.heat === 'cold') cold++;
      if (v.replyMs && t - v.replyMs < 30 * DAY) replied30++;
    }
    const noPhone = (Array.isArray(st.allLeads) ? st.allLeads : []).filter(l => l && l.sample !== true && isPlaceholder(l.phone)).length;
    return { hot, cold, replied30, noPhone };
  }

  // When BenchPilot last saw a post from this recruiter (ms, 0 = never): lastSeenAt, or the newest known post (the saved one or the
  // post log). Computed, so the schema 13 upgrade does not have to rewrite (and re-sync) every saved lead.
  function lastSeenMs(lead, postLogs) {
    let best = ms(lead && lead.lastSeenAt);
    if (!Number.isFinite(best)) best = 0;
    const own = firstPostMs(lead);
    if (own > best) best = own;
    const list = plain(postLogs) && lead ? postLogs[lc(lead.email)] : null;
    for (const e of Array.isArray(list) ? list : []) { const x = ms(e && e.at); if (x > best) best = x; }
    return best;
  }

  // ── Schema 13 (lib/migrations.js): damaged vendor-book fields are dropped. A lead with nothing to fix is the same object. ──
  function cleanLead(lead) {
    if (!plain(lead)) return lead;
    let next = lead;
    const edit = () => { if (next === lead) next = { ...lead }; return next; };
    if (lead.userLocks !== undefined) {
      const ok = Array.isArray(lead.userLocks) ? [...new Set(lead.userLocks.filter(f => LOCKABLE.includes(f)))] : [];
      if (!ok.length) delete edit().userLocks;
      else if (ok.length !== lead.userLocks.length) edit().userLocks = ok;
    }
    if (lead.fieldHistory !== undefined && !Array.isArray(lead.fieldHistory)) delete edit().fieldHistory;
    else if (Array.isArray(lead.fieldHistory) && (lead.fieldHistory.length > HISTORY_MAX || lead.fieldHistory.some(h => !plain(h)))) edit().fieldHistory = lead.fieldHistory.filter(plain).slice(-HISTORY_MAX);
    if (lead.pending !== undefined && !plain(lead.pending)) delete edit().pending;
    if (lead.lastSeenAt !== undefined && !Number.isFinite(ms(lead.lastSeenAt))) delete edit().lastSeenAt;
    return next;
  }

  // ── Job changes (spec 3.2, slice 2; slice 4's profile signal) ──────────────────────────────────────────────────────────
  // Passive only: a post the user scrolled past, or a profile the user opened. BenchPilot never visits a profile by itself.
  // A suggestion is stored in `vendorMoves` (derived, not in backups, not synced) and changes nothing until the user presses
  // Update contact (MOVE_LEAD, with Undo) or Merge (MERGE_LEADS). "Not the same person" remembers the id in cleanupDismissed.
  //   entry: { id, kind: 'email' | 'profile', fromEmail, newEmail, newName, newCompany, newTitle, newPhone, newProfile,
  //            evidence: ['profile' | 'phone'], firstAt, lastAt }
  const MOVES = { max: 200, days: 90, prevEmails: 5, drawer: 50 };
  const nameKey = (name) => {
    const n = normTitle(BP.cleanPersonName ? BP.cleanPersonName(name) : name);
    return n.split(' ').filter(Boolean).length >= 2 ? n : '';
  };
  // Same rule as Fix my data's shared-phone guard (cleanupNamesCompatible), but both names must be known: a move needs a person.
  const namesMatch = (a, b) => Boolean(a && b) && (a === b || a.split(' ').pop() === b.split(' ').pop());
  const bizId = (email) => (BP.companyIdForEmail ? BP.companyIdForEmail(lc(email)) : null);
  const sameCompanyName = (a, b) => {
    if (!normTitle(a) || !normTitle(b)) return false;
    return normTitle(a) === normTitle(b) || Boolean(BP.sameCompany && BP.sameCompany(a, b));
  };
  const moveIdOf = (from, to) => 'jc:' + lc(from) + '>' + lc(to);
  const profileMoveIdOf = (from, company) => 'jc:' + lc(from) + '>p:' + normTitle(company).slice(0, 80);
  // A real hiring contact on the saved side: not a sample, not a bench seller or job seeker, not the user.
  function movable(lead, own) {
    if (!hiringRecruiter(lead)) return false;
    return !(own && BP.isOwnLead && BP.isOwnLead(lead, own));
  }
  // A page lead that may stand for the same person at a new company: the poster's own address (no sharedBy, the address reads as
  // their name or their company), a business domain, a requirement post, a known two-word name.
  function movePageLead(p, own) {
    if (!plain(p) || !p.email || p.sharedBy || p.sample === true || p.fromPostLog === true || p.candidate === 'yes') return false;
    if (p.benchSeller === true || p.recruiterType === 'bench' || p.postType === 'hotlist' || p.postType === 'recruiter-job') return false;
    if (!bizId(p.email) || !(BP.emailLooksPersonal && BP.emailLooksPersonal(p.email)) || !nameKey(p.recruiterName)) return false;
    if (own && BP.isOwnLead && BP.isOwnLead(p, own)) return false;
    const owned = (BP.emailNameOverlap && BP.emailNameOverlap(p.email, p.recruiterName)) ||
      (BP.emailOwnedByAuthor && BP.emailOwnedByAuthor({ email: p.email, authorName: p.recruiterName, authorCompany: p.companyName }));
    return Boolean(owned);
  }
  function validMove(e) {
    return plain(e) && typeof e.id === 'string' && e.id.startsWith('jc:') && (e.kind === 'email' || e.kind === 'profile') &&
      typeof e.fromEmail === 'string' && e.fromEmail && Number.isFinite(ms(e.lastAt)) && (e.kind === 'profile' || (typeof e.newEmail === 'string' && e.newEmail));
  }
  // Drops damaged and old (90+ days) entries and keeps the newest 200. Same array back when nothing was dropped.
  function sanitizeMoves(raw, now) {
    const list = Array.isArray(raw) ? raw : [];
    const t = nowMsOf(now);
    const keep = list.filter(e => validMove(e) && t - ms(e.lastAt) < MOVES.days * DAY);
    const out = keep.length > MOVES.max ? keep.slice().sort((a, b) => ms(b.lastAt) - ms(a.lastAt)).slice(0, MOVES.max) : keep;
    return out.length === list.length ? list : out;
  }
  function upsertMove(list, entry) {
    const i = list.findIndex(e => e.id === entry.id);
    if (i === -1) { list.push(entry); return true; }
    const old = list[i];
    const evidence = [...new Set([...(Array.isArray(old.evidence) ? old.evidence : []), ...entry.evidence])];
    const newer = ms(entry.lastAt) - ms(old.lastAt) >= 3600000;   // seen again within the hour (the same profile reopened): no write
    if (!newer && evidence.length === (old.evidence || []).length) return false;
    list[i] = newer ? { ...old, ...entry, firstAt: old.firstAt, evidence } : { ...old, evidence };
    return true;
  }
  const dismissedSet = (d) => (d instanceof Set ? d : new Set(Array.isArray(d) ? d : []));

  // One pass per page scan, after the refresh. Returns { vendorMoves, changed, found }; the SAME array when nothing changed.
  function detectMoves(allLeads, pageLeads, vendorMoves, now, opts) {
    const o = opts || {};
    const nowIso = isoOf(now);
    const prev = sanitizeMoves(vendorMoves, nowIso);
    let changed = prev !== vendorMoves && Array.isArray(vendorMoves);
    const list = Array.isArray(allLeads) ? allLeads : [];
    const cands = (Array.isArray(pageLeads) ? pageLeads : []).filter(p => movePageLead(p, o.own) && (profileKey(p.linkedinProfile) || phoneKey(p.phone)));
    if (!cands.length || !list.length) return { vendorMoves: prev, changed, found: 0 };
    const dismissed = dismissedSet(o.dismissed);
    const byProfile = new Map(), byPhone = new Map(), byEmail = new Map();
    const bucket = (m, k, l) => { const b = m.get(k); if (b) b.push(l); else m.set(k, [l]); };
    for (const l of list) {
      if (!plain(l) || l.sample === true) continue;
      byEmail.set(lc(l.email), l);
      const pk = profileKey(l.linkedinProfile); if (pk) bucket(byProfile, pk, l);
      const ph = phoneKey(l.phone); if (ph) bucket(byPhone, ph, l);
    }
    const out = prev.slice();
    let found = 0;
    for (const p of cands) {
      const newEmail = lc(p.email);
      const pName = nameKey(p.recruiterName);
      const hits = new Map();   // saved email -> Set(evidence)
      const add = (l, why) => { const k = lc(l.email); if (!hits.has(k)) hits.set(k, new Set()); hits.get(k).add(why); };
      const pk = profileKey(p.linkedinProfile);
      for (const l of pk ? byProfile.get(pk) || [] : []) add(l, 'profile');
      const ph = phoneKey(p.phone);
      const sharers = ph ? byPhone.get(ph) || [] : [];
      // A switchboard, or a number saved on someone with a clearly different name, is no evidence at all.
      if (sharers.length && sharers.length <= SWITCHBOARD && sharers.every(l => !nameKey(l.recruiterName) || namesMatch(nameKey(l.recruiterName), pName))) for (const l of sharers) add(l, 'phone');
      const postedMs = ms(p.postedAt);
      const at = Number.isFinite(postedMs) && postedMs <= ms(nowIso) + 3600000 ? new Date(postedMs).toISOString() : nowIso;
      for (const [email, why] of hits) {
        const r = byEmail.get(email);
        if (!r || email === newEmail || !movable(r, o.own)) continue;
        const fromBiz = bizId(r.email);
        if (!fromBiz || fromBiz === bizId(newEmail)) continue;                 // rule 1: two different business domains
        if (!namesMatch(nameKey(r.recruiterName), pName)) continue;              // rule 3: the same person's name
        if ((Array.isArray(r.previousEmails) ? r.previousEmails : []).map(lc).includes(newEmail)) continue;
        const id = moveIdOf(r.email, newEmail);
        if (dismissed.has(id)) continue;
        const entry = {
          id, kind: 'email', fromEmail: lc(r.email), newEmail, newName: clip(p.recruiterName, 120), newCompany: clip(p.companyName, 120),
          newTitle: clip(p.designation, 120), newPhone: clip(p.phone, 40), newProfile: (BP.safeHttpUrl && BP.safeHttpUrl(p.linkedinProfile)) || '',
          evidence: [...why].sort(), firstAt: at, lastAt: at
        };
        if (upsertMove(out, entry)) { changed = true; found++; }
      }
    }
    if (!changed) return { vendorMoves: prev, changed: false, found: 0 };
    return { vendorMoves: sanitizeMoves(out, nowIso), changed: true, found };
  }

  // The user opened a saved recruiter's LinkedIn profile and it names another current company. profile: { url, name, company, title }.
  // Returns an entry or null. The saved email stays until the user decides (the profile shows no new address).
  function profileMove(lead, profile, now, opts) {
    const o = opts || {};
    const pr = plain(profile) ? profile : {};
    if (!plain(lead) || !movable(lead, o.own)) return null;
    const pk = profileKey(pr.url);
    if (!pk || pk !== profileKey(lead.linkedinProfile)) return null;
    if (!namesMatch(nameKey(lead.recruiterName), nameKey(pr.name))) return null;
    const company = clip(pr.company, 120);
    if (!normTitle(company) || isPlaceholder(company)) return null;
    // Still at the employer of the saved address, or the saved company name: no move.
    if (sameCompanyName(company, lead.companyName)) return null;
    const domain = BP.emailDomain ? BP.emailDomain(lead.email) : '';
    if (domain && BP.domainMatchesCompany && BP.domainMatchesCompany(domain, company)) return null;
    const id = profileMoveIdOf(lead.email, company);
    if (dismissedSet(o.dismissed).has(id)) return null;
    const at = isoOf(now);
    const title = clip(pr.title, 120);
    return { id, kind: 'profile', fromEmail: lc(lead.email), newEmail: '', newName: clip(pr.name, 120), newCompany: company,
      newTitle: title && !isGenericTitle(title) ? title : '', newPhone: '', newProfile: '', evidence: ['profile'], firstAt: at, lastAt: at };
  }
  function addMove(vendorMoves, entry, now) {
    const prev = sanitizeMoves(vendorMoves, now);
    if (!validMove(entry)) return { vendorMoves: prev, changed: prev !== vendorMoves && Array.isArray(vendorMoves) };
    const out = prev.slice();
    const changed = upsertMove(out, entry);
    return changed ? { vendorMoves: sanitizeMoves(out, now), changed: true } : { vendorMoves: prev, changed: prev !== vendorMoves && Array.isArray(vendorMoves) };
  }

  // What the health card shows: the stored suggestions that still apply. state: { allLeads, vendorMoves, cleanupDismissed }.
  //   action 'move'    the new address is not saved: Update contact (MOVE_LEAD)
  //   action 'merge'   the new address is saved as its own record: Merge (MERGE_LEADS, the newer address kept)
  //   action 'profile' the profile names a new company: Update contact (MOVE_LEAD), the email stays
  function pendingMoves(state) {
    const st = state || {};
    const dismissed = dismissedSet(st.cleanupDismissed);
    const byEmail = new Map();
    for (const l of Array.isArray(st.allLeads) ? st.allLeads : []) if (plain(l) && l.sample !== true && l.email) byEmail.set(lc(l.email), l);
    const out = [];
    for (const e of Array.isArray(st.vendorMoves) ? st.vendorMoves : []) {
      if (!validMove(e) || dismissed.has(e.id)) continue;
      const lead = byEmail.get(lc(e.fromEmail));
      if (!lead || !movable(lead)) continue;
      if (e.kind === 'profile') {
        if (sameCompanyName(e.newCompany, lead.companyName)) continue;
        out.push({ ...e, action: 'profile', lead, other: null });
        continue;
      }
      const other = byEmail.get(lc(e.newEmail)) || null;
      out.push({ ...e, action: other ? 'merge' : 'move', lead, other });
    }
    return out.sort((a, b) => ms(b.lastAt) - ms(a.lastAt));
  }

  // The contact after "Update contact". Keeps notes, status, follow-up date, activity, submissions links (by previousEmails).
  // A locked title or phone stays the user's. Returns { ok, lead, error }. The worker regroups the vendor and moves the post log.
  function applyMove(lead, entry, now) {
    if (!plain(lead) || !validMove(entry) || lc(lead.email) !== lc(entry.fromEmail)) return { ok: false, error: 'That suggestion no longer matches this recruiter.' };
    const at = isoOf(now);
    let next = { ...lead };
    const oldCompany = fieldValue(lead, 'companyName');
    const hist = (f, from, to) => { next.fieldHistory = pushHistory(next, { f, from, to, at, src: 'move' }); };
    if (entry.kind === 'email') {
      const oldEmail = lc(lead.email);
      next.email = lc(entry.newEmail);
      next.previousEmails = [oldEmail, ...(Array.isArray(lead.previousEmails) ? lead.previousEmails.map(lc) : [])]
        .filter((x, i, a) => x && x !== next.email && a.indexOf(x) === i).slice(0, MOVES.prevEmails);
      hist('email', oldEmail, next.email);
      if (next.bounced === true) next.bounced = false;   // the bounced address was the old one
      if (Number.isFinite(ms(entry.lastAt)) && !(ms(next.lastSeenAt) >= ms(entry.lastAt))) next.lastSeenAt = new Date(ms(entry.lastAt)).toISOString();
    }
    const company = clip(entry.newCompany, 120) || (entry.kind === 'email' && BP.companyNameFromDomain ? BP.companyNameFromDomain(BP.emailDomain(entry.newEmail)) : '');
    if (company && !isPlaceholder(company) && company !== oldCompany) { next.companyName = company; hist('companyName', oldCompany, company); }
    const title = clip(entry.newTitle, 120);
    if (title && !isPlaceholder(title) && !isGenericTitle(title) && !isLocked(lead, 'designation') && !sameValue('designation', fieldValue(lead, 'designation'), title)) {
      hist('designation', fieldValue(lead, 'designation'), title);
      next.designation = title;
    }
    const phone = clip(entry.newPhone, 40);
    if (phoneKey(phone) && !isLocked(lead, 'phone') && !sameValue('phone', fieldValue(lead, 'phone'), phone)) {
      hist('phone', fieldValue(lead, 'phone'), phone);
      next.phone = phone;
    }
    const prof = clip(entry.newProfile, 300);
    if (prof && !fieldValue(lead, 'linkedinProfile') && !isLocked(lead, 'linkedinProfile')) { hist('linkedinProfile', '', prof); next.linkedinProfile = prof; }
    if (plain(next.pending)) delete next.pending;   // values waiting for a second post belonged to the old job
    const was = `${oldCompany || 'no company'}${entry.kind === 'email' ? ', ' + lc(lead.email) : ''}`;
    const now2 = `${next.companyName || company || 'a new company'}${entry.kind === 'email' ? ', ' + next.email : ''}`;
    next.activity = pushActivity(lead, at, entry.kind === 'profile'
      ? `Job change (from their LinkedIn profile, confirmed by you): ${clip(was, 80)} → ${clip(now2, 80)}. The saved email may no longer work.`
      : `Job change (confirmed by you): ${clip(was, 80)} → ${clip(now2, 80)}`);
    return { ok: true, lead: next };
  }

  // ── Batch "Merge safe ones" (spec 3.7) ──────────────────────────────────────────────────────────────────────────────
  // Safe = the group still holds together on "Same LinkedIn profile" / "Same name at the same company" links alone. A phone number
  // (alone, or as the only link to one member) or a damaged email never makes a group safe: those stay one group at a time in Fix my data.
  const SAFE_REASONS = new Set(['Same LinkedIn profile', 'Same name at the same company']);
  const BATCH_MAX = 25;
  function safeGroups(groups) {
    return (Array.isArray(groups) ? groups : []).filter(g => {
      if (!g || !Array.isArray(g.reasons) || !g.reasons.some(r => SAFE_REASONS.has(r))) return false;
      if (!Array.isArray(g.emails) || g.emails.length < 2 || g.emails.length > 26 || !Array.isArray(g.leads) || typeof BP.findDuplicateGroups !== 'function') return false;
      // The same group found again without phone numbers: one group, every member, safe reasons only.
      const again = BP.findDuplicateGroups(g.leads.map(l => ({ ...l, phone: '' })));
      return again.length === 1 && again[0].emails.length === g.emails.length && again[0].reasons.every(r => SAFE_REASONS.has(r));
    });
  }

  // ── Smart lists (spec 3.5): a saved rule, never a saved list of names ────────────────────────────────────────────────
  //   { id, name, scope: 'vendors' | 'recruiters', rules: { heat[], families[], repliedWithinDays, notSeenDays, trust[], vendorType[],
  //     hasPhone, hasProfile }, createdAt }. All rules are AND. Free: the four built-in lists. Solo / Pro (feature smartLists): up to 25.
  const SMART = { max: 25, nameMax: 40, valuesMax: 12 };
  const SCOPES = ['vendors', 'recruiters'];
  const HEATS = ['hot', 'active', 'cold'];
  const TRUSTS = ['trusted', 'neutral', 'avoid', 'seller'];
  const VENDOR_TYPES = ['prime-vendor', 'implementation-partner', 'direct-client'];
  const TRUST_WORDS = { trusted: 'Trusted', neutral: 'Neutral', avoid: 'Avoid', seller: 'Bench seller' };
  const TYPE_WORDS = { 'prime-vendor': 'Prime vendor', 'implementation-partner': 'Implementation partner', 'direct-client': 'Direct client' };
  const TYPE_LABEL_KEYS = new Set(VENDOR_TYPES);
  function trustKeyOf(c) { const l = c && c.label; return l === 'bench-seller' ? 'seller' : l === 'trusted' ? 'trusted' : l === 'avoid' ? 'avoid' : 'neutral'; }
  function vendorTypeOf(c) { return c && TYPE_LABEL_KEYS.has(c.label) ? c.label : (c && TYPE_LABEL_KEYS.has(c.tier) ? c.tier : ''); }
  const strList = (v) => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string').map(x => clip(x, 60)).filter(Boolean))].slice(0, SMART.valuesMax) : []);
  const days = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 && n <= max ? n : undefined; };
  // Unknown words (a family or label that no longer exists) are KEPT: the list then shows 0 and a note, and is never deleted by itself.
  function sanitizeRules(raw) {
    const r = plain(raw) ? raw : {};
    const out = {};
    for (const k of ['heat', 'families', 'trust', 'vendorType']) { const v = strList(r[k]); if (v.length) out[k] = k === 'heat' ? v.map(lc) : v; }
    const rep = days(r.repliedWithinDays, 365); if (rep) out.repliedWithinDays = rep;
    const ns = days(r.notSeenDays, 730); if (ns) out.notSeenDays = ns;
    for (const k of ['hasPhone', 'hasProfile']) if (typeof r[k] === 'boolean') out[k] = r[k];
    return out;
  }
  const hasRules = (rules) => Object.keys(sanitizeRules(rules)).length > 0;
  function sanitizeSmartList(raw) {
    if (!plain(raw)) return null;
    const id = typeof raw.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(raw.id) ? raw.id : '';
    const name = clip(String(raw.name || '').replace(/\s+/g, ' '), SMART.nameMax);
    if (!id || !name || !SCOPES.includes(raw.scope)) return null;
    const rules = sanitizeRules(raw.rules);
    if (!Object.keys(rules).length) return null;
    const createdAt = Number.isFinite(ms(raw.createdAt)) ? new Date(ms(raw.createdAt)).toISOString() : new Date(0).toISOString();
    return { id, name, scope: raw.scope, rules, createdAt };
  }
  // Clean stored list, one per id, at most 25. Never deletes a valid list for referring to something that is gone.
  function sanitizeSmartLists(raw) {
    const seen = new Set();
    const out = [];
    for (const x of Array.isArray(raw) ? raw : []) {
      const l = sanitizeSmartList(x);
      if (!l || seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(l);
    }
    return out.slice(0, SMART.max);
  }
  // Words in the rules that BenchPilot no longer knows (a removed role family, an unknown label). Non-empty = the list shows 0.
  function staleRefs(list) {
    const r = (list && list.rules) || {};
    const fam = Array.isArray(BP.ROLE_FAMILIES) ? new Set(BP.ROLE_FAMILIES) : null;
    return [
      ...(r.heat || []).filter(x => !HEATS.includes(x)),
      ...(fam ? (r.families || []).filter(x => !fam.has(x)) : []),
      ...(r.trust || []).filter(x => !TRUSTS.includes(x)),
      ...(r.vendorType || []).filter(x => !VENDOR_TYPES.includes(x))
    ];
  }
  // The rules of what is on screen. view: { heat, trust, tier, family, replied (bool), missing ('phone' | 'linkedin' | ...) }.
  function rulesFromView(scope, view) {
    const v = plain(view) ? view : {};
    const rules = {};
    if (v.heat) rules.heat = [v.heat];
    if (v.family) rules.families = [v.family];
    if (v.trust) rules.trust = [v.trust];
    if (v.tier) rules.vendorType = [v.tier];
    if (v.replied) rules.repliedWithinDays = 30;
    if (scope === 'recruiters' && v.missing === 'phone') rules.hasPhone = false;
    if (scope === 'recruiters' && v.missing === 'linkedin') rules.hasProfile = false;
    if (Number(v.notSeenDays) > 0) rules.notSeenDays = Number(v.notSeenDays);
    return sanitizeRules(rules);
  }
  // One line in words, for the chip's title and the export toast.
  function rulesText(rules) {
    const r = sanitizeRules(rules);
    const parts = [];
    if (r.heat) parts.push('Heat ' + r.heat.map(h => HEAT_LABELS[h] || h).join(' or '));
    if (r.families) parts.push('Hires ' + r.families.join(' or '));
    if (r.repliedWithinDays) parts.push(`replied in ${r.repliedWithinDays} days`);
    if (r.notSeenDays) parts.push(`no post for ${r.notSeenDays}+ days`);
    if (r.trust) parts.push(r.trust.map(t => TRUST_WORDS[t] || t).join(' or '));
    if (r.vendorType) parts.push(r.vendorType.map(t => TYPE_WORDS[t] || t).join(' or '));
    if (r.hasPhone !== undefined) parts.push(r.hasPhone ? 'has a phone' : 'no phone');
    if (r.hasProfile !== undefined) parts.push(r.hasProfile ? 'has a LinkedIn profile' : 'no LinkedIn profile');
    return parts.join(', ');
  }
  const familiesIn = (tags, seenOnce) => new Set([...(tags || []).map(x => x.family), ...(seenOnce || [])]);
  // A vendor row: c (company), v (vendorStats entry), leads (its recruiters). t: now in ms.
  function vendorMatches(rules, c, v, leads, t) {
    const r = rules || {};
    const s = v || {};
    if (r.heat && !r.heat.includes(s.heat || '')) return false;
    if (r.families) { const f = familiesIn(s.tags, s.seenOnce); if (!r.families.some(x => f.has(x))) return false; }
    if (r.repliedWithinDays && !(s.replyMs && t - s.replyMs < r.repliedWithinDays * DAY)) return false;
    if (r.notSeenDays && s.lastPostMs && t - s.lastPostMs < r.notSeenDays * DAY) return false;
    if (r.trust && !r.trust.includes(trustKeyOf(c))) return false;
    if (r.vendorType && !r.vendorType.includes(vendorTypeOf(c))) return false;
    if (r.hasPhone !== undefined && (leads || []).some(l => !isPlaceholder(l.phone)) !== r.hasPhone) return false;
    if (r.hasProfile !== undefined && (leads || []).some(l => BP.safeHttpUrl && BP.safeHttpUrl(l.linkedinProfile)) !== r.hasProfile) return false;
    return true;
  }
  // A recruiter: heat, reply, trust and type come from their vendor; families, last seen, phone and profile are their own.
  function recruiterMatches(rules, lead, c, v, postLogs, t) {
    const r = rules || {};
    const s = v || {};
    if (r.heat && !r.heat.includes(s.heat || '')) return false;
    if (r.families) { const tg = recruiterTags(lead, postLogs, t); const f = familiesIn(tg.tags, tg.seenOnce); if (!r.families.some(x => f.has(x))) return false; }
    if (r.repliedWithinDays && !(s.replyMs && t - s.replyMs < r.repliedWithinDays * DAY)) return false;
    if (r.notSeenDays) { const seen = lastSeenMs(lead, postLogs); if (seen && t - seen < r.notSeenDays * DAY) return false; }
    if (r.trust && !(c && r.trust.includes(trustKeyOf(c)))) return false;
    if (r.vendorType && !(c && r.vendorType.includes(vendorTypeOf(c)))) return false;
    if (r.hasPhone !== undefined && !isPlaceholder(lead.phone) !== r.hasPhone) return false;
    if (r.hasProfile !== undefined && Boolean(BP.safeHttpUrl && BP.safeHttpUrl(lead.linkedinProfile)) !== r.hasProfile) return false;
    return true;
  }
  // -> { ids: company ids (vendors) or emails (recruiters), count, stale: [words] }. state: { allLeads, companies, postLogs, submissions }.
  function evaluateList(list, state, now, stats) {
    const l = sanitizeSmartList(list);
    if (!l) return { ids: [], count: 0, stale: [] };
    const stale = staleRefs(l);
    if (stale.length) return { ids: [], count: 0, stale };
    const st = state || {};
    const t = nowMsOf(now);
    const vs = stats || vendorStats(st, t);
    const comp = new Map();
    for (const c of Array.isArray(st.companies) ? st.companies : []) if (c && c.id) comp.set(c.id, c);
    const leads = (Array.isArray(st.allLeads) ? st.allLeads : []).filter(x => plain(x) && x.sample !== true && x.email);
    const ids = [];
    if (l.scope === 'vendors') {
      const byCo = new Map();
      for (const x of leads) if (x.companyId) { const b = byCo.get(x.companyId); if (b) b.push(x); else byCo.set(x.companyId, [x]); }
      for (const [id, v] of vs) if (vendorMatches(l.rules, comp.get(id) || { id }, v, byCo.get(id), t)) ids.push(id);
    } else {
      for (const x of leads) if (recruiterMatches(l.rules, x, x.companyId ? comp.get(x.companyId) || null : null, x.companyId ? vs.get(x.companyId) : null, st.postLogs, t)) ids.push(lc(x.email));
    }
    return { ids, count: ids.length, stale: [] };
  }
  // The addresses to export for a list: a vendor list exports the recruiters at those vendors. Samples never.
  function listEmails(list, state, now, stats) {
    const l = sanitizeSmartList(list);
    const res = evaluateList(l, state, now, stats);
    if (!l || l.scope === 'recruiters') return res.ids;
    const want = new Set(res.ids);
    return (Array.isArray(state && state.allLeads) ? state.allLeads : []).filter(x => plain(x) && x.sample !== true && x.email && want.has(x.companyId)).map(x => lc(x.email));
  }
  function newListId() { return BP.newId('sl'); }

  // ── Slice 4: the job-change banner (dashboard card and drawer recruiter card share these words) ───────────────────────
  const EVIDENCE_LABELS = { profile: 'Same LinkedIn profile', phone: 'Same phone number' };
  const dayText = (iso) => { const t = ms(iso); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''; };
  // One pendingMoves() entry -> { id, action, kind, fromEmail, newEmail, name, newCompany, text, at }. Both addresses and the evidence
  // are always in the text, so the user can judge (spec section 6).
  function moveSummary(m) {
    if (!plain(m) || !plain(m.lead)) return null;
    const name = (BP.cleanPersonName && BP.cleanPersonName(m.lead.recruiterName)) || m.lead.email;
    const was = `${m.lead.email}${m.lead.companyName ? ` (${m.lead.companyName})` : ''}`;
    let text;
    if (m.action === 'profile') {
      text = `${name}'s LinkedIn profile shows a new company. Was: ${was}. Now: ${m.newCompany}${m.newTitle ? ', ' + m.newTitle : ''}, seen when you opened the profile on ${dayText(m.lastAt)}. The saved email may no longer work.`;
    } else {
      const now = `${m.newEmail}${m.newCompany ? ` (${m.newCompany})` : ''}`;
      const why = (Array.isArray(m.evidence) ? m.evidence : []).map(x => EVIDENCE_LABELS[x] || x).join(', ');
      text = m.action === 'merge'
        ? `${name}: same person, two records. Was: ${was}. New: ${now}, seen in a post on ${dayText(m.lastAt)}. ${why}.`
        : `${name} may have moved. Was: ${was}. New: ${now}, seen in a post on ${dayText(m.lastAt)}. ${why}.`;
    }
    return { id: m.id, action: m.action, kind: m.kind, fromEmail: lc(m.fromEmail), newEmail: lc(m.newEmail), name, newCompany: clip(m.newCompany, 120), text, at: m.lastAt };
  }
  // The pending suggestions the drawer needs (GET_RADAR `moves`): summaries only, newest first, at most `max`.
  function drawerMoves(state, max) {
    return pendingMoves(state).slice(0, Number.isFinite(max) ? max : MOVES.drawer).map(moveSummary).filter(Boolean);
  }
  // The suggestion for a recruiter on a drawer card: the saved (old) address, or the new address the post shows.
  function moveForEmail(moves, email) {
    const e = lc(email);
    if (!e) return null;
    return (Array.isArray(moves) ? moves : []).find(m => m && (m.fromEmail === e || (m.newEmail && m.newEmail === e))) || null;
  }

  // ── Slice 4: per-vendor timeline (dashboard company panel) ──────────────────────────────────────────────────────────
  // state: { allLeads, postLogs, submissions }. Events newest first: posts (the lead's first post + the post log), contacts added,
  // updated (field history), moved here or moved away (job changes), submissions and their replies. Computed, never stored.
  //   -> { events: [{ kind, group, at, email, name, text }], counts: { all, post, contact, submission } }
  // group is the filter: 'post' | 'contact' | 'submission' (a reply is in 'submission').
  const TIMELINE = { max: 500, groups: ['post', 'contact', 'submission'] };
  const SRC_WORDS = { post: 'from a post', user: 'by you', move: 'job change' };
  function vendorTimeline(state, companyId, opts) {
    const st = state || {};
    const o = opts || {};
    const id = lc(companyId);
    const counts = { all: 0, post: 0, contact: 0, submission: 0 };
    if (!id) return { events: [], counts };
    const vendorOf = (email) => lc(BP.companyIdForEmail ? BP.companyIdForEmail(email) : String(email || '').split('@')[1]);
    const nameOf = (l) => (BP.cleanPersonName && BP.cleanPersonName(l.recruiterName)) || lc(l.email);
    const events = [];
    const push = (kind, group, atMs, l, text) => {
      if (!Number.isFinite(atMs)) return;
      events.push({ kind, group, at: new Date(atMs).toISOString(), email: l ? lc(l.email) : '', name: l ? nameOf(l) : '', text: clip(text, 300) });
    };
    const leads = (Array.isArray(st.allLeads) ? st.allLeads : []).filter(l => plain(l) && l.sample !== true && l.email);
    const seenPosts = new Set();
    for (const l of leads) {
      const here = lc(l.companyId) === id;
      const hist = Array.isArray(l.fieldHistory) ? l.fieldHistory.filter(plain) : [];
      if (!here) {
        // Moved away: an address change whose old address belonged to this vendor.
        for (const h of hist) if (h.src === 'move' && h.f === 'email' && vendorOf(h.from) === id) push('moved', 'contact', ms(h.at), l, `${nameOf(l)} moved to ${l.companyName || vendorOf(h.to)} (${lc(h.to)})`);
        continue;
      }
      const first = firstPostMs(l);
      if (Number.isFinite(first)) {
        const k = (BP.PostLog && BP.PostLog.keyOf(l)) || 'own:' + lc(l.email);
        if (!seenPosts.has(k)) { seenPosts.add(k); push('post', 'post', first, l, `Posted: ${clip(l.requirement, 120)}`); }
      }
      const logged = plain(st.postLogs) ? st.postLogs[lc(l.email)] : null;
      for (const e of Array.isArray(logged) ? logged : []) {
        if (!plain(e) || !e.k || seenPosts.has(e.k)) continue;
        seenPosts.add(e.k);
        push('post', 'post', ms(e.at), l, `Posted: ${clip(e.requirement || e.t, 120) || 'a requirement'}`);
      }
      const added = ms(l.savedAt);
      push('added', 'contact', Number.isFinite(added) ? added : ms(l.extractedAt), l, `${nameOf(l)} added${l.designation ? ', ' + clip(l.designation, 80) : ''}`);
      const moveAts = new Set(hist.filter(h => h.src === 'move' && h.f === 'email').map(h => h.at));
      for (const h of hist) {
        if (h.src === 'move' && h.f === 'email') { push('moved', 'contact', ms(h.at), l, `${nameOf(l)} moved here from ${lc(h.from)}`); continue; }
        if (h.src === 'move' && h.f === 'companyName' && moveAts.has(h.at)) continue;   // said by the address line above
        const label = FIELD_LABELS[h.f] || h.f;
        push(h.src === 'move' ? 'moved' : 'updated', 'contact', ms(h.at), l,
          `${nameOf(l)}: ${label} ${clip(h.from, 80) || 'empty'} → ${clip(h.to, 80) || 'empty'} (${SRC_WORDS[h.src] || 'updated'})`);
      }
    }
    for (const s of Array.isArray(st.submissions) ? st.submissions : []) {
      if (!plain(s) || s.sample === true || s.draft === true) continue;
      if (lc(s.companyId || vendorOf(s.recruiterEmail || s.leadEmail || s.email)) !== id) continue;
      const who = clip(s.consultantName, 80) || 'A consultant';
      const role = clip(s.role, 80);
      const lead = { email: s.recruiterEmail || s.leadEmail || '', recruiterName: '' };
      push('submission', 'submission', ms(s.submittedAt), lead, `Submitted ${who}${role ? ' for ' + role : ''}`);
      for (const h of Array.isArray(s.history) ? s.history : []) {
        if (!plain(h) || !h.status || h.status === 'Submitted') continue;
        push('reply', 'submission', ms(h.at), lead, `${clip(h.status, 40)}: ${who}${role ? ', ' + role : ''}`);
      }
    }
    for (const e of events) { counts.all++; counts[e.group]++; }
    const want = TIMELINE.groups.includes(o.group) ? o.group : '';
    const out = (want ? events.filter(e => e.group === want) : events).sort((a, b) => ms(b.at) - ms(a.at));
    return { events: out.slice(0, Number.isFinite(o.max) ? o.max : TIMELINE.max), counts };
  }

  BP.VendorBook = {
    HEAT, HEAT_LABELS, TAGS, HISTORY_MAX, PENDING_DAYS, LOCKABLE, RESTORABLE, FIELD_LABELS, SWITCHBOARD, MOVES, SMART, SCOPES, BATCH_MAX, TIMELINE,
    moveSummary, drawerMoves, moveForEmail, vendorTimeline,
    isGenericTitle, isPlaceholder, firstPostMs, postsOf, refresh, refreshLead, lockOnEdit, restoreField, unlockField, isLocked,
    heatOf, heatScore, rankHeat, heatRuleText, roleTags, tagsText, vendorStats, recruiterTags, compareHeat, recentlyUpdated, health, listCounts, cleanLead, lastSeenMs, lastReplyMs,
    detectMoves, profileMove, addMove, sanitizeMoves, pendingMoves, applyMove, safeGroups, trustKeyOf, vendorTypeOf,
    sanitizeRules, hasRules, sanitizeSmartList, sanitizeSmartLists, staleRefs, rulesFromView, rulesText, evaluateList, listEmails, newListId
  };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
