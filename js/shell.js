// webapp/js/shell.js - the one app shell for every signed-in page (design brief D, owner 14 Nov 2026: one product, "BenchPilot").
//   Sidebar (232px): logo · workspace switcher (My book, the team workspace or "Create a team workspace") · the workspace's nav with icons
//   and counts · Plan and billing / Your account · the plan block at the foot.
//   Top bar (56px, the purple header band shared with the extension): menu button (phone), page title, search, the plan chip, the
//   primary action, the account menu. The sidebar's logo row is the same band, so the band runs the full width.
// Built with h() only (no HTML strings, no document-level listeners), so the screens' test doubles of the DOM can render it.

import { h } from './dom.js';
import { icon } from './icons.js';
import { lockBadge, select } from './ui.js';
import { PERSONAL_TIER_LABELS } from './personal-plan.js';

export const PRODUCT = 'BenchPilot';
export const THEME_KEY = 'bp_webapp_theme';
/** The last workspace used ('book' | 'team'): signed-in people land there (app.js). */
export const LAST_WS_KEY = 'bp_webapp_last_ws';
export const LOGO = 'shared/icons/logo-mark.svg';

export function brand(size) {
  const s = String(size || 28);
  return h('span', { class: 'brand' }, h('img', { class: 'brand-mark', src: LOGO, alt: '', width: s, height: s }), h('span', null, PRODUCT));
}

/** The theme saved in this browser ('' = follow the system), applied to <html>. */
export function applyTheme() {
  let t = '';
  try { t = localStorage.getItem(THEME_KEY) || ''; } catch (e) { /* blocked */ }
  if (typeof document !== 'undefined' && document.documentElement) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else if (document.documentElement.removeAttribute) document.documentElement.removeAttribute('data-theme');
  }
  return t;
}

export function readLastWorkspace() { try { return localStorage.getItem(LAST_WS_KEY) || ''; } catch (e) { return ''; } }
export function saveLastWorkspace(ws) { try { localStorage.setItem(LAST_WS_KEY, ws); } catch (e) { /* blocked */ } }

export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

/**
 * The switcher's two rows, as data (pure, tested): My book, then the team workspace or the offer to create one.
 * @param {{workspace:'book'|'team'|'', hasTeam:boolean, teamName?:string, role?:string, roleLabel?:string, personalTier?:string|null,
 *          syncTiers:string[], demo?:boolean, pilotAvailable?:boolean}} o
 */
export function switcherRows(o) {
  const bookOpen = !o.demo && o.personalTier != null && o.syncTiers.includes(o.personalTier);
  const book = {
    key: 'book', href: '#book', label: 'Personal (My book)', current: o.workspace === 'book',
    sub: o.demo ? 'Needs a real sign-in' : (o.personalTier == null ? 'Personal' : (bookOpen ? 'Personal · encrypted' : 'Personal')),
    lock: o.demo ? 'Sign in' : (o.personalTier != null && !bookOpen ? 'Solo' : '')
  };
  const team = o.hasTeam || o.demo
    ? { key: 'team', href: '#today', label: o.teamName || 'Team workspace', sub: o.roleLabel || 'Team', current: o.workspace === 'team', lock: '' }
    : { key: 'new', href: '#welcome', label: 'Create a team', sub: o.pilotAvailable === false ? 'Starts when a plan is paid' : '14-day pilot', current: false, lock: '', create: true };
  return [book, team];
}

function switcher(o) {
  const rows = switcherRows(o);
  const cur = rows.find((r) => r.current) || { label: o.title || PRODUCT, sub: '' };
  const pop = h('div', { class: 'ws-pop', id: 'ws-menu', hidden: true, role: 'menu', 'aria-label': 'Workspaces' },
    h('p', { class: 'menu-label' }, 'Workspaces'),
    rows.map((r) => h('a', { class: 'ws-item' + (r.current ? ' is-current' : '') + (r.create ? ' is-create' : ''), href: r.href, role: 'menuitem', 'aria-current': r.current ? 'true' : null },
      h('span', { class: 'ws-mark ws-mark-sm', 'aria-hidden': 'true' }, r.create ? icon('plus', { size: 14 }) : (r.key === 'book' ? icon('book', { size: 14 }) : initials(r.label))),
      h('span', { class: 'ws-text' }, h('span', { class: 'ws-name' }, r.label), h('span', { class: 'ws-role' }, r.sub)),
      r.lock ? lockBadge(r.lock) : (r.current ? icon('check', { size: 16 }) : null))));
  const btn = h('button', { type: 'button', class: 'ws', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'ws-menu' },
    h('span', { class: 'ws-mark', 'aria-hidden': 'true' }, o.workspace === 'book' ? icon('book', { size: 16 }) : initials(cur.label)),
    h('span', { class: 'ws-text' }, h('span', { class: 'ws-name', title: cur.label }, cur.label), h('span', { class: 'ws-role' }, cur.sub)),
    icon('chevron', { size: 16, class: 'ws-chev' }));
  const wrap = h('div', { class: 'ws-wrap' }, btn, pop);
  const setOpen = (open) => { pop.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', () => setOpen(pop.hidden));
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { setOpen(false); btn.focus(); } });
  wrap.addEventListener('focusout', (e) => { if (!e.relatedTarget || !wrap.contains(e.relatedTarget)) setOpen(false); });
  return wrap;
}

function accountMenu(o) {
  const user = o.session.user || {};
  const name = user.name || user.email || '';
  const pop = h('div', { class: 'menu-pop', id: 'account-menu', hidden: true });
  const btn = h('button', { type: 'button', class: 'avatar-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'account-menu', 'aria-label': 'Account menu for ' + name },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name)), h('span', { class: 'avatar-name' }, name), icon('chevron', { size: 14 }));
  const setOpen = (open) => {
    pop.hidden = !open; btn.setAttribute('aria-expanded', String(open));
    if (open && pop.querySelector) { const first = pop.querySelector('a, button'); if (first) first.focus(); }
  };
  btn.addEventListener('click', () => setOpen(pop.hidden));
  const wrap = h('div', { class: 'account' }, btn, pop);
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { setOpen(false); btn.focus(); } });
  wrap.addEventListener('focusout', (e) => { if (!e.relatedTarget || !wrap.contains(e.relatedTarget)) setOpen(false); });

  const current = applyTheme();
  const themeBtns = [['', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, label]) => h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(current === v) }, label));
  themeBtns.forEach((b, i) => b.addEventListener('click', () => {
    try { localStorage.setItem(THEME_KEY, ['', 'light', 'dark'][i]); } catch (err) { /* blocked */ }
    applyTheme();
    themeBtns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  const item = (href, ico, label) => h('a', { class: 'menu-item', href }, icon(ico, { size: 16 }), h('span', null, label));
  pop.append(
    h('div', { class: 'menu-head' }, h('p', { class: 'strong' }, name),
      h('p', { class: 'muted' }, [user.email && user.email !== name ? user.email : '', o.roleLabel || ''].filter(Boolean).join(' · '))),
    h('div', { class: 'menu-group' }, h('p', { class: 'menu-label' }, 'Theme'), h('div', { class: 'segmented segmented-sm', role: 'group', 'aria-label': 'Theme' }, themeBtns)),
    h('div', { class: 'menu-group' },
      o.demo ? null : item('#account', 'user', 'Your account'),
      item('#billing', 'billing', 'Plan and billing'),
      o.helpUrl ? h('a', { class: 'menu-item', href: o.helpUrl, target: '_blank', rel: 'noopener' }, icon('help', { size: 16 }), h('span', null, 'Help')) : null,
      ...(o.menuExtra || [])),
    h('div', { class: 'menu-group' },
      h('button', { type: 'button', class: 'menu-item', onclick: o.onSignOut }, icon('logout', { size: 16 }), h('span', null, 'Sign out'))));
  return wrap;
}

/**
 * The plan chip on the header band (pure, tested): the team's chip when the page passes one ({ text, warn }), else the person's own
 * plan name (Free / Solo). null = no chip (the demo's personal pages, a plan not read yet).
 */
export function planChipData(o) {
  if (o.planChip && o.planChip.text) return { text: o.planChip.text, warn: Boolean(o.planChip.warn) };
  if (o.workspace !== 'team' && o.personalTier && PERSONAL_TIER_LABELS[o.personalTier]) return { text: PERSONAL_TIER_LABELS[o.personalTier], warn: false };
  return null;
}

function planChipLink(o) {
  const c = planChipData(o);
  return c ? h('a', { class: 'plan-chip' + (c.warn ? ' plan-chip-warn' : ''), href: '#billing', title: 'Plan and billing' },
    h('span', { class: 'sr-only' }, 'Plan: '), c.text) : null;
}

function navLink(n) {
  return h('a', { href: n.href, class: 'nav-link', 'aria-current': n.current ? 'page' : null },
    icon(n.icon, { size: 18 }), h('span', { class: 'nav-label' }, n.label),
    n.badge ? h('span', { class: 'nav-badge' }, h('span', { 'aria-hidden': 'true' }, String(n.badge)), h('span', { class: 'sr-only' }, ', ' + n.badge + ' new'))
      : (n.lock ? lockBadge(n.lock) : (n.count ? h('span', { class: 'nav-count' }, h('span', { 'aria-hidden': 'true' }, String(n.count)), h('span', { class: 'sr-only' }, ', ' + n.count)) : null)));
}

/**
 * @param {object} o
 *   session, demo, workspace ('book'|'team'|''), teamName, roleLabel, personalTier, syncTiers, pilotAvailable, hasTeam
 *   groups: [{ label, items: [{ href, label, icon, current?, count?, badge?, lock? }] }]
 *   title: the top bar's page name · search: Node|null · primary: Node|null · planBlock: Node|null · demoRole: Node|null (the "View as" select)
 *   planChip: {text, warn}|null (the team plan on the header band; personal pages show personalTier)
 *   menuExtra: Node[] (account menu) · helpUrl · onSignOut()
 *   mainClass: extra class for <main>
 * @returns {{root:HTMLElement, main:HTMLElement}}
 */
export function appShell(o) {
  const main = h('main', { id: 'main', tabindex: '-1', class: o.mainClass || null });
  const scrim = h('div', { class: 'scrim', hidden: true });
  const side = h('aside', { class: 'side', id: 'site-nav', 'aria-label': 'Main' },
    h('div', { class: 'side-top' },
      h('a', { class: 'brand-link', href: o.workspace === 'book' ? '#book' : '#today', 'aria-label': PRODUCT + ', home' }, brand(26)),
      h('button', { type: 'button', class: 'icon-btn side-close', 'aria-label': 'Close the menu', onclick: () => setNav(false) }, icon('close', { size: 18 }))),
    switcher(o),
    o.demoRole ? h('label', { class: 'demo-role' }, h('span', null, 'View as'), o.demoRole) : null,
    h('nav', { class: 'side-nav', 'aria-label': 'Screens' }, (o.groups || []).map((g) => h('div', { class: 'nav-group' },
      g.label ? h('p', { class: 'nav-group-label' }, g.label) : null, g.items.map(navLink)))),
    h('div', { class: 'side-foot' }, o.planBlock || null));

  const menu = h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-expanded': 'false', 'aria-controls': 'site-nav', 'aria-label': 'Menu' }, icon('menu', { size: 20 }));
  function setNav(open) {
    if (side.classList) side.classList.toggle('open', open);
    scrim.hidden = !open; menu.setAttribute('aria-expanded', String(open));
    if (open && side.querySelector) { const a = side.querySelector('[aria-current="page"]') || side.querySelector('a'); if (a) a.focus(); }
  }
  menu.addEventListener('click', () => setNav(!(side.classList && side.classList.contains('open'))));
  scrim.addEventListener('click', () => setNav(false));
  side.addEventListener('keydown', (e) => { if (e.key === 'Escape' && side.classList.contains('open')) { setNav(false); menu.focus(); } });
  side.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a[href^="#"]')) setNav(false); });

  const top = h('header', { class: 'topbar' },
    menu,
    h('p', { class: 'top-title' }, o.title || ''),
    o.search || h('span', { class: 'top-fill' }),
    planChipLink(o),
    o.primary || null,
    accountMenu(o));

  const root = h('div', { class: 'shell' + (o.workspace === 'book' ? ' shell-book' : '') }, side, scrim, h('div', { class: 'frame' }, top, main));
  return { root, main };
}

/** A small select for the demo's "View as". */
export function demoRoleSelect(roles, labels, value, onchange) {
  return select(Object.fromEntries(roles.map((r) => [r, labels[r]])), value, { class: 'demo-role-select', onchange });
}
