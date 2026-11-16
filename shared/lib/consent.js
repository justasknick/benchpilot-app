// lib/consent.js - staffing P5 (docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md): a consultant's consent to be marketed, the data-notice
// email draft, the typed contact log, and the two data-rights actions on ONE consultant (export, erase). Pure: no DOM, no chrome.*, no
// clock unless `now` is left out. Needs lib/shared.js first. Exposes BP.Consent.
// Used by the extension (service worker: sanitising and the erase; dashboard: the Consent and contact log panels, the hotlist warning)
// and by the team web app (loaded through webapp/js/bp-lib.js loadConsentLib for the notice draft; webapp/js/consent.js keeps the same
// lists and a parity test, webapp/tests/consent.test.mjs, so the two can never drift).
//
//   Consent fields on a consultant: consentOn ('YYYY-MM-DD', '' = not recorded), consentSource (CONSENT_SOURCES, '' = not recorded),
//   consentNote (<= 200 characters, e.g. "replied I agree to the notice on 3 Nov").
//   Contact notes: contactNotes = [{ id, entity: 'consultant' | 'lead', entityId, kind (CONTACT_KINDS), at (ISO), body (<= 1000), createdAt }].
//   'lead' = a saved recruiter (a vendor contact); entityId = the lead's email (the lead's id). A person types every note: nothing is
//   read from WhatsApp, the phone or any other app, and BenchPilot never sends anything.
//   Erase (eraseConsultant): the consultant record, their résumé files (ids returned for the caller to delete from IndexedDB; sync then
//   writes tombstones, so other computers and the web app's My book drop them too), their contact notes, Match workspace marks and hidden
//   matches go. Submissions stay for the counts, with the name replaced by ERASED_NAME and the free text that may name the person cleared.
//   Staffing P3: the submission's interviews go (the panel and the feedback are about the person); its placement stays (start and end date,
//   rates, PO: the firm's own numbers, so the margin reports still add up). The export lists both.
//   Durable erase list (schema 20, docs/specs/ENCRYPTED_SYNC_SPEC.md section 10.9): the erase also adds { kind: 'consultant', id, at } to
//   erasedIds (ids only, never a name). Sync tombstones are forgotten after 30 days, so a computer offline longer could otherwise bring the
//   person back; erasedIds is synced as the grow-only data set `erased`, merged as a union (sync, backup restore), and applyErasures() removes
//   or anonymises whatever still names an erased consultant, on every computer, for as long as the list exists.
//   The name elsewhere (staffing leftovers, 14 Nov 2026): nameMatches(state, id) lists the quick notes and the contact notes of OTHER records
//   (a saved recruiter, another consultant) whose text has the consultant's full name, so the person can review them before the erase;
//   eraseConsultant(..., { scrub: [{ kind, id }] }) replaces the name with NAME_REMOVED in exactly the ticked ones. Nothing is changed
//   that was not shown and ticked, and the first name alone is never matched (no fuzzy removal). nameRegex is the rule (the team
//   workspace's migration 0053 bp_name_regex and webapp/js/consent.js say the same).
(function (root) {
  'use strict';

  const BP = root.BP = root.BP || {};

  const CONSENT_SOURCES = ['email_reply', 'signed_form', 'verbal_logged', 'other'];
  const CONSENT_SOURCE_LABELS = { email_reply: 'Email reply', signed_form: 'Signed form', verbal_logged: 'Verbal, logged by me', other: 'Other',
    consultant_link: 'Consultant link' };
  // Kept when it comes in, never offered in a picker: 'consultant_link' = the consultant gave it on the team's self-service link (migration 0056).
  const RECORDED_SOURCES = CONSENT_SOURCES.concat(['consultant_link']);
  const CONSENT_NOTE_MAX = 200;
  const CONTACT_KINDS = ['call', 'whatsapp', 'meeting', 'email', 'note'];
  const CONTACT_KIND_LABELS = { call: 'Call', whatsapp: 'WhatsApp', meeting: 'Meeting', email: 'Email', note: 'Note' };
  const CONTACT_ENTITIES = ['consultant', 'lead'];
  const CONTACT_NOTE_MAX = 1000;
  const CONTACT_NOTES_MAX = 5000;            // per computer; the oldest notes go first when it is full
  const ERASED_NAME = 'Erased consultant';
  const NAME_REMOVED = '[name removed]';
  const QUICK_NOTE_TITLE_MAX = 40, QUICK_NOTE_TEXT_MAX = 2000;   // lib/shared.js sanitizeQuickNote
  const NOT_LEGAL_ADVICE = 'A draft to adapt, not legal advice. Fill in the parts in [brackets] and check it with your own adviser.';

  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  const isDay = (v) => ISO_DAY.test(String(v || '')) && Number.isFinite(Date.parse(v));
  const clip = (v, n) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, n);
  const line = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const isoOf = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
  const nowIso = (now) => isoOf(now === undefined ? Date.now() : now) || new Date().toISOString();

  // ── consent ──
  /** The three consent fields, cleaned. A source or note without a date is kept (the date can follow). */
  function cleanConsent(c) {
    const x = c || {};
    return {
      consentOn: isDay(x.consentOn) ? String(x.consentOn) : '',
      consentSource: RECORDED_SOURCES.includes(x.consentSource) ? x.consentSource : '',
      consentNote: line(x.consentNote, CONSENT_NOTE_MAX)
    };
  }
  function hasConsent(c) { return Boolean(c && isDay(c.consentOn)); }
  /** "Recorded 3 Nov 2026 (Email reply)" or ''. */
  function consentText(c) {
    if (!hasConsent(c)) return '';
    const [y, m, d] = String(c.consentOn).split('-').map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const src = CONSENT_SOURCE_LABELS[c.consentSource];
    return `Recorded ${d} ${months[m - 1]} ${y}` + (src ? ` (${src})` : '');
  }
  /** Being marketed (on the bench: matched and on the hotlist) with no consent date: the soft nudge and the hotlist warning. */
  function needsConsent(c) {
    if (!c || hasConsent(c)) return false;
    return typeof BP.onBench === 'function' ? BP.onBench(c) : c.active !== false;
  }

  /**
   * The data-notice email the recruiter sends to the consultant (nothing is sent by BenchPilot). Lists what the firm keeps, why, for how
   * long, who sees it and how to ask for a copy or deletion. The firm fills in its own grievance contact and how long it keeps data.
   * opts: { consultantName, firmName, senderName, grievanceContact, retention }  Every value is optional; a missing one stays a [bracket].
   * Returns { subject, body } (plain text).
   */
  function noticeEmail(opts) {
    const o = opts || {};
    const first = line(o.consultantName, 120).split(' ')[0] || '[first name]';
    const firm = line(o.firmName, 120) || '[your firm name]';
    const sender = line(o.senderName, 120) || '[your name]';
    const contact = line(o.grievanceContact, 200) || '[name and email of the person who handles data requests]';
    const keep = line(o.retention, 80) || '[12 months]';
    const body = [
      `Hi ${first},`,
      '',
      `Before ${firm} markets your profile to vendors and clients, here is what we keep about you, why, and how you can change your mind.`,
      '',
      'What we keep:',
      '- your name, email, phone, location and resume;',
      '- your skills, experience, rate and availability;',
      '- your work authorisation type and the date it ends (never copies or numbers of your documents);',
      '- where we submitted your profile and what happened, and short notes of our calls and messages with you.',
      '',
      'Why: to find roles that fit you, to submit you to them with your agreement, to avoid submitting you twice for the same role, and to follow up on interviews.',
      '',
      'Who sees it: our recruiters. We send your resume and profile to a vendor or client only for a specific role.',
      '',
      `How long: while you are on our bench, and for ${keep} after your last submission or placement. Then we delete it.`,
      '',
      `Your choices: you can ask for a copy of your data, ask us to correct it, or ask us to delete it, and you can withdraw this consent at any time. Write to ${contact}.`,
      '',
      'If you agree to us marketing your profile on these terms, please reply "I agree" to this email.',
      '',
      'Thank you,',
      sender,
      firm
    ].join('\n');
    return { subject: `${firm}: how we keep your profile details`, body };
  }

  // ── contact log ──
  /**
   * One typed note, cleaned; null when it cannot be kept. n: { id?, entity, entityId, kind, at?, body, createdAt? }.
   * `at` (when the call or chat happened) defaults to now; a date in the far future is refused.
   */
  function cleanContactNote(n, now) {
    const x = n || {};
    const entity = CONTACT_ENTITIES.includes(x.entity) ? x.entity : '';
    const entityId = x.entity === 'lead' ? line(x.entityId, 254).toLowerCase() : line(x.entityId, 80);
    const body = clip(x.body, CONTACT_NOTE_MAX);
    if (!entity || !entityId || !body) return null;
    const stamp = nowIso(now);
    let at = isoOf(x.at) || stamp;
    if (Date.parse(at) > Date.parse(stamp) + 2 * 86400000) at = stamp;
    return {
      id: line(x.id, 40) || (typeof BP.newId === 'function' ? BP.newId('cn') : 'cn' + Date.parse(stamp).toString(36)),
      entity, entityId,
      kind: CONTACT_KINDS.includes(x.kind) ? x.kind : 'note',
      at, body,
      createdAt: isoOf(x.createdAt) || stamp
    };
  }
  /** The notes of one consultant or lead, newest first. */
  function notesFor(list, entity, entityId) {
    const id = entity === 'lead' ? String(entityId || '').toLowerCase() : String(entityId || '');
    return (Array.isArray(list) ? list : [])
      .filter((n) => n && n.entity === entity && n.entityId === id)
      .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  }
  /** Adds a note; keeps at most CONTACT_NOTES_MAX (the oldest go). Returns { ok, list, note } | { ok: false, error }. */
  function addContactNote(list, n, now) {
    const note = cleanContactNote(n, now);
    if (!note) return { ok: false, error: 'Write what was said, then save.' };
    const next = (Array.isArray(list) ? list : []).filter((x) => x && x.id !== note.id).concat(note);
    next.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    return { ok: true, list: next.slice(-CONTACT_NOTES_MAX), note };
  }

  // ── export one consultant ──
  const RESUME_META = ['id', 'fileName', 'size', 'type', 'uploadedAt'];
  /**
   * Everything kept about one consultant on this computer. state: { consultants, submissions, contactNotes, matchStatus, notRelevant };
   * resumes: the résumé file records' metadata ([{ id, fileName, size, type, uploadedAt }], from lib/resume-store.js meta; the files
   * themselves are not in the JSON). Returns null when the consultant is not there.
   */
  function consultantExport(state, id, resumes, now) {
    const s = state || {};
    const c = (Array.isArray(s.consultants) ? s.consultants : []).find((x) => x && x.id === id);
    if (!c) return null;
    const subs = (Array.isArray(s.submissions) ? s.submissions : []).filter((x) => x && x.consultantId === id);
    const marks = s.matchStatus && typeof s.matchStatus === 'object' && s.matchStatus[id] ? s.matchStatus[id] : {};
    return {
      format: 'benchpilot-consultant-export', version: 1, exportedAt: nowIso(now),
      consultant: { ...c },
      resumeFiles: (Array.isArray(resumes) ? resumes : []).filter(Boolean).map((r) => Object.fromEntries(RESUME_META.map((k) => [k, r[k] === undefined ? '' : r[k]]))),
      submissions: subs.map((x) => ({ ...x })),
      contactNotes: notesFor(s.contactNotes, 'consultant', id).map((x) => ({ ...x })),
      // Staffing P3: each submission's interviews and placement, also as their own sections (they are inside the submissions too).
      interviews: subs.flatMap((x) => (Array.isArray(x.interviews) ? x.interviews : []).filter((i) => i && typeof i === 'object').map((i) => ({ submissionId: x.id, ...i }))),
      placements: subs.filter((x) => x.placement && typeof x.placement === 'object').map((x) => ({ submissionId: x.id, ...x.placement })),
      matchMarks: { ...marks },
      hiddenMatches: (Array.isArray(s.notRelevant) ? s.notRelevant : []).filter((x) => x && x.consultantId === id).map((x) => ({ ...x }))
    };
  }
  /** The same export as one CSV: section, item, field, value (one row per value; lists joined with "; "). Formula-guarded cells. */
  function consultantCsv(exp) {
    const cell = typeof BP.csvCell === 'function' ? BP.csvCell : (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const val = (v) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join('; ')
      : v && typeof v === 'object' ? JSON.stringify(v) : v == null ? '' : String(v));
    const rows = [['section', 'item', 'field', 'value']];
    const add = (section, item, obj) => { for (const [k, v] of Object.entries(obj || {})) rows.push([section, item, k, val(v)]); };
    if (!exp) return '';
    add('consultant', 1, exp.consultant);
    (exp.resumeFiles || []).forEach((r, i) => add('resume file', i + 1, r));
    (exp.submissions || []).forEach((r, i) => add('submission', i + 1, r));
    (exp.contactNotes || []).forEach((r, i) => add('contact note', i + 1, r));
    (exp.interviews || []).forEach((r, i) => add('interview', i + 1, r));
    (exp.placements || []).forEach((r, i) => add('placement', i + 1, r));
    Object.entries(exp.matchMarks || {}).forEach(([k, v], i) => add('match mark', i + 1, { requirement: k, ...(v && typeof v === 'object' ? v : { value: v }) }));
    (exp.hiddenMatches || []).forEach((r, i) => add('hidden match', i + 1, r));
    return '\ufeff' + rows.map((r) => r.map((x) => cell(x)).join(',')).join('\r\n') + '\r\n';
  }

  // ── the durable erase list (schema 20) ──
  const ERASED_KINDS = ['consultant'];
  const erasedIdOk = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 80 && !/[\u0000-\u001f\s]/.test(v);
  /** A clean erasedIds list: [{ kind, id, at }], one per kind and id (the earliest date kept), oldest first. Never trimmed: an entry dropped
   *  on one computer would be pushed back by the others (and a shorter list must never win anywhere). Ids only, about 50 bytes each. */
  function cleanErasedIds(list) {
    const byKey = new Map();
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || typeof e !== 'object' || !ERASED_KINDS.includes(e.kind) || !erasedIdOk(e.id)) continue;
      const at = isoOf(e.at) || '';
      const k = `${e.kind}:${e.id}`;
      const cur = byKey.get(k);
      if (!cur || (at && (!cur.at || at < cur.at))) byKey.set(k, { kind: e.kind, id: e.id, at });
    }
    return [...byKey.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
  /** The union of two lists (sync, restore): an entry is never taken off. */
  const mergeErasedIds = (a, b) => cleanErasedIds([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
  /** Set of erased consultant ids. */
  function erasedConsultants(list) {
    const out = new Set();
    for (const e of Array.isArray(list) ? list : []) if (e && e.kind === 'consultant' && erasedIdOk(e.id)) out.add(e.id);
    return out;
  }
  /**
   * Makes `state` respect the erase list: every consultant in it is removed with their contact notes, Match marks and hidden matches, and
   * their submissions are anonymised (as eraseConsultant does); a lead's "last pitched" name is cleared when an erased record was still here.
   * state: { consultants, submissions, contactNotes, matchStatus, matchSeen, notRelevant, allLeads }. Returns { patch, fileIds, changed }:
   * `patch` holds only the keys that changed, `fileIds` the résumé files to delete from IndexedDB.
   */
  function applyErasures(state, erasedIds, now) {
    const s = state || {};
    const set = erasedIds instanceof Set ? erasedIds : erasedConsultants(erasedIds);
    const patch = {};
    const fileIds = [];
    if (!set.size) return { patch, fileIds, changed: false };
    const at = nowIso(now);
    const names = new Set();
    if (Array.isArray(s.consultants) && s.consultants.some((c) => c && set.has(c.id))) {
      for (const c of s.consultants) {
        if (!c || !set.has(c.id)) continue;
        const n = line(c.name, 120).toLowerCase();
        if (n) names.add(n);
        for (const f of [c.resumeFileId, ...(Array.isArray(c.resumeVersions) ? c.resumeVersions : [])]) if (typeof f === 'string' && f) fileIds.push(f);
      }
      patch.consultants = s.consultants.filter((c) => !(c && set.has(c.id)));
    }
    if (Array.isArray(s.submissions) && s.submissions.some((x) => x && set.has(x.consultantId) && x.erased !== true)) {
      patch.submissions = s.submissions.map((x) => (x && set.has(x.consultantId) && x.erased !== true ? anonymiseSubmission(x, at) : x));
    }
    if (Array.isArray(s.contactNotes) && s.contactNotes.some((n) => n && n.entity === 'consultant' && set.has(n.entityId))) {
      patch.contactNotes = s.contactNotes.filter((n) => !(n && n.entity === 'consultant' && set.has(n.entityId)));
    }
    for (const k of ['matchStatus', 'matchSeen']) {
      const o = s[k];
      if (o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).some((id) => set.has(id))) {
        patch[k] = { ...o };
        for (const id of Object.keys(o)) if (set.has(id)) delete patch[k][id];
      }
    }
    if (Array.isArray(s.notRelevant) && s.notRelevant.some((x) => x && set.has(x.consultantId))) {
      patch.notRelevant = s.notRelevant.filter((x) => !(x && set.has(x.consultantId)));
    }
    if (names.size && Array.isArray(s.allLeads) && s.allLeads.some((l) => l && names.has(line(l.lastPitchedConsultant, 120).toLowerCase()))) {
      patch.allLeads = s.allLeads.map((l) => (l && names.has(line(l.lastPitchedConsultant, 120).toLowerCase()) ? { ...l, lastPitchedConsultant: '' } : l));
    }
    return { patch, fileIds, changed: Object.keys(patch).length > 0 };
  }

  // ── the consultant's name in other records' free text ──
  /**
   * The full name as a case-insensitive regex: each word of the name (regex characters escaped) joined by any run of spaces, as whole words
   * (not inside a longer word). Group 1 is the character before the name. null when the name is under 3 characters or the erased placeholder.
   */
  function nameRegex(name) {
    const n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    if (n.length < 3 || n.toLowerCase() === ERASED_NAME.toLowerCase()) return null;
    const body = n.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    return new RegExp('(^|[^\\p{L}\\p{N}_])(' + body + ')(?=$|[^\\p{L}\\p{N}_])', 'giu');
  }
  function hasName(text, name) {
    const re = nameRegex(name);
    return Boolean(re && typeof text === 'string' && text && re.test(text));
  }
  /** The text with every full-name match replaced by NAME_REMOVED (what is around it stays). */
  function scrubName(text, name) {
    const re = nameRegex(name);
    return re && typeof text === 'string' ? text.replace(re, (m, pre) => pre + NAME_REMOVED) : text;
  }
  /** One line of text around the first match: "…asked for Ravi Kumar's resume…" ('' when there is none). */
  function nameSnippet(text, name, radius) {
    const re = nameRegex(name);
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ');
    const m = re ? re.exec(t) : null;
    if (!m) return '';
    const r = Number(radius) > 0 ? Number(radius) : 50;
    const at = m.index + m[1].length;
    const from = Math.max(0, at - r), to = Math.min(t.length, at + m[2].length + r);
    return (from > 0 ? '…' : '') + t.slice(from, to).trim() + (to < t.length ? '…' : '');
  }
  /**
   * state: { consultants, quickNotes, contactNotes, allLeads }. The quick notes and the contact notes of other records that have the
   * consultant's full name: [{ kind: 'quick_note' | 'contact_note', id, where, at, snippet }], or [] when there is none.
   */
  function nameMatches(state, id) {
    const s = state || {};
    const c = (Array.isArray(s.consultants) ? s.consultants : []).find((x) => x && x.id === id);
    if (!c || !nameRegex(c.name)) return [];
    const out = [];
    for (const q of Array.isArray(s.quickNotes) ? s.quickNotes : []) {
      if (!q || !q.id) continue;
      const text = [q.title, q.text].filter(Boolean).join(' · ');
      if (hasName(text, c.name)) out.push({ kind: 'quick_note', id: q.id, where: 'Quick note "' + line(q.title, 40) + '"', at: isoOf(q.updatedAt), snippet: nameSnippet(text, c.name) });
    }
    const leads = new Map((Array.isArray(s.allLeads) ? s.allLeads : []).filter((l) => l && l.email).map((l) => [String(l.email).toLowerCase(), l]));
    const people = new Map((Array.isArray(s.consultants) ? s.consultants : []).filter((x) => x && x.id).map((x) => [x.id, x]));
    for (const n of Array.isArray(s.contactNotes) ? s.contactNotes : []) {
      if (!n || !n.id || (n.entity === 'consultant' && n.entityId === id) || !hasName(n.body, c.name)) continue;
      const owner = n.entity === 'lead' ? leads.get(String(n.entityId).toLowerCase()) : people.get(n.entityId);
      const who = n.entity === 'lead' ? line(owner && (owner.recruiterName || owner.email), 80) || 'a saved recruiter' : line(owner && owner.name, 80) || 'a consultant';
      out.push({ kind: 'contact_note', id: n.id, where: 'Contact log of ' + who, at: isoOf(n.at), snippet: nameSnippet(n.body, c.name) });
    }
    return out;
  }

  // ── erase one consultant ──
  /** A submission with the person taken out: the counts, dates, statuses, role and rates stay; the name and free text go. */
  function anonymiseSubmission(sub, at) {
    const out = { ...sub, consultantName: ERASED_NAME, visa: '', rtrNote: '', overrideReason: '', erased: true, updatedAt: at };
    if (Array.isArray(sub.interviews)) out.interviews = [];   // staffing P3: the panel and feedback are about the person; the placement stays
    if (Array.isArray(sub.history)) out.history = sub.history.map((h) => (h && typeof h === 'object' ? { ...h, note: '' } : h));
    if (out.draft !== undefined && typeof out.draft !== 'boolean') out.draft = false;
    return out;
  }
  /**
   * state: { consultants, submissions, contactNotes, quickNotes, matchStatus, matchSeen, notRelevant, allLeads, erasedIds }. Returns
   * { ok, patch, fileIds, submissions, notes, scrubbed } where `patch` is the chrome.storage.local change (only keys that changed) and
   * `fileIds` the résumé files to delete from IndexedDB. A lead's "last pitched" name is cleared when it is this consultant's name.
   * opts.scrub: the nameMatches entries the person ticked ([{ kind, id }]); only those lose the name, and only where it still appears.
   */
  function eraseConsultant(state, id, now, opts) {
    const s = state || {};
    const o = opts || {};
    const list = Array.isArray(s.consultants) ? s.consultants : [];
    const c = list.find((x) => x && x.id === id);
    if (!c) return { ok: false, error: 'That consultant is no longer here.' };
    const at = nowIso(now);
    const patch = { consultants: list.filter((x) => !(x && x.id === id)) };
    let subsN = 0;
    if (Array.isArray(s.submissions) && s.submissions.some((x) => x && x.consultantId === id)) {
      patch.submissions = s.submissions.map((x) => (x && x.consultantId === id ? (subsN++, anonymiseSubmission(x, at)) : x));
    }
    const picked = new Set((Array.isArray(o.scrub) ? o.scrub : []).filter((x) => x && typeof x.id === 'string').map((x) => x.kind + ':' + x.id));
    let notesN = 0, scrubbed = 0;
    if (Array.isArray(s.contactNotes)) {
      let changed = false;
      const kept = s.contactNotes.filter((n) => !(n && n.entity === 'consultant' && n.entityId === id)).map((n) => {
        if (!n || !picked.has('contact_note:' + n.id) || !hasName(n.body, c.name)) return n;
        changed = true; scrubbed++;
        return { ...n, body: clip(scrubName(n.body, c.name), CONTACT_NOTE_MAX) };
      });
      notesN = s.contactNotes.length - kept.length;
      if (notesN || changed) patch.contactNotes = kept;
    }
    if (Array.isArray(s.quickNotes) && s.quickNotes.some((q) => q && picked.has('quick_note:' + q.id))) {
      let changed = false;
      const next = s.quickNotes.map((q) => {
        if (!q || !picked.has('quick_note:' + q.id) || !hasName([q.title, q.text].filter(Boolean).join(' · '), c.name)) return q;
        changed = true; scrubbed++;
        return { ...q, title: line(scrubName(q.title || '', c.name), QUICK_NOTE_TITLE_MAX), text: clip(scrubName(q.text || '', c.name), QUICK_NOTE_TEXT_MAX), updatedAt: at };
      });
      if (changed) patch.quickNotes = next;
    }
    if (s.matchStatus && typeof s.matchStatus === 'object' && s.matchStatus[id] !== undefined) {
      patch.matchStatus = { ...s.matchStatus }; delete patch.matchStatus[id];
    }
    if (s.matchSeen && typeof s.matchSeen === 'object' && s.matchSeen[id] !== undefined) {
      patch.matchSeen = { ...s.matchSeen }; delete patch.matchSeen[id];
    }
    if (Array.isArray(s.notRelevant) && s.notRelevant.some((x) => x && x.consultantId === id)) {
      patch.notRelevant = s.notRelevant.filter((x) => !(x && x.consultantId === id));
    }
    const name = line(c.name, 120).toLowerCase();
    if (name && Array.isArray(s.allLeads) && s.allLeads.some((l) => l && line(l.lastPitchedConsultant, 120).toLowerCase() === name)) {
      patch.allLeads = s.allLeads.map((l) => (l && line(l.lastPitchedConsultant, 120).toLowerCase() === name ? { ...l, lastPitchedConsultant: '' } : l));
    }
    const fileIds = [c.resumeFileId, ...(Array.isArray(c.resumeVersions) ? c.resumeVersions : [])].filter((x) => typeof x === 'string' && x);
    // Schema 20: the id goes on the durable erase list, so no computer (one offline for months included) and no restore brings the person back.
    if (erasedIdOk(id)) patch.erasedIds = mergeErasedIds(s.erasedIds, [{ kind: 'consultant', id, at }]);
    return { ok: true, patch, fileIds, submissions: subsN, notes: notesN, scrubbed };
  }

  BP.Consent = {
    CONSENT_SOURCES, RECORDED_SOURCES, CONSENT_SOURCE_LABELS, CONSENT_NOTE_MAX, CONTACT_KINDS, CONTACT_KIND_LABELS, CONTACT_ENTITIES, CONTACT_NOTE_MAX,
    CONTACT_NOTES_MAX, ERASED_NAME, NAME_REMOVED, NOT_LEGAL_ADVICE,
    cleanConsent, hasConsent, consentText, needsConsent, noticeEmail,
    cleanContactNote, notesFor, addContactNote,
    consultantExport, consultantCsv, anonymiseSubmission, eraseConsultant,
    ERASED_KINDS, cleanErasedIds, mergeErasedIds, erasedConsultants, applyErasures,
    nameRegex, hasName, scrubName, nameSnippet, nameMatches
  };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP.Consent;
}
