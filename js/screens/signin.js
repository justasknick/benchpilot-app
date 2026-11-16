// Sign in (spec section 5, screen 1): Google, or an email and a 6-digit code (no password), plus "Try the demo workspace".
// In demo mode (?demo=1) there is nothing to sign in to: one button enters the demo workspace.

import { h, clear } from '../dom.js';
import { button, field, input, note } from '../ui.js';
import { icon } from '../icons.js';
import { brand, PRODUCT } from '../shell.js';
import { providerEnabled } from '../config.js';

const RESEND_SECONDS = 30;

// The right-hand panel: a small picture of the product drawn with the demo's made-up people and companies (never real data), and
// three plain facts. Hidden from screen readers as a picture; the facts are real text.
const SAMPLE_ROWS = [
  ['Ravi K.', 'Senior Java Developer', 'Brightpath Staffing', 'Vendor screen', 'accent'],
  ['Anita M.', 'QA Automation Lead', 'Northbay Staffing', 'Submitted', 'neutral'],
  ['Kiran P.', 'DevOps Engineer', 'Lakeview Talent', 'Client interview', 'ok']
];
const VALUE_POINTS = [
  ['book', 'Your own book, on any computer', 'With Solo, the book you keep in the extension opens here, encrypted end to end and unlocked only in your tab.'],
  ['bench', 'One desk for the whole team', 'A shared bench, vendor book, requirements and submissions, with a check before anyone submits the same consultant twice.'],
  ['shield', 'Hands off LinkedIn', 'BenchPilot never clicks or messages on LinkedIn, and it is not affiliated with LinkedIn.']
];

function productMock() {
  const tile = (n, label) => h('div', { class: 'mock-tile' }, h('span', { class: 'mock-num' }, n), h('span', { class: 'mock-label' }, label));
  return h('div', { class: 'mock', 'aria-hidden': 'true' },
    h('div', { class: 'mock-bar' }, h('span', { class: 'mock-dot' }), h('span', { class: 'mock-dot' }), h('span', { class: 'mock-dot' }), h('span', { class: 'mock-url' }, 'Today · sample data')),
    h('div', { class: 'mock-body' },
      h('div', { class: 'mock-tiles' }, tile('12', 'Submissions this week'), tile('3', 'In client interview'), tile('7', 'On the bench')),
      h('div', { class: 'mock-table' },
        h('div', { class: 'mock-row mock-head' }, h('span', null, 'Consultant'), h('span', null, 'Vendor'), h('span', null, 'Stage')),
        SAMPLE_ROWS.map(([name, role, vendor, stage, kind]) => h('div', { class: 'mock-row' },
          h('span', null, h('strong', null, name), h('small', null, role)), h('span', null, vendor), h('span', null, h('span', { class: 'chip chip-' + kind }, stage))))),
      h('div', { class: 'mock-guard' }, icon('alert', { size: 16 }),
        h('span', null, h('strong', null, 'Already submitted. '), 'Priya S. sent Ravi K. to Brightpath Staffing for this client 6 days ago.'))));
}

function valuePanel() {
  return h('aside', { class: 'auth-panel', 'aria-label': 'About ' + PRODUCT },
    h('p', { class: 'eyebrow eyebrow-on-purple' }, 'For bench sales recruiters'),
    h('h2', { class: 'auth-panel-title' }, 'Your bench sales day, in one place.'),
    productMock(),
    h('ul', { class: 'auth-points' }, VALUE_POINTS.map(([ico, title, text]) => h('li', null,
      h('span', { class: 'auth-point-ico' }, icon(ico, { size: 18 })), h('span', null, h('strong', null, title), h('span', null, text))))));
}

/** The split sign-in layout (design brief D): the card on the left, the product panel on the right (wide screens only). */
export function authLayout(...cardKids) {
  return h('main', { class: 'auth', id: 'main' },
    h('div', { class: 'auth-form' }, h('div', { class: 'auth-card' }, h('div', { class: 'auth-brand' }, brand(32)), ...cardKids),
      h('p', { class: 'auth-legal' }, 'Not affiliated with LinkedIn.')),
    valuePanel());
}

function demoScreen(ctx) {
  return authLayout(
    h('h1', { id: 'page-title', tabindex: '-1' }, 'Demo workspace'),
    h('p', { class: 'sub' }, 'A team workspace filled with sample data: the bench, vendor book, requirements and submissions, with the check before anyone submits the same consultant twice.'),
    note('info', 'Everyone in this demo is made up. Nothing you type leaves this browser.'),
    button('Enter the demo workspace', { variant: 'primary', class: 'btn-block btn-lg', onclick: async () => { await ctx.store.signIn(); ctx.onSignedIn(); } }),
    h('p', { class: 'center hint' }, h('a', { href: location.pathname }, 'Back to sign in')));
}

/**
 * @param ctx { store, auth, session, notice?:string, hasInvite?:boolean, onSignedIn(), tryDemo() }
 */
export async function render(ctx) {
  if (ctx.store.mode === 'demo') return demoScreen(ctx);

  const auth = ctx.auth;
  const msg = h('div', { 'aria-live': 'polite' });
  const body = h('div', { class: 'signin-body' });
  let email = '';
  let timer = null;

  const show = (kind, text) => { clear(msg); if (text) msg.append(note(kind, text)); };

  function stepEmail() {
    clearInterval(timer);
    clear(body);
    const emailIn = input({ type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'name@company.com', value: email, required: true });
    const send = h('button', { type: 'submit', class: 'btn btn-secondary btn-block' }, 'Email me a code');
    const form = h('form', { class: 'form', novalidate: true }, field('Work email', emailIn), send);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      show('', '');
      send.disabled = true;
      try { await auth.requestCode(emailIn.value); email = emailIn.value.trim(); stepCode(); }
      catch (err) { show('danger', err.message); emailIn.focus(); }
      finally { send.disabled = false; }
    });
    body.append(
      button('Continue with Google', { variant: 'primary', class: 'btn-block', onclick: () => auth.startGoogle() }),
      // "Sign in with Microsoft" (Supabase's Azure provider): only when config.js turns it on, after Nick's setup (docs/setup/MICROSOFT_SIGN_IN.md)
      providerEnabled('azure') ? button('Continue with Microsoft', { variant: 'secondary', class: 'btn-block', onclick: () => auth.startMicrosoft() }) : null,
      h('p', { class: 'divider center hint' }, h('span', null, 'or')),
      form);
  }

  function stepCode() {
    clear(body);
    const codeIn = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '9', placeholder: '123456', class: 'code-input', pattern: '[0-9 ]*' });
    const verify = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in');
    const resend = button('Resend code', { variant: 'link', disabled: true });
    const form = h('form', { class: 'form', novalidate: true },
      h('p', { class: 'sub' }, 'We sent a 6-digit code to ', h('span', { class: 'strong' }, email), '. It can take a minute. Check your spam folder too.'),
      field('6-digit code', codeIn), verify);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      show('', '');
      verify.disabled = true;
      try { await auth.verifyCode(email, codeIn.value); await ctx.onSignedIn(); }
      catch (err) { show('danger', err.message); codeIn.focus(); verify.disabled = false; }
    });
    let left = RESEND_SECONDS;
    const tick = () => {
      resend.textContent = left > 0 ? `Resend code (${left}s)` : 'Resend code';
      resend.disabled = left > 0;
      left -= 1;
      if (left < -1) clearInterval(timer);
    };
    timer = setInterval(tick, 1000);
    tick();
    resend.addEventListener('click', async () => {
      show('', '');
      try { await auth.requestCode(email); show('ok', 'A new code is on its way.'); left = RESEND_SECONDS; timer = setInterval(tick, 1000); tick(); }
      catch (err) { show('danger', err.message); }
    });
    body.append(form, h('div', { class: 'row-split' }, resend, button('Use a different email', { variant: 'link', onclick: () => { show('', ''); stepEmail(); } })));
    codeIn.focus();
  }

  stepEmail();
  if (ctx.notice) show('warn', ctx.notice);

  return authLayout(
    h('h1', { id: 'page-title', tabindex: '-1' }, ctx.hasInvite ? 'Sign in to join your team' : 'Sign in to ' + PRODUCT),
    h('p', { class: 'sub' }, ctx.hasInvite
      ? 'Use the email address your invite was sent to. The invite is accepted as soon as you are in.'
      : 'One sign-in for your own book and your team\'s workspace. No password: Google, or a code by email.'),
    msg, body,
    ctx.hasInvite ? null : h('p', { class: 'hint' }, 'New here? Sign in with your work email, then create your team\'s workspace. The 14-day pilot starts there.'),
    h('p', { class: 'hint auth-safe' }, icon('shield', { size: 14 }), h('span', null, 'Protected by sign-in codes. We never see your LinkedIn password.')),
    h('div', { class: 'demo-offer' },
      h('div', { class: 'divider hint' }, h('span', null, 'Just looking?')),
      button('Try the demo workspace', { variant: 'secondary', class: 'btn-block', onclick: () => ctx.tryDemo() })));
}
