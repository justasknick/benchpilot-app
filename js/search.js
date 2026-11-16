// webapp/js/search.js - the top bar's search: consultants, vendor companies and contacts already loaded for the page (ctx.lk), so it
// sends nothing anywhere. searchBook() is pure (tested); searchBox() is the combobox (arrow keys, Enter, Escape, "/" to focus).

import { h, clear } from './dom.js';
import { icon } from './icons.js';

const norm = (s) => String(s || '').toLowerCase();

/**
 * @param {{consultants?:object[], vendors?:object[], contacts?:object[], vendorName?:(id:string)=>string}} lk
 * @param {string} q
 * @returns {{kind:string, label:string, sub:string, href:string}[]}  names that start with the words first, then the rest; at most `limit`
 */
export function searchBook(lk, q, limit) {
  const words = norm(q).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const max = limit || 8;
  const hits = [];
  const add = (kind, label, sub, href, hay) => {
    const text = norm(label + ' ' + hay);
    if (!words.every((w) => text.includes(w))) return;
    hits.push({ kind, label, sub, href, rank: norm(label).startsWith(words[0]) ? 0 : 1 });
  };
  for (const c of lk.consultants || []) add('Consultant', c.name, c.title || '', '#consultant-' + c.id, [c.title, (c.skills || []).join(' ')].join(' '));
  for (const v of lk.vendors || []) add('Company', v.name, v.domain || '', '#vendors?company=' + encodeURIComponent(v.id), v.domain || '');
  for (const ct of lk.contacts || []) {
    const company = lk.vendorName ? lk.vendorName(ct.companyId) : '';
    add('Contact', ct.name, [ct.title, company].filter(Boolean).join(' · '), '#vendors?company=' + encodeURIComponent(ct.companyId || ''), [ct.email, ct.title, company].join(' '));
  }
  hits.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  return hits.slice(0, max).map(({ rank, ...r }) => r);
}

/** The search combobox for the top bar. go(hash) opens a result. */
export function searchBox(lk, go) {
  const listId = 'search-results';
  const input = h('input', {
    type: 'search', class: 'search-input', placeholder: 'Search people and vendors', autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-autocomplete': 'list', 'aria-label': 'Search consultants, companies and contacts'
  });
  const list = h('ul', { class: 'search-pop', id: listId, role: 'listbox', 'aria-label': 'Search results', hidden: true });
  let results = [];
  let active = -1;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const mark = () => {
    [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0 && list.children[active]) input.setAttribute('aria-activedescendant', list.children[active].id);
    else input.removeAttribute('aria-activedescendant');
  };
  const open = (r) => { close(); input.value = ''; go(r.href); };
  const draw = () => {
    results = searchBook(lk, input.value);
    clear(list);
    if (!input.value.trim()) { close(); return; }
    if (!results.length) list.append(h('li', { class: 'search-none', role: 'option', 'aria-disabled': 'true', id: listId + '-none' }, 'Nothing matches "' + input.value.trim() + '".'));
    results.forEach((r, i) => list.append(h('li', {
      class: 'search-item', role: 'option', id: listId + '-' + i, 'aria-selected': 'false',
      onmousedown: (e) => { e.preventDefault(); open(r); }
    }, h('span', { class: 'search-kind' }, r.kind), h('span', { class: 'search-label' }, r.label), r.sub ? h('span', { class: 'search-sub' }, r.sub) : null)));
    active = results.length ? 0 : -1;
    list.hidden = false; input.setAttribute('aria-expanded', 'true'); mark();
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); active = (active + 1) % results.length; mark(); }
    else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); active = (active - 1 + results.length) % results.length; mark(); }
    else if (e.key === 'Enter' && active >= 0 && results[active]) { e.preventDefault(); open(results[active]); }
    else if (e.key === 'Escape') { input.value = ''; close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
  return h('div', { class: 'search', role: 'search' }, h('span', { class: 'search-ico' }, icon('search', { size: 16 })), input,
    h('kbd', { class: 'search-key', 'aria-hidden': 'true' }, '/'), list);
}
