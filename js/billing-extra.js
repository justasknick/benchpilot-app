// webapp/js/billing-extra.js - the parts of Team > Plan and billing that are not the plan table: the no-auto-renew line, how changing
// plan works, the payment history (`billing-history`), the "Share a pilot link" card (`referral-link`), and the billing watch that
// refreshes the page after a payment made in another tab. The text helpers and the watch are pure; the cards build DOM.

import { h, clear } from './dom.js';
import { card, table, chip, note, emptyState, button, toast } from './ui.js';
import { fmtLong } from './dates.js';

// ── text ─────────────────────────────────────────────────────────────────
/** Paid plans never renew by themselves: say when the paid time ends. '' for a pilot or a workspace that is not paid now. */
export function noAutoRenewText(b) {
  if (!b || b.state !== 'active' || !b.paidUntil) return '';
  return 'No auto-renew: your paid time ends on ' + fmtLong(b.paidUntil) + '.';
}
/** The rule is applied by the server when a payment for another plan arrives. */
/** Every payment is one-off: nothing is charged again unless the owner pays again (the no-auto-renew rule, for the billing page). */
export const NO_AUTO_RENEW_RULE = 'No auto-renew: a payment covers its month or year, and nothing is charged again unless the owner pays again.';
/** Where the paperwork comes from. */
export const INVOICE_TEXT = 'Invoices and receipts come by email from Razorpay after each payment.';
export const PLAN_CHANGE_TEXT = 'How changing plan works: the paid days you have left are converted by price to the new plan, '
  + 'so a bigger plan gives fewer days and a smaller plan more. Nothing is lost.';

/**
 * When a closed workspace's data goes (0034 bp_team_purge_state): 30 days after closing, but never while paid time is left, and only
 * when the purge of closed workspaces is switched on (`me` purge_enabled, the TEAM_PURGE secret); only then is the week-before email sent.
 */
export function purgeText(purgeEnabled) {
  return purgeEnabled === true
    ? 'The data is deleted for good 30 days after closing, or after any paid time ends if that is later. We email the owner a week before.'
    : 'The data is kept for at least 30 days after closing (longer if paid time is left), then deleted for good.';
}

/** Paise or cents -> the rupee text (Indian digit grouping) or "US$" with cents when there are any. Never a price list: amounts paid only. */
export function moneyText(amount, currency) {
  const n = Number(amount) || 0;
  const whole = n % 100 === 0;
  const v = (n / 100).toLocaleString(currency === 'USD' ? 'en-US' : 'en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return (currency === 'USD' ? 'US$' : '₹') + v;
}
export const PAYMENT_STATUS = { paid: ['Paid', 'ok'], refunded: ['Refunded', 'neutral'], failed: ['Not completed', 'warn'] };
/** The server's plan id (plans.js TEAM_PLANS: "team_team_yearly"; "team_team_year" from older rows) -> "Team · 15, yearly". */
const PLAN_SIZE_NAMES = { starter: 'Team · 5', team: 'Team · 15', agency: 'Team · 40' };   // the one ladder's names (screens/billing.js TIER_NAMES)
export function planName(id) {
  const m = /^team_(starter|team|agency)(_year(?:ly)?)?$/.exec(String(id || ''));
  if (!m) return String(id || '') || '-';
  return PLAN_SIZE_NAMES[m[1]] + (m[2] ? ', yearly' : ', monthly');
}

// ── the billing watch ────────────────────────────────────────────────────
export const CHECKOUT_POLL_MS = 15000;      // every 15 seconds ...
export const CHECKOUT_POLL_FOR_MS = 120000; // ... for 2 minutes after a checkout starts
export const FOCUS_GAP_MS = 20000;          // a focus / visible tab checks at most this often

/** What decides whether the page must be drawn again. */
export function billingKey(b) {
  const x = b || {};
  return [x.tier, x.state, x.writable !== false, x.paidUntil || ''].join('|');
}

/**
 * Re-reads the team's billing when the tab comes back (focus, visibilitychange) and every CHECKOUT_POLL_MS for CHECKOUT_POLL_FOR_MS
 * after a checkout starts. Calls onChange(billing) when it differs from the one last drawn (set()). Errors are ignored: the next
 * check tries again.
 * @param {{load:()=>Promise<object>, onChange:(b:object)=>void, now?:()=>number, every?:Function, stopEvery?:Function}} o
 */
export function createBillingWatch(o) {
  const now = o.now || (() => Date.now());
  const every = o.every || ((fn, ms) => setInterval(fn, ms));
  const stopEvery = o.stopEvery || ((t) => clearInterval(t));
  let key = null, last = -Infinity, busy = false, timer = null, until = 0;
  const w = {
    /** The billing the page was drawn with (null = no team page now: checks do nothing). */
    set(b) { key = b ? billingKey(b) : null; },
    async check(force) {
      if (key === null || busy || (!force && now() - last < FOCUS_GAP_MS)) return false;
      busy = true; last = now();
      try {
        const b = await o.load();
        const k = billingKey(b);
        if (key !== null && k !== key) { key = k; o.onChange(b); return true; }
        return false;
      } catch (e) { return false; } finally { busy = false; }
    },
    startCheckoutPoll() {
      until = now() + CHECKOUT_POLL_FOR_MS;
      if (timer) return;
      timer = every(async () => {
        if (now() > until) { w.stop(); return; }
        await w.check(true);
      }, CHECKOUT_POLL_MS);
    },
    stop() { if (timer) { stopEvery(timer); timer = null; } },
    polling() { return Boolean(timer); }
  };
  return w;
}

// ── cards ────────────────────────────────────────────────────────────────
/** The owner's payment history (part 3 of the billing page). */
export async function billingHistoryBlock(ctx) {
  const box = h('div', { class: 'stack-tight' });
  let rows;
  try { rows = await ctx.store.getBillingHistory(); } catch (err) { box.append(note('danger', 'The payments could not be loaded: ' + err.message)); return box; }
  if (!rows.length) {
    box.append(emptyState({ icon: 'billing', title: 'No payments yet', text: ctx.live ? 'Payments for this workspace show here, with their status.' : 'The demo never takes a payment.' }));
    return box;
  }
  box.append(table([
    { label: 'Date', cell: (p) => fmtLong(p.date) || '-' },
    { label: 'Plan', cell: (p) => planName(p.plan) },
    { label: 'Amount', class: 'num', cell: (p) => moneyText(p.amount, p.currency) },
    { label: 'Status', cell: (p) => chip(...(PAYMENT_STATUS[p.status] || PAYMENT_STATUS.failed)) }
  ], rows, { caption: 'Payments for this workspace, newest first' }));
  return box;
}

/** "Share a pilot link" (0021 Bring BenchPilot to your team): the same link the extension offers, for colleagues at other firms. */
export function referralCard(ctx) {
  const body = h('div', { class: 'stack-tight' });
  const intro = h('p', { class: 'muted' }, 'Know a bench sales team at another firm? Send them a link to a free 14-day pilot. '
    + 'When their team makes its first payment, you get 90 days of Solo free.');
  const out = h('div', { 'aria-live': 'polite' });
  const show = (r) => {
    clear(out);
    const linkIn = h('input', { type: 'text', readOnly: true, value: r.link, 'aria-label': 'Your pilot link', class: 'mono' });
    out.append(
      h('div', { class: 'row-end' }, linkIn,
        button('Copy link', { variant: 'secondary', onclick: async () => {
          try { await navigator.clipboard.writeText(r.link); toast('Link copied.'); } catch (e) { linkIn.select(); toast('Copy did not work. Select the link and copy it by hand.'); }
        } })),
      h('p', { class: 'hint' }, (r.expiresOn ? 'Works until ' + fmtLong(r.expiresOn) + '. ' : '') + r.joined + ' joined, ' + r.rewarded + ' rewarded.'),
      h('div', { class: 'row-end' }, button('Make a new link', { variant: 'ghost', onclick: (e) => load(e.currentTarget, true) })));
  };
  async function load(btn, fresh) {
    if (btn) btn.disabled = true;
    try { show(await ctx.store.getReferralLink({ new: fresh === true })); } catch (err) { clear(out); out.append(note(err.code === 'demo_only' ? 'info' : 'danger', err.message)); }
    if (btn) btn.disabled = false;
  }
  out.append(h('div', { class: 'row-end' }, button('Get my pilot link', { variant: 'secondary', onclick: (e) => load(e.currentTarget, false) })));
  body.append(intro, out);
  return card('Share a pilot link', body);
}
