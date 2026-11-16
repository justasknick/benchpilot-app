// #account - Your account (live only, team or not): who is signed in, and "Delete my account" (backlog E11).
// Steps: 1. confirm it is you with a 6-digit code sent to this address (the server needs a sign-in within 10 minutes), 2. type the email,
// 3. delete. The logic lives in js/delete-account.js; the server refuses a team owner and says what to do first.

import { h, clear } from '../dom.js';
import { field, input, button, note, pageHeader } from '../ui.js';
import { createAccountDeleter, confirmMatches, DELETED_NOTICE } from '../delete-account.js';
import { planLine, renewNote, RENEW_WHERE } from '../personal-plan.js';
import { todayISO } from '../dates.js';

/**
 * "Your plan": the person's own plan (Solo, Pro ...) and its end date, with the Renew note in the last 14 days. Solo is renewed in the
 * extension (Plans); the web app has no Solo checkout.
 */
export function planSection(loadPlan, today) {
  const body = h('div', { 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'Loading your plan…'));
  const box = h('section', { class: 'card', 'aria-label': 'Your plan' }, h('h2', null, 'Your plan'), body);
  if (typeof loadPlan !== 'function') { clear(body); return box; }
  Promise.resolve().then(loadPlan).then((plan) => {
    clear(body);
    const renew = renewNote(plan, today);
    body.append(h('p', null, planLine(plan, today)),
      renew ? note('warn', renew)
        : h('p', { class: 'hint' }, plan && plan.tier !== 'free' ? 'Plans do not renew by themselves. ' + RENEW_WHERE : 'Solo is bought in the extension: Plans.'));
  }, (err) => { clear(body); body.append(note('danger', 'Your plan could not be loaded: ' + (err && err.message ? err.message : 'please try again.'))); });
  return box;
}

/** @param ctx { auth, config, session, go, signOut(), onDeleted(notice), fetch?, loadPlan? } */
export function render(ctx) {
  const deleter = createAccountDeleter({ auth: ctx.auth, config: ctx.config, fetch: ctx.fetch });
  const email = (ctx.session && ctx.session.user && ctx.session.user.email) || '';
  let confirmed = false;

  const msg = h('div', { 'aria-live': 'polite' });
  const say = (kind, text) => { clear(msg); if (text) msg.append(note(kind, text)); };

  // step 1: the code
  const sendBtn = button('Email me a 6-digit code', { onclick: sendCode });
  const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]*', placeholder: '123456' });
  const codeBtn = button('Confirm code', { onclick: confirmCode });
  const codeRow = h('div', { class: 'form', hidden: true }, field('Code from your email', code), codeBtn);
  const stepOk = h('p', { class: 'hint', hidden: true }, 'Confirmed. Finish within 10 minutes.');

  // step 2: typed email; step 3: delete
  const typed = input({ type: 'email', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', oninput: paint });
  const delBtn = h('button', { type: 'button', class: 'btn btn-danger btn-block', disabled: true, onclick: doDelete }, 'Delete my account');

  function paint() { delBtn.disabled = !(confirmed && confirmMatches(typed.value, email)); }

  async function sendCode() {
    say('', '');
    sendBtn.disabled = true;
    try {
      await deleter.sendCode();
      codeRow.hidden = false;
      say('info', 'We emailed a 6-digit code to ' + email + '. It can take a minute.');
      code.focus();
    } catch (e) { say('danger', e.message); }
    finally { sendBtn.disabled = false; }
  }

  async function confirmCode() {
    say('', '');
    codeBtn.disabled = true;
    try {
      await deleter.confirmCode(code.value);
      confirmed = true;
      code.value = '';
      codeRow.hidden = true;
      stepOk.hidden = false;
      paint();
      typed.focus();
    } catch (e) { say('danger', e.message); }
    finally { codeBtn.disabled = false; }
  }

  async function doDelete() {
    say('', '');
    delBtn.disabled = true;
    delBtn.textContent = 'Deleting…';
    try {
      await deleter.deleteAccount(typed.value);
      ctx.onDeleted(DELETED_NOTICE);
      return;
    } catch (e) {
      if (e.code === 'reauth_required') {
        confirmed = false; stepOk.hidden = true;
        say('danger', 'For your safety, confirm it is you again with a new code (step 1), then delete within 10 minutes.');
      } else if (e.code === 'session_expired') {
        ctx.onDeleted('');   // signed out: the sign-in page explains
        return;
      } else say('danger', e.message);
    }
    delBtn.textContent = 'Delete my account';
    paint();
  }

  // The page body only: app.js puts it inside the app shell (the account menu there has Sign out).
  return h('div', { class: 'stack page-narrow' },
    pageHeader('Your account', ['Signed in as ', h('strong', null, email)]),
    planSection(ctx.loadPlan, todayISO()),
    h('section', { class: 'card card-danger', 'aria-label': 'Delete my account' },
      h('h2', null, 'Delete my account'),
      h('p', null, 'This deletes your BenchPilot account for good: your sign-in, your plan, your encrypted synced copy and resume files, and your personal inbox. Payments stay in our accounts for tax records, without your name or email. If you are in a team, you leave it and what you added stays with the team. If you own a team workspace that is still open, transfer it or delete the workspace first (Team). A closed workspace you own is deleted for good together with your account. The extension keeps the data on your computer unless you clear it there.'),
      h('ol', { class: 'del-steps' },
        h('li', null, h('strong', null, 'Confirm it is you. '), sendBtn, codeRow, stepOk),
        h('li', null, field('Type your email address (' + email + ')', typed)),
        h('li', null, delBtn)),
      msg));
}
