// webapp/js/personal-inbox.js - the Solo personal inbox in "My book" (docs/specs/SOLO_INBOX_SPEC.md sections 2, 6 and 7). No DOM.
//   * the address card: inbox-get / inbox-create (the first time with a new key pair made by the vault) / inbox-disable;
//   * the list: heads decrypted in this tab with the extension's lib/inbox-crypto.js, the inbox private key opened by the vault (the raw data
//     key never leaves vault.js); the full text only when a message is opened or added;
//   * "Add to my book": claim (inbox-mark added) -> full text -> contact + parser fields -> vault.add('leads', ...) through My book's safe write
//     path; any failure puts the email back to New. Nothing read from an email is ever sent to the server: only ids and statuses;
//   * a job-board alert (backlog E16): its jobs (lib/jobboard-mail.js, read in this tab) go in one by one, each as the recruiter the job names,
//     with the board and the job's link. A job that names no recruiter email cannot be a recruiter in the book and is not added. Each job's
//     Add / Ignore is kept on the server as the job's index and status only (inbox-items / inbox-item-mark, 0037).
// Every dependency is injected (node tests run it with the real crypto, vault and merge code and a fake server).

import { contactFromMessage, requirementFields, looksLikeRequirement, boardSource, personFromEmail } from './inbox-lib.js';
import { companyDomain } from './import-book.js';
import { inboxItemsFrom, INBOX_ITEM_MAX } from './live-map.js';

export const PAGE = 200;
export const MARK_MAX = 100;

export class InboxError extends Error {
  constructor(code, message) { super(message); this.name = 'InboxError'; this.code = code; }
}

export const INBOX_MESSAGES = {
  taken: 'Already added (in another tab or on another computer).',
  no_contact: 'No recruiter email in this message, so it cannot be added as a recruiter.',
  exists: 'Already in your book.',
  not_set_up: 'The inbox address is not set up yet.',
  unreadable: 'This email could not be decrypted here.',
  job_no_contact: 'This job names no recruiter email, so it cannot go into your book as a recruiter. Open the job to find the recruiter.'
};

/** The full address, or '' while there is none, it is turned off, or the domain is not configured. */
export function personalAddress(info) {
  const a = info && info.address;
  return a && !a.disabled_at && /^[a-z0-9]{12}$/.test(String(a.token || '')) && info.domain ? `p-${a.token}@${info.domain}` : '';
}

/**
 * Whether this tab can open the inbox key: 'none' (no key yet), 'ok', 'tab_stale' (the server's sync keys are not this tab's: the keys were
 * replaced elsewhere; lock and unlock) or 'server_stale' (the server's sync keys are this tab's but the inbox key is of an older generation:
 * replace the address).
 */
export function keyState(info, vaultKeyId) {
  if (!info || !info.key) return 'none';
  if (info.sync_key_id && info.sync_key_id !== vaultKeyId) return 'tab_stale';
  return info.key.key_id === vaultKeyId ? 'ok' : 'server_stale';
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A decrypted head -> the card's message object (the same field names as the team inbox's, so inbox-lib.js reads it). */
export function messageFromHead(row, head) {
  const h = head && typeof head === 'object' ? head : {};
  const date = typeof h.date === 'string' && Number.isFinite(Date.parse(h.date)) ? h.date : row.received_at;
  return {
    id: row.id, addressId: row.address_id, status: row.status, receivedAt: row.received_at, size: Number(row.size) || 0,
    fromEmail: str(h.from_email, 254), fromName: str(h.from_name, 200), subject: str(h.subject, 500), date,
    receivedOn: String(date || '').slice(0, 10), kind: h.kind === 'forwarding_confirmation' ? 'forwarding_confirmation' : 'mail',
    truncated: h.truncated === true, preview: str(h.preview, 1000), bodyText: '', full: false, unreadable: false
  };
}

/**
 * @param deps { api(body) -> Promise<json> (store.syncCall), inboxCrypto (BPInboxCrypto), vault (vault.js createVault) }
 */
export function createPersonalInbox({ api, inboxCrypto, vault }) {
  let info = null;
  let badKey = false;   // the server's inbox key is not the user's own (inbox_key_mismatch): its mail is not trusted; Replace makes a new pair

  async function load() {
    info = await api({ action: 'inbox-get' });
    return info;
  }
  const getInfo = () => info;

  /**
   * Create (or with replace: true, replace) the address. The first time, the vault makes the key pair and wraps it with the data key. When the
   * server's inbox key did not match the user's own (keyBad), the replacement comes with a new key pair (rekey: the old key and its mail go).
   */
  async function create({ replace = false } = {}) {
    if (!info) await load();
    const keyId = vault.currentKeyId();
    if (!keyId) throw new InboxError('locked', 'Unlock your book first.');
    if (keyState(info, keyId) === 'tab_stale') throw new InboxError('inbox_tab_stale', vault.MESSAGES.inbox_tab_stale);
    const body = { action: 'inbox-create', key_id: keyId, replace: replace === true };
    if (!info.key || info.key.key_id !== keyId || badKey) {
      const k = await vault.newInboxKeys();
      body.public_key = k.publicKey;
      body.wrapped_private_key = k.wrappedPrivateKey;
      if (badKey && info.key && info.key.key_id === keyId) body.rekey = true;
    }
    await api(body);
    badKey = false;
    return load();
  }

  async function disable() {
    await api({ action: 'inbox-disable' });
    return load();
  }

  /** The inbox private key, opened by the vault and checked against the server's public key (vault.openInboxKey lists the errors). */
  async function privateKey() {
    if (!info) await load();
    if (!info.key) throw new InboxError('not_set_up', INBOX_MESSAGES.not_set_up);
    try {
      const priv = await vault.openInboxKey(info.key.wrapped_private_key, info.key.key_id, info.key.public_key, info.sync_key_id || null);
      badKey = false;
      return priv;
    } catch (e) {
      if (e && e.code === 'inbox_key_mismatch') badKey = true;
      throw e;
    }
  }

  /** One page of one status, newest arrival first: { messages, more, cursor }. A head that does not decrypt is shown as unreadable. */
  async function list(status, before) {
    const priv = await privateKey();
    const r = await api({ action: 'inbox-list', status, ...(before ? { before } : {}) });
    const rows = Array.isArray(r && r.messages) ? r.messages : [];
    const more = rows.length > PAGE;
    const page = rows.slice(0, PAGE);
    const out = [];
    for (const row of page) {
      let head = null;
      try { head = await inboxCrypto.openPart(priv, info.key.public_key, row, 'head'); } catch (_) { head = null; }
      const m = messageFromHead(row, head);
      if (!head) m.unreadable = true;
      out.push(m);
    }
    const last = page[page.length - 1];
    return { messages: out, more, cursor: more && last ? { received_at: last.received_at, id: last.id } : null };
  }

  /** The message with its full text (decrypted body). */
  async function full(m) {
    if (m.full) return m;
    const priv = await privateKey();
    const row = await api({ action: 'inbox-message', id: m.id });
    if (row.id !== m.id || row.address_id !== m.addressId) throw new InboxError('unreadable', INBOX_MESSAGES.unreadable);
    let body;
    try { body = await inboxCrypto.openPart(priv, info.key.public_key, row, 'body'); } catch (_) { throw new InboxError('unreadable', INBOX_MESSAGES.unreadable); }
    return { ...m, bodyText: typeof body.text === 'string' ? body.text : '', full: true };
  }

  async function mark(ids, status) {
    return api({ action: 'inbox-mark', ids: ids.slice(0, MARK_MAX), status });
  }

  /** The jobs handled in one alert: [{ index, status }] (status only; 0037). */
  async function items(m) {
    const r = await api({ action: 'inbox-items', id: m.id });
    return inboxItemsFrom(r && r.items);
  }

  /** Marks jobs of one alert ('added' is a claim per job: another tab may hold the same card). Returns { updated, items }. */
  async function markItems(m, indexes, status) {
    const list = [...new Set(indexes)].filter((x) => Number.isInteger(x) && x >= 0 && x < INBOX_ITEM_MAX);
    if (!list.length) return { updated: 0, items: [] };
    const r = await api({ action: 'inbox-item-mark', id: m.id, items: list, status });
    return { updated: Number(r && r.updated) || 0, items: Array.isArray(r && r.items) ? r.items.filter((x) => Number.isInteger(x)) : [] };
  }

  return { load, getInfo, create, disable, list, full, mark, items, markItems, checkKey: privateKey, keyBad: () => badKey, address: () => personalAddress(info) };
}

function companyNameOf(BP, email) {
  const domain = companyDomain(email);
  if (!domain) return '';
  const fromBP = BP && typeof BP.companyNameFromDomain === 'function' ? BP.companyNameFromDomain(domain) : '';
  if (fromBP) return fromBP;
  const brand = domain.split('.')[0] || domain;
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

/**
 * "Add to my book" for one email (spec section 7). Returns { lead, existed }. Throws InboxError 'taken' when the claim was lost, 'no_contact'
 * when no recruiter email can be found; any other failure is thrown after the email is put back to New.
 * @param ctx { inbox, vault, model (book-model.js), BP (the parser's BP, may be null), inboxDomain, nowMs }
 */
export async function addToMyBook(ctx, m) {
  const { inbox, vault, model, BP } = ctx;
  const claim = await inbox.mark([m.id], 'added');
  const mine = (claim && Array.isArray(claim.ids) ? claim.ids : []).some((id) => String(id).toLowerCase() === String(m.id).toLowerCase());
  if (!mine) throw new InboxError('taken', INBOX_MESSAGES.taken);
  try {
    const f = await inbox.full(m);
    const contact = contactFromMessage(BP, f, ctx.inboxDomain);
    if (!contact) throw new InboxError('no_contact', INBOX_MESSAGES.no_contact);
    const nowMs = ctx.nowMs || Date.now();
    const fields = requirementFields(BP, f, nowMs);
    const lead = model.leadFromInbox(contact, fields, { subject: f.subject, companyName: companyNameOf(BP, contact.email), nowMs });
    try {
      return { lead: await vault.add('leads', lead.email, lead, model), existed: false };
    } catch (err) {
      if (err && err.code === 'exists') return { lead, existed: true };   // the recruiter is already in the book: nothing overwritten
      throw err;
    }
  } catch (err) {
    try { await inbox.mark([m.id], 'new'); } catch (_) { /* the error below is the one to show */ }
    throw err;
  }
}

/** The new, readable emails that look like requirements (the extension's classifier), at most MARK_MAX. Job-board alerts have their own
 *  per-job "Add all". */
export function addAllCandidates(BP, messages) {
  return (messages || []).filter((m) => m.status === 'new' && !m.unreadable && !boardSource(BP, m) && looksLikeRequirement(BP, m)).slice(0, MARK_MAX);
}

/**
 * "Add" / "Add all" for the jobs of one job-board alert (Solo). Claimed first like addToMyBook (a new email only, once per card); then each
 * job that names a recruiter is claimed (inbox-item-mark added, 0037: another tab may hold the same card; a job already added there is
 * 'exists') and becomes a lead through vault.add (the safe write path), with the board and the job's link; a recruiter already in the book is
 * never overwritten ('exists', the job stays marked added); a job with no recruiter email is 'no_contact' and is not claimed. A job whose
 * save fails is released. The email stays added when at least one job is now added; when this call claimed it and none is, it goes back to New.
 * @param ctx  { inbox, vault, model, BP, nowMs }
 * @param opts { source: { label }, claimed?: boolean }
 * @returns {Promise<{outcomes:string[], added:number, claimed:boolean, error:Error|null}>} outcomes[i]: 'added' | 'exists' | 'no_contact' | 'failed'
 */
export async function addBoardJobsToMyBook(ctx, m, items, opts) {
  const { inbox, vault, model, BP } = ctx;
  const o = opts || {};
  const list = (items || []).slice(0, MARK_MAX);
  if (!list.every((it) => Number.isInteger(it.index))) throw new InboxError('unreadable', INBOX_MESSAGES.unreadable);
  const claim = m.status === 'new' && !o.claimed;
  if (claim) {
    const r = await inbox.mark([m.id], 'added');
    const mine = (r && Array.isArray(r.ids) ? r.ids : []).some((id) => String(id).toLowerCase() === String(m.id).toLowerCase());
    if (!mine) throw new InboxError('taken', INBOX_MESSAGES.taken);
  }
  const people = list.map((it) => (it.contact ? personFromEmail(BP, it.contact.email, it.contact.phone) : null));
  const outcomes = list.map((it, i) => (people[i] ? 'failed' : 'no_contact'));
  let held = new Set();
  let added = 0;
  let error = null;
  const nowMs = ctx.nowMs || Date.now();
  try {
    const want = list.filter((it, i) => people[i]).map((it) => it.index);
    if (want.length) held = new Set((await inbox.markItems(m, want, 'added')).items);
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const person = people[i];
      if (!person) continue;
      if (!held.has(it.index)) { outcomes[i] = 'exists'; continue; }
      const lead = model.leadFromInbox(person, it.fields, {
        subject: m.subject, companyName: it.company || companyNameOf(BP, person.email), nowMs, board: o.source && o.source.label, sourceUrl: it.url
      });
      try { await vault.add('leads', lead.email, lead, model); outcomes[i] = 'added'; added += 1; }
      catch (err) { if (err && err.code === 'exists') outcomes[i] = 'exists'; else throw err; }
    }
  } catch (err) { error = err; }
  const release = list.filter((it, i) => outcomes[i] === 'failed' && held.has(it.index)).map((it) => it.index);
  if (release.length) { try { await inbox.markItems(m, release, 'new'); } catch (_) { /* the error below is the one to show */ } }
  const kept = list.some((it, i) => held.has(it.index) && (outcomes[i] === 'added' || outcomes[i] === 'exists'));
  if (claim && !kept) {
    try { await inbox.mark([m.id], 'new'); } catch (_) { /* the error below is the one to show */ }
  }
  if (error && !added) throw error;
  return { outcomes, added, claimed: claim ? kept : Boolean(o.claimed), error };
}
