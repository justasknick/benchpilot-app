// Plan and billing (#billing, under Team; 0016, 0033, 0040, 0041): one page in four parts (design brief D):
//   1. Current plan and status   2. Choose or change plan (cards: seats, price before GST)   3. Payment history   4. Invoices and receipts
// Prices come from the server (`billing` action -> plans.js); this file never holds a price. Everyone on the team sees the page; only the
// owner pays (the pay buttons are locked for the others, not hidden).

import { h, clear } from '../dom.js';
import { pageHeader, chip, note, button, toast, plural, lockNote, lockBadge } from '../ui.js';
import { icon } from '../icons.js';
import { fmtLong } from '../dates.js';
import { planHighlights } from '../plan-gate.js';
import { SYNC_TIERS, PERSONAL_TIER_LABELS, planLine, renewNote, RENEW_WHERE } from '../personal-plan.js';
import { todayISO } from '../dates.js';
import { noAutoRenewText, PLAN_CHANGE_TEXT, billingHistoryBlock, NO_AUTO_RENEW_RULE, INVOICE_TEXT } from '../billing-extra.js';

/**
 * One Team plan in three sizes (owner, 14 Nov 2026). Labels only: the server keys stay starter / team / agency, and the seat numbers on
 * the cards come from the server (plans.js); these names repeat them for the sidebar and the summary card.
 */
export const TIER_NAMES = { pilot: 'Team pilot', starter: 'Team · 5 people', team: 'Team · 15 people', agency: 'Team · 40 people' };
/** A plan card's title: "Team · N people" from the server's seat count. */
export function sizeLabel(p) { return 'Team · ' + plural(p.seats, 'person', 'people'); }

/**
 * The per-person equivalent of a plan price ("≈ <price> per person a month"), worked out from the server's own price text and seat
 * count (a yearly price is spread over 12 months). '' when the text has no number or there are no seats.
 */
export function perPersonText(inrText, seats, period) {
  const n = Number(String(inrText || '').replace(/[^0-9.]/g, ''));
  if (!n || !seats) return '';
  const each = Math.round(n / (period === 'year' ? 12 : 1) / seats);
  return '≈ ' + String(inrText).replace(/[0-9][0-9,.]*/, each.toLocaleString('en-IN')) + ' per person a month';
}
/** The free pilot's length in days (the product's 14-day pilot): the scale of the days-left bar. */
export const PILOT_DAYS = 14;

/**
 * One line about where the plan stands, for everyone on the team. A workspace made without a free pilot (0043 noPilot: the owner had
 * theirs) never had a plan, so it never says "the plan ended". The read-only deadline is the last day it can be paid (0016: read-only
 * while today <= paid-until + 30), so it reads "by <date>".
 */
export function planStatusText(b) {
  const until = b.paidUntil ? fmtLong(b.paidUntil) : '';
  const left = b.daysLeft == null ? '' : plural(b.daysLeft, 'day');
  const by = b.readOnlyUntil ? fmtLong(b.readOnlyUntil) : '';
  if (b.state === 'pilot') return 'Free pilot: ' + left + ' left (the last day is ' + until + ').';
  if (b.state === 'active') return 'Paid until ' + until + ' (' + left + ' left).';
  if (b.noPilot && (b.state === 'read_only' || b.state === 'closing')) {
    return 'This workspace has no free pilot (yours was used with an earlier workspace), so it is read-only until a plan is paid.'
      + (by ? ' Pay by ' + by + ' or it will be closed.' : '');
  }
  if (b.state === 'read_only') return 'The plan ended on ' + until + '. The workspace is read-only. Pay by ' + by + ' or it will be closed.';
  return 'The plan ended on ' + until + ' and the workspace is about to be closed.';
}

/** The short status for the sidebar and the plan card chip: [text, chip kind]. */
export function planChip(b) {
  if (!b) return ['', 'neutral'];
  if (b.state === 'read_only' || b.state === 'closing') return ['Read-only', 'warn'];
  if (b.state === 'pilot') return [b.daysLeft === 0 ? 'Ends today' : plural(b.daysLeft, 'day') + ' left', b.payNow ? 'warn' : 'accent'];
  if (b.state === 'active') return [b.daysLeft === 0 ? 'Ends today' : plural(b.daysLeft, 'day') + ' left', b.payNow ? 'warn' : 'ok'];
  return [TIER_NAMES[b.tier] || String(b.tier || ''), 'neutral'];
}

/**
 * The plan chip on the purple header band (the same component as the extension's drawer chip, "FREE · 2/3"): the plan and the one
 * thing that matters about it. { text, warn } or null when there is no billing yet. warn = yellow (pay now / read-only).
 */
export function headerPlanChip(b) {
  if (!b || !b.state) return null;
  const warn = Boolean(b.payNow) || b.state === 'read_only' || b.state === 'closing';
  if (b.state === 'read_only' || b.state === 'closing') return { text: 'Read-only · Choose a plan', warn };
  if (b.state === 'pilot') return { text: 'Pilot · ' + (b.daysLeft === 0 ? 'ends today' : plural(b.daysLeft, 'day') + ' left'), warn };
  const size = { starter: 'Team · 5', team: 'Team · 15', agency: 'Team · 40' }[b.tier];
  return { text: size || TIER_NAMES[b.tier] || 'Team', warn };
}

/** Share of the pilot used, 0..100, for the thin progress bar; null when it is not a running pilot. */
export function pilotUsedPercent(b) {
  if (!b || b.state !== 'pilot' || b.daysLeft == null) return null;
  const left = Math.max(0, Math.min(PILOT_DAYS, b.daysLeft));
  return Math.round(((PILOT_DAYS - left) / PILOT_DAYS) * 100);
}

/** Which billing periods to offer: yearly only when the server says so (`annual`) and lists a yearly plan. */
export function billingPeriods(info) {
  const plans = (info && info.plans) || [];
  return info && info.annual === true && plans.some((p) => p.period === 'year') ? ['month', 'year'] : ['month'];
}
/** The plans of one period (a plan without a period is monthly). */
export function plansFor(info, period) {
  return ((info && info.plans) || []).filter((p) => (p.period === 'year' ? 'year' : 'month') === period);
}
/**
 * The line under the switch: what one payment buys. The server's rule (0041 bp_team_extend_plan, plans.js teamPlanUntilAfter): the months
 * start when the current plan or pilot ends, or today if it has ended; moving to another tier first converts the days left by price.
 */
export function billingTermsText(period) {
  const rule = ' from the day your current plan or pilot ends, or from today if it has ended. Changing tier converts the days left by price.';
  return period === 'year'
    ? 'Yearly, before GST: pay for 10 months, get 12. Paying adds 12 months' + rule
    : 'Monthly, before GST. Paying adds one month' + rule;
}
/** What the checkout said the paid-until date will be after this payment ('' = the server did not say). */
export function newEndDateText(planUntil) {
  return planUntil ? 'New end date after this payment: ' + fmtLong(planUntil) + '.' : '';
}
/** The founding team offer (F5), from the server only; '' = say nothing (switched off, or no places left and not a founding team). */
export function foundingText(f) {
  if (!f) return '';
  if (f.member) return 'Founding team: you keep the prices of your first payment until ' + (f.lockedUntil ? fmtLong(f.lockedUntil) : 'the end of your 12 months') + ', even if prices go up.';
  if (f.offer && f.placesLeft > 0) {
    return 'Founding offer: the first ' + f.limit + ' teams to pay keep their price for ' + f.lockMonths + ' months, even if prices go up. '
      + plural(f.placesLeft, 'place') + ' left.';
  }
  return '';
}

/** "4 of 5 seats used" (0040): members + pending invites against the plan's seats; the pilot has no limit. */
export function seatText(s) {
  if (!s || s.limit == null) return plural(s ? s.used : 0, 'person', 'people') + ', counting pending invites. The pilot has no seat limit.';
  return s.used + ' of ' + s.limit + ' seats used, counting pending invites';
}

function section(num, title, sub, body, props) {
  return h('section', { class: 'card bill-part' + (props && props.class ? ' ' + props.class : ''), 'aria-labelledby': 'bill-' + num },
    h('header', { class: 'card-head' },
      h('div', null, h('h2', { id: 'bill-' + num }, title), sub ? h('p', { class: 'card-sub' }, sub) : null)),
    body);
}

function meter(percent, label) {
  return h('div', { class: 'meter', role: 'img', 'aria-label': label }, h('span', { class: 'meter-fill', style: 'width:' + Math.max(0, Math.min(100, percent)) + '%' }));
}

/** Part 1: the current plan, its status, seats and the pilot extension request. */
function currentPart(ctx, b, seats) {
  const [chipText, chipKind] = planChip(b);
  const renew = noAutoRenewText(b);
  const used = pilotUsedPercent(b);
  const seatPct = seats && seats.limit ? Math.round((seats.used / seats.limit) * 100) : null;

  let ext = null;
  // A workspace without a pilot (0043 noPilot) may still ask once (0040 rule): for it the 14 days are a trial, not "more" days.
  if (b.tier === 'pilot' && b.extended) ext = h('p', { class: 'muted' }, 'Your pilot has had its one extension.');
  else if (b.tier === 'pilot' && b.extensionRequested) ext = h('p', { class: 'muted' }, b.noPilot ? 'You asked for a 14-day trial. We will reply by email.' : 'You asked for 14 more days. We will reply by email.');
  else if (b.tier === 'pilot' && b.canRequestExtension && ctx.session.role === 'owner') {
    ext = h('div', null, button(b.noPilot ? 'Ask for a 14-day trial' : 'Ask for 14 more days', {
      variant: 'secondary',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await ctx.store.requestPilotExtension(); toast('Request sent. We will reply by email.'); } catch (err) { toast(err.message); }
        ctx.refresh();
      }
    }));
  }

  return section(1, 'Team plan', ctx.team.name, h('div', { class: 'plan-now' },
    h('div', { class: 'plan-now-main' },
      h('p', { class: 'plan-now-name' }, TIER_NAMES[b.tier] || b.tier, ' ', chip(chipText, chipKind)),
      h('p', { class: 'muted' }, planStatusText(b)),
      used == null ? null : meter(used, plural(b.daysLeft, 'day') + ' of the ' + PILOT_DAYS + '-day pilot left'),
      renew ? h('p', { class: 'muted' }, renew) : null,
      ext),
    h('dl', { class: 'plan-facts' },
      h('div', null, h('dt', null, 'Seats'), h('dd', null, seats ? (seats.limit == null ? plural(seats.used, 'person', 'people') : seats.used + ' of ' + seats.limit) : '-'),
        seatPct == null ? null : meter(seatPct, seatText(seats))),
      h('div', null, h('dt', null, b.state === 'pilot' ? 'Pilot ends' : 'Paid until'), h('dd', null, b.paidUntil ? fmtLong(b.paidUntil) : '-')),
      h('div', null, h('dt', null, 'Renewal'), h('dd', null, 'You pay again only when you choose to')))));
}

/** Part 2: the plan cards with the period switch; pay buttons for the owner, a lock for everyone else. */
function choosePart(ctx, info, b, members) {
  const owner = ctx.session.role === 'owner';
  const msg = h('div', { 'aria-live': 'polite' });
  // The payment page opens in a new tab (opened on the click, so a pop-up blocker allows it) and this tab keeps watching the billing
  // (app.js billing watch) so it stops saying read-only as soon as the payment arrives. No new tab -> this tab goes to the payment page.
  const pay = (plan, currency) => async (e) => {
    const btn = e.currentTarget;
    clear(msg); btn.disabled = true;
    const win = typeof window.open === 'function' ? window.open('', '_blank') : null;
    try {
      const { url, planUntil } = await ctx.store.startCheckout(plan.id, currency);
      if (ctx.onCheckoutStarted) ctx.onCheckoutStarted();
      const end = newEndDateText(planUntil);
      if (!win) {
        if (end) msg.append(note('info', end + ' Opening the payment page...'));
        location.assign(url); return;
      }
      win.opener = null; win.location.href = url;
      msg.append(note('info', (end ? end + ' ' : '') + 'The payment page opened in a new tab. This page updates by itself a moment after you pay.'));
    } catch (err) { if (win) win.close(); msg.append(note('danger', err.message)); }
    btn.disabled = false;
  };

  const cardsFor = (period) => h('div', { class: 'plan-cards', role: 'list', 'aria-label': period === 'year' ? 'Team plans, yearly' : 'Team plans, monthly' },
    plansFor(info, period).map((p) => {
      // Seats as the server counts them at checkout (plans.js teamSeatsUsed): members plus pending invites.
      const tooSmall = members > p.seats;
      const current = b.tier === p.tier;
      return h('article', { class: 'plan-card' + (current ? ' is-current' : ''), role: 'listitem', 'aria-label': sizeLabel(p) },
        h('div', { class: 'plan-card-head' },
          h('h3', null, sizeLabel(p)),
          current ? chip('Current plan', 'ok') : null,
          p.locked ? chip('Founding price', 'accent') : null),
        h('p', { class: 'plan-price' }, p.inrText
          ? [h('span', { class: 'plan-amount' }, p.inrText), h('span', { class: 'plan-unit' }, period === 'year' ? ' a year' : ' a month')]
          : h('span', { class: 'plan-unit' }, 'Price shown in your own workspace')),
        h('p', { class: 'plan-sub' }, p.inrText ? ['Before GST', p.usdText ? ' · ' + p.usdText : '', h('br'), perPersonText(p.inrText, p.seats, period)] : 'Up to ' + plural(p.seats, 'person', 'people')),
        h('ul', { class: 'plan-list' }, planHighlights(p.tier).map((t) => h('li', null, icon('check', { size: 16 }), h('span', null, t)))),
        h('div', { class: 'plan-cta' },
          owner
            ? [button(p.inrText ? 'Pay ' + p.inrText : 'Pay', { variant: 'money', class: 'btn-block', disabled: !ctx.live || tooSmall, onclick: pay(p, 'INR') }),
              info.usdCheckout ? button('Pay ' + p.usdText, { variant: 'secondary', class: 'btn-block', disabled: !ctx.live || tooSmall, onclick: pay(p, 'USD') }) : null]
            : lockBadge('Owner pays'),
          tooSmall ? h('p', { class: 'hint' }, 'Your team, counting pending invites, is larger than this plan.') : null));
    }));

  // Monthly / Yearly (0033): the switch shows only when the server lists yearly plans (TEAM_ANNUAL_ENABLED); otherwise monthly only.
  const periods = billingPeriods(info);
  const cardsBox = h('div', null, cardsFor('month'));
  const terms = h('p', { class: 'muted' }, billingTermsText('month'));
  let toggle = null;
  if (periods.length > 1) {
    const choose = (period) => () => {
      clear(cardsBox); cardsBox.append(cardsFor(period));
      terms.textContent = billingTermsText(period);
      for (const btn of toggle.querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.period === period));
    };
    toggle = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Billing period' },
      ...periods.map((period) => {
        const btn = h('button', { type: 'button', class: 'seg-btn', onclick: choose(period) }, period === 'year' ? 'Yearly · pay 10 months, get 12' : 'Monthly');
        btn.dataset.period = period; btn.setAttribute('aria-pressed', String(period === 'month'));
        return btn;
      }));
  }
  const foundingLine = foundingText(info.founding);

  return section(2, owner ? 'Choose or change the team size' : 'Team sizes', owner ? 'One Team plan: a flat price for the whole team, in three sizes. Prices are before GST.' : 'Only the owner can pay. Ask them if the workspace becomes read-only.',
    h('div', { class: 'stack' },
      toggle, foundingLine ? note('info', foundingLine) : null, cardsBox, terms,
      h('p', { class: 'muted' }, PLAN_CHANGE_TEXT),
      owner ? null : lockNote(ctx, { badge: 'Owner only', text: 'Paying and changing the plan is for the owner of this workspace.' }),
      msg,
      ctx.live ? null : note('info', 'Demo: payment works in your own workspace.')));
}

/** Part 4: how invoices and receipts arrive, the no-auto-renew rule and the US-dollar invoice route. */
function invoicePart(info) {
  return section(4, 'Invoices and receipts', null, h('ul', { class: 'fact-list' },
    h('li', null, icon('file', { size: 18 }), h('span', null, INVOICE_TEXT)),
    h('li', null, icon('clock', { size: 18 }), h('span', null, NO_AUTO_RENEW_RULE)),
    h('li', null, icon('shield', { size: 18 }), h('span', null, 'Card and bank details are never stored by BenchPilot.')),
    info.usdCheckout ? null : h('li', null, icon('mail', { size: 18 }), h('span', null, 'Paying in US dollars? Pay by invoice: email us at ',
      info.invoiceEmail ? h('a', { href: 'mailto:' + info.invoiceEmail + '?subject=' + encodeURIComponent('BenchPilot team plan invoice') }, info.invoiceEmail) : 'our support address',
      ' with the plan you want and we will send one.'))));
}

/** The ladder Free -> Solo -> Team: where the person is now and what each step adds (no prices here; the cards carry them). */
export function ladderSteps(personalTier, hasTeam) {
  const solo = SYNC_TIERS.includes(personalTier);
  return [
    { key: 'free', name: 'Free', where: 'In the extension', text: 'Contacts from the posts you read, your vendor book and up to 3 consultants, on your computer.', current: !solo && personalTier != null },
    { key: 'solo', name: 'Solo', where: 'Bought in the extension', text: 'Unlimited consultants, encrypted sync across computers, My book on the web and a personal inbox.', current: solo },
    { key: 'team', name: 'Team', where: 'Paid here, by the owner', text: 'A shared bench, vendor book, requirements and submissions, with a check before anyone submits the same consultant twice.', current: Boolean(hasTeam) }
  ];
}

function ladder(personalTier, hasTeam) {
  return h('section', { class: 'plan-ladder', 'aria-label': 'Plans, from Free to Team' }, ladderSteps(personalTier, hasTeam).map((st) => h('div', { class: 'ladder-step' + (st.current ? ' is-current' : '') },
    h('p', { class: 'ladder-where' }, st.where),
    h('h3', null, st.name, st.current ? chip(st.key === 'team' ? 'Your team' : 'You', 'accent') : null),
    h('p', null, st.text))));
}

/** The person's own plan (Solo, Pro ...): status and where it is renewed (the extension's Plans page; the web app has no Solo checkout). */
function personalPart(plan, err, today) {
  let body;
  if (err || !plan) body = note('info', err || 'Your plan could not be loaded.');
  else {
    const renew = renewNote(plan, today);
    body = h('div', { class: 'stack-tight' },
      h('p', { class: 'plan-now-name' }, PERSONAL_TIER_LABELS[plan.tier] || plan.tier, ' ', chip('Personal', 'neutral')),
      h('p', { class: 'muted' }, planLine(plan, today)),
      renew ? note('warn', renew) : null,
      h('p', { class: 'hint' }, plan.tier === 'free'
        ? 'Solo is bought in the extension: open BenchPilot, then Plans.'
        : 'Solo does not renew by itself. ' + RENEW_WHERE));
  }
  return h('section', { class: 'card bill-part', 'aria-labelledby': 'bill-me' },
    h('header', { class: 'card-head' }, h('div', null, h('h2', { id: 'bill-me' }, 'Your own plan'), h('p', { class: 'card-sub' }, 'For your book in the extension and My book here.'))),
    body);
}

/** No team yet: the team step, with the way to start one. */
function teamOffer(session) {
  return h('section', { class: 'card bill-part', 'aria-labelledby': 'bill-team' },
    h('header', { class: 'card-head' }, h('div', null, h('h2', { id: 'bill-team' }, 'Team plan'),
      h('p', { class: 'card-sub' }, 'One flat price for the whole team, in three sizes: up to 5, 15 or 40 people.'))),
    h('p', { class: 'muted' }, session && session.pilotAvailable === false
      ? 'Your free pilot was used with an earlier workspace, so a new workspace opens once a plan is paid.'
      : 'Create a team workspace and invite your recruiters. The 14-day pilot is free and starts when the workspace is created.'),
    h('div', { class: 'row-end' }, h('a', { class: 'btn btn-money', href: '#welcome' }, 'Create a team')));
}

export async function render(ctx) {
  const role = ctx.session.role;
  const today = ctx.session.today || todayISO();
  let plan = null;
  let planErr = '';
  if (!ctx.live) planErr = 'Your own plan shows when you sign in. The demo has no personal plan.';
  else {
    try { plan = await ctx.loadPlan(); } catch (err) { planErr = 'Your plan could not be loaded: ' + (err && err.message ? err.message : 'please try again.'); }
  }
  const head = pageHeader('Plan and billing', 'Your own plan and your team’s plan, in one place.');
  const personal = personalPart(plan, planErr, today);
  if (!ctx.team) return h('div', { class: 'stack', id: 'billing' }, head, ladder(plan ? plan.tier : null, false), personal, teamOffer(ctx.session));

  let info;
  try { info = await ctx.store.getBilling(); } catch (err) { return h('div', { class: 'stack' }, head, note('danger', err.message)); }
  const b = info.billing;
  let seats = null;
  try { seats = await ctx.store.seatInfo(); } catch (e) { seats = null; }   // the seat line is extra: billing still shows without it
  const members = seats ? seats.used : (b.members == null ? 0 : b.members);

  const history = role === 'owner'
    ? section(3, 'Payment history', 'Newest first.', await billingHistoryBlock(ctx))
    : section(3, 'Payment history', null, lockNote(ctx, { badge: 'Owner only', text: 'The payments for this workspace are visible to the owner.' }));

  return h('div', { class: 'stack', id: 'billing' }, head,
    ladder(plan ? plan.tier : null, true),
    currentPart(ctx, b, seats),
    choosePart(ctx, info, b, members),
    history,
    invoicePart(info),
    personal);
}
