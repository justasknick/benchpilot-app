// Accept an invite: route #accept (the emailed link was #accept-<token>; invite.js moved the token out of the address bar).
// A signed-out person signs in first (app.js shows the sign-in screen with an invite note), then this screen uses the invite.

import { h } from '../dom.js';
import { button, note } from '../ui.js';
import { acceptPending, clearPending } from '../invite.js';
import { ROLE_LABELS } from '../perms.js';

/** @param ctx { store, session, go, signOut(), onJoined() } */
export async function render(ctx) {
  const card = h('div', { class: 'signin-card' }, h('h1', { id: 'page-title', tabindex: '-1' }, 'Joining your team'), h('p', { class: 'sub', role: 'status' }, 'One moment...'));
  const page = h('main', { class: 'signin', id: 'main' }, card);

  async function run() {
    const r = await acceptPending(ctx.store);
    card.replaceChildren();
    if (r.status === 'joined') {
      card.append(
        h('h1', { id: 'page-title', tabindex: '-1' }, 'You are in'),
        note('ok', `You joined ${r.teamName} as ${ROLE_LABELS[r.role] || r.role}.`),
        button('Open the workspace', { variant: 'primary', class: 'btn-block', onclick: () => ctx.onJoined() }));
    } else if (r.status === 'none') {
      card.append(h('h1', { id: 'page-title', tabindex: '-1' }, 'No invite to accept'), h('p', { class: 'sub' }, 'Open the link from your invite email again.'), button('Continue', { variant: 'primary', class: 'btn-block', onclick: () => ctx.onJoined() }));
    } else {
      const mismatch = r.code === 'invite_email_mismatch';
      const actions = r.status === 'retry'
        ? [mismatch ? button('Sign out and use another email', { variant: 'primary', class: 'btn-block', onclick: () => ctx.signOut() }) : button('Try again', { variant: 'primary', class: 'btn-block', onclick: () => { card.replaceChildren(h('p', { role: 'status' }, 'One moment...')); run(); } }),
          button('Not now', { variant: 'ghost', class: 'btn-block', onclick: () => { clearPending(); ctx.onJoined(); } })]
        : [button('Continue', { variant: 'primary', class: 'btn-block', onclick: () => ctx.onJoined() })];
      card.append(
        h('h1', { id: 'page-title', tabindex: '-1' }, mismatch ? 'Wrong email address' : 'This invite could not be used'),
        note('danger', r.message),
        ...(mismatch ? [h('p', { class: 'sub' }, 'You are signed in as ', h('span', { class: 'strong' }, ctx.session.user.email), '. Sign out, then sign in with the address the invite was sent to.')] : []),
        ...actions);
    }
    const t = card.querySelector('#page-title');
    if (t) t.focus({ preventScroll: true });
  }
  run();
  return page;
}
