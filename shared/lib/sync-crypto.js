// lib/sync-crypto.js - End-to-end encryption for sync. WebCrypto only; no DOM, no chrome.*, no network.
// Loaded by the service worker (importScripts) and by node tests. Exposes self.BPSyncCrypto. Design: docs/specs/ENCRYPTED_SYNC_SPEC.md "Key design (as built)".
//
//   passphrase --PBKDF2-SHA-256 (600,000 rounds, random 16-byte salt)--> 256 bits --HKDF--> wrap key (AES-GCM) + verify key (HMAC)
//   recovery code (24 chars, 120 bits) --HKDF (own random salt)--> recovery wrap key (AES-GCM)
//   data key: random 256-bit AES-GCM key, made once, with a key_id (random 128 bits, base64url) naming this key generation. The server
//   refuses any write naming another key_id, so a computer holding an old data key can never overwrite data made with a new one. It is stored on the server wrapped twice (by the passphrase key and by the recovery key).
//   verifier = HMAC-SHA-256(verify key, "benchpilot-sync-v1"): lets a wrong passphrase be refused without the server learning anything.
//   each data set: JSON -> gzip -> AES-GCM(data key, random 96-bit IV, AAD = "benchpilot-sync-v2|<key_id>|<dataset>|<version>"), where <version> is the
//   version the server gives that row (expected_version + 1). A server replaying an older genuine row can only serve it under its own, older version,
//   which background/sync.js refuses (it keeps the highest version seen per data set and key generation). v1 rows (no key_id, no version) are not
//   read any more: sync never went live with them (format bump, review 13 Nov 2026).
// The data key is kept in chrome.storage.session (see background/sync.js) and is never sent. With "remember on this computer" (section 10.3)
// it is also kept in chrome.storage.local, but only sealed with a non-extractable device key that lives in IndexedDB (sealWith / openWith).
// Section 10 (sync on by default, 14 Nov 2026): the passphrase wrapping is optional; key_check (public) ties a data key to its key_id; device
// pairing (pairStart ... pairUnwrap) hands the data key to a new device through the server.
// Section 10.8 (migration 0054): key changes and pairing approvals are authorised by a SIGNATURE over a single-use server challenge. Each key
// generation has an ECDSA P-256 signing key: the server keeps only the public key (sign_pub) and the private key wrapped with the data key
// (wrapped_sign_key), so neither the server nor anyone reading its logs or database can produce a valid answer to a future challenge.
// The static key_proof of 0044 (keyProofFor) is used once only, to attach a signing key to a 0044 key row (sign-upgrade).
(function (root) {
  'use strict';

  const ITERATIONS = 600000;
  const MIN_ITERATIONS = 600000;     // the same bounds the server enforces (supabase/functions/_shared/sync.js). Values from the server outside
  const MAX_ITERATIONS = 5000000;    // them are refused: too few weakens the passphrase, too many is a denial of service on this computer.
  const KEY_ID_RE = /^[A-Za-z0-9_-]{22}$/;
  const KDF_ALG = 'PBKDF2-SHA-256';
  const VERIFIER_TEXT = 'benchpilot-sync-v1';
  const MIN_PASSPHRASE = 12;
  const RECOVERY_LENGTH = 24;
  const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols (no I, O, 0, 1): 5 bits each, 120 bits in total
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const subtle = () => {
    const c = root.crypto || (typeof globalThis !== 'undefined' && globalThis.crypto);
    if (!c || !c.subtle) throw new Error('WebCrypto is not available.');
    return c.subtle;
  };
  const rand = (n) => { const b = new Uint8Array(n); (root.crypto || globalThis.crypto).getRandomValues(b); return b; };

  // ── base64 ──
  function b64e(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64d(s) {
    const bin = atob(String(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }
  const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };

  // ── gzip (CompressionStream: Chrome 80+, Node 18+) ──
  async function pipe(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }
  const gzip = (bytes) => pipe(bytes, new CompressionStream('gzip'));
  const gunzip = (bytes) => pipe(bytes, new DecompressionStream('gzip'));

  // ── passphrase ──
  function normalizePassphrase(p) { return String(p == null ? '' : p).normalize('NFKC'); }
  // A short list of the passwords people pick most often (letters only, lower case: digits and symbols around them are ignored when comparing).
  const COMMON = new Set(['password', 'passw', 'passwd', 'passphrase', 'qwerty', 'qwertyuiop', 'qwertyuiopasdf', 'asdfghjkl', 'asdf', 'zxcvbnm', 'qazwsx',
    'abc', 'abcdef', 'abcdefgh', 'abcdefghijkl', 'iloveyou', 'letmein', 'welcome', 'admin', 'administrator', 'login', 'monkey', 'dragon', 'football',
    'cricket', 'baseball', 'sunshine', 'princess', 'shadow', 'master', 'superman', 'batman', 'trustno', 'freedom', 'whatever', 'starwars', 'secret',
    'changeme', 'default', 'hello', 'helloworld', 'india', 'mumbai', 'hyderabad', 'bangalore', 'chennai', 'delhi', 'computer', 'internet', 'google',
    'linkedin', 'recruiter', 'benchsales', 'myname', 'mypassword', 'test', 'testing', 'user', 'guest', 'root', 'pass', 'pakistan', 'krishna', 'sairam', 'omsairam']);
  const classesOf = (s) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
  /**
   * null when acceptable, otherwise the short reason to show. ctx.email (the signed-in account) is refused as part of the passphrase.
   * Rules: 12+ characters; not one repeated character or a short repeated pattern; not only numbers; under 16 characters it needs at least two kinds of
   * characters (lower case, upper case, numbers, symbols or spaces); not a common password with numbers or symbols around it; and at least 12 characters
   * must remain once the email, its name part and the word "benchpilot" are taken out. No network, no dictionary download.
   */
  function passphraseProblem(p, ctx) {
    const s = normalizePassphrase(p);
    if (s.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
    if (/^(.)\1+$/.test(s)) return 'Please use more than one repeated character.';
    if (/^(.{1,4})\1+$/su.test(s)) return 'Do not repeat a short pattern. Use a few unrelated words.';
    if (/^[0-9\s]+$/.test(s)) return 'Do not use only numbers. Use a few unrelated words.';
    if (s.length < 16 && classesOf(s) < 2) return 'Use 16 or more characters, or mix in numbers, capitals or symbols.';
    const lower = s.toLowerCase();
    const letters = lower.replace(/[^a-z]/g, '');
    if (COMMON.has(letters) || (letters.length >= 3 && [...COMMON].some((w) => w.length >= 3 && letters.replace(new RegExp(w, 'g'), '') === '' && letters.length > w.length && letters.length % w.length === 0)))
      return 'That is a commonly used password. Use a few unrelated words.';
    const email = String((ctx && ctx.email) || '').trim().toLowerCase();
    const parts = ['benchpilot', 'bench pilot', 'bench-pilot'];
    if (email) { parts.push(email); const local = email.split('@')[0]; if (local.length >= 3) parts.push(local); }
    let rest = lower;
    for (const w of parts.sort((a, b) => b.length - a.length)) rest = rest.split(w).join('');
    if (rest !== lower && rest.replace(/[^\p{L}\p{N}]/gu, '').length < MIN_PASSPHRASE) return 'Do not build it on your email address or the word BenchPilot.';
    return null;
  }

  async function hkdfKeys(ikm, salt, infoBase) {
    const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    const derive = (info, algo, usages) => subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(`${VERIFIER_TEXT}/${infoBase}/${info}`) }, base, algo, false, usages);
    return { derive };
  }

  const validIterations = (n) => Number.isInteger(n) && n >= MIN_ITERATIONS && n <= MAX_ITERATIONS;
  /** A key generation id: 16 random bytes, base64url without padding (22 characters). */
  const newKeyId = () => b64e(rand(16)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const validKeyId = (v) => typeof v === 'string' && KEY_ID_RE.test(v);
  /** Key data from the server is untrusted: refuse it (no derivation at all) unless every field the computer relies on is sane. */
  function serverKeysProblem(k) {
    if (!k || typeof k !== 'object' || !k.kdf_params || typeof k.kdf_params !== 'object') return 'invalid_keys';
    if (!validKeyId(k.key_id)) return 'invalid_keys';
    if (hasPassphrase(k) && !validIterations(k.kdf_params.iterations)) return 'invalid_keys';
    if (k.key_check != null && !(typeof k.key_check === 'string' && b64Len(k.key_check) === 32)) return 'invalid_keys';
    // Section 10.8: the signing key is both or neither (the wrapped private key is opened only when an action is signed).
    if ((k.sign_pub == null) !== (k.wrapped_sign_key == null)) return 'invalid_keys';
    if (k.sign_pub != null && !(typeof k.sign_pub === 'string' && b64Len(k.sign_pub) === 65 && typeof k.wrapped_sign_key === 'string' && b64Len(k.wrapped_sign_key) === 60)) return 'invalid_keys';
    return null;
  }
  /** Section 10.2: the passphrase wrapping is optional (all of salt, verifier and wrapped_key_pass, or none). */
  function hasPassphrase(k) {
    return Boolean(k && typeof k.salt === 'string' && k.salt && typeof k.verifier === 'string' && k.verifier && typeof k.wrapped_key_pass === 'string' && k.wrapped_key_pass);
  }
  function b64Len(v) { try { return b64d(v).length; } catch (_) { return -1; } }

  /** Passphrase + salt -> { wrapKey (AES-GCM, wrap/unwrap data key), verifyKey (HMAC) }. Throws on an iteration count outside 600,000-5,000,000. */
  async function deriveFromPassphrase(passphrase, salt, iterations) {
    const iters = iterations === undefined ? ITERATIONS : iterations;
    if (!validIterations(iters)) throw new Error('invalid iterations');
    const pw = await subtle().importKey('raw', enc.encode(normalizePassphrase(passphrase)), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters }, pw, 256));
    const { derive } = await hkdfKeys(bits, new Uint8Array(0), 'passphrase');
    return {
      wrapKey: await derive('wrap', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
      verifyKey: await derive('verify', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign'])
    };
  }

  async function verifierFor(verifyKey) {
    return new Uint8Array(await subtle().sign('HMAC', verifyKey, enc.encode(VERIFIER_TEXT)));
  }

  // ── recovery code ──
  function generateRecoveryCode() {
    const bytes = rand(RECOVERY_LENGTH);
    let s = '';
    for (const b of bytes) s += RECOVERY_ALPHABET[b & 31];
    return s;
  }
  /** "abcd-efgh ..." -> "ABCDEFGH...". Returns '' when the result is not a valid code. */
  function normalizeRecoveryCode(input) {
    const s = String(input || '').toUpperCase().replace(/[\s-]/g, '');
    return s.length === RECOVERY_LENGTH && [...s].every((c) => RECOVERY_ALPHABET.includes(c)) ? s : '';
  }
  const formatRecoveryCode = (code) => String(code).match(/.{1,4}/g).join('-');

  async function recoveryWrapKey(code, recoverySalt) {
    const { derive } = await hkdfKeys(enc.encode(code), recoverySalt, 'recovery');
    return derive('wrap', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
  }

  // ── wrapping the data key (iv || ciphertext+tag) ──
  const WRAP_AAD = enc.encode(`${VERIFIER_TEXT}|data-key`);
  async function wrap(dataKeyRaw, wrapKey) {
    const iv = rand(12);
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: WRAP_AAD }, wrapKey, dataKeyRaw));
    return concat(iv, ct);
  }
  async function unwrap(wrapped, wrapKey) {
    const w = wrapped instanceof Uint8Array ? wrapped : new Uint8Array(wrapped);
    if (w.length < 28) throw new Error('bad wrapped key');
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: w.subarray(0, 12), additionalData: WRAP_AAD }, wrapKey, w.subarray(12)));
  }

  /**
   * First-time setup on this account. Returns:
   *   dataKeyRaw  Uint8Array(32)  keep in storage.session only
   *   recoveryCode string         show once, never store
   *   keyId       string          the key generation id (also in serverKeys.key_id)
   *   serverKeys  { salt, kdf_params, verifier, wrapped_key_pass, wrapped_key_recovery, key_id, key_check, sign_pub, wrapped_sign_key }
   *               (base64) for the `init-keys` / `rotate-keys` action
   */
  async function createAccountKeys(passphrase, iterations, opts) {
    // Section 10: sync on by default. opts.noPassphrase makes keys without a passphrase (the recovery code, pairing and "remember on this
    // computer" open them); a passphrase can be added later (rewrapForNewPassphrase). "Replace my keys" keeps the current passphrase, which was
    // accepted when it was chosen: opts.keepPassphrase skips the strength check.
    const noPass = Boolean(opts && opts.noPassphrase);
    if (!noPass) {
      const problem = opts && opts.keepPassphrase ? (normalizePassphrase(passphrase) ? null : 'Enter your passphrase.') : passphraseProblem(passphrase);
      if (problem) throw new Error(problem);
    }
    const iters = iterations === undefined ? ITERATIONS : iterations;
    const keyId = newKeyId();
    const recoverySalt = rand(16);
    const dataKeyRaw = rand(32);
    const recoveryCode = generateRecoveryCode();
    const serverKeys = {
      key_id: keyId,
      kdf_params: noPass ? { recovery_salt: b64e(recoverySalt) } : { alg: KDF_ALG, iterations: iters, recovery_salt: b64e(recoverySalt) },
      wrapped_key_recovery: b64e(await wrap(dataKeyRaw, await recoveryWrapKey(recoveryCode, recoverySalt))),
      key_check: await keyCheckFor(dataKeyRaw, keyId),
      ...(await newSigningKey(dataKeyRaw, keyId))          // section 10.8: sign_pub + wrapped_sign_key (no static proof any more)
    };
    if (!noPass) {
      const salt = rand(16);
      const { wrapKey, verifyKey } = await deriveFromPassphrase(passphrase, salt, iters);
      serverKeys.salt = b64e(salt);
      serverKeys.verifier = b64e(await verifierFor(verifyKey));
      serverKeys.wrapped_key_pass = b64e(await wrap(dataKeyRaw, wrapKey));
    }
    return { dataKeyRaw, recoveryCode, keyId, serverKeys };
  }

  // ── key check and key proof (spec section 10.2) ──
  // check: public (get-keys returns it); lets a computer refuse a data key that is not this generation's (a wrong unwrap or a substituted key).
  // proof: 0044's static secret (the server kept SHA-256 of it). Since 0054 it authorises exactly one thing: attaching a signing key to a key row
  // made by 0044 (sign-upgrade), after which the server forgets the hash. Everything else is a signed challenge (section 10.8 below).
  async function keyMac(dataKeyRaw, keyId, kind) {
    if (!validKeyId(keyId)) throw new Error('invalid key id');
    const raw = dataKeyRaw instanceof Uint8Array ? dataKeyRaw : new Uint8Array(dataKeyRaw);
    if (raw.length !== 32) throw new Error('invalid data key');
    const base = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const k = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`${VERIFIER_TEXT}/key/${kind}`) },
      base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    return b64e(new Uint8Array(await subtle().sign('HMAC', k, enc.encode(`${VERIFIER_TEXT}|key-${kind}|${keyId}`))));
  }
  const keyCheckFor = (dataKeyRaw, keyId) => keyMac(dataKeyRaw, keyId, 'check');
  const keyProofFor = (dataKeyRaw, keyId) => keyMac(dataKeyRaw, keyId, 'proof');
  /** 'match' | 'absent' (a key row made before 0044: nothing to check against) | 'mismatch'. */
  async function checkDataKey(dataKeyRaw, serverKeys) {
    const want = serverKeys && serverKeys.key_check;
    if (want == null || want === '') return 'absent';
    let got;
    try { got = await keyCheckFor(dataKeyRaw, serverKeys.key_id); } catch (_) { return 'mismatch'; }
    try { return equalBytes(b64d(got), b64d(want)) ? 'match' : 'mismatch'; } catch (_) { return 'mismatch'; }
  }
  /** A key unwrapped from (or received for) `serverKeys` is used only when its check matches, or the row has none yet. */
  async function acceptKey(dataKeyRaw, serverKeys) {
    return (await checkDataKey(dataKeyRaw, serverKeys)) === 'mismatch'
      ? { ok: false, reason: 'invalid_keys' } : { ok: true, dataKeyRaw, keyId: serverKeys.key_id };
  }

  // ── signed challenges (spec section 10.8, migration 0054) ──
  //   signing key      = ECDSA P-256, random, one per key generation (made with the data key; "Replace my keys" makes a new one)
  //   sign_pub         = its public key, 65 bytes uncompressed (the server keeps it and verifies with it)
  //   wrapped_sign_key = iv (12) || AES-GCM(data key, d (32 bytes), AAD "benchpilot-sign-v1|key|<key_id>|<sign_pub>") || tag (16) = 60 bytes
  //                      (only a holder of the data key can open it; the public key is bound in, so a swapped sign_pub fails to open)
  //   message          = "benchpilot-sign-v1|challenge|<action>|<key_id>|<nonce>|<binding>",  binding = base64(SHA-256(request fields joined by "\n"))
  //   signature        = ECDSA-SHA-256 over the message, 64 bytes (r || s)
  // The nonce is issued by the server for ONE action, bound to the account and the key generation, single use, and lives 2 minutes. The binding
  // ties the signature to this request's own values (the new passphrase wrapping, the new key row, the pairing id and wrapped key), so a captured
  // answer is useless for any other request, and the server (which holds only the public key) can check answers but never produce one.
  const SIGN_FORMAT = 'benchpilot-sign-v1';
  const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
  const SIGNED_ACTIONS = ['update-keys', 'rotate-keys', 'pair-approve'];
  const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
  const b64u = (bytes) => b64e(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64u = (v) => { const t = String(v); return b64d(t.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (t.length % 4)) % 4)); };
  const signAad = (keyId, signPub) => enc.encode(`${SIGN_FORMAT}|key|${keyId}|${signPub}`);
  function validSignPub(v) { try { const b = b64d(v); return b.length === 65 && b[0] === 4; } catch (_) { return false; } }
  /** A new signing key for this generation: { sign_pub, wrapped_sign_key } (base64). The private key exists in memory only. */
  async function newSigningKey(dataKeyRaw, keyId) {
    if (!validKeyId(keyId)) throw new Error('invalid key id');
    const kp = await subtle().generateKey(ECDSA, true, ['sign', 'verify']);
    const jwk = await subtle().exportKey('jwk', kp.privateKey);
    const pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
    const d = fromB64u(jwk.d);
    try {
      if (d.length !== 32 || pub.length !== 65) throw new Error('invalid signing key');
      const signPub = b64e(pub);
      const iv = rand(12);
      const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: signAad(keyId, signPub) }, await importDataKey(dataKeyRaw), d));
      return { sign_pub: signPub, wrapped_sign_key: b64e(concat(iv, ct)) };
    } finally { d.fill(0); }
  }
  /** The private signing key of `keys` (get-keys), opened with the data key. Throws when it is missing, of another generation, or changed. */
  async function openSigningKey(dataKeyRaw, keys) {
    if (!keys || !validKeyId(keys.key_id) || !validSignPub(keys.sign_pub)) throw new Error('no signing key');
    const w = fixedBytes(keys.wrapped_sign_key, 60, 'wrapped signing key');
    const d = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: w.subarray(0, 12), additionalData: signAad(keys.key_id, keys.sign_pub) },
      await importDataKey(dataKeyRaw), w.subarray(12)));
    try {
      const pub = b64d(keys.sign_pub);
      return await subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), ext: false },
        ECDSA, false, ['sign']);
    } finally { d.fill(0); }
  }
  const field = (v) => (v === undefined || v === null ? '' : String(v));
  /**
   * The request values a signature covers, per action. The server computes the same list from the values it stores or forwards
   * (supabase/functions/_shared/sync.js requestFields; supabase/test/sync-default.test.js checks both give the same binding).
   */
  function requestFields(action, b) {
    const body = b || {};
    if (action === 'update-keys') {
      const p = body.passphrase || {};
      return [body.key_id, p.salt, p.verifier, p.wrapped_key_pass, p.kdf_params && p.kdf_params.iterations].map(field);
    }
    if (action === 'rotate-keys') {
      const k = body.kdf_params || {};
      return [body.old_key_id, body.key_id, body.salt, body.verifier, body.wrapped_key_pass, k.iterations, k.recovery_salt, body.wrapped_key_recovery,
        body.key_check, body.sign_pub, body.wrapped_sign_key, body.inbox_wrapped_key].map(field);
    }
    if (action === 'pair-approve') return [body.id, body.key_id, body.wrapped].map(field);
    throw new Error('not a signed action');
  }
  async function challengeMessage(action, keyId, nonce, fields) {
    if (!SIGNED_ACTIONS.includes(action) || !validKeyId(keyId) || !CHALLENGE_RE.test(String(nonce))) throw new Error('invalid challenge');
    const binding = b64e(await sha256(enc.encode(fields.join('\n'))));
    return enc.encode(`${SIGN_FORMAT}|challenge|${action}|${keyId}|${nonce}|${binding}`);
  }
  /** The signature (base64, 64 bytes) answering `nonce` for `action` with these request values. */
  async function signChallenge(dataKeyRaw, keys, action, nonce, body) {
    const priv = await openSigningKey(dataKeyRaw, keys);
    const msg = await challengeMessage(action, keys.key_id, nonce, requestFields(action, body));
    return b64e(new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, msg)));
  }
  /** Verification as the server does it (the tests' fake servers use it). */
  async function verifyChallenge(signPub, action, keyId, nonce, body, signature) {
    try {
      const sig = b64d(signature);
      if (sig.length !== 64 || !validSignPub(signPub)) return false;
      const pub = await subtle().importKey('raw', b64d(signPub), ECDSA, false, ['verify']);
      return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, await challengeMessage(action, keyId, nonce, requestFields(action, body)));
    } catch (_) { return false; }
  }
  /** A 0044 key row (key_check, no sign_pub) that a holder of the data key upgrades with its static proof, once. */
  const needsSignUpgrade = (keys) => Boolean(keys && keys.key_check && !keys.sign_pub);
  /** The body of `sign-upgrade` for such a row: a new signing key, authorised by the 0044 proof (the server then deletes the proof hash). */
  async function signUpgradeBody(dataKeyRaw, keys) {
    return { action: 'sign-upgrade', key_id: keys.key_id, current_proof: await keyProofFor(dataKeyRaw, keys.key_id), ...(await newSigningKey(dataKeyRaw, keys.key_id)) };
  }
  /**
   * The whole authorisation of one signed action. `call(body)` is the caller's request function (this file still makes no request itself).
   * Upgrades a 0044 row first when needed, asks the server for a challenge for exactly this action, and returns the body to send.
   * Throws an error with code 'key_changed' when the server names another key generation, 'wrong_key' when the row cannot sign at all
   * (a smoke-test row from before 0044: turn sync off and set it up again).
   */
  async function authorize(dataKeyRaw, keys, action, body, call) {
    const err = (code) => Object.assign(new Error(code), { code });
    let k = keys;
    if (needsSignUpgrade(k)) {
      const up = await signUpgradeBody(dataKeyRaw, k);
      try {
        await call(up);
        k = { ...k, sign_pub: up.sign_pub, wrapped_sign_key: up.wrapped_sign_key };
      } catch (e) {
        if (!e || e.code !== 'sign_exists') throw e;
        k = await call({ action: 'get-keys' });   // another computer upgraded the row first: use its signing key
        if (!k || k.key_id !== keys.key_id) throw err('key_changed');
      }
    }
    if (!validSignPub(k && k.sign_pub)) throw err('wrong_key');
    // The signing key must open with this data key before anything is asked (a row whose signing key was replaced, for example through a
    // captured 0044 proof before this computer upgraded it, cannot sign: the user turns sync off and sets it up again).
    try { await openSigningKey(dataKeyRaw, k); } catch (_) { throw err('wrong_key'); }
    const ch = await call({ action: 'challenge', for: action });
    if (!ch || ch.key_id !== k.key_id) throw err('key_changed');
    let signature;
    try { signature = await signChallenge(dataKeyRaw, k, action, ch.nonce, body); } catch (_) { throw err('wrong_key'); }
    return { ...body, action, challenge: ch.nonce, signature };
  }

  /** Passphrase check against the stored verifier, then unwrap. { ok:true, dataKeyRaw, keyId } | { ok:false, reason:'wrong_passphrase' | 'invalid_keys' }. */
  async function unlockWithPassphrase(passphrase, serverKeys) {
    const problem = serverKeysProblem(serverKeys);
    if (problem) return { ok: false, reason: problem };
    if (!hasPassphrase(serverKeys)) return { ok: false, reason: 'no_passphrase' };
    const k = serverKeys.kdf_params;
    const { wrapKey, verifyKey } = await deriveFromPassphrase(passphrase, b64d(serverKeys.salt), k.iterations);
    if (!equalBytes(await verifierFor(verifyKey), b64d(serverKeys.verifier))) return { ok: false, reason: 'wrong_passphrase' };
    let raw;
    try { raw = await unwrap(b64d(serverKeys.wrapped_key_pass), wrapKey); } catch (_) { return { ok: false, reason: 'wrong_passphrase' }; }
    return acceptKey(raw, serverKeys);
  }

  /** { ok:true, dataKeyRaw, keyId } | { ok:false, reason:'bad_format' | 'wrong_recovery_code' | 'invalid_keys' }. */
  async function unlockWithRecovery(codeInput, serverKeys) {
    const code = normalizeRecoveryCode(codeInput);
    if (!code) return { ok: false, reason: 'bad_format' };
    const problem = serverKeysProblem(serverKeys);
    if (problem) return { ok: false, reason: problem };
    const rs = serverKeys.kdf_params && serverKeys.kdf_params.recovery_salt;
    if (!rs) return { ok: false, reason: 'wrong_recovery_code' };
    let raw;
    try { raw = await unwrap(b64d(serverKeys.wrapped_key_recovery), await recoveryWrapKey(code, b64d(rs))); } catch (_) { return { ok: false, reason: 'wrong_recovery_code' }; }
    return acceptKey(raw, serverKeys);
  }

  /** Passphrase change: new salt, verifier and passphrase wrapping of the SAME data key, so the SAME key_id. The recovery wrapping is untouched (not sent). */
  async function rewrapForNewPassphrase(dataKeyRaw, newPassphrase, oldServerKeys, iterations) {
    const problem = passphraseProblem(newPassphrase);
    if (problem) throw new Error(problem);
    if (!validKeyId(oldServerKeys.key_id)) throw new Error('invalid key id');
    const iters = iterations === undefined ? ITERATIONS : iterations;
    const salt = rand(16);
    const { wrapKey, verifyKey } = await deriveFromPassphrase(newPassphrase, salt, iters);
    return {
      key_id: oldServerKeys.key_id,
      salt: b64e(salt),
      kdf_params: { alg: KDF_ALG, iterations: iters, recovery_salt: oldServerKeys.kdf_params && oldServerKeys.kdf_params.recovery_salt },
      verifier: b64e(await verifierFor(verifyKey)),
      wrapped_key_pass: b64e(await wrap(dataKeyRaw, wrapKey))
    };
  }

  // ── device pairing (spec section 10.5): "Approve from your other computer" ──
  // A short-authentication-string exchange through the server. The new device N commits to its nonce before the approver A picks its key and
  // nonce, and reveals it only after, so a server relaying the messages cannot pick values that make the two six-symbol codes match.
  const PAIR_FORMAT = 'benchpilot-pair-v1';
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  const validPairId = (v) => typeof v === 'string' && KEY_ID_RE.test(v);
  function fixedBytes(v, n, what) {
    let raw;
    try { raw = b64d(v); } catch (_) { throw new Error(`invalid ${what}`); }
    if (raw.length !== n) throw new Error(`invalid ${what}`);
    return raw;
  }
  function pubBytes(pubB64) {
    const raw = fixedBytes(pubB64, 65, 'public key');
    if (raw[0] !== 4) throw new Error('invalid public key');
    return raw;
  }
  const nonceBytes = (v) => fixedBytes(v, 16, 'nonce');
  const join = (...parts) => {
    const o = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let i = 0;
    for (const p of parts) { o.set(p, i); i += p.length; }
    return o;
  };
  const sha256 = async (bytes) => new Uint8Array(await subtle().digest('SHA-256', bytes));
  /** An ephemeral ECDH P-256 pair (the private key cannot be exported) and a 16-byte nonce. */
  async function pairKeys() {
    const kp = await subtle().generateKey(ECDH, false, ['deriveBits']);
    return { privateKey: kp.privateKey, pub: b64e(new Uint8Array(await subtle().exportKey('raw', kp.publicKey))), nonce: b64e(rand(16)) };
  }
  async function pairCommit(newPubB64, newNonceB64) {
    return b64e(await sha256(join(enc.encode(`${PAIR_FORMAT}|commit|`), pubBytes(newPubB64), nonceBytes(newNonceB64))));
  }
  /** The new device: { privateKey, pub, nonce, commit }. privateKey and nonce stay in memory; pub and commit go with pair-create. */
  async function pairStart() {
    const k = await pairKeys();
    return { ...k, commit: await pairCommit(k.pub, k.nonce) };
  }
  /** The approver: does the revealed nonce open the commitment the new device sent first? */
  async function pairCheckCommit(newPubB64, newNonceB64, commitB64) {
    try { return equalBytes(b64d(await pairCommit(newPubB64, newNonceB64)), b64d(commitB64)); } catch (_) { return false; }
  }
  /** "ABC-DEF": 6 symbols of the recovery alphabet (30 bits) over the request id, both public keys and both nonces. */
  async function pairCode(id, { newPub, approverPub, newNonce, approverNonce } = {}) {
    if (!validPairId(id)) throw new Error('invalid pairing id');
    const h = await sha256(join(enc.encode(`${PAIR_FORMAT}|code|${id}|`), pubBytes(newPub), pubBytes(approverPub), nonceBytes(newNonce), nonceBytes(approverNonce)));
    let s = '';
    for (let i = 0; i < 6; i++) s += RECOVERY_ALPHABET[h[i] & 31];
    return `${s.slice(0, 3)}-${s.slice(3)}`;
  }
  async function pairWrapKey(myPrivateKey, otherPubB64, { id, keyId, newPub, approverPub }) {
    if (!validPairId(id)) throw new Error('invalid pairing id');
    if (!validKeyId(keyId)) throw new Error('invalid key id');
    const other = await subtle().importKey('raw', pubBytes(otherPubB64), ECDH, false, []);   // also refuses a point that is not on the curve
    const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: other }, myPrivateKey, 256));
    const base = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    shared.fill(0);
    return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: await sha256(join(pubBytes(newPub), pubBytes(approverPub))),
      info: enc.encode(`${PAIR_FORMAT}|wrap|${id}|${keyId}`) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  /** The approver, after the user saw the same code on both screens: the data key wrapped for the new device (base64 of 60 bytes). */
  async function pairWrap(approverPrivateKey, bind, dataKeyRaw) {
    const raw = dataKeyRaw instanceof Uint8Array ? dataKeyRaw : new Uint8Array(dataKeyRaw);
    if (raw.length !== 32) throw new Error('invalid data key');
    const k = await pairWrapKey(approverPrivateKey, bind.newPub, bind);
    const iv = rand(12);
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${PAIR_FORMAT}|${bind.id}|${bind.keyId}`) }, k, raw));
    return b64e(concat(iv, ct));
  }
  /** The new device: the data key. Throws when anything (keys, id, key generation, a byte) is not what was agreed. */
  async function pairUnwrap(newPrivateKey, bind, wrappedB64) {
    const w = fixedBytes(wrappedB64, 60, 'wrapped key');
    const k = await pairWrapKey(newPrivateKey, bind.approverPub, bind);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: w.subarray(0, 12), additionalData: enc.encode(`${PAIR_FORMAT}|${bind.id}|${bind.keyId}`) }, k, w.subarray(12)));
  }

  // ── "remember on this computer" (spec section 10.3): sealing with the non-extractable device key ──
  /** A fresh non-extractable AES-GCM key (stored as a CryptoKey in IndexedDB by the service worker; it can never be read out as bytes). */
  const newDeviceKey = () => subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  /** base64(iv || AES-GCM(cryptoKey, bytes, AAD)). */
  async function sealWith(cryptoKey, bytes, aadText) {
    const iv = rand(12);
    return b64e(concat(iv, new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aadText) }, cryptoKey, bytes))));
  }
  /** Throws when the key, the AAD or a byte does not match. */
  async function openWith(cryptoKey, sealedB64, aadText) {
    const s = b64d(sealedB64);
    if (s.length < 28) throw new Error('bad sealed value');
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: s.subarray(0, 12), additionalData: enc.encode(aadText) }, cryptoKey, s.subarray(12)));
  }

  // ── data sets ──
  const importDataKey = (raw) => subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const DATA_FORMAT = 'benchpilot-sync-v2';
  /** Additional data of a data set row: binds the key generation, the data set name and the row's version. Throws on a malformed binding. */
  function aad({ keyId, dataset, version } = {}) {
    if (!validKeyId(keyId)) throw new Error('invalid key id');
    if (typeof dataset !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(dataset)) throw new Error('invalid dataset');
    if (!Number.isInteger(version) || version < 1 || version > 2147483647) throw new Error('invalid version');
    return enc.encode(`${DATA_FORMAT}|${keyId}|${dataset}|${version}`);
  }

  /** bind = { keyId, dataset, version } (version = the version the server will give this row: expected_version + 1).
   *  value (any JSON) -> { iv, ciphertext } as base64. Compresses first, then encrypts with a fresh random IV. */
  async function encryptDataset(dataKeyRaw, bind, value) {
    const ad = aad(bind);
    const packed = await gzip(enc.encode(JSON.stringify(value)));
    const iv = rand(12);
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: ad }, await importDataKey(dataKeyRaw), packed));
    return { iv: b64e(iv), ciphertext: b64e(ct) };
  }

  /** bind = { keyId, dataset, version } as the server reports the row. Throws when the key is wrong, the key generation, data set name or version
   *  does not match what was encrypted, or a single byte was changed. */
  async function decryptDataset(dataKeyRaw, bind, { iv, ciphertext }) {
    const packed = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: b64d(iv), additionalData: aad(bind) }, await importDataKey(dataKeyRaw), b64d(ciphertext)));
    return JSON.parse(dec.decode(await gunzip(packed)));
  }

  // ── résumé files (phase 2): one random AES-GCM key per file ──
  // The file key is never sent or stored on its own: it is stored only wrapped with the data key (wrapBlobKey below) in the `resumes` data set
  // (the blob index), which is itself encrypted with the data key like every data set. "Replace my keys" re-wraps the file keys and re-encrypts
  // that small index; re-encrypting the files themselves (new keys, new blob ids) is an extra step the user chooses (background/sync-blobs.js).
  // File ciphertext = iv (12) || AES-GCM(file bytes) || tag (16), additional data "benchpilot-blob-v1|<blob_id>|<version>": a server cannot swap
  // one file for another or serve an older upload of the same blob id under a newer version. Files are not compressed (PDF and .docx already are).
  const BLOB_FORMAT = 'benchpilot-blob-v1';
  const BLOB_OVERHEAD = 28;
  const BLOB_ID_RE = KEY_ID_RE;
  const newBlobId = newKeyId;                       // 128 random bits, base64url, 22 characters
  const validBlobId = (v) => typeof v === 'string' && BLOB_ID_RE.test(v);
  const newBlobKey = () => rand(32);
  function blobAad({ blobId, version } = {}) {
    if (!validBlobId(blobId)) throw new Error('invalid blob id');
    if (!Number.isInteger(version) || version < 1 || version > 2147483647) throw new Error('invalid version');
    return enc.encode(`${BLOB_FORMAT}|${blobId}|${version}`);
  }
  const importBlobKey = (raw) => {
    const k = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (k.length !== 32) throw new Error('invalid blob key');
    return subtle().importKey('raw', k, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  };
  /** bind = { blobId, version } (the version the server gave the reservation). bytes -> Uint8Array iv || ciphertext || tag. */
  async function encryptBlob(blobKeyRaw, bind, bytes) {
    const ad = blobAad(bind);
    const iv = rand(12);
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: ad }, await importBlobKey(blobKeyRaw), bytes));
    return concat(iv, ct);
  }
  /** Throws when the key, the blob id or the version does not match, or a byte was changed. */
  async function decryptBlob(blobKeyRaw, bind, sealed) {
    const s = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed);
    if (s.length < BLOB_OVERHEAD) throw new Error('bad blob');
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: s.subarray(0, 12), additionalData: blobAad(bind) }, await importBlobKey(blobKeyRaw), s.subarray(12)));
  }
  // A file key AT REST (chrome.storage.local, and inside the synced `resumes` data set): wrapped with the data key, never stored in the clear.
  // "<key_id>.<base64(iv 12 || AES-GCM(file key 32) || tag 16)>", additional data "benchpilot-blobkey-v1|<key_id>|<blob_id>". So a locked
  // computer (no data key in session storage) holds no readable file key, and a wrapped key cannot be moved to another blob or generation.
  const BLOB_KEY_FORMAT = 'benchpilot-blobkey-v1';
  const WRAPPED_BLOB_KEY_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9+/]{80}$/;
  const validWrappedBlobKey = (v) => typeof v === 'string' && WRAPPED_BLOB_KEY_RE.test(v);
  const blobKeyAad = (keyId, blobId) => {
    if (!KEY_ID_RE.test(String(keyId))) throw new Error('invalid key id');
    if (!validBlobId(blobId)) throw new Error('invalid blob id');
    return enc.encode(`${BLOB_KEY_FORMAT}|${keyId}|${blobId}`);
  };
  async function wrapBlobKey(dataKeyRaw, keyId, blobId, blobKeyRaw) {
    const k = blobKeyRaw instanceof Uint8Array ? blobKeyRaw : new Uint8Array(blobKeyRaw);
    if (k.length !== 32) throw new Error('invalid blob key');
    const iv = rand(12);
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: blobKeyAad(keyId, blobId) }, await importDataKey(dataKeyRaw), k));
    return `${keyId}.${b64e(concat(iv, ct))}`;
  }
  /** The wrapping's key generation ('' when not well formed). */
  const wrappedBlobKeyId = (w) => (validWrappedBlobKey(w) ? w.slice(0, 22) : '');
  /** Throws when the wrapped key is of another generation or blob, or was changed. */
  async function unwrapBlobKey(dataKeyRaw, keyId, blobId, wrapped) {
    if (!validWrappedBlobKey(wrapped) || wrappedBlobKeyId(wrapped) !== keyId) throw new Error('blob key of another generation');
    const s = b64d(wrapped.slice(23));
    const raw = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: s.subarray(0, 12), additionalData: blobKeyAad(keyId, blobId) }, await importDataKey(dataKeyRaw), s.subarray(12)));
    if (raw.length !== 32) throw new Error('invalid blob key');
    return raw;
  }
  async function sha256Hex(bytes) {
    const h = new Uint8Array(await subtle().digest('SHA-256', bytes));
    return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  root.BPSyncCrypto = {
    ITERATIONS, MIN_ITERATIONS, MAX_ITERATIONS, MIN_PASSPHRASE, RECOVERY_LENGTH, RECOVERY_ALPHABET, VERIFIER_TEXT, DATA_FORMAT,
    b64e, b64d, passphraseProblem, validKeyId, serverKeysProblem, deriveFromPassphrase, verifierFor,
    generateRecoveryCode, normalizeRecoveryCode, formatRecoveryCode,
    createAccountKeys, unlockWithPassphrase, unlockWithRecovery, rewrapForNewPassphrase,
    hasPassphrase, keyCheckFor, keyProofFor, checkDataKey, newDeviceKey, sealWith, openWith,
    SIGN_FORMAT, SIGNED_ACTIONS, newSigningKey, openSigningKey, requestFields, challengeMessage, signChallenge, verifyChallenge,
    needsSignUpgrade, signUpgradeBody, authorize,
    PAIR_FORMAT, validPairId, pairStart, pairKeys, pairCommit, pairCheckCommit, pairCode, pairWrap, pairUnwrap,
    encryptDataset, decryptDataset,
    BLOB_FORMAT, BLOB_OVERHEAD, newBlobId, validBlobId, newBlobKey, encryptBlob, decryptBlob, sha256Hex,
    validWrappedBlobKey, wrappedBlobKeyId, wrapBlobKey, unwrapBlobKey
  };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BPSyncCrypto;
}
