// Team settings: members and roles, invites, export policy, plan and billing, export, delete (spec sections 3, 5.9 and 8).
// What shows depends on the role: owners see everything, managers can invite and change roles (not owners), recruiters see the list only.
// Plan and billing has its own page (screens/billing.js, #billing); this page shows a summary card that links to it.

import { h, clear } from '../dom.js';
import { pageHeader, card, table, chip, field, input, select, note, empty, button, toast, plural, lockNote } from '../ui.js';
import { ROLE_LABELS, canChangeMember, canLeave } from '../perms.js';
import { fmtLong } from '../dates.js';
import { exportZip } from '../export-zip.js';
import { inboxAddress } from '../inbox-lib.js';
import { pausedInboxAddresses, WEEKDAYS, weekdayOf } from '../live-map.js';
import { hasFeature, FEATURE_FROM } from '../plan-gate.js';
import { desksCard } from '../desk-ui.js';
import { referralCard, purgeText } from '../billing-extra.js';
import { planStatusText, planChip, seatText, TIER_NAMES } from './billing.js';
import { signupDomainCard, inviteDomainHint } from '../link-ui.js';

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The browser's own time zone (the default for the morning report), or '' when the browser does not say. */
function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
}

function zoneControl(value) {
  let zones = [];
  try { zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []; } catch (e) { zones = []; }
  if (!zones.length) return input({ value, autocomplete: 'off', placeholder: 'America/New_York' });
  if (value && !zones.includes(value)) zones = [value, ...zones];
  return select(Object.fromEntries(zones.map((z) => [z, z.replace(/_/g, ' ')])), value);
}

/** Minutes until an invite can be sent again (0040: once every RESEND_MINUTES); 0 = now. No sentAt (older server) = now. */
export const RESEND_MINUTES = 15;
export function resendWaitMinutes(sentAt, nowMs) {
  const t = Date.parse(sentAt || '');
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t + RESEND_MINUTES * 60000 - nowMs) / 60000));
}

/** "1 of 1 addresses in use" (the plan limit; turned-off addresses do not count). */
export function inboxLimitText(info) {
  if (info.unavailable) return 'The inbox numbers could not be loaded. Refresh the page to try again.';
  if (!info.limit) return 'Your plan has no inbox address. Team · 15 has one and Team · 40 has three.';
  return info.used + ' of ' + info.limit + ' addresses in use';
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Address copied.'); } catch (e) { toast('Copy did not work. Select the address and copy it by hand.'); }
}

function inboxSteps(addr) {
  const a = addr || 'your BenchPilot address';
  const steps = (title, items) => h('details', { class: 'steps' }, h('summary', null, title), h('ol', null, items.map((t) => h('li', null, t))));
  return h('div', { class: 'stack-tight' },
    h('h3', null, 'How to forward mail to it'),
    steps('Gmail', [
      'In Gmail, open Settings, See all settings, then Forwarding and POP/IMAP.',
      'Choose Add a forwarding address and enter ' + a + '.',
      'Gmail sends a confirmation code to that address. It shows at the top of the Inbox screen here: open its link, or type the code in Gmail.',
      'To forward only requirement emails, create a filter (Settings, Filters and blocked addresses, Create a new filter), for example with the words "requirement OR C2C", and pick Forward it to ' + a + '.'
    ]),
    steps('Outlook', [
      'In Outlook, open Settings, Mail, then Rules, and add a new rule.',
      'Pick a condition, for example Subject includes "requirement".',
      'Pick the action Forward to, enter ' + a + ', and save.',
      'Some company accounts block forwarding outside the company. If the rule does not work, ask your IT admin.'
    ]),
    steps('Google Groups (C2C groups)', [
      'If you own or manage the group: open the group, Members, Add members, and add ' + a + '.',
      'If you are only a member: in Gmail, make a filter for mail from the group\'s address and forward it to ' + a + ' (see Gmail above).',
      'BenchPilot never posts or replies to the group.'
    ]),
    h('p', { class: 'hint' }, 'BenchPilot never sends email from this address: no replies and no read receipts. Emails are kept for 90 days (ignored ones for 30).'));
}

async function inboxCard(ctx, role) {
  let info, addresses;
  try { [info, addresses] = await Promise.all([ctx.store.getInboxInfo(), ctx.store.listInboxAddresses()]); } catch (err) { return card('Inbox', note('danger', err.message)); }
  if (!info.domain) return card('Inbox', h('p', { class: 'muted' }, 'The inbox address is not set up yet.'));
  if (info.unavailable) return card('Inbox', note('danger', inboxLimitText(info)));   // `me` could not read the numbers: an error, not a plan limit
  const owner = role === 'owner';
  const canManage = ctx.can('inbox_addresses');          // create / replace: refused while read-only
  const canTurnOff = ctx.can('disable_inbox_address');   // turning one off stays open on a read-only workspace
  const msg = h('div', { 'aria-live': 'polite' });
  const full = info.used >= info.limit;
  // After a downgrade: the server stores mail only for the first `limit` active addresses (oldest first); the rest are paused.
  const paused = pausedInboxAddresses(addresses, info.limit);
  const run = async (btn, fn, done) => {
    clear(msg); btn.disabled = true;
    try { await fn(); toast(done); ctx.refresh(); } catch (err) { msg.append(note('danger', err.message)); btn.disabled = false; }
  };

  const rows = addresses.length ? table([
    {
      label: 'Address', cell: (a) => h('div', null,
        h('span', { class: 'code-text' }, inboxAddress(a.token, info.domain)), h('br'),
        h('span', { class: 'muted' }, a.label || 'No label'), a.active ? null : [' ', chip('Turned off', 'neutral')],
        paused.has(a.id) ? [' ', chip('Paused: over your plan\'s limit', 'warn')] : null)
    },
    { label: 'Created', cell: (a) => fmtLong(a.createdOn) + (a.disabledOn ? ', turned off ' + fmtLong(a.disabledOn) : '') },
    { label: 'Last email', cell: (a) => (a.lastMessageOn ? fmtLong(a.lastMessageOn) : 'None yet') },
    {
      label: 'Emails', cell: (a) => h('span', null, String(a.messageCount),
        a.droppedCount ? h('span', { class: 'hint' }, ' (' + a.droppedCount + ' not stored: read-only workspace, plan limit or daily cap)') : null)
    },
    {
      label: '', class: 'right', cell: (a) => a.active ? h('div', { class: 'row-end' },
        button('Copy', { variant: 'secondary', 'aria-label': 'Copy ' + inboxAddress(a.token, info.domain), onclick: () => copyText(inboxAddress(a.token, info.domain)) }),
        canManage ? button('Replace', {
          variant: 'ghost', 'aria-label': 'Replace ' + (a.label || 'this address'),
          onclick: (e) => {
            if (!confirm('Replace this address? The old one stops taking email at once, so update your forwarding rules to the new address.')) return;
            // One server call (0040): if the new address cannot be made, the old one stays on.
            return run(e.currentTarget, () => ctx.store.replaceInboxAddress(a.id), 'Address replaced. Update your forwarding to the new one.');
          }
        }) : null,
        canTurnOff ? button('Turn off', {
          variant: 'ghost', 'aria-label': 'Turn off ' + (a.label || 'this address'),
          onclick: (e) => {
            if (!confirm('Turn this address off? Email sent to it is no longer stored. It cannot be turned back on.')) return;
            return run(e.currentTarget, () => ctx.store.disableInboxAddress(a.id), 'Address turned off.');
          }
        }) : null) : null
    }
  ], addresses, { caption: 'Inbox addresses' }) : h('p', { class: 'muted' }, owner ? 'No address yet.' : 'No address yet. Ask the owner to create one.');

  let create = null;
  if (owner) {
    const label = input({ maxlength: 60, placeholder: 'Vendor mail' });
    const btn = h('button', { type: 'submit', class: 'btn btn-primary', disabled: !canManage || full }, 'Create an address');
    create = h('form', { class: 'form', novalidate: true }, field('Label', label, { hint: 'For you only, for example "Vendor mail" or "C2C groups".' }), h('div', { class: 'row-end' }, btn));
    create.addEventListener('submit', (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      run(btn, () => ctx.store.createInboxAddress(label.value), 'Address created.');
    });
  }
  const first = addresses.find((a) => a.active);
  return card('Inbox', h('div', { class: 'stack', id: 'inbox-settings' },
    h('p', { class: 'muted' }, 'Forward requirement emails and C2C group mail to the team\'s address. Every email lands in the Inbox screen for everyone on the team.'),
    h('p', null, chip(inboxLimitText(info), full ? 'warn' : 'neutral')),
    rows, msg,
    owner ? (full && info.limit ? h('p', { class: 'hint' }, 'Turn an address off to free its place.') : null) : h('p', { class: 'hint' }, 'Only the owner creates, turns off or replaces addresses.'),
    paused.size ? note('warn', 'Your plan takes email on ' + info.limit + ' of these addresses (the oldest). Email sent to a paused address is not stored. '
      + (owner ? 'Turn off the ones you do not need, or move to a larger plan.' : 'Ask the owner.')) : null,
    owner && ctx.readOnly ? h('p', { class: 'hint' }, 'The workspace is read-only, so no address can be created or replaced. You can still turn one off.') : null,
    create,
    inboxSteps(first ? inboxAddress(first.token, info.domain) : '')));
}

/** The plan in one line, with the way to the billing page (where the owner pays). */
function planSummaryCard(ctx) {
  const b = ctx.team.billing || {};
  const [text, kind] = planChip(b);
  return card('Plan and billing', h('div', { class: 'stack-tight' },
    h('p', null, h('span', { class: 'strong' }, TIER_NAMES[b.tier] || b.tier || ''), ' ', text ? chip(text, kind) : null),
    b.state ? h('p', { class: 'muted' }, planStatusText(b)) : null,
    h('div', { class: 'row-end' }, h('a', { class: 'btn ' + (ctx.session.role === 'owner' ? 'btn-money' : 'btn-secondary'), href: '#billing' },
      ctx.session.role === 'owner' ? 'Open plan and billing' : 'See the plan'))));
}

export async function render(ctx) {
  const team = ctx.team;
  const role = ctx.session.role;
  const members = await ctx.store.listMembers();
  const invites = await ctx.store.listInvites();
  const canInvite = ctx.can('invite');

  const membersCard = card('Members', table([
    { label: 'Name', cell: (m) => h('span', null, h('span', { class: 'strong' }, m.name), m.id === ctx.session.user.id ? [' ', chip('You', 'neutral')] : null) },
    { label: 'Email', cell: (m) => m.email },
    {
      label: 'Role', cell: (m) => {
        if (!ctx.can('change_roles') || !canChangeMember(role, m.role, m.id === ctx.session.user.id)) return chip(ROLE_LABELS[m.role], m.role === 'owner' ? 'accent' : 'neutral');
        return select({ manager: 'Manager', recruiter: 'Recruiter' }, m.role, {
          'aria-label': 'Role for ' + m.name,
          onchange: async (e) => { try { await ctx.store.setMemberRole(m.id, e.target.value); toast('Role changed.'); } catch (err) { toast(err.message); } ctx.refresh(); }
        });
      }
    },
    {
      label: '', class: 'right', cell: (m) => (ctx.can('remove_member') && canChangeMember(role, m.role, m.id === ctx.session.user.id))
        ? button('Remove', {
          variant: 'ghost', 'aria-label': 'Remove ' + m.name,
          onclick: async () => {
            if (!confirm(`Remove ${m.name}? They lose access now. What they added stays with the team.`)) return;
            try { await ctx.store.removeMember(m.id); toast('Member removed.'); } catch (err) { toast(err.message); }
            ctx.refresh();
          }
        }) : ''
    }
  ], members, { caption: 'Team members' }));

  // Leave (0040): managers and recruiters leave themselves; the owner transfers ownership or deletes the workspace first.
  let leaveCard = null;
  if (canLeave(role)) {
    leaveCard = card('Leave this workspace', h('div', null,
      h('p', { class: 'muted' }, 'You lose access to ' + team.name + ' at once. What you added stays with the team. To come back, someone has to invite you again.'),
      h('div', { class: 'row-end' }, button('Leave this workspace', {
        variant: 'secondary',
        onclick: async (e) => {
          if (!confirm('Leave ' + team.name + ' now? You lose access at once.')) return;
          const btn = e.currentTarget; btn.disabled = true;
          try {
            await ctx.store.leaveTeam();
            toast('You left ' + team.name + '.');
            history.replaceState(null, '', location.pathname + location.search + '#today');
            ctx.refresh();
          } catch (err) { toast(err.message); btn.disabled = false; }
        }
      }))));
  }

  // invites: owners and managers see the pending ones and can cancel them (also on a read-only workspace); resend and new invites
  // need a writable workspace (0040). Seats count members + pending invites.
  const lead = role === 'owner' || role === 'manager';
  const seats = lead ? await ctx.store.seatInfo() : null;
  const inviteRows = (lead && invites.length) ? table([
    { label: 'Email', cell: (i) => i.email }, { label: 'Role', cell: (i) => ROLE_LABELS[i.role] },
    { label: 'Expires', cell: (i) => (i.expired ? h('span', null, chip('Expired', 'warn'), ' ', fmtLong(i.expiresOn)) : fmtLong(i.expiresOn)) },
    {
      label: '', class: 'right', cell: (i) => {
        const wait = resendWaitMinutes(i.sentAt, Date.now());
        return h('div', { class: 'row-end' },
          canInvite ? button('Resend', {
            variant: 'ghost', 'aria-label': 'Resend the invite to ' + i.email, disabled: wait > 0,
            title: wait > 0 ? 'Sent just now. You can send it again in ' + plural(wait, 'minute') + '.' : null,
            onclick: async (e) => {
              const btn = e.currentTarget; btn.disabled = true;
              try { await ctx.store.resendInvite(i.id); toast(ctx.live ? 'Invite sent again with a new link. The old link no longer works.' : 'Demo: the invite now expires in 7 days.'); }
              catch (err) { toast(err.message); }
              ctx.refresh();
            }
          }) : null,
          button('Cancel invite', {
            variant: 'ghost', 'aria-label': 'Cancel the invite to ' + i.email,
            onclick: async (e) => {
              if (!confirm('Cancel the invite to ' + i.email + '? Their link stops working.')) return;
              const btn = e.currentTarget; btn.disabled = true;
              try { await ctx.store.revokeInvite(i.id); toast('Invite cancelled.'); } catch (err) { toast(err.message); }
              ctx.refresh();
            }
          }));
      }
    }
  ], invites, { caption: 'Pending invites' }) : null;
  const seatLine = seats ? h('p', null, h('span', { class: 'chip chip-long chip-' + (seats.limit != null && seats.used >= seats.limit ? 'warn' : 'neutral') }, seatText(seats))) : null;   // a sentence: it wraps on a phone

  let inviteBody;
  if (canInvite) {
    const email = input({ type: 'email', autocomplete: 'off', placeholder: 'name@company.com' });
    const roleSel = select({ recruiter: 'Recruiter', manager: 'Manager' }, 'recruiter');
    const msg = h('div', { 'aria-live': 'polite' });
    const form = h('form', { class: 'form inline-form', novalidate: true },
      h('div', { class: 'grid' }, field('Email', email), field('Role', roleSel)), msg,
      h('div', { class: 'row-end' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send invite')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(msg);
      try { await ctx.store.inviteMember({ email: email.value, role: roleSel.value }); toast(ctx.live ? 'Invite sent. The link works once and expires in 7 days.' : 'Invite saved. In the live version the person gets an email.'); ctx.refresh(); }
      catch (err) { msg.append(note('danger', err.message)); email.focus(); }
    });
    inviteBody = h('div', null, inviteRows || empty('No pending invites.'), seatLine, inviteDomainHint(team), form);
  } else {
    inviteBody = h('div', null, inviteRows, h('p', { class: 'muted' }, ctx.readOnly
      ? 'The workspace is read-only, so no one can be invited until the plan is paid.'
      : 'Only owners and managers can invite people. Ask your owner or manager.'));
  }

  const left = [membersCard, card('Invites', inviteBody), desksCard(ctx), await inboxCard(ctx, role), leaveCard].filter(Boolean);

  const right = [];
  // Email templates and the company signature (backlog W7): their own screen, #templates.
  right.push(card('Email templates', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, ctx.can('edit_templates')
      ? 'Pitch, follow-up, hotlist intro and check-in emails for the whole team, with the company signature.'
      : 'The team\'s pitch, follow-up, hotlist intro and check-in emails. Set your own name, title and phone for the signature.'),
    h('div', { class: 'row-end' }, h('a', { class: 'btn btn-secondary', href: '#templates' }, 'Open email templates')))));
  if (role === 'owner') {
    const nameIn = input({ value: team.name, maxlength: 80 });
    const expMgr = h('input', { type: 'checkbox', id: 'exp-mgr', checked: team.settings.exportPolicy.manager });
    const expRec = h('input', { type: 'checkbox', id: 'exp-rec', checked: team.settings.exportPolicy.recruiter });
    const timeIn = input({ type: 'time', value: team.settings.reportTime || '08:00' });
    const zoneIn = zoneControl(team.settings.timeZone || browserZone());
    const repMgr = h('input', { type: 'checkbox', id: 'rep-mgr', checked: team.settings.reportManagers === true });
    const payRec = h('input', { type: 'checkbox', id: 'pay-rec', checked: Boolean(team.settings.payPolicy && team.settings.payPolicy.recruiter === true) });
    // Staffing P4 (0052): recruiters see everyone's numbers on the leaderboard (default on); off, each recruiter sees only their own.
    const lbOthers = h('input', { type: 'checkbox', id: 'lb-others', checked: !(team.settings.leaderboardPolicy && team.settings.leaderboardPolicy.others === false) });
    const weekly = hasFeature(team.billing, 'weeklyReport');
    const dayIn = select(WEEKDAYS, String(weekdayOf(team.settings.reportWeekday)), { disabled: !weekly });
    const msg = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'btn btn-primary', disabled: !ctx.can('team_settings') }, 'Save settings');
    const form = h('form', { class: 'form', novalidate: true },
      field('Workspace name', nameIn),
      h('fieldset', { class: 'fieldset' }, h('legend', null, 'Who can export the whole book'),
        h('p', { class: 'hint' }, 'The owner always can.'),
        h('div', { class: 'field check' }, expMgr, h('label', { for: 'exp-mgr' }, 'Managers')),
        h('div', { class: 'field check' }, expRec, h('label', { for: 'exp-rec' }, 'Recruiters'))),
      h('fieldset', { class: 'fieldset' }, h('legend', null, 'Pay rates and margin'),
        h('p', { class: 'hint' }, 'Owners and managers always see them.'),
        h('div', { class: 'field check' }, payRec, h('label', { for: 'pay-rec' }, 'Recruiters can see and enter pay rates'))),
      h('fieldset', { class: 'fieldset' }, h('legend', null, 'Leaderboard'),
        h('p', { class: 'hint' }, 'Owners and managers always see everyone. Off: each recruiter sees only their own numbers.'),
        h('div', { class: 'field check' }, lbOthers, h('label', { for: 'lb-others' }, "Recruiters can see everyone's numbers"))),
      h('div', { class: 'grid' },
        field('Morning report time', timeIn, { hint: 'Sent to the owner each day.' }),
        field('Time zone', zoneIn, { hint: team.settings.timeZone ? 'Saved for this workspace.' : 'Your browser\'s time zone. Save to keep it.' })),
      h('div', { class: 'field check' }, repMgr, h('label', { for: 'rep-mgr' }, 'Also send the morning report to managers')),
      field('Weekly summary day', dayIn, { hint: weekly
        ? 'That morning\'s report also has the last 7 days' + (hasFeature(team.billing, 'deskReport') ? ', with a line per desk (per recruiter until you add desks).' : '.')
        : `The weekly summary comes with ${FEATURE_FROM.weeklyReport} and ${FEATURE_FROM.desks}.` }),
      msg,
      h('div', { class: 'row-end' }, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(msg);
      if (!nameIn.value.trim()) { msg.append(note('danger', 'Enter a workspace name.')); nameIn.focus(); return; }
      save.disabled = true;
      try {
        await ctx.store.updateTeam({ name: nameIn.value.trim(), settings: { reportTime: timeIn.value, timeZone: zoneIn.value.trim(), reportManagers: repMgr.checked, reportWeekday: Number(dayIn.value), exportPolicy: { manager: expMgr.checked, recruiter: expRec.checked }, payPolicy: { recruiter: payRec.checked }, leaderboardPolicy: { others: lbOthers.checked } } });
        toast('Settings saved.'); ctx.refresh();
      } catch (err) { msg.append(note('danger', err.message)); save.disabled = false; }
    });
    right.push(card('Workspace settings', form));
  } else {
    right.push(card('Workspace settings', lockNote(ctx, { badge: 'Owner only', text: 'Only the owner changes workspace settings.' })));
  }
  // 0056: "Restrict sign-ups to my company domain" (owner) and the single sign-on there is
  right.push(signupDomainCard(ctx, team));

  right.push(planSummaryCard(ctx));
  if (ctx.live) right.push(referralCard(ctx));
  if (ctx.can('audit_log')) {
    right.push(card('Activity log', h('div', null, h('p', { class: 'muted' }, 'See who added, changed or deleted what, filter by person, type and date, and export the list.'),
      h('div', { class: 'row-end' }, h('a', { href: '#audit', class: 'btn btn-secondary' }, 'Open the activity log')))));
  }

  const exportBtn = button('Export everything', {
    variant: 'secondary', disabled: !ctx.can('export'),
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const data = await ctx.store.exportAll();
        download('benchpilot-export-' + data.exportedOn + '.zip', new Blob([exportZip(data)], { type: 'application/zip' }));
        toast(ctx.live ? 'Export downloaded.' : 'Export downloaded (sample data).');
      } catch (err) { toast(err.message); }
      btn.disabled = false;
    }
  });
  right.push(card('Export', h('div', null,
    ctx.can('export')
      ? h('p', { class: 'muted' }, 'Download the bench, vendor book, contacts, requirements and submissions as CSV files in one .zip. Each file opens in Excel.')
      : lockNote(ctx, { badge: 'Not your role', text: 'Your role cannot export the whole book. Ask the owner.' }),
    h('div', { class: 'row-end' }, exportBtn))));

  if (role === 'owner' && ctx.live) {
    const others = members.filter((m) => m.id !== ctx.session.user.id);
    const target = select(Object.fromEntries(others.map((m) => [m.id, m.name + ' (' + m.email + ')'])), others.length ? others[0].id : '', { 'aria-label': 'New owner', disabled: !others.length });
    const go = button('Transfer ownership', {
      variant: 'secondary', disabled: !others.length,
      onclick: async () => {
        const who = others.find((m) => m.id === target.value);
        if (!who || !confirm(`Make ${who.name} the owner? You become a manager and can no longer change owner-only settings.`)) return;
        try { await ctx.store.transferOwner(who.id); toast('Ownership transferred.'); } catch (err) { toast(err.message); }
        ctx.refresh();
      }
    });
    right.push(card('Transfer ownership', h('div', null,
      h('p', { class: 'muted' }, others.length ? 'Hand the workspace to someone on the team. There is always exactly one owner.' : 'Invite someone first. Ownership can only be handed to a member.'),
      field('New owner', target), h('div', { class: 'row-end' }, go))));
  }
  if (role === 'owner') {
    const want = team.name.trim().toLowerCase();
    const confirmIn = input({ autocomplete: 'off', placeholder: team.name });
    const delBtn = h('button', { type: 'submit', class: 'btn btn-danger', disabled: true }, 'Delete workspace');
    const msg = h('div', { 'aria-live': 'polite' });
    confirmIn.addEventListener('input', () => { delBtn.disabled = confirmIn.value.trim().toLowerCase() !== want; });
    const form = h('form', { class: 'form', novalidate: true },
      h('p', { class: 'muted' }, ctx.live
        ? 'Everyone, you included, loses access to this workspace at once. Export everything first if you want a copy. To undo it, contact support soon after. ' + purgeText(team.purgeEnabled)
        : 'This removes the workspace for everyone. In this demo it only resets the sample data.'),
      field('Type the workspace name to confirm', confirmIn), msg, h('div', { class: 'row-end' }, delBtn));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(msg);
      if (confirmIn.value.trim().toLowerCase() !== want) return;
      if (ctx.live && !confirm('Delete ' + team.name + ' for everyone now?')) return;
      delBtn.disabled = true;
      try {
        await ctx.store.deleteWorkspace(confirmIn.value);
        toast(ctx.live ? 'Workspace deleted.' : 'Demo only: sample data reset.');
        if (ctx.live) history.replaceState(null, '', location.pathname + location.search + '#today');
        ctx.refresh();
      } catch (err) { msg.append(note('danger', err.message)); delBtn.disabled = false; }
    });
    right.push(card('Delete workspace', form, { class: 'card-danger' }));
  }

  return h('div', { class: 'stack' },
    pageHeader('Team', ctx.live ? team.name + ' - your role: ' + ROLE_LABELS[role] : team.name + ' - you are viewing as ' + ROLE_LABELS[role]),
    h('div', { class: 'cols cols-wide-left' }, h('div', { class: 'stack' }, left), h('div', { class: 'stack' }, right)));
}
