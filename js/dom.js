// webapp/js/dom.js - a tiny element builder. Text is always added as text nodes (never as HTML), so data from the store
// can never inject markup.

const PROP_KEYS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'readOnly', 'required', 'open']);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROP_KEYS.has(k)) el[k] = v;
    // CSSOM, not a style="" attribute: the page CSP (index.html, style-src 'self') blocks inline style attributes but not the CSSOM.
    else if (k === 'style' && el.style && typeof el.style === 'object') el.style.cssText = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

export function append(el, ...kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

let uid = 0;
export function nextId(prefix) { uid += 1; return `${prefix || 'f'}-${uid}`; }
