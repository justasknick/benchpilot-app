// webapp/js/delete-account.js - "Delete my account" (backlog E11) for the web app, without the DOM (tests drive it directly).
//
// The server (POST /functions/v1/me {action:'delete-account', confirm_email}) needs the typed email of the account and a sign-in within the
// last 10 minutes; a token refresh does not count. Here that sign-in is the 6-digit email code the web app already uses (auth.requestCode /
// auth.verifyCode), sent to the signed-in address only, so it works for Google accounts too. The new session must be the same person.
// A team owner is refused by the server (409 team_owner) with what to do first. Emails and codes are never logged.

const TIMEOUT_MS = 20000;
export const DELETED_NOTICE = 'Your BenchPilot account is deleted. Thank you for trying BenchPilot.';

export class DeleteError extends Error {
  constructor(code, message) { super(message); this.name = 'DeleteError'; this.code = code; }
}

/** True when the typed text is the account's email (spaces and capitals ignored). */
export function confirmMatches(typed, email) {
  const t = String(typed || '').trim().toLowerCase();
  return Boolean(t) && t === String(email || '').trim().toLowerCase();
}

/**
 * @param {{ auth: ReturnType<import('./auth.js').createAuth>, config: {SUPABASE_URL:string, SUPABASE_ANON_KEY:string}, fetch?: typeof fetch }} deps
 */
export function createAccountDeleter(deps) {
  const { auth, config } = deps;
  const fetcher = deps.fetch || ((...a) => fetch(...a));
  const base = () => String(config.SUPABASE_URL).replace(/\/+$/, '');
  const who = () => { const c = auth.current(); return c.signedIn ? c.user : null; };

  return {
    /** Step 1a: email a 6-digit code to the signed-in address. */
    async sendCode() {
      const u = who();
      if (!u || !u.email) throw new DeleteError('unauthenticated', 'Please sign in first.');
      await auth.requestCode(u.email);
      return { sentTo: u.email };
    },

    /** Step 1b: check the code. It starts a fresh session; it must be the same account. */
    async confirmCode(code) {
      const u = who();
      if (!u || !u.email) throw new DeleteError('unauthenticated', 'Please sign in first.');
      await auth.verifyCode(u.email, code);
      const after = who();
      if (!after || after.id !== u.id) throw new DeleteError('different_account', 'That code signed in a different account. Sign out and sign in with the account you want to delete.');
      return { confirmed: true };
    },

    /** Step 3: the server deletes the account. On success the session is forgotten here. */
    async deleteAccount(typed) {
      const u = who();
      if (!u) throw new DeleteError('unauthenticated', 'Please sign in first.');
      if (!confirmMatches(typed, u.email)) throw new DeleteError('confirm_mismatch', 'Type the email address of this account to confirm.');
      const token = await auth.getAccessToken();
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
      let res;
      try {
        res = await fetcher(base() + '/functions/v1/me', {
          method: 'POST',
          headers: { apikey: config.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete-account', confirm_email: String(typed).trim().toLowerCase() }),
          signal: ctl ? ctl.signal : undefined
        });
      } catch (e) {
        throw new DeleteError('network', "Can't reach the server. Check your internet connection and try again.");
      } finally { if (timer) clearTimeout(timer); }
      let json = null;
      try { json = await res.json(); } catch (e) { json = null; }
      if (res.ok && json && json.deleted === true) { auth.forget(); return { deleted: true }; }
      const err = json && json.error && typeof json.error === 'object' ? json.error : {};
      if (res.status === 401) throw new DeleteError('session_expired', 'Your session expired. Please sign in again.');
      if (err.code && err.message && res.status < 600) throw new DeleteError(String(err.code), String(err.message));
      throw new DeleteError('server', 'Something went wrong on our side. Please try again.');
    }
  };
}
