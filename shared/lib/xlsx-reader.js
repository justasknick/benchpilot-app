// lib/xlsx-reader.js - Minimal .xlsx reader with no third-party code.
// An .xlsx is a ZIP of XML files. We read the ZIP central directory, inflate entries with the
// browser's DecompressionStream('deflate-raw') (stored entries are copied as-is), and pull cell
// text out of the few XML parts that matter with a small tolerant tokenizer. The tokenizer is plain
// string/regex work, so it behaves the same in a Chrome extension page and in Node tests.
//
//   BPXlsx.readXlsx(arrayBuffer | Uint8Array) -> Promise<[{ name, hidden, rows: string[][], rowNumbers: number[] }]>
//
// Supported: shared strings (incl. rich-text runs), inline strings, formula string results,
// numbers, booleans, sparse rows/cells, any sheet order, hidden sheets (flagged, still read).
// Not supported: legacy .xls, password-protected files, ZIP64, dates shown as dates (a date cell
// comes back as its Excel serial number because number formats are not read), formulas without a
// cached value, merged-cell expansion.
// Blank rows are dropped; rowNumbers[i] is the real sheet row number of rows[i].

(function (root) {
  'use strict';

  const LIMITS = { maxBytes: 10 * 1024 * 1024, maxSheets: 20, maxRows: 20000, maxCols: 200, maxEntryBytes: 80 * 1024 * 1024 };

  function fail(message) { const e = new Error(message); e.xlsx = true; return e; }

  // ── ZIP (shared reader in lib/zip-reader.js, errors worded for workbooks) ──
  const Z = root.BPZip || require('./zip-reader.js');
  const ZMSGS = {
    fail,
    notZip: 'This file is not a valid .xlsx workbook.',
    damagedDir: 'This .xlsx file looks damaged (bad directory).',
    zip64: 'This workbook uses ZIP64, which is not supported. Please save as .xlsx again or as CSV.',
    noInflate: 'This browser cannot read .xlsx files. Please save as CSV.',
    encrypted: 'This workbook is password protected. Remove the password or save as CSV.',
    tooLarge: 'A sheet inside this workbook is too large to import.',
    damagedEntry: 'This .xlsx file looks damaged (bad entry).',
    damagedUnpack: 'This .xlsx file looks damaged (cannot unpack).',
    badMethod: 'This workbook uses an unsupported compression method.'
  };
  const readZipDirectory = (bytes) => Z.readDirectory(bytes, ZMSGS);
  const readEntryText = (zip, bytes, name) => Z.readEntryText(zip, bytes, name, ZMSGS, LIMITS.maxEntryBytes);

  // ── XML helpers (tolerant tokenizer for the few elements we need) ─────────
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function decodeText(s) {
    if (s.indexOf('&') === -1 && s.indexOf('_x') === -1) return s;
    return s
      .replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, dec, hex, name) => {
        if (name) return ENTITIES[name];
        const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
        try { return String.fromCodePoint(cp); } catch (_) { return ''; }
      })
      // Excel escapes control characters as _x000D_ inside strings
      .replace(/_x([0-9a-fA-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }

  function parseAttrs(s) {
    const out = {};
    const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(s || ''))) out[m[1]] = decodeText(m[2] !== undefined ? m[2] : m[3]);
    return out;
  }

  // Text of every <t> in an <si> / <is> block, ignoring phonetic runs (<rPh>).
  function collectText(block) {
    const cleaned = block.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let out = '';
    const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
    let m;
    while ((m = re.exec(cleaned))) out += m[1] ? decodeText(m[1]) : '';
    return out;
  }

  function parseSharedStrings(xml) {
    const out = [];
    if (!xml) return out;
    const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
    let m;
    while ((m = re.exec(xml))) out.push(m[1] ? collectText(m[1]) : '');
    return out;
  }

  function colToIndex(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  function numberText(v) {
    const t = v.trim();
    // Large integers come out of Excel as 9.87654321E9; show them as plain digits.
    if (/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n) && Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(0);
    }
    return t;
  }

  function parseSheet(xml, sst, budget) {
    const rows = [];
    const rowNumbers = [];
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rm;
    let seq = 0;
    while ((rm = rowRe.exec(xml))) {
      const ra = parseAttrs(rm[1]);
      const rowNo = ra.r ? parseInt(ra.r, 10) : seq + 1;
      seq = rowNo;
      if (!rm[2]) continue;
      const cells = [];
      let any = false;
      let nextCol = 0;
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(rm[2]))) {
        const a = parseAttrs(cm[1]);
        let col = nextCol;
        if (a.r) {
          const mm = /^([A-Za-z]+)/.exec(a.r);
          if (mm) col = colToIndex(mm[1].toUpperCase());
        }
        nextCol = col + 1;
        if (col < 0 || col >= LIMITS.maxCols || !cm[2]) continue;
        const body = cm[2];
        let text = '';
        const t = a.t || 'n';
        if (t === 'inlineStr') {
          const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body);
          text = is ? collectText(is[1]) : '';
        } else {
          const vm = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(body);
          const v = vm && vm[1] !== undefined ? vm[1] : '';
          if (t === 's') text = sst[parseInt(v, 10)] || '';
          else if (t === 'str') text = decodeText(v);
          else if (t === 'b') text = v.trim() === '1' ? 'TRUE' : v.trim() === '0' ? 'FALSE' : '';
          else if (t === 'e') text = '';
          else text = numberText(v);
        }
        if (text === '') continue;
        while (cells.length < col) cells.push('');
        cells[col] = text;
        any = true;
      }
      if (!any) continue;
      if (++budget.rows > LIMITS.maxRows) {
        throw fail(`This workbook has more than ${LIMITS.maxRows.toLocaleString('en-US')} rows. Split it into smaller files.`);
      }
      rows.push(cells);
      rowNumbers.push(rowNo);
    }
    // Pad every row to the same width so callers can index freely.
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    for (const r of rows) while (r.length < width) r.push('');
    return { rows, rowNumbers };
  }

  function resolveTarget(target) {
    const t = String(target || '');
    if (t.startsWith('/')) return t.slice(1);
    const parts = ('xl/' + t).split('/');
    const out = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    }
    return out.join('/');
  }

  // ── Public API ────────────────────────────────────────────────────────────
  async function readXlsx(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length > LIMITS.maxBytes) throw fail('This file is larger than 10 MB. Split it or save only the tabs you need.');
    // Old binary Excel (and password-protected xlsx) are OLE2 containers, not ZIPs.
    if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      throw fail('This is an old .xls (or password-protected) file. Please save as .xlsx or CSV.');
    }
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw fail('This file is not a valid .xlsx workbook. Please save as .xlsx or CSV.');

    const zip = readZipDirectory(bytes);
    const wbXml = await readEntryText(zip, bytes, 'xl/workbook.xml');
    if (wbXml === null) throw fail('This file is not an Excel workbook (no xl/workbook.xml). Please save as .xlsx or CSV.');
    const relsXml = (await readEntryText(zip, bytes, 'xl/_rels/workbook.xml.rels')) || '';

    const rels = new Map();
    const relRe = /<Relationship\b([^>]*?)\/?>/g;
    let m;
    while ((m = relRe.exec(relsXml))) {
      const a = parseAttrs(m[1]);
      if (a.Id && a.Target && (!a.Type || /\/worksheet$/.test(a.Type))) rels.set(a.Id, resolveTarget(a.Target));
    }

    const sheetDefs = [];
    const sheetRe = /<sheet\b([^>]*?)\/?>/g;
    let idx = 0;
    while ((m = sheetRe.exec(wbXml))) {
      const a = parseAttrs(m[1]);
      idx++;
      // Without a rels file fall back to the conventional sheetN.xml numbering.
      const path = rels.get(a['r:id']) || (rels.size === 0 ? `xl/worksheets/sheet${idx}.xml` : null);
      if (path) sheetDefs.push({ name: a.name || `Sheet${idx}`, hidden: a.state === 'hidden' || a.state === 'veryHidden', path });
    }
    if (!sheetDefs.length) throw fail('No sheets were found in this workbook.');
    if (sheetDefs.length > LIMITS.maxSheets) {
      throw fail(`This workbook has ${sheetDefs.length} sheets; the limit is ${LIMITS.maxSheets}. Remove the sheets you do not need.`);
    }

    const sst = parseSharedStrings(await readEntryText(zip, bytes, 'xl/sharedStrings.xml'));
    const budget = { rows: 0 };
    const out = [];
    for (const def of sheetDefs) {
      const xml = await readEntryText(zip, bytes, def.path);
      if (xml === null) throw fail(`Sheet "${def.name}" is missing from the file (damaged workbook).`);
      const parsed = parseSheet(xml, sst, budget);
      out.push({ name: def.name, hidden: def.hidden, rows: parsed.rows, rowNumbers: parsed.rowNumbers });
    }
    return out;
  }

  root.BPXlsx = { readXlsx, LIMITS, _internal: { colToIndex, decodeText, parseSharedStrings, parseSheet, resolveTarget } };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BPXlsx;
}
