// lib/docx-reader.js - Plain-text reader for Word .docx resumes, no third-party code.
// A .docx is a ZIP; the text lives in word/document.xml (and page headers, where many resumes keep
// the contact line). The ZIP part is lib/zip-reader.js; the XML is read with a small tolerant
// tokenizer, so it behaves the same in a Chrome extension page and in Node tests.
//
//   BPDocx.isDocx(arrayBuffer | Uint8Array) -> boolean   ZIP header + word/document.xml present (no unpacking)
//   BPDocx.readDocxText(arrayBuffer | Uint8Array) -> Promise<string>
//
// Paragraphs become lines, tabs and line breaks are kept, table cells are separated by a tab and
// rows by a new line. Deleted tracked changes, field codes and the duplicate "fallback" copy of text
// boxes are skipped. Old binary .doc (Word 97-2003) is not supported.

(function (root) {
  'use strict';

  const LIMITS = { maxEntryBytes: 30 * 1024 * 1024, maxHeaders: 6 };

  function fail(message) { const e = new Error(message); e.docx = true; return e; }

  const Z = root.BPZip || require('./zip-reader.js');
  const ZMSGS = {
    fail,
    notZip: 'This file is not a valid Word (.docx) document.',
    damagedDir: 'This Word file looks damaged (bad directory).',
    zip64: 'This Word file uses ZIP64, which is not supported.',
    noInflate: 'This browser cannot read Word files. Please upload a PDF.',
    encrypted: 'This Word file is password protected. Remove the password or upload a PDF.',
    tooLarge: 'This Word file is too large to read.',
    damagedEntry: 'This Word file looks damaged (bad entry).',
    damagedUnpack: 'This Word file looks damaged (cannot unpack).',
    badMethod: 'This Word file uses an unsupported compression method.'
  };

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function decodeText(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, dec, hex, name) => {
      if (name) return ENTITIES[name];
      const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      try { return String.fromCodePoint(cp); } catch (_) { return ''; }
    });
  }

  function toBytes(input) { return input instanceof Uint8Array ? input : new Uint8Array(input); }

  function hasZipHeader(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }

  function isOle2(bytes) {
    return bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  }

  // Cheap check used when a file is picked: "PK\x03\x04" and a word/document.xml entry.
  function isDocx(input) {
    try {
      const bytes = toBytes(input);
      if (!hasZipHeader(bytes)) return false;
      return Z.readDirectory(bytes, ZMSGS).entries.has('word/document.xml');
    } catch (_) { return false; }
  }

  // WordprocessingML -> text.
  function xmlToText(xml) {
    // The mc:Fallback branch repeats the text of text boxes; delete/instruction runs are not visible text.
    const cleaned = String(xml)
      .replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '')
      .replace(/<w:delText\b[\s\S]*?<\/w:delText>/g, '')
      .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '');
    let out = '';
    const re = /<w:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:t>)|<w:(tab|br|cr|noBreakHyphen)\b[^>]*?\/?>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;
    let m;
    while ((m = re.exec(cleaned))) {
      const tag = m[0];
      if (m[2] === undefined && tag.startsWith('<w:t')) {
        out += m[1] ? decodeText(m[1]) : '';
      } else if (m[2]) {
        out += m[2] === 'tab' ? '\t' : m[2] === 'noBreakHyphen' ? '-' : '\n';
      } else if (tag === '</w:p>') {
        out += '\n';
      } else if (tag === '</w:tc>') {
        out = out.replace(/\n+$/, '') + '\t';
      } else if (tag === '</w:tr>') {
        out = out.replace(/\t+$/, '') + '\n';
      }
    }
    return out
      .replace(/[  ]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function readDocxText(input) {
    const bytes = toBytes(input);
    if (isOle2(bytes)) throw fail('Old Word .doc files can\'t be read. Please save it as .docx or PDF and upload again.');
    if (!hasZipHeader(bytes)) throw fail('This file is not a valid Word (.docx) document.');
    const zip = Z.readDirectory(bytes, ZMSGS);
    const body = await Z.readEntryText(zip, bytes, 'word/document.xml', ZMSGS, LIMITS.maxEntryBytes);
    if (body === null) throw fail('This file is not a Word document (no word/document.xml).');
    // Page headers often hold the name, phone and email.
    const headerNames = [...zip.entries.keys()].filter(n => /^word\/header\d*\.xml$/.test(n)).sort().slice(0, LIMITS.maxHeaders);
    const parts = [];
    for (const name of headerNames) {
      try {
        const t = xmlToText(await Z.readEntryText(zip, bytes, name, ZMSGS, LIMITS.maxEntryBytes));
        if (t && !parts.includes(t)) parts.push(t);
      } catch (_) { /* a damaged header must not hide the body */ }
    }
    parts.push(xmlToText(body));
    return parts.join('\n');
  }

  root.BPDocx = { isDocx, readDocxText, LIMITS, _internal: { xmlToText, decodeText } };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BPDocx;
}
