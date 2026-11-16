// webapp/js/live-map.js - the live store's translation layer. Pure: no DOM, no network, no storage.
//   * camelCase screen fields <-> snake_case columns of migrations 0010-0011;
//   * server answers (PostgREST, the `team` function) -> short, friendly messages.
// Messages never contain emails, tokens or row contents.

import { nameFromEmail } from './auth.js';
import { withTags, cleanTags } from './req-tags.js';
import { CONSULTANT_CAP_NOTE, PLAN_HINTS } from './plan-gate.js';
import { cleanRateMin, normalizeRateUnit } from './consultant-profile.js';
import { cleanConsent, CONTACT_KINDS, ERASED_READ_ONLY } from './consent.js';

export const NETWORK = "Can't reach the server. Check your internet connection.";
export const SESSION_EXPIRED = 'Your session expired. Please sign in again.';
export const COMING_SOON = 'Coming in the next update.';
export const READ_ONLY = 'This workspace is read-only until the plan is paid. You can still see and export everything.';

export class StoreError extends Error {
  constructor(code, message, status) { super(message); this.name = 'StoreError'; this.code = code; if (status) this.status = status; }
}
export const comingSoon = () => new StoreError('coming_soon', COMING_SOON);

const day = (ts) => (ts ? String(ts).slice(0, 10) : '');
const str = (v) => (v == null ? '' : String(v));
const nul = (v) => { const s = String(v == null ? '' : v).trim(); return s === '' ? null : s; };
const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

// ── rows -> screen objects ───────────────────────────────────────────────
/** The `billing` object of the team `me` / `billing` actions (0016 bp_team_billing) -> the screens' shape. Missing = an open pilot. */
export function billingFrom(b, pilotEndsOn) {
  const x = b && typeof b === 'object' ? b : {};
  const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
  return {
    tier: str(x.tier || 'pilot'), state: str(x.state || 'pilot'), writable: x.writable !== false,
    paidUntil: day(x.paid_until || pilotEndsOn), daysLeft: num(x.days_left), readOnlyUntil: day(x.read_only_until),
    payNow: x.pay_now === true, members: num(x.members), noPilot: x.no_pilot === true,   // 0043: made without a free pilot, never paid
    extensionRequested: x.pilot_extension_requested === true, extended: x.pilot_extended === true, canRequestExtension: x.can_request_extension === true
  };
}

/** The weekly report day (settings.reportWeekday, ISO 1 = Monday ... 7 = Sunday; migration 0023). Anything else reads as Monday. */
export const WEEKDAYS = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };
export function weekdayOf(v) { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 7 ? n : 1; }

/** One team plan from the `billing` action (prices come from the server's plans.js; the web app never holds them). */
export function planFrom(p) {
  return { id: str(p.id), tier: str(p.tier), label: str(p.label), seats: num0(p.seats), inrText: str(p.inr_text), usdText: str(p.usd_text),
    period: p.period === 'year' ? 'year' : 'month', months: num0(p.months) || 1, locked: p.locked === true };
}
const num0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** One team payment from the `billing-history` action: amount in paise / cents, status paid | refunded | failed. */
export function paymentFrom(p) {
  const x = p && typeof p === 'object' ? p : {};
  return { date: day(x.date), plan: str(x.plan), amount: num0(x.amount), currency: x.currency === 'USD' ? 'USD' : 'INR',
    status: ['paid', 'refunded'].includes(x.status) ? x.status : 'failed' };
}
/** The `my-plan` action (same plan as GET /me): the caller's own tier ('free' | 'basic' | 'pro' | 'solo') and its end date. */
export function personalPlanFrom(r) {
  const x = r && typeof r === 'object' ? r : {};
  const tier = ['basic', 'pro', 'solo'].includes(x.tier) ? x.tier : 'free';
  return { tier, planUntil: tier === 'free' ? '' : day(x.plan_until) };
}
/** The founding team offer from the `billing` action (0033, F5), or null when the server sends none (switched off, or not the owner). */
export function foundingFrom(f) {
  if (!f || typeof f !== 'object') return null;
  if (f.member === true) return { member: true, offer: false, lockedUntil: str(f.locked_until), placesLeft: 0, limit: 0, lockMonths: 0 };
  return { member: false, offer: f.offer === true, lockedUntil: '', placesLeft: num0(f.places_left), limit: num0(f.limit), lockMonths: num0(f.lock_months) };
}
export function consultantFrom(r) {
  return {
    id: r.id, name: str(r.name), title: str(r.title), skills: r.skills || [], visa: str(r.visa), taxTerms: str(r.tax_terms), rate: str(r.rate),
    location: str(r.location), relocation: Boolean(r.relocation), availableOn: str(r.available_on), status: r.status || 'marketing',
    // Staffing P1 (0045): the work-authorisation type and end date (no document), and the minimum rate.
    visaType: str(r.visa_type), workAuthUntil: str(r.work_auth_until), rateMin: r.rate_min == null ? null : Number(r.rate_min), rateUnit: str(r.rate_unit) || 'hr',
    ownerRecruiterId: r.owner_recruiter || '', benchSince: str(r.bench_since), notes: '',
    resumeName: r.resume_path ? String(r.resume_path).split('/').pop() : '',
    deskId: r.desk_id || '',
    // Staffing P5 (0049): consent to be marketed ('' = not recorded), and erased (a data-rights erase kept the row only for the counts).
    ...cleanConsent({ consentOn: str(r.consent_on), consentSource: str(r.consent_source), consentNote: str(r.consent_note) }),
    erased: Boolean(r.erased_at),
    // 0056: the consultant's own location preference from the self-service link (read-only here)
    locationPref: str(r.location_pref)
  };
}
/** A contact log note (0049 contact_notes). */
export function contactNoteFrom(r) {
  return {
    id: r.id, entity: r.entity === 'vendor_contact' ? 'vendor_contact' : 'consultant', entityId: str(r.entity_id),
    kind: CONTACT_KINDS.includes(r.kind) ? r.kind : 'note', at: str(r.at), body: str(r.body), createdBy: r.created_by || '', createdAt: str(r.created_at)
  };
}
/** A cleaned note (consent.js cleanNoteInput) -> the insert body (team_id and created_by are added by the store and the stamp trigger). */
export function contactNoteTo(n) { return { entity: n.entity, entity_id: n.entityId, kind: n.kind, at: n.at, body: n.body }; }
export function vendorFrom(r) {
  return {
    id: r.id, name: str(r.name), domain: str(r.domain), tier: r.tier || 'unrated', avoidReason: str(r.avoid_reason), notes: str(r.notes),
    doNotContact: Boolean(r.do_not_contact), createdOn: day(r.created_at),
    // Vendor agreements (0050; the columns are BP.Agreements.COLUMNS). Screens read them through BP.Agreements.clean.
    msaStatus: r.msa_status || 'none', msaSignedOn: day(r.msa_signed_on), msaUntil: day(r.msa_until),
    ndaStatus: r.nda_status || 'none', ndaSignedOn: day(r.nda_signed_on), ndaUntil: day(r.nda_until),
    netTerms: r.net_terms == null ? null : Number(r.net_terms), paymentNote: str(r.payment_note)
  };
}
/** A saved smart list (0027 team_smart_lists). The rule stays as stored; the screen cleans it with BP.VendorBook.sanitizeRules. */
export function smartListFrom(r) {
  return { id: r.id, name: str(r.name), rules: r.rules && typeof r.rules === 'object' && !Array.isArray(r.rules) ? r.rules : {}, createdBy: r.created_by || '', createdAt: str(r.created_at) };
}
export function contactFrom(r) {
  return {
    id: r.id, companyId: r.company_id || '', name: str(r.name), email: str(r.email), phone: str(r.phone), title: str(r.title),
    source: r.source || 'manual', doNotContact: Boolean(r.do_not_contact), createdOn: day(r.created_at), createdBy: r.created_by || ''
  };
}
export function requirementFrom(r) {
  return withTags({
    id: r.id, title: str(r.title), endClient: str(r.end_client), jobRef: str(r.job_ref), vendorCompanyId: r.vendor_company_id || '', vendorContactId: r.vendor_contact_id || '',
    rateText: str(r.rate_text), workMode: str(r.work_mode), location: str(r.location), visaText: str(r.visa_text), taxTerms: str(r.tax_terms),
    duration: str(r.duration), skills: r.skills || [], source: r.source || 'paste', sourceBoard: str(r.source_board), sourceUrl: str(r.source_url), postedOn: str(r.posted_on) || day(r.created_at),
    rawText: str(r.raw_text), status: r.status || 'open', createdBy: r.created_by || '', createdAt: str(r.created_at),
    // 0026 tags; a row from before 0026 (no such columns) reads them from its free text (req-tags.js withTags)
    ...(r.visa_allowed === undefined ? {} : {
      visaAllowed: r.visa_allowed || [], visaNotAllowed: r.visa_not_allowed || [], termsTags: r.tax_terms_tags || [], workModeTag: str(r.work_mode_tag),
      rateMin: r.rate_min == null ? null : Number(r.rate_min), rateMax: r.rate_max == null ? null : Number(r.rate_max), rateUnit: str(r.rate_unit),
      durationMonths: r.duration_months == null ? null : Number(r.duration_months)
    })
  });
}
/** The 0026 tag columns, only when the row carries tags (a form set them). Without them the bp_4_tags trigger reads the free text on insert. */
export function requirementTagsTo(row) {
  if (!row || row.visaAllowed === undefined) return {};
  const t = cleanTags(row);
  return {
    visa_allowed: t.visaAllowed, visa_not_allowed: t.visaNotAllowed, tax_terms_tags: t.termsTags, work_mode_tag: t.workModeTag || null,
    rate_min: t.rateMin, rate_max: t.rateMax, rate_unit: t.rateUnit || null, duration_months: t.durationMonths
  };
}
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/**
 * A submission row. 0046 (P2): the RTR day, end and agreed rate, the bill rate, unit, tax terms and vendor chain; the pay rate comes from the
 * embedded submission_pay row (an array or an object, depending on how PostgREST reads the relationship). A person who may not see pay
 * gets no row from RLS, so payRate is null and payHidden tells the screens not to read that as "no pay rate".
 */
export function submissionFrom(r, opts) {
  const pay = Array.isArray(r.submission_pay) ? r.submission_pay[0] : r.submission_pay;
  return {
    id: r.id, consultantId: r.consultant_id, requirementId: r.requirement_id || null, vendorCompanyId: r.vendor_company_id || '', vendorContactId: r.vendor_contact_id || '',
    endClient: str(r.end_client), jobRef: str(r.job_ref), rate: str(r.rate), rtrStatus: r.rtr_status || 'none', stage: r.stage || 'submitted',
    submittedOn: str(r.submitted_on), recruiterId: r.recruiter_id || '', overrideReason: str(r.override_reason),
    rtrOn: str(r.rtr_on), rtrUntil: str(r.rtr_until), rtrRate: numOrNull(r.rtr_rate), billRate: numOrNull(r.bill_rate), rateUnit: r.rate_unit || 'hr',
    taxTerms: str(r.tax_terms), chain: Array.isArray(r.chain) ? r.chain.map(str).filter(Boolean) : [],
    payRate: pay ? numOrNull(pay.pay_rate) : null, payHidden: Boolean(opts && opts.payHidden),
    createdAt: str(r.created_at), updatedAt: str(r.updated_at)
  };
}
/** The 0046 columns from a form row (camelCase), only the keys present, so an edit never blanks what it did not show. */
export function submissionP2To(row) {
  const out = {};
  const has = (k) => row[k] !== undefined;
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  if (has('rtrOn')) out.rtr_on = day(row.rtrOn);
  if (has('rtrUntil')) out.rtr_until = day(row.rtrUntil);
  if (has('rtrRate')) out.rtr_rate = numOrNull(row.rtrRate);
  if (has('billRate')) out.bill_rate = numOrNull(row.billRate);
  if (has('rateUnit')) out.rate_unit = ['hr', 'day', 'month', 'year'].includes(row.rateUnit) ? row.rateUnit : 'hr';
  if (has('taxTerms')) out.tax_terms = ['C2C', 'W2', '1099'].includes(row.taxTerms) ? row.taxTerms : null;
  if (has('chain')) out.chain = Array.isArray(row.chain) ? row.chain.map((x) => String(x).trim()).filter(Boolean).slice(0, 4) : [];
  if (has('rtrStatus')) out.rtr_status = ['none', 'requested', 'signed'].includes(row.rtrStatus) ? row.rtrStatus : 'none';
  return out;
}
// ── staffing P3 (0051): interviews and placements. The placement's pay rate rides along from placement_pay (owners and managers, recruiters
// when the owner allows it; RLS returns no row otherwise). ──
export function interviewFrom(r) {
  return {
    id: r.id, submissionId: r.submission_id, consultantId: r.consultant_id || '', at: str(r.at), tz: str(r.tz) || 'Asia/Kolkata', round: Number(r.round) || 1,
    mode: r.mode || 'video', withWhom: str(r.with_whom), feedback: str(r.feedback), outcome: r.outcome || 'pending', createdBy: r.created_by || '',
    createdAt: str(r.created_at), updatedAt: str(r.updated_at)
  };
}
/** A cleaned interview (BP.Placements.cleanInterview's shape) to columns. The consultant is set by the database from the submission. */
export function interviewTo(iv) {
  return { at: iv.at, tz: iv.tz, round: iv.round, mode: iv.mode, with_whom: iv.withWhom || null, feedback: iv.feedback || null, outcome: iv.outcome };
}
export function placementFrom(r, opts) {
  const pay = Array.isArray(r.placement_pay) ? r.placement_pay[0] : r.placement_pay;
  return {
    id: r.id, submissionId: r.submission_id, consultantId: r.consultant_id || '', startOn: str(r.start_on), endOn: str(r.end_on), billRate: numOrNull(r.bill_rate),
    rateUnit: r.rate_unit || 'hr', taxTerms: str(r.tax_terms), endClient: str(r.end_client), vendorCompanyId: r.vendor_company_id || '', poRef: str(r.po_ref),
    status: r.status || 'active', payRate: pay ? numOrNull(pay.pay_rate) : null, payHidden: Boolean(opts && opts.payHidden),
    createdAt: str(r.created_at), updatedAt: str(r.updated_at)
  };
}
/** A cleaned placement (BP.Placements.cleanPlacement's shape) to columns; the pay rate is written to placement_pay on its own. */
export function placementTo(p) {
  return { start_on: p.startOn, end_on: p.endOn || null, bill_rate: p.billRate === null || p.billRate === undefined ? null : p.billRate, rate_unit: p.rateUnit || 'hr',
    tax_terms: p.taxTerms || null, po_ref: p.poRef || null, status: p.status || 'active' };
}
/** Staffing P4 (0052): a team_targets row (memberId / deskId '' = everyone). */
export function targetFrom(r) {
  return { id: r.id, memberId: r.member_id || '', deskId: r.desk_id || '', period: r.period, submissions: Number(r.submissions) || 0,
    interviews: Number(r.interviews) || 0, placements: Number(r.placements) || 0, updatedAt: str(r.updated_at) };
}
/** A cleaned target (BP.Targets.cleanTarget plus memberId / deskId) to columns. The scope and period only on a new row (they never move). */
export function targetTo(t, isNew) {
  const out = { submissions: t.submissions, interviews: t.interviews, placements: t.placements };
  return isNew ? { ...out, member_id: t.memberId || null, desk_id: t.deskId || null, period: t.period } : out;
}
// ── timesheets, invoices and commission rules (0055). Field names are lib/invoicing.js's (BP.Timesheets, BP.Invoices, BP.Commission). ──
export function timesheetFrom(r) {
  return { id: r.id, placementId: r.placement_id, weekStart: str(r.week_start), regular: Number(r.regular_hours) || 0, ot: Number(r.ot_hours) || 0,
    approvedBy: str(r.approved_by), status: r.status || 'draft', invoiceId: r.invoice_id || '', createdBy: r.created_by || '', updatedAt: str(r.updated_at) };
}
/** A cleaned timesheet (BP.Timesheets.cleanTimesheet's shape) to columns. The invoice link is never written from here. */
export function timesheetTo(t) {
  return { week_start: t.weekStart, regular_hours: t.regular, ot_hours: t.ot, approved_by: t.approvedBy || null, status: t.status };
}
export function invoiceFrom(r) {
  return { id: r.id, placementId: r.placement_id, number: str(r.number), periodFrom: str(r.period_from), periodTo: str(r.period_to),
    regularHours: Number(r.regular_hours) || 0, otHours: Number(r.ot_hours) || 0, billRate: numOrNull(r.bill_rate), otRate: numOrNull(r.ot_rate),
    amount: Number(r.amount) || 0, currency: r.currency || 'USD', issuedOn: str(r.issued_on), netTerms: Number(r.net_terms) || 30, dueOn: str(r.due_on),
    status: r.status || 'draft', sentOn: str(r.sent_on), paidOn: str(r.paid_on), note: str(r.note), createdAt: str(r.created_at), updatedAt: str(r.updated_at) };
}
/** The fields an invoice may change after it is made (BP.Invoices.updateInvoice's result). */
export function invoicePatchTo(inv) {
  return { status: inv.status, sent_on: inv.sentOn || null, paid_on: inv.paidOn || null, due_on: inv.dueOn, note: inv.note || null };
}
export function commissionRuleFrom(r) {
  return { id: r.id, memberId: r.member_id || '', basis: r.basis, pct: numOrNull(r.pct), fixed: numOrNull(r.fixed_amount),
    leadMemberId: r.lead_member_id || '', leadSharePct: Number(r.lead_share_pct) || 0, updatedAt: str(r.updated_at) };
}
/** A cleaned rule (BP.Commission.cleanRule) to columns; the person only on a new rule (a rule never moves to someone else). */
export function commissionRuleTo(c, isNew) {
  const out = { basis: c.basis, pct: c.basis === 'margin_pct' ? c.pct : null, fixed_amount: c.basis === 'fixed' ? c.fixed : null,
    lead_member_id: c.leadMemberId || null, lead_share_pct: c.leadMemberId ? c.leadSharePct : 0 };
  return isNew ? { ...out, member_id: c.memberId || null } : out;
}
/** The firm's invoice details on team_branding (BP.Invoices.cleanProfile's shape). */
export const INVOICE_PROFILE_COLUMNS = 'company_name,billing_address,billing_email,billing_phone,tax_id,payment_details,invoice_prefix';
export function invoiceProfileFrom(r) {
  const x = r || {};
  return { companyName: str(x.company_name), address: str(x.billing_address), email: str(x.billing_email), phone: str(x.billing_phone), taxId: str(x.tax_id),
    paymentDetails: str(x.payment_details), prefix: x.invoice_prefix === null || x.invoice_prefix === undefined ? 'INV-' : str(x.invoice_prefix) };
}
export function invoiceProfileTo(p) {
  return { company_name: nul(p.companyName), billing_address: nul(p.address), billing_email: nul(p.email), billing_phone: nul(p.phone), tax_id: nul(p.taxId),
    payment_details: nul(p.paymentDetails), invoice_prefix: p.prefix === undefined ? 'INV-' : String(p.prefix || '') };
}
/** A team_guard_catches_by row: how often the guard warned one person on one day. */
export function guardCatchFrom(r) {
  return { day: str(r.day), userId: r.user_id || '', warned: Number(r.warned) || 0 };
}
export function activityFrom(r) {
  return { id: String(r.id), at: day(r.created_at), actor: r.actor || '', action: str(r.entity) + '_' + str(r.action), entity: str(r.entity), entityId: r.entity_id || '', note: '' };
}
/** An activity_log row for the audit screen: the full timestamp and only the whitelisted before/after fields (js/audit-lib.js). */
const AUDIT_SAFE = ['status', 'stage', 'tier', 'rtr_status', 'do_not_contact', 'source', 'role', 'changed'];
const pickAudit = (o) => (o && typeof o === 'object' ? Object.fromEntries(AUDIT_SAFE.filter((k) => k in o).map((k) => [k, o[k]])) : null);
export function auditFrom(r) {
  return { id: String(r.id), at: str(r.created_at), actor: r.actor || '', action: str(r.action), entity: str(r.entity), entityId: r.entity_id || '', before: pickAudit(r.before), after: pickAudit(r.after) };
}
/** The PostgREST query for one audit page. f = { actorId, entities: [..]|null, fromTs, toTs, limit, offset }. */
export function auditQuery(f) {
  const q = f || {};
  const ts = (t) => encodeURIComponent('"' + t + '"');
  const range = [q.fromTs ? 'created_at.gte.' + ts(q.fromTs) : '', q.toTs ? 'created_at.lt.' + ts(q.toTs) : ''].filter(Boolean);
  return query({
    select: 'id,actor,action,entity,entity_id,before,after,created_at',
    actor: q.actorId ? eq(q.actorId) : (Array.isArray(q.actorIds) ? 'in.(' + q.actorIds.map(encodeURIComponent).join(',') + ')' : ''),
    entity: q.entities && q.entities.length ? 'in.(' + q.entities.map(encodeURIComponent).join(',') + ')' : '',
    and: range.length ? '(' + range.join(',') + ')' : '',
    order: 'created_at.desc,id.desc',
    limit: Number(q.limit) || 51,
    offset: Number(q.offset) || ''
  });
}
// ── Agency desks (migration 0036): team_desks + team_desk_members -> [{id, name, office, memberIds}] ──
export function desksFrom(desks, seats) {
  const by = new Map();
  for (const s of seats || []) { if (!by.has(s.desk_id)) by.set(s.desk_id, []); by.get(s.desk_id).push(s.user_id); }
  return (desks || []).map((d) => ({ id: d.id, name: str(d.name), office: str(d.office), memberIds: by.get(d.id) || [] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function memberFrom(m) {
  return { id: m.user_id, name: nameFromEmail(m.email), email: str(m.email), role: m.role, joinedOn: day(m.joined_at) };
}
/** A former member (0043 `members` -> former): a display name only, for "who added this". removedAt marks them as not active. */
export function formerMemberFrom(f) {
  return { id: f.user_id, name: str(f.name) || 'Former member', email: '', role: 'recruiter', joinedOn: '', removedAt: day(f.removed_at) || 'removed' };
}
export function inviteFrom(i) {
  // sentAt (0040): the last time the link was emailed (full timestamp), for the resend wait. '' from an older server.
  // expired (0040): listed for 30 days after the expiry so it can be resent or cancelled; it holds no seat.
  return { id: i.id, email: str(i.email), role: i.role, expiresOn: day(i.expires_at), sentAt: str(i.sent_at), expired: i.expired === true };
}
/** `me` with no team (0040): { name, reason: removed|left|closed, endedOn, wasOwner } or null. */
export function lastTeamFrom(t) {
  if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.name) return null;
  return { name: t.name, reason: ['removed', 'left', 'closed'].includes(t.ended_reason) ? t.ended_reason : 'removed', endedOn: day(t.ended_at), wasOwner: t.role === 'owner' };
}

// ── screen objects -> columns (only what the form controls; team_id is added by the store) ──
export function consultantTo(row, uid, today, isNew) {
  const out = {
    name: String(row.name || '').trim(), title: nul(row.title), skills: arr(row.skills), visa: nul(row.visa), tax_terms: nul(row.taxTerms),
    rate: nul(row.rate), location: nul(row.location), relocation: Boolean(row.relocation), available_on: nul(row.availableOn),
    status: row.status || 'marketing', owner_recruiter: nul(row.ownerRecruiterId) || uid
  };
  // Staffing P1 (0045): sent only when the form has the fields, so an older caller never clears them.
  if (row.visaType !== undefined) out.visa_type = nul(row.visaType);
  if (row.workAuthUntil !== undefined) out.work_auth_until = nul(row.workAuthUntil);
  if (row.rateMin !== undefined) out.rate_min = cleanRateMin(row.rateMin);
  if (row.rateUnit !== undefined || row.rateMin !== undefined) out.rate_unit = normalizeRateUnit(row.rateUnit);
  // Staffing P5 (0049): sent only when the caller has the consent fields (row.consentOn defined), so older callers never clear them.
  if (row.consentOn !== undefined) {
    const k = cleanConsent(row);
    out.consent_on = nul(k.consentOn); out.consent_source = nul(k.consentSource); out.consent_note = nul(k.consentNote);
  }
  if (isNew) out.bench_since = nul(row.benchSince) || today;
  // Agency desks (0036): sent only when the form has a desk field, so a server without the column (or a plan without desks) is untouched.
  if (row.deskId !== undefined) out.desk_id = nul(row.deskId);
  return out;
}
export function vendorTo(row, tierFields) {
  const domain = String(row.domain || '').trim().toLowerCase();
  const out = { name: String(row.name || '').trim(), domain: domain || null, notes: nul(row.notes) };
  if (tierFields) {
    const tier = row.tier === 'unrated' || !row.tier ? null : row.tier;
    out.tier = tier;
    out.avoid_reason = tier === 'avoid' ? nul(row.avoidReason) : null;
    out.do_not_contact = Boolean(row.doNotContact);
  }
  return out;
}
export function contactTo(row) {
  return {
    company_id: nul(row.companyId), name: String(row.name || '').trim(), email: String(row.email || '').trim().toLowerCase(),
    phone: nul(row.phone), title: nul(row.title), do_not_contact: Boolean(row.doNotContact)
  };
}
/** requirements.source (0011 + 0037): 'inbox' = a team-inbox email, 'board' = one job of a job-board alert (with source_board). */
export const REQ_SOURCES = ['extension', 'paste', 'import', 'inbox', 'board'];
/** source_board (0037): the ids of lib/jobboard-mail.js. */
export const JOB_BOARDS = ['dice', 'indeed', 'linkedin', 'ziprecruiter', 'monster', 'careerbuilder'];
/** { source, sourceBoard } as the 0037 check takes them: a board only with source 'board' (an unknown board is kept as 'inbox'); anything
 *  else the server does not know ('manual' from the form) is 'paste'. */
export function requirementSource(row) {
  const src = REQ_SOURCES.includes(row && row.source) ? row.source : 'paste';
  if (src !== 'board') return { source: src, sourceBoard: '' };
  const b = String((row && row.sourceBoard) || '').toLowerCase();
  return JOB_BOARDS.includes(b) ? { source: 'board', sourceBoard: b } : { source: 'inbox', sourceBoard: '' };
}
export function requirementTo(row) {
  const { source, sourceBoard } = requirementSource(row);
  return {
    title: String(row.title || '').trim(), end_client: nul(row.endClient), job_ref: nul(row.jobRef), vendor_company_id: nul(row.vendorCompanyId), vendor_contact_id: nul(row.vendorContactId),
    rate_text: nul(row.rateText), work_mode: nul(row.workMode), location: nul(row.location), visa_text: nul(row.visaText), tax_terms: nul(row.taxTerms),
    duration: nul(row.duration), skills: arr(row.skills), source, source_board: sourceBoard || null, source_url: nul(row.sourceUrl), posted_on: nul(row.postedOn),
    raw_text: String(row.rawText || '').slice(0, 20000) || null, status: row.status === 'closed' ? 'closed' : 'open',
    ...requirementTagsTo(row)
  };
}

// ── team inbox (docs/specs/TEAM_INBOX_SPEC.md section 5, "API for the web app") ──
// The list reads `preview` (the first 1,000 characters, a generated column), never the full text: 200 cards stay about 200 KB.
// The full text (`body_text`, up to 20 KB) is fetched for one message at a time: "Open the email", "Add to requirements", the Gmail card.
export const INBOX_MESSAGE_COLUMNS = 'id,address_id,from_email,from_name,subject,received_at,created_at,preview,truncated,kind,status,requirement_id,handled_by,handled_at';
export const INBOX_FULL_COLUMNS = INBOX_MESSAGE_COLUMNS + ',body_text';
/** Cards per page, newest arrival (created_at) first; "Load more" fetches the next page. */
export const INBOX_PAGE = 200;
export const INBOX_ADDRESS_COLUMNS = 'id,token,label,created_at,disabled_at,message_count,last_message_at,dropped_count,last_dropped_at';
export const INBOX_LIMIT = 'Your plan has no free inbox address. Turn one off first, or move to a larger plan.';
export const INBOX_STATUSES = ['new', 'added', 'ignored'];
export const INBOX_MARK_MAX = 100;
/** The jobs of one job-board alert (0037 inbox_message_items; lib/jobboard-mail.js MAX_ITEMS): indexes 0..99. */
export const INBOX_ITEM_MAX = 100;
export const INBOX_ITEM_STATUSES = ['added', 'ignored', 'new'];

/** Read a field by its column name or by its camelCase name (the demo keeps camelCase rows). */
const pick = (r, snake) => {
  if (r[snake] !== undefined) return r[snake];
  return r[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
};
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : 0);

/** A message row. `full` says whether bodyText holds the whole stored text (else it is '' and only `preview` is there). */
export function inboxMessageFrom(r) {
  const at = str(pick(r, 'received_at'));
  const body = pick(r, 'body_text');
  return {
    id: r.id, addressId: str(pick(r, 'address_id')), fromEmail: str(pick(r, 'from_email')), fromName: str(pick(r, 'from_name')),
    subject: str(r.subject), receivedAt: at, receivedOn: day(at), createdAt: str(pick(r, 'created_at')),
    preview: str(pick(r, 'preview')), bodyText: str(body), full: body !== undefined && body !== null, truncated: pick(r, 'truncated') === true,
    kind: pick(r, 'kind') === 'forwarding_confirmation' ? 'forwarding_confirmation' : 'mail',
    status: INBOX_STATUSES.includes(r.status) ? r.status : 'new', requirementId: str(pick(r, 'requirement_id')),
    handledBy: str(pick(r, 'handled_by')), handledAt: str(pick(r, 'handled_at'))
  };
}
export function inboxAddressFrom(r) {
  return {
    id: r.id, token: str(r.token), label: str(r.label), createdAt: str(pick(r, 'created_at')), createdOn: day(pick(r, 'created_at')), disabledOn: day(pick(r, 'disabled_at')),
    active: !pick(r, 'disabled_at'), messageCount: num(pick(r, 'message_count')), lastMessageOn: day(pick(r, 'last_message_at')),
    droppedCount: num(pick(r, 'dropped_count')), lastDroppedOn: day(pick(r, 'last_dropped_at'))
  };
}
/** `me` -> { domain, limit, used, newCount }. Read from the `team` object, or from the top of the reply. */
export function inboxInfoFrom(reply) {
  const rep = reply && typeof reply === 'object' ? reply : {};
  const t = rep.team && typeof rep.team === 'object' ? rep.team : {};
  const box = (t.inbox && typeof t.inbox === 'object' ? t.inbox : null) || (rep.inbox && typeof rep.inbox === 'object' ? rep.inbox : {});
  const domain = t.inbox_domain !== undefined ? t.inbox_domain : rep.inbox_domain;
  // `me` sends team.inbox = null when the numbers could not be read: that is "unavailable", not "your plan has no inbox address".
  const unavailable = Boolean(rep.team) && !(t.inbox && typeof t.inbox === 'object') && !(rep.inbox && typeof rep.inbox === 'object');
  return { domain: domain ? String(domain) : null, limit: num(box.limit), used: num(box.used), newCount: num(box.new_count), ...(unavailable ? { unavailable: true } : {}) };
}
/** The inbox numbers when they could not be loaded at all (app.js): shown as an error, never as a plan without an inbox. */
export function inboxInfoUnavailable() { return { domain: null, limit: 0, used: 0, newCount: 0, unavailable: true }; }
/**
 * Ids of the active addresses beyond the plan limit ("Paused: over your plan's limit"). The server (bp_inbox_ingest) stores mail only
 * for the first `limit` active addresses, oldest first (created_at, then id); this is the same order.
 */
export function pausedInboxAddresses(addresses, limit) {
  const active = (addresses || []).filter((a) => a.active)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
  return new Set(active.slice(Math.max(0, Number(limit) || 0)).map((a) => a.id));
}

/**
 * The PostgREST query of one page of the Inbox list: one status (and kind), newest arrival first, keyset-paged by (created_at, id)
 * so new mail arriving while someone scrolls never shifts or repeats a page.
 * @param {{status?:string, kind?:string, before?:{createdAt:string,id:string}|null, limit?:number}} f
 */
export function inboxListQuery(f) {
  const q = f || {};
  const b = q.before && q.before.createdAt && q.before.id ? q.before : null;
  const ts = b ? encodeURIComponent('"' + b.createdAt + '"') : '';
  return query({
    select: INBOX_MESSAGE_COLUMNS,
    status: q.status ? eq(q.status) : '',
    kind: q.kind ? eq(q.kind) : '',
    or: b ? '(created_at.lt.' + ts + ',and(created_at.eq.' + ts + ',id.lt.' + encodeURIComponent(b.id) + '))' : '',
    order: 'created_at.desc,id.desc',
    limit: Math.min(Math.max(Number(q.limit) || INBOX_PAGE, 1), INBOX_PAGE + 1)
  });
}

/** The `inbox-mark` body; refuses what the server would refuse. */
export function inboxMarkBody(ids, status, requirementId) {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String))];
  if (!list.length) throw new StoreError('invalid', 'Pick at least one email.');
  if (list.length > INBOX_MARK_MAX) throw new StoreError('invalid', 'At most ' + INBOX_MARK_MAX + ' emails at a time.');
  if (!INBOX_STATUSES.includes(status)) throw new StoreError('invalid', 'Unknown inbox status.');
  const body = { message_ids: list, status };
  if (requirementId) {
    if (status !== 'added' || list.length !== 1) throw new StoreError('invalid', 'A requirement can be linked to one added email only.');
    body.requirement_id = String(requirementId);
  }
  return body;
}

/** The `inbox-item-mark` body; refuses what the server would refuse. */
export function inboxItemMarkBody(messageId, items, status) {
  const list = [...new Set((Array.isArray(items) ? items : [items]).filter((x) => x !== null && x !== undefined))];
  if (!messageId) throw new StoreError('invalid', 'Pick an email.');
  if (!list.length) throw new StoreError('invalid', 'Pick at least one job.');
  if (list.length > INBOX_ITEM_MAX || !list.every((x) => Number.isInteger(x) && x >= 0 && x < INBOX_ITEM_MAX)) throw new StoreError('invalid', 'At most ' + INBOX_ITEM_MAX + ' jobs at a time.');
  if (!INBOX_ITEM_STATUSES.includes(status)) throw new StoreError('invalid', 'Unknown job status.');
  return { message_id: String(messageId), items: list, status };
}
/** A row of inbox_message_items (or the Solo inbox-items answer) -> { index, status }; anything else is dropped. */
export function inboxItemsFrom(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({ index: Number(pick(r, 'item_index') ?? r.index), status: r.status }))
    .filter((x) => Number.isInteger(x.index) && x.index >= 0 && x.index < INBOX_ITEM_MAX && (x.status === 'added' || x.status === 'ignored'));
}

// ── PostgREST filter helpers ─────────────────────────────────────────────
export const eq = (v) => 'eq.' + encodeURIComponent(String(v));
export function query(params) {
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => k + '=' + v).join('&');
}

// ── team templates, branding, sender profile (migration 0028) ─────────────
export const TEMPLATE_LIMIT = 'A team can keep 40 templates. Delete one first.';
export const TEMPLATE_COLUMNS = 'id,kind,name,subject,body,position,seed_key,updated_at';
export function templateFrom(r) {
  return { id: r.id, kind: str(r.kind), name: str(r.name), subject: str(r.subject), body: str(r.body), position: Number(r.position) || 0, seedKey: str(r.seed_key), updatedAt: str(r.updated_at) };
}
/** A cleaned template (templates.js cleanTemplate) -> columns. seed_key only for a default being saved for the first time. */
export function templateTo(t, seedKey) {
  return { kind: t.kind, name: t.name, subject: t.subject || '', body: t.body, position: Number(t.position) || 0, ...(seedKey ? { seed_key: seedKey } : {}) };
}
export function brandingFrom(r) { return { companyName: str(r && r.company_name), website: str(r && r.website) }; }
export function brandingTo(b) { return { company_name: nul(b.companyName), website: nul(b.website) }; }
export function senderFrom(r) { return { senderName: str(r && r.sender_name), jobTitle: str(r && r.job_title), phone: str(r && r.phone) }; }
export function senderTo(s) { return { sender_name: nul(s.senderName), job_title: nul(s.jobTitle), phone: nul(s.phone) }; }

// ── errors ───────────────────────────────────────────────────────────────
const cap = (s) => { const t = String(s || '').trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.') : ''; };

/** 5xx codes from the team function whose own message is shown: email_failed (502) and mail_not_configured (503) say what happened to
 *  the invite. Every other 5xx gets the generic line. */
export const KEEP_SERVER_MESSAGE = ['email_failed', 'mail_not_configured'];

/**
 * True when a failed call says the caller is no longer in the team: the team function's no_team, or Postgres 42501 (an RLS refusal,
 * e.g. after being removed). The store then forgets its cached team.
 */
export function membershipGone(status, json) {
  const j = json && typeof json === 'object' ? json : {};
  const teamErr = j.error && typeof j.error === 'object' ? j.error : null;
  return Boolean((teamErr && teamErr.code === 'no_team') || j.code === '42501');
}

/**
 * Turn a failed response into a StoreError with a friendly message.
 * @param {number} status HTTP status
 * @param {object|null} json parsed body ({code,message,details} from PostgREST, or {error:{code,message}} from the team function)
 * @param {{team?:boolean}} [opts]
 */
export function explain(status, json, opts) {
  const o = opts || {};
  const j = json && typeof json === 'object' ? json : {};
  const teamErr = j.error && typeof j.error === 'object' ? j.error : null;
  const pgCode = typeof j.code === 'string' ? j.code : '';
  const msg = String(teamErr ? teamErr.message : j.message || '');

  if (status === 401) return new StoreError('session_expired', SESSION_EXPIRED, 401);
  // A server-side failure whose message the person must read (the invite was not sent; whether the earlier one still works).
  if (teamErr && KEEP_SERVER_MESSAGE.includes(teamErr.code) && teamErr.message) return new StoreError(String(teamErr.code), String(teamErr.message), status);
  if (teamErr && status < 500) return new StoreError(String(teamErr.code || 'failed'), String(teamErr.message || 'That did not go through.'), status);
  if (status === 429) return new StoreError('rate_limited', 'Too many requests. Please wait a moment and try again.', status);
  if (status >= 500) return new StoreError('server', 'Something went wrong on our side. Please try again.', status);
  if (/team_read_only/.test(msg)) return new StoreError('read_only', READ_ONLY, status);   // the 0016 write gate on the book tables
  if (/starter_consultant_cap/.test(msg)) return new StoreError('plan_limit', CONSULTANT_CAP_NOTE, status);   // 0038: Team · 5 bench cap
  // 0027 saved lists and 0052 targets on a plan without them (42501 would otherwise read as a role problem); wording: plan-gate PLAN_HINTS
  if (/smart_lists_plan/.test(msg)) return new StoreError('plan', PLAN_HINTS.smart_lists_plan, status);
  if (/targets_plan/.test(msg)) return new StoreError('plan', PLAN_HINTS.targets_plan, status);
  if (/template_limit/.test(msg)) return new StoreError('limit', TEMPLATE_LIMIT, status);   // 0028: at most 40 templates per team
  // 0036 Agency desks: the plan gate, the 50-desk cap and the seat rule (active members only)
  if (/desks_plan/.test(msg)) return new StoreError('plan', PLAN_HINTS.desks_plan, status);
  if (/desks_full/.test(msg)) return new StoreError('limit', 'A team keeps at most 50 desks. Delete one first.', status);
  if (/desk_not_member/.test(msg)) return new StoreError('invalid', 'Only active members of the team can sit on a desk.', status);
  // 0046: pay rate above the bill rate (either table), and the RTR end date before its day
  if (/pay_above_bill/.test(msg)) return new StoreError('invalid', 'The pay rate is above the bill rate. Raise the bill rate or lower the pay rate.', status);
  if (/submissions_rtr_until_check/.test(msg)) return new StoreError('invalid', 'The RTR end date is before the day it was given. Check the dates.', status);
  // 0049: an erased consultant is read-only and takes no new submission or note; a note must point at a record of the team
  if (/consultant_erased/.test(msg)) return new StoreError('erased', ERASED_READ_ONLY, status);
  if (/contact_note_entity_not_found/.test(msg)) return new StoreError('not_found', 'That record is no longer in your workspace. Refresh the page.', status);
  // 0055: timesheets, invoices and commission rules
  if (/invoicing_plan/.test(msg)) return new StoreError('plan', 'Timesheets, invoices and commission come with Team · 15.', status);
  if (/timesheet_invoiced/.test(msg)) return new StoreError('locked', 'This week is on an invoice. Remove the invoice first to change the hours.', status);
  if (/invoice_locked/.test(msg)) return new StoreError('locked', 'An invoice keeps its hours, rates and number. Remove it and make it again from the timesheets.', status);
  if (/invoice_link/.test(msg)) return new StoreError('forbidden', 'Invoices are made from the Invoices screen.', status);
  if (/week_outside_placement/.test(msg)) return new StoreError('invalid', 'That week is outside the placement dates.', status);
  if (/placement_timesheets_week_key/.test(msg + ' ' + String(j.details || ''))) return new StoreError('duplicate', 'There is already a timesheet for that week. Edit that one.', status);
  if (/placement_timesheets_approved_check/.test(msg)) return new StoreError('invalid', 'Add who approved the hours, and some hours.', status);
  if (/commission_rules_member_key/.test(msg + ' ' + String(j.details || ''))) return new StoreError('duplicate', 'There is already a rule for that person. Change that one.', status);
  if (/team_branding_billing_check/.test(msg)) return new StoreError('invalid', 'Check the invoice details: the billing email must be an address and the prefix has no spaces.', status);
  if (pgCode === '23503' && /invoices_placement_fk/.test(msg + ' ' + String(j.details || ''))) {
    return new StoreError('linked', 'This placement has invoices. Remove them first, or set the placement to Ended instead.', status);
  }
  if (status === 403 || pgCode === '42501') {
    if (/^only an owner or manager/i.test(msg)) return new StoreError('forbidden', cap(msg), status);
    return new StoreError('forbidden', 'Your role cannot do that.', status);
  }
  // 23503 comes back as HTTP 409 too, so it is read before the duplicate check below.
  if (pgCode === '23503' && /submissions_consultant_fk/.test(msg + ' ' + String(j.details || ''))) {
    return new StoreError('linked', 'This consultant has submissions, so they cannot be deleted. Set their status to Inactive instead.', status);
  }
  if (pgCode === '23503') return new StoreError('linked', 'That record is linked to another one that no longer exists. Refresh and try again.', status);
  if (status === 409 || pgCode === '23505') {
    const text = msg + ' ' + String(j.details || '');
    if (/vendor_companies_team_domain_key/.test(text)) return new StoreError('duplicate', 'A company with that domain is already in your vendor book.', status);
    if (/team_desks_team_name_key/.test(text)) return new StoreError('duplicate', 'A desk with that name already exists.', status);
    if (/vendor_contacts_team_email_key/.test(text)) return new StoreError('duplicate', 'A contact with that email is already in your vendor book.', status);
    return new StoreError('duplicate', 'That is already in your workspace.', status);
  }
  if (pgCode === '23514' || pgCode === '22001' || pgCode === '22P02' || pgCode === '22007') return new StoreError('invalid', 'One of the values is too long or not allowed. Check the fields and try again.', status);
  if (status === 404) return new StoreError('not_found', 'That was not found.', status);
  return new StoreError('failed', 'That did not go through. Please try again.', status);
}
