// webapp/js/offline.js - when the browser is offline: a banner, Save buttons turned off, and no form sent.
// Only the buttons this file turned off are turned back on (a button a screen disabled for a role or a rule stays disabled).

export const OFFLINE_TEXT = 'You are offline. You can read what is on screen; saving is off until the connection is back.';
const MARK = 'offlineOff';

/** Turns the submit (Save) buttons under `root` off while offline, and back on afterwards. Returns how many changed. */
export function setSaveButtons(root, offline) {
  let n = 0;
  for (const b of root.querySelectorAll('button[type="submit"]')) {
    if (offline && !b.disabled) { b.disabled = true; b.dataset[MARK] = '1'; n += 1; }
    else if (!offline && b.dataset[MARK]) { b.disabled = false; delete b.dataset[MARK]; n += 1; }
  }
  return n;
}

/**
 * Wires the banner, the buttons and a submit guard. `nav` = navigator-like ({onLine}); `win` / `doc` = window and document.
 * New forms drawn while offline are caught by a MutationObserver on `root`.
 */
export function installOffline({ win, doc, nav, root, toast }) {
  const isOff = () => nav.onLine === false;
  const bar = doc.createElement('div');
  bar.className = 'offline-banner';
  bar.setAttribute('role', 'status');
  bar.hidden = true;
  bar.textContent = OFFLINE_TEXT;
  doc.body.prepend(bar);
  const apply = () => {
    const off = isOff();
    bar.hidden = !off;
    doc.body.classList.toggle('is-offline', off);
    setSaveButtons(root, off);
  };
  win.addEventListener('online', apply);
  win.addEventListener('offline', apply);
  // A form sent while offline would fail half-way: stop it before any screen handler runs.
  doc.addEventListener('submit', (e) => {
    if (!isOff()) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (toast) toast(OFFLINE_TEXT);
  }, true);
  if (typeof win.MutationObserver === 'function') new win.MutationObserver(() => { if (isOff()) setSaveButtons(root, true); }).observe(root, { childList: true, subtree: true });
  apply();
  return { apply };
}
