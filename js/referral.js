// webapp/js/referral.js - the "Bring BenchPilot to your team" pilot link (docs/specs/BRING_TO_TEAM_SPEC.md).
// A colleague shares  <app>/?ref=<12 characters a-z0-9>. The code is not a secret (it only decides who gets the thank-you reward when the
// firm pays), but it is still taken out of the address bar at once and kept in this browser only until the workspace is created.
// localStorage, not sessionStorage: signing in by email code or Google may come back in another tab. It expires after 30 days and is
// deleted once a workspace is created (with or without it). It is sent only with the `team` function's create action.

export const REF_KEY = 'bp_webapp_ref';
export const REF_DAYS = 30;
const REF_RE = /^[a-z0-9]{12}$/;

function store() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }
const pick = (storage) => (storage === undefined ? store() : storage);

export function isRefCode(c) { return REF_RE.test(String(c || '')); }

/**
 * Call at start-up. If the address carries ?ref=<code>, keep the code (a valid one only), remove `ref` from the address (other query
 * parameters such as demo=1 and the hash stay) and return true.
 */
export function captureRef(loc, hist, storage, nowMs = Date.now()) {
  const search = String((loc && loc.search) || '');
  const params = new URLSearchParams(search);
  if (!params.has('ref')) return false;
  const code = String(params.get('ref') || '').trim().toLowerCase();
  const good = isRefCode(code);
  if (good) {
    try { const s = pick(storage); if (s) s.setItem(REF_KEY, JSON.stringify({ code, at: nowMs })); } catch (e) { /* not kept */ }
  }
  params.delete('ref');
  const rest = params.toString();
  try { if (hist && hist.replaceState) hist.replaceState(null, '', (loc.pathname || '/') + (rest ? '?' + rest : '') + (loc.hash || '')); } catch (e) { /* ignore */ }
  return good;
}

/** The kept code, or '' when there is none, it is malformed or older than REF_DAYS. */
export function getRef(storage, nowMs = Date.now()) {
  try {
    const s = pick(storage);
    const raw = s && s.getItem(REF_KEY);
    if (!raw) return '';
    const v = JSON.parse(raw);
    if (!v || !isRefCode(v.code) || !Number.isFinite(v.at) || nowMs - v.at > REF_DAYS * 86400000) { s.removeItem(REF_KEY); return ''; }
    return v.code;
  } catch (e) { return ''; }
}

export function clearRef(storage) {
  try { const s = pick(storage); if (s) s.removeItem(REF_KEY); } catch (e) { /* ignore */ }
}
