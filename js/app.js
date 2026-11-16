// webapp/js/app.js - the shell: hash router, navigation, sign-in gate, demo or live mode.
// Screens live in js/screens/*.js. They talk only to ctx.store (js/store.js).
//
// Which mode:
//   ?demo=1                      -> demo workspace (DemoStore, sample data, "Demo workspace" banner)
//   otherwise                    -> live (SupabaseStore). With no session the sign-in page offers Google, an email code
//                                   and "Try the demo workspace". A signed-in person with no team creates a workspace.
//   #accept-<token>              -> invite link: the token is moved out of the address bar (invite.js), sign in, then accept.
//   #book, #book-<section>       -> My book (Solo personal workspace, live only, team or not): js/vault.js + screens/book.js. The sync data key
//                                   lives only inside the vault (memory); it is dropped on sign-out, page hide and 30 minutes idle.
//   ?ref=<code>                  -> a colleague's pilot link (referral.js): the code is kept until the workspace is created.
//   #account                     -> Your account (live only, team or not): your own plan, "Delete my account" (screens/account.js).
//   signed in, no team           -> My book when the person's own plan includes sync (Solo, Pro; personal-plan.js noTeamHome), else
//                                   Create your workspace. #welcome always opens Create your workspace.
// Always: an offline banner with Save turned off (offline.js), "Send feedback" in the footer (feedback.js), and the team's billing is
// read again when the tab comes back and for 2 minutes after a checkout starts (billing-extra.js createBillingWatch).

import { h, clear } from './dom.js';
import { createStore, SupabaseStore } from './store.js';
import { CONFIG, wantsDemo } from './config.js';
import { createAuth } from './auth.js';
import { captureFromLocation, getPending } from './invite.js';
import { captureRef, getRef } from './referral.js';
import { parseHash } from './route.js';
import { ROLES, ROLE_LABELS, canNow } from './perms.js';
import { toast, button, plural } from './ui.js';
import { fmtLong } from './dates.js';
import { deskIndex } from './desks.js';
import * as signin from './screens/signin.js';
import * as welcome from './screens/welcome.js';
import * as accept from './screens/accept.js';
import * as today from './screens/today.js';
import * as bench from './screens/bench.js';
import * as consultant from './screens/consultant.js';
import * as requirements from './screens/requirements.js';
import * as matches from './screens/matches.js';
import * as vendors from './screens/vendors.js';
import * as submissions from './screens/submissions.js';
import * as placementsScreen from './screens/placements.js';
import * as reportsScreen from './screens/reports.js';
import * as timesheetsScreen from './screens/timesheets.js';
import * as invoicesScreen from './screens/invoices.js';
import * as commissionScreen from './screens/commission.js';
import * as team from './screens/team.js';
import * as audit from './screens/audit.js';
import * as importScreen from './screens/import.js';
import * as inbox from './screens/inbox.js';
import * as book from './screens/book.js';
import * as templatesScreen from './screens/templates.js';
import * as accountScreen from './screens/account.js';
import * as billingScreen from './screens/billing.js';
import { planChip, pilotUsedPercent, headerPlanChip, TIER_NAMES } from './screens/billing.js';
import { BENCH_STATUSES } from './stats.js';
import { icon } from './icons.js';
import { searchBox } from './search.js';
import { appShell, applyTheme, demoRoleSelect, readLastWorkspace, saveLastWorkspace, PRODUCT } from './shell.js';
import { bookGroups } from './screens/book.js';
import { createVault } from './vault.js';
import { createBookModel, BOOK_DATASETS } from './book-model.js';
import { loadSyncLib } from './bp-lib.js';
import { createPersonalInbox } from './personal-inbox.js';
import { inboxInfoUnavailable } from './live-map.js';
import { noTeamHome, SYNC_TIERS, PERSONAL_TIER_LABELS, daysLeft as personalDaysLeft } from './personal-plan.js';
import { createBillingWatch } from './billing-extra.js';
import { installOffline } from './offline.js';
import { feedbackFooter } from './feedback.js';

const demoMode = wantsDemo(location.search);
const auth = createAuth();
// landing: the page was opened without a screen in the address, so a signed-in person goes to the workspace they used last.
const state = { session: null, notice: '', focusMain: false, seq: 0, plan: null, landing: !location.hash || location.hash === '#' };
const store = demoMode
  ? createStore()
  : new SupabaseStore({ auth, config: CONFIG, onSessionLost: () => { forgetBook(); state.notice = 'Your session expired. Please sign in again.'; renderRoute(); } });

// ── My book: created on first use (loads the extension's sync code) ──
let bookKit = null;
async function getBook() {
  if (!bookKit) {
    const lib = await loadSyncLib();
    const vault = createVault({
      api: (body) => store.syncCall(body), crypto: lib.crypto, merge: lib.merge, messages: lib.messages, datasets: BOOK_DATASETS, inboxCrypto: lib.inboxCrypto,
      // Resume files (phase 2): the extension's read path, the browser's fetch, and this project's Storage prefix (signed links are checked against it).
      blobRead: lib.blobRead, http: (url, init) => fetch(url, init), storageBase: String(CONFIG.SUPABASE_URL || '').replace(/\/+$/, '') + '/storage/v1/object/',
      onLock: () => { if (parseHash(location.hash).name === 'book') renderRoute(); }
    });
    // The Solo personal inbox (docs/specs/SOLO_INBOX_SPEC.md): its private key is opened by the vault; nothing here holds the data key.
    const inbox = createPersonalInbox({ api: (body) => store.syncCall(body), inboxCrypto: lib.inboxCrypto, vault });
    bookKit = { vault, inbox, model: createBookModel(lib.BP), BP: lib.BP };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, () => vault.touch(), { passive: true, capture: true });
  }
  return bookKit;
}
/** Drops the data key and the decrypted book (sign-out, session lost, page hidden for good). */
function forgetBook() { if (bookKit) bookKit.vault.signOut(); }
window.addEventListener('pagehide', forgetBook);

document.body.dataset.mode = demoMode ? 'demo' : 'live';

// ── billing watch: a payment made in another tab (or the checkout tab) shows here without a reload ──
const billingWatch = createBillingWatch({ load: () => store.refreshBilling(), onChange: () => renderRoute() });
window.addEventListener('focus', () => billingWatch.check());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') billingWatch.check(); });

/** The signed-in person's own plan (Solo ...), once per user; null when it cannot be read (then nothing depends on it). */
async function personalPlan(userId) {
  if (!state.plan || state.plan.userId !== userId) {
    let plan = null;
    try { plan = await store.getPersonalPlan(); } catch (e) { plan = null; }
    state.plan = { userId, plan };
  }
  return state.plan.plan;
}

const NAV = [
  { name: 'today', label: 'Today', screen: today },
  { name: 'bench', label: 'Bench', screen: bench },
  { name: 'requirements', label: 'Requirements', screen: requirements },
  { name: 'matches', label: 'Matches', screen: matches },
  { name: 'inbox', label: 'Inbox', screen: inbox },
  { name: 'vendors', label: 'Vendor book', screen: vendors },
  { name: 'submissions', label: 'Submissions', screen: submissions },
  { name: 'placements', label: 'Placements', screen: placementsScreen },
  { name: 'reports', label: 'Reports', screen: reportsScreen },
  { name: 'timesheets', label: 'Timesheets', screen: timesheetsScreen },
  { name: 'invoices', label: 'Invoices', screen: invoicesScreen, need: 'invoices' },
  { name: 'commission', label: 'Commission', screen: commissionScreen, need: 'commission' },
  { name: 'import', label: 'Import', screen: importScreen, need: 'import' },
  { name: 'team', label: 'Team', screen: team },
  { name: 'billing', label: 'Plan and billing', screen: billingScreen }
];
/** The sidebar's groups and icons for NAV (icons.js names). */
const NAV_GROUPS = [
  ['Daily', ['today', 'inbox', 'requirements', 'matches', 'submissions', 'placements', 'reports']],
  ['Back office', ['timesheets', 'invoices', 'commission']],
  ['Records', ['bench', 'vendors', 'import']],
  ['Workspace', ['team', 'billing']]
];
const NAV_ICON = { today: 'today', bench: 'bench', requirements: 'requirements', matches: 'matches', inbox: 'inbox', vendors: 'vendors', submissions: 'submissions', placements: 'placements', reports: 'reports', timesheets: 'clock', invoices: 'file', commission: 'percent', import: 'import', team: 'team', billing: 'billing' };

const TITLE = PRODUCT;

async function buildLookups() {
  const [members, everyone, vendorRows, contacts, desks] = await Promise.all([
    store.listMembers({ includeRemoved: true }), store.listConsultants({ includeErased: true }), store.listVendors(), store.listContacts(),
    store.listDesks().catch(() => [])          // Agency desks (0036); a server without them, or an error, means no desk filters
  ]);
  // Staffing P5: an erased consultant kept for the counts is out of every list and picker, but their submissions still read "Erased consultant".
  const consultants = everyone.filter((x) => !x.erased);
  const deskIdx = deskIndex(desks);
  const by = (rows) => new Map(rows.map((r) => [r.id, r]));
  const m = by(members), c = by(everyone), v = by(vendorRows), ct = by(contacts);
  return {
    members, consultants, vendors: vendorRows, contacts, desks, deskIdx, deskName: deskIdx.name,
    memberName: (id) => (m.get(id) ? m.get(id).name : 'Unknown'),
    consultantName: (id) => (c.get(id) ? c.get(id).name : 'Unknown'),
    vendorName: (id) => (v.get(id) ? v.get(id).name : ''),
    contactName: (id) => (ct.get(id) ? ct.get(id).name : '')
  };
}

function go(hash) {
  if (location.hash === hash) renderRoute(); else location.hash = hash;
}

async function signOut() {
  forgetBook();
  await store.signOut();
  if (demoMode) { location.href = location.pathname + '#signin'; return; }
  state.notice = '';
  go('#signin');
}

async function tryDemo() {
  const demo = createStore();
  await demo.signIn();
  location.href = location.pathname + '?demo=1#today';
}

/** The shell options every workspace shares (the switcher, the help link, the person's own plan). */
async function sharedShell(session) {
  const plan = demoMode ? null : await personalPlan(session.user.id);
  let teamName = '';
  if (session.hasTeam || demoMode) { try { teamName = (await store.getTeam()).name; } catch (e) { teamName = ''; } }
  return {
    demo: demoMode, helpUrl: CONFIG.HELP_URL, personalTier: plan ? plan.tier : null, syncTiers: SYNC_TIERS, teamName,
    hasTeam: Boolean(session.hasTeam), pilotAvailable: session.pilotAvailable, roleLabel: session.role ? ROLE_LABELS[session.role] : '',
    planBlock: personalPlanBlock(plan, session.today), onSignOut: signOut
  };
}

/** The sidebar plan block in My book and on personal pages: the person's own plan (Solo is bought and renewed in the extension). */
function personalPlanBlock(plan, today) {
  if (!plan) return null;
  const paid = plan.tier !== 'free';
  const left = personalDaysLeft(plan, today);
  return h('div', { class: 'plan-block ' + (paid ? 'plan-block-ok' : 'plan-block-neutral') },
    h('p', { class: 'plan-block-name' }, h('span', null, PERSONAL_TIER_LABELS[plan.tier] || plan.tier),
      h('span', { class: 'plan-block-state' }, paid ? (left == null ? 'Personal' : plural(left, 'day') + ' left') : 'Personal')),
    h('a', { class: 'plan-block-link', href: '#billing' }, paid ? 'Plan and billing' : 'Compare plans'));
}

/** The sidebar on personal pages: the two workspaces, then the person's own pages. */
function personalGroups(session, opts, current) {
  const bookOk = opts.personalTier != null && SYNC_TIERS.includes(opts.personalTier);
  return [
    { label: 'Workspaces', items: [
      { href: '#book', label: 'My book', icon: 'book', lock: bookOk ? '' : 'Solo' },
      session.hasTeam ? { href: '#today', label: opts.teamName || 'Team workspace', icon: 'bench' } : { href: '#welcome', label: 'Create a team', icon: 'plus' }] },
    { label: 'You', items: [
      { href: '#account', label: 'Your account', icon: 'user', current: current === 'account' },
      { href: '#billing', label: 'Plan and billing', icon: 'billing', current: current === 'billing' }] }
  ];
}

/** A page that belongs to the person, not a team (Your account; Plan and billing without a team), inside the My book shell. */
async function personalPage(root, session, route, body, title) {
  const opts = await sharedShell(session);
  const { root: shellRoot, main } = appShell({
    ...opts, session, workspace: '', title,
    groups: personalGroups(session, opts, route.name),
    primary: h('a', { class: 'btn btn-primary btn-sm top-action', href: session.hasTeam ? '#team' : '#welcome' }, 'Invite a teammate')
  });
  main.append(await body);
  clear(root);
  root.append(shellRoot);
  document.title = title + ' - ' + TITLE;
  if (state.focusMain) { const t = root.querySelector('#page-title'); if (t) t.focus({ preventScroll: true }); }
  state.focusMain = false;
  window.scrollTo(0, 0);
}

function showError(root, err) {
  clear(root);
  root.append(h('main', { class: 'signin', id: 'main' }, h('div', { class: 'signin-card' },
    h('h1', { id: 'page-title', tabindex: '-1' }, 'We could not load your workspace'),
    h('p', { class: 'note note-danger', role: 'alert' }, err && err.message ? err.message : 'Something went wrong. Please try again.'),
    // Try again reads the team from the server again: the error may be that the membership ended (removed, workspace closed).
    button('Try again', { variant: 'primary', class: 'btn-block', onclick: () => { store.forgetTeamCache(); renderRoute(); } }),
    button('Sign out', { variant: 'ghost', class: 'btn-block', onclick: signOut }))));
}

async function renderRoute() {
  const my = ++state.seq;
  const root = document.getElementById('app');
  const route = parseHash(location.hash);
  let session;
  try { session = await store.getSession(); } catch (e) {
    if (my !== state.seq) return;
    if (e && e.code === 'session_expired') { session = { mode: 'live', signedIn: false }; } else { showError(root, e); return; }
  }
  if (my !== state.seq) return;
  state.session = session;
  billingWatch.set(null);          // set again below once a team page is drawn with its billing
  const hasInvite = Boolean(getPending());
  const onSignedIn = () => renderRoute();

  // ── not signed in ───────────────────────────────────────────────────
  if (!session.signedIn || route.name === 'signin') {
    if (session.signedIn && route.name === 'signin') { go('#today'); return; }
    if (!session.signedIn && route.name !== 'signin' && route.name !== 'accept') { history.replaceState(null, '', location.pathname + location.search + '#signin'); }
    const notice = state.notice; state.notice = '';
    clear(root);
    if (demoMode) root.append(banner());
    root.append(await signin.render({ store, auth, session, notice, hasInvite, onSignedIn, tryDemo }));
    document.title = 'Sign in - ' + TITLE;
    return;
  }

  // ── landing (no screen in the address): the workspace used last; My book only for a plan that includes it ──
  if (state.landing) {
    state.landing = false;
    if (!demoMode && session.hasTeam && readLastWorkspace() === 'book' && !hasInvite && noTeamHome(await personalPlan(session.user.id)) === 'book') {
      if (my !== state.seq) return;
      history.replaceState(null, '', location.pathname + location.search + '#book');
      renderRoute(); return;
    }
  }

  // ── live: a pending invite is used before anything else ─────────────
  if (!demoMode && hasInvite) {
    clear(root);
    root.append(await accept.render({ store, session, go, signOut, onJoined: () => { history.replaceState(null, '', location.pathname + location.search + '#today'); renderRoute(); } }));
    document.title = 'Join your team - ' + TITLE;
    return;
  }

  // ── live: My book (Solo personal workspace), for people in a team or not ──
  if (route.name === 'book') {
    if (demoMode) { toast('My book needs a real sign-in. It is not part of the demo workspace.'); go('#today'); return; }
    let kit;
    try { kit = await getBook(); } catch (e) { if (my === state.seq) showError(root, e); return; }
    await kit.vault.check(session.user.id);
    if (my !== state.seq) return;
    const shellOpts = await sharedShell(session);
    if (my !== state.seq) return;
    saveLastWorkspace('book');
    clear(root);
    root.append(book.render({ ...kit, session, route, refresh: renderRoute, signOut, toast, go, shell: shellOpts }));
    const t = root.querySelector('#page-title');
    document.title = (t ? t.textContent + ' - ' : '') + 'My book - ' + TITLE;
    if (state.focusMain) (t || root.querySelector('#main')).focus({ preventScroll: true });
    state.focusMain = false;
    window.scrollTo(0, 0);
    return;
  }

  // ── live: Your account (Delete my account), for people in a team or not ──
  if (route.name === 'account') {
    if (demoMode) { toast('Your account needs a real sign-in. It is not part of the demo workspace.'); go('#today'); return; }
    await personalPage(root, session, route, accountScreen.render({
      auth, config: CONFIG, session, go, signOut, loadPlan: () => store.getPersonalPlan(),
      onDeleted: async (notice) => { forgetBook(); await store.signOut(); state.notice = notice; go('#signin'); }
    }), 'Your account');
    return;
  }

  // ── live, no team: Plan and billing shows the person's own plan and the way to a team (the team page needs a team) ──
  if (route.name === 'billing' && !demoMode && !session.hasTeam) {
    await personalPage(root, session, route, billingScreen.render({ store, session, route, go, toast, live: true, team: null, refresh: renderRoute,
      loadPlan: () => store.getPersonalPlan() }), 'Plan and billing');
    return;
  }

  // ── live: signed in, no team (yet, or any more: session.lastTeam says why, 0040) ──
  if (!demoMode && !session.hasTeam) {
    // A Solo/Pro user goes to My book, unless a team membership ended in the last 30 days (the welcome screen says why first,
    // session.lastTeam, 0040; it links to My book) or they opened a colleague's pilot link (?ref=, kept by referral.js): then they came
    // to create the workspace.
    if (route.name !== 'welcome' && !session.lastTeam && !getRef() && noTeamHome(await personalPlan(session.user.id)) === 'book') {
      if (my !== state.seq) return;
      history.replaceState(null, '', location.pathname + location.search + '#book');
      renderRoute(); return;
    }
    if (my !== state.seq) return;
    clear(root);
    // onDone(hash): '#today' after a normal start; '#billing' when the new workspace has no pilot and starts read-only (pay there).
    const onDone = (hash) => { history.replaceState(null, '', location.pathname + location.search + (hash === '#billing' ? '#billing' : '#today')); renderRoute(); };
    root.append(await welcome.render({ store, session, go, signOut, onDone }));
    document.title = 'Create your workspace - ' + TITLE;
    return;
  }

  if (route.name === 'accept' || route.name === 'welcome') { go('#today'); return; }

  let ctx;
  try {
    ctx = { store, auth, session, route, go, toast, live: !demoMode, lk: await buildLookups(), refresh: renderRoute, signOut, loadPlan: () => store.getPersonalPlan() };
    ctx.team = await store.getTeam();
    // The team inbox counts (nav badge, Today line). Never stops a screen from loading.
    try { ctx.inbox = await store.getInboxInfo(); } catch (e) { ctx.inbox = inboxInfoUnavailable(); }
  } catch (e) {
    if (my !== state.seq) return;
    if (e && e.code === 'session_expired') return;      // onSessionLost already re-rendered the sign-in page
    showError(root, e); return;
  }
  if (my !== state.seq) return;
  const billing = ctx.team.billing || { writable: true };
  ctx.readOnly = billing.writable === false;
  billingWatch.set(demoMode ? null : billing);
  ctx.onCheckoutStarted = () => billingWatch.startCheckoutPoll();
  ctx.can = (a) => canNow(session.role, a, ctx.team.settings, billing.writable);

  const entry = NAV.find((n) => n.name === route.name) || (route.name === 'consultant' ? { name: 'bench', screen: consultant } : null)
    || (route.name === 'audit' ? { name: 'team', screen: audit } : null)      // #audit: the activity log, under Team
    || (route.name === 'templates' ? { name: 'team', screen: templatesScreen } : null);   // Email templates live under Team
  if (!entry) { location.hash = '#today'; return; }

  saveLastWorkspace('team');
  const shared = await sharedShell(session);
  if (my !== state.seq) return;
  clear(root);
  if (demoMode) root.append(banner());
  root.append(shell(ctx, entry.name, shared));
  const main = document.getElementById('main');
  const bb = billingBanner(ctx, billing);
  if (bb) main.append(bb);
  let view;
  try { view = await entry.screen.render(ctx); } catch (e) { view = h('p', { class: 'note note-danger', role: 'alert' }, 'Something went wrong: ' + e.message); }
  if (my !== state.seq) return;
  main.append(view);
  const title = main.querySelector('#page-title');
  document.title = (title ? title.textContent + ' - ' : '') + TITLE + (demoMode ? ' (demo)' : '');
  if (state.focusMain) { (title || main).focus({ preventScroll: true }); }
  state.focusMain = false;
  window.scrollTo(0, 0);
}

function banner() {
  return h('div', { class: 'demo-banner', role: 'region', 'aria-label': 'Demo mode' },
    h('span', { class: 'demo-dot', 'aria-hidden': 'true' }),
    h('span', null, h('strong', null, 'Demo workspace.'), ' Made-up people and companies. Nothing you type leaves this browser.'),
    button('Reset demo data', {
      variant: 'link',
      onclick: async () => {
        if (!confirm('Reset the demo? Your changes to the sample data are removed.')) return;
        await store.resetDemo();
        toast('Demo data reset.');
        renderRoute();
      }
    }),
    h('a', { href: location.pathname, class: 'banner-link' }, 'Leave the demo'));
}

const BANNER_KEY = 'bp_webapp_banner_hidden';
/** The dismissal is kept for one billing state and one day count, so the banner comes back the next day and after any change. */
function bannerId(b) { return [b.tier, b.state, b.paidUntil || '', b.daysLeft].join('|'); }

/**
 * Above each screen: the read-only banner (always, it explains why nothing saves) and, in the last days only (the server's payNow: from
 * day 12 of the pilot, 2 days before a paid month ends), a dismissible "ends in N days" banner. The days left are in the sidebar the
 * rest of the time.
 */
function billingBanner(ctx, b) {
  const owner = ctx.session.role === 'owner';
  const payLink = owner && ctx.route.name !== 'billing' ? h('a', { href: '#billing', class: 'btn btn-money btn-sm' }, 'Choose a plan') : null;
  if (b.state === 'read_only' || b.state === 'closing') {
    // 0043 noPilot: a workspace made without a free pilot never had a plan to end.
    return h('div', { class: 'billing-banner banner banner-warn', role: 'status' },
      h('span', { class: 'banner-ico' }, icon('lock', { size: 18 })),
      h('p', { class: 'banner-text' },
        h('strong', null, 'This workspace is read-only. '),
        b.noPilot ? 'It has no free pilot, so it opens once a plan is paid. ' : 'The plan ended on ' + fmtLong(b.paidUntil) + '. ',
        'Everyone can still see and export the data, but nothing can be added or changed. ',
        b.readOnlyUntil ? 'If it is not paid by ' + fmtLong(b.readOnlyUntil) + ', the workspace will be closed. ' : '',
        owner ? '' : 'Ask the owner to pay.'),
      payLink);
  }
  if (!b.payNow) return null;
  let hidden = '';
  try { hidden = localStorage.getItem(BANNER_KEY) || ''; } catch (e) { /* blocked: always shown */ }
  if (hidden === bannerId(b)) return null;
  const left = b.daysLeft === 0 ? 'ends today' : 'ends in ' + plural(b.daysLeft, 'day');
  const box = h('div', { class: 'billing-banner banner banner-warn', role: 'status' },
    h('span', { class: 'banner-ico' }, icon('clock', { size: 18 })),
    h('p', { class: 'banner-text' },
      h('strong', null, (b.state === 'pilot' ? 'Your pilot ' : 'Your plan ') + left + '. '),
      owner ? 'Pay to keep adding and changing records after ' + fmtLong(b.paidUntil) + '.' : 'The owner can pay in Plan and billing.'),
    payLink,
    h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': 'Hide this message until tomorrow',
      onclick: () => { try { localStorage.setItem(BANNER_KEY, bannerId(b)); } catch (e) { /* blocked */ } box.remove(); }
    }, icon('close', { size: 16 })));
  return box;
}

/** The plan block at the foot of the team sidebar: plan, days left with a thin bar, and "Choose a plan" (the money colour) for the owner. */
function planBlock(ctx) {
  const b = ctx.team.billing || {};
  const [text, kind] = planChip(b);
  const used = pilotUsedPercent(b);
  const owner = ctx.session.role === 'owner';
  const paid = b.state === 'active' && !b.payNow;
  return h('div', { class: 'plan-block plan-block-' + kind },
    h('p', { class: 'plan-block-name' }, h('span', null, TIER_NAMES[b.tier] || 'Plan'), h('span', { class: 'plan-block-state' }, text)),
    used == null ? null : h('div', { class: 'meter meter-sm', role: 'img', 'aria-label': plural(b.daysLeft, 'day') + ' of the pilot left' },
      h('span', { class: 'meter-fill', style: 'width:' + used + '%' })),
    owner && !paid
      ? h('a', { class: 'btn btn-money btn-sm btn-block', href: '#billing' }, 'Choose a plan')
      : h('a', { class: 'plan-block-link', href: '#billing' }, owner ? 'Plan and billing' : 'See the plan'));
}

/** The team workspace inside the one app shell (shell.js): its nav with counts, search, "New submission", the team plan block. */
function shell(ctx, active, shared) {
  const counts = { bench: ctx.lk.consultants.filter((c) => BENCH_STATUSES.includes(c.status)).length, vendors: ctx.lk.vendors.length };
  const shown = NAV.filter((n) => !n.need || ctx.can(n.need));
  const groups = NAV_GROUPS.map(([label, names]) => ({
    label,
    items: names.map((name) => shown.find((n) => n.name === name)).filter(Boolean).map((n) => ({
      href: '#' + n.name, label: n.label, icon: NAV_ICON[n.name], current: n.name === active, count: counts[n.name] || 0,
      badge: n.name === 'inbox' && ctx.inbox && ctx.inbox.newCount > 0 ? ctx.inbox.newCount : 0
    }))
  }));
  const entry = NAV.find((n) => n.name === active);
  const canWrite = ctx.can('edit_records');
  const primary = active === 'submissions' ? null : (canWrite
    ? h('a', { class: 'btn btn-primary btn-sm top-action', href: '#submissions?new=1' }, icon('plus', { size: 16 }), h('span', null, 'New submission'))
    : h('button', { type: 'button', class: 'btn btn-primary btn-sm top-action', disabled: true, title: ctx.readOnly ? 'The workspace is read-only.' : 'Your role cannot add submissions.' },
      icon('lock', { size: 14 }), h('span', null, 'New submission')));
  // Demo: the "View as" switch under the workspace name.
  const demoRole = demoMode ? demoRoleSelect(ROLES, ROLE_LABELS, ctx.session.role, async (e) => {
    await store.setDemoRole(e.target.value); toast('Now viewing as ' + ROLE_LABELS[e.target.value] + '.'); renderRoute();
  }) : null;
  const { root } = appShell({
    ...shared, session: ctx.session, workspace: 'team', teamName: ctx.team.name, roleLabel: ROLE_LABELS[ctx.session.role],
    groups, title: entry ? entry.label : (active === 'account' ? 'Your account' : ''), search: searchBox(ctx.lk, go), primary,
    planBlock: planBlock(ctx), planChip: headerPlanChip(ctx.team.billing), demoRole
  });
  return root;
}

// "/" focuses the search (not while typing in a field).
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const s = document.querySelector('.search-input');
  if (s) { e.preventDefault(); s.focus(); }
});

window.addEventListener('hashchange', () => {
  captureFromLocation(location, history);
  state.focusMain = true;
  renderRoute();
});

async function boot() {
  captureRef(location, history);
  captureFromLocation(location, history);
  applyTheme();
  installOffline({ win: window, doc: document, nav: navigator, root: document.getElementById('app'), toast });
  document.getElementById('toast').before(feedbackFooter({ fetch: (...a) => fetch(...a), config: CONFIG, toast }));
  if (!demoMode) {
    try {
      const r = await auth.consumeRedirect();
      if (r && r.error) state.notice = r.error;
    } catch (e) { state.notice = e && e.message ? e.message : 'Sign-in did not go through. Please try again.'; }
  }
  renderRoute();
}
boot();
