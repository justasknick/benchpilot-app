// lib/migrations.js - Storage schema versions and the pure company logic built on them.
// Everything here takes a state object and returns a new one; nothing touches chrome.storage.
// The service worker (the single writer) loads it via importScripts and persists the result.
//
// State shape: { schemaVersion, allLeads: [...], companies: [...] }
//   schemaVersion absent = 1 (v1.0 - v1.4 data, no companies).
//   2 = companies[] exists; every lead has companyId (string | null) and bounced (boolean).
//   3 = v1.7: submissions[] (the duplicate / RTR guard's history) and notRelevant[] exist. Old pitch history is seeded
//       into submissions as source 'seeded' records, which can only ever raise soft warnings (docs/specs/V1_7_SPEC.md section 7).
//   4 = E1: role families were added (ServiceNow, Workday, Oracle / PeopleSoft, Pega, Guidewire, Security / Cyber, Network / Infra,
//       Data analyst / BI, Mainframe). The family strings copied into submissions[] and notRelevant[] are refreshed when the
//       requirement title now clearly belongs to another family. Nothing is removed and old family names stay valid.
//   5 = W2 support: every consultant has taxTerms ('C2C' | 'W2' | '1099' | 'Any'). Existing consultants get 'C2C', because matching
//       always treated bench consultants as C2C, so nobody's matches change on update.
//   6 = recruiter type: every lead gets recruiterType ('tech' | 'bench' | 'company-hr' | 'unknown') and recruiterTypeManual (true when the user
//       chose it, including an old bench-seller mark). benchSeller is kept in step (bench = true). Nothing else changes.
//   7 = Match workspace: matchStatus { [consultantId]: { [leadKey]: { status, at } } } holds Pitched / Submitted / Skipped / Not relevant per
//       consultant and requirement (lib/match-workspace.js). Starts empty; an existing valid value is kept (cleaned), so nobody's data changes.
//   8 = v1.17 clean data: unknown stays unknown. The made-up defaults "Tier 1" (tierLevel) and "Direct Client" (directClientVms, unless the
//       saved notes say "direct client") become blank, a team mailbox (hr@, jobs@) loses the person name made from its address ("Hr") and gets
//       teamMailbox: true, and a posted date read from a tenure or a year-old label ("1 yr", "11 mos") is dropped (the saved date is used).
//       The install-time Settings defaults "Tier 1" / "Direct Client" are cleared too. Every changed value is kept in schemaUpgradeBackupV8.
//   9 = extension team mode: a lead may carry teamId (the team book it was copied to; absent = personal book only) and syncedToTeam
//       (true once the team book has it). Absent stays absent, so no existing lead changes; a damaged teamId is dropped together with
//       its syncedToTeam, and a non-boolean syncedToTeam becomes false (it is sent again).
//  10 = v1.19 vendor memory: postLogs { [email]: [post, ...] } holds the later requirement posts of saved recruiters (lib/post-log.js).
//       Starts empty; an existing value is cleaned. No lead changes. A damaged value that had to be cleaned is kept as it was in
//       schemaUpgradeBackupV10, like the v8 upgrade does.
//  11 = no monthly contact limit (every plan is unlimited since v1.20): the retired keys `usage` (the monthly reveal counter) and
//       `bp_autosave_paused` (why autosave switched itself off near the limit) are removed. Nothing the user saved changes.
//  12 = do-not-email list: doNotEmail [{ email, at, reason }] (lib/do-not-email.js). Starts empty; an existing value is cleaned. No lead
//       changes. The per-recruiter contact type is the existing recruiterType / recruiterTypeManual (schema 6), so nothing else is added.
//  13 = Vendor Book (lib/vendor-book.js): a lead may carry lastSeenAt, fieldHistory, userLocks and pending (absent = empty / not known yet).
//       Nothing is seeded: "last seen" is computed from the saved post and the post log until a new post sets lastSeenAt, so the upgrade
//       does not rewrite (and re-sync) every lead. A damaged vendor-book field (e.g. from an edited backup) is dropped; nothing else changes.
//  14 = staffing P1 consultant profile: every consultant gets visaType (a BP.VISA_TYPES code read from the free-text visa, '' when none),
//       workAuthUntil ('' = not recorded; a date only, never a document), availableOn (a date read from the free-text availability when
//       it reads clearly, e.g. "Immediate" = the upgrade day, "2 weeks"; else ''), rateMin (null) with rateUnit ('hr'), and benchStatus
//       (from the Active switch: 'marketing' or 'inactive'). Every old field, visa and availability included, is kept as it was.
//  15 = P2 RTR, rates and the vendor chain: every submission gets rtrOn (the day the RTR was given; from the old rtrConfirmed tick it is
//       the day the record was submitted), rtrUntil, rtrRate, rtrRequestedOn, billRate (read from rateAsked when it parses), payRate,
//       rateUnit ('hr'), taxTerms and chain ([]). rtrConfirmed is removed. Nothing else changes; rateAsked stays as the text shown.
//  16 = vendor agreements (staffing P6, lib/vendor-agreements.js): a company may carry msaStatus, msaSignedOn, msaUntil, ndaStatus,
//       ndaSignedOn, ndaUntil, netTerms and paymentNote (absent = nothing recorded). Nothing is seeded, so no company changes; a company
//       that already holds agreement fields (an edited backup, another computer) keeps only the clean, non-default ones.
//  17 = staffing P5 consent and contact log (lib/consent.js): contactNotes [{ id, entity, entityId, kind, at, body, createdAt }] exists
//       (starts empty; an existing value is cleaned). A consultant MAY carry consentOn / consentSource / consentNote: absent = not
//       recorded, so no consultant is rewritten (and re-synced) by the upgrade; a damaged consent value is cleaned.
//  18 = staffing P3 interviews and placements (lib/placements.js): every submission gets interviews ([]: round, time and zone, mode, panel,
//       feedback, outcome each) and placement (null: start and end date, bill and pay rate, unit, tax terms, PO, status). A value already
//       there (synced from a computer on 18) is kept; lib/placements.js cleans every value it reads and writes. Nothing is invented: a record
//       already at Placed gets no placement until the person enters its start date.
//  19 = staffing P4 targets (lib/targets.js): targets { week?, month? } holds the person's own targets (submissions, interviews, placements
//       per week or month) shown on Insights. Starts empty ({}); an existing value (synced from a computer on 19, or an edited backup) is
//       cleaned and kept. No lead, consultant or submission changes.
//  20 = the durable erase list (lib/consent.js, docs/specs/ENCRYPTED_SYNC_SPEC.md section 10.9): erasedIds [{ kind: 'consultant', id, at }]
//       (ids only, never a name) exists. Starts empty; an existing value (synced from a computer on 20, or a backup) is cleaned. "Erase this
//       consultant" adds to it; sync merges it as a grow-only union and never keeps a record naming an erased consultant. Nothing else changes.
//  21 = timesheets and invoices on a placement (lib/invoicing.js; migration 0055 is the team twin): every submission gets timesheets ([]:
//       one week each, Monday start, regular and overtime hours, who approved them, draft / submitted / approved, the invoice it is on) and
//       invoices ([]: number, period, hours, rates, invoice and due date, draft / sent / paid, sent and paid days). A value already there
//       (synced from a computer on 21) is kept as long as it is a list; lib/invoicing.js cleans every value it reads and writes. The person's
//       own invoice details (invoiceProfile) and commission rule (commissionRule) are settings: absent = not set, nothing is seeded.

(function (root) {
  'use strict';

  // Node tests load this file directly; the browser has shared.js loaded before it.
  if (!root.BP && typeof require === 'function') require('./shared.js');
  if (!root.BPMatchWS && typeof require === 'function') { try { require('./match-workspace.js'); } catch (_) { /* optional */ } }
  if (!(root.BP && root.BP.PostLog) && typeof require === 'function') { try { require('./post-log.js'); } catch (_) { /* optional */ } }
  if (!(root.BP && root.BP.VendorBook) && typeof require === 'function') { try { require('./vendor-book.js'); } catch (_) { /* optional */ } }
  if (!(root.BP && root.BP.DoNotEmail) && typeof require === 'function') { try { require('./do-not-email.js'); } catch (_) { /* optional */ } }
  if (!(root.BP && root.BP.Agreements) && typeof require === 'function') { try { require('./vendor-agreements.js'); } catch (_) { /* optional */ } }
  if (!(root.BP && root.BP.Consent) && typeof require === 'function') { try { require('./consent.js'); } catch (_) { /* optional */ } }
  if (!(root.BP && root.BP.Targets) && typeof require === 'function') { try { require('./targets.js'); } catch (_) { /* optional */ } }
  const BP = root.BP;

  const SCHEMA_VERSION = 21;

  function clipText(value, max) {
    if (value === null || value === undefined) return '';
    return String(value).trim().slice(0, max);
  }

  function nowIso() { return new Date().toISOString(); }

  // Company a given email belongs to: its own domain, or the company that lists that domain as an
  // alias (left behind by a merge). null when the email is free-mail or no company exists yet.
  function resolveCompanyId(companies, email) {
    const d = BP.companyIdForEmail(email);
    if (!d) return null;
    if (companies.some(c => c.id === d)) return d;
    const aliased = companies.find(c => Array.isArray(c.aliases) && c.aliases.includes(d));
    return aliased ? aliased.id : null;
  }

  // Returns the company id for `email`, creating the company when the domain is new.
  // MUTATES `companies` (callers pass their working copy). Free-mail / invalid email -> null.
  function ensureCompany(companies, email, companyName, now) {
    const existing = resolveCompanyId(companies, email);
    if (existing) return existing;
    const id = BP.companyIdForEmail(email);
    if (!id) return null;
    const at = now || nowIso();
    companies.push({
      id,
      domain: id,
      name: clipText(companyName, 120) || id,
      label: 'none',
      notes: '',
      aliases: [],
      createdAt: at,
      updatedAt: at
    });
    return id;
  }

  // v1 -> v2: build companies from lead email domains; add companyId + bounced to every lead.
  // Keeps all existing lead fields. A state already at v2 or later comes back unchanged.
  function migrateToV2(state, now) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 2) return s;
    const at = now || nowIso();
    const companies = (Array.isArray(s.companies) ? s.companies : []).map(c => ({ ...c, aliases: (c.aliases || []).slice() }));
    const leads = Array.isArray(s.allLeads) ? s.allLeads : [];

    // Pass 1: which company each lead falls in, plus the names/dates seen per new domain.
    const seen = new Map(); // new domain -> { names: [], firstSaved: '' }
    const assigned = leads.map(l => {
      if (typeof l.companyId === 'string' || l.companyId === null) return l.companyId;
      const known = resolveCompanyId(companies, l.email);
      if (known) return known;
      const id = BP.companyIdForEmail(l.email);
      if (!id) return null;
      let e = seen.get(id);
      if (!e) { e = { names: [], firstSaved: '' }; seen.set(id, e); }
      e.names.push(l.companyName);
      const saved = typeof l.savedAt === 'string' && !isNaN(Date.parse(l.savedAt)) ? l.savedAt : '';
      if (saved && (!e.firstSaved || saved < e.firstSaved)) e.firstSaved = saved;
      return id;
    });

    // Pass 2: create the new companies (first-seen order).
    for (const [id, e] of seen) {
      companies.push({
        id,
        domain: id,
        name: BP.pickCompanyName(e.names, id),
        label: 'none',
        notes: '',
        aliases: [],
        createdAt: e.firstSaved || at,
        updatedAt: at
      });
    }

    return {
      ...s,
      schemaVersion: 2,
      companies,
      allLeads: leads.map((l, i) => ({
        ...l,
        companyId: assigned[i],
        bounced: l.bounced !== undefined ? l.bounced : false
      }))
    };
  }

  // v2 -> v3: adds submissions[] and notRelevant[]; each lead with lastPitchedConsultant becomes a 'seeded' submission
  // (lib/submissions.js builds them). Needs state.consultants to name them; none = every pitch reads as a deleted consultant.
  // A state already at v3 or later comes back unchanged, so running it twice changes nothing. Existing records are kept.
  function migrateToV3(state, now) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 3) return s;
    if (typeof BP.seedSubmissionsFromPitches !== 'function' && typeof require === 'function') require('./submissions.js');
    // Never bump the version without seeding: the caller keeps the old version and retries.
    if (typeof BP.seedSubmissionsFromPitches !== 'function') throw new Error('lib/submissions.js must be loaded to migrate to schema 3.');
    const existing = Array.isArray(s.submissions) ? s.submissions : [];
    const seeded = BP.seedSubmissionsFromPitches({
      allLeads: s.allLeads, companies: s.companies, consultants: s.consultants, submissions: existing
    }, now || nowIso());
    return {
      ...s,
      schemaVersion: 3,
      submissions: existing.concat(seeded),
      notRelevant: Array.isArray(s.notRelevant) ? s.notRelevant : []
    };
  }

  // v3 -> v4: refresh the role family copied into submissions[] and notRelevant[] (the Today view, the duplicate guard and the
  // "Not relevant" penalty compare these strings). A record is only changed when its requirement TITLE now matches a family
  // (that is exactly what BP.roleFamily would pick, the title wins); if the title says nothing the stored family is kept, so
  // technology-derived families are never lost. All other fields and all other keys are untouched. Idempotent.
  function titleFamily(title) {
    const t = String(title == null ? '' : title).trim();
    if (!t) return '';
    const f = BP.roleFamily({ requirement: t, technologies: '', notes: '' });
    return f && f !== 'Other' ? f : '';
  }
  function migrateToV4(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 4) return s;
    if (typeof BP.roleFamily !== 'function' && typeof require === 'function') { try { require('./roles.js'); } catch (e) { /* page without roles.js */ } }
    // Pages that do not load lib/roles.js cannot refresh anything: keep the old version so the service worker does it later.
    if (typeof BP.roleFamily !== 'function') return s;
    const leadTitleByEmail = new Map();
    for (const l of Array.isArray(s.allLeads) ? s.allLeads : []) {
      if (l && l.email && l.requirement) leadTitleByEmail.set(String(l.email).trim().toLowerCase(), l.requirement);
    }
    const submissions = Array.isArray(s.submissions) ? s.submissions.map((x) => {
      if (!x || typeof x !== 'object') return x;
      const f = titleFamily(x.role || x.requirement);
      return f && f !== x.roleFamily ? { ...x, roleFamily: f } : x;
    }) : s.submissions;
    const notRelevant = Array.isArray(s.notRelevant) ? s.notRelevant.map((x) => {
      if (!x || typeof x !== 'object') return x;
      // The saved lead's title when it still exists; else the title baked into postKey ("r:<normalized title>").
      const fromKey = typeof x.postKey === 'string' && x.postKey.startsWith('r:') ? x.postKey.slice(2) : '';
      const f = titleFamily(leadTitleByEmail.get(String(x.leadEmail || '').trim().toLowerCase())) || titleFamily(fromKey);
      return f && f !== x.roleFamily ? { ...x, roleFamily: f } : x;
    }) : s.notRelevant;
    const out = { ...s, schemaVersion: 4 };
    if (submissions !== undefined) out.submissions = submissions;
    if (notRelevant !== undefined) out.notRelevant = notRelevant;
    return out;
  }

  // v4 -> v5: every consultant gets taxTerms. A consultant that already carries a valid value keeps it (so running this twice, or on
  // a backup made after the field existed, changes nothing). Every other field and every other key is untouched.
  // A state without a consultants list stays without one.
  function migrateToV5(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 5) return s;
    const out = { ...s, schemaVersion: 5 };
    if (Array.isArray(s.consultants)) {
      out.consultants = s.consultants.map((c) => {
        if (!c || typeof c !== 'object' || Array.isArray(c)) return c;
        return BP.TAX_TERMS.includes(c.taxTerms) ? c : { ...c, taxTerms: 'C2C' };
      });
    }
    return out;
  }

  // v5 -> v6: recruiter type for every saved lead, computed from what is saved (BP.recruiterType). A lead the user decided about (an old
  // benchSeller true/false, or a recruiterTypeManual flag) keeps that decision. Running it twice changes nothing: a lead that already has a
  // valid recruiterType and a recruiterTypeManual boolean is left as it is. Only recruiterType, recruiterTypeManual and benchSeller are touched.
  function migrateToV6(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 6) return s;
    const out = { ...s, schemaVersion: 6 };
    if (Array.isArray(s.allLeads)) {
      const companies = Array.isArray(s.companies) ? s.companies : [];
      out.allLeads = s.allLeads.map((l) => {
        if (!l || typeof l !== 'object' || Array.isArray(l)) return l;
        if (BP.RECRUITER_TYPES.includes(l.recruiterType) && typeof l.recruiterTypeManual === 'boolean') return l;
        return BP.withRecruiterType(l, { companies });
      });
    }
    return out;
  }

  // v6 -> v7: matchStatus (the Match workspace's Pitched / Submitted / Skipped / Not relevant marks). Absent or damaged becomes {}; a valid
  // one is kept as it is (cleaned of unknown statuses), so running this twice, or on a backup that already has it, changes nothing else.
  function migrateToV7(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 7) return s;
    const clean = root.BPMatchWS && root.BPMatchWS.cleanMatchStatus ? root.BPMatchWS.cleanMatchStatus : (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    return { ...s, schemaVersion: 7, matchStatus: clean(s.matchStatus) };
  }

  // v7 -> v8 (v1.17 clean data, see the header). Only tierLevel, directClientVms, recruiterName, teamMailbox, postedAt and postedLabel of a lead
  // change; the old values of every changed lead go to schemaUpgradeBackupV8 { at, leads: [{ email, ...old values }] } so nothing is lost.
  // Running it twice changes nothing more (blank stays blank). A lead the user named by hand (contactEdited) keeps its name.
  const MADE_UP_TIER = 'Tier 1';
  const MADE_UP_CLIENT = 'Direct Client';
  const SAYS_DIRECT_CLIENT = /\bdirect\s+client\b/i;
  const OLD_AGE_LABEL = /^(?:\d+y|(?:1[0-2])mo)$/;
  const MISREAD_POSTED_MS = 300 * 86400000;
  function emailMadeName(email) {
    const user = String(email || '').split('@')[0];
    const parts = user.split(/[._\-]/).filter(p => p.length > 0 && !/^\d+$/.test(p));
    const pick = parts.length ? parts : [user];
    return pick.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
  }
  function migrateToV8(state, now) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 8) return s;
    const out = { ...s, schemaVersion: 8 };
    const backup = [];
    if (Array.isArray(s.allLeads)) {
      out.allLeads = s.allLeads.map((l) => {
        if (!l || typeof l !== 'object' || Array.isArray(l)) return l;
        const next = { ...l };
        const old = {};
        if (l.tierLevel === MADE_UP_TIER) { old.tierLevel = l.tierLevel; next.tierLevel = ''; }
        if (l.directClientVms === MADE_UP_CLIENT && !SAYS_DIRECT_CLIENT.test([l.notes, l.requirement].filter(Boolean).join(' '))) {
          old.directClientVms = l.directClientVms; next.directClientVms = '';
        }
        if (BP.isTeamMailbox(l.email)) {
          if (l.teamMailbox !== true) next.teamMailbox = true;
          const name = String(l.recruiterName || '').trim();
          if (name && l.contactEdited !== true && name.toLowerCase() === emailMadeName(l.email).toLowerCase()) { old.recruiterName = l.recruiterName; next.recruiterName = ''; }
        }
        if (typeof l.postedAt === 'string' && l.postedAt) {
          const posted = Date.parse(l.postedAt);
          const saved = Date.parse(l.savedAt || l.extractedAt || '');
          const label = typeof l.postedLabel === 'string' ? l.postedLabel.trim() : '';
          if (OLD_AGE_LABEL.test(label) || (Number.isFinite(posted) && Number.isFinite(saved) && saved - posted > MISREAD_POSTED_MS)) {
            old.postedAt = l.postedAt; old.postedLabel = l.postedLabel;
            delete next.postedAt; delete next.postedLabel;
          }
        }
        if (!Object.keys(old).length) return l.teamMailbox !== true && next.teamMailbox === true ? next : l;
        backup.push({ email: l.email, ...old });
        return next;
      });
    }
    // The install used to write these two defaults for everybody; they were never a choice, so they go back to "Leave blank".
    const settingsOld = {};
    if (s.tierLevelDefault === MADE_UP_TIER) { settingsOld.tierLevelDefault = s.tierLevelDefault; out.tierLevelDefault = ''; }
    if (s.clientTypeDefault === MADE_UP_CLIENT) { settingsOld.clientTypeDefault = s.clientTypeDefault; out.clientTypeDefault = ''; }
    if (backup.length || Object.keys(settingsOld).length) {
      out.schemaUpgradeBackupV8 = { at: typeof now === 'string' ? now : Number.isFinite(now) ? new Date(now).toISOString() : nowIso(), leads: backup, settings: settingsOld };
    }
    return out;
  }

  // v8 -> v9 (extension team mode, see the header). Only teamId / syncedToTeam of a lead are looked at; a lead without them is returned
  // as it is (the same object), so personal data never changes. Running it twice changes nothing more.
  const TEAM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function cleanTeamFields(l) {
    if (!l || typeof l !== 'object' || Array.isArray(l)) return l;
    const hasId = 'teamId' in l;
    const hasSynced = 'syncedToTeam' in l;
    if (!hasId && !hasSynced) return l;
    if (!hasId || typeof l.teamId !== 'string' || !TEAM_ID_RE.test(l.teamId)) {
      const next = { ...l };
      delete next.teamId; delete next.syncedToTeam;
      return next;
    }
    if (typeof l.syncedToTeam !== 'boolean') return { ...l, syncedToTeam: false };
    return l;
  }
  function migrateToV9(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 9) return s;
    const out = { ...s, schemaVersion: 9 };
    if (Array.isArray(s.allLeads)) out.allLeads = s.allLeads.map(cleanTeamFields);
    return out;
  }

  // v9 -> v10 (v1.19 vendor memory, see the header). Needs lib/post-log.js; a page without it keeps version 9 and the worker finishes it.
  function migrateToV10(state, now) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 10) return s;
    if (!(BP.PostLog && BP.PostLog.sanitize)) return s;
    const out = { ...s, schemaVersion: 10 };
    const raw = s.postLogs;
    out.postLogs = BP.PostLog.sanitize(raw);
    if (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(out.postLogs)) {
      out.schemaUpgradeBackupV10 = { at: typeof now === 'string' ? now : Number.isFinite(now) ? new Date(now).toISOString() : nowIso(), postLogs: raw };
    }
    return out;
  }

  // v10 -> v11 (see the header). The caller reads these keys with the rest of the state and removes from storage every one the result lacks.
  const RETIRED_KEYS_V11 = ['usage', 'bp_autosave_paused'];
  function migrateToV11(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 11) return s;
    const out = { ...s, schemaVersion: 11 };
    for (const k of RETIRED_KEYS_V11) delete out[k];
    return out;
  }

  // v11 -> v12 (see the header). Needs lib/do-not-email.js; a page without it keeps version 11 and the worker finishes it.
  function migrateToV12(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 12) return s;
    if (!(BP.DoNotEmail && BP.DoNotEmail.sanitize)) return s;
    return { ...s, schemaVersion: 12, doNotEmail: BP.DoNotEmail.sanitize(s.doNotEmail) };
  }

  // v12 -> v13 (see the header). Needs lib/vendor-book.js; a page without it keeps version 12 and the worker finishes it.
  function migrateToV13(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 13) return s;
    if (!(BP.VendorBook && BP.VendorBook.cleanLead)) return s;
    const out = { ...s, schemaVersion: 13 };
    if (Array.isArray(s.allLeads)) out.allLeads = s.allLeads.map(BP.VendorBook.cleanLead);
    return out;
  }

  // v13 -> v14 (see the header). A value that is already valid is kept, so running it twice changes nothing.
  function migrateToV14(state, now) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 14) return s;
    const out = { ...s, schemaVersion: 14 };
    if (!Array.isArray(s.consultants)) return out;
    const at = typeof now === 'string' && Number.isFinite(Date.parse(now)) ? new Date(now) : Number.isFinite(now) ? new Date(now) : new Date();
    const today = BP.todayStr(at);
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && Number.isFinite(Date.parse(v)) ? String(v) : '');
    out.consultants = s.consultants.map((c) => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return c;
      return {
        ...c,
        visaType: BP.VISA_TYPES.includes(c.visaType) ? c.visaType : BP.normalizeVisa(c.visa),
        workAuthUntil: day(c.workAuthUntil),
        availableOn: day(c.availableOn) || BP.availableOnFromText(c.availability, today),
        rateMin: BP.cleanRateMin(c.rateMin),
        rateUnit: BP.normalizeRateUnit(c.rateUnit),
        benchStatus: BP.benchStatusOf(c)
      };
    });
    return out;
  }

  // v14 -> v15 (see the header). Pure; a record already in the new shape is kept.
  function rtrDayOf(sub) {
    const t = Date.parse(sub && sub.submittedAt);
    if (!Number.isFinite(t)) return '';
    return BP.dayKeyOf ? BP.dayKeyOf(t, 'Asia/Kolkata') : new Date(t).toISOString().slice(0, 10);
  }
  function migrateSubmissionV15(sub) {
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return sub;
    const out = { ...sub };
    const had = out.rtrConfirmed === true;
    delete out.rtrConfirmed;
    if (typeof out.rtrOn !== 'string') out.rtrOn = had ? rtrDayOf(sub) : '';
    if (typeof out.rtrUntil !== 'string') out.rtrUntil = '';
    if (out.rtrRate === undefined) out.rtrRate = null;
    if (typeof out.rtrRequestedOn !== 'string') out.rtrRequestedOn = '';
    if (out.billRate === undefined) { const n = BP.parseRate(out.rateAsked); out.billRate = n === null ? null : n; }
    if (out.payRate === undefined) out.payRate = null;
    if (typeof out.rateUnit !== 'string' || !['hr', 'day', 'month', 'year'].includes(out.rateUnit)) out.rateUnit = 'hr';
    if (typeof out.taxTerms !== 'string') out.taxTerms = '';
    if (!Array.isArray(out.chain)) out.chain = [];
    return out;
  }
  function migrateToV15(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 15) return s;
    const out = { ...s, schemaVersion: 15 };
    if (Array.isArray(s.submissions)) out.submissions = s.submissions.map(migrateSubmissionV15);
    return out;
  }

  // The agreement fields of one company, cleaned (lib/vendor-agreements.js). A company without any is returned as it is (same object).
  function cleanCompanyAgreement(c) {
    const A = BP.Agreements;
    if (!c || typeof c !== 'object' || Array.isArray(c) || !A.FIELDS.some(k => k in c)) return c;
    const next = { ...c };
    for (const k of A.FIELDS) delete next[k];
    return { ...next, ...A.compact(c) };
  }

  // v15 -> v16 (see the header). Needs lib/vendor-agreements.js; a page without it keeps version 15 and the worker finishes it.
  function migrateToV16(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 16) return s;
    if (!(BP.Agreements && BP.Agreements.compact)) return s;
    const out = { ...s, schemaVersion: 16 };
    if (Array.isArray(s.companies)) out.companies = s.companies.map(cleanCompanyAgreement);
    return out;
  }

  // v16 -> v17 (see the header). Needs lib/consent.js (loaded before this file wherever data is written).
  function migrateToV17(state, now) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 17) return s;
    const C = BP.Consent;
    if (!C) return s;   // lib/consent.js not loaded on this page: the version stays, so the service worker runs this step
    const out = { ...s, schemaVersion: 17 };
    const notes = [];
    for (const n of Array.isArray(s.contactNotes) ? s.contactNotes : []) {
      const clean = C.cleanContactNote(n, now);
      if (clean && !notes.some((x) => x.id === clean.id)) notes.push(clean);
    }
    out.contactNotes = notes.slice(-C.CONTACT_NOTES_MAX);
    if (Array.isArray(s.consultants)) {
      const keys = ['consentOn', 'consentSource', 'consentNote'];
      out.consultants = s.consultants.map((c) => {
        if (!c || typeof c !== 'object' || Array.isArray(c) || !keys.some((k) => k in c)) return c;
        const clean = C.cleanConsent(c);
        return keys.every((k) => !(k in c) || c[k] === clean[k]) ? c : { ...c, ...clean };
      });
    }
    return out;
  }

  // v17 -> v18 (see the header). Pure; a record already in the new shape is kept.
  function migrateSubmissionV18(sub) {
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return sub;
    const plainObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
    return { ...sub, interviews: Array.isArray(sub.interviews) ? sub.interviews.filter(plainObj) : [], placement: plainObj(sub.placement) ? sub.placement : null };
  }
  function migrateToV18(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 18) return s;
    const out = { ...s, schemaVersion: 18 };
    if (Array.isArray(s.submissions)) out.submissions = s.submissions.map(migrateSubmissionV18);
    return out;
  }

  // v18 -> v19 (see the header). Needs lib/targets.js; a page without it keeps the version, so the service worker runs this step.
  function migrateToV19(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 19) return s;
    const T = BP.Targets;
    if (!T) return s;
    return { ...s, schemaVersion: 19, targets: T.cleanPersonal(s.targets) };
  }

  // v19 -> v20 (see the header). Needs lib/consent.js; a page without it keeps the version, so the service worker runs this step.
  function migrateToV20(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 20) return s;
    const C = BP.Consent;
    if (!C) return s;
    return { ...s, schemaVersion: 20, erasedIds: C.cleanErasedIds(s.erasedIds) };
  }

  // v20 -> v21 (see the header). Pure; a record already in the new shape is kept.
  function migrateSubmissionV21(sub) {
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return sub;
    const plainObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
    return { ...sub, timesheets: Array.isArray(sub.timesheets) ? sub.timesheets.filter(plainObj) : [], invoices: Array.isArray(sub.invoices) ? sub.invoices.filter(plainObj) : [] };
  }
  function migrateToV21(state) {
    const s = state || {};
    if ((Number(s.schemaVersion) || 1) >= 21) return s;
    const out = { ...s, schemaVersion: 21 };
    if (Array.isArray(s.submissions)) out.submissions = s.submissions.map(migrateSubmissionV21);
    return out;
  }

  // Ordered list: MIGRATIONS[n] upgrades version n-1 to n. Every number from 2 to SCHEMA_VERSION has a step, and every step runs.
  const MIGRATIONS = { 2: migrateToV2, 3: migrateToV3, 4: migrateToV4, 5: migrateToV5, 6: migrateToV6, 7: migrateToV7, 8: migrateToV8, 9: migrateToV9, 10: migrateToV10, 11: migrateToV11, 12: migrateToV12, 13: migrateToV13, 14: migrateToV14, 15: migrateToV15, 16: migrateToV16, 17: migrateToV17, 18: migrateToV18, 19: migrateToV19, 20: migrateToV20, 21: migrateToV21 };

  // Runs every migration newer than the state's version, in order. Idempotent.
  function migrate(state, now) {
    let s = state || {};
    for (let v = (Number(s.schemaVersion) || 1) + 1; v <= SCHEMA_VERSION; v++) {
      s = MIGRATIONS[v](s, now);
    }
    return s;
  }

  // ── Company operations (pure; the service worker saves what they return) ──

  // patch: { name?, label?, notes?, agreement? } -> { ok, companies, company } | { ok:false, error }
  // agreement: any of the lib/vendor-agreements.js fields; checked there, and stored compact (a field back at its default is removed).
  function updateCompany(companies, id, patch, now) {
    const idx = companies.findIndex(c => c.id === id);
    if (idx === -1) return { ok: false, error: 'Company not found.' };
    const p = patch || {};
    const next = { ...companies[idx] };
    if (p.name !== undefined) {
      const name = clipText(p.name, 120);
      if (!name) return { ok: false, error: 'Company name cannot be empty.' };
      next.name = name;
    }
    if (p.label !== undefined) {
      if (!BP.COMPANY_LABEL_KEYS.includes(p.label)) return { ok: false, error: 'Unknown company label.' };
      next.label = p.label;
    }
    if (p.notes !== undefined) next.notes = clipText(p.notes, 2000);
    if (p.agreement !== undefined) {
      if (!BP.Agreements) return { ok: false, error: 'Agreements are not available here.' };
      const v = BP.Agreements.validate(p.agreement, companies[idx]);
      if (!v.ok) return { ok: false, error: v.error };
      for (const k of BP.Agreements.FIELDS) delete next[k];
      Object.assign(next, BP.Agreements.compact(v.value));
    }
    next.updatedAt = now || nowIso();
    const out = companies.slice();
    out[idx] = next;
    return { ok: true, companies: out, company: next };
  }

  // Moves every lead of `sourceId` into `targetId`; the source domain and its aliases become
  // aliases of the target so future leads from them land there. The source is removed.
  // A label/notes the target lacks are carried over from the source (nothing is dropped).
  function mergeCompanies(state, targetId, sourceId, now) {
    const companies = state.companies || [];
    const target = companies.find(c => c.id === targetId);
    const source = companies.find(c => c.id === sourceId);
    if (!target || !source) return { ok: false, error: 'Company not found.' };
    if (targetId === sourceId) return { ok: false, error: 'Pick two different companies to merge.' };

    const aliases = [];
    for (const a of [...(target.aliases || []), source.id, ...(source.aliases || [])]) {
      if (a && a !== target.id && !aliases.includes(a)) aliases.push(a);
    }
    const sourceNotes = (source.notes || '').trim();
    const targetNotes = (target.notes || '').trim();
    const merged = {
      ...target,
      aliases,
      label: target.label && target.label !== 'none' ? target.label : (source.label || 'none'),
      notes: !sourceNotes ? target.notes : !targetNotes ? source.notes : clipText(`${target.notes}\n\n${source.notes}`, 2000),
      updatedAt: now || nowIso()
    };
    return {
      ok: true,
      company: merged,
      moved: (state.allLeads || []).filter(l => l.companyId === sourceId).length,
      companies: companies.filter(c => c.id !== sourceId).map(c => c.id === targetId ? merged : c),
      allLeads: (state.allLeads || []).map(l => l.companyId === sourceId ? { ...l, companyId: targetId } : l)
    };
  }

  // companyId may be null (no company). -> { ok, allLeads, lead } | { ok:false, error }
  function moveLeadToCompany(state, email, companyId, now) {
    const target = String(email || '').toLowerCase();
    const leads = state.allLeads || [];
    const idx = leads.findIndex(l => (l.email || '').toLowerCase() === target);
    if (idx === -1) return { ok: false, error: 'That recruiter is not in your dashboard any more. Reload the page and try again.' };
    const id = companyId === undefined ? null : companyId;
    if (id !== null && !(state.companies || []).some(c => c.id === id)) return { ok: false, error: 'Company not found.' };
    const out = leads.slice();
    out[idx] = { ...leads[idx], companyId: id };
    // The company's "last changed" moves with its membership.
    const companies = (state.companies || []).map(c =>
      (c.id === id || c.id === leads[idx].companyId) ? { ...c, updatedAt: now || nowIso() } : c);
    return { ok: true, allLeads: out, companies, lead: out[idx] };
  }

  function setLeadBounced(state, email, bounced) {
    const target = String(email || '').toLowerCase();
    const leads = state.allLeads || [];
    const idx = leads.findIndex(l => (l.email || '').toLowerCase() === target);
    if (idx === -1) return { ok: false, error: 'That recruiter is not in your dashboard any more. Reload the page and try again.' };
    const out = leads.slice();
    out[idx] = { ...leads[idx], bounced: Boolean(bounced) };
    return { ok: true, allLeads: out, lead: out[idx] };
  }

  // ── Vendor badges (v1.5, #5): what the LinkedIn drawer shows for a company label ──
  // A badge is { companyId, name, label, text, kind, note } or null (no company, or label 'none').
  // kind: 'avoid' (warning) | 'trusted' | 'neutral' (direct client, prime vendor, implementation partner)
  //       | 'seller' (bench seller, not hiring; styled neutral, short text 'Bench seller').

  function badgeFromCompany(c) {
    if (!c || !c.label || c.label === 'none' || !BP.COMPANY_LABELS[c.label]) return null;
    return {
      companyId: c.id,
      name: c.name || c.id,
      label: c.label,
      text: c.label === 'bench-seller' ? 'Bench seller' : BP.COMPANY_LABELS[c.label],
      kind: c.label === 'avoid' ? 'avoid' : c.label === 'trusted' ? 'trusted' : c.label === 'bench-seller' ? 'seller' : 'neutral',
      note: String(c.notes || '').trim()
    };
  }

  // Badge for an email address: its company (own domain or an alias left by a merge). Free-mail
  // addresses and domains with no company give null.
  function companyBadgeFor(email, companies) {
    const list = Array.isArray(companies) ? companies : [];
    const id = resolveCompanyId(list, email);
    return id ? badgeFromCompany(list.find(c => c.id === id)) : null;
  }

  const BADGE_ORDER = { avoid: 0, trusted: 1, neutral: 2, seller: 3 };

  // The most important badge of a list: Avoid beats Trusted beats the neutral labels. null for none.
  function strongestBadge(badges) {
    let best = null;
    for (const b of badges || []) {
      if (b && (!best || BADGE_ORDER[b.kind] < BADGE_ORDER[best.kind])) best = b;
    }
    return best;
  }

  function normalizeCompanyName(name) {
    return String(name || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/\s+(inc|llc|llp|ltd|corp|corporation|co|company)$/, '').trim();
  }

  // Fallback for a profile with no captured email: exact match on the company name (ignoring case,
  // punctuation and a trailing Inc/LLC/Ltd). Several companies with that name give the strongest badge.
  function companyBadgeForName(name, companies) {
    const n = normalizeCompanyName(name);
    if (!n) return null;
    return strongestBadge((Array.isArray(companies) ? companies : [])
      .filter(c => normalizeCompanyName(c.name) === n)
      .map(badgeFromCompany));
  }

  // ── Bench sellers (v1.5.1, #39) ──
  // A bench seller markets their own consultants (posts a hotlist); they are not hiring, so they are
  // not a lead for a bench-sales recruiter. Lead fields: benchSeller (user decision, boolean),
  // benchSellerReviewed (true once the user un-marked it, so cleanup stops suggesting it).

  // -> { ok, allLeads, companies, lead, company?, labelSkipped?, existingLabel? } | { ok:false, error }
  function markBenchSeller(state, email, benchSeller, labelCompany, now) {
    const target = String(email || '').trim().toLowerCase();
    const leads = state.allLeads || [];
    const idx = leads.findIndex(l => (l.email || '').toLowerCase() === target);
    if (idx === -1) return { ok: false, error: 'That recruiter is not in your dashboard any more. Reload the page and try again.' };
    const on = Boolean(benchSeller);
    const at = now || nowIso();
    const before = leads[idx];
    const note = on ? 'Marked as bench seller (not hiring)' : 'Unmarked as bench seller';
    const activity = (Array.isArray(before.activity) ? before.activity.slice(-49) : []).concat([{ at, type: 'note', text: note }]);
    const lead = { ...before, benchSeller: on, activity };
    if (!on) lead.benchSellerReviewed = true;
    // The user's call is the type: bench sales, or (un-marked) whatever the other signals say.
    if (on) { lead.recruiterType = 'bench'; lead.recruiterTypeManual = true; }
    else {
      delete lead.recruiterTypeManual; delete lead.recruiterType;
      const cosNow = (state.companies || []).map(c => (c.id === lead.companyId && c.label === 'bench-seller' ? { ...c, label: 'none' } : c));
      lead.recruiterType = BP.recruiterType({ ...lead, benchSeller: false }, { companies: cosNow }).type;
      lead.recruiterTypeManual = true;
    }
    const allLeads = leads.slice();
    allLeads[idx] = lead;

    const companies = state.companies || [];
    const out = { ok: true, allLeads, companies, lead };
    const cIdx = labelCompany && lead.companyId ? companies.findIndex(c => c.id === lead.companyId) : -1;
    if (cIdx !== -1) {
      const c = companies[cIdx];
      const current = c.label || 'none';
      let nextLabel = null;
      if (on) {
        if (current === 'none') nextLabel = 'bench-seller';
        else if (current !== 'bench-seller') { out.labelSkipped = true; out.existingLabel = current; }
      } else if (current === 'bench-seller') {
        nextLabel = 'none';
      }
      if (nextLabel) {
        const r = updateCompany(companies, c.id, { label: nextLabel }, at);
        if (r.ok) {
          out.companies = r.companies; out.company = r.company;
          // The rest of that company's contacts follow the new label unless their own type was chosen by the user.
          out.allLeads = refreshCompanyTypes(out.allLeads, out.companies, c.id);
          out.lead = out.allLeads[idx];
        }
      }
    }
    return out;
  }

  // Recomputes the stored type of the non-manual contacts of one company (after its label changed).
  function refreshCompanyTypes(leads, companies, companyId) {
    return leads.map((l) => {
      if (!l || l.companyId !== companyId || l.recruiterTypeManual === true) return l;
      return BP.withRecruiterType({ ...l, recruiterTypeManual: false }, { companies });
    });
  }

  // The chip menu: the user picks Tech recruiter, Bench sales or Company HR for one contact. Always stored as their own choice.
  // Same result shape as markBenchSeller. labelCompany only matters for bench: it also labels the company Bench seller (when it has no label).
  function setRecruiterType(state, email, type, labelCompany, now) {
    if (!['tech', 'bench', 'company-hr'].includes(type)) return { ok: false, error: 'Unknown contact type.' };
    if (type === 'bench') return markBenchSeller(state, email, true, labelCompany, now);
    const r = markBenchSeller(state, email, false, labelCompany, now);
    if (!r.ok) return r;
    const target = String(email || '').trim().toLowerCase();
    const idx = r.allLeads.findIndex(l => (l.email || '').toLowerCase() === target);
    const lead = { ...r.allLeads[idx], recruiterType: type, recruiterTypeManual: true, benchSeller: false };
    const allLeads = r.allLeads.slice();
    allLeads[idx] = lead;
    return { ...r, allLeads, lead };
  }

  // Role families: a technologies list spanning many of them is a whole bench, not one opening.
  const ROLE_FAMILIES = [
    /\bjava\b|spring ?boot/i, /\.net\b|\bc#|dotnet/i, /\bpython\b/i, /dev ?ops|\bsre\b|site reliability/i,
    /data (engineer|scientist|analyst|architect)|big data|\betl\b|data warehouse/i, /business analyst|\bba\b/i,
    /full[ -]?stack/i, /\b(ai|ml|genai|machine learning|artificial intelligence|gen ai)\b/i, /\bqa\b|tester|testing|automation test|sdet/i,
    /salesforce/i, /\bsap\b/i, /service ?now/i, /cyber|security engineer|infosec/i, /network engineer/i,
    /\bandroid\b|\bios\b|mobile developer/i, /project manager|scrum master|product owner/i, /\bdba\b|database admin/i
  ];
  const HEADLINE_SELLER_RE = /bench\s*(sales|marketing)|marketing recruiter|bench recruiter/i;
  const HOTLIST_TEXT_RE = /available consultants?|hot\s*list|share (your )?requirements?|our bench|bench consultants?/i;

  function roleFamilyCount(text) {
    const parts = String(text || '').split(/[,;|\n/]+/).map(s => s.trim()).filter(Boolean);
    const hit = new Set();
    for (const p of parts) ROLE_FAMILIES.forEach((re, i) => { if (re.test(p)) hit.add(i); });
    return hit.size;
  }

  // Saved leads that look like bench sellers and still need a decision.
  // -> [{ email, reasons: [string] }]. Skips leads already marked (benchSeller === true) and leads the
  // user un-marked (benchSellerReviewed === true).
  function benchSellerSuspects(leads, companies) {
    const cos = new Map((Array.isArray(companies) ? companies : []).map(c => [c.id, c]));
    const out = [];
    for (const l of Array.isArray(leads) ? leads : []) {
      if (!l || !l.email || l.benchSeller === true || l.benchSellerReviewed === true) continue;
      const reasons = [];
      if (l.postType === 'hotlist') reasons.push('Saved from a post that looks like a hotlist');
      const co = l.companyId ? cos.get(l.companyId) : null;
      if (co && co.label === 'bench-seller') reasons.push('Its company is labelled Bench seller');
      const title = [l.headline, l.designation].filter(Boolean).join(' | ');
      if (HEADLINE_SELLER_RE.test(title)) reasons.push('Job title says bench sales / marketing');
      const body = [l.requirement, l.notes].filter(Boolean).join('\n');
      if (HOTLIST_TEXT_RE.test(body)) reasons.push('Notes mention available consultants or a hotlist');
      const families = roleFamilyCount(l.technologies);
      if (families >= 4) reasons.push('Lists many unrelated roles (' + families + ' role types)');
      if (typeof BP.classifyPost === 'function' && body) {
        try {
          const c = BP.classifyPost({ text: body, headline: l.headline || '' });
          if (c && c.type === 'hotlist') {
            for (const r of (c.reasons || []).slice(0, 3)) if (!reasons.includes(r)) reasons.push(r);
          }
        } catch (e) { /* classifier problems never block cleanup */ }
      }
      if (reasons.length) out.push({ email: l.email, reasons });
    }
    return out;
  }

  // ── Possible job seekers (v1.17 Cleanup) ──
  // Saved contacts that look like people looking for a job, judged from what was saved (headline, role, notes, name and email; the
  // post text itself is not kept). Leads already decided (candidate 'yes' or 'no'), bench sellers, hotlists and jobs are skipped.
  // -> [{ email, level: 'yes' | 'check', reasons }]
  function jobSeekerSuspects(leads) {
    const out = [];
    for (const l of Array.isArray(leads) ? leads : []) {
      if (!l || !l.email || l.sample === true || l.candidate === 'yes' || l.candidate === 'no') continue;
      if (l.postType === 'hotlist' || l.postType === 'recruiter-job' || l.benchSeller === true || l.recruiterType === 'bench') continue;
      const r = BP.detectJobSeeker({ text: [l.requirement, l.notes].filter(Boolean).join('\n'), headline: l.headline || l.designation || '', name: l.recruiterName, email: l.email });
      if (l.candidate === 'check' || r.level) {
        const reasons = r.reasons.length ? r.reasons : (Array.isArray(l.candidateReasons) ? l.candidateReasons.slice(0, 4) : []);
        out.push({ email: l.email, level: r.level === 'yes' ? 'yes' : 'check', reasons: reasons.length ? reasons : ['Some signs of a job seeker'] });
      }
    }
    return out;
  }

  // ── Name doesn't match email (v1.6.1) ──
  // Before 1.6.1 a poster's name was saved on whatever single email their post held, so a bench seller
  // sharing a Nityo requirement left "Ameesha vadisa" on mdayaz.ahmad@nityo.com. Cleanup finds those:
  // the address reads like a person (not hr@, jobs@) and nothing in it resembles the saved name. The
  // company rule is NOT used here: a saved company is often just the email domain, which proves nothing.
  // Skipped: leads the user edited by hand (contactEdited), leads they chose to keep (emailOwnerReviewed),
  // and names that already came from the email.
  const EMAIL_FIX_FIELDS = ['recruiterName', 'companyName', 'designation', 'headline', 'linkedinProfile', 'notes', 'sharedBy', 'activity', 'emailOwnerReviewed'];

  function emailOwnerSuspects(leads, companies) {
    const out = [];
    for (const l of Array.isArray(leads) ? leads : []) {
      if (!l || !l.email || l.contactEdited === true || l.emailOwnerReviewed === true) continue;
      const name = BP.cleanPersonName(l.recruiterName);
      if (!name || name === 'Recruiter Lead' || name === BP.nameFromEmail(l.email)) continue;
      if (BP.nameTokensOf(name).length === 0) continue;
      if (!BP.emailLooksPersonal(l.email)) continue;
      // Strict rule first, then the loose "anything in common" test so nicknames and spellings are left alone.
      if (BP.emailOwnedByAuthor({ email: l.email, authorName: name })) continue;
      if (BP.emailNameOverlap(l.email, name)) continue;
      const newName = BP.nameFromEmail(l.email);
      const company = suggestedCompanyName(l, companies);
      out.push({ email: l.email, oldName: name, newName, company, reasons: [`The email looks like ${newName}, not ${name}`] });
    }
    return out;
  }

  function suggestedCompanyName(lead, companies) {
    const domain = BP.emailDomain(lead.email);
    if (!domain || BP.isFreeMailDomain(domain)) return lead.companyName && lead.companyName !== 'Staffing Partner' ? 'Staffing Partner' : (lead.companyName || 'Staffing Partner');
    if (lead.companyName && BP.domainMatchesCompany(domain, lead.companyName)) return lead.companyName;
    const co = (Array.isArray(companies) ? companies : []).find(c => c.id === lead.companyId);
    return (co && co.name) || BP.companyNameFromDomain(domain) || 'Staffing Partner';
  }

  // state { allLeads, companies }, emails [...] -> { ok, allLeads, fixed, undo: [{ email, before, afterName }] }
  function fixEmailOwners(state, emails, now) {
    const at = now || nowIso();
    const wanted = new Set((Array.isArray(emails) ? emails : []).map(e => String(e || '').trim().toLowerCase()));
    const suspects = new Map(emailOwnerSuspects(state.allLeads, state.companies).map(s => [String(s.email).toLowerCase(), s]));
    const undo = [];
    const allLeads = (state.allLeads || []).map((l) => {
      const key = String((l && l.email) || '').toLowerCase();
      if (!wanted.has(key) || !suspects.has(key)) return l;   // stale list or edited since: leave it alone
      const s = suspects.get(key);
      const before = {};
      for (const f of EMAIL_FIX_FIELDS) if (f in l) before[f] = l[f];
      const next = { ...l };
      next.recruiterName = s.newName;
      next.companyName = suggestedCompanyName(l, state.companies);
      next.designation = 'Recruiter';
      next.headline = '';

      // The profile link belongs to the other person unless its address resembles this email.
      let removedUrl = '';
      const url = String(l.linkedinProfile || '');
      const slug = (url.match(/linkedin\.com\/in\/([^/?#]+)/i) || [])[1];
      if (slug && !BP.emailNameOverlap(l.email, decodeURIComponent(slug).replace(/[-_0-9]+/g, ' '))) {
        removedUrl = url;
        next.linkedinProfile = '';
      }
      if (!l.sharedBy) {
        const sb = BP.sanitizeSharedBy({ name: s.oldName, headline: l.headline || '', url: removedUrl });
        if (sb) next.sharedBy = sb;
      }
      const notes = String(l.notes || '');
      next.notes = /\bShared by\b/i.test(notes) ? notes : (notes ? `${notes} | Shared by ${s.oldName}` : `Shared by ${s.oldName}`);
      next.emailOwnerReviewed = true;
      next.activity = (Array.isArray(l.activity) ? l.activity.slice(-49) : []).concat([{ at, type: 'note', text: `Contact corrected: was "${s.oldName}"` }]);
      undo.push({ email: l.email, before, afterName: s.newName });
      return next;
    });
    return { ok: true, allLeads, fixed: undo.length, undo };
  }

  // "Keep as is": remember the decision on each lead so it is not suggested again.
  function keepEmailOwners(state, emails) {
    const wanted = new Set((Array.isArray(emails) ? emails : []).map(e => String(e || '').trim().toLowerCase()));
    let kept = 0;
    const allLeads = (state.allLeads || []).map((l) => {
      if (!l || !wanted.has(String(l.email || '').toLowerCase()) || l.emailOwnerReviewed === true) return l;
      kept++;
      return { ...l, emailOwnerReviewed: true };
    });
    return { ok: true, allLeads, kept };
  }

  // Reverts a fix; a lead the user changed since (its name is no longer the one we wrote) stays as it is.
  function undoEmailOwnerFix(allLeads, undo) {
    const items = Array.isArray(undo) ? undo : [];
    const byEmail = new Map(items.map(u => [String(u.email || '').toLowerCase(), u]));
    let restored = 0;
    const out = (allLeads || []).map((l) => {
      const u = l && byEmail.get(String(l.email || '').toLowerCase());
      if (!u || l.recruiterName !== u.afterName) return l;
      const next = { ...l };
      for (const f of EMAIL_FIX_FIELDS) { if (f in u.before) next[f] = u.before[f]; else delete next[f]; }
      restored++;
      return next;
    });
    return { allLeads: out, restored };
  }

  Object.assign(BP, {
    SCHEMA_VERSION,
    emailOwnerSuspects,
    fixEmailOwners,
    keepEmailOwners,
    undoEmailOwnerFix,
    markBenchSeller,
    benchSellerSuspects,
    jobSeekerSuspects,
    resolveCompanyId,
    ensureCompany,
    migrateToV2,
    migrateToV3,
    migrateToV4,
    migrateToV5,
    migrateToV6,
    migrateToV7,
    migrateToV8,
    migrateToV9,
    migrateToV10,
    migrateToV11,
    migrateToV12,
    migrateToV13,
    migrateToV14,
    migrateToV15,
    migrateToV16,
    migrateToV17,
    migrateToV18,
    migrateToV19,
    migrateToV20,
    migrateToV21,
    migrateSubmissionV15,
    migrateSubmissionV18,
    migrateSubmissionV21,
    RETIRED_KEYS_V11,
    TEAM_ID_RE,
    setRecruiterType,
    migrate,
    updateCompany,
    mergeCompanies,
    moveLeadToCompany,
    setLeadBounced,
    companyBadgeFor,
    companyBadgeForName,
    strongestBadge
  });
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
