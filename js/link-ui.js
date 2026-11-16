// webapp/js/link-ui.js - the screens for migration 0056:
//   consultantLinkCard(ctx, c, subs)  the consultant page's "Consultant link" card (owners and managers): make a link for this consultant
//                                     (optionally with the RTR for one submission), copy it, see whether it was opened or answered, cancel it.
//   signupDomainCard(ctx, team)       the team page's "Sign-in and sign-ups" card (owner): "Restrict sign-ups to my company domain", and
//                                     what single sign-on there is (Google and Microsoft; SAML is an Enterprise request, not built).
// The rules are in js/consultant-links.js and on the server (team function, 0056 SQL).

import { h, clear } from './dom.js';
import { card, field, input, select, note, chip, button, toast, empty } from './ui.js';
import { fmtShort } from './dates.js';
import { providerEnabled } from './config.js';
import { LINK_DAYS, LINK_STATES, LINK_STATE_KIND, linkState, answerText, normalizeDomain } from './consultant-links.js';

async function copy(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); } catch (e) { toast('Could not copy. Select the link and copy it.'); }
}
const day = (iso) => String(iso || '').slice(0, 10);

/** The "Consultant link" card, or null for a recruiter (RLS lets only owners and managers read the links). */
export function consultantLinkCard(ctx, c, subs) {
  if (!ctx.can('consultant_links')) return null;
  const body = h('div', { class: 'stack-tight cl' });
  const made = h('div', { 'aria-live': 'polite' });
  const listBox = h('div');
  const subLabel = (s) => [s.endClient || 'Submission', s.submittedOn ? fmtShort(s.submittedOn) : ''].filter(Boolean).join(', ');
  const open = (subs || []).filter((s) => !['rejected', 'no_response', 'placed'].includes(s.stage));
  const which = select({ '': 'Availability, rate, location and consent', ...Object.fromEntries(open.map((s) => [s.id, 'Also the RTR for ' + subLabel(s)])) }, '');
  const canMake = ctx.can('consultant_links') && !ctx.readOnly;

  async function paint() {
    let links;
    try { links = await ctx.store.listConsultantLinks(c.id); } catch (e) { clear(listBox).append(note('danger', e.message)); return; }
    const now = Date.now();
    clear(listBox).append(links.length ? h('ul', { class: 'cl-list' }, links.map((l) => {
      const st = linkState(l, now);
      const sub = l.submissionId ? (subs || []).find((s) => s.id === l.submissionId) : null;
      const ans = answerText(l.response);
      return h('li', { class: 'cl-row' },
        h('div', { class: 'cl-main' },
          h('strong', null, (sub ? 'With the RTR for ' + subLabel(sub) : 'Availability, rate, location and consent')),
          h('span', { class: 'muted' }, `Made ${fmtShort(day(l.createdAt))} · ${st === 'cancelled' ? 'cancelled' : st === 'ended' ? 'ended' : 'open until ' + fmtShort(day(l.expiresAt))}`
            + (l.opens ? ` · opened ${l.opens} time${l.opens === 1 ? '' : 's'}` : ' · not opened yet')),
          ans ? h('span', { class: 'cl-answer' }, 'Answer: ' + ans + (l.respondedAt ? ` (${fmtShort(day(l.respondedAt))})` : '')) : null),
        chip(LINK_STATES[st], LINK_STATE_KIND[st]),
        st === 'active' || st === 'answered'
          ? button('Cancel link', { variant: 'ghost', 'aria-label': 'Cancel this consultant link', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { await ctx.store.revokeConsultantLink(l.id); toast('Link cancelled. It no longer opens.'); paint(); } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
          } })
          : null);
    })) : empty('No link made yet.'));
  }

  async function make(btn) {
    btn.disabled = true;
    clear(made);
    try {
      const r = await ctx.store.createConsultantLink(c.id, which.value || null);
      const url = new URL(r.link, location.href).href;
      const box = input({ value: url, readOnly: true, 'aria-label': 'The consultant link' });
      made.append(h('div', { class: 'cl-made' },
        note('ok', `Link made. It works for ${LINK_DAYS} days. Send it to ${c.name.split(/\s+/)[0]} yourself (email or WhatsApp). It is shown only now.`),
        h('div', { class: 'cl-copy' }, box, button('Copy link', { variant: 'primary', onclick: () => copy(url, 'Link copied.') }))));
      box.select();
      paint();
    } catch (err) { made.append(note('danger', err.message)); }
    btn.disabled = false;
  }

  body.append(
    h('p', { class: 'muted' }, `A private link for ${c.name.split(/\s+/)[0]} to confirm their availability date, minimum rate, location preference and consent to be marketed, and, if you choose a submission, to give the RTR. No account needed. The page shows only your firm's name, their first name and, for an RTR, the role and end client. Answers are saved on this page.`),
    canMake
      ? h('div', { class: 'cl-make' }, field('The link asks for', which), button('Make link', { variant: 'secondary', onclick: (e) => make(e.currentTarget) }))
      : note('info', ctx.readOnly ? 'The workspace is read-only, so no new link can be made until the plan is paid.' : 'Only owners and managers make consultant links.'),
    made,
    h('h3', { class: 'cl-h' }, 'Links'),
    listBox,
    h('p', { class: 'hint' }, `A new link for the same consultant and submission cancels the earlier one. Links end after ${LINK_DAYS} days. Erasing the consultant deletes their links.`));
  paint();
  return card('Consultant link', body, { class: 'cl-card' });
}

/** The owner's "Sign-in and sign-ups" card: the company domain rule, and the single sign-on there is. */
export function signupDomainCard(ctx, team) {
  const current = (team.settings && team.settings.signupDomain) || '';
  const owner = ctx.session.role === 'owner';
  const msg = h('div', { 'aria-live': 'polite' });
  const domain = input({ value: current, placeholder: 'yourcompany.com', autocomplete: 'off', spellcheck: false, maxlength: '253', disabled: !owner || ctx.readOnly });
  const form = h('form', { class: 'form', novalidate: true },
    field('Restrict sign-ups to my company domain', domain, { hint: 'Only people with an address at this domain can be invited or join. Leave it empty to allow any address. People already in the workspace stay.' }),
    msg,
    owner ? h('div', { class: 'row-end' },
      current ? button('Remove the rule', { variant: 'ghost', disabled: ctx.readOnly, onclick: () => save('') }) : null,
      h('button', { type: 'submit', class: 'btn btn-primary', disabled: ctx.readOnly }, 'Save')) : null);
  async function save(value) {
    clear(msg);
    try {
      const r = await ctx.store.setSignupDomain(value);
      toast(r.domain ? `Only @${r.domain} addresses can join now.` + (r.revoked ? ` ${r.revoked} pending invite${r.revoked === 1 ? ' was' : 's were'} cancelled.` : '') : 'Any address can be invited again.');
      ctx.refresh();
    } catch (err) { msg.append(note('danger', err.message)); domain.focus(); }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); save(normalizeDomain(domain.value)); });
  return card('Sign-in and sign-ups', h('div', { class: 'stack-tight' },
    current ? h('p', null, chip('Only @' + current, 'accent'), ' ', h('span', { class: 'muted' }, 'Invites and joins from other domains are refused.')) : null,
    owner ? form : h('p', { class: 'muted' }, current ? `Only @${current} addresses can join. The owner sets this.` : 'Any address can be invited. The owner can restrict this to the company domain.'),
    h('p', { class: 'hint' }, `Everyone signs in with Google${providerEnabled('azure') ? ', Microsoft' : ''} or an email link. SAML single sign-on (Okta, Microsoft Entra ID, Google Workspace) is an Enterprise option: write to us if your company needs it.`)));
}

/** The line under the invite form when the rule is on. */
export function inviteDomainHint(team) {
  const d = team && team.settings && team.settings.signupDomain;
  return d ? h('p', { class: 'hint' }, `Only @${d} addresses can be invited (the owner's rule under Sign-in and sign-ups).`) : null;
}

