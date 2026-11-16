// lib/sync-blob-read.js - Reading one synced resume file (encrypted sync phase 2): the pure parts of background/sync-blobs.js downloadOne,
// shared by the extension's service worker and the web app's "My book" (webapp/js/vault.js), so both check the server's link, read the
// body and open the file with exactly the same code. No chrome.*, no DOM, no network: the caller fetches. Exposes self.BPSyncBlobRead.
// Design: docs/specs/ENCRYPTED_SYNC_SPEC.md section 9, "Resume files".
//
//   checkSignedUrl(storageBase, url, fail)  the signed Storage link from `blob-get`: exactly this project's origin over https, a path under the
//                                           storage object prefix, no dot segments, no encoded dots / slashes / backslashes. Returns url.href.
//   readLimited(res, want, fail)            the response body, exactly `want` bytes or a refusal (Content-Length checked first; never read past).
//   openBlob(crypto, cred, rec, sealed, fail)  unwraps the file key (rec.k) with the data key, decrypts (AAD bound to blobId and version),
//                                           zeroes the file key, checks the SHA-256 of the plaintext against rec.h. Returns the bytes.
// fail(code, message) -> Error (the caller's error type). Every refusal is 'invalid_url' or 'blob_failed'.
(function (root) {
  'use strict';

  function checkSignedUrl(storageBase, u, fail) {
    const bad = () => fail('invalid_url', 'The server sent an unexpected file address. Nothing was sent.');
    let base = null;
    try { base = storageBase ? new URL(String(storageBase)) : null; } catch (_) { base = null; }
    if (typeof u !== 'string' || !base || base.protocol !== 'https:') throw bad();
    if (/%2e|%2f|%5c|\\/i.test(u)) throw bad();
    let url;
    try { url = new URL(u); } catch (_) { throw bad(); }
    if (url.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password) throw bad();
    const prefix = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
    if (!url.pathname.startsWith(prefix) || url.pathname.split('/').some((seg) => seg === '.' || seg === '..')) throw bad();
    if (!/^[A-Za-z0-9_\-./]+$/.test(url.pathname)) throw bad();
    return url.href;
  }

  async function readLimited(res, want, fail) {
    const len = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
    if (len !== null && len !== undefined && Number(len) !== want) throw fail('blob_failed');
    if (!res || !res.body || typeof res.body.getReader !== 'function') throw fail('blob_failed');
    const out = new Uint8Array(want);
    const reader = res.body.getReader();
    let got = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (got + value.length > want) throw fail('blob_failed');
        out.set(value, got); got += value.length;
      }
    } finally {
      try { reader.cancel().catch(() => {}); } catch (_) { /* already closed */ }
    }
    if (got !== want) throw fail('blob_failed');
    return out;
  }

  /** cred = { key: data key bytes, keyId }. rec = a valid `resumes` index record. */
  async function openBlob(crypto, cred, rec, sealed, fail) {
    let key;
    try { key = await crypto.unwrapBlobKey(cred.key, cred.keyId, rec.blobId, rec.k); } catch (_) { throw fail('blob_failed'); }   // another generation: a newer index will come
    let bytes;
    try { bytes = await crypto.decryptBlob(key, { blobId: rec.blobId, version: rec.v }, sealed); } finally { key.fill(0); }
    if ((await crypto.sha256Hex(bytes)) !== rec.h) throw fail('blob_failed');
    return bytes;
  }

  root.BPSyncBlobRead = { checkSignedUrl, readLimited, openBlob };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BPSyncBlobRead;
}
