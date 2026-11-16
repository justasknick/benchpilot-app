// webapp/js/bp-lib.js - loads the extension's own pure modules so the web app uses the very same code as the extension:
//   loadBP()         lib/shared.js, classify.js, requirement.js, jobboard-mail.js   "Paste a requirement", the inboxes (job-board alerts split into jobs)
//   loadImportLib()  lib/shared.js, zip-reader.js, xlsx-reader.js, import.js   Excel/CSV import (column matching, CSV and .xlsx reading)
//   loadSyncLib()    lib/shared.js, sync-crypto.js, sync-merge.js, sync-blob-read.js, inbox-crypto.js, background/sync.js   "My book" (Solo): the extension's
//                    own encryption, merge rules, resume-file read path and sync wording (background/sync.js only defines BPSyncFactory / BPSyncShared
//                    when it loads; nothing runs), plus the record rules (submissions.js, jobs.js, migrations.js) and the morning summary (homework.js)
//   loadHotlistLib() lib/shared.js, hotlist.js   the Bench screen's "Hotlist" (the extension's own formatter, BP.Hotlist)
//   loadHeatLib()    lib/shared.js, roles.js, vendor-book.js   Vendor book heat (BP.VendorBook, read-only use of the extension's Vendor Book logic)
//   loadMatchLib()   the loadBP() files                         Matches (BP.scoreMatch, BP.requirementState: the extension's scoring)
//   loadAgreementsLib() lib/vendor-agreements.js              Vendor agreements (BP.Agreements: MSA / NDA states, reminders, the submit warning,
//                    payment dates; staffing P6). Already loaded (a node test, or another set that has it) = used as it is.
//   loadConsentLib() lib/shared.js, consent.js                 The consultant page's data-notice email (BP.Consent.noticeEmail: the extension's
//                    own text; webapp/js/consent.js keeps the synchronous lists with a parity test)
//   loadEmailCheckLib() lib/email-check.js                     The email check under the vendor contact form (BP.EmailCheck: typos, dots, endings)
//   loadResumeLib()  lib/shared.js, zip-reader.js, docx-reader.js            Consultant resume upload (BP.checkResumeFile, BPDocx.isDocx: the extension's file check)
//   loadDraftLib()   the loadBP() files, posted.js, roles.js, today.js, submissions.js, placements.js   Team templates and "Draft email" (BP.fillTemplate
//                    through BP.Submissions.fillSubmitEmail, BP.buildComposeUrl, BP.DEFAULT_TEMPLATES: the extension's own fill and compose code), and
//                    staffing P3's interviews, .ics files, placements, margin and funnel (BP.Placements), and staffing P4's targets, periods and
//                    leaderboard order (BP.Targets, lib/targets.js), and the masked profile summary in a draft (BP.Hotlist.profile, lib/hotlist.js)
//                    and the timesheets, invoices and commission estimates (BP.Timesheets, BP.Invoices, BP.Commission: lib/invoicing.js, migration 0055)
// These files are plain scripts that attach to `BP` / `BPXlsx` and touch no chrome.* API when they load. The build
// (scripts/build-webapp.mjs) copies them next to the web app.

const BASE = new URL('../shared/lib/', import.meta.url);
const FILES = ['shared.js', 'classify.js', 'requirement.js', 'jobboard-mail.js'];
const IMPORT_FILES = ['shared.js', 'zip-reader.js', 'xlsx-reader.js', 'import.js'];
// My book v2 also loads the extension's record rules (submissions, jobs, vendor updates) and the morning summary (homework.js), in order.
const SYNC_FILES = ['shared.js', 'classify.js', 'requirement.js', 'posted.js', 'roles.js', 'today.js', 'submissions.js', 'placements.js', 'jobs.js', 'homework.js',
  'vendor-agreements.js', 'consent.js', 'targets.js', 'migrations.js', 'sync-crypto.js', 'sync-merge.js', 'sync-blob-read.js', 'inbox-crypto.js', '../background/sync.js'];
const HOTLIST_FILES = ['shared.js', 'hotlist.js'];
const HEAT_FILES = ['shared.js', 'roles.js', 'vendor-book.js'];
const RESUME_FILES = ['shared.js', 'zip-reader.js', 'docx-reader.js'];
const DRAFT_FILES = ['shared.js', 'classify.js', 'requirement.js', 'posted.js', 'roles.js', 'today.js', 'submissions.js', 'placements.js', 'targets.js', 'hotlist.js', 'invoicing.js'];
const EMAIL_CHECK_FILES = ['email-check.js'];
const AGREEMENT_FILES = ['vendor-agreements.js'];
const CONSENT_FILES = ['shared.js', 'consent.js'];

let pending = null;
let importPending = null;
let syncPending = null;
let hotlistPending = null;
let heatPending = null;
let resumePending = null;
let draftPending = null;
let emailCheckPending = null;
let agreementsPending = null;
let consentPending = null;
const loaded = new Map();      // file -> Promise, so a file shared by both sets loads once

function loadScript(name) {
  if (!loaded.has(name)) {
    loaded.set(name, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL(name, BASE).href;
      s.onload = resolve;
      s.onerror = () => { loaded.delete(name); reject(new Error('Could not load ' + name)); };
      document.head.append(s);
    }));
  }
  return loaded.get(name);
}

/** Resolves to { Import, readXlsx } (the extension's import helpers), or null when the files are not available. */
export function loadImportLib() {
  if (!importPending) {
    importPending = (async () => {
      try {
        for (const f of IMPORT_FILES) await loadScript(f);   // in order: xlsx-reader needs zip-reader, import needs shared
        const BP = self.BP;
        return BP && BP.Import && self.BPXlsx ? { Import: BP.Import, readXlsx: self.BPXlsx.readXlsx } : null;
      } catch (e) {
        importPending = null;
        return null;
      }
    })();
  }
  return importPending;
}

/** Resolves to { BP, crypto, merge, messages } (the extension's BP, BPSyncCrypto, BPSyncMerge and sync MESSAGES). Rejects when they cannot load:
 *  unlike the parser, "My book" has no fallback (it never decrypts with anything but the extension's code). */
export function loadSyncLib() {
  if (!syncPending) {
    syncPending = (async () => {
      for (const f of SYNC_FILES) await loadScript(f);
      const g = self;
      if (!g.BP || !g.BPSyncCrypto || !g.BPSyncMerge || !g.BPSyncShared || !g.BPInboxCrypto || !g.BPSyncBlobRead) throw new Error('Could not load the sync code.');
      if (!g.BP.Submissions || !g.BP.Jobs || !g.BP.Homework || !g.BP.updateCompany) throw new Error('Could not load the book rules.');
      return { BP: g.BP, crypto: g.BPSyncCrypto, merge: g.BPSyncMerge, messages: g.BPSyncShared.MESSAGES, inboxCrypto: g.BPInboxCrypto, blobRead: g.BPSyncBlobRead };
    })().catch((e) => { syncPending = null; throw e; });
  }
  return syncPending;
}

/** Resolves to BP.Hotlist (the extension's hotlist formatter). Rejects when it cannot load, so the screen can say so. */
export function loadHotlistLib() {
  if (!hotlistPending) {
    hotlistPending = (async () => {
      for (const f of HOTLIST_FILES) await loadScript(f);
      if (!self.BP || !self.BP.Hotlist) throw new Error('Could not load the hotlist code.');
      return self.BP.Hotlist;
    })().catch((e) => { hotlistPending = null; throw e; });
  }
  return hotlistPending;
}

/** Resolves to BP.VendorBook (heat, role tags). Rejects when it cannot load, so the Vendor book says so and still lists the companies. */
export function loadHeatLib() {
  if (!heatPending) {
    heatPending = (async () => {
      for (const f of HEAT_FILES) await loadScript(f);
      if (!self.BP || !self.BP.VendorBook || !self.BP.VendorBook.vendorStats) throw new Error('Could not load the vendor heat code.');
      return self.BP.VendorBook;
    })().catch((e) => { heatPending = null; throw e; });
  }
  return heatPending;
}

/** Resolves to BP.Agreements (the extension's own vendor agreement rules). Rejects when it cannot load, so the screen can say so. */
export function loadAgreementsLib() {
  const g = globalThis;
  if (g.BP && g.BP.Agreements) return Promise.resolve(g.BP.Agreements);
  if (!agreementsPending) {
    agreementsPending = (async () => {
      for (const f of AGREEMENT_FILES) await loadScript(f);
      if (!self.BP || !self.BP.Agreements) throw new Error('Could not load the vendor agreement code.');
      return self.BP.Agreements;
    })().catch((e) => { agreementsPending = null; throw e; });
  }
  return agreementsPending;
}

/** Resolves to BP.Consent (the extension's consent lists and the data-notice email). Rejects when it cannot load, so the screen says so. */
export function loadConsentLib() {
  if (!consentPending) {
    consentPending = (async () => {
      for (const f of CONSENT_FILES) await loadScript(f);
      if (!self.BP || !self.BP.Consent || !self.BP.Consent.noticeEmail) throw new Error('Could not load the notice email code.');
      return self.BP.Consent;
    })().catch((e) => { consentPending = null; throw e; });
  }
  return consentPending;
}

/** Resolves to BP.EmailCheck (the extension's own email check), or null when it cannot load: the form then simply shows no warning. */
export function loadEmailCheckLib() {
  if (!emailCheckPending) {
    emailCheckPending = (async () => {
      try {
        for (const f of EMAIL_CHECK_FILES) await loadScript(f);
        return (self.BP && self.BP.EmailCheck) || null;
      } catch (e) { emailCheckPending = null; return null; }
    })();
  }
  return emailCheckPending;
}

/** Resolves to { BP, BPDocx } (the extension's resume file check). Rejects when it cannot load, so the upload says so instead of guessing. */
export function loadResumeLib() {
  if (!resumePending) {
    resumePending = (async () => {
      for (const f of RESUME_FILES) await loadScript(f);
      if (!self.BP || !self.BP.checkResumeFile || !self.BPDocx) throw new Error('Could not load the file check.');
      return { BP: self.BP, BPDocx: self.BPDocx };
    })().catch((e) => { resumePending = null; throw e; });
  }
  return resumePending;
}

/** Resolves to BP with the extension's template fill and compose-URL code. Rejects when it cannot load: drafts have no fallback. */
export function loadDraftLib() {
  if (!draftPending) {
    draftPending = (async () => {
      for (const f of DRAFT_FILES) await loadScript(f);       // in order: submissions.js needs the others
      const BP = self.BP;
      if (!BP || !BP.fillTemplate || !BP.buildComposeUrl || !BP.DEFAULT_TEMPLATES || !BP.Submissions || !BP.Submissions.fillSubmitEmail || !BP.Placements || !BP.Targets || !BP.Invoices) {
        throw new Error('Could not load the email template code.');
      }
      return BP;
    })().catch((e) => { draftPending = null; throw e; });
  }
  return draftPending;
}

/** Resolves to BP with the extension's match scoring. Rejects when it cannot load: Matches has no fallback (it never scores differently). */
export async function loadMatchLib() {
  const BP = await loadBP();
  if (!BP || !BP.scoreMatch || !BP.requirementState) throw new Error('Could not load the matching code.');
  return BP;
}

/** Resolves to the shared BP object, or null when the files are not available (the paste form then works by hand). */
export function loadBP() {
  if (!pending) {
    pending = (async () => {
      try {
        for (const f of FILES) await loadScript(f);      // in order: requirement.js needs the other two
        return self.BP && self.BP.parsePastedRequirement ? self.BP : null;
      } catch (e) {
        return null;
      }
    })();
  }
  return pending;
}

/** Fields for the requirement form from pasted text. Anything the text does not state stays empty.
 *  One implementation: BP.parsePastedRequirement in the extension's lib/requirement.js (the extension dashboard uses the
 *  same function). When the reader could not load (BP null), every field is empty and the user fills the form by hand. */
export function parsePastedRequirement(BP, text, todayMs) {
  if (BP && typeof BP.parsePastedRequirement === 'function') return BP.parsePastedRequirement(text, { now: todayMs || Date.now() });
  return { title: '', endClient: '', jobRef: '', rateText: '', workMode: '', location: '', visaText: '', taxTerms: '', duration: '', skills: [] };
}
