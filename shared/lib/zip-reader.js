// lib/zip-reader.js - Tiny ZIP reader shared by the .xlsx and .docx readers (no third-party code).
// Reads the ZIP central directory and inflates entries with the browser's
// DecompressionStream('deflate-raw'); stored entries are copied as-is. ZIP64 is not supported.
//
//   BPZip.readDirectory(bytes, msgs) -> { entries: Map(name -> entry), dv }
//   BPZip.readEntryText(zip, bytes, name, msgs, maxEntryBytes) -> Promise<string | null>
//
// msgs (all optional) lets each caller word the errors for its own file type:
//   { fail(message) -> Error, notZip, damagedDir, zip64, noInflate, encrypted, tooLarge, damagedEntry, damagedUnpack, badMethod }
(function (root) {
  'use strict';

  const DEFAULT_MSGS = {
    notZip: 'This file is not a valid ZIP-based document.',
    damagedDir: 'This file looks damaged (bad directory).',
    zip64: 'This file uses ZIP64, which is not supported.',
    noInflate: 'This browser cannot unpack this file.',
    encrypted: 'This file is password protected.',
    tooLarge: 'A part of this file is too large to read.',
    damagedEntry: 'This file looks damaged (bad entry).',
    damagedUnpack: 'This file looks damaged (cannot unpack).',
    badMethod: 'This file uses an unsupported compression method.'
  };

  function pick(msgs) {
    const m = Object.assign({}, DEFAULT_MSGS, msgs || {});
    if (typeof m.fail !== 'function') m.fail = (message) => new Error(message);
    return m;
  }

  function readDirectory(bytes, msgs) {
    const M = pick(msgs);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = bytes.length;
    if (n < 22) throw M.fail(M.notZip);
    let eocd = -1;
    for (let i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw M.fail(M.notZip);
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw M.fail(M.zip64);
    if (cdOffset + cdSize > n) throw M.fail(M.damagedDir);
    const entries = new Map();
    const dec = new TextDecoder('utf-8');
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > n || dv.getUint32(p, true) !== 0x02014b50) throw M.fail(M.damagedDir);
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const size = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.set(name, { name, flags, method, compSize, size, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, dv };
  }

  async function inflateRaw(data, msgs) {
    const M = pick(msgs);
    if (typeof DecompressionStream !== 'function') throw M.fail(M.noInflate);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Returns the entry's text, or null when the entry does not exist.
  async function readEntryText(zip, bytes, name, msgs, maxEntryBytes) {
    const M = pick(msgs);
    const e = zip.entries.get(name);
    if (!e) return null;
    if (e.flags & 1) throw M.fail(M.encrypted);
    if (e.size > (maxEntryBytes || 80 * 1024 * 1024)) throw M.fail(M.tooLarge);
    const dv = zip.dv;
    const o = e.localOffset;
    if (o + 30 > bytes.length || dv.getUint32(o, true) !== 0x04034b50) throw M.fail(M.damagedEntry);
    const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
    const raw = bytes.subarray(start, start + e.compSize);
    let out;
    if (e.method === 0) out = raw;
    else if (e.method === 8) {
      try { out = await inflateRaw(raw, M); } catch (_) { throw M.fail(M.damagedUnpack); }
    } else throw M.fail(M.badMethod);
    return new TextDecoder('utf-8').decode(out).replace(/^﻿/, '');
  }

  root.BPZip = { readDirectory, readEntryText, inflateRaw };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BPZip;
}
