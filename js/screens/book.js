// My book (Solo personal web workspace, docs/specs/SOLO_WEB_WORKSPACE_SPEC.md). The whole mode: its own top bar and menu, the plan / no-keys /
// unlock states, the lists with search and a filter, the record detail and the safe edits. All crypto and every server call are in js/vault.js;
// this file only shows what the vault gives it. User data is only ever added as text (dom.js h()), never as HTML.
// Record ids (a lead's id is the recruiter's email) never go into the address bar: the open record is kept in memory (`picked`).

import { h, clear } from '../dom.js';
import { CONSENT_SOURCE_LABELS, CONSENT_NOTE_MAX } from '../consent.js';
import { pageHeader, card, table, field, input, select, note, empty, button, plural } from '../ui.js';
import { SECTIONS, sectionByName } from '../book-model.js';
import * as bookInbox from './book-inbox.js';
import { appShell } from '../shell.js';
import { SYNC_TIERS } from '../personal-plan.js';
import { progressList } from '../p4-ui.js';

const TITLE = 'My book';
let picked = null;   // { dataset, id } of the open record, memory only
let adding = null;   // the data set whose Add form is open, memory only

/** The Upgrade card (no checkout here: buying happens in the extension's upgrade page). Same wording as the extension's Settings > Sync gate. */
export function upgradeCard(messages) {
  return card('Upgrade to Solo', [
    h('p', null, messages.plan_required || 'Sync across computers is part of the Solo plan.'),
    h('p', null, 'Upgrade to have your vendor book on every computer you sign in on, encrypted so only you can read it. ',
      'Open the BenchPilot extension and choose ', h('strong', null, 'Upgrade to Solo'), '. Your book then syncs and opens here.')
  ]);
}

// ── device pairing (docs/specs/ENCRYPTED_SYNC_SPEC.md section 10.5): this tab is the new device; the vault holds the request and its keys ──
const PAIR_POLL_MS = 3000;
let poller = null;   // { form, timer }: the one poll loop of this tab's pending request, owned by the unlock form on screen

/** The label the extension shows on its approve card: "Web app" plus a short browser / OS hint. Only [A-Za-z0-9 ().,-], at most 40 characters. */
export function pairLabel(ua) {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  const os = /Windows/.test(s) ? 'Windows' : /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /CrOS/.test(s) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : '';
  const hint = [browser, os].filter(Boolean).join(', ');
  return ('Web app' + (hint ? ` (${hint})` : '')).replace(/[^A-Za-z0-9 ().,-]/g, '').slice(0, 40);
}

/**
 * The unlock form. First choice: "Approve from your extension" (device pairing, nothing to type). Then the recovery code or the passphrase;
 * those fields are emptied after every try, right or wrong. While a request is pending the form polls the vault every 3 seconds; it stops on
 * expiry (10 minutes), on Cancel, when the book opens, and when the user leaves the screen (the request is then withdrawn).
 */
export function unlockForm(ctx) {
  const v = ctx.vault;
  const st = v.getState();
  const later = ctx.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const stopTimer = ctx.clearTimer || ((t) => clearTimeout(t));
  let mode = 'pair';   // 'pair' | 'code' | 'pass'
  const pass = input({ type: 'password', autocomplete: 'current-password', spellcheck: 'false' });
  const code = input({ autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' });
  const passField = field('Sync passphrase', pass);
  const codeField = field('Recovery code', code);
  const msg = h('div', { 'aria-live': 'polite' });
  const go = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Unlock');
  const secretPanel = h('div', null, h('h2', null, 'Enter your sync passphrase'),
    h('p', { class: 'sub' }, 'Your book is encrypted. It is opened in this tab only; what you type here is never sent or saved.'),
    passField, codeField, msg, h('div', { class: 'row-end' }, go));

  // The pairing panel: Send a request -> waiting (with Cancel) -> the code -> the book opens.
  const pairMsg = h('div', { 'aria-live': 'polite' });
  const send = button('Send a request', { variant: 'primary' });
  const cancel = button('Cancel', { variant: 'ghost' });
  const codeBox = h('div', { 'aria-live': 'polite' });
  const waiting = h('div', null,
    h('p', null, 'On your computer with BenchPilot, open Settings > Sync (or click the BenchPilot icon) and approve this request.'),
    codeBox, h('progress', { 'aria-label': 'Waiting for your extension' }), h('div', { class: 'row-end' }, cancel));
  const sendRow = h('div', { class: 'row-end' }, send);
  const pairPanel = h('div', null, h('h2', null, 'Approve from your extension'),
    h('p', { class: 'sub' }, 'Your book is encrypted. Send a request, then approve it on a computer where BenchPilot is signed in and syncing. Nothing to type.'),
    waiting, pairMsg, sendRow);

  const toPair = button('Approve from your extension', { variant: 'link', onclick: () => show('pair') });
  const toCode = button('Use recovery code', { variant: 'link', onclick: () => show('code') });
  const toPass = button('Use passphrase', { variant: 'link', onclick: () => show('pass') });
  function show(m) {
    mode = m;
    pairPanel.hidden = m !== 'pair'; secretPanel.hidden = m === 'pair';
    passField.hidden = m !== 'pass'; codeField.hidden = m !== 'code';
    toPair.hidden = m === 'pair'; toCode.hidden = m === 'code'; toPass.hidden = m === 'pass';
    pass.value = ''; code.value = '';
    clear(msg);
    if (m === 'code') code.focus(); else if (m === 'pass') pass.focus();
  }
  // Review M1 + M3: the extension does not show the code; the user types it there. Here, the book opens only after the user confirms.
  const confirmBox = h('input', { type: 'checkbox', id: 'pair-confirm' });
  let shownCode = '', approvedShown = false;
  function showCode(c, approved) {
    if ((c || '') !== shownCode) {
      shownCode = c || '';
      approvedShown = false;
      confirmBox.checked = false;
      clear(codeBox);
      if (c) codeBox.append(h('p', { class: 'code-input', 'aria-label': 'Request code' }, c),
        h('p', null, 'In your extension (Settings > Sync), type this code and approve.'));
    }
    // Re-review L-a: the confirmation box appears only once the extension has approved.
    if (approved && c && !approvedShown) {
      approvedShown = true;
      codeBox.append(h('p', null, 'Your extension approved. Tick the box to open your book.'),
        h('label', { class: 'check-line', for: 'pair-confirm' }, confirmBox, ' I approved in my extension and typed this code there'));
    }
  }
  function showWaiting(on, c) {
    waiting.hidden = !on; sendRow.hidden = on; send.disabled = false;
    showCode(on ? c : '');
  }

  const mine = () => poller && poller.form === form;
  const stopPoll = () => { if (mine()) { if (poller.timer) stopTimer(poller.timer); poller = null; } };
  function schedule() {
    if (poller && poller.timer) stopTimer(poller.timer);
    poller = { form, timer: later(tick, PAIR_POLL_MS) };
  }
  async function tick() {
    if (!mine()) return;
    poller.timer = null;
    if (form.isConnected === false) { poller = null; await v.pairCancel(); return; }   // the user left the screen
    let r;
    try { r = await v.pairStep({ confirmed: confirmBox.checked }); } catch (err) {
      if (!mine()) return;
      if (v.pairInfo()) { schedule(); return; }                                           // a network blip: keep waiting
      poller = null;
      if (v.getState().status !== 'locked') { ctx.refresh(); return; }
      showWaiting(false);
      pairMsg.append(note(err.code === 'pair_expired' ? 'warn' : 'danger', err.message));
      return;
    }
    if (r.status === 'open') { if (mine()) poller = null; picked = null; ctx.refresh(); return; }
    if (!mine()) return;
    if (r.status === 'code' || r.status === 'approved') showCode(r.code, r.status === 'approved');
    schedule();
  }
  send.addEventListener('click', async () => {
    clear(pairMsg);
    send.disabled = true;
    try {
      await v.pairStart(pairLabel(globalThis.navigator && globalThis.navigator.userAgent));
      showWaiting(true, '');
      schedule();
    } catch (err) {
      send.disabled = false;
      if (v.getState().status !== 'locked') { ctx.refresh(); return; }
      pairMsg.append(note('danger', err.message));
    }
  });
  cancel.addEventListener('click', async () => {
    stopPoll();
    showWaiting(false);
    await v.pairCancel();
  });

  const form = h('form', { class: 'card form', autocomplete: 'off', novalidate: true },
    st.notice && st.notice.message ? note(st.notice.code === 'decrypt_failed' || st.notice.code === 'rolled_back' ? 'danger' : 'warn', st.notice.message) : null,
    pairPanel, secretPanel, h('p', { class: 'row-end' }, toPair, toCode, toPass));
  show('pair');
  // A request still pending from before a redraw: show it and take over its poll loop.
  const pending = v.pairInfo ? v.pairInfo() : null;
  if (pending) { showWaiting(true, pending.code); schedule(); } else showWaiting(false);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (mode === 'pair') return;
    clear(msg);
    const useCode = mode === 'code';
    const secret = useCode ? { recoveryCode: code.value } : { passphrase: pass.value };
    pass.value = ''; code.value = '';
    go.disabled = true;
    try {
      if (v.pairInfo && v.pairInfo()) { stopPoll(); showWaiting(false); await v.pairCancel(); }
      await v.unlock(secret);
      picked = null;
      ctx.refresh();
    } catch (err) {
      go.disabled = false;
      if (v.getState().status !== 'locked') { ctx.refresh(); return; }
      msg.append(note('danger', err.message));
      (useCode ? code : pass).focus();
    } finally { secret.passphrase = ''; secret.recoveryCode = ''; }
  });
  return form;
}

/** Every field of a record, as text. */
export function detailList(model, dataset, r) {
  return h('dl', { class: 'book-detail' }, model.detailFields(dataset, r).map((f) => [h('dt', null, f.label), h('dd', null, f.value)]));
}

// ── forms: one field list per data set (the model cleans and checks every value again before anything is written) ──
const t = (k, label, extra) => ({ k, label, type: 'text', ...extra });
const area = (k, label, rows, extra) => ({ k, label, type: 'textarea', rows, wide: true, ...extra });

/** Vendor agreements (staffing P6): the same fields and words as the extension's company panel (lib/vendor-agreements.js). */
function agreementSpec(BP) {
  const A = BP.Agreements;
  if (!A) return [];
  const statuses = Object.fromEntries(A.STATUSES.map((k) => [k, A.STATUS_LABELS[k]]));
  const doc = (p, K) => [
    { k: p + 'Status', label: K, type: 'select', options: statuses, value: (r) => A.clean(r)[p + 'Status'] },
    { k: p + 'SignedOn', label: K + ' signed on', type: 'date' },
    { k: p + 'Until', label: K + ' ends on', type: 'date', hint: 'Leave empty if it has no end date.' }];
  return [...doc('msa', 'MSA'), ...doc('nda', 'NDA'),
    { k: 'netTerms', label: 'Payment terms', type: 'select', options: { '': 'Not set', ...Object.fromEntries(A.NET_TERMS.map((n) => [String(n), 'Net ' + n])) }, value: (r) => (A.clean(r).netTerms ? String(A.clean(r).netTerms) : '') },
    t('paymentNote', 'Payment note', { max: A.NOTE_MAX, wide: true, hint: 'Status and dates only: BenchPilot does not keep the agreement files.' })];
}

/** Edit fields per data set. value(r) gives the current value when it is not simply r[k]. */
function editSpec(ctx, dataset) {
  const { model, BP } = ctx;
  if (dataset === 'leads') return [
    { k: 'status', label: 'Status', type: 'select', options: Object.fromEntries(model.LEAD_STATUSES.map((s) => [s, s])), value: (r) => BP.normalizeStatus(r.status) },
    { k: 'followUpDate', label: 'Follow-up date', type: 'date', hint: 'Leave empty for no follow-up.' },
    area('notes', 'Notes', 4, { max: 2000 })];
  if (dataset === 'consultants') return [t('title', 'Title'),
    { k: 'visaType', label: 'Work authorisation', type: 'select', options: { '': 'Not recorded', ...Object.fromEntries(BP.VISA_TYPES.map((v) => [v, v])) }, value: (r) => BP.consultantVisaType(r) },
    { k: 'workAuthUntil', label: 'Authorised until', type: 'date', hint: 'Only the end date. Never upload or type document numbers.' },
    t('visa', 'Visa note'), t('rate', 'Rate'),
    t('rateMin', 'Minimum rate', { hint: 'A number. Submitting below it shows a warning.' }),
    { k: 'rateUnit', label: 'Minimum rate per', type: 'select', options: BP.RATE_UNIT_LABELS, value: (r) => BP.normalizeRateUnit(r.rateUnit) },
    t('location', 'Location'), { k: 'availableOn', label: 'Available from', type: 'date' },
    { k: 'benchStatus', label: 'Status', type: 'select', options: BP.BENCH_STATUS_LABELS, value: (r) => BP.benchStatusOf(r) },
    // Staffing P5: the consent record (the extension's fields; synced both ways)
    { k: 'consentOn', label: 'Consent given on', type: 'date', hint: 'The day the consultant agreed to be marketed.' },
    { k: 'consentSource', label: 'Consent how', type: 'select', options: { '': 'Not recorded', ...CONSENT_SOURCE_LABELS } },
    t('consentNote', 'Consent note', { max: CONSENT_NOTE_MAX }),
    area('skills', 'Skills', 2, { max: 1000 }), area('notes', 'Notes', 3, { max: 1000 })];
  if (dataset === 'companies') return [t('name', 'Name', { max: 120 }), { k: 'label', label: 'Label', type: 'select', options: BP.COMPANY_LABELS, value: (r) => r.label || 'none' },
    ...agreementSpec(BP), area('notes', 'Notes', 4, { max: 2000 })];
  if (dataset === 'submissions') return [
    { k: 'status', label: 'Status', type: 'select', options: Object.fromEntries(BP.Submissions.STATUSES.map((s) => [s, s])), value: (r) => BP.Submissions.normalizeStatus(r.status) || 'Submitted' },
    { k: 'followUpDate', label: 'Follow-up date', type: 'date', hint: 'Cleared when the status is Rejected or Closed.' },
    // P2: the RTR (given on, valid until, agreed rate), bill and pay rate, and the vendor chain (lib/submissions.js updateRates checks them)
    { k: 'rtrOn', label: 'RTR given on', type: 'date', value: (r) => BP.Submissions.rtrOf(r).on },
    { k: 'rtrUntil', label: 'RTR valid until', type: 'date' },
    t('rtrRate', 'RTR rate ($/hr)', { max: 12, value: (r) => (r.rtrRate == null ? '' : String(r.rtrRate)) }),
    t('billRate', 'Bill rate ($/hr)', { max: 12, value: (r) => (r.billRate == null ? '' : String(r.billRate)) }),
    t('payRate', 'Pay rate ($/hr)', { max: 12, value: (r) => (r.payRate == null ? '' : String(r.payRate)) }),
    t('chain', 'Vendor chain', { max: 400, wide: true, value: (r) => (Array.isArray(r.chain) ? r.chain.join(', ') : ''), hint: 'Between the vendor and the end client, nearest first, up to 4, separated by commas.' }),
    area('rtrNote', 'RTR note', 2, { max: 300 })];
  if (dataset === 'notes') return [t('title', 'Title', { max: 120 }), area('text', 'Text', 8, { max: 5000 })];
  if (dataset === 'templates') return [t('name', 'Name', { max: 120 }), t('subject', 'Subject', { max: 500, wide: true }),
    area('body', 'Body', 10, { max: 10000, hint: 'Placeholders such as {firstName} and {requirement} are filled by the extension when you send.' })];
  return [];
}

/** Add fields per data set. */
function addSpec(ctx, dataset) {
  const { vault, BP } = ctx;
  if (dataset === 'leads') return [t('email', 'Email', { type: 'email', required: true, max: 254 }), t('recruiterName', 'Name'), t('companyName', 'Company'), t('phone', 'Phone'),
    t('requirement', 'Requirement', { wide: true }), t('location', 'Location'), t('technologies', 'Skills'), { k: 'followUpDate', label: 'Follow-up date', type: 'date' }, area('notes', 'Notes', 3, { max: 2000 })];
  if (dataset === 'companies') return [t('domain', 'Email domain', { required: true, hint: 'The part after @ in their emails, for example acme-staffing.com.' }), t('name', 'Name', { max: 120 }),
    { k: 'label', label: 'Label', type: 'select', options: BP.COMPANY_LABELS }, area('notes', 'Notes', 3, { max: 2000 })];
  if (dataset === 'consultants') return [t('name', 'Name', { required: true }), t('title', 'Title'), t('visa', 'Visa'), t('rate', 'Rate'), t('location', 'Location'), t('availability', 'Availability'),
    t('email', 'Email', { type: 'email' }), t('phone', 'Phone'), area('skills', 'Skills', 2, { max: 1000 }), area('notes', 'Notes', 2, { max: 1000 })];
  if (dataset === 'submissions') {
    const people = vault.rows('consultants').filter((x) => BP.onBench(x.r)).sort((a, b) => String(a.r.name).localeCompare(String(b.r.name)));
    return [{ k: 'consultantId', label: 'Consultant', type: 'select', options: { '': 'Choose a consultant', ...Object.fromEntries(people.map((x) => [x.id, x.r.name || 'Unnamed'])) } },
      t('role', 'Role'), t('vendorName', 'Vendor'), t('leadEmail', 'Recruiter email', { type: 'email' }), t('endClient', 'End client'), t('jobId', 'Job ID'),
      t('billRate', 'Bill rate ($/hr)', { max: 12 }), t('payRate', 'Pay rate ($/hr)', { max: 12 }),
      { k: 'rtrOn', label: 'RTR given on', type: 'date' }, { k: 'rtrUntil', label: 'RTR valid until', type: 'date' },
      t('chain', 'Vendor chain', { max: 400, wide: true, hint: 'Between the vendor and the end client, nearest first, up to 4, separated by commas.' }),
      { k: 'status', label: 'Status', type: 'select', options: Object.fromEntries(BP.Submissions.STATUSES.map((s) => [s, s])) }, area('rtrNote', 'RTR note', 2, { max: 300 })];
  }
  if (dataset === 'notes') return [t('title', 'Title', { required: true, max: 120 }), area('text', 'Text', 6, { max: 5000 })];
  if (dataset === 'jobs') return [t('title', 'Title'), t('company', 'Company'), t('email', 'Email', { type: 'email' }), t('location', 'Location'),
    t('postUrl', 'Post link', { type: 'url', wide: true }), area('notes', 'Notes', 3, { max: 2000 })];
  return [];
}

/** The controls for a field list; read() gives the values (booleans for 'bool'). */
function buildFields(spec, r) {
  const el = {};
  const fields = spec.map((f) => {
    const cur = f.value ? f.value(r || {}) : (r && r[f.k] != null ? r[f.k] : '');
    let c;
    if (f.type === 'select') c = select(f.options, String(cur || Object.keys(f.options)[0]));
    else if (f.type === 'bool') c = select(f.options, cur === false ? 'no' : 'yes');
    else if (f.type === 'textarea') c = h('textarea', { rows: f.rows || 3, maxlength: String(f.max || 1000) }, String(cur));
    else c = input({ type: f.type === 'text' ? 'text' : f.type, value: String(cur), maxlength: String(f.max || 600), required: f.required || null });
    el[f.k] = { c, f };
    return field(f.label, c, { wide: f.wide, hint: f.hint });
  });
  const read = () => Object.fromEntries(Object.entries(el).map(([k, { c, f }]) => [k, f.type === 'bool' ? c.value === 'yes' : c.value]));
  return { fields, read };
}

function editForm(ctx, dataset, id, r) {
  const { model, vault } = ctx;
  const msg = h('div', { 'aria-live': 'polite' });
  const { fields, read } = buildFields(editSpec(ctx, dataset), r);
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
  const form = h('form', { class: 'card form', novalidate: true }, h('h2', null, 'Change'), h('div', { class: 'grid' }, fields), msg, h('div', { class: 'row-end' }, save));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    save.disabled = true;
    try {
      await vault.edit(dataset, id, read(), model);
      ctx.toast('Saved. Your other computers get it on their next sync.');
      ctx.refresh();
    } catch (err) {
      save.disabled = false;
      if (!vault.isOpen()) { ctx.refresh(); return; }
      msg.append(note(err.code === 'unchanged' ? 'info' : 'danger', err.message));
    }
  });
  return form;
}

/** Delete with a second, explicit click ("Yes, delete"). */
function deleteCard(ctx, section, id) {
  const { model, vault } = ctx;
  const msg = h('div', { 'aria-live': 'polite' });
  const yes = button('Yes, delete', { variant: 'danger' });
  const no = button('Cancel', { variant: 'ghost' });
  const confirmRow = h('div', { class: 'row-end' }, no, yes);
  confirmRow.hidden = true;
  const ask = button('Delete this ' + section.one, { variant: 'ghost', onclick: () => { ask.hidden = true; confirmRow.hidden = false; yes.focus(); } });
  no.addEventListener('click', () => { confirmRow.hidden = true; ask.hidden = false; });
  yes.addEventListener('click', async () => {
    clear(msg);
    yes.disabled = true;
    try {
      await vault.remove(section.dataset, id, model);
      picked = null;
      ctx.toast('Deleted. Your other computers remove it on their next sync.');
      ctx.refresh();
    } catch (err) {
      yes.disabled = false;
      if (!vault.isOpen()) { ctx.refresh(); return; }
      msg.append(note('danger', err.message));
    }
  });
  return card('Delete', [h('p', { class: 'hint' }, 'It is removed from every computer on their next sync. This cannot be undone here.'), msg, h('div', { class: 'row-end' }, ask), confirmRow], { class: 'card-danger' });
}

function addView(ctx, section) {
  const { model, vault } = ctx;
  const msg = h('div', { 'aria-live': 'polite' });
  const { fields, read } = buildFields(addSpec(ctx, section.dataset), null);
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add');
  const back = button('Back to ' + section.label.toLowerCase(), { variant: 'link', onclick: () => { adding = null; ctx.refresh(); } });
  const form = h('form', { class: 'card form', novalidate: true }, h('div', { class: 'grid' }, fields), msg, h('div', { class: 'row-end' }, save));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    save.disabled = true;
    try {
      const out = await vault.create(section.dataset, read(), model);
      adding = null;
      picked = { dataset: section.dataset, id: out.id };
      ctx.toast(out.guard ? 'Added. Note: ' + out.guard : 'Added. Your other computers get it on their next sync.');
      ctx.refresh();
    } catch (err) {
      save.disabled = false;
      if (!vault.isOpen()) { ctx.refresh(); return; }
      msg.append(note(err.code === 'exists' ? 'warn' : 'danger', err.message));
    }
  });
  return h('div', { class: 'stack' }, h('p', null, back), pageHeader('Add a ' + section.one), form);
}

/** Download one synced resume file: decrypted in this tab, handed to the browser as a download, then dropped. */
async function downloadResume(ctx, id, btn, msg) {
  clear(msg);
  btn.disabled = true;
  let url = '';
  try {
    const f = await ctx.vault.resumeFile(id);
    url = URL.createObjectURL(new Blob([f.bytes], { type: f.type }));
    const a = h('a', { href: url, download: f.fileName || 'resume' });
    document.body.append(a);
    a.click();
    a.remove();
    f.bytes.fill(0);
  } catch (err) {
    if (!ctx.vault.isOpen()) { ctx.refresh(); return; }
    msg.append(note('danger', err.message));
  } finally {
    btn.disabled = false;
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function detailView(ctx, section) {
  const { model, vault } = ctx;
  const row = vault.rows(section.dataset).find((x) => x.id === picked.id);
  const back = button('Back to ' + section.label.toLowerCase(), { variant: 'link', onclick: () => { picked = null; ctx.refresh(); } });
  if (!row) { picked = null; return h('div', { class: 'stack' }, pageHeader('Not found'), note('warn', 'That record is not in your synced book any more.'), back); }
  const v = model.VIEWS[section.dataset];
  const parts = [h('p', null, back), pageHeader(v.title(row.r) || section.one), card(null, detailList(model, section.dataset, row.r))];
  if (section.dataset === 'resumes') {
    const msg = h('div', { 'aria-live': 'polite' });
    const btn = button('Download', { variant: 'primary' });
    btn.addEventListener('click', () => downloadResume(ctx, row.id, btn, msg));
    parts.push(card(null, [h('p', { class: 'hint' }, 'The file is decrypted in this tab and saved by your browser. It is never stored by the web app.'), msg, h('div', { class: 'row-end' }, btn)]));
  } else parts.push(model.canEdit(section.dataset) ? editForm(ctx, section.dataset, row.id, row.r) : h('p', { class: 'hint' }, 'Change this in the extension.'));
  if (model.canDelete(section.dataset) && vault.datasetState(section.dataset) === 'ok') parts.push(deleteCard(ctx, section, row.id));
  return h('div', { class: 'stack' }, parts);
}

function listView(ctx, section) {
  const { model, vault } = ctx;
  const v = model.VIEWS[section.dataset];
  const all = vault.rows(section.dataset);
  const ds = vault.datasetState(section.dataset);
  const q = input({ type: 'search', placeholder: 'Search', 'aria-label': 'Search ' + section.label.toLowerCase() });
  const filterOpts = v.filter ? v.filter.options(all) : null;
  const f = v.filter ? select(filterOpts, '', { 'aria-label': v.filter.label }) : null;
  const out = h('div', { 'aria-live': 'polite' });
  const people = section.dataset === 'resumes' ? new Map(vault.rows('consultants').map((x) => [x.id, x.r.name])) : null;
  const draw = () => {
    clear(out);
    const shown = model.filterRows(section.dataset, all, q.value, f ? f.value : '');
    out.append(h('p', { class: 'hint' }, all.length === shown.length ? plural(all.length, section.one) : `${shown.length} of ${plural(all.length, section.one)}`));
    if (!shown.length) { out.append(empty(all.length ? 'Nothing matches the search.' : `No ${section.label.toLowerCase()} in your synced book yet.`)); return; }
    const cols = v.columns.map((c, i) => (i === 0
      ? { label: c.label, cell: (x) => button(c.cell(x.r) || 'Untitled', { variant: 'link', onclick: () => { picked = { dataset: section.dataset, id: x.id }; ctx.refresh(); } }) }
      : { label: c.label, cell: (x) => c.cell(x.r) }));
    if (people) cols.splice(1, 0, { label: 'Consultant', cell: (x) => people.get(x.r.consultantId) || (x.r.consultantId === 'me' ? 'My profile' : '') });
    out.append(table(cols, shown.slice(0, 500), { caption: section.label }));
    if (shown.length > 500) out.append(h('p', { class: 'hint' }, 'Showing the first 500. Search to narrow the list.'));
  };
  q.addEventListener('input', draw);
  if (f) f.addEventListener('change', draw);
  draw();
  const canAdd = model.canAdd(section.dataset) && (ds === 'ok' || ds === 'empty');
  const sub = section.dataset === 'resumes' ? 'Resume files synced from the extension. Open one to download it.'
    : model.canEdit(section.dataset) ? 'Open a ' + section.one + ' to see every field and make changes.' : 'Open a ' + section.one + ' to see every field.';
  return h('div', { class: 'stack' },
    pageHeader(section.label, sub, canAdd ? button('Add a ' + section.one, { variant: 'primary', onclick: () => { adding = section.dataset; picked = null; ctx.refresh(); } }) : null),
    ds === 'decrypt_failed' || ds === 'rolled_back' ? note('danger', vault.MESSAGES[ds] + ' This list cannot be changed here.') : null,
    h('div', { class: 'filters' }, field('Search', q), f ? field(v.filter.label, f) : null),
    out);
}

/** The Solo morning summary: yesterday's numbers from the decrypted book, the extension's own BP.Homework.yesterday. */
export function summaryView(ctx, nowMs) {
  const { vault, model } = ctx;
  let s;
  try {
    s = model.morningSummary({ leads: vault.rows('leads').map((x) => x.r), submissions: vault.rows('submissions').map((x) => x.r), settings: vault.settings() }, nowMs);
  } catch (err) { return h('div', { class: 'stack' }, pageHeader('Morning summary'), note('danger', err.message)); }
  const tileOf = (n, label) => h('div', { class: 'tile' }, h('span', { class: 'tile-num' }, String(n)), h('span', { class: 'tile-label' }, label));
  return h('div', { class: 'stack' },
    pageHeader('Morning summary', 'Yesterday (' + s.day + '), counted in this tab from your synced book, the same way as Today in the extension.'),
    h('div', { class: 'tiles' },
      tileOf(s.saved, 'Requirements saved'), tileOf(s.sent, 'Submissions sent'), tileOf(s.replies, 'Vendor replies'), s.interviews ? tileOf(s.interviews, 'Interviews') : null),
    h('p', null, s.text),
    h('p', { class: 'hint' }, 'Your homework ticks stay on each computer, so they are not counted here. A day runs from your shift start (Today in the extension) to the next.'),
    targetsCard(ctx, nowMs));
}

/** "Your targets": the week and month targets set on Insights in the extension (synced), with progress from the synced submissions. */
export function targetsCard(ctx, nowMs) {
  const { vault, model } = ctx;
  let list;
  try {
    list = model.personalTargets({ submissions: vault.rows('submissions').map((x) => x.r), settings: vault.settings() }, nowMs);
  } catch (err) { return null; }
  return card('Your targets', list.length
    ? h('div', { class: 'stack' },
      list.map((t) => h('div', { class: 'stack book-target' }, h('h3', { class: 'book-target-h' }, t.title), progressList(t.progress))),
      h('p', { class: 'hint' }, 'Set on Insights in the extension and synced here. Counted from your submissions: an interview on the day it is held, a placement on its start day.'))
    : h('p', { class: 'muted' }, 'No target yet. Set a weekly or monthly target on Insights in the BenchPilot extension; it shows here once it syncs.'));
}

/** Changed on two computers: the same panel as the extension's Settings > Sync, for the conflicts this tab saw. */
function conflictsView(ctx) {
  const { vault, model } = ctx;
  const list = vault.conflicts();
  const msg = h('div', { 'aria-live': 'polite' });
  const items = list.map((c) => {
    const act = async (action, b) => {
      clear(msg);
      b.disabled = true;
      try { await vault.resolveConflict(c.key, action, model); ctx.refresh(); } catch (err) {
        b.disabled = false;
        if (!vault.isOpen()) { ctx.refresh(); return; }
        msg.append(note('danger', err.message));
      }
    };
    const use = button('Use the other version', { onclick: (e) => act('keep-other', e.currentTarget) });
    const dis = button('Dismiss', { variant: 'ghost', onclick: (e) => act('dismiss', e.currentTarget) });
    const where = (SECTIONS.find((s) => s.dataset === c.dataset) || { label: c.dataset }).label;
    return h('li', null, h('span', null, `${c.label} (${where}: this tab’s version kept)`), use, dis);
  });
  return h('div', { class: 'stack' },
    pageHeader('Changed on two computers', 'These were changed here and on another computer within a minute. We kept the newer version and saved the other one here. Nothing was lost.'),
    msg,
    list.length ? h('ul', { class: 'book-conflicts' }, items) : empty('Nothing to check. Conflicts the extension found are listed in its Settings > Sync.'),
    h('p', { class: 'hint' }, 'This list is kept in this tab only and is cleared when the book locks.'));
}

/**
 * Change passphrase, or "Add a passphrase" when the account has none (sync made its keys without one): the same rules and server action as the
 * extension's Settings > Sync. Every field is emptied after every try.
 */
export function passphraseView(ctx) {
  const { vault } = ctx;
  if (!vault.hasPassphrase()) return addPassphraseView(ctx);
  let useCode = false;
  const cur = input({ type: 'password', autocomplete: 'current-password', spellcheck: 'false' });
  const code = input({ autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' });
  const next = input({ type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
  const again = input({ type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
  const curField = field('Current passphrase', cur);
  const codeField = field('Recovery code', code);
  codeField.hidden = true;
  const msg = h('div', { 'aria-live': 'polite' });
  const go = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Change passphrase');
  const toggle = button('Use recovery code instead', {
    variant: 'ghost',
    onclick: () => {
      useCode = !useCode;
      curField.hidden = useCode; codeField.hidden = !useCode;
      toggle.textContent = useCode ? 'Use passphrase instead' : 'Use recovery code instead';
      cur.value = ''; code.value = '';
    }
  });
  const form = h('form', { class: 'card form', autocomplete: 'off', novalidate: true },
    h('p', null, 'Your book stays encrypted with the same key; only the passphrase that opens it changes. Your other computers keep syncing and ask for the new passphrase the next time they unlock. Your recovery code stays the same.'),
    curField, codeField, field('New passphrase', next, { hint: 'At least 12 characters. A few unrelated words work well.' }), field('New passphrase again', again), msg,
    h('div', { class: 'row-end' }, toggle, go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    const secret = { current: useCode ? '' : cur.value, recoveryCode: useCode ? code.value : '', next: next.value };
    const same = next.value === again.value;
    cur.value = ''; code.value = ''; next.value = ''; again.value = '';
    if (!same) { secret.current = ''; secret.recoveryCode = ''; secret.next = ''; msg.append(note('danger', 'The two new passphrases are not the same.')); return; }
    go.disabled = true;
    try {
      await vault.changePassphrase(secret, ctx.session.user.email);
      ctx.toast('Passphrase changed. Use the new one from now on.');
      if (ctx.go) ctx.go('#book-summary'); else ctx.refresh();
    } catch (err) {
      go.disabled = false;
      if (!vault.isOpen()) { ctx.refresh(); return; }
      msg.append(note('danger', err.message));
    } finally { secret.current = ''; secret.recoveryCode = ''; secret.next = ''; }
  });
  return h('div', { class: 'stack' }, pageHeader('Change passphrase'), form,
    h('p', { class: 'hint' }, '"Replace my keys" (a new key for everything) and turning sync off stay in the extension: Settings > Sync across computers.'));
}

/** Add a passphrase: the open book's key (checked when it was opened) is enough, so only the new passphrase is asked, twice. */
function addPassphraseView(ctx) {
  const { vault } = ctx;
  const next = input({ type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
  const again = input({ type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
  const msg = h('div', { 'aria-live': 'polite' });
  const go = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add passphrase');
  const form = h('form', { class: 'card form', autocomplete: 'off', novalidate: true },
    h('p', null, 'A passphrase lets you open your book by typing something you remember, as well as with your recovery code or by approving from your extension. Your book stays encrypted with the same key, and your recovery code stays the same.'),
    field('New passphrase', next, { hint: 'At least 12 characters. A few unrelated words work well.' }), field('New passphrase again', again), msg,
    h('div', { class: 'row-end' }, go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    const secret = { next: next.value };
    const same = next.value === again.value;
    next.value = ''; again.value = '';
    if (!same) { secret.next = ''; msg.append(note('danger', 'The two passphrases are not the same.')); return; }
    go.disabled = true;
    try {
      await vault.changePassphrase(secret, ctx.session.user.email);
      ctx.toast('Passphrase added. You can now use it to open your book.');
      if (ctx.go) ctx.go('#book-summary'); else ctx.refresh();
    } catch (err) {
      go.disabled = false;
      if (!vault.isOpen()) { ctx.refresh(); return; }
      msg.append(note('danger', err.message));
    } finally { secret.next = ''; }
  });
  return h('div', { class: 'stack' }, pageHeader('Add a passphrase'), form,
    h('p', { class: 'hint' }, '"Replace my keys" (a new key for everything) and turning sync off stay in the extension: Settings > Sync across computers.'));
}

/** My book's sidebar: the summary, each synced list, the inbox, conflicts (only when there are some) and the passphrase (Add / Change). */
export function bookGroups(o) {
  const x = o || {};
  const ICONS = { leads: 'user', vendors: 'vendors', consultants: 'bench', submissions: 'submissions', notes: 'file', jobs: 'requirements', templates: 'templates', resumes: 'file' };
  return [
    { label: 'My book', items: [
      { href: '#book-summary', label: 'Morning summary', icon: 'today', current: x.page === 'summary' },
      ...SECTIONS.map((s) => ({ href: '#book-' + s.name, label: s.label, icon: ICONS[s.name] || 'list', current: x.section === s.name })),
      { href: '#book-inbox', label: 'Inbox', icon: 'inbox', current: x.page === 'inbox' }] },
    { label: 'Settings', items: [
      x.conflictCount ? { href: '#book-conflicts', label: 'Changed on two computers', icon: 'alert', count: x.conflictCount, current: x.page === 'conflicts' } : null,
      { href: '#book-passphrase', label: x.hasPassphrase === false ? 'Add a passphrase' : 'Change passphrase', icon: 'lock', current: x.page === 'passphrase' },
      { href: '#billing', label: 'Plan and billing', icon: 'billing', current: x.page === 'billing' }].filter(Boolean) }
  ];
}

/** Pages of My book that are not a list: '' and 'summary' (the landing page), 'conflicts', 'passphrase', 'inbox'. */
const PAGES = ['', 'summary', 'conflicts', 'passphrase', 'inbox'];
const NOTHING_YET = 'Nothing synced yet. Open the extension on the computer that has your book; it uploads within a few minutes.';

/**
 * @param ctx { vault, model, BP, session, route, refresh(), signOut(), toast(text), go?(hash), now?() }
 *   vault.check() has already run for this account (app.js).
 */
export function render(ctx) {
  const st = ctx.vault.getState();
  const page = PAGES.includes(ctx.route.section) ? (ctx.route.section || 'summary') : '';
  const section = sectionByName(ctx.route.section);
  const open = st.status === 'open' && ctx.vault.isOpen();
  if (picked && (!open || page || picked.dataset !== section.dataset)) picked = null;
  if (adding && (!open || page || adding !== section.dataset)) adding = null;
  const conflictCount = open ? ctx.vault.conflicts().length : 0;
  const shellOpts = ctx.shell || {};
  const lockBtn = ctx.vault.isOpen() ? h('button', { type: 'button', class: 'menu-item', onclick: () => { ctx.vault.lock(null); picked = null; ctx.refresh(); } }, 'Lock my book') : null;
  const { root, main } = appShell({
    ...shellOpts, session: ctx.session, workspace: 'book', hasTeam: Boolean(ctx.session.hasTeam), syncTiers: SYNC_TIERS,
    groups: bookGroups({ page, section: open && !page ? section.name : '', conflictCount, hasPassphrase: open ? ctx.vault.hasPassphrase() : undefined }),
    title: TITLE, mainClass: open ? null : 'book-gate', menuExtra: lockBtn ? [lockBtn] : [],
    // "Invite a teammate" is the step from a personal book to a team (it starts the pilot); members invite on the Team page.
    primary: h('a', { class: 'btn btn-primary btn-sm top-action', href: ctx.session.hasTeam ? '#team' : '#welcome' }, 'Invite a teammate'),
    onSignOut: ctx.signOut
  });
  const msgs = ctx.vault.MESSAGES;
  if (st.status === 'plan') main.append(pageHeader(TITLE), upgradeCard(msgs));
  else if (st.status === 'no_keys') main.append(pageHeader(TITLE), note('info', msgs.no_keys));
  else if (st.status === 'error') main.append(pageHeader(TITLE), note('danger', (st.notice && st.notice.message) || 'Something went wrong. Please try again.'), button('Try again', { variant: 'primary', onclick: () => ctx.refresh() }));
  else if (!open) main.append(pageHeader(TITLE, 'Your own book from the extension, decrypted in this tab only.'), unlockForm(ctx));
  else if (page === 'inbox' && ctx.inbox) main.append(bookInbox.render(ctx));
  else if (page === 'conflicts') main.append(conflictsView(ctx));
  else if (page === 'passphrase') main.append(passphraseView(ctx));
  else {
    const anything = SECTIONS.some((s) => ctx.vault.datasetState(s.dataset) !== 'empty');
    if (page === 'summary') main.append(anything ? summaryView(ctx, ctx.now ? ctx.now() : Date.now()) : h('div', { class: 'stack' }, pageHeader(TITLE), note('info', NOTHING_YET)));
    else if (adding) main.append(addView(ctx, section));
    else if (!anything && !ctx.model.canAdd(section.dataset)) main.append(pageHeader(TITLE), note('info', NOTHING_YET));
    else main.append(picked ? detailView(ctx, section) : listView(ctx, section));
  }
  return root;
}
