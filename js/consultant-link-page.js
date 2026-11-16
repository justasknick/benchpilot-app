// webapp/js/consultant-link-page.js - the page a consultant opens from a self-service link (consultant-link.html, migration 0056). No account,
// no session, no storage: it reads the token from the #fragment, removes it from the address bar, asks the `team` function's public
// link-view action what it may show (the firm, the consultant's first name, and for an RTR the role and end client), and sends the answers
// with link-respond. ?demo=1 shows sample data and saves nothing (the demo workspace's "Make link").

import { h, clear } from './dom.js';
import { field, input, select, note, button } from './ui.js';
import { CONFIG } from './config.js';
import { tokenFromHash, respondBody, RATE_UNIT_OPTIONS, LOCATION_PREF_MAX } from './consultant-links.js';

const card = document.getElementById('cl-card');
const params = new URLSearchParams(location.search);
const demo = params.get('demo') === '1';
const token = demo ? '' : tokenFromHash(location.hash);
// The token stays in memory only: out of the address bar and the history entry at once.
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

const PRIVACY_URL = 'https://justasknick.github.io/benchpilot-site/privacy.html';
const DEMO_VIEW = { firm: 'Northbay Talent (sample)', first_name: 'Ravi', expires_at: new Date(Date.now() + 13 * 86400000).toISOString(), answered: false,
  rtr: params.get('rtr') === '1' ? { role: 'Senior Java Developer', end_client: 'Harborline Bank' } : null };

async function call(body) {
  const r = await fetch(CONFIG.SUPABASE_URL + '/functions/v1/team', {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_ANON_KEY }, body: JSON.stringify(body),
    credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store'
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok) {
    const e = new Error((j && j.error && j.error.message) || 'Something went wrong. Please try again later.');
    e.code = j && j.error && j.error.code;
    throw e;
  }
  return j;
}

function title(text) { return h('h1', { id: 'page-title', tabindex: '-1' }, text); }

function showProblem(message) {
  clear(card).append(title('This link cannot be used'), note('danger', message),
    h('p', { class: 'sub' }, 'Ask your recruiter for a new link. Nothing else is needed from you.'));
}

function fmtDay(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

function form(view) {
  const firm = view.firm || 'Your recruiter';
  const avail = input({ type: 'date' });
  const rate = input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: 'e.g. 65' });
  const unit = select(RATE_UNIT_OPTIONS, 'hr', { 'aria-label': 'Rate per' });
  const loc = input({ maxlength: String(LOCATION_PREF_MAX), placeholder: 'e.g. Remote, or Dallas or Austin', autocomplete: 'off' });
  const radio = (name, value, label, extra) => {
    const id = name + '-' + value;
    return h('div', { class: 'field check' }, h('input', { type: 'radio', name, id, value }), h('label', { for: id }, label, extra || null));
  };
  const consent = h('fieldset', { class: 'cl-choice' }, h('legend', null, 'May ' + firm + ' share your profile with clients and vendors?'),
    radio('consent', 'give', 'Yes, you may market my profile'), radio('consent', 'decline', 'No, please do not'));
  const rtr = view.rtr ? h('fieldset', { class: 'cl-choice' },
    h('legend', null, 'Right to represent'),
    h('p', { class: 'hint' }, `${firm} would like to submit you for ${view.rtr.role ? 'the ' + view.rtr.role + ' role' : 'a role'}${view.rtr.end_client ? ' at ' + view.rtr.end_client : ''}. Only one firm should submit you for the same role.`),
    radio('rtr', 'give', `I give ${firm} the right to represent me for this role`), radio('rtr', 'decline', 'I do not')) : null;
  const msg = h('div', { 'aria-live': 'polite' });
  const send = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Send my answers');
  const f = h('form', { class: 'form', novalidate: true },
    field('Available from', avail, { hint: 'The first day you can start.' }),
    h('div', { class: 'cl-rate' }, field('Minimum rate', rate), field('Per', unit)),
    field('Where would you like to work?', loc, { hint: 'Remote, a city, or both.' }),
    consent, rtr, msg, send);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    const pick = (name) => { const el = f.querySelector(`input[name="${name}"]:checked`); return el ? el.value : ''; };
    const b = respondBody({ availableOn: avail.value, rateMin: rate.value, rateUnit: unit.value, locationPref: loc.value, consent: pick('consent'), rtr: pick('rtr') }, Boolean(view.rtr));
    if (b.error) { msg.append(note('danger', b.error)); return; }
    send.disabled = true;
    try {
      if (!demo) await call({ action: 'link-respond', token, ...b.body });
      done(view, b.body);
    } catch (err) { msg.append(note('danger', err.message)); send.disabled = false; }
  });
  clear(card).append(
    h('p', { class: 'cl-kicker' }, firm),
    title(`Hi ${view.first_name || 'there'}, please confirm your details`),
    h('p', { class: 'sub' }, `${firm} asked you to confirm a few things. Answer only what you want to change; everything is optional.`
      + (view.expires_at ? ` This link works until ${fmtDay(view.expires_at)}.` : '')),
    view.answered ? note('info', 'You already sent answers. Sending again replaces them.') : '',
    demo ? note('info', 'Sample page: answers are not saved.') : '',
    f,
    h('p', { class: 'hint cl-privacy' }, `Your answers go only to ${firm}, who keeps them with your profile. This page shows nothing else about you. `,
      h('a', { href: PRIVACY_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Privacy policy'), '. Powered by BenchPilot.'));
}

function done(view, body) {
  const lines = [];
  if (body.consent === 'give') lines.push('You agreed to be marketed.'); else if (body.consent === 'decline') lines.push('You asked not to be marketed.');
  if (body.rtr === 'give') lines.push('You gave the right to represent you for this role.'); else if (body.rtr === 'decline') lines.push('You declined the right to represent.');
  clear(card).append(title(`Thank you, ${view.first_name || 'there'}`),
    note('ok', `${view.firm || 'Your recruiter'} has your answers.` + (demo ? ' (Sample page: nothing was saved.)' : '')),
    ...lines.map((t) => h('p', null, t)),
    h('p', { class: 'sub' }, 'You can close this page. To change an answer, open the link again while it still works.'),
    button('Change my answers', { variant: 'ghost', onclick: () => form({ ...view, answered: true }) }));
  const t = card.querySelector('#page-title');
  if (t) t.focus({ preventScroll: true });
}

async function start() {
  if (demo) { form(DEMO_VIEW); return; }
  if (!token) { showProblem('This link is not complete. Open it again from the message you received.'); return; }
  try { form(await call({ action: 'link-view', token })); } catch (err) { showProblem(err.message); }
  const t = card.querySelector('#page-title');
  if (t) t.focus({ preventScroll: true });
}
start();
