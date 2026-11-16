// lib/sync-merge.js - What syncs, and how two copies of a data set are merged. Pure: no DOM, no chrome.*, no network, no clock unless nowMs is omitted.
// Loaded by the service worker (importScripts) and by node tests. Exposes self.BPSyncMerge. Rules: docs/specs/ENCRYPTED_SYNC_SPEC.md section 2, step 6.
//
// Records are not stamped inside the user's saved data (that would touch about 60 write paths and every backup). Instead the sync layer keeps a
// side table per data set: meta[id] = { h: hash of the record, u: updatedAt (ms), d: deviceId } (or { x: true, u, d } for a deletion). A record is
// "changed" when its hash differs from the one in the table; a record that was in the table and is gone now becomes a deletion (tombstone).
//
// Wire format of one data set (this is what gets gzip-compressed and encrypted):  { v: 1, records: { <id>: { u, d, r: <record> } | { u, d, x: true } } }
//
// Merge rules, per record id:
//   - only one side knows it: it is taken (a deletion is taken too).
//   - both know it: the newest updatedAt wins; a deletion is just a version. Equal times: the larger deviceId wins (same answer on every computer).
//   - same record changed on two DIFFERENT computers less than 1 minute apart with different content: the newer one is kept and the other is
//     returned in `conflicts` (the caller stores it and asks the user once). Nothing is silently dropped.
//   - deletions (tombstones) are kept for 30 days, then forgotten.
//   - erased consultants (schema 20, spec section 10.9): the grow-only data set `erased` lists their ids (never a name). It merges as a union
//     (a deletion of an entry is never taken), and merge() never keeps a live record that names an erased consultant (the consultant, their
//     contact notes, hidden matches and résumé index records): it becomes a deletion, whatever its date. So a computer that was offline for
//     longer than the 30 days a tombstone lives cannot bring an erased person back. Their submissions are anonymised by the sync run
//     (BP.Consent.applyErasures), not here.
(function (root) {
  'use strict';

  const SNAPSHOT_VERSION = 1;
  const TOMBSTONE_DAYS = 30;
  const CONFLICT_WINDOW_MS = 60 * 1000;
  const DAY_MS = 86400000;

  // ── what syncs (the same data sets as a backup, minus resume files; settings that are per device stay home) ──
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
  const byId = (r) => (r && typeof r.id === 'string' && r.id ? r.id : '');
  const isSample = (r) => Boolean(r && r.sample === true);   // "Try with sample data" records never leave the computer
  // The only keys of the `settings` data set. Not here (so never synced): theme, reduceMotion, autosave, the floating dock,
  // scroll speed and depth, the error-report switch, alert switches, undo snapshots, backup reminders, licence, account.
  const SETTINGS_KEYS = ['myProfile', 'activeTemplateId', 'senderName', 'emailClient', 'tierLevelDefault', 'clientTypeDefault', 'followUpDays',
    'dashboardColumns', 'dashboardPresets', 'targetDesignations', 'blacklist', 'consultantSkills', 'cleanupDismissed',
    'homework',    // Today's homework: shift start, ticks, snoozes and the streak days (the day's list snapshot `homeworkDay` stays home)
    'coach',       // Sales coach: first-week lessons done, dismissed tips, the tips switch
    'bp_work_terms',   // Default work terms (C2C / W2 / Both) for matching: a user preference like the other defaults
    'targets',         // Staffing P4 (schema 19): the person's own weekly / monthly targets on Insights (lib/targets.js)
    'invoiceProfile',  // Schema 21 (lib/invoicing.js): the person's own invoice details (company, address, billing email, tax id, payment details, prefix)
    'commissionRule']; // Schema 21: the person's own commission rule (% of margin or fixed per placement) for the estimate on Placements

  const erasedIdOk = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 80 && !/[\u0000-\u001f\s]/.test(v);   // as lib/consent.js
  const RESUME_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  const RESUME_MAX_BYTES = 5 * 1024 * 1024;
  const str = (v, max) => typeof v === 'string' && v.length <= max;
  /** A blob index record (see `resumes` below). Strict: it comes off a server and names a key and a file to write on this computer. */
  function validResumeIndexRecord(r) {
    return Boolean(r && typeof r === 'object' && !Array.isArray(r)
      && typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r.id)
      && typeof r.blobId === 'string' && /^[A-Za-z0-9_-]{22}$/.test(r.blobId)
      && Number.isInteger(r.v) && r.v >= 1 && r.v <= 2147483647
      && typeof r.k === 'string' && /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9+/]{80}$/.test(r.k)   // the file key wrapped with the data key (sync-crypto wrapBlobKey)
      && typeof r.h === 'string' && /^[0-9a-f]{64}$/.test(r.h)
      && Number.isInteger(r.size) && r.size >= 1 && r.size <= RESUME_MAX_BYTES
      && str(r.consultantId, 40) && str(r.fileName, 200) && RESUME_TYPES.includes(r.type)
      && str(r.uploadedAt, 40) && str(r.updatedAt, 40));
  }

  const DATASETS = {
    leads:         { key: 'allLeads',      kind: 'list', idOf: (r) => (r && norm(r.email)) || '', skip: isSample, label: (r) => r.recruiterName || r.email || 'a lead' },
    companies:     { key: 'companies',     kind: 'list', idOf: byId, label: (r) => r.name || r.id || 'a vendor' },
    consultants:   { key: 'consultants',   kind: 'list', idOf: byId, label: (r) => r.name || 'a consultant' },
    // A submission carries its interviews and placement (schema 18) and its timesheets and invoices (schema 21): they sync with it, so the
    // hours and invoices reach every computer and the web app's My book.
    submissions:   { key: 'submissions',   kind: 'list', idOf: byId, skip: isSample, label: (r) => r.role || 'a submission' },
    notes:         { key: 'quickNotes',    kind: 'list', idOf: byId, label: (r) => r.title || 'a note' },
    jobs:          { key: 'jobOpenings',   kind: 'list', idOf: byId, label: (r) => r.title || 'a job' },
    templates:     { key: 'templates',     kind: 'list', idOf: byId, label: (r) => r.name || r.id || 'a template' },
    not_relevant:  { key: 'notRelevant',   kind: 'list', idOf: (r) => (r && typeof r.consultantId === 'string' && r.consultantId ? `${r.consultantId}|${norm(r.leadEmail)}|${r.postKey || ''}` : ''), label: () => 'a hidden match' },
    // The do-not-email list (schema 12): one record per address, so taking someone off on one computer syncs too.
    do_not_email:  { key: 'doNotEmail',    kind: 'list', idOf: (r) => (r && norm(r.email)) || '', label: (r) => r.email || 'an address' },
    // Vendor Book saved smart lists (Solo): rules only, never a list of names. Job-change suggestions and undo snapshots stay home.
    smart_lists:   { key: 'smartLists',    kind: 'list', idOf: byId, label: (r) => r.name || 'a smart list' },
    // Staffing P5 (schema 17): the typed contact log (calls, WhatsApp, meetings) per consultant and per saved recruiter (lib/consent.js).
    // A note removed here, or by "Erase this consultant", becomes a tombstone, so it goes on every computer and in the web app's My book.
    contact_notes: { key: 'contactNotes',  kind: 'list', idOf: byId, label: (r) => (r.kind ? r.kind + ' note' : 'a contact note') },
    // Schema 20: the durable erase list (lib/consent.js cleanErasedIds): { kind: 'consultant', id, at }, ids only. Grow-only: never tombstoned.
    erased:        { key: 'erasedIds',     kind: 'list', growOnly: true, idOf: (r) => (r && r.kind === 'consultant' && erasedIdOk(r.id) ? 'consultant:' + r.id : ''), label: () => 'an erased record' },
    settings:      { key: null,            kind: 'object', keys: SETTINGS_KEYS, label: (r, id) => id },
    // Phase 2: the index of the résumé files synced as encrypted blobs (background/sync-blobs.js). One record per file: where it is on the
    // server (blobId, v), its own key wrapped with the data key (k, never in the clear), the plaintext hash (h) and the file's metadata. It lives in chrome.storage.local under its own key
    // (sync bookkeeping, never in a backup); the files themselves stay in IndexedDB. Records that are not well formed are never taken.
    resumes:       { key: 'bpSyncResumeIndex', kind: 'list', internal: true, idOf: byId, skip: (r) => !validResumeIndexRecord(r), label: (r) => r.fileName || 'a resume file' }
  };
  // What a live record must not name once a consultant is erased (spec section 10.9). set = Set of erased consultant ids.
  const ERASED_BY = {
    consultants: (r, id, set) => set.has(id),
    contact_notes: (r, id, set) => r.entity === 'consultant' && set.has(r.entityId),
    not_relevant: (r, id, set) => set.has(r.consultantId),
    resumes: (r, id, set) => set.has(r.consultantId)
  };
  /** Set of erased consultant ids from the erasedIds list (or a Map of `erased` records). */
  function erasedSet(list) {
    const out = new Set();
    const items = list instanceof Map ? [...list.values()] : (Array.isArray(list) ? list : []);
    for (const e of items) if (e && e.kind === 'consultant' && erasedIdOk(e.id)) out.add(e.id);
    return out;
  }
  // Pulled first in a sync run, so every other data set merges against the newest list.
  const DATASET_NAMES = ['erased', ...Object.keys(DATASETS).filter((n) => n !== 'erased')];
  /** Every chrome.storage.local key of the user's own data that sync reads or writes (backed up, cleared by "Start empty"). */
  const SYNCED_KEYS = [...new Set(DATASET_NAMES.filter((n) => !DATASETS[n].internal).flatMap((n) => (DATASETS[n].key ? [DATASETS[n].key] : DATASETS[n].keys)))];
  /** SYNCED_KEYS plus the sync's own bookkeeping data sets (the blob index): what a merge or a push reads. Not in backups. */
  const STORAGE_KEYS = [...new Set([...SYNCED_KEYS, ...DATASET_NAMES.filter((n) => DATASETS[n].internal).map((n) => DATASETS[n].key)])];

  // ── hashing (change detection only, not security): cyrb53 over a key-sorted JSON string ──
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  function hashText(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const hashRecord = (r) => hashText(stable(r));

  // ── reading and writing the user's data ──
  /** storage = the chrome.storage.local object (or at least the SYNCED_KEYS). Returns Map id -> record. Records without an id are not synced. */
  function recordsOf(name, storage) {
    const ds = DATASETS[name];
    const out = new Map();
    const s = storage || {};
    if (ds.kind === 'object') {
      for (const k of ds.keys) if (s[k] !== undefined && s[k] !== null) out.set(k, s[k]);
      return out;
    }
    const list = Array.isArray(s[ds.key]) ? s[ds.key] : [];
    for (const r of list) {
      if (!r || typeof r !== 'object' || Array.isArray(r) || (ds.skip && ds.skip(r))) continue;
      const id = ds.idOf(r);
      if (id && !out.has(id)) out.set(id, r);
    }
    return out;
  }

  /**
   * The chrome.storage.local change that makes `storage` hold `finalRecords` (Map id -> record) for this data set.
   * Returns { set, remove }. Local order is kept; new records go at the end; records that cannot be synced (no id, samples) and
   * a second record with an already used id are always kept untouched, so applying a merge can never lose something the sync did not decide on.
   */
  function applyPatch(name, storage, finalRecords) {
    const ds = DATASETS[name];
    const s = storage || {};
    if (ds.kind === 'object') {
      const set = {}, remove = [];
      for (const k of ds.keys) {
        if (finalRecords.has(k)) { if (stable(s[k]) !== stable(finalRecords.get(k))) set[k] = finalRecords.get(k); }
        else if (s[k] !== undefined) remove.push(k);
      }
      return { set, remove };
    }
    const list = Array.isArray(s[ds.key]) ? s[ds.key] : [];
    const emitted = new Set();
    const next = [];
    for (const r of list) {
      if (!r || typeof r !== 'object' || Array.isArray(r) || (ds.skip && ds.skip(r))) { next.push(r); continue; }
      const id = ds.idOf(r);
      if (!id || emitted.has(id)) { next.push(r); continue; }
      emitted.add(id);
      if (finalRecords.has(id)) next.push(finalRecords.get(id));      // else: deleted by the merge
    }
    for (const [id, r] of finalRecords) if (!emitted.has(id)) next.push(r);
    return { set: { [ds.key]: next }, remove: [] };
  }

  // ── change detection ──
  const asMs = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };
  /** When a record that the sync has never seen was last touched, by its own fields; 0 when unknown (then any synced copy wins). */
  function adoptionTime(r) {
    if (!r || typeof r !== 'object') return 0;
    if (typeof r.id === 'string' && r.id.startsWith('qn-default-') && r.updatedAt === r.createdAt) return 0; // the starter notes are not "edits"
    return Math.max(asMs(r.updatedAt), asMs(r.savedAt), asMs(r.createdAt));
  }

  /** New meta for a data set after looking at the current records. Pure: returns a copy. growOnly (the `erased` list): a record missing here is
   *  not a deletion (the list only ever grows; a lost entry comes back from the other computers). */
  function stamp(records, meta, deviceId, nowMs, growOnly) {
    const out = {};
    for (const [id, m] of Object.entries(meta || {})) out[id] = m;
    for (const [id, r] of records) {
      const h = hashRecord(r);
      const m = out[id];
      if (!m) out[id] = { h, u: Math.min(adoptionTime(r), nowMs), d: deviceId };
      else if (m.x || m.h !== h) out[id] = { h, u: nowMs, d: deviceId };
    }
    for (const [id, m] of Object.entries(out)) {
      if (!records.has(id) && !m.x) { if (growOnly) delete out[id]; else out[id] = { x: true, u: nowMs, d: deviceId }; }
    }
    return out;
  }

  /** Forgets deletions older than 30 days. */
  function prune(meta, nowMs) {
    const out = {};
    for (const [id, m] of Object.entries(meta || {})) if (!(m.x && nowMs - m.u > TOMBSTONE_DAYS * DAY_MS)) out[id] = m;
    return out;
  }

  /** The wire object for one data set. */
  function snapshotOf(records, meta) {
    const out = {};
    for (const [id, m] of Object.entries(meta || {})) {
      if (m.x) out[id] = { u: m.u, d: m.d, x: true };
      else if (records.has(id)) out[id] = { u: m.u, d: m.d, r: records.get(id) };
    }
    return { v: SNAPSHOT_VERSION, records: out };
  }
  const snapshotHash = (snap) => hashText(stable(snap));

  /** Checks a decrypted snapshot (it came off a server, so it is untrusted). Returns the cleaned snapshot or null. */
  function cleanSnapshot(snap, name) {
    if (!snap || typeof snap !== 'object' || snap.v !== SNAPSHOT_VERSION || !snap.records || typeof snap.records !== 'object' || Array.isArray(snap.records)) return null;
    const ds = DATASETS[name];
    const out = {};
    for (const [id, e] of Object.entries(snap.records)) {
      if (!e || typeof e !== 'object' || !Number.isFinite(e.u) || typeof e.d !== 'string') continue;
      if (id === '__proto__' || id === 'constructor') continue;
      if (e.x === true) { if (!ds.growOnly) out[id] = { u: e.u, d: e.d, x: true }; continue; }   // the erase list is never tombstoned
      if (ds.kind === 'object') { if (ds.keys.includes(id) && e.r !== undefined && e.r !== null) out[id] = { u: e.u, d: e.d, r: e.r }; continue; }
      if (e.r && typeof e.r === 'object' && !Array.isArray(e.r) && ds.idOf(e.r) === id && !(ds.skip && ds.skip(e.r))) out[id] = { u: e.u, d: e.d, r: e.r };
    }
    return { v: SNAPSHOT_VERSION, records: out };
  }

  // ── the merge ──
  /**
   * @param name       data set name
   * @param local      Map id -> record (recordsOf)
   * @param localMeta  stamped meta (after stamp())
   * @param remote     a cleaned snapshot, or null when the server has nothing yet
   * @param opts       { erased: Set of erased consultant ids } (spec section 10.9): a live record naming one becomes a deletion
   * @returns { records: Map, meta, conflicts: [{ dataset, id, label, kept: 'local'|'remote', record }], changedLocal: bool, pushNeeded: bool }
   *          conflicts[i].record is the version that was NOT kept.
   */
  function merge(name, local, localMeta, remote, nowMs, opts) {
    const ds = DATASETS[name];
    const rrec = (remote && remote.records) || {};
    if (ds.growOnly) return mergeUnion(local, localMeta, rrec);
    const records = new Map();
    const meta = {};
    const conflicts = [];
    let changedLocal = false;
    const ids = new Set([...local.keys(), ...Object.keys(localMeta || {}), ...Object.keys(rrec)]);

    const conflictIfClose = (id, L, lr, R, kept) => {
      if (R.x || !lr || L.x) return;
      if (L.d === R.d || Math.abs(L.u - R.u) >= CONFLICT_WINDOW_MS) return;
      if (hashRecord(lr) === hashRecord(R.r)) return;
      conflicts.push({ dataset: name, id, label: String(ds.label(kept === 'local' ? lr : R.r, id) || id).slice(0, 80), kept, record: kept === 'local' ? R.r : lr });
    };
    const takeRemote = (id, R) => {
      if (R.x) meta[id] = { x: true, u: R.u, d: R.d };
      else { records.set(id, R.r); meta[id] = { h: hashRecord(R.r), u: R.u, d: R.d }; }
    };
    const keepLocal = (id, L, lr) => {
      if (L.x || !lr) meta[id] = { x: true, u: L.u, d: L.d };
      else { records.set(id, lr); meta[id] = L; }
    };

    for (const id of ids) {
      const lr = local.get(id);
      const L = (localMeta || {})[id] || (lr ? { h: hashRecord(lr), u: adoptionTime(lr), d: '' } : null);
      const R = rrec[id];
      if (!R) { if (L) keepLocal(id, L, lr); continue; }
      if (!L) { takeRemote(id, R); if (!R.x) changedLocal = true; continue; }
      const localLive = !L.x && !!lr;
      const remoteWins = R.u > L.u || (R.u === L.u && String(R.d) > String(L.d));
      if (remoteWins) {
        if (R.x) { if (localLive) changedLocal = true; takeRemote(id, R); }
        else if (localLive && hashRecord(lr) === hashRecord(R.r)) { records.set(id, lr); meta[id] = { h: hashRecord(lr), u: Math.max(L.u, R.u), d: R.d }; }
        else { conflictIfClose(id, L, lr, R, 'remote'); takeRemote(id, R); changedLocal = true; }
      } else if (localLive && !R.x && hashRecord(lr) === hashRecord(R.r)) {
        records.set(id, lr); meta[id] = { h: hashRecord(lr), u: Math.max(L.u, R.u), d: L.d };
      } else {
        conflictIfClose(id, L, lr, R, 'local');
        keepLocal(id, L, lr);
      }
    }
    // Erased consultants (spec section 10.9): whatever its date, a live record that names one is not kept. It becomes a deletion stamped at the
    // newest time either side knows, so it also wins on a computer that has not merged the erase list yet; once the tombstone is forgotten
    // (30 days) the list still refuses the record here.
    const erased = opts && opts.erased instanceof Set && opts.erased.size ? opts.erased : null;
    if (erased && ERASED_BY[name]) {
      for (const [id, r] of [...records]) {
        if (!ERASED_BY[name](r, id, erased)) continue;
        records.delete(id);
        const R = rrec[id];
        meta[id] = { x: true, u: Math.max(Number(meta[id] && meta[id].u) || 0, Number(R && R.u) || 0), d: (meta[id] && meta[id].d) || '' };
        if (local.has(id)) changedLocal = true;
      }
    }
    const pruned = prune(meta, nowMs);
    let pushNeeded = false;
    for (const [id, m] of Object.entries(pruned)) {
      const R = rrec[id];
      if (!R || R.u !== m.u || Boolean(R.x) !== Boolean(m.x)) { pushNeeded = true; break; }
    }
    return { records, meta: pruned, conflicts, changedLocal, pushNeeded };
  }

  /** The grow-only merge (the `erased` list): the union of both sides; a deletion is never taken or made. */
  function mergeUnion(local, localMeta, rrec) {
    const records = new Map(local);
    const meta = {};
    let changedLocal = false;
    for (const [id, r] of local) meta[id] = (localMeta && localMeta[id] && !localMeta[id].x) ? localMeta[id] : { h: hashRecord(r), u: adoptionTime(r), d: '' };
    for (const [id, R] of Object.entries(rrec)) {
      if (R.x || records.has(id)) continue;
      records.set(id, R.r);
      meta[id] = { h: hashRecord(R.r), u: R.u, d: R.d };
      changedLocal = true;
    }
    let pushNeeded = false;
    for (const id of records.keys()) if (!rrec[id] || rrec[id].x) { pushNeeded = true; break; }
    return { records, meta, conflicts: [], changedLocal, pushNeeded };
  }

  root.BPSyncMerge = {
    SNAPSHOT_VERSION, TOMBSTONE_DAYS, CONFLICT_WINDOW_MS, DATASETS, DATASET_NAMES, SYNCED_KEYS, STORAGE_KEYS, SETTINGS_KEYS, validResumeIndexRecord,
    stable, hashText, hashRecord, recordsOf, applyPatch, adoptionTime, stamp, prune, snapshotOf, snapshotHash, cleanSnapshot, merge,
    ERASED_BY, erasedSet
  };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BPSyncMerge;
}
