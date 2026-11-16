// webapp/js/ui.js - small shared UI pieces: labels, chips, form fields, tables, notes, toast.

import { h, nextId } from './dom.js';
import { icon } from './icons.js';

export const STATUS_LABELS = { marketing: 'Marketing', interviewing: 'In interview', on_hold: 'On hold', placed: 'Placed', inactive: 'Inactive' };
export const STATUS_KIND = { marketing: 'accent', interviewing: 'ok', on_hold: 'warn', placed: 'ok', inactive: 'neutral' };
export const TIER_LABELS = { prime: 'Prime', tier1: 'Tier 1', tier2: 'Tier 2', direct_client: 'Direct client', avoid: 'Avoid', unrated: 'Not rated' };
export const TIER_KIND = { prime: 'accent', tier1: 'accent', tier2: 'neutral', direct_client: 'ok', avoid: 'danger', unrated: 'neutral' };
export const STAGE_LABELS = { submitted: 'Submitted', vendor_screen: 'Vendor screen', client_interview: 'Client interview', offer: 'Offer', placed: 'Placed', rejected: 'Rejected', no_response: 'No response' };
export const STAGE_KIND = { submitted: 'neutral', vendor_screen: 'accent', client_interview: 'ok', offer: 'ok', placed: 'ok', rejected: 'danger', no_response: 'warn' };
export const TAX_TERMS = ['C2C', 'W2', '1099'];
export const WORK_MODES = { '': 'Not stated', remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' };
export const SOURCE_LABELS = { extension: 'Extension', paste: 'Pasted', import: 'Import', manual: 'Added by hand', inbox: 'Team inbox', board: 'Job board' };
/** A requirement's job board (0037 source_board; the ids of lib/jobboard-mail.js). */
export const BOARD_LABELS = { dice: 'Dice', indeed: 'Indeed', linkedin: 'LinkedIn Job Alerts', ziprecruiter: 'ZipRecruiter', monster: 'Monster', careerbuilder: 'CareerBuilder' };

export function chip(text, kind) { return h('span', { class: 'chip chip-' + (kind || 'neutral') }, text); }

export function field(label, control, opts) {
  const o = opts || {};
  const id = control.id || nextId('f');
  control.id = id;
  const hint = o.hint ? h('span', { class: 'hint', id: id + '-hint' }, o.hint) : null;
  if (hint) control.setAttribute('aria-describedby', id + '-hint');
  return h('div', { class: 'field' + (o.wide ? ' wide' : '') }, h('label', { for: id }, label), control, hint);
}

export function input(props) { return h('input', { type: 'text', ...props }); }

export function select(options, value, props) {
  const el = h('select', props || {});
  for (const [v, text] of Object.entries(options)) el.append(h('option', { value: v, selected: v === value }, text));
  return el;
}

export function button(text, props) {
  const p = props || {};
  return h('button', { type: 'button', ...p, class: 'btn' + (p.variant ? ' btn-' + p.variant : '') + (p.class ? ' ' + p.class : ''), variant: null }, text);
}

export function pageHeader(title, subtitle, actions) {
  return h('header', { class: 'page-head' },
    h('div', null, h('h1', { id: 'page-title', tabindex: '-1' }, title), subtitle ? h('p', { class: 'sub' }, subtitle) : null),
    actions ? h('div', { class: 'actions' }, actions) : null);
}

export function card(title, body, props) {
  return h('section', { class: 'card' + (props && props.class ? ' ' + props.class : ''), 'aria-label': title || null }, title ? h('h2', null, title) : null, body);
}

export function note(kind, ...kids) {
  return h('div', { class: 'note note-' + kind, role: kind === 'danger' ? 'alert' : 'status' }, ...kids);
}

/** A small "nothing here" line inside a card or under filters (icon + one sentence). Whole empty screens use emptyState(). */
export function empty(text) { return h('p', { class: 'empty' }, icon('info', { size: 16 }), h('span', null, text)); }

/**
 * The empty-state pattern (design brief C3/D): icon, one-line title, one sentence, one primary action, an optional second link
 * (for example "Load sample data" in the demo).
 * @param {{icon?:string, title:string, text?:string, action?:Node|null, secondary?:Node|null}} o
 */
export function emptyState(o) {
  return h('div', { class: 'empty-state', role: 'status' },
    h('span', { class: 'empty-ico' }, icon(o.icon || 'list', { size: 24 })),
    h('p', { class: 'empty-title' }, o.title),
    o.text ? h('p', { class: 'empty-text' }, o.text) : null,
    o.action || o.secondary ? h('div', { class: 'empty-actions' }, o.action || null, o.secondary || null) : null);
}

/** The empty states' second action in the demo: put the sample data back. null in a real workspace. */
export function sampleDataButton(ctx) {
  if (!ctx || ctx.live || !ctx.store || typeof ctx.store.resetDemo !== 'function') return null;
  return button('Load sample data', { variant: 'secondary', onclick: async () => { await ctx.store.resetDemo(); toast('Sample data loaded.'); ctx.refresh(); } });
}

/** The lock badge (brief C2): a lock and a short word ("Team plan", "Owner only"), placed after a control's label. */
export function lockBadge(text) {
  return h('span', { class: 'lock-badge' }, icon('lock', { size: 12 }), h('span', null, text));
}

/**
 * A locked feature, shown instead of hidden: the badge, one line saying why, and for a plan lock the owner's way to upgrade
 * ("Choose a plan", the money colour) or, for everyone else, who can change it.
 * @param {{session:{role:string}}} ctx
 * @param {{badge:string, text:string, plan?:boolean}} o  plan: true = a plan limit (upgrade path); false = a role or state lock
 */
export function lockNote(ctx, o) {
  const owner = ctx && ctx.session && ctx.session.role === 'owner';
  const more = o.plan
    ? (owner ? h('a', { class: 'btn btn-money btn-sm', href: '#billing' }, 'Choose a plan') : h('span', { class: 'lock-who' }, 'Ask the owner to change the plan.'))
    : null;
  return h('div', { class: 'lock-note' }, lockBadge(o.badge), h('p', { class: 'lock-text' }, o.text), more);
}

/** Responsive table: a real table on wide screens, stacked rows on a phone (cells carry data-label). */
export function table(columns, rows, opts) {
  const o = opts || {};
  const thead = h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col', class: c.class || null }, c.label))));
  const tbody = h('tbody', null, rows.map((r) => h('tr', { class: o.rowClass ? o.rowClass(r) : null },
    columns.map((c) => h('td', { 'data-label': c.label, class: c.class || null }, c.cell(r))))));
  const tbl = h('table', { class: 'tbl' }, o.caption ? h('caption', { class: 'sr-only' }, o.caption) : null, thead, tbody);
  const wrap = h('div', { class: 'table-wrap' }, tbl);
  watchFit(wrap, tbl);
  return wrap;
}

/**
 * Wide screens: the header sticks under the top bar only when the table fits its box (.is-fit lets the wrapper overflow
 * visibly); a table wider than its box scrolls sideways inside it. Measured per table, never guessed from the window width
 * (a fixed 1100px breakpoint let Submissions and Vendors push the whole page sideways up to ~1500px).
 */
export function watchFit(wrap, tbl) {
  if (typeof ResizeObserver !== 'function') return;
  const fit = () => { if (wrap.isConnected) wrap.classList.toggle('is-fit', tbl.offsetWidth <= wrap.clientWidth + 1); };
  const ro = new ResizeObserver(() => requestAnimationFrame(fit));
  ro.observe(wrap); ro.observe(tbl);
}

export function toast(text) {
  const box = document.getElementById('toast');
  if (!box) return;
  box.textContent = text;
  box.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => box.classList.remove('show'), 3500);
}

export function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }
