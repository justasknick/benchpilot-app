// webapp/js/inbox-lib.js - the team inbox rules (docs/specs/TEAM_INBOX_SPEC.md sections 2 and 6). Pure: no DOM, no network.
//   * the address, the Gmail confirmation code and its link (allow-listed: https Google hosts only);
//   * the requirement fields of an email (the extension's own parser, the same one as "Paste a requirement");
//   * "Add to requirements": claim the email first (`inbox-mark added`; only the person who gets its id back goes on), fetch the
//     full text, then the vendor contact (link one that exists, or create it) and the requirement through the store's own
//     saveVendor / saveContact / saveRequirement, then `inbox-attach` links the requirement. A failed save puts the email back to New;
//   * job-board alerts (Dice, Indeed, LinkedIn Job Alerts, ZipRecruiter, Monster, CareerBuilder; backlog E16): the extension's
//     lib/jobboard-mail.js (BP.JobBoardMail) splits one alert into its jobs; "Add" / "Add all" save one requirement per job with the job's
//     link, through the same claim and saveRequirement path. The board's no-reply sender is never a contact;
//   * where a requirement came from (0037): an email's "Add to requirements" saves source 'inbox'; a job of an alert saves source 'board' with
//     its board (sourceBoard). Each job's Add / Ignore is kept on the server per job (inbox-item-mark: job index + status; 'added' is a claim
//     per job, so two teammates never save one job twice).

import { parsePastedRequirement } from './bp-lib.js';
import { companyDomain } from './import-book.js';
import { INBOX_MARK_MAX, StoreError } from './live-map.js';

/** The error "Add to requirements" throws when a teammate claimed the email first. */
export const INBOX_TAKEN = 'Already added by a teammate.';

/** The full address of a token, or '' while the domain is not configured. */
export function inboxAddress(token, domain) {
  return token && domain ? 'r-' + token + '@' + domain : '';
}

/** The text we have: the full text when it was fetched, else the list's preview (the first 1,000 characters). */
export function bodyOf(m) {
  return String((m && (m.full || m.bodyText) ? m.bodyText : (m && m.preview)) || '');
}

/** The plain text the parser reads: the subject (without Fwd:/Re:) on the first line, then the body (or the preview on a card). */
export function messageText(m) {
  const subject = String((m && m.subject) || '').replace(/^\s*(?:(?:fwd?|fw|re)\s*:\s*)+/i, '').trim();
  return (subject ? subject + '\n' : '') + bodyOf(m);
}

// ── the Gmail forwarding confirmation ───────────────────────────────────
// Gmail's forwarding confirmation links look like https://mail-settings.google.com/mail/vf-%5B...%5D-... (older mail:
// https://mail.google.com/mail/vf-...). Nothing else is offered as a button, even on another Google host.
const CONFIRM_HOSTS = new Set(['mail-settings.google.com', 'mail.google.com']);
const CONFIRM_PATH = '/mail/vf-';

/** The link as a clean https URL when it is a Gmail forwarding-confirmation link, else ''. */
export function safeConfirmLink(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return '';
  if (!CONFIRM_HOSTS.has(u.hostname.toLowerCase())) return '';
  if (!u.pathname.startsWith(CONFIRM_PATH)) return '';
  return u.href;
}

/** The first allowed confirm link in the text, or ''. */
export function findConfirmLink(text) {
  for (const m of String(text || '').matchAll(/https:\/\/[^\s<>"'()[\]]+/gi)) {
    const ok = safeConfirmLink(m[0].replace(/[.,;:!?]+$/, ''));
    if (ok) return ok;
  }
  return '';
}

/** The confirmation code ("Confirmation code: 123456789", or "(#123456789)" in the subject), or ''. */
export function confirmationCode(m) {
  const body = bodyOf(m);
  const a = /confirmation code\s*[:#]?\s*(\d{6,12})/i.exec(body);
  if (a) return a[1];
  const b = /\(#(\d{6,12})\)/.exec(String((m && m.subject) || ''));
  return b ? b[1] : '';
}

// ── requirement fields ──────────────────────────────────────────────────
/** The requirement form's fields from an email (empty when the text does not state them). */
export function requirementFields(BP, m, todayMs) {
  return parsePastedRequirement(BP, messageText(m), todayMs);
}

/** True when the extension's classifier reads the email as a requirement. Never true without the parser. */
export function looksLikeRequirement(BP, m) {
  if (!BP || typeof BP.classifyPost !== 'function' || !m || m.kind !== 'mail') return false;
  try { return BP.classifyPost({ text: messageText(m) }).type === 'requirement'; } catch (e) { return false; }
}

// ── the vendor contact ──────────────────────────────────────────────────
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]\d{4}\b/;
const NOT_A_PERSON = /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|notify|alerts?|forwarding-noreply)@/i;

/**
 * A mailbox no person reads (no-reply, alert mailboxes, the job boards' own domains): never a vendor contact. One rule, the extension's
 * BP.JobBoardMail.isMachineSender; the short list above is only used when the reader could not load (BP null).
 */
export function isMachineAddress(BP, email) {
  const e = String(email || '').toLowerCase();
  if (BP && BP.JobBoardMail && typeof BP.JobBoardMail.isMachineSender === 'function') return BP.JobBoardMail.isMachineSender(e) || NOT_A_PERSON.test(e);
  return NOT_A_PERSON.test(e);
}

function cleanName(name) {
  return String(name || '').replace(/\s+via\s+.+$/i, '').replace(/^["']+|["']+$/g, '').trim().slice(0, 80);
}
function nameOf(BP, email) {
  const fromBP = BP && typeof BP.nameFromEmail === 'function' ? BP.nameFromEmail(email) : '';
  if (fromBP) return fromBP;
  const local = String(email).split('@')[0].replace(/[._+-]+/g, ' ').replace(/\d+/g, '').trim();
  return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : '';
}

/**
 * Who sent the requirement: the sender, unless the sender is a group or a no-reply address; then the first person's email in
 * the text. Returns { email, name, phone } or null.
 */
export function contactFromMessage(BP, m, inboxDomain) {
  const own = (e) => {
    const d = (String(e).split('@')[1] || '').toLowerCase();
    return d === 'googlegroups.com' || (inboxDomain && d === String(inboxDomain).toLowerCase()) || isMachineAddress(BP, e);
  };
  const from = String((m && m.fromEmail) || '').trim().toLowerCase();
  const viaGroup = /\svia\s/i.test(String((m && m.fromName) || ''));
  const body = bodyOf(m);
  let email = '', name = '';
  if (from && !own(from) && !viaGroup) { email = from; name = cleanName(m.fromName); }
  else {
    const hit = (body.match(EMAIL_RE) || []).map((e) => e.toLowerCase()).find((e) => !own(e) && e !== from);
    if (!hit) return null;
    email = hit;
    if (viaGroup) name = cleanName(m.fromName);     // "Chloe W. via C2C Group": the person who posted
  }
  if (!name) name = nameOf(BP, email);
  if (!name) return null;
  // The phone: on the line that names the email, or the two lines around it (a signature).
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.toLowerCase().includes(email));
  let phone = '';
  if (at >= 0) {
    for (const l of [lines[at], lines[at + 1], lines[at - 1]]) {
      const p = l && PHONE_RE.exec(l);
      if (p) { phone = p[0].trim(); break; }
    }
  }
  return { email, name, phone };
}

function companyName(BP, domain) {
  const fromBP = BP && typeof BP.companyNameFromDomain === 'function' ? BP.companyNameFromDomain(domain) : '';
  if (fromBP) return fromBP;
  const brand = domain.split('.')[0] || domain;
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

/** A person from an address found in a job: { email, name, phone }, or null for a machine mailbox or one with no person's name (hr@). */
export function personFromEmail(BP, email, phone) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || isMachineAddress(BP, e)) return null;
  const name = nameOf(BP, e);
  return name ? { email: e, name, phone: String(phone || '') } : null;
}

/**
 * Link the email's vendor contact, creating the company and contact when they are new. A contact on a free-mail address
 * (gmail.com ...) with no company in the book is left out: a contact needs a company. `book` = { vendors, contacts } is
 * updated in place so "Add all" does not create the same company twice.
 * @returns {Promise<{vendorCompanyId:string, vendorContactId:string}>}
 */
export async function linkVendorContact(store, BP, m, book, inboxDomain) {
  return linkContact(store, BP, contactFromMessage(BP, m, inboxDomain), book);
}

/** linkVendorContact for a contact already found ({ email, name, phone } or null). */
export async function linkContact(store, BP, c, book) {
  if (!c) return { vendorCompanyId: '', vendorContactId: '' };
  const known = book.contacts.find((x) => String(x.email).toLowerCase() === c.email);
  if (known) return { vendorCompanyId: known.companyId || '', vendorContactId: known.id };
  const domain = companyDomain(c.email);
  if (!domain) return { vendorCompanyId: '', vendorContactId: '' };
  let vendor = book.vendors.find((v) => String(v.domain || '').toLowerCase() === domain);
  if (!vendor) {
    vendor = await store.saveVendor({ name: companyName(BP, domain), domain });
    book.vendors.push(vendor);
  }
  const contact = await store.saveContact({ companyId: vendor.id, name: c.name, email: c.email, phone: c.phone, source: 'manual' });
  book.contacts.push(contact);
  return { vendorCompanyId: vendor.id, vendorContactId: contact.id };
}

/**
 * "Add to requirements" for one email (spec section 5, "Add to requirements"):
 *   1. claim: `inbox-mark added` without a requirement. Only messages not yet added change, and the server returns their ids; when
 *      this id is not among them a teammate got there first: StoreError 'inbox_taken' (INBOX_TAKEN), nothing is created;
 *   2. the full text (the list only has the preview), the vendor contact, then the requirement (source "inbox", with the email text
 *      kept). If any of it fails the email goes back to New (`inbox-mark new`) and the error is thrown;
 *   3. `inbox-attach` links the requirement to the email. It is only a link: if it fails the requirement and the "added" status stay.
 * @param {{BP:object|null, book?:{vendors:object[], contacts:object[]}, inboxDomain?:string|null, todayMs?:number}} opts
 */
export async function addToRequirements(store, m, opts) {
  const o = opts || {};
  const claim = await store.markInbox([m.id], 'added');
  const mine = (claim && Array.isArray(claim.ids) ? claim.ids : []).some((id) => String(id).toLowerCase() === String(m.id).toLowerCase());
  if (!mine) throw new StoreError('inbox_taken', INBOX_TAKEN, 409);
  let requirement, link;
  try {
    const full = m.full ? m : await store.getInboxMessage(m.id);
    const book = o.book || { vendors: await store.listVendors(), contacts: await store.listContacts() };
    const fields = requirementFields(o.BP, full, o.todayMs || Date.now());
    if (!fields.title) fields.title = String(full.subject || '').trim().slice(0, 120) || 'Requirement from the inbox';
    link = await linkVendorContact(store, o.BP, full, book, o.inboxDomain);
    requirement = await store.saveRequirement({
      ...fields, ...link, source: 'inbox', rawText: messageText(full), postedOn: full.receivedOn || undefined
    });
  } catch (err) {
    try { await store.markInbox([m.id], 'new'); } catch (e) { /* the save error below is the one to show */ }
    throw err;
  }
  let attached = false;
  try { attached = (await store.attachInbox(m.id, requirement.id)).attached === true; } catch (e) { attached = false; }
  return { requirement, ...link, attached };
}

/** The new emails "Add all" would take: requirements by the parser (on the list's preview), at most INBOX_MARK_MAX. A job-board alert is
 *  not one requirement, so it is left to its own "Add all" (per job). */
export function addAllCandidates(BP, messages) {
  return (messages || []).filter((m) => m.status === 'new' && !boardSource(BP, m) && looksLikeRequirement(BP, m)).slice(0, INBOX_MARK_MAX);
}

/**
 * "Add all that look like requirements": addToRequirements for each candidate, one after the other (one shared book, so a company
 * is created once). An email a teammate claimed first is skipped and counted. Returns { added, taken }.
 */
export async function addAll(store, candidates, opts) {
  const o = opts || {};
  const book = o.book || { vendors: await store.listVendors(), contacts: await store.listContacts() };
  let added = 0, taken = 0;
  for (const m of candidates || []) {
    try { await addToRequirements(store, m, { ...o, book }); added += 1; }
    catch (err) { if (err && err.code === 'inbox_taken') taken += 1; else throw err; }
  }
  return { added, taken };
}

// ── job-board alerts (backlog E16) ──────────────────────────────────────
const boardMail = (m) => ({ fromEmail: (m && m.fromEmail) || '', fromName: (m && m.fromName) || '', subject: (m && m.subject) || '', text: bodyOf(m) });

/** { id, label } of the job board that sent the email (sender, forwarded "From:", subject, job links; the preview is enough), or null. */
export function boardSource(BP, m) {
  if (!BP || !BP.JobBoardMail || !m || m.kind !== 'mail') return null;
  try { return BP.JobBoardMail.detect(boardMail(m)); } catch (e) { return null; }
}

/** The alert's jobs, { source, items } (lib/jobboard-mail.js; read the full text, not the preview), or null. Each item carries its
 *  `index` in the alert: the key of its per-job state on the server (0037). */
export function boardJobs(BP, m, todayMs) {
  if (!BP || !BP.JobBoardMail || !m || m.kind !== 'mail') return null;
  let r;
  try { r = BP.JobBoardMail.parse(boardMail(m), { now: todayMs || Date.now() }); } catch (e) { return null; }
  return r ? { ...r, items: r.items.map((it, index) => ({ ...it, index })) } : null;
}

/** The requirement row of one job: the parser's fields, the job's link as the source URL, source 'board' with the board's id. */
export function requirementFromJob(item, source, m) {
  return {
    ...item.fields, title: item.title || item.fields.title, source: 'board', sourceBoard: (source && source.id) || '', sourceUrl: item.url || '',
    rawText: item.text, postedOn: item.postedOn || (m && m.receivedOn) || undefined
  };
}

const jobIndexes = (list) => list.map((it) => it.index);
function needIndexes(list) {
  if (!list.every((it) => Number.isInteger(it.index))) throw new StoreError('invalid', 'These jobs could not be read. Reload the inbox.');
}

/**
 * "Add" / "Add all" for the jobs of one job-board alert (team). The same race rule as addToRequirements: a new email is claimed first
 * (`inbox-mark added`; a teammate's claim stops it with INBOX_TAKEN before anything is saved). An email already added (by this card, or
 * one opened from Added) is not claimed again. Then each job is claimed (`inbox-item-mark added`, 0037): a job a teammate already added is
 * 'exists', as is a job whose link is already a requirement (it stays marked added). A job whose save fails is released (`new`). The email
 * stays added when at least one job is now added; when this call claimed it and none is, it goes back to New. The first saved requirement
 * is linked to the email.
 * @param items  jobs from boardJobs() (each with its `index`), at most INBOX_MARK_MAX are taken
 * @param opts   { BP, book?, source, claimed?: boolean (this card already holds the claim) }
 * @returns {Promise<{outcomes:string[], added:number, skipped:number, claimed:boolean, error:Error|null}>} outcomes[i]: 'added' | 'exists' | 'failed'
 */
export async function addBoardJobs(store, m, items, opts) {
  const o = opts || {};
  const list = (items || []).slice(0, INBOX_MARK_MAX);
  needIndexes(list);
  const claim = m.status === 'new' && !o.claimed;
  if (claim) {
    const r = await store.markInbox([m.id], 'added');
    const mine = (r && Array.isArray(r.ids) ? r.ids : []).some((id) => String(id).toLowerCase() === String(m.id).toLowerCase());
    if (!mine) throw new StoreError('inbox_taken', INBOX_TAKEN, 409);
  }
  const outcomes = list.map(() => 'failed');
  const saved = [];
  let held = new Set();
  let error = null;
  try {
    if (list.length) held = new Set((await store.markInboxItems(m.id, jobIndexes(list), 'added')).items);
    const book = o.book || { vendors: await store.listVendors(), contacts: await store.listContacts() };
    const have = new Set((await store.listRequirements({})).map((r) => String(r.sourceUrl || '').toLowerCase()).filter(Boolean));
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!held.has(it.index)) { outcomes[i] = 'exists'; continue; }      // a teammate (or this card) added it already
      const url = String(it.url || '').toLowerCase();
      if (url && have.has(url)) { outcomes[i] = 'exists'; continue; }
      const link = await linkContact(store, o.BP, it.contact ? personFromEmail(o.BP, it.contact.email, it.contact.phone) : null, book);
      saved.push(await store.saveRequirement({ ...requirementFromJob(it, o.source, m), ...link }));
      if (url) have.add(url);
      outcomes[i] = 'added';
    }
  } catch (err) { error = err; }
  const release = list.filter((it, i) => outcomes[i] === 'failed' && held.has(it.index)).map((it) => it.index);
  if (release.length) { try { await store.markInboxItems(m.id, release, 'new'); } catch (e) { /* the error below is the one to show */ } }
  const kept = list.some((it, i) => held.has(it.index) && outcomes[i] !== 'failed');
  if (claim && !kept) {
    try { await store.markInbox([m.id], 'new'); } catch (e) { /* the error below is the one to show */ }
    if (error) throw error;
  }
  if (claim && saved.length) { try { await store.attachInbox(m.id, saved[0].id); } catch (e) { /* only a link */ } }
  if (error && !saved.length) throw error;
  return { outcomes, added: saved.length, skipped: outcomes.filter((x) => x === 'exists').length, claimed: claim ? kept : Boolean(o.claimed), error };
}

/** The jobs' states for the card: index -> 'added' | 'ignored' (a job with no entry is still to do). */
export function itemStates(rows) {
  const out = new Map();
  for (const r of rows || []) if (Number.isInteger(r.index) && (r.status === 'added' || r.status === 'ignored')) out.set(r.index, r.status);
  return out;
}

/** "N added, M ignored, K left" for an alert of `total` jobs (states: index -> 'added' | 'ignored'). */
export function jobCounts(total, states) {
  let added = 0, ignored = 0;
  for (const [i, st] of states || []) {
    if (i >= total) continue;
    if (st === 'added') added += 1; else if (st === 'ignored') ignored += 1;
  }
  const left = Math.max(0, total - added - ignored);
  return { added, ignored, left, text: added + ' added, ' + ignored + ' ignored, ' + left + ' left' };
}
