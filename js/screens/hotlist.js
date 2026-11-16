// Bench -> "Hotlist" (spec docs/specs/HOTLIST_BUILDER_SPEC.md): the team bench as a hotlist email, a table for Gmail / Outlook or a CSV.
// The formatter is the extension's own lib/hotlist.js (BP.Hotlist, loaded by bp-lib.js), so the text is the same in both places.
// Nothing is sent and nothing is written to the team's data: the user pastes the result into their own mail app. The last columns,
// order and name style are kept in localStorage `bp_hotlist_prefs` on this browser.

import { h, clear } from '../dom.js';
import { field, select, button, note, toast, plural } from '../ui.js';
import { availableLater } from '../consultant-profile.js';
import { hasConsent } from '../consent.js';

/** Staffing P5: the soft warning under the count, '' when every ticked consultant has a consent date. Never blocks the copy. */
export function consentWarning(ticked) {
  const n = (ticked || []).filter((c) => !hasConsent(c)).length;
  if (!n) return '';
  return (n === 1 ? '1 ticked consultant has' : n + ' ticked consultants have') + ' no consent recorded. Record it on their page before you send this.';
}

export const PREFS_KEY = 'bp_hotlist_prefs';
/** The consultants ticked when the panel opens: the ones being marketed. */
export const DEFAULT_STATUSES = ['marketing'];

function readPrefs(H, storage) {
  try { return H.cleanPrefs(JSON.parse(storage.getItem(PREFS_KEY) || 'null')); } catch (e) { return H.cleanPrefs(null); }
}
function savePrefs(p, storage) {
  try { storage.setItem(PREFS_KEY, JSON.stringify({ columns: p.columns, nameStyle: p.nameStyle, profiles: p.profiles === true })); } catch (e) { /* not kept */ }
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyPlain(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); } catch (e) { toast('Could not copy. Select the text and copy it.'); }
}

/** Rich text (text/html + text/plain) where the browser allows it; otherwise the plain text, and the user is told. */
async function copyTable(htmlText, plain) {
  try {
    if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem === 'function') {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([htmlText], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' })
      })]);
      toast('Copied the table. Paste it into your email.');
      return;
    }
  } catch (e) { /* fall back to plain text */ }
  await copyPlain(plain, 'Copied as plain text: this browser could not copy the table.');
}

/**
 * @param {object} ctx      the screen context (session.today, session.user.name)
 * @param {object[]} consultants  the team bench (store.listConsultants())
 * @param {object} H        BP.Hotlist
 * @param {{ storage?: Storage, onClose?: Function }} [opts]
 */
export function hotlistPanel(ctx, consultants, H, opts) {
  const o = opts || {};
  const storage = o.storage || window.localStorage;
  const prefs = readPrefs(H, storage);
  // Ticked to start: Marketing, and free now or within 30 days (staffing P1: someone free only later can still be ticked by hand).
  const today = ctx.session.today;
  const picked = new Set(consultants.filter((c) => DEFAULT_STATUSES.includes(c.status) && !availableLater(c, today)).map((c) => c.id));
  // The CSV is a file of team data, so it follows the workspace export policy (perms.js 'export'); copying text does not.
  const canExport = typeof ctx.can === 'function' ? ctx.can('export') : true;
  const textOpts = () => ({ myName: ctx.session.user && ctx.session.user.name, today });
  const chosen = () => consultants.filter((c) => picked.has(c.id)).map((c) => H.fromTeam(c, today));

  const subject = h('input', { type: 'text', readOnly: true });
  const body = h('textarea', { rows: '10', readOnly: true, 'aria-label': 'Email text' });
  const count = h('p', { class: 'hint', 'aria-live': 'polite' });
  const consentBox = h('div', { 'aria-live': 'polite' });
  const colsBox = h('ol', { class: 'hl-cols', 'aria-label': 'Columns' });

  function paint() {
    const list = chosen();
    const t = H.text(list, prefs, textOpts());
    subject.value = list.length ? t.subject : '';
    body.value = list.length ? t.body : '';
    count.textContent = plural(list.length, 'consultant') + ' ticked. Phone, email and resume never go in.';
    clear(consentBox);
    const warn = consentWarning(consultants.filter((c) => picked.has(c.id)));
    if (warn) consentBox.append(note('warn', warn));
  }

  function paintCols() {
    clear(colsBox);
    const order = prefs.columns.concat(H.COLUMN_KEYS.filter((k) => !prefs.columns.includes(k)));
    for (const k of order) {
      const on = prefs.columns.includes(k);
      const i = prefs.columns.indexOf(k);
      const move = (dir) => {
        const j = i + dir;
        [prefs.columns[i], prefs.columns[j]] = [prefs.columns[j], prefs.columns[i]];
        savePrefs(prefs, storage); paintCols(); paint();
      };
      colsBox.append(h('li', { class: 'hl-col' },
        h('label', null, h('input', {
          type: 'checkbox', checked: on,
          onchange: (e) => {
            if (e.target.checked) prefs.columns.push(k);
            else if (prefs.columns.length === 1) { e.target.checked = true; toast('Keep at least one column.'); return; }
            else prefs.columns = prefs.columns.filter((x) => x !== k);
            savePrefs(prefs, storage); paintCols(); paint();
          }
        }), ' ', H.COLUMN_LABELS[k]),
        button('↑', { variant: 'ghost', disabled: !on || i === 0, 'aria-label': 'Move ' + H.COLUMN_LABELS[k] + ' up', onclick: () => move(-1) }),
        button('↓', { variant: 'ghost', disabled: !on || i === prefs.columns.length - 1, 'aria-label': 'Move ' + H.COLUMN_LABELS[k] + ' down', onclick: () => move(1) })));
    }
  }

  const people = h('div', { class: 'hl-people', role: 'group', 'aria-label': 'Consultants in the hotlist' },
    consultants.map((c) => h('div', { class: 'field check' },
      h('input', { type: 'checkbox', id: 'hl-' + c.id, checked: picked.has(c.id), onchange: (e) => { if (e.target.checked) picked.add(c.id); else picked.delete(c.id); paint(); } }),
      h('label', { for: 'hl-' + c.id }, c.name + (c.title ? ' - ' + c.title : '')))));

  const names = select(Object.fromEntries(H.NAME_STYLES), prefs.nameStyle, {
    onchange: (e) => { prefs.nameStyle = H.cleanPrefs({ nameStyle: e.target.value }).nameStyle; savePrefs(prefs, storage); paint(); }
  });

  // The masked profile summaries (BP.Hotlist.profile) under the list: one short profile per consultant, no contact details.
  const profiles = h('div', { class: 'field check' },
    h('input', { type: 'checkbox', id: 'hl-profiles', checked: prefs.profiles === true, onchange: (e) => { prefs.profiles = e.target.checked; savePrefs(prefs, storage); paint(); } }),
    h('label', { for: 'hl-profiles' }, 'Add profile summaries under the list (no contact details)'));

  const need = () => { const list = chosen(); if (!list.length) toast('Tick at least one consultant.'); return list; };
  const actions = h('div', { class: 'actions' },
    button('Copy text', { variant: 'primary', onclick: () => { const l = need(); if (l.length) copyPlain(H.text(l, prefs, textOpts()).body, 'Copied the hotlist with ' + plural(l.length, 'consultant')); } }),
    button('Copy subject', { variant: 'secondary', onclick: () => { const l = need(); if (l.length) copyPlain(H.text(l, prefs, textOpts()).subject, 'Copied the subject'); } }),
    button('Copy table', { variant: 'secondary', title: 'A table you can paste into Gmail or Outlook', onclick: () => { const l = need(); if (l.length) copyTable(H.html(l, prefs, textOpts()), H.text(l, prefs, textOpts()).body); } }),
    button('Download CSV', { variant: 'secondary', disabled: !canExport, title: canExport ? null : 'Your workspace owner has turned off exports for your role.', onclick: () => { const l = need(); if (l.length) download('benchpilot_hotlist_' + today + '.csv', H.csv(l, prefs)); } }),
    o.onClose ? button('Close', { variant: 'ghost', onclick: o.onClose }) : null);

  paintCols();
  paint();
  return h('section', { class: 'card hl', 'aria-label': 'Hotlist' },
    h('h2', null, 'Hotlist'),
    h('div', { class: 'hl-grid' },
      h('div', { class: 'stack-tight' }, h('h3', null, 'Consultants'), people),
      h('div', { class: 'stack-tight' }, h('h3', null, 'Columns'), field('Names', names), colsBox, profiles)),
    h('div', { class: 'stack-tight' }, h('h3', null, 'Preview'), count, consentBox, field('Subject', subject), body),
    actions,
    note('info', 'BenchPilot never sends email. Paste this into your own mail app and add the recipients there. Send a resume only when a vendor asks for it.'));
}
