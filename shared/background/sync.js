// background/sync.js - Encrypted sync: turn on/off, unlock, push and pull. Loaded by service-worker.js via importScripts.
// Exposes self.BPSyncFactory(deps) (testable in node: every browser API comes in through deps) and, in the worker, self.BPSync.
// Design: docs/specs/ENCRYPTED_SYNC_SPEC.md ("Key design (as built)"). Crypto: lib/sync-crypto.js. Merge rules: lib/sync-merge.js.
//
// Rules this file keeps:
//   - With sync off, or while the key is not in storage.session, NOTHING touches the network.
//   - The data key lives only in chrome.storage.session (memory, cleared when the browser closes). Never in storage.local, never sent.
//   - Plaintext never leaves this file's callers: data goes through BPSyncCrypto.encryptDataset before any request; passphrases and recovery
//     codes are never stored, logged or put in an error message.
//   - A data set that cannot be decrypted is never overwritten by a push.
//   - Every write names the key generation (key_id) this computer holds; the server refuses any other. When the server's key_id is not ours
//     (sync was set up again elsewhere) the key is dropped and nothing is pushed until the passphrase is entered again; when the server has no
//     keys (sync was turned off elsewhere) sync is turned off here too. Local data is never touched by either.
//   - Local data belongs to the account it last synced with (bpSyncDataOwner). Another account turning sync on or unlocking here gets nothing
//     pulled or pushed until it chooses: "Upload" (this computer's data goes into its vault) or "Start empty" (needs a backup made in the last
//     30 minutes; the synced data sets are cleared on this computer, then its vault is pulled). See spec section 9, "Another account on this computer".
//   - A pulled row older than the highest version this computer has seen for that data set and key generation is refused (no snapshot replay).
//   - Push at most every 2 minutes (alarm), pull every 10 minutes (alarm) and on turn-on / unlock / browser start.
//   - An erased consultant never comes back (schema 20, spec section 10.9): the grow-only `erased` list is pulled first, every merge and every
//     push drops what names an erased consultant, and after the pulls BP.Consent.applyErasures cleans this computer (records, notes, résumé
//     files, anonymised submissions), so even a computer offline for longer than the 30 days a tombstone lives cannot resurrect the person.
(function (root) {
  'use strict';

  const STATE_KEY = 'bpSyncState';          // storage.local: { enabled, uid, deviceId, keyId, versions, seen, pushedHash, lastSyncedAt, lastPushAt, error, paused, totalBytes, progress, conflictsSeen }
  const OWNER_KEY = 'bpSyncDataOwner';      // storage.local: { uid } the account the synced data on this computer last synced with. Kept by "turn off" (the data stays)
  const META_KEY = 'bpSyncMeta';            // storage.local: { <dataset>: { <id>: { h, u, d } | { x, u, d } } }
  const CONFLICTS_KEY = 'bpSyncConflicts';  // storage.local: [{ key, dataset, id, label, kept, record, at }]
  const KEY_SESSION = 'bpSyncKey';          // storage.session only: base64 data key
  const KEY_ID_SESSION = 'bpSyncKeyId';     // storage.session only: the key generation id of that data key (not secret; kept beside it)
  const PENDING_SESSION = 'bpSyncPending';  // storage.session only: keys made by "prepare", waiting for "I've saved my recovery code"
  const ROTATE_SESSION = 'bpSyncRotate';    // storage.session only: new keys made by "Replace my keys", waiting for "I've saved my new recovery code"
  const PUSH_ALARM = 'bp-sync-push';
  const PULL_ALARM = 'bp-sync-pull';
  const PUSH_EVERY_MIN = 2;
  const PULL_EVERY_MIN = 10;
  const MIN_PUSH_GAP_MS = 110 * 1000;
  const STALE_PULL_MS = 15 * 60 * 1000;     // a push-only run this long after the last pull pulls first (section 10.9)
  const SYNC_TIERS = ['solo', 'pro'];       // tiers with features.sync in BP.TIERS; mirrors SYNC_PLANS in supabase/functions/_shared/plans.js (the server decides; this only avoids useless calls)
  const ROW_CAP_BYTES = 5 * 1024 * 1024;
  const MAX_CONFLICTS = 50;
  const MAX_SEEN = 200;
  const BACKUP_FRESH_MS = 30 * 60 * 1000;   // "Start empty" needs a backup made this recently (lastBackupAt, set by Settings > Backup)
  const DATA_CHOICES = ['upload', 'empty'];
  // ── spec section 10: sync on by default, remember on this computer, device pairing, Free account backup ──
  const WRAPPED_KEY = 'bpSyncKeyWrapped';         // storage.local: { uid, keyId, w } the data key sealed with the non-extractable device key (IndexedDB)
  const RECOVERY_PENDING = 'bpSyncRecoveryPending'; // storage.local: { uid, keyId, w } the recovery code sealed the same way, until "I saved it"
  const RECOVERY_SESSION = 'bpSyncRecoverySession'; // storage.session: the same when there is no device key store (tests, or IndexedDB unavailable)
  const OPT_OUT_KEY = 'bpSyncOptOut';             // storage.local: { uids: [..] } accounts that turned sync off here: never turned on again by itself
  const AUTO_KEY = 'bpSyncAuto';                  // storage.local: { uid, tier, at, result } the last automatic start check
  const BACKUP_KEY = 'bpSyncBackup';              // storage.local: { uid, auto, lastAt, size, error } the Free account backup
  const BACKUP_DATASET = 'backup';
  const AUTO_EVERY_MS = 6 * 60 * 60 * 1000;
  const BACKUP_EVERY_MS = 7 * 86400000;
  const PAIR_TTL_MS = 10 * 60 * 1000;
  const MAX_OPT_OUT = 20;
  const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ().,-]{0,39}$/;

  class SyncError extends Error {
    constructor(code, message) { super(message); this.name = 'SyncError'; this.code = code; }
  }

  const MESSAGES = {
    wrong_passphrase: 'That passphrase is not right.',
    wrong_recovery_code: 'That recovery code is not right.',
    bad_format: 'A recovery code has 24 letters and numbers.',
    plan_required: 'Sync across computers is part of the Solo plan.',
    network: "Can't reach the server. Check your internet connection.",
    unauthenticated: 'Please sign in again.',
    rate_limited: 'Too many sync requests this hour. It will try again later.',
    row_too_large: 'One of your data sets is too large to sync (5 MB limit).',
    account_full: 'Your synced copy would pass the 50 MB limit.',
    locked: 'Enter your sync passphrase to continue.',
    off: 'Sync is turned off.',
    other_account: 'Sync on this computer was set up for a different account.',
    decrypt_failed: 'Some synced data could not be read. It was left as it is.',
    key_changed: 'Sync was set up again on another computer. Enter your sync passphrase to continue.',
    remote_off: 'Sync was turned off on another computer.',
    not_available: 'Sync is not available right now.',
    invalid_keys: 'The sync key data on the server is not valid, so it was not used. Nothing was changed.',
    delete_needs_owner: 'Sign in as the account that set up sync to delete the server copy.',
    other_data: 'This computer has data from another BenchPilot account. Choose whether to upload it to this account or start empty.',
    backup_first: 'Download a backup first. Starting empty clears the synced data on this computer.',
    rolled_back: 'The server sent an older copy of your synced data than this computer has already seen. It was not used, and nothing was overwritten.',
    // phase 2: resume files (background/sync-blobs.js)
    blob_account_full: 'Your synced resume files would pass the 200 MB limit. Newer files stay on this computer only.',
    too_many_blobs: 'You have more than 1,000 synced resume files. Newer files stay on this computer only.',
    blob_too_large: 'A resume file is too large to sync (5 MB limit). It stays on this computer only.',
    blob_failed: 'A synced resume file could not be read. It was left out and will be tried again later.',
    invalid_url: 'The server sent an unexpected file address. Nothing was sent.',
    blob_id_used: 'A resume file could not get a new upload slot. It will be tried again.',
    // section 10
    no_passphrase: 'This account has no sync passphrase. Use your recovery code, or approve this computer from your other computer.',
    needs_unlock: 'Sync is ready. Approve this computer from your other computer, or use your recovery code.',
    wrong_key: 'This computer does not hold the current sync key, so nothing was changed.',
    bad_challenge: 'That change could not be confirmed, so nothing was changed. Please try again.',
    pair_expired: 'The request expired. Start again.',
    pair_cancelled: 'The request was declined on your other computer.',
    pair_state: 'That request is no longer valid. Start again.',
    pair_limit: 'Too many requests. Wait a few minutes and try again.',
    pair_code: 'The codes did not match, so nothing was sent. Start again on the new computer.',
    no_recovery: 'The recovery code is no longer on this computer. If you did not save it, use Replace my keys to make a new one.',
    backup_locked: 'This account already has a backup or sync key. Restore it first with your recovery code or from your other computer.',
    backup_too_soon: 'You backed up a few minutes ago. Try again later.',
    backup_none: 'There is no account backup yet.',
    backup_too_large: 'Your data is too large for the account backup (5 MB limit). Use Download a backup instead.'
  };

  /**
   * @param deps {
   *   local, session: { get(keys)->Promise<obj>, set(obj), remove(keys) }   chrome.storage.local / .session
   *   api(body) -> Promise<json>   POST /functions/v1/sync; throws an error with .code and .message
   *   getAccount() -> Promise<{ uid, email? }|null>, getTier() -> Promise<'free'|'basic'|'pro'|'solo'>,
   *   withLock(fn), now() -> ms, crypto (BPSyncCrypto), merge (BPSyncMerge),
   *   alarms?: { create(name, info), clear(name) }
   *   enabled?: boolean | () => boolean   the feature switch, asked at run time (service worker: BP.featureOn('sync'), so a remote OFF
   *                                        stops sync at once and a remote ON resumes it). false / () => false: no alarm, no run, no network.
   *   files?: { resumes, http, storageBase }   phase 2: resume files as encrypted blobs (background/sync-blobs.js). Absent = data sets only
   *                                             (the web app's My book loads this file without it).
   * }
   */
  function createSync(deps) {
    const { local, session, api, getAccount, getTier, withLock, crypto, merge } = deps;
    // The Solo personal inbox's crypto (lib/inbox-crypto.js): "Replace my keys" re-wraps the inbox private key with the new data key.
    const inboxCrypto = deps.inboxCrypto || root.BPInboxCrypto || null;
    const now = deps.now || (() => Date.now());
    const alarms = deps.alarms || { create() {}, clear() {} };
    // The feature switch, read every time sync decides something (never once at start-up): build flag BP_CONFIG.FEATURES.sync, and not
    // switched off by remote config. Off: no alarm is created, no run starts and call() refuses before any request. Local data stays.
    const featureOn = typeof deps.enabled === 'function' ? () => deps.enabled() === true : () => deps.enabled !== false;
    // Section 10 switches, both under `enabled` (sync off = neither does anything): automatic start for paid plans, and the Free account backup.
    const autoOn = typeof deps.autoSync === 'function' ? () => featureOn() && deps.autoSync() === true : () => featureOn() && deps.autoSync === true;
    const backupOn = typeof deps.backupFree === 'function' ? () => featureOn() && deps.backupFree() === true : () => featureOn() && deps.backupFree === true;
    // { get() -> CryptoKey|null, create() -> CryptoKey }: the non-extractable device key in IndexedDB (BPSyncDeviceKeys below). Absent: nothing is
    // remembered on this computer (the key lives in the session only, as before section 10).
    const deviceKeys = deps.deviceKeys || null;

    const fail = (code, message) => new SyncError(code, message || MESSAGES[code] || 'Sync did not work. Please try again.');
    const errCode = (e) => (e && e.code) || 'internal';
    const blobsFactory = deps.blobsFactory || root.BPSyncBlobsFactory;
    const blobs = deps.files && blobsFactory ? blobsFactory({
      local, withLock, crypto, merge, fail, now, metaKey: META_KEY, call: (body) => call(body),
      resumes: deps.files.resumes, storageBase: deps.files.storageBase,
      http: (url, init) => (featureOn() ? deps.files.http(url, init) : Promise.reject(fail('not_available'))),   // signed Storage URLs: same switch
      // A lasting note in Settings (kept by the end of the run because it names a data set), e.g. over the 200 MB file cap.
      note: (code) => patchState({ error: { code, message: MESSAGES[code] || 'Sync did not work.', at: now(), dataset: 'resumes' } })
    }) : null;

    // ── state ──
    async function readState() {
      const o = await local.get(STATE_KEY);
      const s = o[STATE_KEY] && typeof o[STATE_KEY] === 'object' ? o[STATE_KEY] : {};
      return { enabled: false, uid: '', deviceId: '', keyId: '', versions: {}, seen: { keyId: '', v: {} }, pushedHash: {}, lastSyncedAt: 0, lastPushAt: 0, error: null, paused: null,
        totalBytes: 0, progress: null, conflictsSeen: [], ...s };
    }
    async function patchState(patch) {
      const s = { ...(await readState()), ...patch };
      await local.set({ [STATE_KEY]: s });
      return s;
    }
    /** { key, keyId } while unlocked, else null. A key without its generation id (an older session) counts as locked. */
    async function readKey() {
      const o = await session.get([KEY_SESSION, KEY_ID_SESSION]);
      const k = o[KEY_SESSION], id = o[KEY_ID_SESSION];
      if (typeof k === 'string' && k && typeof id === 'string' && id) return { key: crypto.b64d(k), keyId: id };
      // Section 10.3: a key remembered on this computer comes back into the session for the SAME signed-in account (cold start, browser restart).
      const acc = await getAccount().catch(() => null);
      const rem = acc && acc.uid ? await rememberedKey(acc.uid) : null;
      if (!rem) return null;
      await session.set({ [KEY_SESSION]: crypto.b64e(rem.key), [KEY_ID_SESSION]: rem.keyId });
      return rem;
    }

    // ── remember on this computer (spec section 10.3) ──
    const deviceAad = (kind, uid, keyId) => `benchpilot-device-v1|${kind}|${uid}|${keyId}`;
    async function deviceKey(create) {
      if (!deviceKeys) return null;
      try {
        const k = await deviceKeys.get();
        return k || (create ? await deviceKeys.create() : null);
      } catch (_) { return null; }
    }
    /** Seals the data key with the device key into storage.local. false when there is no device key store (then nothing is remembered). */
    async function rememberKey(uid, raw, keyId) {
      const dk = await deviceKey(true);
      if (!dk || !uid || !crypto.validKeyId(keyId)) return false;
      await local.set({ [WRAPPED_KEY]: { uid, keyId, w: await crypto.sealWith(dk, raw, deviceAad('key', uid, keyId)) } });
      return true;
    }
    async function rememberedKey(uid) {
      const o = (await local.get(WRAPPED_KEY))[WRAPPED_KEY];
      if (!o || o.uid !== uid || !crypto.validKeyId(o.keyId) || typeof o.w !== 'string') return null;
      const dk = await deviceKey(false);
      if (!dk) return null;
      try {
        const key = await crypto.openWith(dk, o.w, deviceAad('key', uid, o.keyId));
        return key.length === 32 ? { key, keyId: o.keyId } : null;
      } catch (_) { return null; }
    }
    const isRemembered = async (uid) => { const o = (await local.get(WRAPPED_KEY))[WRAPPED_KEY]; return Boolean(o && uid && o.uid === uid); };
    const forgetKey = () => local.remove([WRAPPED_KEY]);

    // The recovery code made by an automatic start, kept sealed until "I saved it" (the sheet can be shown again, on any extension page).
    async function keepRecovery(uid, keyId, code) {
      const dk = await deviceKey(true);
      if (dk) await local.set({ [RECOVERY_PENDING]: { uid, keyId, w: await crypto.sealWith(dk, new TextEncoder().encode(code), deviceAad('recovery', uid, keyId)) } });
      else await session.set({ [RECOVERY_SESSION]: { uid, keyId, code } });
    }
    async function pendingRecovery(uid) {
      const o = (await local.get(RECOVERY_PENDING))[RECOVERY_PENDING];
      if (o && o.uid === uid && typeof o.w === 'string') {
        const dk = await deviceKey(false);
        if (!dk) return null;
        try { return { keyId: o.keyId, code: new TextDecoder().decode(await crypto.openWith(dk, o.w, deviceAad('recovery', uid, o.keyId))) }; } catch (_) { return null; }
      }
      const s = (await session.get(RECOVERY_SESSION))[RECOVERY_SESSION];
      return s && s.uid === uid ? { keyId: s.keyId, code: s.code } : null;
    }
    const hasPendingRecovery = async (uid) => {
      const o = (await local.get(RECOVERY_PENDING))[RECOVERY_PENDING];
      if (o && o.uid === uid) return true;
      const s = (await session.get(RECOVERY_SESSION))[RECOVERY_SESSION];
      return Boolean(s && s.uid === uid);
    };
    const dropRecovery = async () => { await local.remove([RECOVERY_PENDING]); await session.remove([RECOVERY_SESSION]); };

    // "Turn off" is remembered per account: an automatic start never turns sync on again for it (only "Turn on sync" does).
    async function optedOut(uid) { const o = (await local.get(OPT_OUT_KEY))[OPT_OUT_KEY]; return Boolean(o && Array.isArray(o.uids) && o.uids.includes(uid)); }
    async function setOptOut(uid, on) {
      if (!uid) return;
      const o = (await local.get(OPT_OUT_KEY))[OPT_OUT_KEY];
      const list = (o && Array.isArray(o.uids) ? o.uids : []).filter((x) => x !== uid);
      if (on) list.push(uid);
      await local.set({ [OPT_OUT_KEY]: { uids: list.slice(-MAX_OPT_OUT) } });
    }
    /** Holds a freshly unwrapped data key. A different generation than the one this computer last synced with restarts the per-data-set
     *  bookkeeping, so the next run pulls and merges every data set of the new vault before it pushes (nothing local is overwritten or lost). */
    async function adoptKey(dataKeyRaw, keyId) {
      await session.set({ [KEY_SESSION]: crypto.b64e(dataKeyRaw), [KEY_ID_SESSION]: keyId });
      const st = await readState();
      if (st.keyId !== keyId) await patchState({ keyId, versions: {}, pushedHash: {}, seen: { keyId, v: {} } });
    }
    /** Highest version seen per data set for this key generation (never lowered; a new generation starts again). */
    const seenOf = (st, keyId) => (st.seen && st.seen.keyId === keyId && st.seen.v && typeof st.seen.v === 'object' ? st.seen.v : {});
    async function noteSeen(keyId, name, version) {
      const st = await readState();
      const v = { ...seenOf(st, keyId) };
      if (!(v[name] >= version)) v[name] = version;
      await patchState({ seen: { keyId, v } });
    }

    // ── whose data is on this computer (spec section 9, "Another account on this computer") ──
    async function dataOwner(st) {
      const o = (await local.get(OWNER_KEY))[OWNER_KEY];
      return o && typeof o.uid === 'string' && o.uid ? o.uid : (st.uid || '');
    }
    const otherDataFor = async (acc, st) => { const owner = await dataOwner(st); return Boolean(owner && owner !== acc.uid); };
    /** Before anything is pulled or pushed for `acc`: when this computer's data belongs to another account, a choice is required.
     *  Returns the choice to apply ('upload' | 'empty') or null when there is nothing to choose. "empty" needs a recent backup. */
    async function checkDataChoice(acc, st, choice) {
      if (!(await otherDataFor(acc, st))) return null;
      if (!DATA_CHOICES.includes(choice)) throw fail('other_data');
      if (choice === 'empty') {
        const { lastBackupAt = 0 } = await local.get('lastBackupAt');
        if (!(Number(lastBackupAt) > 0 && now() - Number(lastBackupAt) <= BACKUP_FRESH_MS)) throw fail('backup_first');
      }
      return choice;
    }
    /** "Start empty": the synced data sets on this computer are cleared (a backup was made first); resume files and local-only settings stay. */
    async function clearSyncedData() {
      await withLock(async () => {
        await local.remove([...merge.STORAGE_KEYS, CONFLICTS_KEY]);   // with the blob index: files stay here, and nothing points at them any more
        await local.set({ [META_KEY]: {} });
      });
      if (blobs) await blobs.reset();
    }
    const setOwner = (uid) => local.set({ [OWNER_KEY]: { uid } });
    /** The server holds another key generation: forget our key (locked), push nothing, and ask for the passphrase. */
    async function onKeyChanged() {
      await session.remove([KEY_SESSION, KEY_ID_SESSION]);
      await forgetKey();                                                 // a remembered key of the old generation is useless now
      await dropRecovery();                                              // so is a recovery code that was never confirmed
      await patchState({ versions: {}, pushedHash: {}, progress: null, error: { code: 'key_changed', message: MESSAGES.key_changed, at: now() } });
    }
    /** The server has no keys any more: sync is off for this account, so it is turned off here too (local data untouched). The choice is
     *  remembered for the account, so the automatic start does not set it up again behind the user's back (section 10.4). */
    async function onRemoteOff() {
      const st = await readState();
      await localReset();
      if (st.uid) await setOptOut(st.uid, true);
      await patchState({ error: { code: 'remote_off', message: MESSAGES.remote_off, at: now() } });
    }
    /** get-keys for a computer that already has sync on: a missing key row means it was turned off elsewhere. */
    async function getKeysWhileOn(st, acc) {
      try { return await call({ action: 'get-keys' }); } catch (e) {
        if (errCode(e) === 'no_keys' && st.enabled && (!st.uid || st.uid === acc.uid)) { await onRemoteOff(); throw fail('remote_off'); }
        throw e;
      }
    }
    const unlockFail = (r) => fail(r.reason === 'wrong_passphrase' ? 'wrong_passphrase' : r.reason);
    const newDeviceId = () => crypto.b64e(globalThis.crypto.getRandomValues(new Uint8Array(12))).replace(/\+/g, '-').replace(/\//g, '_');
    const setError = (e, extra) => patchState({ error: { code: errCode(e), message: String((e && e.message) || MESSAGES[errCode(e)] || 'Sync did not work.').slice(0, 200), at: now(), ...(extra || {}) } });

    async function ensureAlarms(on) {
      if (!featureOn()) { alarms.clear(PUSH_ALARM); alarms.clear(PULL_ALARM); return; }
      if (on) { alarms.create(PUSH_ALARM, { periodInMinutes: PUSH_EVERY_MIN, delayInMinutes: PUSH_EVERY_MIN }); alarms.create(PULL_ALARM, { periodInMinutes: PULL_EVERY_MIN, delayInMinutes: PULL_EVERY_MIN }); }
      else { alarms.clear(PUSH_ALARM); alarms.clear(PULL_ALARM); }
    }

    // ── what the Settings page shows. No network. ──
    async function status() {
      const st = await readState();
      const key = st.enabled ? await readKey() : null;
      const cs = (await local.get(CONFLICTS_KEY))[CONFLICTS_KEY];
      const tier = await getTier().catch(() => 'free');
      const acc = await getAccount().catch(() => null);
      const uid = acc && acc.uid ? acc.uid : '';
      const auto = (await local.get(AUTO_KEY))[AUTO_KEY];
      const bk = (await local.get(BACKUP_KEY))[BACKUP_KEY];
      const eligible = SYNC_TIERS.includes(tier);
      return {
        // Section 10: recoveryPending = the "Save your recovery code" sheet / reminder; remembered = the key is kept on this computer;
        // autoResult = why sync is not on yet for this paid account ('needs_unlock' | 'needs_choice'); backup = the Free account backup.
        recoveryPending: uid ? await hasPendingRecovery(uid) : false,
        remembered: uid ? await isRemembered(uid) : false,
        hasPassphrase: st.hasPassphrase === undefined ? null : st.hasPassphrase,
        autoResult: !st.enabled && eligible && auto && auto.uid === uid && ['needs_unlock', 'needs_choice'].includes(auto.result) ? auto.result : null,
        optedOut: uid ? await optedOut(uid) : false,
        backup: !eligible && uid && backupOn() ? { auto: Boolean(bk && bk.uid === uid && bk.auto), lastAt: bk && bk.uid === uid ? Number(bk.lastAt) || 0 : 0,
          size: bk && bk.uid === uid ? Number(bk.size) || 0 : 0, error: bk && bk.uid === uid ? bk.error || null : null, unlocked: Boolean(await readKey()) } : null,
        enabled: st.enabled, locked: st.enabled && !key, paused: st.paused, eligible,
        lastSyncedAt: st.lastSyncedAt, totalBytes: st.totalBytes, capBytes: 50 * 1024 * 1024, progress: st.progress, error: st.error,
        files: blobs && st.enabled ? await blobs.summary().catch(() => null) : null,
        conflicts: Array.isArray(cs) ? cs.map((c) => ({ key: c.key, dataset: c.dataset, label: c.label, kept: c.kept, at: c.at })) : []
      };
    }

    // ── the one network call ──
    async function call(body) {
      if (!featureOn()) throw fail('not_available');                     // switched off (also mid-run): no request leaves
      try { return await api(body); } catch (e) {
        const code = errCode(e);
        if (code === 'plan_required') await patchState({ paused: 'plan' });
        throw e;
      }
    }

    // ── turn on, step 1: make the keys. Nothing is sent. ──
    async function prepare(passphrase, { dataChoice } = {}) {
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      const problem = crypto.passphraseProblem(passphrase, { email: acc.email });
      if (problem) throw fail('weak_passphrase', problem);
      if (!SYNC_TIERS.includes(await getTier())) throw fail('plan_required');
      const choice = await checkDataChoice(acc, await readState(), dataChoice);
      const made = await crypto.createAccountKeys(passphrase);
      await session.set({ [PENDING_SESSION]: { dataKey: crypto.b64e(made.dataKeyRaw), serverKeys: made.serverKeys, uid: acc.uid, dataChoice: choice } });
      return { recoveryCode: made.recoveryCode, recoveryCodeFormatted: crypto.formatRecoveryCode(made.recoveryCode) };
    }

    // ── does this account already have keys on the server? (decides: "set up" or "enter your passphrase") ──
    async function probe() {
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      if (!SYNC_TIERS.includes(await getTier())) throw fail('plan_required');
      const otherData = await otherDataFor(acc, await readState());
      const email = typeof acc.email === 'string' ? acc.email : '';
      try { await call({ action: 'get-keys' }); return { hasKeys: true, otherData, email }; } catch (e) {
        if (errCode(e) === 'no_keys') return { hasKeys: false, otherData, email };
        throw e;
      }
    }

    // ── turn on, step 2: the user confirmed the recovery code is saved. Upload the keys, then the first sync. ──
    async function enable() {
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      const p = (await session.get(PENDING_SESSION))[PENDING_SESSION];
      if (!p || p.uid !== acc.uid) throw fail('locked', 'Start again: choose a passphrase first.');
      const choice = await checkDataChoice(acc, await readState(), p.dataChoice);   // checked again: nothing is sent before it passes
      await call({ action: 'turn-on' });                                     // an explicit turn-on clears the account's "turned off" marker (review M2)
      await call({ action: 'init-keys', ...p.serverKeys });
      await session.set({ [KEY_SESSION]: p.dataKey, [KEY_ID_SESSION]: p.serverKeys.key_id });
      await session.remove(PENDING_SESSION);
      if (choice === 'empty') await clearSyncedData();
      await local.set({ [META_KEY]: {} });
      await setOwner(acc.uid);
      await setOptOut(acc.uid, false);
      await patchState({ enabled: true, uid: acc.uid, deviceId: newDeviceId(), keyId: p.serverKeys.key_id, versions: {}, seen: { keyId: p.serverKeys.key_id, v: {} }, pushedHash: {}, lastSyncedAt: 0, lastPushAt: 0, error: null, paused: null, totalBytes: 0, progress: null, hasPassphrase: crypto.hasPassphrase(p.serverKeys) });
      await ensureAlarms(true);
      return syncNow({ force: true });
    }

    // ── second computer (or after a restart): unlock with the passphrase or the recovery code ──
    //   remember: keep the key on this computer (section 10.3), so it is not asked for again after a browser restart.
    async function unlock({ passphrase, recoveryCode, dataChoice, remember = false }) {
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      if (!SYNC_TIERS.includes(await getTier())) throw fail('plan_required');
      const st = await readState();
      if (st.enabled && st.uid && st.uid !== acc.uid) throw fail('other_account');
      const choice = await checkDataChoice(acc, st, dataChoice);   // before any key is fetched or any data moves
      const keys = await getKeysWhileOn(st, acc);     // always fresh from the server: it names the current key generation
      const r = recoveryCode ? await crypto.unlockWithRecovery(recoveryCode, keys) : await crypto.unlockWithPassphrase(passphrase, keys);
      if (!r.ok) throw unlockFail(r);
      return finishUnlock(acc, st, choice, r.dataKeyRaw, r.keyId, keys, { remember });
    }
    /** The key is proven (passphrase, recovery code or pairing, and the key check): turn sync on with it here. */
    async function finishUnlock(acc, st, choice, raw, keyId, keys, { remember }) {
      if (choice === 'empty') await clearSyncedData();
      await setOwner(acc.uid);
      await setOptOut(acc.uid, false);
      if (!st.enabled) {
        await local.set({ [META_KEY]: {} });
        await patchState({ enabled: true, uid: acc.uid, deviceId: st.deviceId || newDeviceId(), keyId, versions: {}, seen: { keyId, v: {} }, pushedHash: {}, lastSyncedAt: 0, lastPushAt: 0, error: null, paused: null, totalBytes: 0, progress: null });
      } else {
        await patchState({ error: null, paused: null });
      }
      await patchState({ hasPassphrase: crypto.hasPassphrase(keys) });
      await adoptKey(raw, keyId);
      if (remember) await rememberKey(acc.uid, raw, keyId);
      await upgradeSigning(raw, keys);
      await ensureAlarms(true);
      return syncNow({ force: true });
    }
    /**
     * Section 10.8 (0054): the body of a signed action. A fresh single-use challenge for exactly this action, signed with this key generation's
     * signing key (opened with the data key in memory). The server holds only the public key: neither it nor a log reader can answer a challenge.
     */
    async function signed(raw, keys, action, body) {
      try { return await crypto.authorize(raw, keys, action, body, call); } catch (e) {
        if (errCode(e) === 'key_changed') { await onKeyChanged(); throw fail('key_changed'); }
        if (errCode(e) === 'wrong_key' || errCode(e) === 'sign_upgrade_required') throw fail('wrong_key');
        throw e;
      }
    }
    /** First unlock of a key row made by 0044 (a static proof, no signing key): attach the signing key now, once. Best effort: a signed action
     *  does it again when this one did not get through (offline, rate limit). */
    async function upgradeSigning(raw, keys) {
      if (!crypto.needsSignUpgrade(keys)) return;
      try { await call(await crypto.signUpgradeBody(raw, keys)); } catch (_) { /* retried by the next signed action */ }
    }

    // ── change passphrase: re-wrap the same data key. Nothing is re-encrypted. ──
    async function changePassphrase({ current, recoveryCode, next }) {
      const st = await readState();
      if (!st.enabled) throw fail('off');
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      const keys = await getKeysWhileOn(st, acc);
      const r = recoveryCode ? await crypto.unlockWithRecovery(recoveryCode, keys) : await crypto.unlockWithPassphrase(current, keys);
      if (!r.ok) throw unlockFail(r);
      const problem = crypto.passphraseProblem(next, { email: acc.email });
      if (problem) throw fail('weak_passphrase', problem);
      const { key_id: _k, ...pass } = await crypto.rewrapForNewPassphrase(r.dataKeyRaw, next, keys);   // same data key, so the same key_id
      await call(await signed(r.dataKeyRaw, keys, 'update-keys', { key_id: r.keyId, passphrase: pass }));
      await adoptKey(r.dataKeyRaw, r.keyId);
      await patchState({ hasPassphrase: true });
      return { ok: true };
    }

    // ── add a passphrase (section 10.1): wraps the key this computer holds; the recovery code keeps working. ──
    async function addPassphrase({ next }) {
      const st = await readState();
      if (!st.enabled) throw fail('off');
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      const cred = await readKey();
      if (!cred) throw fail('locked');
      const problem = crypto.passphraseProblem(next, { email: acc.email });
      if (problem) throw fail('weak_passphrase', problem);
      const keys = await getKeysWhileOn(st, acc);
      if (keys.key_id !== cred.keyId) { await onKeyChanged(); throw fail('key_changed'); }
      if ((await crypto.checkDataKey(cred.key, keys)) === 'mismatch') throw fail('invalid_keys');
      const { key_id: _k, ...pass } = await crypto.rewrapForNewPassphrase(cred.key, next, keys);
      await call(await signed(cred.key, keys, 'update-keys', { key_id: cred.keyId, passphrase: pass }));
      await patchState({ hasPassphrase: true });
      return { ok: true };
    }

    // ── remember on this computer / forget it (Settings > Sync) ──
    async function setRemember(on) {
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      if (!on) { await forgetKey(); return { remembered: false }; }
      const cred = await readKey();
      if (!cred) throw fail('locked');
      return { remembered: await rememberKey(acc.uid, cred.key, cred.keyId) };
    }

    // ── the recovery code sheet after an automatic start ──
    async function revealRecovery() {
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      const p = await pendingRecovery(acc.uid);
      if (!p) throw fail('no_recovery');
      const cred = await readKey();
      if (cred && cred.keyId !== p.keyId) { await dropRecovery(); throw fail('no_recovery'); }   // a code of an older generation is no use
      return { recoveryCode: p.code, recoveryCodeFormatted: crypto.formatRecoveryCode(p.code), email: typeof acc.email === 'string' ? acc.email : '' };
    }
    async function confirmRecovery() { await dropRecovery(); return { ok: true }; }

    // ── automatic start for paid plans (section 10.4) and "Turn on sync" ──
    //   auto: true  = called by the worker (install, start, plan or sign-in change): never asks, never clears a "turn off" choice, throttled.
    //   auto: false = the user pressed "Turn on sync": clears the "turn off" choice; dataChoice answers the "another account" question.
    // Returns { result: 'started' | 'needs_unlock' | 'needs_choice', recoveryPending } or { skipped }.
    let starting = null;
    function autoStart(opts) {
      if (starting) return starting;
      starting = startCore(opts || {}).finally(() => { starting = null; });
      return starting;
    }
    async function startCore({ auto = true, force = false, dataChoice } = {}) {
      if (!featureOn() || (auto && !autoOn())) return { skipped: 'off' };
      const acc = await getAccount();
      if (!acc) { if (auto) return { skipped: 'signed_out' }; throw fail('unauthenticated'); }
      const tier = await getTier().catch(() => 'free');
      if (!SYNC_TIERS.includes(tier)) { if (auto) return { skipped: 'plan' }; throw fail('plan_required'); }
      const st = await readState();
      if (st.enabled) return { skipped: 'on' };
      if (auto && await optedOut(acc.uid)) return { skipped: 'opted_out' };
      const prev = (await local.get(AUTO_KEY))[AUTO_KEY];
      if (auto && !force && prev && prev.uid === acc.uid && prev.tier === tier && now() - Number(prev.at || 0) < AUTO_EVERY_MS) return { skipped: 'recent', result: prev.result };
      const note = (result) => local.set({ [AUTO_KEY]: { uid: acc.uid, tier, at: now(), result } });
      if (!auto) await setOptOut(acc.uid, false);
      // This computer's data belongs to another account: the automatic start never decides that; "Turn on sync" asks (other_data).
      let choice = null;
      if (await otherDataFor(acc, st)) {
        if (auto) { await note('needs_choice'); return { result: 'needs_choice' }; }
        choice = await checkDataChoice(acc, st, dataChoice);
      }
      // The account-wide "turned off" marker (review M2): sync was turned off (typed DELETE) on some computer. The automatic start respects it
      // on every computer, also a fresh install; only "Turn on sync" (auto: false) clears it.
      const l = await call({ action: 'list' });
      if (l && l.turned_off === true) {
        if (auto) { await setOptOut(acc.uid, true); await note('turned_off'); return { skipped: 'turned_off' }; }
        await call({ action: 'turn-on' });
      }
      let keys = null;
      if (!l || l.has_keys !== false) {
        try { keys = await call({ action: 'get-keys' }); } catch (e) { if (errCode(e) !== 'no_keys') throw e; }
      }
      if (!keys) {
        const made = await crypto.createAccountKeys(null, undefined, { noPassphrase: true });
        try { await call({ action: 'init-keys', ...made.serverKeys }); } catch (e) {
          if (errCode(e) === 'keys_exist') { await note('needs_unlock'); return { result: 'needs_unlock' }; }   // another computer was first
          if (errCode(e) === 'turned_off') { await setOptOut(acc.uid, true); await note('turned_off'); return { skipped: 'turned_off' }; }   // the server enforces it (L-b)
          throw e;
        }
        await keepRecovery(acc.uid, made.keyId, made.recoveryCode);
        await note('started');
        await startWithKey(acc, st, choice, made.dataKeyRaw, made.keyId, made.serverKeys);
        return { result: 'started', recoveryPending: true };
      }
      // The account has keys (another computer, or a Free account backup): a key remembered here for that generation is used at once.
      const rem = await rememberedKey(acc.uid);
      if (rem && rem.keyId === keys.key_id && crypto.serverKeysProblem(keys) === null && (await crypto.checkDataKey(rem.key, keys)) !== 'mismatch') {
        await note('started');
        await startWithKey(acc, st, choice, rem.key, rem.keyId, keys);
        return { result: 'started', recoveryPending: await hasPendingRecovery(acc.uid) };
      }
      await note('needs_unlock');
      return { result: 'needs_unlock' };
    }
    async function startWithKey(acc, st, choice, raw, keyId, keys) {
      if (choice === 'empty') await clearSyncedData();
      await local.set({ [META_KEY]: {} });
      await setOwner(acc.uid);
      await patchState({ enabled: true, uid: acc.uid, deviceId: st.deviceId || newDeviceId(), keyId, versions: {}, seen: { keyId, v: {} }, pushedHash: {}, lastSyncedAt: 0, lastPushAt: 0, error: null, paused: null, totalBytes: 0, progress: null, hasPassphrase: crypto.hasPassphrase(keys) });
      await adoptKey(raw, keyId);
      await rememberKey(acc.uid, raw, keyId);
      await upgradeSigning(raw, keys);
      await ensureAlarms(true);
      await syncNow({ force: true });
    }

    // ── "Replace my keys": a new data key, key_id and recovery code; every data set is re-encrypted and re-uploaded. ──
    //   step 1 (prepareRotate): proves the current passphrase on this computer, makes the new keys (same passphrase, new salt) and returns the new
    //           recovery code. Nothing is sent except get-keys.
    //   step 2 (commitRotate, after "I've saved my new recovery code"): syncs once with the old key (so this computer holds the newest data), then
    //           rotate-keys swaps the key row and empties the old generation in one server transaction (it needs the current verifier and the old
    //           key_id), then every data set is pushed under the new key_id. Other computers get key_changed and must enter the passphrase again;
    //           their local data is merged back in, so nothing is lost even if this computer stops half way.
    async function prepareRotate({ current } = {}) {
      const st = await readState();
      if (!st.enabled) throw fail('off');
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      if (st.uid && st.uid !== acc.uid) throw fail('other_account');
      if (!SYNC_TIERS.includes(await getTier())) throw fail('plan_required');
      const cred = await readKey();
      if (!cred) throw fail('locked');
      const keys = await getKeysWhileOn(st, acc);
      if (keys.key_id !== cred.keyId) { await onKeyChanged(); throw fail('key_changed'); }
      // With a passphrase it is proven again (as before section 10) and kept; without one, this unlocked computer's key is enough (the server
      // checks a challenge signed with this generation's signing key, section 10.8) and the new keys have no passphrase either.
      const withPass = crypto.hasPassphrase(keys);
      if (withPass) {
        const r = await crypto.unlockWithPassphrase(current, keys);
        if (!r.ok) throw unlockFail(r);
      } else if ((await crypto.checkDataKey(cred.key, keys)) === 'mismatch') throw fail('invalid_keys');
      const made = withPass ? await crypto.createAccountKeys(current, undefined, { keepPassphrase: true }) : await crypto.createAccountKeys(null, undefined, { noPassphrase: true });
      await session.set({ [ROTATE_SESSION]: { dataKey: crypto.b64e(made.dataKeyRaw), serverKeys: made.serverKeys, uid: acc.uid, oldKeyId: keys.key_id } });
      return { recoveryCode: made.recoveryCode, recoveryCodeFormatted: crypto.formatRecoveryCode(made.recoveryCode) };
    }
    async function commitRotate({ reencryptFiles = false } = {}) {
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      const st = await readState();
      if (!st.enabled) throw fail('off');
      const p = (await session.get(ROTATE_SESSION))[ROTATE_SESSION];
      if (!p || p.uid !== acc.uid || (st.uid && st.uid !== acc.uid)) throw fail('locked', 'Start again: enter your passphrase first.');
      const pre = await syncNow({ force: true });                          // newest data under the old key first
      if (!pre || pre.ok !== true || pre.skipped) {
        const e = pre && pre.error;
        throw fail(e && e.code ? e.code : 'locked', e && e.code && MESSAGES[e.code] ? MESSAGES[e.code] : undefined);
      }
      // The personal inbox (docs/specs/SOLO_INBOX_SPEC.md section 4): its private key is wrapped with the data key, so it moves to the new one in
      // the same server transaction. The server refuses the rotation without it when the user has an inbox (inbox_rewrap_required).
      const inboxWrapped = await rewrapInboxKey(p);
      // Resume file keys are stored wrapped with the data key: re-wrapped in memory now, written only once the server took the new keys.
      const oldCred = await readKey();
      if (!oldCred || oldCred.keyId !== p.oldKeyId) throw fail('locked', 'Start again: enter your passphrase first.');
      const rewrap = blobs ? await blobs.prepareRewrap(oldCred, { key: crypto.b64d(p.dataKey), keyId: p.serverKeys.key_id }) : null;
      try {
        // Signed with the OLD generation's signing key over the new key row (section 10.8): fresh keys from the server name that generation.
        const cur = await call({ action: 'get-keys' });
        if (!cur || cur.key_id !== p.oldKeyId) throw fail('key_changed');
        await call(await signed(oldCred.key, cur, 'rotate-keys', { ...p.serverKeys, old_key_id: p.oldKeyId, ...(inboxWrapped ? { inbox_wrapped_key: inboxWrapped } : {}) }));
      } catch (e) {
        if (errCode(e) === 'key_changed') { await session.remove(ROTATE_SESSION); await onKeyChanged(); }
        throw e;
      }
      await session.remove(ROTATE_SESSION);
      await adoptKey(crypto.b64d(p.dataKey), p.serverKeys.key_id);         // new generation: versions, pushedHash and seen start again
      await dropRecovery();                                                // an unconfirmed code of the old generation no longer opens anything
      if (await isRemembered(acc.uid)) await rememberKey(acc.uid, crypto.b64d(p.dataKey), p.serverKeys.key_id);
      // "Also re-encrypt resume files": every file gets a new key and blob id over the next runs and the old server files are deleted. Without
      // it, the old data key plus an old copy of the index can still open the old files (docs/specs/ENCRYPTED_SYNC_SPEC.md section 9).
      if (blobs) await blobs.applyRewrap(rewrap, { renewFiles: reencryptFiles === true });
      return syncNow({ force: true });                                     // the new vault is empty: every data set is uploaded
    }

    /** The inbox private key wrapped with the rotation's new data key, or null when there is no inbox key of the current generation. */
    async function rewrapInboxKey(p) {
      if (!inboxCrypto) return null;
      let info;
      try { info = await call({ action: 'inbox-get' }); } catch (_) { return null; }   // an older server: no inbox; the server decides
      const k = info && info.key;
      if (!k || typeof k.wrapped_private_key !== 'string' || k.key_id !== p.oldKeyId) return null;   // none, or stale (the server deletes it)
      const old = await readKey();
      if (!old || old.keyId !== p.oldKeyId) throw fail('locked', 'Start again: enter your passphrase first.');
      // The public key is bound into the wrapping (AAD) and checked against the private key: a public key replaced on the server is refused
      // loudly here instead of being carried into the new keys.
      try {
        return await inboxCrypto.rewrapInboxKey(old.key, old.keyId, crypto.b64d(p.dataKey), p.serverKeys.key_id, k.wrapped_private_key, k.public_key);
      } catch (_) {
        throw fail('inbox_key_mismatch', inboxCrypto.MISMATCH);
      }
    }

    /** Settings > Sync: the personal inbox address to show and copy (read-only; it is created in the web app). null when there is none. */
    async function inboxAddress() {
      const st = await readState();
      if (!st.enabled) return { address: null };
      const r = await call({ action: 'inbox-get' });
      const a = r && r.address;
      if (!a || a.disabled_at || typeof a.token !== 'string' || !/^[a-z0-9]{12}$/.test(a.token) || typeof r.domain !== 'string' || !r.domain) return { address: null };
      return { address: `p-${a.token}@${r.domain}`, newCount: Number(r.new_count) || 0 };
    }

    // ── turn off. Local data is never touched. ──
    //   { confirm: 'DELETE' }    typed DELETE: the server copy is deleted, then sync is off here. Needs the account that set sync up to be signed
    //                            in; otherwise it fails with a clear message and nothing changes (it never reports "deleted" when it was not).
    //   { localOnly: true }      "Turn off on this computer only": forgets the sync state here, sends nothing, leaves the server copy as it is.
    //   Either way the choice is remembered for the account (bpSyncOptOut): the automatic start never turns sync on again by itself (section 10.4).
    async function disable({ confirm, localOnly } = {}) {
      if (localOnly === true) {
        const st = await readState();
        const acc = await getAccount().catch(() => null);
        await localReset();
        await setOptOut(st.uid || (acc && acc.uid) || '', true);
        return { ok: true, localOnly: true };
      }
      if (confirm !== 'DELETE') throw fail('confirm', 'Type DELETE to confirm.');
      const st = await readState();
      const acc = await getAccount();
      if (!acc || (st.uid && st.uid !== acc.uid)) throw fail('delete_needs_owner');
      await call({ action: 'delete-all', turn_off: true });                 // the account-wide "turned off" marker (review M2)
      await localReset();
      await setOptOut(acc.uid, true);
      return { ok: true };
    }
    async function localReset() {
      await ensureAlarms(false);
      await session.remove([KEY_SESSION, KEY_ID_SESSION, PENDING_SESSION, ROTATE_SESSION]);
      await forgetKey();                                                  // the key remembered on this computer goes with sync (section 10.3)
      await dropRecovery();
      await local.remove([STATE_KEY, META_KEY, CONFLICTS_KEY, AUTO_KEY, BACKUP_KEY]);   // OWNER_KEY stays: the data on this computer is still that account's
      if (blobs) await blobs.reset();                                     // the blob index goes; the resume files stay in IndexedDB
    }
    /** Called when the user signs out: the key goes away from the session; sync stays "on" but locked until the same account signs in again
     *  (a key remembered on this computer is sealed to that account and comes back only for it) or the key is entered again. */
    async function onSignOut() {
      await session.remove([KEY_SESSION, KEY_ID_SESSION, PENDING_SESSION, ROTATE_SESSION, RECOVERY_SESSION]);
      pairing.clear();
      approving.clear();
    }

    // ── device pairing (section 10.5). Private keys and nonces stay in this worker's memory only and are dropped when a request ends. ──
    const pairing = new Map();     // new device: id -> { privateKey, pub, nonce, commit, mode, dataChoice, remember, approverPub, approverNonce, code, until }
    const approving = new Map();   // approver:   id -> { privateKey, pub, nonce, until }
    const pairErr = (e) => {
      const c = errCode(e);
      return ['pair_expired', 'pair_state', 'pair_limit', 'not_found'].includes(c) ? fail(c === 'not_found' ? 'pair_state' : c) : e;
    };
    const validPub = (v) => { try { const b = crypto.b64d(v); return b.length === 65 && b[0] === 4; } catch (_) { return false; } };
    const validNonce = (v) => { try { return crypto.b64d(v).length === 16; } catch (_) { return false; } };
    const sweep = (m) => { for (const [id, s] of m) if (s.until <= now()) m.delete(id); };

    /** New device: open a request. mode 'sync' (paid: turn sync on here) or 'backup' (Free: restore the account backup). */
    async function pairStart({ label, mode = 'sync', dataChoice, remember = true } = {}) {
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      const tier = await getTier().catch(() => 'free');
      if (mode === 'sync' && !SYNC_TIERS.includes(tier)) throw fail('plan_required');
      if (mode === 'backup' && !backupOn()) throw fail('not_available');
      const st = await readState();
      if (st.enabled && st.uid && st.uid !== acc.uid) throw fail('other_account');
      const choice = mode === 'sync' ? await checkDataChoice(acc, st, dataChoice) : null;   // before anything is requested
      const name = String(label || '').trim().slice(0, 40);
      const n = await crypto.pairStart();
      let r;
      try { r = await call({ action: 'pair-create', new_pub: n.pub, commit: n.commit, label: LABEL_RE.test(name) ? name : 'Chrome extension' }); } catch (e) { throw pairErr(e); }
      if (!r || !crypto.validPairId(r.id)) throw fail('pair_state');
      sweep(pairing);
      pairing.set(r.id, { ...n, mode, dataChoice: choice, remember: remember !== false, uid: acc.uid, until: now() + PAIR_TTL_MS });
      return { id: r.id, expiresAt: now() + PAIR_TTL_MS };
    }
    /** New device: one poll. { status: 'waiting' | 'code' | 'approved' | 'done', code? }. Throws pair_expired / pair_cancelled / pair_state / invalid_keys.
     *  opts.confirmed: the user confirmed here "I approved on my other computer and the codes matched" (review M3). Without it an approved
     *  request is never taken: the poll answers 'approved' and waits.  */
    async function pairPoll(id, opts) {
      const s = pairing.get(id);
      if (!s) throw fail('pair_state');
      const end = (e) => { pairing.delete(id); return e; };
      if (s.until <= now()) throw end(fail('pair_expired'));
      const acc = await getAccount();
      if (!acc || acc.uid !== s.uid) throw end(fail('other_account'));
      let g;
      try { g = await call({ action: 'pair-get', id }); } catch (e) { const x = pairErr(e); if (x !== e) throw end(x); throw e; }   // network: keep it
      if (g.status === 'cancelled') throw end(fail('pair_cancelled'));
      if (g.status === 'expired') throw end(fail('pair_expired'));
      if (g.new_pub !== s.pub || g.commit !== s.commit) throw end(fail('pair_state'));   // not the request this computer made
      if (g.status === 'open') return { status: 'waiting' };
      if (!s.code) {
        if (g.status !== 'responded' || !validPub(g.approver_pub) || !validNonce(g.approver_nonce)) throw end(fail('pair_state'));
        // The approver's values are fixed now; only then does this computer reveal its nonce.
        try { await call({ action: 'pair-reveal', id, new_nonce: s.nonce }); } catch (e) { throw end(pairErr(e)); }
        s.approverPub = g.approver_pub;
        s.approverNonce = g.approver_nonce;
        s.code = await crypto.pairCode(id, { newPub: s.pub, approverPub: s.approverPub, newNonce: s.nonce, approverNonce: s.approverNonce });
        return { status: 'code', code: s.code };
      }
      if (g.approver_pub !== s.approverPub || g.approver_nonce !== s.approverNonce) throw end(fail('pair_state'));
      if (g.status === 'revealed') return { status: 'code', code: s.code };
      if (g.status !== 'approved') throw end(fail('pair_state'));
      // Re-review L-a: a confirmation counts only once the server says 'approved' (never recorded earlier, e.g. a box ticked too soon).
      if (opts && opts.confirmed === true) s.confirmed = true;
      if (!s.confirmed) return { status: 'approved', code: s.code };          // the user has not confirmed the match on this screen yet
      let t;
      try { t = await call({ action: 'pair-take', id }); } catch (e) { throw end(pairErr(e)); }
      pairing.delete(id);
      if (!t || t.approver_pub !== s.approverPub) throw fail('pair_state');
      const keys = await call({ action: 'get-keys' });
      if (crypto.serverKeysProblem(keys) || keys.key_id !== t.key_id) throw fail('invalid_keys');
      let raw;
      try { raw = await crypto.pairUnwrap(s.privateKey, { id, keyId: keys.key_id, newPub: s.pub, approverPub: s.approverPub }, t.wrapped); } catch (_) { throw fail('invalid_keys'); }
      if ((await crypto.checkDataKey(raw, keys)) !== 'match') throw fail('invalid_keys');      // pairing always needs the key check (0044 rows have it)
      if (s.mode === 'backup') {
        await session.set({ [KEY_SESSION]: crypto.b64e(raw), [KEY_ID_SESSION]: keys.key_id });
        if (s.remember) await rememberKey(acc.uid, raw, keys.key_id);
        await upgradeSigning(raw, keys);
        return { status: 'done', mode: 'backup' };
      }
      await finishUnlock(acc, await readState(), s.dataChoice, raw, keys.key_id, keys, { remember: s.remember });
      return { status: 'done', mode: 'sync' };
    }
    async function pairCancel(id) {
      pairing.delete(id);
      approving.delete(id);
      try { await call({ action: 'pair-cancel', id }); } catch (_) { /* gone or expired: nothing to cancel */ }
      return { ok: true };
    }

    /** Can this computer approve? It must hold the key: an unlocked computer that syncs, or (Free) the one holding the account backup key. */
    async function canApprove(st) {
      if (!(st.enabled || backupOn())) return false;
      const acc = await getAccount().catch(() => null);
      if (!acc || (st.enabled && st.uid && st.uid !== acc.uid)) return false;
      return Boolean(await readKey());
    }
    /** Approver: open requests of this account. */
    async function pairList() {
      const st = await readState();
      if (!(await canApprove(st))) return { items: [] };
      const r = await call({ action: 'pair-list' });
      return { items: (r && Array.isArray(r.items) ? r.items : []).filter((x) => x && crypto.validPairId(x.id))
        .map((x) => ({ id: x.id, label: typeof x.label === 'string' ? x.label.slice(0, 40) : '', status: x.status, createdAt: x.created_at || null, expiresAt: x.expires_at || null, mine: approving.has(x.id) })) };
    }
    /** Approver: the user chose to review a request. This computer's ephemeral key and nonce are made only now (after the commitment). */
    async function pairRespond(id) {
      const st = await readState();
      if (!(await canApprove(st))) throw fail('locked');
      if (!crypto.validPairId(id)) throw fail('pair_state');
      const a = await crypto.pairKeys();
      try { await call({ action: 'pair-respond', id, approver_pub: a.pub, approver_nonce: a.nonce }); } catch (e) { throw pairErr(e); }
      sweep(approving);
      approving.set(id, { ...a, until: now() + PAIR_TTL_MS });
      return { ok: true };
    }
    /** Approver: { status: 'waiting' } until the new computer revealed its nonce, then { status: 'code', code } (the commitment checked). */
    async function pairStatus(id) {
      const s = approving.get(id);
      if (!s) throw fail('pair_state');
      if (s.until <= now()) { approving.delete(id); throw fail('pair_expired'); }
      let g;
      try { g = await call({ action: 'pair-get', id }); } catch (e) { const x = pairErr(e); if (x !== e) approving.delete(id); throw x; }
      if (['cancelled', 'expired', 'done', 'approved'].includes(g.status)) { approving.delete(id); throw fail(g.status === 'expired' ? 'pair_expired' : 'pair_state'); }
      if (g.approver_pub !== s.pub || g.approver_nonce !== s.nonce) { approving.delete(id); throw fail('pair_state'); }   // another computer answered
      if (g.status !== 'revealed') return { status: 'waiting' };
      await approverCode(id, s, g);                                          // checks the commitment; the code itself is NOT shown here (review M1):
      return { status: 'ready' };                                            // the user types the code the new computer shows
    }
    async function approverCode(id, s, g) {
      if (!validPub(g.new_pub) || !(await crypto.pairCheckCommit(g.new_pub, g.new_nonce, g.commit))) {
        approving.delete(id);
        await call({ action: 'pair-cancel', id }).catch(() => {});
        throw fail('pair_state');
      }
      return crypto.pairCode(id, { newPub: g.new_pub, approverPub: s.pub, newNonce: g.new_nonce, approverNonce: s.nonce });
    }
    /** "abc def" / "ABC-DEF" -> "ABC-DEF" (the recovery alphabet only), '' when it is not 6 symbols. */
    function normalizePairCode(v) {
      const s = String(v || '').toUpperCase().replace(/[\s-]/g, '');
      return s.length === 6 && [...s].every((c) => crypto.RECOVERY_ALPHABET.includes(c)) ? `${s.slice(0, 3)}-${s.slice(3)}` : '';
    }
    /** Approver: the user TYPED `code`, read off the new computer's screen (review M1: this screen never shows it), and pressed Approve. A
     *  wrong code cancels the request and sends nothing. Otherwise the data key is wrapped for the new computer's key and sent once. */
    async function pairApprove(id, code) {
      const s = approving.get(id);
      if (!s) throw fail('pair_state');
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      const st = await readState();
      if (!(await canApprove(st))) throw fail('locked');
      const cred = await readKey();
      if (!cred) throw fail('locked');
      let g;
      try { g = await call({ action: 'pair-get', id }); } catch (e) { throw pairErr(e); }
      if (g.status !== 'revealed' || g.approver_pub !== s.pub || g.approver_nonce !== s.nonce) { approving.delete(id); throw fail('pair_state'); }
      const now2 = await approverCode(id, s, g);
      if (normalizePairCode(code) !== now2) { approving.delete(id); await call({ action: 'pair-cancel', id }).catch(() => {}); throw fail('pair_code'); }
      const keys = await getKeysWhileOn(st, acc);
      if (keys.key_id !== cred.keyId) { approving.delete(id); await onKeyChanged(); throw fail('key_changed'); }
      if ((await crypto.checkDataKey(cred.key, keys)) === 'mismatch') throw fail('invalid_keys');

      const wrapped = await crypto.pairWrap(s.privateKey, { id, keyId: cred.keyId, newPub: g.new_pub, approverPub: s.pub }, cred.key);
      // Section 10.8: a challenge signed with this generation's signing key over this request id and this wrapped key. The request is kept
      // here until the approval went through, so a refused or failed challenge (limit, network) can be tried again.
      const body = await signed(cred.key, keys, 'pair-approve', { id, key_id: cred.keyId, wrapped });
      try { await call(body); } catch (e) { const x = pairErr(e); if (x !== e) approving.delete(id); throw x; }
      approving.delete(id);
      return { ok: true };
    }

    // ── Free account backup (section 10.6): one encrypted snapshot of this computer's data, no resume files. Not live sync. ──
    async function readBackupState(uid) { const o = (await local.get(BACKUP_KEY))[BACKUP_KEY]; return o && o.uid === uid ? o : { uid, auto: false, lastAt: 0, size: 0, error: null }; }
    const patchBackup = async (uid, patch) => local.set({ [BACKUP_KEY]: { ...(await readBackupState(uid)), ...patch, uid } });
    async function backupAccount() {
      if (!backupOn()) throw fail('not_available');
      const acc = await getAccount();
      if (!acc) throw fail('unauthenticated');
      if (SYNC_TIERS.includes(await getTier().catch(() => 'free'))) throw fail('not_available');   // a sync plan syncs instead
      return acc;
    }
    /** Back up now (or the weekly automatic one). Makes the keys on the first backup (no passphrase; the recovery code sheet follows). */
    // Review L2: this computer's data may belong to another account (bpSyncDataOwner): then nothing is sent until the user answers
    // (dataChoice 'upload'); the automatic weekly backup never asks and skips. The owner is never recorded silently.
    async function backupNow({ auto = false, dataChoice } = {}) {
      const acc = await backupAccount();
      const choice = await otherDataFor(acc, await readState()) ? (dataChoice === 'upload' && !auto ? 'upload' : null) : 'none';
      if (!choice) throw fail('other_data');
      if (!deps.buildBackup) throw fail('not_available');
      let cred = await readKey();
      let keys = null;
      try { keys = await call({ action: 'get-keys' }); } catch (e) { if (errCode(e) !== 'no_keys') throw e; }
      if (!keys) {
        const made = await crypto.createAccountKeys(null, undefined, { noPassphrase: true });
        // "Back up now" is an explicit user action (never the weekly backup, which needs a key already): it may clear the account's "turned
        // off" marker, as "Turn on sync" does (re-review L-b; spec 10.6). The marker only stops keys being made behind the user's back.
        try { await call({ action: 'init-keys', ...made.serverKeys }); } catch (e) {
          if (errCode(e) !== 'turned_off' || auto) throw e;
          await call({ action: 'turn-on' });
          await call({ action: 'init-keys', ...made.serverKeys });
        }
        await keepRecovery(acc.uid, made.keyId, made.recoveryCode);
        await session.set({ [KEY_SESSION]: crypto.b64e(made.dataKeyRaw), [KEY_ID_SESSION]: made.keyId });
        await rememberKey(acc.uid, made.dataKeyRaw, made.keyId);
        cred = { key: made.dataKeyRaw, keyId: made.keyId };
        keys = made.serverKeys;
      }
      if (!cred || cred.keyId !== keys.key_id) throw fail('backup_locked');
      const list = await call({ action: 'list' });
      if (list.key_id !== cred.keyId) throw fail('backup_locked');
      const prev = (Array.isArray(list.datasets) ? list.datasets : []).find((d) => d && d.dataset === BACKUP_DATASET);
      const expected = prev ? Number(prev.version) || 0 : 0;
      const snapshot = await deps.buildBackup();
      const sealed = await crypto.encryptDataset(cred.key, { keyId: cred.keyId, dataset: BACKUP_DATASET, version: expected + 1 }, snapshot);
      const size = Math.floor((sealed.ciphertext.length * 3) / 4);
      if (size > ROW_CAP_BYTES) { await patchBackup(acc.uid, { error: { code: 'backup_too_large', at: now() } }); throw fail('backup_too_large'); }
      try {
        await call({ action: 'put', dataset: BACKUP_DATASET, expected_version: expected, iv: sealed.iv, ciphertext: sealed.ciphertext, device_id: (await readState()).deviceId || newDeviceId(), key_id: cred.keyId });
      } catch (e) {
        if (!auto || errCode(e) !== 'backup_too_soon') await patchBackup(acc.uid, { error: { code: errCode(e), at: now() } });
        throw e;
      }
      if (choice === 'upload') await setOwner(acc.uid);                     // only after the user said this computer's data goes to this account (review L2)
      await patchBackup(acc.uid, { lastAt: now(), size, error: null });
      return { ok: true, size, recoveryPending: await hasPendingRecovery(acc.uid) };
    }
    async function backupSetAuto(on) { const acc = await backupAccount(); await patchBackup(acc.uid, { auto: on === true }); return { ok: true }; }
    /** New computer: unlock the account backup with the recovery code (or by pairing, mode 'backup'). The key is remembered here by default. */
    async function backupUnlock({ recoveryCode, remember = true }) {
      const acc = await backupAccount();
      const keys = await call({ action: 'get-keys' });
      const r = await crypto.unlockWithRecovery(recoveryCode, keys);
      if (!r.ok) throw unlockFail(r);
      await session.set({ [KEY_SESSION]: crypto.b64e(r.dataKeyRaw), [KEY_ID_SESSION]: r.keyId });
      if (remember) await rememberKey(acc.uid, r.dataKeyRaw, r.keyId);
      await upgradeSigning(r.dataKeyRaw, keys);

      return { ok: true };
    }
    /** The decrypted backup object, for the Settings restore screen (which saves a safety backup first, then restores as from a file). */
    async function backupFetch() {
      await backupAccount();
      const cred = await readKey();
      if (!cred) throw fail('backup_locked');
      let r;
      try { r = await call({ action: 'get', dataset: BACKUP_DATASET }); } catch (e) { if (errCode(e) === 'not_found') throw fail('backup_none'); throw e; }
      if (r.key_id !== cred.keyId) throw fail('backup_locked');
      try { return { backup: await crypto.decryptDataset(cred.key, { keyId: cred.keyId, dataset: BACKUP_DATASET, version: r.version }, r) }; } catch (_) { throw fail('decrypt_failed'); }
    }
    /** "Delete my account backup": the server copy and the keys go (delete-all); this computer forgets the key. Local data is untouched. */
    async function backupDelete() {
      const acc = await backupAccount();
      if ((await readState()).enabled) throw fail('not_available');
      await call({ action: 'delete-all' });                                 // no turn_off: deleting the Free backup is not "turn off sync"
      await session.remove([KEY_SESSION, KEY_ID_SESSION]);
      await forgetKey();
      await dropRecovery();
      await local.remove([BACKUP_KEY]);
      return { ok: true, uid: acc.uid };
    }
    /** The daily alarm: the weekly automatic backup, when turned on. Never throws. */
    async function onDaily() {
      try {
        if (!backupOn()) return null;
        const acc = await getAccount();
        if (!acc || SYNC_TIERS.includes(await getTier().catch(() => 'free'))) return null;
        const b = await readBackupState(acc.uid);
        if (!b.auto || now() - Number(b.lastAt || 0) < BACKUP_EVERY_MS) return null;
        if (!(await readKey())) return null;                             // never makes keys or asks anything by itself
        return await backupNow({ auto: true });
      } catch (_) { return null; }
    }

    // ── one data set: pull + merge ──
    function mergeInto(name, remoteSnap, st, deviceId) {
      return withLock(async () => {
        const storage = await local.get([...merge.STORAGE_KEYS, META_KEY]);
        const allMeta = storage[META_KEY] || {};
        const t = now();
        const records = merge.recordsOf(name, storage);
        const meta = merge.stamp(records, allMeta[name], deviceId, t, merge.DATASETS[name].growOnly);
        const out = merge.merge(name, records, meta, remoteSnap, t, { erased: merge.erasedSet(storage.erasedIds) });   // section 10.9
        if (out.changedLocal) {
          const patch = merge.applyPatch(name, storage, out.records);
          if (Object.keys(patch.set).length) await local.set(patch.set);
          if (patch.remove.length) await local.remove(patch.remove);
        }
        await local.set({ [META_KEY]: { ...allMeta, [name]: out.meta } });
        return out;
      });
    }

    async function recordConflicts(list, st) {
      if (!list.length) return st;
      const seen = new Set(st.conflictsSeen || []);
      const cur = (await local.get(CONFLICTS_KEY))[CONFLICTS_KEY];
      const out = Array.isArray(cur) ? cur.slice() : [];
      for (const c of list) {
        const key = `${c.dataset}|${c.id}|${merge.hashRecord(c.record)}`;
        if (seen.has(key)) continue;           // asked once: never again for the same pair
        seen.add(key);
        out.push({ key, dataset: c.dataset, id: c.id, label: c.label, kept: c.kept, record: c.record, at: now() });
      }
      await local.set({ [CONFLICTS_KEY]: out.slice(-MAX_CONFLICTS) });
      return patchState({ conflictsSeen: [...seen].slice(-MAX_SEEN) });
    }

    const blocked = new Set(); // data sets that could not be decrypted this run: never pushed over

    async function pullOne(name, cred) {
      const st0 = await readState();
      const r = await call({ action: 'get', dataset: name });
      if (r.key_id !== cred.keyId) throw fail('key_changed');   // never decrypt-and-fail (or merge) a data set of another key generation
      if (!Number.isInteger(r.version) || r.version < 1 || r.version < (seenOf(st0, cred.keyId)[name] || 0)) {   // older than a row already seen: a replay
        blocked.add(name);
        await patchState({ error: { code: 'rolled_back', message: MESSAGES.rolled_back, at: now() } });
        return null;
      }
      let snap;
      try { snap = merge.cleanSnapshot(await crypto.decryptDataset(cred.key, { keyId: cred.keyId, dataset: name, version: r.version }, r), name); } catch (_) { snap = null; }
      if (!snap) { blocked.add(name); await patchState({ error: { code: 'decrypt_failed', message: MESSAGES.decrypt_failed, at: now() } }); return null; }
      const out = await mergeInto(name, snap, st0, st0.deviceId);
      let st = await readState();
      const versions = { ...st.versions, [name]: r.version };
      const pushedHash = { ...st.pushedHash };
      if (!out.pushNeeded) pushedHash[name] = merge.snapshotHash(merge.snapshotOf(out.records, out.meta));
      else delete pushedHash[name];
      const seen = { ...seenOf(st, cred.keyId) };
      if (!(seen[name] >= r.version)) seen[name] = r.version;
      st = await patchState({ versions, pushedHash, seen: { keyId: cred.keyId, v: seen } });
      await recordConflicts(out.conflicts, st);
      return out;
    }

    /** The erase list as the server has it now (section 10.9); nothing there yet is fine. */
    async function pullErased(cred) {
      try { await pullOne('erased', cred); } catch (e) { if (errCode(e) !== 'not_found') throw e; }
    }
    async function pushOne(name, cred, { retried = false } = {}) {
      if (blocked.has(name)) return false;
      // A grow-only data set (the erase list) never goes up without the server's entries merged in first: a push replaces the server row, so
      // a computer whose own list is missing entries must not shrink it for everyone (review of section 10.9).
      if (merge.DATASETS[name].growOnly && !retried && (await readState()).versions[name] !== undefined) await pullErased(cred);
      if (blocked.has(name)) return false;
      const st = await readState();
      const snapInfo = await withLock(async () => {
        const storage = await local.get([...merge.STORAGE_KEYS, META_KEY]);
        const allMeta = storage[META_KEY] || {};
        const records = withoutErased(name, merge.recordsOf(name, storage), storage.erasedIds);   // never pushes an erased person (section 10.9)
        const meta = merge.prune(merge.stamp(records, allMeta[name], st.deviceId, now(), merge.DATASETS[name].growOnly), now());
        await local.set({ [META_KEY]: { ...allMeta, [name]: meta } });
        return { snap: merge.snapshotOf(records, meta), empty: Object.keys(meta).length === 0 };
      });
      const hash = merge.snapshotHash(snapInfo.snap);
      if (st.pushedHash[name] === hash) return false;
      if (snapInfo.empty && st.versions[name] === undefined) return false;   // nothing here and nothing there
      const expected = st.versions[name] || 0;
      const sealed = await crypto.encryptDataset(cred.key, { keyId: cred.keyId, dataset: name, version: expected + 1 }, snapInfo.snap);   // the version this row will get
      if (Math.floor((sealed.ciphertext.length * 3) / 4) > ROW_CAP_BYTES) { await setError(fail('row_too_large'), { dataset: name }); return false; }
      try {
        const r = await call({ action: 'put', dataset: name, expected_version: expected, iv: sealed.iv, ciphertext: sealed.ciphertext, device_id: st.deviceId, key_id: cred.keyId });
        const cur = await readState();
        await patchState({ versions: { ...cur.versions, [name]: r.version }, pushedHash: { ...cur.pushedHash, [name]: hash } });
        if (Number.isInteger(r.version)) await noteSeen(cred.keyId, name, r.version);
        return true;
      } catch (e) {
        if (errCode(e) === 'version_conflict' && !retried) {   // another computer went first: merge theirs in, then push the result once
          // Section 10.9: against the newest erase list, and with this computer cleaned again, so the retry can never carry an erased person.
          const before = await erasedNow();
          if (name !== 'erased') await pullErased(cred);
          await pullOne(name, cred);
          if (name !== 'erased') await enforceErasures(before);
          return pushOne(name, cred, { retried: true });
        }
        throw e;
      }
    }

    // ── erased consultants (schema 20, spec section 10.9) ──
    const ERASE_STATE_KEYS = ['consultants', 'submissions', 'contactNotes', 'matchStatus', 'matchSeen', 'notRelevant', 'allLeads', 'erasedIds'];
    /** records without those that name an erased consultant (they become deletions in the pushed snapshot). */
    function withoutErased(name, records, erasedIds) {
      const test = merge.ERASED_BY && merge.ERASED_BY[name];
      const set = test ? merge.erasedSet(erasedIds) : null;
      if (!set || !set.size) return records;
      const out = new Map();
      for (const [id, r] of records) if (!test(r, id, set)) out.set(id, r);
      return out;
    }
    const erasedNow = async () => merge.erasedSet((await local.get('erasedIds')).erasedIds);
    /**
     * After the pulls: this computer respects the erase list. BP.Consent.applyErasures removes or anonymises what still names an erased
     * consultant (a computer that was offline while it happened still holds them), and their résumé files leave IndexedDB. `before` = the
     * erased ids known before this run: only newly learned ones are looked up in IndexedDB.
     */
    async function enforceErasures(before) {
      const consent = deps.consent || (root.BP && root.BP.Consent) || null;
      const resumes = deps.files && deps.files.resumes;
      return withLock(async () => {
        const s = await local.get(ERASE_STATE_KEYS);
        const set = merge.erasedSet(s.erasedIds);
        if (!set.size) return 0;
        const fileIds = new Set();
        let changed = false;
        if (consent && typeof consent.applyErasures === 'function') {
          const r = consent.applyErasures(s, set, now());
          if (r.changed) { await local.set(r.patch); changed = true; }
          for (const f of r.fileIds) fileIds.add(f);
        }
        if (resumes && typeof resumes.idsForConsultant === 'function') {
          for (const id of set) if (!before.has(id)) for (const f of (await resumes.idsForConsultant(id)) || []) fileIds.add(f);
          if (fileIds.size) await resumes.remove([...fileIds]);
        }
        return changed || fileIds.size ? 1 : 0;
      });
    }

    // ── a sync run. Serialized: two runs never overlap. ──
    let running = null;
    function syncNow(opts) {
      if (!featureOn()) return Promise.resolve(null);
      if (running) return running;
      running = run(opts || {}).finally(() => { running = null; });
      return running;
    }

    async function run({ force = false, pull: pullAsked = true, push = true } = {}) {
      let pull = pullAsked;
      let st = await readState();
      if (!st.enabled) return { ok: true, skipped: 'off' };                      // sync off: no network at all
      const cred = await readKey();
      if (!cred) return { ok: true, skipped: 'locked' };                          // key not in session storage: no network at all
      const acc = await getAccount();
      if (!acc) return { ok: true, skipped: 'signed_out' };
      if (st.uid && st.uid !== acc.uid) { await patchState({ paused: 'other_account' }); return { ok: true, skipped: 'other_account' }; }
      if (await otherDataFor(acc, st)) { await patchState({ paused: 'other_account' }); return { ok: true, skipped: 'other_data' }; }   // never push another account's data
      if (!SYNC_TIERS.includes(await getTier())) { await patchState({ paused: 'plan' }); return { ok: true, skipped: 'plan' }; }
      if (!force && !pull && push && now() - st.lastPushAt < MIN_PUSH_GAP_MS) return { ok: true, skipped: 'throttled' };
      // A push-only run (the 2-minute alarm) on a computer that has not pulled for a while (asleep, offline) pulls first: it must not upload
      // anything (records, résumé files) against an erase list or data it has not seen (section 10.9).
      if (push && !pull && now() - Number(st.lastPullAt || 0) > STALE_PULL_MS) pull = true;
      blocked.clear();
      st = await patchState({ paused: null, error: null });
      try {
        let pushed = 0, pulled = 0, serverBlobs = null, serverItems = null;
        const erasedBefore = await erasedNow();
        if (pull) {
          const list = await call({ action: 'list' });
          if (list.has_keys !== true) throw fail('remote_off');
          if (list.key_id !== cred.keyId) throw fail('key_changed');
          const remote = (Array.isArray(list.datasets) ? list.datasets : []).filter((d) => merge.DATASET_NAMES.includes(d.dataset));
          // The erase list first (section 10.9): every other data set then merges against the newest one.
          const todo = remote.filter((d) => st.versions[d.dataset] !== d.version).sort((a, b) => (a.dataset === 'erased' ? -1 : 0) - (b.dataset === 'erased' ? -1 : 0));
          let done = 0;
          for (const d of todo) {
            await patchState({ progress: { done, total: todo.length, phase: 'download' } });
            if (await pullOne(d.dataset, cred)) pulled++;
            done++;
          }
          await patchState({ totalBytes: Number(list.total_bytes) || 0, lastPullAt: now() });
          if (list.blobs && Array.isArray(list.blobs.items)) { serverItems = list.blobs.items; serverBlobs = new Set(serverItems.map((b) => b && b.blob_id)); }
        }
        await enforceErasures(erasedBefore);                                       // section 10.9: nothing of an erased person stays or goes up
        // Resume files (phase 2): what the merged index says arrives or goes here, then this computer's new files go up before the index is pushed.
        if (blobs) await blobs.downloads(cred);
        if (blobs && push) await blobs.uploads(cred, { serverBlobs });
        if (push) {
          const names = merge.DATASET_NAMES;
          let done = 0;
          for (const name of names) {
            await patchState({ progress: { done, total: names.length, phase: 'upload' } });
            if (await pushOne(name, cred)) pushed++;
            done++;
          }
        }
        if (blobs && push) { if (serverItems) await blobs.collect(serverItems); await blobs.flushDeletes(cred); }
        let totalBytes = (await readState()).totalBytes;
        if (pushed) { try { totalBytes = Number((await call({ action: 'list' })).total_bytes) || totalBytes; } catch (_) { /* keep the old number */ } }
        const cur = await readState();
        await patchState({ progress: null, totalBytes, lastSyncedAt: now(), lastPushAt: push ? now() : cur.lastPushAt, ...(blocked.size ? {} : { error: cur.error && cur.error.dataset ? cur.error : null }) });
        return { ok: true, pushed, pulled };
      } catch (e) {
        const code = !featureOn() ? 'not_available' : errCode(e);         // switched off mid-run: stop quietly, no error note
        if (code === 'not_available') await patchState({ progress: null });
        else if (code === 'key_changed') await onKeyChanged();                        // the server refused our generation, or named another one
        else if (code === 'remote_off' || code === 'no_keys') await onRemoteOff();
        else {
          await patchState({ progress: null });
          if (code !== 'plan_required') await setError(e);
        }
        return { ok: false, error: { code: errCode(e), message: String((e && e.message) || '') } };
      }
    }

    // ── conflicts ──
    /** action 'keep-other': the other version becomes the current one (a normal edit, so it syncs). 'dismiss': forget the note. */
    async function resolveConflict(key, action) {
      const cs = (await local.get(CONFLICTS_KEY))[CONFLICTS_KEY];
      const list = Array.isArray(cs) ? cs : [];
      const c = list.find((x) => x.key === key);
      if (!c) return { ok: true };
      if (action === 'keep-other' && merge.DATASETS[c.dataset]) {
        await withLock(async () => {
          const storage = await local.get(merge.STORAGE_KEYS);
          const records = merge.recordsOf(c.dataset, storage);
          records.set(c.id, c.record);
          const patch = merge.applyPatch(c.dataset, storage, records);
          if (Object.keys(patch.set).length) await local.set(patch.set);
        });
      }
      await local.set({ [CONFLICTS_KEY]: list.filter((x) => x.key !== key) });
      return { ok: true };
    }

    /**
     * The switch changed (remote config, while the browser runs). Off: the alarms go at once; a run in progress stops at its next request.
     * On again: the alarms come back and one run starts, if sync is turned on in Settings. Locked or signed out: that run sends nothing.
     */
    async function onFeatureChanged() {
      if (!featureOn()) { await ensureAlarms(false); return { on: false }; }
      const st = await readState();
      if (!st.enabled) return { on: true, enabled: false };
      await ensureAlarms(true);
      await syncNow({ force: true });
      return { on: true, enabled: true };
    }

    async function onAlarm(name) {
      if (!featureOn()) { await ensureAlarms(false); return null; }       // a leftover alarm after a remote OFF clears itself
      if (name === PULL_ALARM) return syncNow({ pull: true, push: true });
      if (name === PUSH_ALARM) return syncNow({ pull: false, push: true });
      return null;
    }

    return { status, prepare, probe, enable, unlock, changePassphrase, prepareRotate, commitRotate, inboxAddress, disable, syncNow, resolveConflict, onAlarm, onSignOut, ensureAlarms, readState, localReset, onFeatureChanged, featureOn,
      autoStart, addPassphrase, setRemember, revealRecovery, confirmRecovery,
      pairStart, pairPoll, pairCancel, pairList, pairRespond, pairStatus, pairApprove,
      backupNow, backupSetAuto, backupUnlock, backupFetch, backupDelete, onDaily,
      PUSH_ALARM, PULL_ALARM, SYNC_TIERS, MESSAGES, SyncError, STATE_KEY, META_KEY, CONFLICTS_KEY, OWNER_KEY, KEY_SESSION, KEY_ID_SESSION,
      WRAPPED_KEY, RECOVERY_PENDING, OPT_OUT_KEY, AUTO_KEY, BACKUP_KEY };
  }

  /**
   * The non-extractable device key (spec section 10.3) in IndexedDB "bp-sync-device", store "keys", record "device". A CryptoKey made with
   * extractable: false is stored by structured clone and can never be read out as bytes. Content scripts cannot open the extension's IndexedDB.
   */
  function deviceKeyStore(idb, cryptoLib) {
    const open = () => new Promise((resolve, reject) => {
      const req = idb.open('bp-sync-device', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('keys')) req.result.createObjectStore('keys'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = async (mode, fn) => {
      const db = await open();
      try {
        return await new Promise((resolve, reject) => {
          const t = db.transaction('keys', mode);
          const r = fn(t.objectStore('keys'));
          t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        });
      } finally { db.close(); }
    };
    let made = null;
    return {
      async get() { const k = await tx('readonly', (s) => s.get('device')); return k && k.type === 'secret' && k.extractable === false ? k : null; },
      async create() {
        if (!made) made = (async () => {
          const have = await this.get();
          if (have) return have;
          const k = await cryptoLib.newDeviceKey();
          await tx('readwrite', (s) => s.put(k, 'device'));
          return k;
        })().finally(() => { made = null; });
        return made;
      }
    };
  }

  root.BPSyncFactory = createSync;
  root.BPSyncDeviceKeys = deviceKeyStore;
  root.BPSyncShared = { STATE_KEY, META_KEY, CONFLICTS_KEY, OWNER_KEY, MESSAGES, SyncError };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BPSyncFactory;
}
