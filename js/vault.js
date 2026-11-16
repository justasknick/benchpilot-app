// webapp/js/vault.js - the Solo personal book in the web app (docs/specs/SOLO_WEB_WORKSPACE_SPEC.md sections 3 to 5).
// Reads the encrypted sync vault the extension uploads, decrypts it in this tab only, and writes the safe edits back exactly like the extension's
// background/sync.js pushOne (expected_version + key_id, AAD bound to the new version, pull-and-retry on a version conflict).
//
// Rules this file keeps:
//   - The data key and the decrypted book live only in this closure (memory). Never localStorage / sessionStorage / IndexedDB / URL / logs.
//   - They are dropped on lock(): sign-out, page hide, 30 minutes idle, key_changed, no_keys, another account. The raw key bytes are zeroed.
//   - Passphrases and recovery codes are passed straight to the extension's lib/sync-crypto.js and never kept or put in a message.
//   - A data set this tab could not decrypt (or a replayed row) is never written. Every write is decrypted again here before it is sent.
// Every dependency is injected, so node tests run it with the real sync-crypto.js / sync-merge.js and a fake server.

export const IDLE_MS = 30 * 60 * 1000;
const MAX_RETRIES = 2;

/** Web-app wording on top of the extension's MESSAGES (background/sync.js BPSyncShared.MESSAGES). */
export const WEB_MESSAGES = {
  no_keys: 'Sync is not set up on this account yet. Turn it on in the extension: Settings > Sync across computers.',
  idle: 'Locked after 30 minutes without activity. Enter your sync passphrase to open your book again.',
  other_account: "You signed in with a different account. Enter that account's sync passphrase.",
  signed_out: 'Locked.',
  retry_exhausted: 'Your book changed on another computer. Reload and try again.',
  verify_failed: 'That change could not be checked, so nothing was saved. Please try again.',
  invalid_snapshot: 'That change would not be readable by the extension, so nothing was saved.',
  unreadable: 'This list could not be read here, so it cannot be changed.',
  empty_passphrase: 'Enter your sync passphrase.',
  exists: 'Already in your book.',
  inbox_stale: 'Your inbox key was made with sync keys that were replaced. Replace your inbox address to start again.',
  inbox_tab_stale: 'Your sync keys were replaced on another computer. Lock your book and unlock it again (re-enter your passphrase) to read your inbox.',
  inbox_key_mismatch: "Your inbox key on the server does not match your own key. Mail can't be trusted; replace your inbox address.",
  // My book v2: resume downloads and change passphrase
  blob_missing: "This file is not on the server any more. It may have been deleted on another computer.",
  blob_pending: "This file is still being uploaded from another computer. Try again in a few minutes.",
  blob_failed: "This file could not be read here, so nothing was downloaded. Try again later.",
  weak_passphrase: "Choose a stronger passphrase.",
  // Sync on by default (docs/specs/ENCRYPTED_SYNC_SPEC.md section 10): keys without a passphrase, key check / proof, device pairing
  no_passphrase: 'This account has no sync passphrase. Use your recovery code, or approve from your extension.',
  wrong_key: 'Your book key could not be confirmed, so nothing was changed. Lock your book and open it again.',
  pair_expired: 'The request expired. Start again.',
  pair_cancelled: 'The request was declined on your other computer.',
  pair_limit: 'Too many requests. Wait a few minutes and try again.',
  pair_state: 'That request is no longer valid. Start again.'
};

/** A pairing request lives 10 minutes on the server (section 10.5); this tab never waits longer, whatever the server says. */
export const PAIR_TTL_MS = 10 * 60 * 1000;

export class VaultError extends Error {
  constructor(code, message) { super(message); this.name = 'VaultError'; this.code = code; }
}

/**
 * @param deps {
 *   api(body) -> Promise<json>   POST /functions/v1/sync; rejects with an error carrying .code (store.syncCall)
 *   crypto   the extension's BPSyncCrypto,  merge  the extension's BPSyncMerge,  messages  the extension's sync MESSAGES
 *   datasets string[]            the data sets to read (book-model.js BOOK_DATASETS)
 *   now?() -> ms, deviceId? string, idleMs?, setTimer?(fn, ms) -> handle, clearTimer?(handle), onLock?(code)  (an open book was locked)
 * }
 */
export function createVault(deps) {
  const { api, crypto, merge, datasets } = deps;
  const now = deps.now || (() => Date.now());
  const idleMs = deps.idleMs || IDLE_MS;
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((h) => clearTimeout(h));
  const onLock = deps.onLock || (() => {});
  const MESSAGES = { ...(deps.messages || {}), ...WEB_MESSAGES };
  // One device id per tab ("web-" + 12 random bytes), the same alphabet the server accepts for device_id.
  const deviceId = deps.deviceId || ('web-' + crypto.b64e(globalThis.crypto.getRandomValues(new Uint8Array(12))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));

  const fail = (code, message) => new VaultError(code, message || MESSAGES[code] || 'That did not work. Please try again.');
  const codeOf = (e) => (e && e.code) || 'internal';

  // ── private state: never exposed, never stored ──
  let key = null;            // Uint8Array(32) while open
  let keyId = '';
  let inboxKey = null;       // the Solo inbox private key { wrapped, keyId, priv: CryptoKey that cannot be exported } while open; dropped with the key
  let data = new Map();      // dataset -> { version, snap } | { unreadable: code }
  let seen = { keyId: '', v: {} };   // highest version seen per data set and key generation (replay check), this tab only
  let idleTimer = null;
  let hasPass = false;       // the key row had a passphrase wrapping when this tab opened the book (Add vs Change passphrase)
  // The pending pairing request (section 10.5), this tab only: { id, privateKey (a CryptoKey that cannot be exported), pub, nonce, expiresAt, approverPub,
  // approverNonce, code }. The private key and the nonce are never exposed or stored; the whole object is dropped on done, cancel, expiry or error.
  let pair = null;
  const state = { status: 'unknown', uid: '', notice: null, totalBytes: 0 };

  const publicState = () => ({ status: state.status, notice: state.notice, totalBytes: state.totalBytes });
  const set = (patch) => { Object.assign(state, patch); };
  const notice = (code) => (code ? { code, message: MESSAGES[code] || '' } : null);

  function wipe() {
    if (key) key.fill(0);
    key = null;
    inboxKey = null;
    keyId = '';
    data = new Map();
    conflictList = [];
    conflictSeen = new Set();
    hasPass = false;
    pair = null;
    if (idleTimer !== null) { clearTimer(idleTimer); idleTimer = null; }
  }

  /** Drop the key and the decrypted book. code: why (shown on the unlock form), or null. */
  function lock(code) {
    const wasOpen = Boolean(key);
    wipe();
    if (state.status === 'open' || wasOpen) { set({ status: 'locked', notice: notice(code) }); if (wasOpen) onLock(code); }
    else if (code && state.status === 'locked') set({ notice: notice(code) });
  }

  /** Sign-out: everything goes, including whose vault this was. */
  function signOut() {
    wipe();
    seen = { keyId: '', v: {} };
    set({ status: 'unknown', uid: '', notice: null, totalBytes: 0 });
  }

  /** Any key press, click or scroll in the page: restarts the 30-minute idle timer while open. */
  function touch() {
    if (!key) return;
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = setTimer(() => { idleTimer = null; lock('idle'); }, idleMs);
  }

  async function call(body) {
    try { return await api(body); } catch (e) {
      const code = codeOf(e);
      if (code === 'key_changed') { lock('key_changed'); throw fail('key_changed'); }
      if (code === 'no_keys') { wipe(); set({ status: 'no_keys', notice: null }); throw fail('no_keys'); }
      if (code === 'plan_required') { wipe(); set({ status: 'plan', notice: null }); throw fail('plan_required'); }
      throw e;
    }
  }

  /**
   * Which state to show for the signed-in account `uid`, from one `list` call (no key needed, nothing decrypted).
   * A different account than before wipes everything first.
   */
  async function check(uid) {
    if (state.uid && uid !== state.uid) {
      const had = state.status === 'open' || state.status === 'locked';
      wipe();
      seen = { keyId: '', v: {} };
      state.notice = had ? notice('other_account') : null;
    }
    state.uid = uid;
    if (key && state.status === 'open') return publicState();
    const keep = state.notice;
    set({ status: 'checking' });
    try {
      const list = await call({ action: 'list' });
      if (list.has_keys !== true) { set({ status: 'no_keys', notice: null }); return publicState(); }
      set({ status: 'locked', notice: keep });
    } catch (e) {
      if (['plan_required', 'no_keys'].includes(codeOf(e))) return publicState();
      set({ status: 'error', notice: { code: codeOf(e), message: e.message || MESSAGES[codeOf(e)] || 'Something went wrong. Please try again.' } });
    }
    return publicState();
  }

  /**
   * Unlock with { passphrase } or { recoveryCode }, then read every data set. Throws VaultError (wrong_passphrase, wrong_recovery_code,
   * no_passphrase: the account has none; invalid_keys: the unwrapped key failed the key check; ...).
   */
  async function unlock({ passphrase, recoveryCode } = {}) {
    if (!recoveryCode && !String(passphrase || '')) throw fail('empty_passphrase');
    const keys = await call({ action: 'get-keys' });     // always fresh: names the current key generation
    const r = recoveryCode ? await crypto.unlockWithRecovery(recoveryCode, keys) : await crypto.unlockWithPassphrase(passphrase, keys);
    if (!r.ok) throw fail(r.reason);
    return adopt(r.dataKeyRaw, r.keyId, keys);
  }

  /**
   * The one way a data key becomes this tab's key (unlock and pairing). The key was already checked against `keys`, the fresh get-keys it came
   * with. Wipes whatever was open (a pending pairing request too), restarts the replay record on a new generation, opens the book, reads it.
   */
  async function adopt(raw, kid, keys) {
    wipe();
    key = raw;
    keyId = kid;
    hasPass = crypto.hasPassphrase(keys);
    if (seen.keyId !== keyId) seen = { keyId, v: {} };   // a new generation restarts the replay record
    set({ status: 'open', notice: null });
    touch();
    // Section 10.8 (0054): a key row made by 0044 gets its signing key on the first unlock, once (its static proof then authorises nothing).
    // Best effort: Change passphrase does it again if this did not get through.
    if (crypto.needsSignUpgrade(keys)) { try { await call(await crypto.signUpgradeBody(raw, keys)); } catch (_) { /* retried on the next signed action */ } }
    try { await load(); } catch (e) { if (key) lock(null); throw e; }
    return publicState();
  }

  // ── device pairing as the NEW device (section 10.5): "Approve from your extension" ──
  // pair-create (public key + commitment) -> the extension responds -> pair-reveal (our nonce, only now) -> both screens show the same code -> the
  // user approves on the extension -> pair-take (the data key wrapped for our ECDH key, once) -> key check against a fresh get-keys -> adopt().

  const PAIR_ERRORS = ['pair_expired', 'pair_state', 'pair_limit', 'pair_cancelled'];
  const b64Size = (v) => { try { return typeof v === 'string' ? crypto.b64d(v).length : -1; } catch (_) { return -1; } };
  const validPub = (v) => b64Size(v) === 65 && crypto.b64d(v)[0] === 4;
  const validNonce = (v) => b64Size(v) === 16;

  /** A server error during pairing: drop the request (except a network blip while polling) and give the error to show. */
  function pairFail(e, keepOnNetwork) {
    const code = codeOf(e);
    if (!(keepOnNetwork && code === 'network')) pair = null;
    if (e instanceof VaultError) return e;
    if (code === 'not_found') return fail('pair_state');
    return PAIR_ERRORS.includes(code) ? fail(code) : e;
  }

  /** Sends a new request. label: what the extension shows ("Web app (Chrome, Windows)"). Returns { id, expiresAt }. */
  async function pairStart(label) {
    if (key) throw fail('pair_state');
    if (pair) await pairCancel();
    const k = await crypto.pairStart();
    let r;
    try { r = await call({ action: 'pair-create', new_pub: k.pub, commit: k.commit, label: String(label || 'Web app').slice(0, 40) }); } catch (e) { throw pairFail(e); }
    if (!r || !crypto.validPairId(r.id)) throw fail('pair_state');
    const t = now();
    const at = Date.parse(r.expires_at);
    const expiresAt = Math.min(Number.isFinite(at) ? at : t + PAIR_TTL_MS, t + PAIR_TTL_MS);
    pair = { id: r.id, privateKey: k.privateKey, pub: k.pub, nonce: k.nonce, expiresAt, approverPub: '', approverNonce: '', code: '' };
    return { id: r.id, expiresAt };
  }

  /** The pending request as the screen may show it: { id, expiresAt, code } (code '' until the extension answered), or null. */
  function pairInfo() { return pair ? { id: pair.id, expiresAt: pair.expiresAt, code: pair.code } : null; }

  /**
   * One poll (the screen calls it every 3 seconds). Returns { status: 'waiting' } | { status: 'code', code } | { status: 'open' } (book open).
   * Throws VaultError pair_expired / pair_cancelled / pair_state / invalid_keys / ...; the request is then dropped (a network error keeps it).
   */
  // opts.confirmed (review M3): the user ticked "I approved in my extension and typed this code there". An approved request is taken only then;
  // until then the poll answers { status: 'approved', code } and keeps the request.
  async function pairStep(opts) {
    const p = pair;
    if (!p) throw fail('pair_state');
    if (now() >= p.expiresAt) { pair = null; throw fail('pair_expired'); }
    let g;
    try { g = await call({ action: 'pair-get', id: p.id }); } catch (e) { throw pairFail(e, true); }
    if (pair !== p) throw fail('pair_state');                       // cancelled or replaced meanwhile
    const status = g && g.status;
    if (status === 'open') return { status: 'waiting' };
    if (status === 'cancelled') { pair = null; throw fail('pair_cancelled'); }
    if (status === 'expired') { pair = null; throw fail('pair_expired'); }
    if (status === 'responded' || status === 'revealed') {
      if (!p.code) {
        if (!validPub(g.approver_pub) || !validNonce(g.approver_nonce) || g.approver_pub === p.pub) { pair = null; throw fail('invalid_keys'); }
        p.approverPub = g.approver_pub;
        p.approverNonce = g.approver_nonce;
      } else if (g.approver_pub !== p.approverPub || g.approver_nonce !== p.approverNonce) { pair = null; throw fail('invalid_keys'); }
      if (status === 'responded') {
        // Our nonce goes out only now, after the extension's key and nonce are fixed (the commitment we sent first binds it).
        try { await call({ action: 'pair-reveal', id: p.id, new_nonce: p.nonce }); } catch (e) { throw pairFail(e, true); }
        if (pair !== p) throw fail('pair_state');
      }
      if (!p.code) p.code = await crypto.pairCode(p.id, { newPub: p.pub, approverPub: p.approverPub, newNonce: p.nonce, approverNonce: p.approverNonce });
      return { status: 'code', code: p.code };
    }
    // Re-review L-a: a confirmation counts only once the server says 'approved' (never recorded earlier, e.g. a box ticked too soon).
    if (status === 'approved' && p.code && opts && opts.confirmed === true) p.confirmed = true;
    if (status === 'approved' && p.code && !p.confirmed) return { status: 'approved', code: p.code };   // waits for the user's confirmation
    pair = null;                                                     // from here on the request is spent, whatever happens
    if (status === 'approved' && p.code) return pairTake(p);         // approved without the code ever shown here: refused
    throw fail('pair_state');                                        // 'done' (taken elsewhere) or anything unknown
  }

  async function pairTake(p) {
    let t;
    try { t = await call({ action: 'pair-take', id: p.id }); } catch (e) { throw pairFail(e); }
    // The approver key must be the one both codes were made with (the unwrap below is bound to it as well).
    if (!t || t.approver_pub !== p.approverPub || !crypto.validKeyId(t.key_id)) throw fail('invalid_keys');
    const keys = await call({ action: 'get-keys' });                 // fresh: the key must be the current generation's
    if (!keys || keys.key_id !== t.key_id || crypto.serverKeysProblem(keys)) throw fail('invalid_keys');
    let raw;
    try { raw = await crypto.pairUnwrap(p.privateKey, { id: p.id, keyId: t.key_id, newPub: p.pub, approverPub: p.approverPub }, t.wrapped); } catch (_) { throw fail('invalid_keys'); }
    // Only a key that matches the row's key check is used: 'absent' (an old row) is refused too, since nothing then vouches for this key.
    if ((await crypto.checkDataKey(raw, keys)) !== 'match') { raw.fill(0); throw fail('invalid_keys'); }
    if (key || pair) { raw.fill(0); throw fail('pair_state'); }      // opened another way, or a new request started meanwhile
    await adopt(raw, t.key_id, keys);
    return { status: 'open' };
  }

  /** Withdraws the pending request (the extension stops showing it) and forgets its private key. Never throws. */
  async function pairCancel() {
    const p = pair;
    pair = null;
    if (!p) return;
    try { await api({ action: 'pair-cancel', id: p.id }); } catch (_) { /* it expires on its own */ }
  }

  /** One row from the server -> its snapshot, or { unreadable } (wrong generation throws key_changed). */
  async function readRow(dataset, row) {
    if (row.key_id !== keyId) { lock('key_changed'); throw fail('key_changed'); }
    if (!Number.isInteger(row.version) || row.version < 1 || row.version < (seen.v[dataset] || 0)) return { unreadable: 'rolled_back' };
    let snap = null;
    try { snap = merge.cleanSnapshot(await crypto.decryptDataset(key, { keyId, dataset, version: row.version }, row), dataset); } catch (_) { snap = null; }
    if (!snap) return { unreadable: 'decrypt_failed' };
    if (!(seen.v[dataset] >= row.version)) seen.v[dataset] = row.version;
    return { version: row.version, snap };
  }

  /** Reads every book data set the server has (a fresh `list`, then `get` each). */
  async function load() {
    if (!key) throw fail('locked');
    const list = await call({ action: 'list' });
    if (list.has_keys !== true) { wipe(); set({ status: 'no_keys', notice: null }); throw fail('no_keys'); }
    if (list.key_id !== keyId) { lock('key_changed'); throw fail('key_changed'); }
    const rows = (Array.isArray(list.datasets) ? list.datasets : []).filter((d) => datasets.includes(d.dataset));
    const next = new Map();
    for (const d of rows) {
      const row = await call({ action: 'get', dataset: d.dataset });
      if (!key) throw fail('locked');
      next.set(d.dataset, await readRow(d.dataset, row));
    }
    if (!key) throw fail('locked');
    data = next;
    set({ status: 'open', totalBytes: Number(list.total_bytes) || 0, notice: [...next.values()].some((x) => x.unreadable) ? notice([...next.values()].find((x) => x.unreadable).unreadable) : null });
    return publicState();
  }

  /** 'ok' | 'empty' (nothing synced) | an unreadable code ('decrypt_failed', 'rolled_back'). */
  function datasetState(dataset) {
    const e = data.get(dataset);
    if (!e) return 'empty';
    return e.unreadable || 'ok';
  }

  /** [{ id, r, u }] of the live records of a data set, most recently changed first. Copies, so the screen cannot change the vault. */
  function rows(dataset) {
    const e = data.get(dataset);
    if (!key || !e || !e.snap) return [];
    return Object.entries(e.snap.records).filter(([, x]) => !x.x && x.r).map(([id, x]) => ({ id, r: structuredCloneSafe(x.r), u: x.u })).sort((a, b) => b.u - a.u);
  }

  /**
   * One safe edit (spec section 4). model = book-model.js createBookModel(BP). Returns the saved record.
   * Throws VaultError / Error with a message to show; nothing is written unless every check passed.
   */
  async function edit(dataset, id, rawPatch, model) {
    if (!key) throw fail('locked');
    touch();
    const patch = model.cleanEdit(dataset, rawPatch);
    // A conflict (spec "Conflicts"): the other computer changed one of the fields this edit sets, within a minute of it.
    const touched = (a, b) => Object.keys(patch).some((k) => merge.stable(a[k]) !== merge.stable(b[k]));
    return write(dataset, id, false, (snap, t) => model.applyEdit(snap, dataset, id, patch, { nowMs: t, deviceId, hashRecord: merge.hashRecord }), { touched });
  }

  /**
   * Adds one record from an Add form (model.newRecord: the extension's own shapes, duplicate checks and limits), through write().
   * Returns { id, record, guard } (guard: the duplicate guard's SOFT warning text, or '').
   */
  async function create(dataset, input, model) {
    if (!key) throw fail('locked');
    touch();
    if (!model.canAdd(dataset)) throw new Error('Records cannot be added to this list in the web app.');
    let made = null;
    const ctx = (t) => ({ nowMs: t, settings: settings(), submissions: rows('submissions').map((x) => x.r), consultants: rows('consultants').map((x) => x.r) });
    const record = await write(dataset, () => made.id, true, (snap, t) => {
      made = model.newRecord(dataset, input, snap, ctx(t));
      return model.applyAdd(snap, dataset, made.id, made.record, { nowMs: t, deviceId });
    });
    return { id: made.id, record, guard: made.guard || '' };
  }

  /** Deletes one record: a tombstone the extension's merge takes (model.applyDelete). Nothing else in the data set changes. */
  async function remove(dataset, id, model) {
    if (!key) throw fail('locked');
    touch();
    if (!model.canDelete(dataset)) throw new Error('Records cannot be deleted from this list in the web app.');
    await write(dataset, id, false, (snap, t) => model.applyDelete(snap, dataset, id, { nowMs: t, deviceId }));
    for (const c of conflictList.filter((x) => x.dataset === dataset && x.id === id)) conflictList.splice(conflictList.indexOf(c), 1);
    return true;
  }

  // ── conflicts (the extension's Settings > Sync "Changed on two computers" panel, background/sync.js recordConflicts / resolveConflict) ──
  // The extension keeps its own list on each computer (chrome.storage.local, not synced). This tab lists the conflicts IT sees: an edit here
  // that met a newer version from another computer, changed in the same fields less than a minute apart (lib/sync-merge.js
  // CONFLICT_WINDOW_MS). This tab's version is kept (it is the newer one) and the other is kept here, in memory only, until the user picks.
  // Asked once per pair (dataset|id|hash of the other version), at most 50, dropped on lock with the key.
  const MAX_CONFLICTS = 50;
  let conflictList = [];
  let conflictSeen = new Set();

  function noteConflict(dataset, id, base, fresh, touched, t) {
    if (!base || !fresh || base.x || fresh.x || !base.r || !fresh.r) return;
    if (fresh.d === deviceId || Math.abs(t - fresh.u) >= merge.CONFLICT_WINDOW_MS) return;
    if (merge.hashRecord(base.r) === merge.hashRecord(fresh.r)) return;
    if (touched && !touched(base.r, fresh.r)) return;
    const ds = merge.DATASETS[dataset];
    const k = `${dataset}|${id}|${merge.hashRecord(fresh.r)}`;
    if (conflictSeen.has(k)) return;
    conflictSeen.add(k);
    conflictList.push({ key: k, dataset, id, label: String((ds && ds.label(fresh.r, id)) || id).slice(0, 80), kept: 'local', record: structuredCloneSafe(fresh.r), at: t });
    conflictList = conflictList.slice(-MAX_CONFLICTS);
  }

  /** [{ key, dataset, id, label, kept, at }] (the other version itself stays inside the vault). */
  function conflicts() {
    if (!key) return [];
    return conflictList.map(({ key: k, dataset, id, label, kept, at }) => ({ key: k, dataset, id, label, kept, at }));
  }

  /** action 'keep-other': the other version becomes the current one (a normal edit, so it syncs). 'dismiss': forget it. */
  async function resolveConflict(k, action, model) {
    if (!key) throw fail('locked');
    touch();
    const c = conflictList.find((x) => x.key === k);
    if (!c) return { ok: true };
    if (action === 'keep-other') {
      try {
        await write(c.dataset, c.id, false, (snap, t) => model.applyReplace(snap, c.dataset, c.id, structuredCloneSafe(c.record), { nowMs: t, deviceId, hashRecord: merge.hashRecord }));
      } catch (e) { if (e.code !== 'unchanged') throw e; }
    }
    conflictList = conflictList.filter((x) => x.key !== k);
    return { ok: true };
  }

  /** The synced settings the web app reads ({ homework, followUpDays, ... }), as plain values. */
  function settings() {
    const out = {};
    for (const x of rows('settings')) out[x.id] = x.r;
    return out;
  }

  /**
   * Change or add a passphrase (the extension's Settings > Sync, the same server action and rules). Re-wraps the SAME data key
   * (rewrapForNewPassphrase: same key_id, recovery wrapping untouched) and sends `update-keys` with a signed single-use challenge (section 10.8:
   * only a holder of the data key can open the signing key; the server keeps only its public key). The verifier authorises nothing. Nothing is
   * re-encrypted; the book stays open; the other computers keep working (same key).
   *   - The account has a passphrase: the current passphrase or the recovery code is proved on this computer first and must give this key.
   *   - It has none (sync made the keys without one): the open book's key, checked at unlock, is enough; only the new passphrase is asked.
   * The new one is checked with the extension's passphraseProblem (account email included). Secrets are never kept or put in a message.
   */
  async function changePassphrase({ current, recoveryCode, next } = {}, email) {
    if (!key) throw fail('locked');
    touch();
    const keys = await call({ action: 'get-keys' });
    if (keys.key_id !== keyId) { lock('key_changed'); throw fail('key_changed'); }
    const adding = !crypto.hasPassphrase(keys);
    let r = null;
    if (!adding) {
      if (!recoveryCode && !String(current || '')) throw fail('empty_passphrase');
      r = recoveryCode ? await crypto.unlockWithRecovery(recoveryCode, keys) : await crypto.unlockWithPassphrase(current, keys);
      if (!r.ok) throw fail(r.reason);
    }
    try {
      if (r && (r.keyId !== keyId || !equalBytes(r.dataKeyRaw, key))) { lock('key_changed'); throw fail('key_changed'); }
      const problem = crypto.passphraseProblem(next, { email: String(email || '') });
      if (problem) throw fail('weak_passphrase', problem);
      const { key_id: _sameKeyId, ...passphrase } = await crypto.rewrapForNewPassphrase(key, next, keys);   // same data key, so the same key_id
      // Section 10.8 (0054): a single-use server challenge signed with this generation's signing key (opened with the book's key in this tab);
      // a 0044 key row gets its signing key first, once. The server holds only the public key.
      try {
        await call(await crypto.authorize(key, keys, 'update-keys', { key_id: keyId, passphrase }, call));
      } catch (e) {
        const c = codeOf(e);
        if (c === 'key_changed') { lock('key_changed'); throw fail('key_changed'); }
        throw c === 'wrong_key' || c === 'bad_challenge' || c === 'sign_upgrade_required' ? fail('wrong_key') : e;
      }
      hasPass = true;
    } finally { if (r) r.dataKeyRaw.fill(0); }
    return { ok: true };
  }

  /**
   * One synced resume file, decrypted in this tab (phase 2 blobs, docs/specs/ENCRYPTED_SYNC_SPEC.md section 9): `blob-get` for a 60-second
   * signed link, the extension's own lib/sync-blob-read.js for the link check, the bounded read, the file-key unwrap, the decryption and the
   * SHA-256 check. Returns { bytes, fileName, type }; nothing is stored (the screen hands the bytes to the browser's download and drops them).
   */
  async function resumeFile(id) {
    if (!key) throw fail('locked');
    touch();
    const { blobRead, http, storageBase } = deps;
    if (!blobRead || !http) throw fail('internal');
    const e = data.get('resumes');
    const x = e && e.snap ? e.snap.records[id] : null;
    const rec = x && !x.x ? x.r : null;
    if (!rec || !merge.validResumeIndexRecord(rec)) throw fail('blob_missing');
    let g;
    try { g = await call({ action: 'blob-get', blob_id: rec.blobId }); } catch (err) { if (codeOf(err) === 'not_found') throw fail('blob_missing'); throw err; }
    if (!g || g.version !== rec.v) throw fail('blob_pending');
    const url = blobRead.checkSignedUrl(storageBase, g.download_url, fail);
    let res;
    try { res = await http(url, { method: 'GET' }); } catch (_) { throw fail('network'); }
    if (!res || !res.ok) throw fail('blob_failed');
    const sealed = await blobRead.readLimited(res, rec.size + crypto.BLOB_OVERHEAD, fail);
    if (!key) throw fail('locked');
    let bytes;
    try { bytes = await blobRead.openBlob(crypto, { key, keyId }, rec, sealed, fail); } catch (err) { throw err && err.code === 'blob_failed' ? err : fail('blob_failed'); }
    return { bytes, fileName: rec.fileName, type: rec.type };
  }

  /**
   * Adds one new record (the Solo inbox's "Add to my book", docs/specs/SOLO_INBOX_SPEC.md section 7) through the same safe write path as edit():
   * cleanSnapshot check, seal, decrypt-check, put with expected_version, re-read and re-apply on a version conflict. A data set nothing was
   * synced to yet starts empty (expected_version 0). Throws { code:'exists' } when the record is already in the book (never overwritten).
   */
  async function add(dataset, id, record, model) {
    if (!key) throw fail('locked');
    touch();
    return write(dataset, id, true, (snap, t) => model.applyAdd(snap, dataset, id, record, { nowMs: t, deviceId }));
  }

  /**
   * id: the record id, or a function giving it after build() ran (a new record's id is made inside build). opts.touched(base, fresh): for an
   * edit, whether the other computer changed a field this write sets (then it is listed under conflicts when within the conflict window).
   * Returns the written record, or null for a deletion.
   */
  async function write(dataset, id, allowNew, build, opts) {
    const idOf = () => (typeof id === 'function' ? id() : id);
    let base = null;                // the record as this tab first saw it (conflict check after a 409)
    let conflict = null;
    for (let attempt = 0; ; attempt++) {
      let entry = data.get(dataset);
      if (!entry && allowNew) entry = { version: 0, snap: { v: 1, records: {} } };
      if (!entry || !entry.snap) throw fail('unreadable');
      const t = now();
      const next = build(entry.snap, t);
      if (attempt === 0 && typeof id !== 'function') base = entry.snap.records[id] || null;
      // What every extension will read: the snapshot must come through the extension's own untrusted-input check unchanged.
      if (merge.stable(merge.cleanSnapshot(next, dataset)) !== merge.stable(next)) throw fail('invalid_snapshot');
      const bind = { keyId, dataset, version: entry.version + 1 };
      const sealed = await crypto.encryptDataset(key, bind, next);
      let back = null;
      try { back = await crypto.decryptDataset(key, bind, sealed); } catch (_) { back = null; }
      if (!back || merge.stable(back) !== merge.stable(next)) throw fail('verify_failed');
      try {
        const r = await call({ action: 'put', dataset, expected_version: entry.version, iv: sealed.iv, ciphertext: sealed.ciphertext, device_id: deviceId, key_id: keyId });
        if (!key) throw fail('locked');
        const version = Number.isInteger(r && r.version) ? r.version : entry.version + 1;
        data.set(dataset, { version, snap: next });
        if (!(seen.v[dataset] >= version)) seen.v[dataset] = version;
        if (conflict) noteConflict(dataset, idOf(), conflict.base, conflict.fresh, opts && opts.touched, t);
        const out = next.records[idOf()];
        return out && out.r ? structuredCloneSafe(out.r) : null;
      } catch (e) {
        if (codeOf(e) !== 'version_conflict') throw e;
        if (attempt >= MAX_RETRIES) throw fail('retry_exhausted');
        // The extension pushed first: read the newer row, then re-apply the same field patch to it (its other changes are kept).
        let row;
        try { row = await call({ action: 'get', dataset }); } catch (ge) {
          if (codeOf(ge) !== 'not_found') throw ge;
          row = null;                                    // still nothing synced: start from empty again
        }
        if (!key) throw fail('locked');
        if (!row) { data.delete(dataset); continue; }
        const fresh = await readRow(dataset, row);
        data.set(dataset, fresh);
        if (fresh.unreadable) throw fail(fresh.unreadable);
        if (base) conflict = { base, fresh: fresh.snap.records[idOf()] || null };
      }
    }
  }

  // ── the Solo personal inbox key (docs/specs/SOLO_INBOX_SPEC.md section 4): wrapped with this data key; the raw data key never leaves here ──

  /** A new inbox key pair wrapped with the open data key: { publicKey, wrappedPrivateKey, keyId }. */
  async function newInboxKeys() {
    if (!key) throw fail('locked');
    if (!deps.inboxCrypto) throw fail('internal');
    touch();
    return deps.inboxCrypto.createInboxKeys(key, keyId);
  }

  /**
   * The inbox private key from its wrapping (cached while open), checked against the server's public key.
   * Throws, when the wrapping names another key generation than this tab's:
   *   inbox_tab_stale  the server's current sync key_id (syncKeyId) is not this tab's either: the keys were replaced elsewhere; lock and unlock;
   *   inbox_stale      the server's sync keys are this tab's: the server's inbox key is of an old generation; replace the address.
   * And inbox_key_mismatch when the wrapping does not open with this (verified) data key for this public key, or the private key is not the
   * public key's: the public key or the wrapping was changed on the server.
   */
  async function openInboxKey(wrapped, wrapKeyId, publicKey, syncKeyId) {
    if (!key) throw fail('locked');
    if (wrapKeyId !== keyId) throw fail(syncKeyId && syncKeyId !== keyId ? 'inbox_tab_stale' : 'inbox_stale');
    if (inboxKey && inboxKey.wrapped === wrapped && inboxKey.keyId === keyId && inboxKey.publicKey === publicKey) return inboxKey.priv;
    let priv;
    try { priv = await deps.inboxCrypto.unwrapInboxKey(key, keyId, wrapped, publicKey); } catch (_) { throw fail('inbox_key_mismatch'); }
    if (!key) throw fail('locked');
    inboxKey = { wrapped, keyId, publicKey, priv };
    return priv;
  }

  return { check, unlock, load, lock, signOut, touch, rows, datasetState, edit, add, create, remove, conflicts, resolveConflict, settings,
    changePassphrase, resumeFile, newInboxKeys, openInboxKey, currentKeyId: () => (key ? keyId : ''),
    pairStart, pairStep, pairCancel, pairInfo, hasPassphrase: () => Boolean(key) && hasPass,
    getState: publicState, isOpen: () => Boolean(key), deviceId, MESSAGES };
}

function structuredCloneSafe(v) { return JSON.parse(JSON.stringify(v)); }
function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
