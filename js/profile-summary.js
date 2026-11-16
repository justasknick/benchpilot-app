// webapp/js/profile-summary.js - the masked one-page "profile summary" of a consultant on the consultant page (the extension's Bench has the
// same panel: dashboard/views/bench.js openProfileSummary). The text comes from the extension's lib/hotlist.js (BP.Hotlist.profile, loaded by
// bp-lib.js loadHotlistLib), so both say the same thing. It is built only from the hotlist fields: no phone, email, LinkedIn, notes, resume
// or work-authorisation date, and the name is masked (initials, or first name + last initial). The resume file is never read or changed.
// "Print or save as PDF" prints only the sheet (css/app.css @media print); the person attaches the PDF themselves. Nothing is sent.

import { h, clear } from './dom.js';
import { select, field, button, toast } from './ui.js';

/** The sheet (preview and printed page) for one profile from BP.Hotlist.profile(). */
export function profileSheet(pr) {
  return h('article', { class: 'pf-sheet', 'aria-label': 'Profile summary of ' + pr.name },
    h('header', { class: 'pf-top' },
      h('p', { class: 'pf-kicker' }, 'Consultant profile'),
      h('h2', { class: 'pf-name' }, pr.name),
      pr.headline ? h('p', { class: 'pf-headline' }, pr.headline) : null),
    pr.facts.length ? h('dl', { class: 'pf-facts' }, pr.facts.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v)))) : null,
    pr.skills.length ? h('section', { class: 'pf-skills' }, h('h3', null, 'Skills'), h('ul', null, pr.skills.map((s) => h('li', null, s)))) : null,
    h('p', { class: 'pf-note' }, pr.note));
}

/** Print only the sheet: it goes into #print-sheet, the body gets .printing-sheet (app.css hides everything else), and the title names the PDF. */
export function printSheet(pr) {
  let host = document.getElementById('print-sheet');
  if (!host) { host = h('div', { id: 'print-sheet' }); document.body.append(host); }
  clear(host).append(profileSheet(pr));
  const title = document.title;
  document.title = 'Profile - ' + pr.name;
  document.body.classList.add('printing-sheet');
  const done = () => { document.body.classList.remove('printing-sheet'); document.title = title; clear(host); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

/**
 * The panel: name style, rate on or off, the preview, Copy text and Print or save as PDF.
 * @param {object} ctx  the screen context (session.today)
 * @param {object} c    a team consultant
 * @param {object} H    BP.Hotlist
 * @param {{ onClose?: Function }} [opts]
 */
export function profilePanel(ctx, c, H, opts) {
  const o = opts || {};
  const choice = H.cleanProfileOpts(null);
  const preview = h('div', { class: 'pf-preview' });
  const now = () => H.profile(H.fromTeam(c, ctx.session.today), choice);
  const paint = () => clear(preview).append(profileSheet(now()));
  const names = select(Object.fromEntries(H.PROFILE_NAME_STYLES), choice.nameStyle, {
    onchange: (e) => { choice.nameStyle = H.cleanProfileOpts({ nameStyle: e.target.value }).nameStyle; paint(); }
  });
  const rate = h('input', { type: 'checkbox', id: 'pf-rate', checked: choice.rate, onchange: (e) => { choice.rate = e.target.checked; paint(); } });
  paint();
  return h('section', { class: 'card pf', 'aria-label': 'Profile summary' },
    h('h2', null, 'Profile summary'),
    h('p', { class: 'hint' }, 'A one-page summary to attach to a pitch or a hotlist email. Phone, email, LinkedIn, notes and the resume are never in it.'),
    h('div', { class: 'pf-opts' }, field('Name', names), h('div', { class: 'field check pf-check' }, rate, h('label', { for: 'pf-rate' }, 'Show the rate'))),
    preview,
    h('div', { class: 'row-end' },
      o.onClose ? button('Close', { variant: 'ghost', onclick: o.onClose }) : null,
      button('Copy text', { variant: 'secondary', onclick: async () => {
        try { await navigator.clipboard.writeText(now().text); toast('Copied the profile summary.'); } catch (e) { toast('Could not copy. Select the text and copy it.'); }
      } }),
      button('Print or save as PDF', { variant: 'primary', onclick: () => printSheet(now()) })),
    h('p', { class: 'hint' }, 'Choose "Save as PDF" in the print window, then attach the file to your email yourself. Your resume files are not changed.'));
}
