// webapp/js/store.js - the ONE data-access interface for the web app.
//
// Every screen talks only to a store object created by createStore(). Two implementations:
//   DemoStore      in-memory sample data, saved to localStorage so edits survive a reload. Used today ("demo mode").
//   SupabaseStore  the live store: Supabase auth + row-level-security tables (PostgREST) + the `team` function.
//
// Every method is async so the Supabase version can drop in without touching a screen.
//
// Interface (both stores):
//   session     getSession() signIn() signOut() setDemoRole(role) resetDemo()
//   team        getTeam() updateTeam(patch) listMembers({includeRemoved}) listInvites() inviteMember({email, role})
//               setMemberRole(id, role) removeMember(id) exportAll() transferOwner(id) createTeam(name, {ref}) acceptInvite(token)
//               importBook({vendors, consultants}) deleteWorkspace(confirmName)
//               leaveTeam() seatInfo() -> {limit, used} revokeInvite(id) resendInvite(id)   (0040; live getSession() with no team also
//               carries lastTeam {name, reason, endedOn, wasOwner} | null and pilotAvailable)
//   billing     getBilling() startCheckout(planId, currency) requestPilotExtension()   (getTeam() also carries `billing`)
//               refreshBilling() -> billing (fresh from the server)  getBillingHistory() -> [{date, plan, amount, currency, status}] (owner)
//               getReferralLink({new}) -> {code, link, expiresOn, joined, rewarded}  getPersonalPlan() -> {tier, planUntil} (`my-plan`)
//   delete      deleteConsultant(id) deleteRequirement(id) deleteVendor(id) deleteContact(id) deleteSubmission(id)
//               owners and managers (record-delete.js; RLS 0011 `<table>_delete`). A consultant with submissions cannot be deleted.
//   bench       listConsultants({status, recruiterId, q}) getConsultant(id) saveConsultant(row)
//   resumes     listResumes(consultantId) uploadResume(consultantId, file, check) resumeLink(version) deleteResume(id)
//               (migration 0024; js/resume.js. `check` = checkResume()'s result; versions newest first, at most RESUME_KEEP)
//   requirements listRequirements({q, status, source}) getRequirement(id) saveRequirement(row)
//   vendors     listVendors({q, tier}) getVendor(id) saveVendor(row) listContacts({companyId, q}) saveContact(row)
//               saveVendorAgreement(id, agreement) -> vendor   (staffing P6, migration 0050: MSA / NDA status and dates, net terms, payment
//               note; owners and managers only, checked by BP.Agreements.validate. saveVendor never writes these fields.)
//   submissions listSubmissions({recruiterId, consultantId, stage, sinceDays}) checkGuard(query)
//               saveSubmission(row, {overrideReason})   P2 (0046): row may carry rtrOn, rtrUntil, rtrRate, rtrStatus, billRate, rateUnit, taxTerms,
//               chain and payRate. payRate is read and written only by people who may see pay (perms 'see_pay'; RLS on submission_pay).
//   P3 (0051)   listInterviews({submissionId, from, to}) saveInterview(row) deleteInterview(id)
//               listPlacements() savePlacement(row) deletePlacement(id)   row: BP.Placements.cleanInterview / cleanPlacement's shape plus
//               submissionId (and id to edit). A placement's payRate is read and written only by people who may see pay (perms 'see_pay';
//               RLS on placement_pay). Deletes: owners and managers. The database moves the stage, the consultant and the status (0051).
//   0055        listTimesheets({placementId}) saveTimesheet(row) deleteTimesheet(id)   (BP.Timesheets' shape plus placementId; members write,
//               owners and managers delete; a week on an invoice is locked)   listInvoices() createInvoice({placementId, number, issuedOn, from, to, otRate})
//               updateInvoice(id, patch) deleteInvoice(id)   (owners and managers; made only from approved weeks; patch = status, sentOn, paidOn,
//               dueOn, note)   listCommissionRules() saveCommissionRule(row) deleteCommissionRule(id)   (owners and managers)
//               getInvoiceProfile() saveInvoiceProfile(row)   the firm's invoice details (team_branding; owners and managers write)
//   P4 (0052)   listTargets() -> [{id, memberId, deskId, period, submissions, interviews, placements}]   saveTarget(row) deleteTarget(id)
//               (owners and managers write; a recruiter reads the team's, the desks' and their own target only: RLS team_targets_select)
//               listGuardCatches({from, to}) -> [{day, userId, warned}]   duplicates caught per person (a recruiter: their own rows only)
//   home        todayStats() listActivity(limit) lastReportRun()
//   audit       listAudit({actorId, actorIds, kind, from, to, limit, offset}) -> {rows, more}   owners and managers (perms 'audit_log');
//               rows are {id, at, actor, action, entity, entityId, before, after} with ids only (js/audit-lib.js makes the lines)
//   inbox       getInboxInfo({fresh}) listInboxMessages({status, kind, before, limit}) getInboxMessage(id) listInboxAddresses()
//               createInboxAddress(label) disableInboxAddress(id) replaceInboxAddress(id, label?) markInbox(ids, status, requirementId) -> {updated, ids}
//               attachInbox(messageId, requirementId) -> {attached}      (docs/specs/TEAM_INBOX_SPEC.md section 5)
//               The list rows carry `preview` only (bodyText '', full false); getInboxMessage returns the full text.
//   desks       listDesks() -> [{id, name, office, memberIds}]  saveDesk({id?, name, office}) deleteDesk(id) setMemberDesk(userId, deskId|'')
//               (backlog W10, migration 0036, js/desks.js. Owners and managers write; Agency and the pilot only. A consultant's own desk
//               is saveConsultant's deskId, set by owners and managers only.)
//   consent     (staffing P5, migration 0049, js/consent.js) consultants carry consentOn, consentSource, consentNote ('' = none) and erased.
//               listConsultants() hides erased consultants unless {includeErased: true} (the name lookups keep them: "Erased consultant").
//               listContactNotes(entity, entityId) -> [{id, entity, entityId, kind, at, body, createdBy}] newest first ('consultant'|'vendor_contact')
//               addContactNote({entity, entityId, kind, at, body}) -> note   deleteContactNote(id)   (the author, or an owner or manager)
//               consultantNameMatches(id) -> [{kind, id, entity, entityName, at, text}]   where else the full name appears (0053)
//               eraseConsultant(id, confirmName, scrub?) -> {ok, keptRow, submissions, files, scrubbed}   owners and managers, also while read-only
//               exportConsultant(id) -> {format:'benchpilot-consultant-export', version, exportedAt, consultant, resumeFiles, submissions, contactNotes}
//   templates   listTemplates({defaults}) saveTemplate(row) deleteTemplate(id) getBranding() saveBranding(row) getSenderProfile()
//               saveSenderProfile(row)     (migration 0028, js/templates.js. With no saved template, an owner or manager's first list
//               seeds `defaults`; anyone else gets them unsaved, marked builtIn. The sender profile is the caller's own.)

import { addDays, diffDays, todayISO } from './dates.js';
import { buildSeed, seedP3, seedP4, seedBilling, DATE_FIELDS, TIME_FIELDS, WEEK_FIELDS, mondayOf, DEMO_USER_BY_ROLE } from './demo-data.js';
import { checkGuard, reasonOk } from './guard.js';
import { can, canNow, canChangeMember, ROLES } from './perms.js';
import { computeToday } from './stats.js';
import { nameFromEmail } from './auth.js';
import * as M from './live-map.js';
import { StoreError } from './live-map.js';
import { companyDomain } from './import-book.js';
import { RESUME_BUCKET, RESUME_KEEP, RESUME_PATH_RE, SIGNED_LINK_SECONDS, DOCX_TYPE, resumePath, cleanFileName, versionFrom, storageProblem } from './resume.js';
import { withTags, cleanTags, tagsFromFreeText } from './req-tags.js';
import { entitiesFor, dayRange, AUDIT_PAGE } from './audit-lib.js';
import { cleanTemplate, cleanBranding, cleanSender, TEMPLATE_MAX } from './templates.js';
import { checkName, SMART_LIST_MAX } from './vendor-lists.js';
import { cleanDesk } from './desks.js';
import { VISA_TYPES, normalizeVisa, cleanRateMin, normalizeRateUnit } from './consultant-profile.js';
import { isISODay } from './dates.js';
import { hasFeature, consultantCap, CONSULTANT_CAP_NOTE, PLAN_HINTS } from './plan-gate.js';
import { canDeleteRecords, CONSULTANT_HAS_SUBMISSIONS } from './record-delete.js';
import { loadAgreementsLib } from './bp-lib.js';
import { cleanConsent, cleanNoteInput, sortNotes, consultantExport, ERASED_NAME, NOTE_EMPTY, ERASE_MISMATCH, ERASED_READ_ONLY, nameRegex, hasName, scrubName } from './consent.js';
import { LINK_DAYS, linkFrom, domainProblem, emailInDomain, domainRefusal, normalizeDomain } from './consultant-links.js';

export const STORAGE_KEY = 'bp_webapp_demo_v1';

const clone = (x) => JSON.parse(JSON.stringify(x));
const lower = (s) => String(s == null ? '' : s).toLowerCase();
const textHas = (hay, q) => !q || lower(hay).includes(lower(q).trim());

/** Move every date in a saved demo forward by `delta` days (so "yesterday" stays yesterday after midnight). */
export function shiftState(state, delta) {
  if (!delta) return state;
  for (const [collection, fields] of Object.entries(DATE_FIELDS)) {
    const rows = collection === 'team' ? [state.team] : state[collection];
    for (const row of rows || []) {
      for (const f of fields) if (row && row[f]) row[f] = addDays(row[f], delta);
    }
  }
  for (const [collection, fields] of Object.entries(WEEK_FIELDS)) {
    for (const row of state[collection] || []) for (const f of fields) if (row && row[f]) row[f] = mondayOf(addDays(row[f], delta));
  }
  // Contact log notes (staffing P5) carry a full time, not a day: move them by whole days in milliseconds.
  for (const n of state.contactNotes || []) if (n && n.at && Number.isFinite(Date.parse(n.at))) n.at = new Date(Date.parse(n.at) + delta * 86400000).toISOString();
  for (const [collection, fields] of Object.entries(TIME_FIELDS)) {
    for (const row of state[collection] || []) {
      for (const f of fields) { const t = Date.parse(row && row[f]); if (Number.isFinite(t)) row[f] = new Date(t + delta * 86400000).toISOString(); }
    }
  }
  state.seededOn = addDays(state.seededOn, delta);
  return state;
}

/** A list to save: a clean name (unique among `lists`) and a non-empty rule object; throws a StoreError with the problem in words. */
function smartListInput(row, lists) {
  const name = String((row && row.name) || '').replace(/\s+/g, ' ').trim();
  const problem = checkName(name, lists);
  if (problem) throw new StoreError('invalid', problem);
  const rules = row && row.rules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || !Object.keys(rules).length) throw new StoreError('invalid', 'Choose at least one rule for the list.');
  if (lists.length >= SMART_LIST_MAX) throw new StoreError('full', `Your team has ${SMART_LIST_MAX} saved lists. Delete one first.`);
  return { name, rules };
}

export class DemoStore {
  /**
   * @param {{today?:()=>string, now?:()=>string, storage?:Storage|null}} [opts]  `today` returns an ISO day (tests pass a fixed one);
   *        `storage` is where the demo is saved (default window.localStorage; null = memory only).
   */
  constructor(opts) {
    const o = opts || {};
    this.mode = 'demo';
    /** What the data store can keep. The live server has no consultant notes column yet and allows "not rated" vendors. */
    this.capabilities = { consultantNotes: true, unratedTier: false, resumes: true };
    this._today = o.today || (() => todayISO());
    /** The time a demo row changes (updatedAt / createdAt, read by the Today follow-ups); tests pass a fixed one. */
    this._now = o.now || (() => new Date().toISOString());
    this._storage = 'storage' in o ? o.storage : DemoStore._defaultStorage();
    this._state = this._load();
  }

  static _defaultStorage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
  }

  // ── persistence ────────────────────────────────────────────────────────
  _load() {
    const today = this._today();
    let state = null;
    try {
      const raw = this._storage && this._storage.getItem(STORAGE_KEY);
      if (raw) state = JSON.parse(raw);
    } catch (e) { state = null; }
    if (!state || state.version !== 1 || !state.seededOn) return buildSeed(today);
    if (!Array.isArray(state.inboxMessages) || !Array.isArray(state.inboxAddresses)) {
      // A demo saved before the team inbox: add the sample inbox, dated as if it was seeded with the rest.
      const seed = buildSeed(state.seededOn);
      state.inboxAddresses = seed.inboxAddresses; state.inboxMessages = seed.inboxMessages;
      state.team.inboxDomain = seed.team.inboxDomain; state.team.inboxLimit = seed.team.inboxLimit;
    }
    // A demo saved before the contact log (staffing P5): add the sample notes.
    if (!Array.isArray(state.contactNotes)) state.contactNotes = buildSeed(state.seededOn).contactNotes;
    if (!Array.isArray(state.interviews) || !Array.isArray(state.placements)) {
      // A demo saved before interviews and placements (staffing P3): add the samples, dated as if seeded with the rest.
      const p3 = seedP3(state.seededOn);
      state.interviews = p3.interviews; state.placements = p3.placements;
    }
    // A demo saved before targets (staffing P4): add the sample targets and catches, dated as if seeded with the rest.
    if (!Array.isArray(state.targets) || !Array.isArray(state.guardCatches)) {
      const p4 = seedP4(state.seededOn);
      state.targets = p4.targets; state.guardCatches = p4.guardCatches;
    }
    // A demo saved before timesheets and invoices (0055): add the samples, dated as if seeded with the rest.
    if (!Array.isArray(state.timesheets) || !Array.isArray(state.invoices) || !Array.isArray(state.commissionRules)) {
      const b = seedBilling(state.seededOn);
      state.timesheets = b.timesheets; state.invoices = b.invoices; state.commissionRules = b.commissionRules; state.invoiceProfile = b.invoiceProfile;
    }
    const delta = diffDays(today, state.seededOn);
    if (delta > 0) shiftState(state, delta);
    return state;
  }

  _save() {
    try { if (this._storage) this._storage.setItem(STORAGE_KEY, JSON.stringify(this._state)); } catch (e) { /* storage full or blocked: keep working in memory */ }
  }

  _id(prefix) { this._state.seq += 1; return `${prefix}${this._state.seq}`; }

  _log(action, entity, entityId, note) {
    this._state.activity.unshift({ id: this._id('a'), at: this._today(), actor: this._user().id, action, entity, entityId, note: note || '' });
    this._state.activity.length = Math.min(this._state.activity.length, 200);
  }

  _user() {
    const s = this._state;
    const id = DEMO_USER_BY_ROLE[s.session.role] || 'm1';
    return s.members.find((m) => m.id === id && !m.removedAt) || s.members.find((m) => m.role === s.session.role && !m.removedAt) || s.members[0];
  }

  _can(action) { return can(this._state.session.role, action, this._state.team.settings); }
  _require(action) { if (!this._can(action)) throw new Error('Your role cannot do that.'); }

  // ── session ────────────────────────────────────────────────────────────
  async getSession() {
    const s = this._state.session;
    return { mode: 'demo', signedIn: s.signedIn, role: s.role, user: clone(this._user()), today: this._today() };
  }
  async signIn() { this._state.session.signedIn = true; this._save(); return this.getSession(); }
  async signOut() { this._state.session.signedIn = false; this._save(); return this.getSession(); }
  /** "My book" (Solo) reads the encrypted sync vault of a real account: there is none in the demo. */
  async syncCall() { throw new StoreError('demo_only', 'My book needs a real sign-in. It is not part of the demo workspace.'); }
  async setDemoRole(role) {
    if (!ROLES.includes(role)) throw new Error('Unknown role.');
    this._state.session.role = role; this._save(); return this.getSession();
  }
  async resetDemo() {
    const keep = this._state.session;
    this._state = buildSeed(this._today());
    this._state.session = { ...keep };
    this._save();
  }

  // ── team ───────────────────────────────────────────────────────────────
  async getTeam() { return { ...clone(this._state.team), billing: this._billing() }; }
  /** The sample pilot: same shape as the live billingFrom(); read-only once the demo pilot date has passed. */
  _billing() {
    const t = this._state.team;
    const left = diffDays(t.pilotEndsOn, this._today());
    const open = left >= 0;
    return {
      tier: 'pilot', state: open ? 'pilot' : (left >= -30 ? 'read_only' : 'closing'), writable: open, paidUntil: t.pilotEndsOn,
      daysLeft: Math.max(0, left), readOnlyUntil: addDays(t.pilotEndsOn, 30), payNow: left <= 2,
      members: this._state.members.filter((m) => !m.removedAt).length,
      extensionRequested: t.pilotExtensionRequested === true, extended: false, canRequestExtension: t.pilotExtensionRequested !== true
    };
  }
  /** Demo: the tiers and seat limits only. Prices live on the server (plans.js) and show in the live app. */
  async getBilling() {
    return {
      billing: this._billing(), usdCheckout: false, invoiceEmail: '', annual: false, founding: null,
      plans: [
        { id: 'team_starter', tier: 'starter', label: 'Team · 5', seats: 5, inrText: '', usdText: '', period: 'month', months: 1, locked: false },
        { id: 'team_team', tier: 'team', label: 'Team · 15', seats: 15, inrText: '', usdText: '', period: 'month', months: 1, locked: false },
        { id: 'team_agency', tier: 'agency', label: 'Team · 40', seats: 40, inrText: '', usdText: '', period: 'month', months: 1, locked: false }
      ]
    };
  }
  async startCheckout() { throw new StoreError('demo_only', 'Payment works in your own workspace, not in the demo.'); }
  /** Nothing is cached from a server in the demo. */
  forgetTeamCache() {}
  async requestPilotExtension() {
    this._require('billing');
    this._state.team.pilotExtensionRequested = true;
    this._save();
  }
  async refreshBilling() { return this._billing(); }
  /** The demo never takes a payment, so its history is empty. */
  async getBillingHistory() { this._require('billing'); return []; }
  async getReferralLink() { throw new StoreError('demo_only', 'Pilot links work in your own workspace, not in the demo.'); }
  async getPersonalPlan() { return { tier: 'free', planUntil: '' }; }
  async updateTeam(patch) {
    this._require('team_settings');
    const t = this._state.team;
    if (patch.name != null) t.name = String(patch.name).trim() || t.name;
    if (patch.settings) t.settings = { ...t.settings, ...patch.settings, exportPolicy: { ...t.settings.exportPolicy, ...(patch.settings.exportPolicy || {}) },
      payPolicy: { recruiter: false, ...(t.settings.payPolicy || {}), ...(patch.settings.payPolicy || {}) },
      leaderboardPolicy: { others: true, ...(t.settings.leaderboardPolicy || {}), ...(patch.settings.leaderboardPolicy || {}) } };
    this._log('team_updated', 'team', t.id);
    this._save();
    return clone(t);
  }
  async listMembers(opts) {
    const all = (opts && opts.includeRemoved) ? this._state.members : this._state.members.filter((m) => !m.removedAt);
    return clone(all);
  }
  async listInvites() { return clone(this._state.invites); }
  async inviteMember(input) {
    this._require('invite');
    const email = lower(input.email).trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
    const role = input.role === 'manager' ? 'manager' : 'recruiter';
    if (role === 'manager' && !this._can('change_roles')) throw new Error('Your role cannot do that.');
    if (this._state.members.some((m) => lower(m.email) === email && !m.removedAt)) throw new Error('That person is already on the team.');
    if (this._state.invites.some((i) => lower(i.email) === email)) throw new Error('That email already has an invite.');
    // 0056: "Restrict sign-ups to my company domain" (the server's bp_team_invite answers domain_not_allowed the same way)
    const dom = this._state.team.settings && this._state.team.settings.signupDomain;
    if (!emailInDomain(email, dom)) throw new StoreError('domain_not_allowed', domainRefusal(dom), 403);
    const inv = { id: this._id('i'), email, role, invitedBy: this._user().id, expiresOn: addDays(this._today(), 7) };
    this._state.invites.push(inv);
    this._log('member_invited', 'invite', inv.id);
    this._save();
    return clone(inv);
  }
  async setMemberRole(id, role) {
    this._require('change_roles');
    const m = this._state.members.find((x) => x.id === id && !x.removedAt);
    if (!m) throw new Error('Member not found.');
    if (m.id === this._user().id) throw new StoreError('same_user', 'You cannot change your own role.');
    if (!canChangeMember(this._state.session.role, m.role)) throw new Error('Only the owner can change an owner.');
    if (role !== 'manager' && role !== 'recruiter') throw new Error('Unknown role.');
    m.role = role;
    this._log('role_changed', 'member', id);
    this._save();
    return clone(m);
  }
  async removeMember(id) {
    this._require('remove_member');
    const m = this._state.members.find((x) => x.id === id && !x.removedAt);
    if (!m) throw new Error('Member not found.');
    if (m.id === this._user().id) throw new StoreError('use_leave', 'To leave the workspace, use Leave this workspace.');
    if (!canChangeMember(this._state.session.role, m.role)) throw new Error('The owner cannot be removed.');
    m.removedAt = this._today();     // their data stays in the team (created_by / recruiterId keep pointing at them)
    this._log('member_removed', 'member', id);
    this._save();
  }
  async leaveTeam() { throw new StoreError('demo_only', 'Leaving works in your own workspace, not in the demo.'); }
  /** "N of M seats used": members + pending invites. The demo is a pilot, which has no seat limit (limit null). */
  async seatInfo() {
    return { limit: null, used: this._state.members.filter((m) => !m.removedAt).length + this._state.invites.length };
  }
  async revokeInvite(id) {
    this._require('invite');
    const at = this._state.invites.findIndex((i) => i.id === id);
    if (at < 0) throw new StoreError('not_found', 'That invite was not found. It may have been accepted or cancelled.', 404);
    this._state.invites.splice(at, 1);
    this._log('invite_revoked', 'invite', id);
    this._save();
  }
  async resendInvite(id) {
    this._require('invite');
    const inv = this._state.invites.find((i) => i.id === id);
    if (!inv) throw new StoreError('not_found', 'That invite was not found. It may have been accepted or cancelled.', 404);
    inv.expiresOn = addDays(this._today(), 7);
    this._save();
    return clone(inv);
  }
  async transferOwner() { throw new StoreError('demo_only', 'Transferring ownership works in your own workspace, not in the demo.'); }
  async createTeam() { throw new StoreError('demo_only', 'The demo workspace is already set up. Sign in to create your own.'); }
  async acceptInvite() { throw new StoreError('demo_only', 'Invites work in your own workspace, not in the demo.'); }
  /** The whole book for "Export everything": { teamName, exportedOn, tables } with names next to the ids (same shape as live). */
  async exportAll() {
    this._require('export');
    const { consultants, companies, contacts, requirements, submissions, members } = this._state;
    const notes = this._notes();
    const nameOf = (rows) => { const m = new Map(rows.map((r) => [r.id, r.name])); return (id) => m.get(id) || ''; };
    const member = nameOf(members), consultant = nameOf(consultants), company = nameOf(companies), deskName = nameOf(this._desks().list);
    return clone({
      teamName: this._state.team.name, exportedOn: this._today(),
      tables: {
        consultants: consultants.map((c) => ({ ...c, ownerRecruiter: member(c.ownerRecruiterId) })),
        vendor_companies: companies,
        vendor_contacts: contacts.map((c) => ({ ...c, company: company(c.companyId) })),
        requirements: requirements.map((r) => ({ ...r, vendorCompany: company(r.vendorCompanyId), recruiter: member(r.createdBy) })),
        submissions: submissions.map((x) => ({ ...x, consultant: consultant(x.consultantId), vendorCompany: company(x.vendorCompanyId), recruiter: member(x.recruiterId) })),
        contact_notes: notes.map((n) => ({ ...n, createdByName: member(n.createdBy) })),
        // P3 (0051): the server exports these too; pay rates stay out of "Export everything", as for submissions on the server.
        submission_interviews: (this._state.interviews || []).map((x) => ({ ...x, consultant: consultant(x.consultantId) })),
        placements: (this._state.placements || []).map(({ payRate, ...x }) => ({ ...x, consultant: consultant(x.consultantId), vendorCompany: company(x.vendorCompanyId) })),
        // P4 (0052; exported since 0053) with the 0052 read rule: a recruiter gets the team's, the desks' and their own targets only.
        team_targets: (await this.listTargets()).map((x) => ({ ...x, member: x.memberId ? member(x.memberId) : '', desk: x.deskId ? deskName(x.deskId) : '' })),
        // 0057: the weeks for every exporter; invoices and commission rules for owners and managers only (listInvoices / listCommissionRules
        // already return [] to anyone else, the 0055 RLS rule).
        placement_timesheets: await this.listTimesheets({}),
        invoices: await this.listInvoices(),
        commission_rules: (await this.listCommissionRules()).map((x) => ({ ...x, member: x.memberId ? member(x.memberId) : 'Everyone (default)', lead: x.leadMemberId ? member(x.leadMemberId) : '' }))
      }
    });
  }
  /**
   * Import a book built by import-book.js buildBook(). Same merge rules as the server (0014 bp_team_import): contacts by lower-case email,
   * companies by email domain (free mail: by company name), consultants by name; an existing record only gets its empty fields filled.
   */
  async importBook(book) {
    this._require('import');
    const b = book || {};
    const out = { contactsCreated: 0, contactsUpdated: 0, companiesCreated: 0, vendorsSkipped: 0, consultantsCreated: 0, consultantsUpdated: 0, consultantsSkipped: 0, consultantsOverCap: 0 };
    const st = this._state;
    const cap = consultantCap(this._billing());
    const fillIn = (row, patch) => {
      let changed = false;
      for (const [k, v] of Object.entries(patch)) {
        const empty = Array.isArray(row[k]) ? !row[k].length : !row[k];
        if (empty && (Array.isArray(v) ? v.length : v)) { row[k] = v; changed = true; }
      }
      return changed;
    };
    for (const v of (b.vendors || []).slice(0, 5000)) {
      const email = lower(v.email).trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { out.vendorsSkipped += 1; continue; }
      const domain = companyDomain(email);
      const cname = String(v.companyName || '').trim();
      let co = domain ? st.companies.find((c) => c.domain === domain) : (cname ? st.companies.find((c) => !c.domain && lower(c.name) === lower(cname)) : null);
      if (!co && (domain || cname)) {
        co = { id: this._id('v'), createdOn: this._today(), name: cname || domain, domain, tier: v.tier || 'tier2', avoidReason: '', notes: '', doNotContact: false };
        st.companies.push(co);
        out.companiesCreated += 1;
      }
      const patch = { companyId: co ? co.id : '', name: v.name || '', phone: v.phone || '', title: v.title || '' };
      const ct = st.contacts.find((c) => lower(c.email) === email);
      if (ct) { if (fillIn(ct, patch)) out.contactsUpdated += 1; continue; }
      st.contacts.push({ id: this._id('ct'), source: 'import', createdOn: this._today(), createdBy: this._user().id, email, doNotContact: false, ...patch, name: patch.name || email });
      out.contactsCreated += 1;
    }
    for (const c of (b.consultants || []).slice(0, 5000)) {
      const name = String(c.name || '').replace(/\s+/g, ' ').trim();
      if (!name) { out.consultantsSkipped += 1; continue; }
      const patch = {
        title: c.title || '', skills: Array.isArray(c.skills) ? c.skills : [], visa: c.visa || '', visaType: normalizeVisa(c.visa), taxTerms: c.taxTerms || '', rate: c.rate || '',
        location: c.location || '', availableOn: c.availableOn || ''
      };
      const have = st.consultants.find((x) => lower(x.name).replace(/\s+/g, ' ').trim() === lower(name));
      if (have) { if (fillIn(have, patch)) out.consultantsUpdated += 1; continue; }
      if (cap !== null && st.consultants.length >= cap) { out.consultantsSkipped += 1; out.consultantsOverCap += 1; continue; }   // 0038, as bp_team_import
      st.consultants.push({
        id: this._id('c'), name, ...patch, relocation: Boolean(c.relocation), status: c.status || 'marketing',
        ownerRecruiterId: this._user().id, benchSince: this._today(), notes: '', resumeName: ''
      });
      out.consultantsCreated += 1;
    }
    this._log('team_import', 'team', st.team.id);
    this._save();
    return out;
  }
  /** Demo: checks the typed name like the live store, then only resets the sample data. */
  async deleteWorkspace(confirmName) {
    this._require('delete_workspace');
    if (lower(confirmName).trim() !== lower(this._state.team.name).trim()) throw new StoreError('confirm_mismatch', 'Type the workspace name exactly to confirm.');
    await this.resetDemo();
  }

  // ── bench ──────────────────────────────────────────────────────────────
  async listConsultants(f) {
    const q = f || {};
    let rows = this._state.consultants.filter((c) =>
      (q.includeErased || !c.erased) &&
      (!q.status || c.status === q.status) &&
      (!q.recruiterId || c.ownerRecruiterId === q.recruiterId) &&
      (!q.q || textHas([c.name, c.title, c.skills.join(' '), c.location].join(' '), q.q)));
    rows = rows.slice().sort((a, b) => lower(a.benchSince).localeCompare(lower(b.benchSince)));
    return clone(rows);
  }
  async getConsultant(id) { return clone(this._state.consultants.find((c) => c.id === id) || null); }
  async saveConsultant(row) {
    this._require('edit_records');
    const list = this._state.consultants;
    const name = String(row.name || '').trim();
    if (!name) throw new Error('A consultant needs a name.');
    const clean = {
      name, title: String(row.title || '').trim(),
      skills: (Array.isArray(row.skills) ? row.skills : String(row.skills || '').split(',')).map((s) => String(s).trim()).filter(Boolean),
      visa: row.visa || '', taxTerms: row.taxTerms || '', rate: row.rate || '', location: row.location || '',
      relocation: Boolean(row.relocation), availableOn: row.availableOn || '', status: row.status || 'marketing',
      ownerRecruiterId: row.ownerRecruiterId || this._user().id, benchSince: row.benchSince || this._today(),
      notes: row.notes || '', resumeName: row.resumeName || ''
    };
    // Staffing P1: as the server keeps them (0045: a type from the list, a date, a number); only the fields the caller sends, so an older
    // caller never clears them. A new consultant gets the type read from the free-text visa, like the 0045 insert trigger.
    if (row.visaType !== undefined) clean.visaType = VISA_TYPES.includes(row.visaType) ? row.visaType : normalizeVisa(row.visaType);
    if (row.workAuthUntil !== undefined) clean.workAuthUntil = isISODay(row.workAuthUntil) ? row.workAuthUntil : '';
    if (row.rateMin !== undefined) clean.rateMin = cleanRateMin(row.rateMin);
    if (row.rateUnit !== undefined || row.rateMin !== undefined) clean.rateUnit = normalizeRateUnit(row.rateUnit);
    // Staffing P5: the consent fields only when the caller sends them (row.consentOn defined), like the live store.
    if (row.consentOn !== undefined) Object.assign(clean, cleanConsent(row));
    const at = row.id ? list.findIndex((c) => c.id === row.id) : -1;
    if (at >= 0 && list[at].erased) throw new StoreError('erased', ERASED_READ_ONLY, 409);     // 0049: an erased row is read-only
    if (row.deskId !== undefined) {                       // Agency desks (0036): owners and managers only
      clean.deskId = row.deskId && this._desks().list.some((d) => d.id === row.deskId) ? row.deskId : '';
      if (clean.deskId !== (at >= 0 ? list[at].deskId || '' : '')) this._require('manage_desks');
    }
    if (at >= 0) {
      if (clean.ownerRecruiterId !== list[at].ownerRecruiterId) this._require('reassign');
      list[at] = { ...list[at], ...clean };
      this._log('consultant_updated', 'consultant', list[at].id);
      this._save();
      return clone(list[at]);
    }
    const cap = consultantCap(this._billing());          // 0038: the same Starter cap as the server trigger
    if (cap !== null && list.length >= cap) throw new StoreError('plan_limit', CONSULTANT_CAP_NOTE);
    const created = { id: this._id('c'), visaType: normalizeVisa(clean.visa), workAuthUntil: '', rateMin: null, rateUnit: 'hr', consentOn: '', consentSource: '', consentNote: '', erased: false, ...clean };
    list.push(created);
    this._log('consultant_added', 'consultant', created.id);
    this._save();
    return clone(created);
  }

  // ── resumes (the demo keeps the file name and size only, never the file) ──
  _resumes() { if (!Array.isArray(this._state.resumes)) this._state.resumes = []; return this._state.resumes; }
  async listResumes(consultantId) {
    return clone(this._resumes().filter((r) => r.consultantId === consultantId).sort((a, b) => b.seq - a.seq).slice(0, RESUME_KEEP));
  }
  async uploadResume(consultantId, file, check) {
    this._require('edit_records');
    const c = this._state.consultants.find((x) => x.id === consultantId);
    if (!c) throw new StoreError('not_found', 'That consultant is not in your workspace.');
    if (!check || check.problem || !check.ext) throw new StoreError('invalid', (check && check.problem) || 'Please choose a PDF or Word (.docx) file.');
    const list = this._resumes();
    const v = { id: this._id('r'), seq: this._state.seq, consultantId, path: '', fileName: cleanFileName(file.name), mime: check.mime,
      size: Number(file.size) || 0, uploadedBy: this._user().id, uploadedAt: this._today() };
    list.push(v);
    const mine = list.filter((r) => r.consultantId === consultantId).sort((a, b) => b.seq - a.seq);
    const gone = new Set(mine.slice(RESUME_KEEP).map((r) => r.id));
    this._state.resumes = list.filter((r) => !gone.has(r.id));
    c.resumeName = v.fileName;
    this._log('resume_added', 'consultant', consultantId);
    this._save();
    return { id: v.id, pruned: gone.size };
  }
  async resumeLink() {
    throw new StoreError('demo_only', 'The demo keeps only the file name. Sign in to your own workspace to store and open real files.');
  }
  async deleteResume(id) {
    this._require('delete_resume');
    const v = this._resumes().find((r) => r.id === id);
    if (!v) throw new StoreError('not_found', 'That resume version was not found.');
    this._state.resumes = this._resumes().filter((r) => r.id !== id);
    const c = this._state.consultants.find((x) => x.id === v.consultantId);
    const next = this._state.resumes.filter((r) => r.consultantId === v.consultantId).sort((a, b) => b.seq - a.seq)[0];
    if (c) c.resumeName = next ? next.fileName : '';
    this._log('resume_deleted', 'consultant', v.consultantId);
    this._save();
    return { ok: true };
  }

  // ── requirements ───────────────────────────────────────────────────────
  async listRequirements(f) {
    const q = f || {};
    const rows = this._state.requirements
      .filter((r) => (!q.status || r.status === q.status) && (!q.source || r.source === q.source) && (!q.board || r.sourceBoard === q.board) && (!q.q || textHas([r.title, r.endClient, r.location, r.skills.join(' ')].join(' '), q.q)))
      .sort((a, b) => lower(b.postedOn).localeCompare(lower(a.postedOn)));
    return clone(rows).map(withTags);
  }
  async getRequirement(id) { const r = this._state.requirements.find((x) => x.id === id); return r ? withTags(clone(r)) : null; }
  async saveRequirement(row) {
    this._require('edit_records');
    const title = String(row.title || '').trim();
    if (!title) throw new Error('A requirement needs a title.');
    const clean = {
      title, endClient: String(row.endClient || '').trim(), jobRef: String(row.jobRef || '').trim(),
      vendorCompanyId: row.vendorCompanyId || '', vendorContactId: row.vendorContactId || '',
      rateText: row.rateText || '', workMode: row.workMode || '', location: row.location || '', visaText: row.visaText || '',
      taxTerms: row.taxTerms || '', duration: row.duration || '',
      skills: (Array.isArray(row.skills) ? row.skills : String(row.skills || '').split(',')).map((s) => String(s).trim()).filter(Boolean),
      source: row.source || 'manual', sourceBoard: row.source === 'board' ? M.requirementSource(row).sourceBoard : '', sourceUrl: row.sourceUrl || '', postedOn: row.postedOn || this._today(),
      rawText: String(row.rawText || '').slice(0, 20000), status: row.status === 'closed' ? 'closed' : 'open'
    };
    // 0026 tags: the form's when it set them, else the free-text reading (the bp_4_tags trigger on the server)
    Object.assign(clean, cleanTags(row.visaAllowed === undefined ? tagsFromFreeText(clean) : row));
    const list = this._state.requirements;
    const at = row.id ? list.findIndex((r) => r.id === row.id) : -1;
    if (at >= 0) { list[at] = { ...list[at], ...clean }; this._log('requirement_updated', 'requirement', row.id); this._save(); return clone(list[at]); }
    const created = { id: this._id('r'), createdBy: this._user().id, createdAt: this._now(), ...clean };
    list.push(created);
    this._log('requirement_added', 'requirement', created.id);
    this._save();
    return clone(created);
  }

  // ── vendor book ────────────────────────────────────────────────────────
  async listVendors(f) {
    const q = f || {};
    const contacts = this._state.contacts;
    const rows = this._state.companies
      .map((c) => ({ ...c, contactCount: contacts.filter((x) => x.companyId === c.id).length }))
      .filter((c) => {
        if (q.tier && c.tier !== q.tier) return false;
        if (!q.q) return true;
        const emails = contacts.filter((x) => x.companyId === c.id).map((x) => x.email).join(' ');
        return textHas([c.name, c.domain, emails].join(' '), q.q);
      })
      .sort((a, b) => lower(a.name).localeCompare(lower(b.name)));
    return clone(rows);
  }
  async getVendor(id) { return clone(this._state.companies.find((c) => c.id === id) || null); }
  async saveVendor(row) {
    this._require('edit_records');
    const name = String(row.name || '').trim();
    if (!name) throw new Error('A company needs a name.');
    const list = this._state.companies;
    const at = row.id ? list.findIndex((c) => c.id === row.id) : -1;
    const prev = at >= 0 ? list[at] : null;
    const tier = row.tier || (prev ? prev.tier : 'tier2');
    if ((prev ? prev.tier !== tier : tier !== 'tier2') || (prev && (prev.avoidReason || '') !== (row.avoidReason == null ? prev.avoidReason : row.avoidReason))) {
      this._require('set_vendor_tier');     // tiers and the Avoid reason are for owners and managers
    }
    const clean = {
      name, domain: lower(row.domain).trim(), tier,
      avoidReason: tier === 'avoid' ? String(row.avoidReason || '').trim() : '',
      notes: row.notes || '', doNotContact: Boolean(row.doNotContact)
    };
    if (at >= 0) { list[at] = { ...prev, ...clean }; this._log('vendor_updated', 'vendor_company', prev.id); this._save(); return clone(list[at]); }
    const created = { id: this._id('v'), createdOn: this._today(), ...clean };
    list.push(created);
    this._log('vendor_added', 'vendor_company', created.id);
    this._save();
    return clone(created);
  }
  async saveVendorAgreement(id, agreement) {
    this._require('edit_agreements');
    const A = await loadAgreementsLib();
    const at = this._state.companies.findIndex((c) => c.id === id);
    if (at < 0) throw new StoreError('not_found', 'That company was not found.');
    const v = A.validate(agreement, this._state.companies[at]);
    if (!v.ok) throw new StoreError('invalid', v.error);
    this._state.companies[at] = { ...this._state.companies[at], ...v.value };
    this._log('vendor_updated', 'vendor_company', id);
    this._save();
    return clone(this._state.companies[at]);
  }
  async listContacts(f) {
    const q = f || {};
    const rows = this._state.contacts
      .filter((c) => (!q.companyId || c.companyId === q.companyId) && (!q.q || textHas([c.name, c.email, c.title].join(' '), q.q)))
      .sort((a, b) => lower(a.name).localeCompare(lower(b.name)));
    return clone(rows);
  }
  /** Contacts are unique per team by lower-case email: saving an email that exists updates that contact. */
  async saveContact(row) {
    this._require('edit_records');
    const email = lower(row.email).trim();
    const name = String(row.name || '').trim();
    if (!name) throw new Error('A contact needs a name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
    if (!this._state.companies.some((c) => c.id === row.companyId)) throw new Error('Pick a company for this contact.');
    const list = this._state.contacts;
    let at = row.id ? list.findIndex((c) => c.id === row.id) : -1;
    if (at < 0) at = list.findIndex((c) => lower(c.email) === email);
    const clean = { companyId: row.companyId, name, email, phone: row.phone || '', title: row.title || '', doNotContact: Boolean(row.doNotContact) };
    if (at >= 0) { list[at] = { ...list[at], ...clean }; this._log('contact_updated', 'vendor_contact', list[at].id); this._save(); return clone(list[at]); }
    const created = { id: this._id('ct'), source: row.source || 'manual', createdOn: this._today(), createdBy: this._user().id, ...clean };
    list.push(created);
    this._log('contact_added', 'vendor_contact', created.id);
    this._save();
    return clone(created);
  }

  // ── submissions and the guard ──────────────────────────────────────────
  async listSubmissions(f) {
    const q = f || {};
    const today = this._today();
    const rows = this._state.submissions
      .filter((s) =>
        (!q.recruiterId || s.recruiterId === q.recruiterId) &&
        (!q.consultantId || s.consultantId === q.consultantId) &&
        (!q.stage || s.stage === q.stage) &&
        (!q.sinceDays || diffDays(today, s.submittedOn) <= q.sinceDays))
      .sort((a, b) => lower(b.submittedOn).localeCompare(lower(a.submittedOn)));
    const pay = this._seesPay();
    return clone(rows).map((r) => (pay ? { ...r, payHidden: false } : { ...r, payRate: null, payHidden: true }));
  }
  /** Pay rates and margin (0046): owners and managers, recruiters when the owner allows it. The database rule (RLS on submission_pay). */
  _seesPay() { return can(this._state.session.role, 'see_pay', this._state.team.settings); }
  /** The 0046 rules the database enforces (checks and triggers), for the demo: dates in order, positive rates, pay never above bill,
   *  at most 4 chain names, and the RTR status following the RTR day. Returns the cleaned fields, or throws. */
  _p2Fields(row, before) {
    const b = before || {};
    const out = {};
    const has = (k) => row[k] !== undefined;
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
    const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); if (!Number.isFinite(n) || n <= 0 || n >= 1000000) throw new StoreError('invalid', 'Enter rates as numbers, for example 65.'); return Math.round(n * 100) / 100; };
    if (has('rtrOn')) out.rtrOn = day(row.rtrOn);
    if (has('rtrUntil')) out.rtrUntil = day(row.rtrUntil);
    if (has('rtrRate')) out.rtrRate = num(row.rtrRate);
    if (has('billRate')) out.billRate = num(row.billRate);
    if (has('rateUnit')) out.rateUnit = ['hr', 'day', 'month', 'year'].includes(row.rateUnit) ? row.rateUnit : 'hr';
    if (has('taxTerms')) out.taxTerms = ['C2C', 'W2', '1099'].includes(row.taxTerms) ? row.taxTerms : '';
    if (has('chain')) {
      const seen = new Set();
      out.chain = (Array.isArray(row.chain) ? row.chain : []).map((x) => String(x).replace(/\s+/g, ' ').trim().slice(0, 120))
        .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).slice(0, 4);
    }
    if (has('rtrStatus')) out.rtrStatus = ['none', 'requested', 'signed'].includes(row.rtrStatus) ? row.rtrStatus : 'none';
    if (has('payRate')) {
      if (!this._seesPay()) throw new StoreError('forbidden', 'Only an owner or manager can see or change pay rates.', 403);
      out.payRate = num(row.payRate);
    }
    const m = { ...b, ...out };
    if (has('rtrStatus') && out.rtrStatus !== 'signed' && b.rtrStatus === 'signed' && !has('rtrOn')) m.rtrOn = '';
    if (has('rtrOn') && !out.rtrOn && !has('rtrStatus') && b.rtrOn) m.rtrStatus = 'none';   // the day was cleared: the RTR is withdrawn
    if (!m.rtrOn && m.rtrStatus === 'signed') m.rtrOn = m.submittedOn || this._today();
    if (m.rtrOn) m.rtrStatus = 'signed'; else { m.rtrUntil = ''; m.rtrRate = null; if (m.rtrStatus === 'signed') m.rtrStatus = 'none'; }
    if (m.rtrOn && m.rtrUntil && m.rtrUntil < m.rtrOn) throw new StoreError('invalid', 'The RTR end date is before the day it was given. Check the dates.');
    if (m.payRate != null && m.billRate != null && m.payRate > m.billRate) throw new StoreError('invalid', 'The pay rate is above the bill rate. Raise the bill rate or lower the pay rate.');
    return { rtrOn: m.rtrOn || '', rtrUntil: m.rtrUntil || '', rtrRate: m.rtrRate == null ? null : m.rtrRate, rtrStatus: m.rtrStatus || 'none',
      billRate: m.billRate == null ? null : m.billRate, rateUnit: m.rateUnit || 'hr', taxTerms: m.taxTerms || '', chain: m.chain || [], payRate: m.payRate == null ? null : m.payRate };
  }
  /** Earlier submissions in the last 90 days that match: same consultant AND (same end client OR requirement OR job reference). */
  async checkGuard(query) {
    const matches = checkGuard(query, this._state.submissions, { today: this._today() });
    if (matches.length) this._countCatch();   // 0052: a warning shown is a duplicate caught, counted for the person
    return clone(matches);
  }

  // ── P4 (0052): targets and the guard's catches per person, with the database's rules (demo-only copies of its checks and RLS) ──
  _targetRows() { return this._state.targets || (this._state.targets = []); }
  /** RLS team_targets_select: owners and managers read every target; a recruiter the team's, the desks' and their own. */
  async listTargets() {
    const me = this._user().id;
    const lead = this._state.session.role !== 'recruiter';
    return clone(this._targetRows().filter((t) => lead || !t.memberId || t.memberId === me));
  }
  /** row: BP.Targets.cleanTarget's shape plus memberId / deskId ('' = everyone), and id to change the numbers of one. */
  async saveTarget(row) {
    if (!canNow(this._state.session.role, 'set_targets', this._state.team.settings, this._billing().writable)) {
      throw new StoreError('forbidden', this._billing().writable ? 'Only an owner or manager can set targets.' : 'The workspace is read-only until the plan is paid.', 403);
    }
    if (!hasFeature(this._billing(), 'targets')) throw new StoreError('plan', PLAN_HINTS.targets_plan);
    const r = row || {};
    const nums = {};
    for (const k of ['submissions', 'interviews', 'placements']) {
      const n = r[k] === '' || r[k] === null || r[k] === undefined ? 0 : Number(r[k]);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw new StoreError('invalid', 'Targets are whole numbers from 0 to 1000.');
      nums[k] = n;
    }
    if (!(nums.submissions + nums.interviews + nums.placements)) throw new StoreError('invalid', 'Set at least one number above 0.');
    const list = this._targetRows();
    if (r.id) {
      const t = list.find((x) => x.id === r.id);
      if (!t) throw new StoreError('not_found', 'That target was not found. It may have been removed.', 404);
      Object.assign(t, nums, { updatedAt: this._now() });
      this._log('target_updated', 'team_targets', t.id);
      this._save();
      return clone(t);
    }
    if (!['day', 'week', 'month'].includes(r.period)) throw new StoreError('invalid', 'Pick a period: day, week or month.');
    const memberId = r.memberId || '', deskId = r.deskId || '';
    if (memberId && deskId) throw new StoreError('invalid', 'A target is for the team, a desk or one person.');
    if (memberId && !this._state.members.some((m) => m.id === memberId && !m.removedAt)) throw new StoreError('invalid', 'Targets are for active members of the team.');
    if (deskId && !this._desks().list.some((x) => x.id === deskId)) throw new StoreError('not_found', 'That desk was not found.');
    if (list.some((x) => (x.memberId || '') === memberId && (x.deskId || '') === deskId && x.period === r.period)) {
      throw new StoreError('invalid', 'There is already a target for this scope and period. Change that one instead.');
    }
    const created = { id: this._id('tg'), memberId, deskId, period: r.period, ...nums, updatedAt: this._now() };
    list.push(created);
    this._log('target_added', 'team_targets', created.id);
    this._save();
    return clone(created);
  }
  async deleteTarget(id) {
    if (!canNow(this._state.session.role, 'set_targets', this._state.team.settings, this._billing().writable)) throw new StoreError('forbidden', 'Only an owner or manager can remove targets.', 403);
    const list = this._targetRows();
    const at = list.findIndex((x) => x.id === id);
    if (at < 0) throw new StoreError('not_found', 'That target was not found.', 404);
    list.splice(at, 1);
    this._log('target_deleted', 'team_targets', id);
    this._save();
  }
  /** RLS team_guard_catches_by_select: owners and managers read every person's catches; a recruiter only their own. {from, to} ISO days. */
  async listGuardCatches(f) {
    const q = f || {};
    const me = this._user().id;
    const lead = this._state.session.role !== 'recruiter';
    return clone((this._state.guardCatches || []).filter((c) => (lead || c.userId === me) && (!q.from || c.day >= q.from) && (!q.to || c.day <= q.to)));
  }
  /** 0052 bp_team_guard_for: a check that shows a match counts one catch for the person on the team's day. */
  _countCatch() {
    const list = this._state.guardCatches || (this._state.guardCatches = []);
    const day = this._today(), userId = this._user().id;
    const row = list.find((c) => c.day === day && c.userId === userId);
    if (row) row.warned += 1; else list.push({ day, userId, warned: 1 });
    this._save();
  }


  // ── P3 (0051): interviews and placements, with the database's rules (demo-only copies of its checks and triggers) ──
  async listInterviews(f) {
    const q = f || {};
    return clone((this._state.interviews || [])
      .filter((i) => (!q.submissionId || i.submissionId === q.submissionId) && (!q.from || i.at >= q.from) && (!q.to || i.at < q.to))
      .sort((a, b) => String(a.at).localeCompare(String(b.at))));
  }
  async saveInterview(row) {
    this._require('edit_records');
    const list = this._state.interviews || (this._state.interviews = []);
    const r = row || {};
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) throw new StoreError('invalid', 'Enter the interview date and time.');
    let zoneOk = false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: r.tz }); zoneOk = Boolean(r.tz); } catch (e) { zoneOk = false; }
    if (!zoneOk) throw new StoreError('invalid', 'Pick a time zone from the list.');
    const round = Number(r.round);
    if (!(round >= 1 && round <= 10)) throw new StoreError('invalid', 'The round is a number from 1 to 10.');
    const fields = { at: new Date(at).toISOString(), tz: r.tz, round, mode: ['phone', 'video', 'onsite'].includes(r.mode) ? r.mode : 'video',
      withWhom: String(r.withWhom || '').replace(/\s+/g, ' ').trim().slice(0, 120), feedback: String(r.feedback || '').trim().slice(0, 1000),
      outcome: ['pending', 'passed', 'failed', 'no_show'].includes(r.outcome) ? r.outcome : 'pending', updatedAt: this._now() };
    if (r.id) {
      const at2 = list.findIndex((x) => x.id === r.id);
      if (at2 < 0) throw new StoreError('not_found', 'That interview was not found. It may have been removed.', 404);
      list[at2] = { ...list[at2], ...fields };
      this._log('interview_updated', 'interview', r.id);
      this._save();
      return clone(list[at2]);
    }
    const sub = this._state.submissions.find((s) => s.id === r.submissionId);
    if (!sub) throw new StoreError('not_found', 'That submission was not found.', 404);
    const created = { id: this._id('iv'), submissionId: sub.id, consultantId: sub.consultantId, ...fields, createdBy: this._user().id, createdAt: this._now() };
    list.push(created);
    if (sub.stage === 'submitted' || sub.stage === 'vendor_screen') { sub.stage = 'client_interview'; sub.updatedAt = this._now(); }
    this._log('interview_added', 'interview', created.id);
    this._save();
    return clone(created);
  }
  async deleteInterview(id) {
    this._requireDelete();
    this._state.interviews = this._state.interviews || [];
    this._drop('interviews', id, 'interview');
    this._save();
    return { ok: true };
  }
  /** The placement status on a day (0051 bp_team_placement_status; lib/placements.js placementStatus). */
  _placementStatus(p) {
    const t = this._today();
    if (p.status === 'fell_through' || p.status === 'ended') return p.status;
    if (p.startOn > t) return 'upcoming';
    if (p.endOn && p.endOn < t) return 'ended';
    return 'active';
  }
  /** 0051 bp_team_placement_follow: the consultant is placed when a placement turns active, back to marketing when the last one stops. */
  _placementFollow(consultantId, placementId, wasActive, isActive) {
    const c = this._state.consultants.find((x) => x.id === consultantId);
    if (!c) return;
    if (isActive && !wasActive && c.status !== 'placed') c.status = 'placed';
    else if (wasActive && !isActive && c.status === 'placed'
      && !(this._state.placements || []).some((p) => p.consultantId === consultantId && p.id !== placementId && p.status === 'active')) c.status = 'marketing';
  }
  async listPlacements() {
    const pay = this._seesPay();
    return clone((this._state.placements || []).map((p) => ({ ...p, status: this._placementStatus(p) })))
      .sort((a, b) => String(b.startOn).localeCompare(String(a.startOn)))
      .map((p) => (pay ? { ...p, payHidden: false } : { ...p, payRate: null, payHidden: true }));
  }
  async savePlacement(row) {
    this._require('edit_records');
    const list = this._state.placements || (this._state.placements = []);
    const r = row || {};
    const at = r.id ? list.findIndex((x) => x.id === r.id) : -1;
    if (r.id && at < 0) throw new StoreError('not_found', 'That placement was not found. It may have been removed.', 404);
    const before = at >= 0 ? list[at] : null;
    const sub = this._state.submissions.find((s) => s.id === (before ? before.submissionId : r.submissionId));
    if (!sub) throw new StoreError('not_found', 'That submission was not found.', 404);
    if (!before && list.some((p) => p.submissionId === sub.id)) throw new StoreError('invalid', 'This submission already has a placement. Edit it instead.');
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
    const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n >= 1000000) throw new StoreError('invalid', 'Enter rates as numbers, for example 65.'); return Math.round(n * 100) / 100; };
    const m = {
      startOn: day(r.startOn !== undefined ? r.startOn : before && before.startOn), endOn: day(r.endOn !== undefined ? r.endOn : before && before.endOn),
      billRate: r.billRate !== undefined ? num(r.billRate) : (before ? before.billRate : null),
      rateUnit: ['hr', 'day', 'month', 'year'].includes(r.rateUnit) ? r.rateUnit : (before ? before.rateUnit : 'hr'),
      taxTerms: r.taxTerms !== undefined ? (['C2C', 'W2', '1099'].includes(r.taxTerms) ? r.taxTerms : '') : (before ? before.taxTerms : ''),
      poRef: r.poRef !== undefined ? String(r.poRef || '').replace(/\s+/g, ' ').trim().slice(0, 100) : (before ? before.poRef : ''),
      status: ['upcoming', 'active', 'ended', 'fell_through'].includes(r.status) ? r.status : (before ? before.status : 'active')
    };
    if (!m.startOn) throw new StoreError('invalid', 'Enter the start date.');
    if (m.endOn && m.endOn < m.startOn) throw new StoreError('invalid', 'The end date is before the start date. Check the dates.');
    let payRate = before ? before.payRate : null;
    if (r.payRate !== undefined) {
      if (!this._seesPay()) throw new StoreError('forbidden', 'Only an owner or manager can see or change pay rates.', 403);
      payRate = num(r.payRate);
    }
    if (payRate !== null && m.billRate !== null && payRate > m.billRate) throw new StoreError('invalid', 'The pay rate is above the bill rate. Raise the bill rate or lower the pay rate.');
    if (m.status === 'upcoming') m.status = 'active';
    m.status = this._placementStatus(m);
    const wasActive = Boolean(before && before.status === 'active');
    const saved = { ...(before || { id: this._id('pl'), submissionId: sub.id, consultantId: sub.consultantId, endClient: sub.endClient || '', vendorCompanyId: sub.vendorCompanyId || '', createdBy: this._user().id, createdAt: this._now() }),
      ...m, payRate, updatedAt: this._now() };
    if (at >= 0) list[at] = saved; else list.push(saved);
    this._placementFollow(sub.consultantId, saved.id, wasActive, saved.status === 'active');
    if (saved.status !== 'fell_through' && (!before || before.status === 'fell_through') && sub.stage !== 'placed') { sub.stage = 'placed'; sub.updatedAt = this._now(); }
    this._log(before ? 'placement_updated' : 'placement_added', 'placement', saved.id);
    this._save();
    const out = clone(saved);
    return this._seesPay() ? { ...out, payHidden: false } : { ...out, payRate: null, payHidden: true };
  }
  async deletePlacement(id) {
    this._requireDelete();
    this._state.placements = this._state.placements || [];
    // 0055: a placement with invoices stays (invoices_placement_fk); its timesheets go with it (on delete cascade).
    if (this._rows('invoices').some((i) => i.placementId === id)) throw new StoreError('linked', 'This placement has invoices. Remove them first, or set the placement to Ended instead.');
    this._state.timesheets = this._rows('timesheets').filter((t) => t.placementId !== id);
    const gone = this._drop('placements', id, 'placement');
    this._placementFollow(gone.consultantId, gone.id, gone.status === 'active', false);
    this._save();
    return { ok: true };
  }

  // ── 0055: timesheets, invoices and commission rules, with the database's rules (demo-only copies of its checks, triggers and RLS) ──
  _invoicingGate(action) {
    const writable = this._billing().writable;
    if (!canNow(this._state.session.role, action, this._state.team.settings, writable)) {
      throw new StoreError('forbidden', writable ? 'Only an owner or manager can do that.' : 'The workspace is read-only until the plan is paid.', 403);
    }
  }
  _invoicingPlan() { if (!hasFeature(this._billing(), 'invoicing')) throw new StoreError('plan', 'Timesheets, invoices and commission come with Team · 15.'); }
  _rows(name) { return this._state[name] || (this._state[name] = []); }
  /** RLS placement_timesheets_select: every member. {placementId} narrows to one placement. Newest week first. */
  async listTimesheets(f) {
    const q = f || {};
    return clone(this._rows('timesheets').filter((t) => !q.placementId || t.placementId === q.placementId)
      .sort((a, b) => String(b.weekStart).localeCompare(String(a.weekStart))));
  }
  /** row: BP.Timesheets.cleanTimesheet's shape plus placementId (a new one) or id (an edit). 0055 bp_team_timesheet_check's rules. */
  async saveTimesheet(row) {
    this._invoicingGate('edit_records');
    const r = row || {};
    const list = this._rows('timesheets');
    const before = r.id ? list.find((t) => t.id === r.id) : null;
    if (r.id && !before) throw new StoreError('not_found', 'That timesheet was not found. It may have been removed.', 404);
    if (!before) this._invoicingPlan();
    if (before && before.invoiceId) throw new StoreError('locked', 'This week is on an invoice. Remove the invoice first to change the hours.');
    const pl = (this._state.placements || []).find((p) => p.id === (before ? before.placementId : r.placementId));
    if (!pl) throw new StoreError('not_found', 'That placement was not found.', 404);
    const week = String(r.weekStart || '');
    if (!isISODay(week) || new Date(week + 'T00:00:00Z').getUTCDay() !== 1) throw new StoreError('invalid', 'Pick the week.');
    if (addDays(week, 6) < pl.startOn || (pl.endOn && week > pl.endOn)) throw new StoreError('invalid', 'That week is outside the placement dates.');
    const hrs = (v) => { const n = Number(v || 0); if (!Number.isFinite(n) || n < 0 || n > 168) throw new StoreError('invalid', 'Hours are a number from 0 to 168.'); return Math.round(n * 100) / 100; };
    const regular = hrs(r.regular), ot = hrs(r.ot);
    if (regular + ot > 168) throw new StoreError('invalid', 'A week has 168 hours. Check the numbers.');
    const status = ['draft', 'submitted', 'approved'].includes(r.status) ? r.status : 'draft';
    const approvedBy = String(r.approvedBy || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (status === 'approved' && (!approvedBy || regular + ot <= 0)) throw new StoreError('invalid', 'Add who approved the hours, and some hours.');
    if (list.some((t) => t.placementId === pl.id && t.weekStart === week && t.id !== (before && before.id))) {
      throw new StoreError('duplicate', 'There is already a timesheet for that week. Edit that one.');
    }
    const fields = { weekStart: week, regular, ot, approvedBy, status, updatedAt: this._now() };
    if (before) {
      Object.assign(before, fields);
      this._log('timesheet_updated', 'placement_timesheets', before.id);
      this._save();
      return clone(before);
    }
    const created = { id: this._id('ts'), placementId: pl.id, invoiceId: '', createdBy: this._user().id, ...fields };
    list.push(created);
    this._log('timesheet_added', 'placement_timesheets', created.id);
    this._save();
    return clone(created);
  }
  async deleteTimesheet(id) {
    this._requireDelete();
    const t = this._rows('timesheets').find((x) => x.id === id);
    if (!t) throw new StoreError('not_found', 'That timesheet was not found.', 404);
    if (t.invoiceId) throw new StoreError('locked', 'This week is on an invoice. Remove the invoice first.');
    this._drop('timesheets', id, 'timesheet');
    this._save();
    return { ok: true };
  }
  /** RLS invoices_select: owners and managers only (a recruiter gets none). Newest first. */
  async listInvoices() {
    if (!this._can('invoices')) return [];
    return clone(this._rows('invoices').map((i) => ({ ...i, amount: Math.round(((i.regularHours || 0) * i.billRate + (i.otHours || 0) * i.otRate) * 100) / 100 }))
      .sort((a, b) => String(b.issuedOn).localeCompare(String(a.issuedOn)) || String(b.number).localeCompare(String(a.number))));
  }
  /** 0055 bp_team_invoice_create: the approved weeks not invoiced yet (from / to: the weeks to include) x the hourly bill rate. */
  async createInvoice(row) {
    this._invoicingGate('manage_invoices');
    this._invoicingPlan();
    const r = row || {};
    const pl = (this._state.placements || []).find((p) => p.id === r.placementId);
    if (!pl) throw new StoreError('not_found', 'That placement was not found. It may have been removed.', 404);
    if (pl.rateUnit !== 'hr') throw new StoreError('not_hourly', 'Invoices from timesheets need an hourly bill rate. Change the placement\'s rate unit to per hour.');
    if (!pl.billRate) throw new StoreError('no_bill_rate', 'Add the bill rate to the placement first.');
    const number = String(r.number || '').trim();
    if (!number || number.length > 40) throw new StoreError('invalid_number', 'Enter an invoice number of up to 40 characters.');
    if (this._rows('invoices').some((i) => i.number.toLowerCase() === number.toLowerCase())) throw new StoreError('number_taken', 'That invoice number is already used. Pick another.');
    let otRate = pl.billRate;
    if (r.otRate !== undefined && r.otRate !== null && r.otRate !== '') {
      otRate = Number(r.otRate);
      if (!(otRate > 0 && otRate < 1000000)) throw new StoreError('invalid_rate', 'Enter the overtime rate as a number, for example 97.50.');
      otRate = Math.round(otRate * 100) / 100;
    }
    const issuedOn = isISODay(r.issuedOn) ? r.issuedOn : this._today();
    const monday = (d) => { const wd = new Date(d + 'T00:00:00Z').getUTCDay(); return addDays(d, wd === 0 ? -6 : 1 - wd); };
    const from = isISODay(r.from) ? monday(r.from) : '', to = isISODay(r.to) ? r.to : '';
    const weeks = this._rows('timesheets').filter((t) => t.placementId === pl.id && t.status === 'approved' && !t.invoiceId && (!from || t.weekStart >= from) && (!to || t.weekStart <= to));
    const regularHours = weeks.reduce((a, t) => a + t.regular, 0), otHours = weeks.reduce((a, t) => a + t.ot, 0);
    if (!weeks.length || regularHours + otHours <= 0) throw new StoreError('nothing_to_invoice', 'No approved week to invoice. Approve the timesheets first.');
    const starts = weeks.map((t) => t.weekStart).sort();
    let periodFrom = starts[0], periodTo = addDays(starts[starts.length - 1], 6);
    if (periodFrom < pl.startOn) periodFrom = pl.startOn;
    if (pl.endOn && periodTo > pl.endOn) periodTo = pl.endOn;
    const vendor = (this._state.companies || []).find((v) => v.id === pl.vendorCompanyId);
    const netTerms = vendor && [15, 30, 45, 60, 90].includes(Number(vendor.netTerms)) ? Number(vendor.netTerms) : 30;
    const inv = { id: this._id('inv'), placementId: pl.id, number, periodFrom, periodTo, regularHours: Math.round(regularHours * 100) / 100, otHours: Math.round(otHours * 100) / 100,
      billRate: pl.billRate, otRate, currency: 'USD', issuedOn, netTerms, dueOn: addDays(issuedOn, netTerms), status: 'draft', sentOn: '', paidOn: '', note: '',
      createdBy: this._user().id, createdAt: this._now(), updatedAt: this._now() };
    this._rows('invoices').push(inv);
    for (const t of weeks) t.invoiceId = inv.id;
    this._log('invoice_added', 'invoice', inv.id);
    this._save();
    return (await this.listInvoices()).find((x) => x.id === inv.id);
  }
  /** patch: BP.Invoices.updateInvoice's result (status, sentOn, paidOn, dueOn, note). 0055 bp_team_invoice_check. */
  async updateInvoice(id, patch) {
    this._invoicingGate('manage_invoices');
    const inv = this._rows('invoices').find((x) => x.id === id);
    if (!inv) throw new StoreError('not_found', 'That invoice was not found. It may have been removed.', 404);
    const p = patch || {};
    const status = ['draft', 'sent', 'paid'].includes(p.status) ? p.status : inv.status;
    const dueOn = isISODay(p.dueOn) ? p.dueOn : inv.dueOn;
    if (dueOn < inv.issuedOn) throw new StoreError('invalid', 'The due date must be on or after the invoice date.');
    const next = { status, dueOn, note: p.note !== undefined ? String(p.note || '').trim().slice(0, 300) : inv.note };
    if (status === 'draft') { next.sentOn = ''; next.paidOn = ''; }
    if (status === 'sent') { next.paidOn = ''; next.sentOn = (isISODay(p.sentOn) && p.sentOn) || inv.sentOn || this._today(); }
    if (status === 'paid') { next.sentOn = inv.sentOn || inv.issuedOn; next.paidOn = (isISODay(p.paidOn) && p.paidOn) || this._today(); }
    if (status === 'paid' && next.paidOn < inv.issuedOn) throw new StoreError('invalid', 'The payment date is before the invoice date. Check the date.');
    Object.assign(inv, next, { updatedAt: this._now() });
    this._log('invoice_updated', 'invoice', id);
    this._save();
    return (await this.listInvoices()).find((x) => x.id === id);
  }
  /** Removing an invoice frees its weeks (0055: on delete set null). */
  async deleteInvoice(id) {
    this._invoicingGate('manage_invoices');
    const list = this._rows('invoices');
    if (!list.some((x) => x.id === id)) throw new StoreError('not_found', 'That invoice was not found.', 404);
    this._state.invoices = list.filter((x) => x.id !== id);
    for (const t of this._rows('timesheets')) if (t.invoiceId === id) t.invoiceId = '';
    this._log('invoice_deleted', 'invoice', id);
    this._save();
    return { ok: true };
  }
  /** RLS commission_rules_*: owners and managers only. */
  async listCommissionRules() {
    if (!(this._state.session.role === 'owner' || this._state.session.role === 'manager')) return [];
    return clone(this._rows('commissionRules'));
  }
  /** row: BP.Commission.cleanRule's shape (memberId '' = the default rule), id to change one. 0055 bp_team_commission_check. */
  async saveCommissionRule(row) {
    this._invoicingGate('set_commission');
    const r = row || {};
    const list = this._rows('commissionRules');
    const before = r.id ? list.find((x) => x.id === r.id) : null;
    if (r.id && !before) throw new StoreError('not_found', 'That rule was not found. It may have been removed.', 404);
    if (!before) this._invoicingPlan();
    const memberId = before ? before.memberId : String(r.memberId || '');
    const active = (id) => this._state.members.some((m) => m.id === id && !m.removedAt);
    if (!before && memberId && !active(memberId)) throw new StoreError('invalid', 'Rules are for active members of the team.');
    if (!['margin_pct', 'fixed'].includes(r.basis)) throw new StoreError('invalid', 'Pick % of margin or a fixed amount per placement.');
    const pct = r.basis === 'margin_pct' ? Number(r.pct) : null, fixed = r.basis === 'fixed' ? Number(r.fixed) : null;
    if (r.basis === 'margin_pct' && !(pct > 0 && pct <= 100)) throw new StoreError('invalid', 'Enter the percentage of margin, from 0.01 to 100.');
    if (r.basis === 'fixed' && !(fixed > 0 && fixed < 1000000)) throw new StoreError('invalid', 'Enter the fixed amount per placement, for example 500.');
    const leadMemberId = String(r.leadMemberId || '');
    const leadSharePct = leadMemberId ? Number(r.leadSharePct) : 0;
    if (leadMemberId && (leadMemberId === memberId || !(leadSharePct > 0 && leadSharePct <= 100))) throw new StoreError('invalid', 'The lead is someone else, with a share from 1 to 100%.');
    if (leadMemberId && leadMemberId !== (before && before.leadMemberId) && !active(leadMemberId)) throw new StoreError('invalid', 'The lead must be an active member of the team.');
    if (!before && list.some((x) => x.memberId === memberId)) throw new StoreError('duplicate', 'There is already a rule for that person. Change that one.');
    const fields = { basis: r.basis, pct, fixed, leadMemberId, leadSharePct, updatedAt: this._now() };
    if (before) { Object.assign(before, fields); this._log('commission_rule_updated', 'commission_rules', before.id); this._save(); return clone(before); }
    const created = { id: this._id('cr'), memberId, ...fields };
    list.push(created);
    this._log('commission_rule_added', 'commission_rules', created.id);
    this._save();
    return clone(created);
  }
  async deleteCommissionRule(id) {
    this._invoicingGate('set_commission');
    const list = this._rows('commissionRules');
    if (!list.some((x) => x.id === id)) throw new StoreError('not_found', 'That rule was not found.', 404);
    this._state.commissionRules = list.filter((x) => x.id !== id);
    this._log('commission_rule_deleted', 'commission_rules', id);
    this._save();
    return { ok: true };
  }
  /** The firm's invoice details (team_branding, 0055 columns). Every member reads them; owners and managers write them. */
  async getInvoiceProfile() {
    const b = this._state.branding || {};
    return clone({ companyName: b.companyName || 'Northwind Consulting', prefix: 'INV-', address: '', email: '', phone: '', taxId: '', paymentDetails: '', ...(this._state.invoiceProfile || {}) });
  }
  /** row: BP.Invoices.cleanProfile's result. The company name is the branding's (one name on emails and invoices). */
  async saveInvoiceProfile(row) {
    this._invoicingGate('manage_invoices');
    const p = row || {};
    if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) throw new StoreError('invalid', 'Check the invoice details: the billing email must be an address and the prefix has no spaces.');
    if (/\s/.test(p.prefix || '')) throw new StoreError('invalid', 'Check the invoice details: the billing email must be an address and the prefix has no spaces.');
    const { companyName, ...rest } = p;
    this._state.invoiceProfile = rest;
    if (companyName !== undefined) this._state.branding = { ...(this._state.branding || { website: 'https://northwind.example.com' }), companyName: String(companyName || '').trim().slice(0, 80) };
    this._log('invoice_profile_updated', 'team', this._state.team.id);
    this._save();
    return this.getInvoiceProfile();
  }
  /**
   * New submissions run the guard. A match blocks the save unless `opts.overrideReason` has at least 8 characters;
   * the reason is stored on the submission and in the activity log. Editing an existing submission (stage, RTR) skips the guard.
   */
  async saveSubmission(row, opts) {
    this._require('edit_records');
    const list = this._state.submissions;
    const at = row.id ? list.findIndex((s) => s.id === row.id) : -1;
    if (at >= 0) {
      const { stage, rate } = row;
      const p2 = this._p2Fields(row, list[at]);
      list[at] = { ...list[at], ...(stage ? { stage } : {}), ...(rate != null ? { rate } : {}), ...p2, updatedAt: this._now() };
      this._log('submission_updated', 'submission', row.id);
      this._save();
      return clone(list[at]);
    }
    const forWho = row.consultantId ? this._state.consultants.find((c) => c.id === row.consultantId) : null;
    if (!forWho) throw new Error('Pick a consultant.');
    if (forWho.erased) throw new StoreError('erased', ERASED_READ_ONLY, 409);           // 0049: no new submission for an erased consultant
    const endClient = String(row.endClient || '').trim();
    if (!endClient && !row.requirementId) throw new Error('Add the end client, or pick a requirement.');
    const matches = checkGuard({ consultantId: row.consultantId, endClient, requirementId: row.requirementId, jobRef: row.jobRef }, list, { today: this._today() });
    const reason = String((opts && opts.overrideReason) || '').trim();
    if (matches.length && !reasonOk(reason)) {
      const err = new Error('Already submitted. Type a reason (at least 8 characters) to continue.');
      err.code = 'guard_block';
      err.matches = clone(matches);
      throw err;
    }
    const created = {
      id: this._id('s'), consultantId: row.consultantId, requirementId: row.requirementId || null,
      vendorCompanyId: row.vendorCompanyId || '', vendorContactId: row.vendorContactId || '',
      endClient, jobRef: String(row.jobRef || '').trim(), rate: row.rate || '',
      ...this._p2Fields({ rtrStatus: 'none', ...row }, { submittedOn: row.submittedOn || this._today() }), stage: row.stage || 'submitted',
      submittedOn: row.submittedOn || this._today(), recruiterId: this._user().id,
      overrideReason: matches.length ? reason : '', createdAt: this._now(), updatedAt: this._now()
    };
    list.push(created);
    this._log(matches.length ? 'guard_override' : 'submission_created', 'submission', created.id, matches.length ? reason : '');
    this._save();
    return clone(created);
  }

  // ── delete (owners and managers; the same rules as the database: record-delete.js, 0011 FKs) ──
  _requireDelete() { if (!canDeleteRecords(this._state.session.role, this._billing().writable)) throw new StoreError('forbidden', 'Only an owner or manager can delete records.', 403); }
  _drop(list, id, what) {
    const at = this._state[list].findIndex((x) => x.id === id);
    if (at < 0) throw new StoreError('not_found', 'That ' + what + ' was not found. It may have been deleted already.', 404);
    return this._state[list].splice(at, 1)[0];
  }
  async deleteConsultant(id) {
    this._requireDelete();
    if (this._state.submissions.some((s) => s.consultantId === id)) throw new StoreError('linked', CONSULTANT_HAS_SUBMISSIONS, 409);
    this._drop('consultants', id, 'consultant');
    this._state.resumes = this._resumes().filter((r) => r.consultantId !== id);
    this._dropNotes('consultant', [id]);                  // 0049: notes go with their consultant
    this._log('consultant_deleted', 'consultant', id);
    this._save();
    return { ok: true };
  }
  async deleteRequirement(id) {
    this._requireDelete();
    this._drop('requirements', id, 'requirement');
    for (const s of this._state.submissions) if (s.requirementId === id) s.requirementId = null;
    this._log('requirement_deleted', 'requirement', id);
    this._save();
    return { ok: true };
  }
  /** The company and its contacts (a contact always belongs to a company in this app). Requirements and submissions lose the link. */
  async deleteVendor(id) {
    this._requireDelete();
    this._drop('companies', id, 'company');
    const gone = new Set(this._state.contacts.filter((c) => c.companyId === id).map((c) => c.id));
    this._state.contacts = this._state.contacts.filter((c) => !gone.has(c.id));
    this._dropNotes('vendor_contact', [...gone]);
    for (const r of [...this._state.requirements, ...this._state.submissions]) {
      if (r.vendorCompanyId === id) r.vendorCompanyId = '';
      if (gone.has(r.vendorContactId)) r.vendorContactId = '';
    }
    this._log('vendor_deleted', 'vendor_company', id);
    this._save();
    return { ok: true, contacts: gone.size };
  }
  async deleteContact(id) {
    this._requireDelete();
    this._drop('contacts', id, 'contact');
    this._dropNotes('vendor_contact', [id]);
    for (const r of [...this._state.requirements, ...this._state.submissions]) if (r.vendorContactId === id) r.vendorContactId = '';
    this._log('contact_deleted', 'vendor_contact', id);
    this._save();
    return { ok: true };
  }
  async deleteSubmission(id) {
    this._requireDelete();
    for (const p of (this._state.placements || []).filter((x) => x.submissionId === id)) await this.deletePlacement(p.id);   // 0051 cascade
    this._state.interviews = (this._state.interviews || []).filter((x) => x.submissionId !== id);
    this._drop('submissions', id, 'submission');
    this._log('submission_deleted', 'submission', id);
    this._save();
    return { ok: true };
  }

  // ── consent, contact log, erase and export of one consultant (staffing P5; the same rules as migration 0049) ──
  _notes() { if (!Array.isArray(this._state.contactNotes)) this._state.contactNotes = []; return this._state.contactNotes; }
  _dropNotes(entity, ids) {
    const gone = new Set(ids);
    const before = this._notes().length;
    this._state.contactNotes = this._notes().filter((n) => !(n.entity === entity && gone.has(n.entityId)));
    return before - this._state.contactNotes.length;
  }
  _noteParent(entity, entityId) {
    return entity === 'consultant' ? this._state.consultants.find((c) => c.id === entityId) : this._state.contacts.find((c) => c.id === entityId);
  }
  async listContactNotes(entity, entityId) {
    return clone(sortNotes(this._notes().filter((n) => n.entity === entity && n.entityId === entityId)));
  }
  async addContactNote(input) {
    this._require('edit_records');
    const n = cleanNoteInput(input, this._now());
    if (!n) throw new StoreError('invalid', NOTE_EMPTY, 400);
    const parent = this._noteParent(n.entity, n.entityId);
    if (!parent) throw new StoreError('not_found', 'That record is not in your workspace.', 404);
    if (parent.erased) throw new StoreError('erased', ERASED_READ_ONLY, 409);
    const note = { id: this._id('cn'), ...n, createdBy: this._user().id, createdAt: this._now() };
    this._notes().push(note);
    this._save();
    return clone(note);
  }
  /** The note's author, or an owner or manager (0049 RLS). */
  async deleteContactNote(id) {
    this._require('edit_records');
    const n = this._notes().find((x) => x.id === id);
    if (!n) throw new StoreError('not_found', 'That note was not found. It may have been deleted already.', 404);
    const role = this._state.session.role;
    if (n.createdBy !== this._user().id && role !== 'owner' && role !== 'manager') throw new StoreError('forbidden', 'Only the person who wrote a note, an owner or a manager can delete it.', 403);
    this._state.contactNotes = this._notes().filter((x) => x.id !== id);
    this._save();
    return { ok: true };
  }
  // ── 0056: the consultant self-service link (demo: the link opens a sample page that saves nothing) ──
  async listConsultantLinks(consultantId) {
    if (!this._can('consultant_links')) return [];
    return clone((this._state.consultantLinks || []).filter((l) => l.consultantId === consultantId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }
  async createConsultantLink(consultantId, submissionId) {
    if (!canNow(this._state.session.role, 'consultant_links', this._state.team.settings, this._billing().writable)) {
      throw new StoreError('forbidden', 'Only an owner or manager can make a consultant link.', 403);
    }
    const c = this._state.consultants.find((x) => x.id === consultantId && !x.erased);
    if (!c) throw new StoreError('consultant_not_found', 'That consultant is not in your workspace.', 404);
    const sub = submissionId ? this._state.submissions.find((x) => x.id === submissionId && x.consultantId === consultantId) : null;
    if (submissionId && !sub) throw new StoreError('consultant_not_found', 'That submission is not this consultant\'s.', 404);
    const list = this._state.consultantLinks || (this._state.consultantLinks = []);
    const now = new Date().toISOString();
    for (const l of list) if (l.consultantId === consultantId && (l.submissionId || '') === (submissionId || '') && !l.revokedAt) l.revokedAt = now;
    const link = { id: this._id('cl'), consultantId, submissionId: submissionId || '', createdAt: now,
      expiresAt: new Date(Date.now() + LINK_DAYS * 86400000).toISOString(), revokedAt: '', opens: 0, respondedAt: '', responses: 0, response: null };
    list.push(link);
    this._log('consultant_link_created', 'consultant', consultantId);
    this._save();
    return { id: link.id, link: 'consultant-link.html?demo=1' + (submissionId ? '&rtr=1' : '') + '#demo', expiresAt: link.expiresAt };
  }
  async revokeConsultantLink(id) {
    if (!this._can('consultant_links')) throw new StoreError('forbidden', 'Only an owner or manager can cancel a consultant link.', 403);
    const l = (this._state.consultantLinks || []).find((x) => x.id === id);
    if (!l) throw new StoreError('not_found', 'That link was not found.', 404);
    if (!l.revokedAt) l.revokedAt = new Date().toISOString();
    this._log('consultant_link_revoked', 'consultant', l.consultantId);
    this._save();
  }
  /** Owner only: "Restrict sign-ups to my company domain" ('' clears it). Pending invites to other domains are cancelled. */
  async setSignupDomain(domain) {
    if (!canNow(this._state.session.role, 'team_settings', this._state.team.settings, this._billing().writable)) {
      throw new StoreError('forbidden', 'Only the owner can change this.', 403);
    }
    const d = normalizeDomain(domain);
    const problem = domainProblem(d, this._user().email);
    if (problem) throw new StoreError('invalid_domain', problem, 400);
    const t = this._state.team;
    t.settings = { ...t.settings };
    if (d) t.settings.signupDomain = d; else delete t.settings.signupDomain;
    const before = this._state.invites.length;
    if (d) this._state.invites = this._state.invites.filter((i) => emailInDomain(i.email, d));
    this._log('team_updated', 'team', t.id);
    this._save();
    return { domain: d || null, revoked: before - this._state.invites.length };
  }

  /**
   * Where else the consultant's full name appears (0053 bp_consultant_name_matches): contact notes on vendor contacts and other consultants,
   * and vendor companies' notes. For review before the erase; nothing changes. Owners and managers.
   * @returns {Promise<Array<{kind:'contact_note'|'vendor_note', id, entity, entityName, at, text}>>}
   */
  async consultantNameMatches(id) {
    if (!this._can('erase_consultant')) throw new StoreError('forbidden', 'Only an owner or manager can erase a consultant.', 403);
    const c = this._state.consultants.find((x) => x.id === id && !x.erased);
    if (!c) throw new StoreError('consultant_not_found', 'That consultant is not in your workspace.', 404);
    if (!nameRegex(c.name)) return [];
    const nameOf = (rows) => { const m = new Map(rows.map((r) => [r.id, r.name])); return (x) => m.get(x) || ''; };
    const person = nameOf(this._state.consultants), contact = nameOf(this._state.contacts);
    const notes = sortNotes(this._notes().filter((n) => !(n.entity === 'consultant' && n.entityId === id) && hasName(n.body, c.name)))
      .map((n) => ({ kind: 'contact_note', id: n.id, entity: n.entity, entityName: n.entity === 'consultant' ? person(n.entityId) : contact(n.entityId), at: n.at, text: n.body }));
    const vendors = this._state.companies.filter((v) => hasName(v.notes, c.name))
      .map((v) => ({ kind: 'vendor_note', id: v.id, entity: 'vendor_company', entityName: v.name, at: '', text: v.notes }));
    return clone([...notes, ...vendors]);
  }
  /**
   * A data-rights erase (0049 bp_consultant_erase; 0053 adds `scrub`): owners and managers, also while read-only. The name must be typed.
   * Resumes and notes go; submissions stay for the counts with the guard reason cleared. With submissions the row stays anonymised, else
   * it is deleted. scrub = the consultantNameMatches entries the person ticked ([{kind, id}]): exactly those lose the full name.
   */
  async eraseConsultant(id, confirmName, scrub) {
    if (!this._can('erase_consultant')) throw new StoreError('forbidden', 'Only an owner or manager can erase a consultant.', 403);
    const list = this._state.consultants;
    const at = list.findIndex((c) => c.id === id);
    if (at < 0 || list[at].erased) throw new StoreError('consultant_not_found', 'That consultant is not in your workspace.', 404);
    const c = list[at];
    if (lower(confirmName).trim() !== lower(c.name).trim()) throw new StoreError('confirm_mismatch', ERASE_MISMATCH, 400);
    const files = this._resumes().filter((r) => r.consultantId === id).length;
    this._state.resumes = this._resumes().filter((r) => r.consultantId !== id);
    this._dropNotes('consultant', [id]);
    // 0053: the ticked notes lose the full name (a row that no longer has it is left alone)
    const picked = new Set((Array.isArray(scrub) ? scrub : []).filter((x) => x && typeof x.id === 'string').map((x) => x.kind + ':' + x.id));
    let scrubbed = 0;
    for (const n of this._notes()) {
      if (picked.has('contact_note:' + n.id) && hasName(n.body, c.name)) { n.body = scrubName(n.body, c.name).slice(0, 1000); scrubbed++; }
    }
    for (const v of this._state.companies) {
      if (picked.has('vendor_note:' + v.id) && hasName(v.notes, c.name)) { v.notes = scrubName(v.notes, c.name).slice(0, 4000); scrubbed++; }
    }
    // Staffing P3 (0051): the interviews go (panel and feedback are about the person); placements stay for the margin reports.
    const interviews = (this._state.interviews || []).filter((x) => x.consultantId === id).length;
    this._state.interviews = (this._state.interviews || []).filter((x) => x.consultantId !== id);
    const subs = this._state.submissions.filter((s) => s.consultantId === id);
    for (const s of subs) s.overrideReason = '';
    if (subs.length) {
      // Kept for the counts: every personal field empty; the recruiter, desk, bench start and tax terms stay so reports still add up.
      list[at] = {
        id: c.id, name: ERASED_NAME, title: '', skills: [], visa: '', visaType: '', workAuthUntil: '', taxTerms: c.taxTerms || '', rate: '', rateMin: null,
        rateUnit: c.rateUnit || 'hr', location: '', relocation: false, availableOn: '', status: 'inactive', ownerRecruiterId: c.ownerRecruiterId,
        benchSince: c.benchSince, notes: '', resumeName: '', consentOn: '', consentSource: '', consentNote: '', erased: true,
        ...(c.deskId !== undefined ? { deskId: c.deskId } : {})
      };
    } else list.splice(at, 1);
    this._state.consultantLinks = (this._state.consultantLinks || []).filter((l) => l.consultantId !== id);   // 0056: the links and answers go too
    this._log('consultant_erased', 'consultant', id);         // counts only, never the name
    this._save();
    return { ok: true, keptRow: subs.length > 0, submissions: subs.length, files, scrubbed };
  }
  async exportConsultant(id) {
    this._require('export');
    const c = this._state.consultants.find((x) => x.id === id);
    if (!c) throw new StoreError('not_found', 'That consultant is not in your workspace.', 404);
    return consultantExport({
      consultant: clone(c), resumes: await this.listResumes(id),
      submissions: this._state.submissions.filter((s) => s.consultantId === id), contactNotes: await this.listContactNotes('consultant', id),
      interviews: (await this.listInterviews({})).filter((x) => x.consultantId === id), placements: (await this.listPlacements()).filter((x) => x.consultantId === id)
    }, this._now());
  }

  // ── home ───────────────────────────────────────────────────────────────
  async todayStats() {
    const s = this._state;
    return computeToday({ consultants: s.consultants, submissions: s.submissions, members: s.members.filter((m) => !m.removedAt), companies: s.companies, contacts: s.contacts, requirements: s.requirements, activity: s.activity }, this._today());
  }
  async listActivity(limit) { return clone(this._state.activity.slice(0, limit || 20)); }
  async listAudit(f) {
    this._require('audit_log');
    const q = f || {};
    const ents = entitiesFor(q.kind);
    const r = dayRange(q.from, q.to);
    const limit = Math.min(Math.max(Number(q.limit) || AUDIT_PAGE, 1), 500), offset = Math.max(Number(q.offset) || 0, 0);
    const all = this._state.activity.filter((a) => (!q.actorId || a.actor === q.actorId) && (!Array.isArray(q.actorIds) || q.actorIds.includes(a.actor))
      && (!ents || ents.includes(a.entity))
      && (!r.from || a.at >= r.from) && (!r.to || a.at <= r.to));
    const rows = all.slice(offset, offset + limit).map((a) => ({ id: a.id, at: a.at, actor: a.actor, action: a.action, entity: a.entity, entityId: a.entityId || '', before: null, after: null }));
    return { rows, more: all.length > offset + limit };
  }
  /** The latest morning report run, or null. The demo shows a sample: today's report, sent. */
  async lastReportRun() { return { runOn: this._today(), status: 'sent' }; }

  // ── Agency desks (backlog W10; live: migration 0036) ──
  _desks() {
    const s = this._state;
    if (!s.desks || !Array.isArray(s.desks.list)) s.desks = { list: [], seats: {} };
    return s.desks;
  }
  _deskGate() {
    this._require('manage_desks');
    if (!hasFeature(this._billing(), 'desks')) throw new StoreError('plan', PLAN_HINTS.desks_plan);
  }
  async listDesks() {
    const d = this._desks();
    return d.list.map((x) => ({ ...clone(x), memberIds: Object.keys(d.seats).filter((u) => d.seats[u] === x.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async saveDesk(row) {
    this._deskGate();
    const d = this._desks();
    const clean = cleanDesk(row, d.list);
    if (row.id) {
      const at = d.list.findIndex((x) => x.id === row.id);
      if (at < 0) throw new StoreError('not_found', 'That desk was not found.');
      d.list[at] = { ...d.list[at], ...clean };
      this._log('desk_updated', 'desk', row.id);
    } else {
      d.list.push({ id: this._id('d'), ...clean });
      this._log('desk_added', 'desk', d.list[d.list.length - 1].id);
    }
    this._save();
    return (await this.listDesks()).find((x) => x.id === (row.id || d.list[d.list.length - 1].id));
  }
  async deleteDesk(id) {
    this._require('manage_desks');
    const d = this._desks();
    const at = d.list.findIndex((x) => x.id === id);
    if (at < 0) throw new StoreError('not_found', 'That desk was not found.');
    d.list.splice(at, 1);
    for (const u of Object.keys(d.seats)) if (d.seats[u] === id) delete d.seats[u];
    for (const c of this._state.consultants) if (c.deskId === id) c.deskId = '';
    this._log('desk_deleted', 'desk', id);
    this._save();
  }
  async setMemberDesk(userId, deskId) {
    this._deskGate();
    const d = this._desks();
    if (!this._state.members.some((m) => m.id === userId && !m.removedAt)) throw new StoreError('invalid', 'Only active members of the team can sit on a desk.');
    if (deskId && !d.list.some((x) => x.id === deskId)) throw new StoreError('not_found', 'That desk was not found.');
    if (deskId) d.seats[userId] = deskId; else delete d.seats[userId];
    this._log('desk_seat', 'desk_member', userId);
    this._save();
  }

  // ── team inbox (sample data; same shapes as the live store) ───────────
  // ── smart lists (backlog W5; live: migration 0027) and the email check (W6) ──
  async listSmartLists() { return clone(this._state.smartLists || []); }
  async saveSmartList(row) {
    this._require('manage_smart_lists');
    const lists = this._state.smartLists || (this._state.smartLists = []);
    const clean = smartListInput(row, lists);
    const created = { id: this._id('sl'), ...clean, rules: clone(clean.rules), createdBy: this._user().id, createdAt: this._now() };
    lists.push(created);
    this._save();
    return clone(created);
  }
  async deleteSmartList(id) {
    this._require('manage_smart_lists');
    const lists = this._state.smartLists || [];
    const at = lists.findIndex((l) => l.id === id);
    if (at < 0) throw new StoreError('not_found', 'That list was not found.');
    lists.splice(at, 1);
    this._save();
  }
  /** The demo never looks anything up: the typo check in the form still runs, the mail server check says nothing. */
  async checkEmailDomain(email) { return { domain: lower(email).split('@').pop() || '', status: 'unchecked', cached: false }; }

  async getInboxInfo() {
    const s = this._state;
    return {
      domain: s.team.inboxDomain || null, limit: Number(s.team.inboxLimit) || 0,
      used: s.inboxAddresses.filter((a) => !a.disabledAt).length, newCount: s.inboxMessages.filter((m) => m.status === 'new').length
    };
  }
  /** Same order, filters and paging as the live list: newest arrival first, keyset by (createdAt, id); rows without the full text. */
  async listInboxMessages(f) {
    const q = f || {};
    const at = (m) => String(m.createdAt || m.receivedAt || '');
    const b = q.before && q.before.id ? q.before : null;
    const rows = this._state.inboxMessages
      .filter((m) => (!q.status || m.status === q.status) && (!q.kind || m.kind === q.kind))
      .filter((m) => !b || at(m) < String(b.createdAt) || (at(m) === String(b.createdAt) && String(m.id) < String(b.id)))
      .sort((a, b2) => at(b2).localeCompare(at(a)) || String(b2.id).localeCompare(String(a.id)))
      .slice(0, Math.min(Math.max(Number(q.limit) || M.INBOX_PAGE, 1), M.INBOX_PAGE + 1));
    return clone(rows).map((m) => {
      const { bodyText, ...rest } = m;
      return M.inboxMessageFrom({ ...rest, createdAt: at(m), preview: String(bodyText || '').slice(0, 1000) });
    });
  }
  async getInboxMessage(id) {
    const m = this._state.inboxMessages.find((x) => x.id === id);
    if (!m) throw new StoreError('not_found', 'That email was not found. It may have been deleted.', 404);
    const row = clone(m);
    return M.inboxMessageFrom({ ...row, createdAt: row.createdAt || row.receivedAt, preview: String(row.bodyText || '').slice(0, 1000), bodyText: String(row.bodyText || '') });
  }
  async listInboxAddresses() {
    return clone(this._state.inboxAddresses).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(M.inboxAddressFrom);
  }
  async createInboxAddress(label) {
    this._require('inbox_addresses');
    const info = await this.getInboxInfo();
    if (info.used >= info.limit) throw new StoreError('inbox_limit', M.INBOX_LIMIT, 409);
    const created = {
      id: this._id('ia'), token: randomToken(), label: String(label || '').trim().slice(0, 60), createdAt: this._today(), disabledAt: '',
      messageCount: 0, lastMessageAt: '', droppedCount: 0, lastDroppedAt: ''
    };
    this._state.inboxAddresses.push(created);
    this._log('inbox_address_created', 'inbox_address', created.id);
    this._save();
    return M.inboxAddressFrom(clone(created));
  }
  async disableInboxAddress(id) {
    this._require('disable_inbox_address');     // also on a read-only workspace, as the server (0020)
    const a = this._state.inboxAddresses.find((x) => x.id === id);
    if (!a) throw new StoreError('not_found', 'That address was not found.', 404);
    if (!a.disabledAt) { a.disabledAt = this._today(); this._log('inbox_address_disabled', 'inbox_address', a.id); this._save(); }
  }
  /** Same rule as bp_inbox_address_replace (0040): all or nothing. The old address goes off only when the new one is made. */
  async replaceInboxAddress(id, label) {
    this._require('inbox_addresses');
    const a = this._state.inboxAddresses.find((x) => x.id === id);
    if (!a) throw new StoreError('not_found', 'That address was not found.', 404);
    if (a.disabledAt) throw new StoreError('inbox_off', 'That address is already turned off.', 409);
    a.disabledAt = this._today();
    try { return await this.createInboxAddress(label == null || label === '' ? a.label : label); }
    catch (err) { a.disabledAt = ''; throw err; }
  }
  /** Same rules as bp_inbox_mark: 'added' is a claim (only messages not yet added change); returns the ids that changed. */
  async markInbox(ids, status, requirementId) {
    this._require('edit_records');
    const list = M.inboxMarkBody(ids, status, requirementId);
    const changed = [];
    for (const m of this._state.inboxMessages) {
      if (!list.message_ids.includes(m.id)) continue;
      if (list.status === 'added' && m.status === 'added') continue;
      m.status = list.status;
      m.requirementId = list.status === 'added' ? (list.requirement_id || '') : '';
      m.handledBy = list.status === 'new' ? '' : this._user().id;
      m.handledAt = list.status === 'new' ? '' : this._today();
      changed.push(m.id);
    }
    if (changed.length) this._log('inbox_' + list.status, 'inbox_message', '', String(changed.length));
    this._save();
    return { updated: changed.length, ids: changed };
  }
  /** The jobs handled in one job-board alert (0037 inbox_message_items): [{ index, status }]. */
  async listInboxItems(messageId) {
    const all = this._state.inboxItems || [];
    return M.inboxItemsFrom(all.filter((x) => x.messageId === messageId).sort((a, b) => a.index - b.index));
  }
  /** Same rules as bp_inbox_item_mark: 'added' is a claim per job; 'ignored' never touches an added job; 'new' releases an added job only
   *  for its claimer. Returns { updated, items } (the indexes that changed). */
  async markInboxItems(messageId, items, status) {
    this._require('edit_records');
    const body = M.inboxItemMarkBody(messageId, items, status);
    const m = this._state.inboxMessages.find((x) => x.id === body.message_id && x.kind !== 'forwarding_confirmation');
    if (!m) throw new StoreError('not_found', 'That email is not in the inbox any more.', 404);
    if (!Array.isArray(this._state.inboxItems)) this._state.inboxItems = [];
    const me = this._user().id;
    const changed = [];
    for (const i of body.items) {
      const at = this._state.inboxItems.findIndex((x) => x.messageId === m.id && x.index === i);
      const row = this._state.inboxItems[at];
      if (body.status === 'new') {
        if (row && (row.status === 'ignored' || row.handledBy === me)) { this._state.inboxItems.splice(at, 1); changed.push(i); }
      } else if (!row || row.status !== 'added') {
        if (row) Object.assign(row, { status: body.status, handledBy: me }); else this._state.inboxItems.push({ messageId: m.id, index: i, status: body.status, handledBy: me });
        changed.push(i);
      }
    }
    this._save();
    return { updated: changed.length, items: changed.sort((a, b) => a - b) };
  }
  /** Same rules as bp_inbox_attach: only the caller's own claimed message without a requirement yet. */
  async attachInbox(messageId, requirementId) {
    this._require('edit_records');
    const m = this._state.inboxMessages.find((x) => x.id === messageId);
    const ok = Boolean(m && requirementId && m.status === 'added' && !m.requirementId && m.handledBy === this._user().id);
    if (ok) { m.requirementId = String(requirementId); this._save(); }
    return { attached: ok };
  }

  // ── team templates (migration 0028) ────────────────────────────────────
  _templates() { if (!Array.isArray(this._state.templates)) this._state.templates = []; return this._state.templates; }
  async listTemplates(opts) {
    const list = this._templates();
    const defaults = (opts && Array.isArray(opts.defaults)) ? opts.defaults : [];
    if (!list.length && defaults.length) {
      if (!(this._can('edit_templates') && this._billing().writable)) return builtInTemplates(defaults);
      for (const d of defaults) list.push({ id: this._id('tp'), kind: d.kind, name: d.name, subject: d.subject || '', body: d.body, position: d.position || 0, seedKey: d.seedKey || '' });
      this._log('templates_seeded', 'team', this._state.team.id);
      this._save();
    }
    return clone(sortTemplates(list));
  }
  async saveTemplate(row) {
    this._require('edit_templates');
    const c = cleanTemplate(row);
    if (!c.ok) throw new StoreError('invalid', c.error);
    const list = this._templates();
    const at = row.id && !row.builtIn ? list.findIndex((x) => x.id === row.id) : -1;
    if (row.id && !row.builtIn && at < 0) throw new StoreError('not_found', 'That template was not found.');
    if (at >= 0) {
      list[at] = { ...list[at], ...c.template, id: list[at].id };
      this._log('template_updated', 'template', list[at].id);
      this._save();
      return clone(list[at]);
    }
    if (list.length >= TEMPLATE_MAX) throw new StoreError('limit', M.TEMPLATE_LIMIT);
    const created = { ...c.template, id: this._id('tp'), seedKey: row.builtIn && row.seedKey && !list.some((x) => x.seedKey === row.seedKey) ? row.seedKey : '' };
    list.push(created);
    this._log('template_added', 'template', created.id);
    this._save();
    return clone(created);
  }
  async deleteTemplate(id) {
    this._require('edit_templates');
    const list = this._templates();
    if (!list.some((x) => x.id === id)) throw new StoreError('not_found', 'That template was not found.');
    this._state.templates = list.filter((x) => x.id !== id);
    this._log('template_deleted', 'template', id);
    this._save();
  }
  async getBranding() { return clone(this._state.branding || { companyName: 'Northwind Consulting', website: 'https://northwind.example.com' }); }
  async saveBranding(row) {
    this._require('edit_templates');
    const c = cleanBranding(row);
    if (!c.ok) throw new StoreError('invalid', c.error);
    this._state.branding = c.branding;
    this._log('branding_updated', 'team', this._state.team.id);
    this._save();
    return clone(c.branding);
  }
  async getSenderProfile() {
    const me = this._user();
    const all = this._state.senders || {};
    return clone(all[me.id] || { senderName: me.name, jobTitle: '', phone: '' });
  }
  async saveSenderProfile(row) {
    const me = this._user();
    this._state.senders = { ...(this._state.senders || {}), [me.id]: cleanSender(row) };
    this._save();
    return clone(this._state.senders[me.id]);
  }
}

/** 12 random lower-case letters and digits (the demo's address token; the live server makes its own). */
function cryptoUuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
}

function randomToken() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(12);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 12; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}


// ── Live store ───────────────────────────────────────────────────────────
// SupabaseStore: the same interface as DemoStore, backed by the BenchPilot Supabase project.
//   * team, members, invites, roles, remove, transfer, create, accept  ->  the `team` edge function (POST {action, ...})
//   * bench, vendors, contacts, requirements, submissions, activity    ->  PostgREST /rest/v1 with the signed-in user's token,
//                                                                          so row-level security decides who may do what
//   * the guard and the Today numbers are computed here from the team's own rows (RLS limits the rows to the team)
// Nothing here logs a token, an email or a row. Errors become short friendly messages (see live-map.js explain()).

const TIMEOUT_MS = 20000;
/**
 * Rows per PostgREST page. Lists are read page by page until a short page, so no list, count or Today number stops at a page.
 * Must not be above the project's max-rows (Supabase default 1000): a smaller server cap would look like the last page.
 */
export const PAGE_ROWS = 1000;
/** A runaway guard only (200,000 rows); a team book is far smaller. */
export const MAX_PAGES = 200;
const IMPORT_BATCH = 500;

export class SupabaseStore {
  /**
   * @param {{auth:object, config:{SUPABASE_URL:string,SUPABASE_ANON_KEY:string}, fetch?:Function, today?:()=>string, onSessionLost?:()=>void}} opts
   */
  constructor(opts) {
    const o = opts || {};
    this.mode = 'supabase';
    this.capabilities = { consultantNotes: false, unratedTier: true, resumes: true };
    this._auth = o.auth;
    this._cfg = o.config;
    this._fetch = o.fetch || ((...a) => fetch(...a));
    this._today = o.today || (() => todayISO());
    this._onSessionLost = o.onSessionLost || (() => {});
    this._me = undefined;          // undefined = not loaded, null = signed in but no team
    this._members = null;          // cached `members` reply
    this._settings = null;
    this._inbox = null;            // { domain, limit, used, newCount } from the `me` reply
  }

  // ── plumbing ───────────────────────────────────────────────────────────
  _base() { return String(this._cfg.SUPABASE_URL).replace(/\/+$/, ''); }

  async _send(url, init, force) {
    let token;
    try { token = await this._auth.getAccessToken(force); } catch (e) {
      if (e && e.code === 'unauthenticated') { this._onSessionLost(); throw new StoreError('session_expired', M.SESSION_EXPIRED, 401); }
      throw new StoreError('network', e && e.message ? e.message : M.NETWORK);
    }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      const headers = { apikey: this._cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, ...(init.headers || {}) };
      return await this._fetch(url, { ...init, headers, signal: ctl ? ctl.signal : undefined });
    } catch (e) {
      throw new StoreError('network', M.NETWORK);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** One request. A 401 gets one retry with a freshly refreshed token before the session counts as lost. */
  async _call(url, init, opts) {
    let res = await this._send(url, init, false);
    if (res.status === 401) res = await this._send(url, init, true);
    let json = null;
    if (res.status !== 204) { try { json = await res.json(); } catch (e) { json = null; } }
    if (!res.ok) {
      const err = M.explain(res.status, json, opts);
      if (err.code === 'session_expired') { this._auth.forget(); this._onSessionLost(); }
      // The membership may have ended in another tab or by someone else (removed, workspace closed): the cached team is stale, so the
      // next getSession() asks `me` again and the app shows why (0040 last_team) instead of a screen of errors.
      if (M.membershipGone(res.status, json)) this._forgetTeamCache();
      throw err;
    }
    return json;
  }

  _rest(method, table, { qs, body, prefer } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    return this._call(this._base() + '/rest/v1/' + table + (qs ? '?' + qs : ''), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  /**
   * Every row of a table that RLS shows (the one list helper: bench, vendors, contacts, requirements, submissions, desks, lists, templates).
   * limit + offset pages with `id` as the last sort key, so rows with equal sort values never repeat or go missing between pages.
   */
  async _list(table, qs) {
    const q = { select: '*', ...qs };
    q.order = q.order ? (/(^|,)id\./.test(q.order) ? q.order : q.order + ',id.asc') : 'id.asc';
    const out = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = (await this._rest('GET', table, { qs: M.query({ ...q, limit: PAGE_ROWS, offset: page * PAGE_ROWS || '' }) })) || [];
      for (const r of rows) out.push(r);
      if (rows.length < PAGE_ROWS) break;
    }
    return out;
  }
  async _one(table, id) { const rows = await this._rest('GET', table, { qs: M.query({ select: '*', id: M.eq(id), limit: 1 }) }); return (rows && rows[0]) || null; }
  async _insert(table, body) {
    const rows = await this._rest('POST', table, { body: { ...body, team_id: await this._teamId() }, prefer: 'return=representation' });
    return rows[0];
  }
  async _update(table, id, body) {
    const rows = await this._rest('PATCH', table, { qs: M.query({ id: M.eq(id) }), body, prefer: 'return=representation' });
    if (!rows || !rows.length) throw new StoreError('not_found', 'That was not found, or your role cannot change it.');
    return rows[0];
  }
  _team(action, payload) {
    return this._call(this._base() + '/functions/v1/team', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...(payload || {}) })
    }, { team: true });
  }

  async _loadMe(force) {
    if (this._me === undefined || force) {
      const r = await this._team('me');
      this._me = (r && r.team) || null;
      this._inbox = M.inboxInfoFrom(r);
      // No team (0040): why the last membership ended (30 days) and whether this person's one free pilot is still there.
      this._noTeam = this._me ? null : { lastTeam: M.lastTeamFrom(r && r.last_team), pilotAvailable: !(r && r.pilot_available === false) };
      this._purgeEnabled = Boolean(r && r.purge_enabled === true);   // 0043: the purge of closed workspaces is switched on (TEAM_PURGE)
    }
    return this._me;
  }
  async _teamId() {
    const me = await this._loadMe();
    if (!me) throw new StoreError('no_team', 'You are not in a team yet.');
    return me.id;
  }
  _role() { return this._me ? this._me.role : null; }
  _uid() { return this._auth.current().user.id; }
  _isLead() { return this._role() === 'owner' || this._role() === 'manager'; }
  _forgetTeamCache() { this._me = undefined; this._members = null; this._settings = null; }
  /** "Try again" after an error: read the team from the server again (the membership may have ended meanwhile). */
  forgetTeamCache() { this._forgetTeamCache(); }
  async _membersReply() {
    if (!this._members) { this._members = await this._team('members'); }
    return this._members;
  }

  // ── session ────────────────────────────────────────────────────────────
  async getSession() {
    const cur = this._auth.current();
    if (!cur.signedIn) return { mode: 'live', signedIn: false, role: null, hasTeam: false, user: null, today: this._today() };
    const me = await this._loadMe();
    const out = {
      mode: 'live', signedIn: true, hasTeam: Boolean(me), role: me ? me.role : null,
      user: { id: cur.user.id, name: cur.user.name || nameFromEmail(cur.user.email), email: cur.user.email }, teamId: me ? me.id : null, today: this._today()
    };
    if (!me && this._noTeam) { out.lastTeam = this._noTeam.lastTeam; out.pilotAvailable = this._noTeam.pilotAvailable; }
    out.purgeEnabled = this._purgeEnabled === true;
    return out;
  }
  async signIn() { throw new StoreError('use_form', 'Use the sign-in form.'); }
  async signOut() { this._forgetTeamCache(); await this._auth.signOut(); return this.getSession(); }
  /**
   * One `sync` function call (POST /functions/v1/sync {action, ...}) for "My book" (js/vault.js). The body holds only ciphertext and key
   * metadata; it is never logged. Errors keep the server's code (plan_required, no_keys, version_conflict, key_changed, rate_limited ...).
   */
  syncCall(body) {
    return this._call(this._base() + '/functions/v1/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }
  async setDemoRole() { throw new StoreError('demo_only', 'Switching roles works in the demo workspace only.'); }
  async resetDemo() { throw new StoreError('demo_only', 'Resetting works in the demo workspace only.'); }

  // ── team (the `team` function) ─────────────────────────────────────────
  async getTeam() {
    const me = await this._loadMe();
    if (!me) throw new StoreError('no_team', 'You are not in a team yet.');
    if (!this._settings) {
      let s = {};
      try { const rows = await this._rest('GET', 'teams', { qs: M.query({ select: 'settings', id: M.eq(me.id), limit: 1 }) }); s = (rows && rows[0] && rows[0].settings) || {}; } catch (e) { s = {}; }
      this._settings = s;
    }
    const ep = this._settings.exportPolicy || {};
    return {
      id: me.id, name: me.name, plan: me.plan, pilotEndsOn: me.pilot_ends_on || '', billing: M.billingFrom(me.billing, me.pilot_ends_on),
      purgeEnabled: this._purgeEnabled === true,
      settings: { reportTime: this._settings.reportTime || '08:00', timeZone: this._settings.timeZone || '', reportManagers: this._settings.reportManagers === true,
        reportWeekday: M.weekdayOf(this._settings.reportWeekday),
        exportPolicy: { manager: ep.manager !== false, recruiter: ep.recruiter === true },
        payPolicy: { recruiter: Boolean(this._settings.payPolicy && this._settings.payPolicy.recruiter === true) },
        leaderboardPolicy: { others: !(this._settings.leaderboardPolicy && this._settings.leaderboardPolicy.others === false) },
        signupDomain: typeof this._settings.signupDomain === 'string' ? this._settings.signupDomain : '' }
    };
  }
  /** Owner only (0056 bp_team_set_signup_domain): '' clears the rule. Returns { domain, revoked } (pending invites elsewhere cancelled). */
  async setSignupDomain(domain) {
    const r = await this._team('set-signup-domain', { domain: normalizeDomain(domain) });
    this._settings = null;
    this._members = null;
    return { domain: (r && r.domain) || null, revoked: Number(r && r.revoked) || 0 };
  }
  /** Owner only; the `team` function's update-settings action checks the role and the values (0014 bp_team_update_settings). */
  async updateTeam(patch) {
    const p = patch || {};
    const s = p.settings || {};
    const ep = s.exportPolicy || {};
    const body = {};
    if (p.name != null) body.name = String(p.name).trim();
    if (s.reportTime) body.report_time = String(s.reportTime).slice(0, 5);
    if (s.timeZone) body.time_zone = String(s.timeZone);
    if (typeof ep.manager === 'boolean') body.export_manager = ep.manager;
    if (typeof ep.recruiter === 'boolean') body.export_recruiter = ep.recruiter;
    if (typeof s.reportManagers === 'boolean') body.report_managers = s.reportManagers;
    if (s.reportWeekday != null) body.report_weekday = M.weekdayOf(s.reportWeekday);
    if (s.payPolicy && typeof s.payPolicy.recruiter === 'boolean') body.pay_recruiter = s.payPolicy.recruiter;   // 0046
    if (s.leaderboardPolicy && typeof s.leaderboardPolicy.others === 'boolean') body.leaderboard_others = s.leaderboardPolicy.others;   // 0052
    const r = await this._team('update-settings', body);
    this._settings = (r && r.settings) || {};
    if (this._me && r && r.name) this._me = { ...this._me, name: r.name };
    return this.getTeam();
  }
  /** Active members; with {includeRemoved: true} also the people who left or were removed (0043 `former`: a name only, removedAt set),
   *  so records they added still show who added them. */
  async listMembers(opts) {
    const r = await this._membersReply();
    const active = r.members.map(M.memberFrom);
    return opts && opts.includeRemoved ? [...active, ...(Array.isArray(r.former) ? r.former : []).map(M.formerMemberFrom)] : active;
  }
  async listInvites() { return (await this._membersReply()).invites.map(M.inviteFrom); }
  async inviteMember(input) {
    const email = String(input.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new StoreError('invalid_email', 'Enter a valid email address.');
    const r = await this._team('invite', { email, role: input.role === 'manager' ? 'manager' : 'recruiter' });
    this._members = null;
    return { id: r.invite_id, email, role: input.role === 'manager' ? 'manager' : 'recruiter', expiresOn: String(r.expires_at || '').slice(0, 10) };
  }
  async setMemberRole(id, role) {
    await this._team('set-role', { user_id: id, role });
    this._members = null;
    return { id, role };
  }
  async removeMember(id) { await this._team('remove', { user_id: id }); this._members = null; }
  /** Managers and recruiters (0040). Afterwards the session has no team, so the app shows the welcome screen with the "you left" card. */
  async leaveTeam() { await this._team('leave'); this._forgetTeamCache(); await this._loadMe(true); }
  /** "N of M seats used" (0040): members + pending invites, from the server; limit null = no limit (the pilot). */
  async seatInfo() {
    const r = await this._membersReply();
    const used = Number.isInteger(r.seats_used) ? r.seats_used : (r.members || []).length + (r.invites || []).filter((i) => i.expired !== true).length;
    return { limit: Number.isInteger(r.seat_limit) ? r.seat_limit : null, used };
  }
  async revokeInvite(id) { await this._team('revoke-invite', { invite_id: String(id) }); this._members = null; }
  async resendInvite(id) {
    const r = await this._team('resend-invite', { invite_id: String(id) });
    this._members = null;
    return { id: r.invite_id, expiresOn: String(r.expires_at || '').slice(0, 10) };
  }
  async transferOwner(id) { await this._team('transfer-owner', { user_id: id }); this._forgetTeamCache(); await this._loadMe(true); }
  /**
   * opts.ref = the code from a colleague's pilot link (js/referral.js); sent only when present. referral = the server's answer or ''.
   * pilot false (0040) = this person had their free pilot with an earlier workspace: the new one starts read-only until it is paid.
   */
  async createTeam(name, opts) {
    const ref = opts && typeof opts.ref === 'string' && opts.ref ? { ref: opts.ref } : {};
    const r = await this._team('create', { name: String(name || '').trim(), ...ref });
    this._forgetTeamCache();
    await this._loadMe(true);
    return { id: r.team_id, pilotEndsOn: r.pilot_ends_on, pilot: r.pilot !== false, referral: typeof r.referral === 'string' ? r.referral : '' };
  }
  /**
   * Plan and billing (0016): the team's billing plus, for the owner, the plans with prices from the server. `annual` and `founding`
   * (0033) come from the server too: yearly plans and the founding offer show only when it says they are on sale.
   */
  async getBilling() {
    const r = await this._team('billing');
    return {
      billing: M.billingFrom(r && r.billing), plans: (r && Array.isArray(r.plans) ? r.plans : []).map(M.planFrom),
      usdCheckout: Boolean(r && r.usd_checkout), invoiceEmail: String((r && r.invoice_email) || ''),
      annual: Boolean(r && r.annual === true), founding: M.foundingFrom(r && r.founding)
    };
  }
  /**
   * Owner only. The `checkout` function prices the plan on the server and returns a Razorpay payment page, and (handlers.js) planUntil:
   * the paid-until date this payment will give (days left converted to the new tier, then the plan's months). Returns { url, planUntil }.
   */
  async startCheckout(planId, currency) {
    const r = await this._call(this._base() + '/functions/v1/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: String(planId), currency: currency === 'USD' ? 'USD' : 'INR' })
    }, { team: true });
    if (!r || typeof r.url !== 'string' || !/^https:\/\//.test(r.url)) throw new StoreError('failed', 'That did not go through. Please try again.');
    return { url: r.url, planUntil: typeof r.planUntil === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.planUntil) ? r.planUntil : '' };
  }
  async requestPilotExtension() {
    await this._team('request-extension');
    this._forgetTeamCache();
    await this._loadMe(true);
  }
  /** The team's billing read again from the server (after a payment in another tab the webhook moves paid_until; app.js watches it). */
  async refreshBilling() {
    const me = await this._loadMe(true);
    if (!me) throw new StoreError('no_team', 'You are not in a team yet.');
    return M.billingFrom(me.billing, me.pilot_ends_on);
  }
  /** Owner only: the team's payments, newest first (`billing-history`). Date, plan, amount and status; never card or payment ids. */
  async getBillingHistory() {
    const r = await this._team('billing-history');
    return (r && Array.isArray(r.payments) ? r.payments : []).map(M.paymentFrom);
  }
  /** "Share a pilot link" (0021 `referral-link`): the newest open code, or a new one with {new: true}. */
  async getReferralLink(opts) {
    const r = await this._team('referral-link', opts && opts.new === true ? { new: true } : {});
    return { code: String(r.code || ''), link: String(r.link || ''), expiresOn: String(r.expires_at || '').slice(0, 10),
      joined: Number(r.joined) || 0, rewarded: Number(r.rewarded) || 0 };
  }
  /**
   * The caller's own plan (Solo, Pro ...), team or not: the `team` function's `my-plan` action, the same effective plan as the extension's
   * GET /me without the licence (GET /me answers extension origins only).
   */
  async getPersonalPlan() { return M.personalPlanFrom(await this._team('my-plan')); }
  /** The token is used for this one call and not kept. */
  async acceptInvite(token) {
    const r = await this._team('accept', { token });
    this._forgetTeamCache();
    await this._loadMe(true);
    return { teamId: r.team_id, role: r.role, teamName: r.team_name };
  }
  /**
   * The whole book from the `team` function's export action, which applies the team's export policy on the server (0014 bp_team_export).
   * Same shape as the demo: { teamName, exportedOn, tables }, with names next to the ids.
   */
  async exportAll() {
    const r = await this._team('export');
    let members = [];
    try { members = await this.listMembers(); } catch (e) { members = []; }
    const nameOf = (rows) => { const m = new Map(rows.map((x) => [x.id, x.name])); return (id) => m.get(id) || ''; };
    const member = nameOf(members), consultant = nameOf(r.consultants || []), company = nameOf(r.vendor_companies || []);
    return {
      teamName: r.team_name || '', exportedOn: this._today(),
      tables: {
        consultants: (r.consultants || []).map((c) => ({ ...c, owner_recruiter_name: member(c.owner_recruiter) })),
        vendor_companies: r.vendor_companies || [],
        vendor_contacts: (r.vendor_contacts || []).map((c) => ({ ...c, company_name: company(c.company_id) })),
        requirements: (r.requirements || []).map((x) => ({ ...x, vendor_company_name: company(x.vendor_company_id), recruiter_name: member(x.created_by) })),
        submissions: (r.submissions || []).map((x) => ({ ...x, consultant_name: consultant(x.consultant_id), vendor_company_name: company(x.vendor_company_id), recruiter_name: member(x.recruiter_id) })),
        contact_notes: (r.contact_notes || []).map((x) => ({ ...x, created_by_name: member(x.created_by) })),
        submission_interviews: (r.submission_interviews || []).map((x) => ({ ...x, consultant_name: consultant(x.consultant_id) })),
        placements: (r.placements || []).map((x) => ({ ...x, consultant_name: consultant(x.consultant_id), vendor_company_name: company(x.vendor_company_id) })),
        team_targets: (r.team_targets || []).map((x) => ({ ...x, member_name: x.member_id ? member(x.member_id) : '' })),   // 0053 (the 0052 read rule on the server)
        placement_timesheets: r.placement_timesheets || [],   // 0057; invoices and commission rules come back only for owners and managers
        invoices: r.invoices || [],
        commission_rules: (r.commission_rules || []).map((x) => ({ ...x, member_name: x.member_id ? member(x.member_id) : 'Everyone (default)', lead_name: x.lead_member_id ? member(x.lead_member_id) : '' }))
      }
    };
  }
  /**
   * Import a book built by import-book.js buildBook() through the `team` function's import action (owner/manager; merges on the server,
   * 0014 bp_team_import). Sent in batches of IMPORT_BATCH rows, all with one run_id, so the team's hourly import cap counts this import
   * once (0043); a batch that fails stops the run, and running it again is safe because rows merge instead of duplicating. The error
   * carries the counts so far in `err.partial`.
   */
  async importBook(book) {
    const b = book || {};
    const rows = [
      ...(b.vendors || []).map((v) => ({ k: 'v', row: {
        email: v.email, name: v.name || '', phone: v.phone || '', title: v.title || '', company_name: v.companyName || '', linkedin_url: v.linkedinUrl || '', tier: v.tier || ''
      } })),
      ...(b.consultants || []).map((c) => ({ k: 'c', row: {
        name: c.name, title: c.title || '', skills: c.skills || [], visa: c.visa || '', tax_terms: c.taxTerms || '', rate: c.rate || '', location: c.location || '',
        relocation: Boolean(c.relocation), available_on: c.availableOn || '', status: c.status || ''
      } }))
    ].slice(0, 5000);
    const out = { contactsCreated: 0, contactsUpdated: 0, companiesCreated: 0, vendorsSkipped: 0, consultantsCreated: 0, consultantsUpdated: 0, consultantsSkipped: 0, consultantsOverCap: 0 };
    const runId = cryptoUuid();
    for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
      const part = rows.slice(i, i + IMPORT_BATCH);
      let r;
      try {
        r = await this._team('import', { run_id: runId, vendors: part.filter((x) => x.k === 'v').map((x) => x.row), consultants: part.filter((x) => x.k === 'c').map((x) => x.row) });
      } catch (e) {
        if (i > 0 && e && typeof e === 'object') e.partial = { ...out };
        throw e;
      }
      const v = (r && r.vendors) || {}, c = (r && r.consultants) || {};
      out.contactsCreated += v.contacts_created || 0; out.contactsUpdated += v.contacts_updated || 0; out.companiesCreated += v.companies_created || 0;
      out.vendorsSkipped += v.skipped || 0; out.consultantsCreated += c.created || 0; out.consultantsUpdated += c.updated || 0; out.consultantsSkipped += c.skipped || 0;
      out.consultantsOverCap += c.over_cap || 0;
    }
    return out;
  }
  /** Owner only, typed confirmation (the workspace name). Soft delete on the server (0014 bp_team_delete); everyone loses access at once. */
  async deleteWorkspace(confirmName) {
    await this._team('delete', { confirm: String(confirmName || '').trim() });
    this._forgetTeamCache();
  }

  // ── bench ──────────────────────────────────────────────────────────────
  async listConsultants(f) {
    const q = f || {};
    const rows = (await this._list('consultants', {
      status: q.status ? M.eq(q.status) : '', owner_recruiter: q.recruiterId ? M.eq(q.recruiterId) : '', order: 'bench_since.asc.nullslast'
    })).map(M.consultantFrom).filter((c) => q.includeErased || !c.erased);
    return q.q ? rows.filter((c) => textHas([c.name, c.title, c.skills.join(' '), c.location].join(' '), q.q)) : rows;
  }
  async getConsultant(id) { const r = await this._one('consultants', id); return r ? M.consultantFrom(r) : null; }
  async saveConsultant(row) {
    const name = String(row.name || '').trim();
    if (!name) throw new StoreError('invalid', 'A consultant needs a name.');
    await this._loadMe();
    const body = M.consultantTo(row, this._uid(), this._today(), !row.id);
    const saved = row.id ? await this._update('consultants', row.id, body) : await this._insert('consultants', body);
    return M.consultantFrom(saved);
  }

  // ── resumes (0024): the file goes straight to private Storage with the user's own token (the storage policies decide), then the
  // `team` function registers it (keeps the last 5). Downloads are signed links that expire after SIGNED_LINK_SECONDS. ──
  /** One Storage API call with the user's token. Errors become friendly StoreErrors (never the response body). */
  async _storage(path, init) {
    const url = this._base() + '/storage/v1/' + path;
    let res = await this._send(url, init, false);
    if (res.status === 401) res = await this._send(url, init, true);
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok) {
      if (res.status === 401) { this._auth.forget(); this._onSessionLost(); throw new StoreError('session_expired', M.SESSION_EXPIRED, 401); }
      const [code, message] = storageProblem(res.status, json);
      throw new StoreError(code, message, res.status);
    }
    return json;
  }
  async listResumes(consultantId) {
    const rows = await this._rest('GET', 'consultant_resumes', {
      qs: M.query({ select: 'id,consultant_id,path,file_name,mime,size_bytes,uploaded_by,created_at', consultant_id: M.eq(consultantId), order: 'seq.desc', limit: RESUME_KEEP })
    });
    return (rows || []).map(versionFrom);
  }
  async uploadResume(consultantId, file, check) {
    if (!check || check.problem || !check.ext) throw new StoreError('invalid', (check && check.problem) || 'Please choose a PDF or Word (.docx) file.');
    const path = resumePath(await this._teamId(), consultantId, cryptoUuid(), check.ext);
    await this._storage('object/' + RESUME_BUCKET + '/' + path, {
      method: 'POST', headers: { 'Content-Type': check.mime, 'x-upsert': 'false', 'cache-control': 'private, max-age=0' }, body: file
    });
    const r = await this._team('resume-add', { consultant_id: consultantId, path, file_name: cleanFileName(file.name) });
    return { id: String(r.resume_id), pruned: Number(r.pruned) || 0 };
  }
  /** A short-lived link to one version. PDFs open in the browser; Word files download under their own name. */
  async resumeLink(version) {
    const v = version || {};
    const path = String(v.path || '');
    if (!RESUME_PATH_RE.test(path)) throw new StoreError('not_found', 'That file is no longer there. Refresh the page.');
    const r = await this._storage('object/sign/' + RESUME_BUCKET + '/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: SIGNED_LINK_SECONDS })
    });
    const rel = r && (r.signedURL || r.signedUrl);
    if (typeof rel !== 'string' || !rel) throw new StoreError('server', 'Something went wrong on our side. Please try again.');
    let url = /^https?:/.test(rel) ? rel : this._base() + '/storage/v1' + (rel.startsWith('/') ? rel : '/' + rel);
    if (v.mime === DOCX_TYPE) url += (url.includes('?') ? '&' : '?') + 'download=' + encodeURIComponent(v.fileName || 'resume.docx');
    return url;
  }
  async deleteResume(id) {
    const r = await this._team('resume-delete', { resume_id: id });
    return { ok: true, removedFile: Boolean(r && r.removed_file) };
  }

  // ── requirements ───────────────────────────────────────────────────────
  async listRequirements(f) {
    const q = f || {};
    const rows = (await this._list('requirements', { status: q.status ? M.eq(q.status) : '', source: q.source ? M.eq(q.source) : '', source_board: q.board ? M.eq(q.board) : '', order: 'posted_on.desc.nullslast,created_at.desc' })).map(M.requirementFrom);
    return q.q ? rows.filter((r) => textHas([r.title, r.endClient, r.location, r.skills.join(' ')].join(' '), q.q)) : rows;
  }
  async getRequirement(id) { const r = await this._one('requirements', id); return r ? M.requirementFrom(r) : null; }
  async saveRequirement(row) {
    if (!String(row.title || '').trim()) throw new StoreError('invalid', 'A requirement needs a title.');
    await this._loadMe();
    const body = M.requirementTo({ ...row, postedOn: row.postedOn || this._today() });
    const saved = row.id ? await this._update('requirements', row.id, body) : await this._insert('requirements', body);
    return M.requirementFrom(saved);
  }

  // ── vendor book ────────────────────────────────────────────────────────
  async listVendors(f) {
    const q = f || {};
    const tier = q.tier === 'unrated' ? 'is.null' : (q.tier ? M.eq(q.tier) : '');
    const [companies, contacts] = await Promise.all([this._list('vendor_companies', { tier, order: 'name.asc' }), this._list('vendor_contacts', { select: 'id,company_id,email' })]);
    const rows = companies.map((c) => ({ ...M.vendorFrom(c), contactCount: contacts.filter((x) => x.company_id === c.id).length }));
    if (!q.q) return rows;
    return rows.filter((v) => textHas([v.name, v.domain, contacts.filter((x) => x.company_id === v.id).map((x) => x.email).join(' ')].join(' '), q.q));
  }
  async getVendor(id) { const r = await this._one('vendor_companies', id); return r ? M.vendorFrom(r) : null; }
  async saveVendor(row) {
    const name = String(row.name || '').trim();
    if (!name) throw new StoreError('invalid', 'A company needs a name.');
    const domain = lower(row.domain).trim();
    if (domain && (domain.length < 3 || /\s/.test(domain))) throw new StoreError('invalid', 'Enter the company domain like company.com, or leave it empty.');
    await this._loadMe();
    const prev = row.id ? await this._one('vendor_companies', row.id) : null;
    if (row.id && !prev) throw new StoreError('not_found', 'That company was not found.');
    const before = prev ? M.vendorFrom(prev) : { tier: 'unrated', avoidReason: '', doNotContact: false };
    const tier = row.tier || before.tier;
    // Tier, the Avoid reason and Do not contact belong to owners and managers (trigger bp_team_restrict). For everyone else they
    // are left out unless changed, so a recruiter's ordinary edit goes through and a real change is refused with a clear message.
    const changed = tier !== before.tier || (tier === 'avoid' && String(row.avoidReason || '').trim() !== before.avoidReason) || Boolean(row.doNotContact) !== before.doNotContact;
    if (changed && !this._isLead()) throw new StoreError('forbidden', 'Only an owner or manager can set a vendor tier or mark Avoid.');
    const body = M.vendorTo({ ...row, name, tier }, this._isLead());
    const saved = prev ? await this._update('vendor_companies', prev.id, body) : await this._insert('vendor_companies', body);
    return M.vendorFrom(saved);
  }
  /** Owners and managers only (trigger bp_team_restrict, 0050, refuses a recruiter's change too). Only the agreement columns are sent. */
  async saveVendorAgreement(id, agreement) {
    await this._loadMe();
    if (!this._isLead()) throw new StoreError('forbidden', 'Only an owner or manager can change vendor agreements.');
    const A = await loadAgreementsLib();
    const prev = await this._one('vendor_companies', id);
    if (!prev) throw new StoreError('not_found', 'That company was not found.');
    const v = A.validate(agreement, M.vendorFrom(prev));
    if (!v.ok) throw new StoreError('invalid', v.error);
    return M.vendorFrom(await this._update('vendor_companies', id, A.toRow(v.value)));
  }
  async listContacts(f) {
    const q = f || {};
    const rows = (await this._list('vendor_contacts', { company_id: q.companyId ? M.eq(q.companyId) : '', order: 'name.asc' })).map(M.contactFrom);
    return q.q ? rows.filter((c) => textHas([c.name, c.email, c.title].join(' '), q.q)) : rows;
  }
  /** Contacts are unique per team by lower-case email: saving an email that exists updates that contact (same as the demo). */
  async saveContact(row) {
    const email = lower(row.email).trim();
    const name = String(row.name || '').trim();
    if (!name) throw new StoreError('invalid', 'A contact needs a name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new StoreError('invalid', 'Enter a valid email address.');
    if (!row.companyId) throw new StoreError('invalid', 'Pick a company for this contact.');
    await this._loadMe();
    const body = M.contactTo({ ...row, email });
    let id = row.id || '';
    if (!id) {
      // The unique index is on lower(email), which PostgREST cannot target for an upsert, so look the email up first.
      const hits = await this._rest('GET', 'vendor_contacts', { qs: M.query({ select: 'id,email', email: 'ilike.' + encodeURIComponent(email.replace(/[\\%_]/g, (c) => '\\' + c)), limit: 5 }) });
      const found = (hits || []).find((x) => lower(x.email) === email);
      if (found) id = found.id;
    }
    const saved = id ? await this._update('vendor_contacts', id, body) : await this._insert('vendor_contacts', { ...body, source: row.source === 'extension' || row.source === 'import' ? row.source : 'manual' });
    return M.contactFrom(saved);
  }

  // ── submissions and the guard ──────────────────────────────────────────
  async listSubmissions(f) {
    const q = f || {};
    const since = q.sinceDays ? addDays(this._today(), -Number(q.sinceDays)) : '';
    await this._loadMe();
    // 0046: the pay rate rides along from submission_pay; RLS returns no row to someone who may not see pay.
    const payHidden = !this._seesPay();
    return (await this._list('submissions', {
      select: '*,submission_pay(pay_rate)',
      recruiter_id: q.recruiterId ? M.eq(q.recruiterId) : '', consultant_id: q.consultantId ? M.eq(q.consultantId) : '', stage: q.stage ? M.eq(q.stage) : '',
      submitted_on: since ? 'gte.' + since : '', order: 'submitted_on.desc,created_at.desc'
    })).map((r) => M.submissionFrom(r, { payHidden }));
  }
  _seesPay() { return can(this._role(), 'see_pay', (this._settings || {})); }
  /** Writes (or clears) the pay rate of one submission: an upsert on submission_pay, or a delete when it is cleared. */
  async _savePay(submissionId, payRate) {
    if (!this._seesPay()) throw new StoreError('forbidden', 'Only an owner or manager can see or change pay rates.', 403);
    const n = payRate === null || payRate === undefined || payRate === '' ? null : Number(payRate);
    if (n === null) { await this._rest('DELETE', 'submission_pay', { qs: M.query({ submission_id: M.eq(submissionId) }) }); return null; }
    const rows = await this._rest('POST', 'submission_pay', { qs: 'on_conflict=submission_id', body: { submission_id: submissionId, team_id: await this._teamId(), pay_rate: n },
      prefer: 'resolution=merge-duplicates,return=representation' });
    return rows && rows[0] ? Number(rows[0].pay_rate) : n;
  }
  /**
   * Earlier submissions in the last 90 days: same consultant AND (same end client OR requirement OR job reference), across the whole team.
   * The server is the source of truth: the `team` function's `guard` action runs bp_team_guard (0011, via 0013 bp_team_guard_for) for the
   * caller's own team. A failed call throws, so nothing is saved on an unchecked guard. Same result shape as the demo's guard.js.
   */
  async checkGuard(query) {
    const q = query || {};
    if (!q.consultantId) return [];
    const r = await this._team('guard', {
      consultant_id: q.consultantId, end_client: String(q.endClient || '').trim() || null, requirement_id: q.requirementId || null, job_ref: String(q.jobRef || '').trim() || null
    });
    const today = this._today();
    return (r && Array.isArray(r.matches) ? r.matches : [])
      .filter((m) => !q.excludeId || m.submission_id !== q.excludeId)
      .map((m) => ({
        submission: {
          id: m.submission_id, consultantId: m.consultant_id, requirementId: m.requirement_id || null, vendorCompanyId: m.vendor_company_id || '',
          chain: Array.isArray(m.chain) ? m.chain : [],
          endClient: m.end_client || '', jobRef: m.job_ref || '', stage: m.stage || 'submitted', submittedOn: m.submitted_on || '', recruiterId: m.recruiter_id || ''
        },
        reasons: Array.isArray(m.matched_on) ? m.matched_on : [],
        daysAgo: m.submitted_on ? diffDays(today, m.submitted_on) : 0
      }));
  }
  // ── P3 (0051): interviews and placements. RLS: members read and write, owners and managers delete; placement_pay as submission_pay. ──
  async listInterviews(f) {
    const q = f || {};
    await this._loadMe();
    const qs = { submission_id: q.submissionId ? M.eq(q.submissionId) : '', order: 'at.asc' };
    if (q.from && q.to) qs.and = `(at.gte.${q.from},at.lt.${q.to})`;
    else if (q.from) qs.at = 'gte.' + q.from;
    else if (q.to) qs.at = 'lt.' + q.to;
    return (await this._list('submission_interviews', qs)).map(M.interviewFrom);
  }
  async saveInterview(row) {
    await this._loadMe();
    const body = M.interviewTo(row);
    const saved = row.id ? await this._update('submission_interviews', row.id, body) : await this._insert('submission_interviews', { ...body, submission_id: row.submissionId });
    return M.interviewFrom(saved);
  }
  async deleteInterview(id) { await this._loadMe(); await this._delete('submission_interviews', id, 'interview'); return { ok: true }; }
  async listPlacements() {
    await this._loadMe();
    const payHidden = !this._seesPay();
    return (await this._list('placements', { select: '*,placement_pay(pay_rate)', order: 'start_on.desc' })).map((r) => M.placementFrom(r, { payHidden }));
  }
  /** Writes (or clears) a placement's pay rate: an upsert on placement_pay, or a delete when it is cleared. */
  async _savePlacementPay(placementId, payRate) {
    if (!this._seesPay()) throw new StoreError('forbidden', 'Only an owner or manager can see or change pay rates.', 403);
    const n = payRate === null || payRate === undefined || payRate === '' ? null : Number(payRate);
    if (n === null) { await this._rest('DELETE', 'placement_pay', { qs: M.query({ placement_id: M.eq(placementId) }) }); return null; }
    const rows = await this._rest('POST', 'placement_pay', { qs: 'on_conflict=placement_id', body: { placement_id: placementId, team_id: await this._teamId(), pay_rate: n },
      prefer: 'resolution=merge-duplicates,return=representation' });
    return rows && rows[0] ? Number(rows[0].pay_rate) : n;
  }
  async savePlacement(row) {
    await this._loadMe();
    const body = M.placementTo(row);
    const payHidden = !this._seesPay();
    const withPay = (saved, pay) => M.placementFrom({ ...saved, placement_pay: pay === null || pay === undefined ? null : { pay_rate: pay } }, { payHidden });
    if (!row.id) {
      const saved = await this._insert('placements', { ...body, submission_id: row.submissionId });
      const hasPay = row.payRate !== undefined && row.payRate !== null && row.payRate !== '';
      return withPay(saved, hasPay ? await this._savePlacementPay(saved.id, row.payRate) : null);
    }
    if (row.payRate === undefined) return withPay(await this._update('placements', row.id, body), null);
    // pay <= bill holds on both tables (0051): lowering both, the pay goes first; raising both, the bill goes first.
    let saved, pay;
    try { saved = await this._update('placements', row.id, body); pay = await this._savePlacementPay(row.id, row.payRate); }
    catch (e) {
      if (!(e && e.code === 'invalid')) throw e;
      pay = await this._savePlacementPay(row.id, row.payRate);
      saved = await this._update('placements', row.id, body);
    }
    return withPay(saved, pay);
  }
  async deletePlacement(id) { await this._loadMe(); await this._delete('placements', id, 'placement'); return { ok: true }; }

  // ── 0055: timesheets (members), invoices and commission rules (owners and managers; RLS). An invoice is made only by the team function's
  // invoice-create (bp_team_invoice_create), so its hours always match the approved weeks; afterwards only its status, days and note change. ──
  async listTimesheets(f) {
    const q = f || {};
    await this._loadMe();
    return (await this._list('placement_timesheets', { placement_id: q.placementId ? M.eq(q.placementId) : '', order: 'week_start.desc' })).map(M.timesheetFrom);
  }
  async saveTimesheet(row) {
    await this._loadMe();
    const body = M.timesheetTo(row);
    const saved = row.id ? await this._update('placement_timesheets', row.id, body) : await this._insert('placement_timesheets', { ...body, placement_id: row.placementId });
    return M.timesheetFrom(saved);
  }
  async deleteTimesheet(id) { await this._loadMe(); await this._delete('placement_timesheets', id, 'timesheet'); return { ok: true }; }
  async listInvoices() {
    await this._loadMe();
    if (!this._isLead()) return [];
    return (await this._list('invoices', { order: 'issued_on.desc,number.desc' })).map(M.invoiceFrom);
  }
  /** row: { placementId, number, issuedOn?, from?, to?, otRate? } -> the new invoice (the server picks the weeks and does the sums). */
  async createInvoice(row) {
    const r = row || {};
    const out = await this._team('invoice-create', { placement_id: r.placementId, number: String(r.number || '').trim(), issued_on: r.issuedOn || null,
      from: r.from || null, to: r.to || null, ot_rate: r.otRate === '' || r.otRate === undefined ? null : r.otRate });
    return M.invoiceFrom(out.invoice);
  }
  async updateInvoice(id, patch) {
    await this._loadMe();
    return M.invoiceFrom(await this._update('invoices', id, M.invoicePatchTo(patch)));
  }
  async deleteInvoice(id) { await this._loadMe(); await this._delete('invoices', id, 'invoice'); return { ok: true }; }
  async listCommissionRules() {
    await this._loadMe();
    if (!this._isLead()) return [];
    return (await this._list('commission_rules', { order: 'created_at.asc' })).map(M.commissionRuleFrom);
  }
  async saveCommissionRule(row) {
    await this._loadMe();
    const saved = row.id ? await this._update('commission_rules', row.id, M.commissionRuleTo(row, false)) : await this._insert('commission_rules', M.commissionRuleTo(row, true));
    return M.commissionRuleFrom(saved);
  }
  async deleteCommissionRule(id) { await this._loadMe(); await this._delete('commission_rules', id, 'rule'); return { ok: true }; }
  async getInvoiceProfile() {
    await this._loadMe();
    const rows = await this._rest('GET', 'team_branding', { qs: M.query({ select: M.INVOICE_PROFILE_COLUMNS, limit: 1 }) });
    return M.invoiceProfileFrom(rows && rows[0]);
  }
  /** The firm's invoice details on team_branding (one row per team): an upsert of these columns only, so the website stays as it is. */
  async saveInvoiceProfile(row) {
    const teamId = await this._teamId();
    const rows = await this._rest('POST', 'team_branding', {
      qs: 'on_conflict=team_id&columns=team_id,' + M.INVOICE_PROFILE_COLUMNS, prefer: 'resolution=merge-duplicates,return=representation',
      body: { ...M.invoiceProfileTo(row || {}), team_id: teamId }
    });
    return M.invoiceProfileFrom(rows && rows[0]);
  }

  async saveSubmission(row, opts) {
    await this._loadMe();
    if (row.id) {
      const body = { ...M.submissionP2To(row) };
      if (row.stage) body.stage = row.stage;
      if (row.rate != null) body.rate = String(row.rate).trim() || null;
      const payHidden = !this._seesPay();
      if (row.payRate === undefined) return M.submissionFrom(await this._update('submissions', row.id, body), { payHidden });
      // pay <= bill holds on both tables (0046): lowering both, the pay goes first; raising both, the bill goes first.
      let saved, pay;
      try { saved = await this._update('submissions', row.id, body); pay = await this._savePay(row.id, row.payRate); }
      catch (e) {
        if (!(e && e.code === 'invalid')) throw e;
        pay = await this._savePay(row.id, row.payRate);
        saved = await this._update('submissions', row.id, body);
      }
      return M.submissionFrom({ ...saved, submission_pay: pay === null ? null : { pay_rate: pay } }, { payHidden });
    }
    if (!row.consultantId) throw new StoreError('invalid', 'Pick a consultant.');
    const endClient = String(row.endClient || '').trim();
    if (!endClient && !row.requirementId) throw new StoreError('invalid', 'Add the end client, or pick a requirement.');
    const matches = await this.checkGuard({ consultantId: row.consultantId, endClient, requirementId: row.requirementId, jobRef: row.jobRef });
    const reason = String((opts && opts.overrideReason) || '').trim();
    if (matches.length && !reasonOk(reason)) {
      const err = new StoreError('guard_block', 'Already submitted. Type a reason (at least 8 characters) to continue.');
      err.matches = clone(matches);
      throw err;
    }
    const nul = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };
    const saved = await this._insert('submissions', {
      consultant_id: row.consultantId, requirement_id: nul(row.requirementId), vendor_company_id: nul(row.vendorCompanyId), vendor_contact_id: nul(row.vendorContactId),
      end_client: nul(endClient), job_ref: nul(row.jobRef), rate: nul(row.rate), rtr_status: 'none', ...M.submissionP2To(row), stage: row.stage || 'submitted',
      submitted_on: nul(row.submittedOn) || this._today(), recruiter_id: this._uid(), override_reason: matches.length ? reason.slice(0, 300) : null
    });
    const hasPay = row.payRate !== undefined && row.payRate !== null && row.payRate !== '';
    const pay = hasPay ? await this._savePay(saved.id, row.payRate) : null;
    return M.submissionFrom({ ...saved, submission_pay: pay === null ? null : { pay_rate: pay } }, { payHidden: !this._seesPay() });
  }

  // ── delete: owners and managers (RLS 0011 `<table>_delete`; record-delete.js). PostgREST DELETE with return=representation, so a row
  // that RLS hides or refuses (a recruiter, another team) comes back empty instead of looking deleted. ──
  async _delete(table, id, what) {
    if (!canDeleteRecords(this._role(), true)) throw new StoreError('forbidden', 'Only an owner or manager can delete records.', 403);
    const rows = await this._rest('DELETE', table, { qs: M.query({ id: M.eq(id) }), prefer: 'return=representation' });
    if (!rows || !rows.length) throw new StoreError('not_found', 'That ' + what + ' was not found, or your role cannot delete it.', 404);
    return rows[0];
  }
  /**
   * A consultant with submissions cannot be deleted (submissions_consultant_fk keeps them). Otherwise the resume files go first through the
   * existing `resume-delete` action (file removed at once), then the row; any version left is removed by the cascade, whose trigger
   * (0029 bp_team_resume_gone) queues the file for deletion.
   */
  async deleteConsultant(id) {
    await this._loadMe();
    if (!canDeleteRecords(this._role(), true)) throw new StoreError('forbidden', 'Only an owner or manager can delete records.', 403);
    const subs = await this._rest('GET', 'submissions', { qs: M.query({ select: 'id', consultant_id: M.eq(id), limit: 1 }) });
    if (subs && subs.length) throw new StoreError('linked', CONSULTANT_HAS_SUBMISSIONS, 409);
    for (const v of await this.listResumes(id)) await this.deleteResume(v.id);
    await this._delete('consultants', id, 'consultant');
    return { ok: true };
  }
  async deleteRequirement(id) { await this._loadMe(); await this._delete('requirements', id, 'requirement'); return { ok: true }; }
  /** The company and its contacts: the FK would only clear the contacts' company, leaving contacts no screen can show. */
  async deleteVendor(id) {
    await this._loadMe();
    if (!canDeleteRecords(this._role(), true)) throw new StoreError('forbidden', 'Only an owner or manager can delete records.', 403);
    const gone = await this._rest('DELETE', 'vendor_contacts', { qs: M.query({ company_id: M.eq(id) }), prefer: 'return=representation' });
    await this._delete('vendor_companies', id, 'company');
    return { ok: true, contacts: (gone || []).length };
  }
  async deleteContact(id) { await this._loadMe(); await this._delete('vendor_contacts', id, 'contact'); return { ok: true }; }
  async deleteSubmission(id) { await this._loadMe(); await this._delete('submissions', id, 'submission'); return { ok: true }; }

  // ── consent, contact log, erase and export of one consultant (staffing P5, migration 0049). Notes go straight through PostgREST (RLS:
  // team members read and add; the author or an owner/manager deletes; the read-only and stamp triggers apply). The erase runs in the
  // `team` function (service role), which also removes the resume files from Storage. ──
  async listContactNotes(entity, entityId) {
    const rows = await this._list('contact_notes', { entity: M.eq(entity), entity_id: M.eq(entityId), order: 'at.desc' });
    return sortNotes(rows.map(M.contactNoteFrom));
  }
  async addContactNote(input) {
    const n = cleanNoteInput(input);
    if (!n) throw new StoreError('invalid', NOTE_EMPTY, 400);
    return M.contactNoteFrom(await this._insert('contact_notes', M.contactNoteTo(n)));
  }
  async deleteContactNote(id) {
    const rows = await this._rest('DELETE', 'contact_notes', { qs: M.query({ id: M.eq(id) }), prefer: 'return=representation' });
    if (!rows || !rows.length) throw new StoreError('not_found', 'That note was not found, or only its author, an owner or a manager can delete it.', 404);
    return { ok: true };
  }
  // ── 0056: the consultant self-service link. Owners and managers read the team's links (RLS); making and cancelling go through `team`. ──
  async listConsultantLinks(consultantId) {
    if (!can(this._role(), 'consultant_links')) return [];
    const rows = await this._rest('GET', 'consultant_links', {
      qs: M.query({ select: 'id,consultant_id,submission_id,created_at,expires_at,revoked_at,opens,responses,responded_at,response',
        consultant_id: M.eq(consultantId), order: 'created_at.desc', limit: 20 })
    });
    return (rows || []).map(linkFrom);
  }
  async createConsultantLink(consultantId, submissionId) {
    const r = await this._team('link-create', { consultant_id: String(consultantId), ...(submissionId ? { submission_id: String(submissionId) } : {}) });
    return { id: String(r.link_id), link: String(r.link), expiresAt: String(r.expires_at || '') };
  }
  async revokeConsultantLink(id) { await this._team('link-revoke', { link_id: String(id) }); }
  /** 0053: where else the full name appears, from the `team` function's consultant-name-matches (owners and managers; nothing changes). */
  async consultantNameMatches(id) {
    const r = await this._team('consultant-name-matches', { consultant_id: String(id) });
    return (Array.isArray(r && r.matches) ? r.matches : []).filter((m) => m && (m.kind === 'contact_note' || m.kind === 'vendor_note') && typeof m.id === 'string')
      .map((m) => ({ kind: m.kind, id: m.id, entity: String(m.entity || (m.kind === 'vendor_note' ? 'vendor_company' : '')), entityName: String(m.entity_name || ''),
        at: String(m.at || ''), text: String(m.text || '') }));
  }
  async eraseConsultant(id, confirmName, scrub) {
    let r;
    const list = (Array.isArray(scrub) ? scrub : []).filter((x) => x && typeof x.id === 'string').map((x) => ({ kind: x.kind, id: x.id }));
    try {
      r = await this._team('consultant-erase', { consultant_id: String(id), confirm: String(confirmName || '').trim(), ...(list.length ? { scrub: list } : {}) });
    } catch (e) {
      if (e && e.code === 'confirm_mismatch') e.message = ERASE_MISMATCH;
      throw e;
    }
    return { ok: true, keptRow: Boolean(r && r.kept_row), submissions: Number(r && r.submissions) || 0, files: Number(r && r.files) || 0, scrubbed: Number(r && r.scrubbed) || 0 };
  }
  async exportConsultant(id) {
    const team = await this.getTeam();
    if (!can(this._role(), 'export', team.settings)) throw new StoreError('forbidden', 'Your workspace owner has turned off exports for your role.', 403);
    const c = await this.getConsultant(id);
    if (!c) throw new StoreError('not_found', 'That consultant is not in your workspace.', 404);
    const [resumes, submissions, contactNotes, interviews, placements] = await Promise.all([this.listResumes(id), this.listSubmissions({ consultantId: id }),
      this.listContactNotes('consultant', id), this._list('submission_interviews', { consultant_id: M.eq(id), order: 'at.asc' }),
      this._list('placements', { select: '*,placement_pay(pay_rate)', consultant_id: M.eq(id), order: 'start_on.desc' })]);
    return consultantExport({ consultant: c, resumes, submissions, contactNotes, interviews: interviews.map(M.interviewFrom),
      placements: placements.map((r) => M.placementFrom(r, { payHidden: !this._seesPay() })) });
  }

  // ── P4 (0052): targets (owners and managers write; RLS shows a recruiter the team's, the desks' and their own) and the guard's
  //    catches per person (read only; RLS shows a recruiter their own) ──
  async listTargets() { return (await this._list('team_targets', { order: 'period.asc' })).map(M.targetFrom); }
  async saveTarget(row) {
    await this._loadMe();
    if (!this._isLead()) throw new StoreError('forbidden', 'Only an owner or manager can set targets.', 403);
    const saved = row.id ? await this._update('team_targets', row.id, M.targetTo(row, false)) : await this._insert('team_targets', M.targetTo(row, true));
    return M.targetFrom(saved);
  }
  async deleteTarget(id) {
    const rows = await this._rest('DELETE', 'team_targets', { qs: M.query({ id: M.eq(id) }), prefer: 'return=representation' });
    if (!rows || !rows.length) throw new StoreError('not_found', 'That target was not found, or your role cannot remove it.');
  }
  async listGuardCatches(f) {
    const q = f || {};
    const qs = { select: 'day,user_id,warned', order: 'day.asc,user_id.asc', limit: 5000 };   // a row per person and day: a year of a 40-person team fits
    if (q.from && q.to) qs.and = `(day.gte.${q.from},day.lte.${q.to})`;
    else if (q.from) qs.day = 'gte.' + q.from;
    else if (q.to) qs.day = 'lte.' + q.to;
    return ((await this._rest('GET', 'team_guard_catches_by', { qs: M.query(qs) })) || []).map(M.guardCatchFrom);
  }

  // ── home ───────────────────────────────────────────────────────────────
  async todayStats() {
    const [consultants, submissions, members, companies, contacts, requirements] = await Promise.all([
      this.listConsultants(), this.listSubmissions({}), this.listMembers(), this.listVendors(), this.listContacts(), this.listRequirements()
    ]);
    const activity = submissions.filter((s) => s.overrideReason).map((s) => ({ action: 'guard_override', at: s.submittedOn }));
    return computeToday({ consultants, submissions, members, companies, contacts, requirements, activity }, this._today());
  }
  async listActivity(limit) {
    const rows = await this._rest('GET', 'activity_log', { qs: M.query({ select: '*', order: 'created_at.desc', limit: Math.min(Number(limit) || 20, 200) }) });
    return (rows || []).map(M.activityFrom);
  }
  /** One page of the activity log (RLS: own team only). Asks for one row more than the page to know if there is an older page. */
  async listAudit(f) {
    await this._teamId();
    if (!this._isLead()) throw new StoreError('forbidden', 'Only owners and managers can see the activity log.');
    const q = f || {};
    const limit = Math.min(Math.max(Number(q.limit) || AUDIT_PAGE, 1), 500), offset = Math.max(Number(q.offset) || 0, 0);
    // A desk filter (actorIds) with nobody on the desk, or a person who is not on it, matches nothing.
    if (Array.isArray(q.actorIds) && (!q.actorIds.length || (q.actorId && !q.actorIds.includes(q.actorId)))) return { rows: [], more: false };
    const rows = await this._rest('GET', 'activity_log', { qs: M.auditQuery({ ...q, entities: entitiesFor(q.kind), ...dayRange(q.from, q.to), limit: limit + 1, offset }) });
    const list = (rows || []).map(M.auditFrom);
    return { rows: list.slice(0, limit), more: list.length > limit };
  }
  /** The latest morning report run (report_runs, members read it under RLS), or null. */
  async lastReportRun() {
    const rows = await this._rest('GET', 'report_runs', { qs: M.query({ select: 'run_on,status', order: 'run_on.desc', limit: 1 }) });
    const r = rows && rows[0];
    return r ? { runOn: r.run_on, status: r.status } : null;
  }

  // ── team inbox (spec TEAM_INBOX_SPEC.md section 5, "API for the web app") ─
  /** `me` carries `inbox` and `inbox_domain`. `fresh` asks the server again (the Inbox screen does, so the counts are current). */
  // ── Agency desks (backlog W10, migration 0036: every member reads; owners and managers write; RLS and the plan gate decide) ──
  async listDesks() {
    const [desks, seats] = await Promise.all([
      this._list('team_desks', { select: 'id,name,office', order: 'name.asc' }), this._list('team_desk_members', { select: 'desk_id,user_id' })
    ]);
    return M.desksFrom(desks, seats);
  }
  async saveDesk(row) {
    const clean = cleanDesk(row, await this.listDesks());
    const body = { name: clean.name, office: clean.office || null };
    const saved = row.id ? await this._update('team_desks', row.id, body) : await this._insert('team_desks', body);
    return (await this.listDesks()).find((d) => d.id === saved.id) || M.desksFrom([saved], [])[0];
  }
  async deleteDesk(id) {
    const rows = await this._rest('DELETE', 'team_desks', { qs: M.query({ id: M.eq(id) }), prefer: 'return=representation' });
    if (!rows || !rows.length) throw new StoreError('not_found', 'That desk was not found, or your role cannot delete it.');
  }
  /** One desk per person: the old seat goes, then the new one (if any) is added. */
  async setMemberDesk(userId, deskId) {
    const team = await this._teamId();
    await this._rest('DELETE', 'team_desk_members', { qs: M.query({ team_id: M.eq(team), user_id: M.eq(userId) }), prefer: 'return=minimal' });
    if (deskId) await this._insert('team_desk_members', { desk_id: deskId, user_id: userId });
  }

  // ── smart lists (backlog W5, migration 0027 team_smart_lists: every member reads, owner / manager save and delete) ──
  async listSmartLists() { return (await this._list('team_smart_lists', { order: 'created_at.asc' })).map(M.smartListFrom); }
  async saveSmartList(row) {
    const clean = smartListInput(row, await this.listSmartLists());
    return M.smartListFrom(await this._insert('team_smart_lists', { ...clean, created_by: this._uid() }));
  }
  async deleteSmartList(id) {
    const rows = await this._rest('DELETE', 'team_smart_lists', { qs: M.query({ id: M.eq(id) }), prefer: 'return=representation' });
    if (!rows || !rows.length) throw new StoreError('not_found', 'That list was not found, or your role cannot delete it.');
  }
  /** The `team` function's email-check (W6): the mail server (MX) answer for the address's domain. A warning only. */
  async checkEmailDomain(email) {
    const r = await this._team('email-check', { email: String(email || '') });
    return { domain: String((r && r.domain) || ''), status: (r && r.status) || 'unknown', cached: Boolean(r && r.cached) };
  }

  async getInboxInfo(opts) {
    await this._loadMe(Boolean(opts && opts.fresh));
    return { ...(this._inbox || M.inboxInfoFrom(null)) };
  }
  async listInboxMessages(f) {
    const rows = await this._rest('GET', 'inbox_messages', { qs: M.inboxListQuery(f) });
    return (rows || []).map(M.inboxMessageFrom);
  }
  async getInboxMessage(id) {
    const rows = await this._rest('GET', 'inbox_messages', { qs: M.query({ select: M.INBOX_FULL_COLUMNS, id: M.eq(id), limit: 1 }) });
    if (!rows || !rows.length) throw new StoreError('not_found', 'That email was not found. It may have been deleted.', 404);
    return M.inboxMessageFrom(rows[0]);
  }
  async listInboxAddresses() {
    const rows = await this._rest('GET', 'inbox_addresses', { qs: M.query({ select: M.INBOX_ADDRESS_COLUMNS, order: 'created_at.desc' }) });
    return (rows || []).map(M.inboxAddressFrom);
  }
  async createInboxAddress(label) {
    const r = await this._team('inbox-address-create', { label: String(label || '').trim().slice(0, 60) });
    await this._loadMe(true);
    return M.inboxAddressFrom((r && r.address) || {});
  }
  async disableInboxAddress(id) {
    await this._team('inbox-address-disable', { address_id: id });
    await this._loadMe(true);
  }
  /** One server call (0040 bp_inbox_address_replace): the old address goes off only if the new one is made. No label = keep the old one. */
  async replaceInboxAddress(id, label) {
    const body = { address_id: id };
    if (label != null && String(label).trim()) body.label = String(label).trim().slice(0, 60);
    const r = await this._team('inbox-address-replace', body);
    await this._loadMe(true);
    return M.inboxAddressFrom((r && r.address) || {});
  }
  async markInbox(ids, status, requirementId) {
    const r = await this._team('inbox-mark', M.inboxMarkBody(ids, status, requirementId));
    await this._loadMe(true);
    return { updated: Number(r && r.updated) || 0, ids: Array.isArray(r && r.ids) ? r.ids.map(String) : [] };
  }
  async listInboxItems(messageId) {
    const rows = await this._rest('GET', 'inbox_message_items', { qs: M.query({ select: 'item_index,status', message_id: M.eq(messageId), order: 'item_index.asc' }) });
    return M.inboxItemsFrom(rows);
  }
  async markInboxItems(messageId, items, status) {
    const r = await this._team('inbox-item-mark', M.inboxItemMarkBody(messageId, items, status));
    return { updated: Number(r && r.updated) || 0, items: Array.isArray(r && r.items) ? r.items.filter((x) => Number.isInteger(x)) : [] };
  }
  async attachInbox(messageId, requirementId) {
    const r = await this._team('inbox-attach', { message_id: String(messageId), requirement_id: String(requirementId) });
    return { attached: Boolean(r && r.attached) };
  }

  // ── team templates (migration 0028; RLS: members read, owners and managers write, the sender profile is one's own) ─
  async listTemplates(opts) {
    const read = async () => (await this._list('team_templates', { select: M.TEMPLATE_COLUMNS, order: 'kind.asc,position.asc,created_at.asc' })).map(M.templateFrom);
    const rows = await read();
    const defaults = (opts && Array.isArray(opts.defaults)) ? opts.defaults : [];
    if (rows.length || !defaults.length) return sortTemplates(rows);
    await this._loadMe();
    if (!this._isLead()) return builtInTemplates(defaults);
    try {
      // First use: seed the defaults. seed_key is unique per team, so two people opening at once never double them.
      const teamId = await this._teamId();
      await this._rest('POST', 'team_templates', {
        qs: 'on_conflict=team_id,seed_key', prefer: 'resolution=ignore-duplicates,return=minimal',
        body: defaults.map((d) => ({ ...M.templateTo(d, d.seedKey), team_id: teamId }))
      });
    } catch (e) {
      if (e && e.code === 'session_expired') throw e;
      return builtInTemplates(defaults);       // read-only workspace or no right to write: show them unsaved
    }
    return sortTemplates(await read());
  }
  async saveTemplate(row) {
    const c = cleanTemplate(row);
    if (!c.ok) throw new StoreError('invalid', c.error);
    if (row.id && !row.builtIn) return M.templateFrom(await this._update('team_templates', row.id, M.templateTo(c.template)));
    let seedKey = '';
    if (row.builtIn && row.seedKey) {
      const taken = await this._rest('GET', 'team_templates', { qs: M.query({ select: 'id', seed_key: M.eq(row.seedKey), limit: 1 }) });
      if (!taken || !taken.length) seedKey = row.seedKey;
    }
    return M.templateFrom(await this._insert('team_templates', M.templateTo(c.template, seedKey)));
  }
  async deleteTemplate(id) {
    const rows = await this._rest('DELETE', 'team_templates', { qs: M.query({ id: M.eq(id) }), prefer: 'return=representation' });
    if (!rows || !rows.length) throw new StoreError('not_found', 'That was not found, or your role cannot change it.');
  }
  async getBranding() {
    const rows = await this._rest('GET', 'team_branding', { qs: M.query({ select: 'company_name,website', limit: 1 }) });
    return M.brandingFrom(rows && rows[0]);
  }
  async saveBranding(row) {
    const c = cleanBranding(row);
    if (!c.ok) throw new StoreError('invalid', c.error);
    const teamId = await this._teamId();
    const rows = await this._rest('POST', 'team_branding', {
      qs: 'on_conflict=team_id', prefer: 'resolution=merge-duplicates,return=representation', body: { ...M.brandingTo(c.branding), team_id: teamId }
    });
    return M.brandingFrom(rows && rows[0]);
  }
  async getSenderProfile() {
    const rows = await this._rest('GET', 'team_sender_profiles', { qs: M.query({ select: 'sender_name,job_title,phone', user_id: M.eq(this._uid()), limit: 1 }) });
    if (rows && rows[0]) return M.senderFrom(rows[0]);
    const cur = this._auth.current();
    return { senderName: (cur.user && (cur.user.name || nameFromEmail(cur.user.email))) || '', jobTitle: '', phone: '' };
  }
  async saveSenderProfile(row) {
    const teamId = await this._teamId();
    const rows = await this._rest('POST', 'team_sender_profiles', {
      qs: 'on_conflict=team_id,user_id', prefer: 'resolution=merge-duplicates,return=representation',
      body: { ...M.senderTo(cleanSender(row)), team_id: teamId, user_id: this._uid() }
    });
    return M.senderFrom(rows && rows[0]);
  }
}

/** Templates in display order: by kind (pitch, follow-up, hotlist intro, check-in), then position, then name. */
const KIND_ORDER = ['pitch', 'follow_up', 'hotlist_intro', 'check_in'];
function sortTemplates(list) {
  return list.slice().sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.position || 0) - (b.position || 0) || String(a.name).localeCompare(String(b.name)));
}
/** The defaults shown, unsaved, until an owner or manager opens the templates. */
function builtInTemplates(defaults) {
  return sortTemplates(defaults.map((d) => ({ id: 'default-' + d.seedKey, builtIn: true, seedKey: d.seedKey, kind: d.kind, name: d.name, subject: d.subject || '', body: d.body, position: d.position || 0 })));
}

export const STORE_METHODS = [
  'getSession', 'signIn', 'signOut', 'setDemoRole', 'resetDemo',
  'getTeam', 'updateTeam', 'listMembers', 'listInvites', 'inviteMember', 'setMemberRole', 'removeMember', 'leaveTeam', 'seatInfo', 'revokeInvite', 'resendInvite', 'exportAll', 'transferOwner', 'createTeam', 'acceptInvite',
  'importBook', 'deleteWorkspace', 'getBilling', 'startCheckout', 'requestPilotExtension', 'syncCall',
  'refreshBilling', 'getBillingHistory', 'getReferralLink', 'getPersonalPlan', 'forgetTeamCache',
  'deleteConsultant', 'deleteRequirement', 'deleteVendor', 'deleteContact', 'deleteSubmission',
  'listConsultants', 'getConsultant', 'saveConsultant',
  'listContactNotes', 'addContactNote', 'deleteContactNote', 'consultantNameMatches', 'eraseConsultant', 'exportConsultant',
  'listConsultantLinks', 'createConsultantLink', 'revokeConsultantLink', 'setSignupDomain',
  'listResumes', 'uploadResume', 'resumeLink', 'deleteResume',
  'listRequirements', 'getRequirement', 'saveRequirement',
  'listVendors', 'getVendor', 'saveVendor', 'saveVendorAgreement', 'listContacts', 'saveContact',
  'listSubmissions', 'checkGuard', 'saveSubmission',
  'listInterviews', 'saveInterview', 'deleteInterview', 'listPlacements', 'savePlacement', 'deletePlacement',
  'todayStats', 'listActivity', 'lastReportRun', 'listAudit',
  'getInboxInfo', 'listInboxMessages', 'getInboxMessage', 'listInboxAddresses', 'createInboxAddress', 'disableInboxAddress', 'replaceInboxAddress', 'markInbox',
  'attachInbox', 'listInboxItems', 'markInboxItems',
  'listTemplates', 'saveTemplate', 'deleteTemplate', 'getBranding', 'saveBranding', 'getSenderProfile', 'saveSenderProfile',
  'listSmartLists', 'saveSmartList', 'deleteSmartList', 'checkEmailDomain',
  'listDesks', 'saveDesk', 'deleteDesk', 'setMemberDesk',
  'listTargets', 'saveTarget', 'deleteTarget', 'listGuardCatches',
  'listTimesheets', 'saveTimesheet', 'deleteTimesheet', 'listInvoices', 'createInvoice', 'updateInvoice', 'deleteInvoice',
  'listCommissionRules', 'saveCommissionRule', 'deleteCommissionRule', 'getInvoiceProfile', 'saveInvoiceProfile'
];

/** Demo store (the default, used by `?demo=1` and by the tests). The app builds the live store with `new SupabaseStore({...})`. */
export function createStore(opts) {
  return new DemoStore(opts);
}
