// Create your workspace (spec section 5, screen 2): the team name, then "Invite your team" (emails and roles, can be skipped).
// Shown to a signed-in person who is not in a team yet. The person who creates the workspace becomes its owner.

import { h, clear } from '../dom.js';
import { field, input, select, note, button, toast } from '../ui.js';
import { getRef, clearRef } from '../referral.js';
import { fmtLong } from '../dates.js';
import { purgeText } from '../billing-extra.js';

/**
 * Why this person has no team any more (0040: `me` -> session.lastTeam, for 30 days after the end), as one sentence; '' = say nothing.
 * @param {{name:string, reason:'removed'|'left'|'closed', endedOn:string, wasOwner:boolean}|null} t
 * @param {boolean} [purgeEnabled] `me` purge_enabled (0043): the purge of closed workspaces is switched on, so the week-before email is promised
 */
export function lastTeamText(t, purgeEnabled) {
  if (!t || !t.name) return '';
  const on = t.endedOn ? ' on ' + fmtLong(t.endedOn) : '';
  if (t.reason === 'left') return 'You left ' + t.name + on + '. To go back, ask its owner or a manager to invite you again.';
  if (t.reason === 'closed') {
    return t.wasOwner
      ? t.name + ' was closed' + on + '. To get it back, contact support soon. ' + purgeText(purgeEnabled)
      : t.name + ' was closed' + on + ', so nobody can use it any more. Ask its owner if it should still be open.';
  }
  return 'You were removed from ' + t.name + on + '. What you added stays with that workspace. To work in it again, ask its owner or a manager to invite you.';
}

/** The line under "Create your workspace": the 14-day pilot, or (0040) a reminder that this person's pilot is used. */
export function pilotLine(pilotAvailable) {
  return pilotAvailable === false
    ? 'You will be the owner. Your free pilot was used with an earlier workspace, so this one starts read-only until a plan is paid.'
    : 'You will be the owner. Your 14-day pilot starts now.';
}

const MAX_ROWS = 10;
const ROLE_OPTIONS = { recruiter: 'Recruiter', manager: 'Manager' };

function shellCard(...kids) {
  return h('main', { class: 'signin', id: 'main' }, h('div', { class: 'signin-card signin-wide' }, ...kids));
}

/** @param ctx { store, session, go, signOut(), onDone() } */
export async function render(ctx) {
  const root = h('div', { class: 'signin-body' });

  function stepName() {
    clear(root);
    const name = input({ autocomplete: 'organization', maxlength: '80', placeholder: 'Northwind Consulting', required: true });
    const msg = h('div', { 'aria-live': 'polite' });
    const go = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Create workspace');
    const form = h('form', { class: 'form', novalidate: true },
      field('Team name', name, { hint: 'Your company or desk. You can find it again under Team.' }), msg, go);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(msg);
      if (!name.value.trim()) { msg.append(note('danger', 'Please enter a team name (1 to 80 characters).')); name.focus(); return; }
      go.disabled = true;
      // A colleague's pilot link (js/referral.js) goes with the create call once; the workspace is created whatever its code is.
      const ref = getRef();
      try {
        const made = await ctx.store.createTeam(name.value, ref ? { ref } : undefined);
        clearRef();
        // No pilot (0040): the workspace is read-only, so nobody can be invited yet. Go to Team, where the owner pays.
        if (made && made.pilot === false) { toast('Workspace created. Pay for a plan under Plan and billing to start using it.'); ctx.onDone('#billing'); return; }
        stepInvite(name.value.trim());
      } catch (err) { msg.append(note('danger', err.message)); go.disabled = false; name.focus(); }
    });
    const ended = lastTeamText(ctx.session && ctx.session.lastTeam, ctx.session && ctx.session.purgeEnabled);
    root.append(
      ...(ended ? [note('info', ended)] : []),
      h('p', { class: 'step' }, 'Step 1 of 2'),
      h('h1', { id: 'page-title', tabindex: '-1' }, 'Create your workspace'),
      h('p', { class: 'sub' }, pilotLine(ctx.session && ctx.session.pilotAvailable)),
      ...(ended ? [h('p', { class: 'hint' }, 'Waiting for an invite? Open the link in the email to join that workspace instead.')] : []),
      ...(getRef() ? [h('p', { class: 'hint' }, 'You came from a colleague\u2019s link. If your firm buys a plan after the pilot, they get a thank-you from us. Nothing else is shared with them.')] : []),
      form,
      h('p', { class: 'center' }, 'On the Solo plan? ', h('a', { href: '#book' }, 'Open my book'), ' (your own book from the extension, no team needed).'),
      h('p', { class: 'center' }, h('a', { href: '#account' }, 'Your account'), ' · ', button('Sign out', { variant: 'link', onclick: () => ctx.signOut() })));
    name.focus();
  }

  function stepInvite(teamName) {
    clear(root);
    const rows = [];
    const list = h('div', { class: 'invite-rows' });
    const msg = h('div', { 'aria-live': 'polite' });
    const addRow = () => {
      const n = rows.length + 1;
      const email = input({ type: 'email', autocomplete: 'off', placeholder: 'name@company.com', 'aria-label': 'Email for person ' + n });
      const role = select(ROLE_OPTIONS, 'recruiter', { 'aria-label': 'Role for person ' + n });
      const status = h('span', { class: 'hint', 'aria-live': 'polite' });
      rows.push({ email, role, status });
      list.append(h('div', { class: 'invite-row' }, h('div', { class: 'invite-email' }, email), h('div', { class: 'invite-role' }, role), status));
    };
    for (let i = 0; i < 3; i += 1) addRow();
    const more = button('Add another', { variant: 'ghost', onclick: () => { if (rows.length < MAX_ROWS) { addRow(); rows[rows.length - 1].email.focus(); } if (rows.length >= MAX_ROWS) more.disabled = true; } });
    const send = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send invites');
    const skip = button('Skip for now', { variant: 'ghost', onclick: () => ctx.onDone() });
    const form = h('form', { class: 'form', novalidate: true }, list, h('div', { class: 'row-split' }, more), msg, h('div', { class: 'row-end' }, skip, send));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(msg);
      const todo = rows.filter((r) => r.email.value.trim());
      if (!todo.length) { ctx.onDone(); return; }
      send.disabled = true;
      let sent = 0;
      for (const r of todo) {
        r.status.textContent = 'Sending...';
        try { await ctx.store.inviteMember({ email: r.email.value, role: r.role.value }); r.status.textContent = 'Sent'; r.email.value = ''; sent += 1; }
        catch (err) { r.status.textContent = err.message; r.status.className = 'hint hint-danger'; }
      }
      send.disabled = false;
      if (sent === todo.length) { toast(sent === 1 ? 'Invite sent.' : sent + ' invites sent.'); ctx.onDone(); return; }
      msg.append(note('warn', sent ? `${sent} of ${todo.length} invites sent. Fix the others, or continue and invite them later under Team.` : 'No invites were sent. Fix the addresses, or continue and invite them later under Team.'));
      skip.textContent = 'Continue to the workspace';
    });
    root.append(
      h('p', { class: 'step' }, 'Step 2 of 2'),
      h('h1', { id: 'page-title', tabindex: '-1' }, 'Invite your team'),
      h('p', { class: 'sub' }, `${teamName} is ready. Add the people who will work in it. Each gets an email with a link that works once, for 7 days. You can skip this and invite people later.`),
      form);
    rows[0].email.focus();
  }

  stepName();
  return shellCard(root);
}
