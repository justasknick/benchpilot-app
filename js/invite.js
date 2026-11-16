// webapp/js/invite.js - the pending invite link.
// The invite email links to  <app>/#accept-<43 character token>. The token sits in the fragment so no server log ever sees it.
// We take it out of the address bar at once (so it is not left in the history entry or a screenshot), keep it for this tab only,
// and delete it when the invite is used, found invalid, or dismissed. It is never logged and never sent anywhere except
// the `team` function's accept action.

export const PENDING_KEY = 'bp_webapp_pending_invite';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

let memory = '';

function store() { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch (e) { return null; } }

export function isToken(t) { return TOKEN_RE.test(String(t || '')); }

/** The token inside "#accept-<token>", or '' when the hash is something else. */
export function tokenFromHash(hash) {
  const m = /^#accept-(.+)$/.exec(String(hash || ''));
  return m && isToken(m[1]) ? m[1] : '';
}

export function setPending(token, storage) {
  memory = token;
  try { const s = storage === undefined ? store() : storage; if (s) s.setItem(PENDING_KEY, token); } catch (e) { /* memory only */ }
}
export function getPending(storage) {
  try { const s = storage === undefined ? store() : storage; const v = s && s.getItem(PENDING_KEY); if (v && isToken(v)) return v; } catch (e) { /* fall through */ }
  return isToken(memory) ? memory : '';
}
export function clearPending(storage) {
  memory = '';
  try { const s = storage === undefined ? store() : storage; if (s) s.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
}

/**
 * Call at start-up and on every hash change. If the address is an invite link, keep the token, replace the address with a
 * plain "#accept" and return true. A malformed "#accept-..." is dropped.
 */
export function captureFromLocation(loc, hist, storage) {
  const hash = String((loc && loc.hash) || '');
  if (!/^#accept-/.test(hash)) return false;
  const token = tokenFromHash(hash);
  if (token) setPending(token, storage);
  try { if (hist && hist.replaceState) hist.replaceState(null, '', (loc.pathname || '/') + (loc.search || '') + '#accept'); } catch (e) { /* ignore */ }
  return Boolean(token);
}

// Errors after which the same link may still work (wrong account signed in, no connection, a hiccup): the token is kept.
const KEEP_CODES = ['invite_email_mismatch', 'network', 'session_expired', 'server', 'rate_limited'];

/**
 * Use the pending invite. The token is passed to the store for this one call and removed afterwards unless the failure may
 * be fixed by signing in with another address or trying again.
 * @returns {Promise<{status:'none'}|{status:'joined',teamName:string,role:string}|{status:'retry'|'failed',code:string,message:string}>}
 */
export async function acceptPending(store, storage) {
  const token = getPending(storage);
  if (!token) return { status: 'none' };
  try {
    const r = await store.acceptInvite(token);
    clearPending(storage);
    return { status: 'joined', teamName: r.teamName, role: r.role };
  } catch (e) {
    const code = (e && e.code) || 'failed';
    const message = (e && e.message) || 'That did not go through. Please try again.';
    if (KEEP_CODES.includes(code)) return { status: 'retry', code, message };
    clearPending(storage);
    return { status: 'failed', code, message };
  }
}
