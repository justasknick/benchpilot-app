// lib/inbox-crypto.js - the Solo personal inbox keys and opening its emails (docs/specs/SOLO_INBOX_SPEC.md section 4). WebCrypto only; no DOM,
// no chrome.*, no network. Loaded by the service worker (importScripts: "Replace my keys" re-wraps the inbox key), by the web app ("My book" >
// Inbox, through js/bp-lib.js loadSyncLib) and by node tests. Exposes self.BPInboxCrypto.
//
//   inbox key pair  = ECDH P-256, made in the browser when the first inbox address is created; the public key (raw, 65 bytes) goes to the server
//   wrapped private = AES-GCM(sync data key, random 96-bit IV, AAD "benchpilot-inbox-v1|<key_id>|<base64url sha256(public key)>") over the
//                     PKCS#8 private key: iv || ciphertext. Unwrapping also rebuilds the public point from the private key and refuses a
//                     server public key that is not the user's own (code inbox_key_mismatch). The server also tags the public key
//                     (INBOX_KEY_TAG_SECRET) and seals nothing to a key whose tag does not match.
//   each email      = sealed by the server (supabase/functions/_shared/personal-inbox.js sealInboxMessage) with an ephemeral P-256 key:
//                     key = HKDF-SHA-256(ECDH(eph, inbox), salt = eph public || inbox public, info = "benchpilot-inbox-v1|<address_id>|<id>"),
//                     head / body = AES-GCM(key, own IV, AAD = info + "|head" / "|body") over JSON.
// The private key is imported non-extractable after unwrapping (extractable only for a moment, to rebuild its public point); the PKCS#8
// bytes are zeroed after use.
(function (root) {
  'use strict';

  const FORMAT = 'benchpilot-inbox-v1';
  const KEY_ID_RE = /^[A-Za-z0-9_-]{22}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const cryptoObj = () => root.crypto || globalThis.crypto;
  const subtle = () => {
    const c = cryptoObj();
    if (!c || !c.subtle) throw new Error('WebCrypto is not available.');
    return c.subtle;
  };

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

  /** base64url (no padding) of SHA-256 over the raw public point: binds the public key into the wrapping's AAD. */
  async function publicKeyHash(publicKeyB64) {
    const raw = b64d(publicKeyB64);
    if (raw.length !== 65 || raw[0] !== 4) throw new Error('invalid inbox key');
    return b64e(new Uint8Array(await subtle().digest('SHA-256', raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * AAD of the wrapped private key: "benchpilot-inbox-v1|<key_id>|<base64url sha256(public key)>". It names the sync key generation (a wrapping
   * cannot be passed off as another generation's) and the public key (a public key replaced on the server makes the unwrap fail).
   */
  async function wrapAad(keyId, publicKeyB64) {
    if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) throw new Error('invalid key id');
    return enc.encode(`${FORMAT}|${keyId}|${await publicKeyHash(publicKeyB64)}`);
  }
  const dataKey = (raw, usage) => subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, usage);

  /** The public key the server holds is not the one of the user's own private key: mail sealed to it cannot be trusted. */
  const MISMATCH = "Your inbox key on the server does not match your own key. Mail can't be trusted; replace your inbox address.";
  function mismatch() {
    const e = new Error(MISMATCH);
    e.code = 'inbox_key_mismatch';
    return e;
  }

  async function wrapBytes(dataKeyRaw, keyId, publicKeyB64, bytes) {
    const iv = cryptoObj().getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: await wrapAad(keyId, publicKeyB64) },
      await dataKey(dataKeyRaw, ['encrypt']), bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0); out.set(ct, 12);
    return b64e(out);
  }
  /** The PKCS#8 bytes. A wrong data key or generation, a changed wrapping or a replaced public key all fail here. */
  async function unwrapBytes(dataKeyRaw, keyId, publicKeyB64, wrappedB64) {
    const all = b64d(wrappedB64);
    if (all.length < 12 + 16 + 1) throw new Error('invalid wrapped key');
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: await wrapAad(keyId, publicKeyB64) },
      await dataKey(dataKeyRaw, ['decrypt']), all.subarray(12)));
  }

  function b64urlToBytes(s) {
    const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    return b64d(t + '='.repeat((4 - (t.length % 4)) % 4));
  }
  /**
   * Checks that the private key (PKCS#8) belongs to the public key the server holds: imports it extractable only here, exports the JWK, rebuilds
   * the uncompressed point 04 || x || y and compares. Throws inbox_key_mismatch when it differs.
   */
  async function checkPublicKey(pkcs8, publicKeyB64) {
    const jwk = await subtle().exportKey('jwk', await subtle().importKey('pkcs8', pkcs8, CURVE, true, ['deriveBits']));
    let x, y;
    try { x = b64urlToBytes(jwk.x); y = b64urlToBytes(jwk.y); } finally { delete jwk.d; }
    const server = b64d(publicKeyB64);
    if (x.length !== 32 || y.length !== 32 || server.length !== 65) throw mismatch();
    const own = new Uint8Array(65);
    own[0] = 4; own.set(x, 1); own.set(y, 33);
    let diff = 0;
    for (let i = 0; i < 65; i++) diff |= own[i] ^ server[i];
    if (diff !== 0) throw mismatch();
  }

  /** A new inbox key pair for the sync generation keyId. -> { publicKey (base64 raw point), wrappedPrivateKey (base64), keyId } */
  async function createInboxKeys(dataKeyRaw, keyId) {
    const pair = await subtle().generateKey(CURVE, true, ['deriveBits']);
    const pub = b64e(new Uint8Array(await subtle().exportKey('raw', pair.publicKey)));
    const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));
    try {
      return { publicKey: pub, wrappedPrivateKey: await wrapBytes(dataKeyRaw, keyId, pub, pkcs8), keyId };
    } finally { pkcs8.fill(0); }
  }

  /**
   * The inbox private key (non-extractable CryptoKey) from its wrapping, checked against the server's public key. Throws when the data key or
   * the generation is wrong, the wrapping was changed or the public key replaced (AAD), or the private key is not the public key's
   * (code inbox_key_mismatch).
   */
  async function unwrapInboxKey(dataKeyRaw, keyId, wrappedB64, publicKeyB64) {
    const pkcs8 = await unwrapBytes(dataKeyRaw, keyId, publicKeyB64, wrappedB64);
    try {
      await checkPublicKey(pkcs8, publicKeyB64);
      return await subtle().importKey('pkcs8', pkcs8, CURVE, false, ['deriveBits']);
    } finally { pkcs8.fill(0); }
  }

  /** "Replace my keys": the same inbox private key (checked against its public key), wrapped with the new data key for the new generation. */
  async function rewrapInboxKey(oldRaw, oldKeyId, newRaw, newKeyId, wrappedB64, publicKeyB64) {
    const pkcs8 = await unwrapBytes(oldRaw, oldKeyId, publicKeyB64, wrappedB64);
    try {
      await checkPublicKey(pkcs8, publicKeyB64);
      return await wrapBytes(newRaw, newKeyId, publicKeyB64, pkcs8);
    } finally { pkcs8.fill(0); }
  }

  function messageInfo(addressId, id) {
    if (!UUID_RE.test(String(addressId)) || !UUID_RE.test(String(id))) throw new Error('invalid binding');
    return `${FORMAT}|${String(addressId).toLowerCase()}|${String(id).toLowerCase()}`;
  }

  /**
   * Opens one part ('head' or 'body') of a stored email. row = { id, address_id, eph_public_key, head_iv, head_ct } or the body fields.
   * publicKeyB64 = the inbox public key (it is part of the HKDF salt). Throws when anything was changed or moved to another row or address.
   */
  async function openPart(privateKey, publicKeyB64, row, part) {
    if (part !== 'head' && part !== 'body') throw new Error('invalid part');
    const info = messageInfo(row.address_id, row.id);
    const ephRaw = b64d(row.eph_public_key);
    const recipientRaw = b64d(publicKeyB64);
    if (ephRaw.length !== 65 || recipientRaw.length !== 65) throw new Error('invalid key');
    const eph = await subtle().importKey('raw', ephRaw, CURVE, false, []);
    const shared = await subtle().deriveBits({ name: 'ECDH', public: eph }, privateKey, 256);
    const salt = new Uint8Array(130);
    salt.set(ephRaw, 0); salt.set(recipientRaw, 65);
    const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const key = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64d(row[part + '_iv']), additionalData: enc.encode(`${info}|${part}`) }, key, b64d(row[part + '_ct']));
    return JSON.parse(dec.decode(pt));
  }

  root.BPInboxCrypto = { FORMAT, MISMATCH, b64e, b64d, wrapAad, publicKeyHash, createInboxKeys, unwrapInboxKey, rewrapInboxKey, messageInfo, openPart };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BPInboxCrypto;
}
