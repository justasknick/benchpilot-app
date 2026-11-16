// webapp/js/icons.js - one line-icon set (Lucide-style, 24 grid, 1.75 stroke, currentColor), drawn as inline SVG elements.
// Built with createElementNS from plain shape data (never from an HTML string). Decorative: aria-hidden, the label sits next to it.

const SVG = 'http://www.w3.org/2000/svg';

// p: path d · c: cx cy r · r: x y w h rx
const SHAPES = {
  today: ['r:3 4 18 18 2', 'p:M16 2v4M8 2v4M3 10h18', 'p:m9 16 2 2 4-4'],
  bench: ['p:M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'c:9 7 4', 'p:M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'],
  requirements: ['r:2 7 20 14 2', 'p:M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16'],
  matches: ['c:12 12 10', 'c:12 12 6', 'c:12 12 2'],
  inbox: ['p:M22 12h-6l-2 3h-4l-2-3H2', 'p:M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
  vendors: ['r:4 2 16 20 2', 'p:M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01'],
  submissions: ['p:m22 2-7 20-4-9-9-4Z', 'p:M22 2 11 13'],
  placements: ['p:M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z', 'p:m9 12 2 2 4-4'],
  import: ['p:M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'p:m17 8-5-5-5 5M12 3v12'],
  team: ['p:M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', 'c:12 12 3'],
  billing: ['r:2 5 20 14 2', 'p:M2 10h20M6 15h4'],
  templates: ['r:2 4 20 16 2', 'p:m22 7-10 6L2 7'],
  reports: ['p:M3 3v18h18', 'p:M7 16v-5M12 16V8M17 16v-8'],
  audit: ['p:M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'p:M3 3v5h5M12 7v5l4 2'],
  search: ['c:11 11 8', 'p:m21 21-4.3-4.3'],
  lock: ['r:3 11 18 11 2', 'p:M7 11V7a5 5 0 0 1 10 0v4'],
  plus: ['p:M12 5v14M5 12h14'],
  menu: ['p:M4 6h16M4 12h16M4 18h16'],
  close: ['p:M18 6 6 18M6 6l12 12'],
  chevron: ['p:m6 9 6 6 6-6'],
  check: ['p:M20 6 9 17l-5-5'],
  book: ['p:M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'],
  user: ['c:12 8 5', 'p:M20 21a8 8 0 0 0-16 0'],
  logout: ['p:M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'],
  alert: ['p:m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z', 'p:M12 9v4M12 17h.01'],
  info: ['c:12 12 10', 'p:M12 16v-4M12 8h.01'],
  help: ['c:12 12 10', 'p:M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01'],
  shield: ['p:M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'],
  file: ['p:M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'p:M14 2v4a2 2 0 0 0 2 2h4M16 13H8M16 17H8M10 9H8'],
  list: ['p:M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
  filter: ['p:M22 3H2l8 9.46V19l4 2v-8.54L22 3z'],
  percent: ['p:M19 5 5 19', 'c:6.5 6.5 2.5', 'c:17.5 17.5 2.5'],
  clock: ['c:12 12 10', 'p:M12 6v6l4 2']
};

export const ICON_NAMES = Object.keys(SHAPES);

/**
 * An inline SVG icon, or null where the document cannot make SVG elements (the test doubles of the DOM): icons are decoration only.
 * @param {string} name  a key of SHAPES
 * @param {{size?:number, class?:string}} [opts]
 */
export function icon(name, opts) {
  const o = opts || {};
  const shapes = SHAPES[name];
  if (!shapes || typeof document === 'undefined' || typeof document.createElementNS !== 'function') return null;
  const size = String(o.size || 18);
  const svg = document.createElementNS(SVG, 'svg');
  const attrs = { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'ico' + (o.class ? ' ' + o.class : '') };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const s of shapes) {
    const kind = s[0];
    const v = s.slice(2);
    let el;
    if (kind === 'p') { el = document.createElementNS(SVG, 'path'); el.setAttribute('d', v); }
    else {
      const n = v.split(' ');
      if (kind === 'c') { el = document.createElementNS(SVG, 'circle'); el.setAttribute('cx', n[0]); el.setAttribute('cy', n[1]); el.setAttribute('r', n[2]); }
      else { el = document.createElementNS(SVG, 'rect'); el.setAttribute('x', n[0]); el.setAttribute('y', n[1]); el.setAttribute('width', n[2]); el.setAttribute('height', n[3]); el.setAttribute('rx', n[4]); }
    }
    svg.append(el);
  }
  return svg;
}
