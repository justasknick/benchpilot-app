// webapp/js/auth.js - Supabase Auth over plain fetch (no SDK, no bundler). Same wording and rules as the extension's
// background/auth.js (Google through /authorize, email code through /otp + /verify, rotating refresh tokens).
//
// Security rules kept here:
//   * tokens, emails and codes are never logged and never put in a URL we build (the one exception is Google's own redirect_to);
//   * the session lives in localStorage under one web-app-only key (wrapped in try/catch: private windows can block it);
//   * the URL fragment that carries Google's tokens is removed from the address bar as soon as it is read.

import { CONFIG, appUrl } from './config.js';

export const SESSION_KEY = 'bp_webapp_session_v1';
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const TIMEOUT_MS = 15000;

export class AuthError extends Error {
  constructor(code, message) { super(message); this.name = 'AuthError'; this.code = code; }
}

const RATE = 'Too many attempts. Please wait a few minutes and try again.';
const EXPIRED = 'Your session expired. Please sign in again.';
const GOOGLE_BAD = 'Google sign-in could not be verified. Please try again.';
const NOT_ENABLED = "This sign-in method isn't enabled yet.";
const BAD_CODE = 'That code is wrong or has expired. Check the newest email, or press Resend for a new code.';
export const NETWORK_MSG = "Can't reach the server. Check your internet connection.";
export const FRIENDLY = {
  email_address_invalid: 'Please enter a valid email address.',
  validation_failed: 'Please enter a valid email address.',
  over_request_rate_limit: RATE,
  over_email_send_rate_limit: RATE,
  user_banned: 'This account has been disabled. Contact support for help.',
  provider_disabled: NOT_ENABLED,
  signup_disabled: NOT_ENABLED,
  email_provider_disabled: NOT_ENABLED,
  email_not_confirmed: 'Please verify your email first. Check your inbox for the code.',
  otp_expired: BAD_CODE,
  otp_disabled: NOT_ENABLED,
  bad_code_verifier: GOOGLE_BAD,
  flow_state_not_found: GOOGLE_BAD,
  flow_state_expired: GOOGLE_BAD,
  bad_jwt: EXPIRED,
  session_not_found: EXPIRED,
  session_expired: EXPIRED,
  user_not_found: EXPIRED,
  refresh_token_not_found: EXPIRED,
  refresh_token_already_used: EXPIRED,
  INVALID_CODE: 'Enter the 6-digit code from your email.',
  INVALID_EMAIL: 'Please enter a valid email address.'
};
const FATAL_REFRESH = ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'user_not_found', 'user_banned', 'invalid_grant', 'bad_jwt', 'no_authorization'];

/** Supabase answers { code, error_code, msg } (GoTrue) or { error, error_description } (OAuth style). */
export function supaCode(json, status) {
  if (!json || typeof json !== 'object') return status === 429 ? 'over_request_rate_limit' : '';
  let c = json.error_code || (typeof json.code === 'string' ? json.code : '') || (typeof json.error === 'string' ? json.error : '');
  c = String(c || '').toLowerCase();
  if (!c && status === 429) c = 'over_request_rate_limit';
  return c;
}
export function mapSupaError(json, status) {
  const code = supaCode(json, status);
  return new AuthError(code || 'auth_failed', FRIENDLY[code] || 'Sign-in did not go through. Check your internet connection and try again.');
}

export function cleanEmail(email) {
  const e = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 254) throw new AuthError('INVALID_EMAIL', FRIENDLY.INVALID_EMAIL);
  return e;
}
export function cleanCode(code) {
  const t = String(code || '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(t)) throw new AuthError('INVALID_CODE', FRIENDLY.INVALID_CODE);
  return t;
}

/** "priya.sharma@x.com" -> "Priya Sharma" (a readable name when the account has none). */
export function nameFromEmail(email) {
  const local = String(email || '').split('@')[0].replace(/[._+-]+/g, ' ').trim();
  return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : 'You';
}

function userFrom(u, fallbackEmail) {
  const meta = (u && u.user_metadata) || {};
  const email = String((u && u.email) || fallbackEmail || '').toLowerCase();
  const app = (u && u.app_metadata) || {};
  const providers = Array.isArray(app.providers) ? app.providers : [];
  const provider = app.provider === 'google' && !providers.includes('email') ? 'google' : 'email';
  return {
    id: (u && u.id) || '',
    email,
    name: String(meta.full_name || meta.name || '') || nameFromEmail(email),
    verified: Boolean(u && (u.email_confirmed_at || u.confirmed_at)) || provider === 'google',
    provider
  };
}

/** Parse "#access_token=...&refresh_token=..." (or "#error=...") that Supabase puts in the address after Google. */
export function parseAuthFragment(hash, search) {
  const frag = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const query = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const pick = (k) => frag.get(k) || query.get(k) || '';
  const error = pick('error');
  if (error) return { error: { code: String(pick('error_code') || error).toLowerCase(), cancelled: error === 'access_denied' && !pick('error_code') } };
  const accessToken = frag.get('access_token');
  const refreshToken = frag.get('refresh_token');
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken, expiresIn: Number(frag.get('expires_in')) || 3600 };
}

/**
 * @param {{fetch?:Function, storage?:Storage|null, config?:object, now?:()=>number, location?:object, history?:object, redirect?:(url:string)=>void}} [deps]
 */
export function createAuth(deps) {
  const d = deps || {};
  const cfg = d.config || CONFIG;
  const now = d.now || (() => Date.now());
  const fetcher = d.fetch || ((...a) => fetch(...a));
  const storage = 'storage' in d ? d.storage : (() => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } })();
  const loc = d.location || (typeof location !== 'undefined' ? location : { hash: '', search: '', pathname: '/', hostname: '' });
  const hist = d.history || (typeof history !== 'undefined' ? history : null);
  const redirect = d.redirect || ((url) => { if (loc.assign) loc.assign(url); else loc.href = url; });

  const base = () => String(cfg.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1';
  let memory = null;       // used when storage is blocked, so a session still works until the tab closes
  let inflight = null;

  function load() {
    try {
      const raw = storage && storage.getItem(SESSION_KEY);
      if (raw) { const s = JSON.parse(raw); if (s && s.refreshToken && s.accessToken) return s; }
    } catch (e) { /* fall through */ }
    return memory;
  }
  function save(s) {
    memory = s;
    try { if (storage) storage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* blocked: memory only */ }
  }
  function wipe() {
    memory = null;
    try { if (storage) storage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  async function http(path, opts) {
    const o = opts || {};
    const method = o.method || 'POST';
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    let res;
    try {
      const headers = { apikey: cfg.SUPABASE_ANON_KEY };
      if (o.body !== undefined) headers['Content-Type'] = 'application/json';
      if (o.token) headers.Authorization = 'Bearer ' + o.token;
      res = await fetcher(base() + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: ctl ? ctl.signal : undefined });
    } catch (e) {
      throw new AuthError('network', NETWORK_MSG);
    } finally { if (timer) clearTimeout(timer); }
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { ok: res.ok, status: res.status, json };
  }
  async function call(path, opts) {
    const r = await http(path, opts);
    if (!r.ok) throw mapSupaError(r.json, r.status);
    return r.json || {};
  }

  function sessionFrom(resp, userObj) {
    const user = userFrom(userObj || resp.user, '');
    if (!resp.access_token || !resp.refresh_token || !user.id) throw new AuthError('auth_failed', 'Sign-in failed. Please try again.');
    return { accessToken: resp.access_token, refreshToken: resp.refresh_token, expiresAt: now() + (Number(resp.expires_in) || 3600) * 1000, user };
  }

  const api = {
    /** The stored session as { signedIn, user } (never the tokens). */
    current() {
      const s = load();
      return s ? { signedIn: true, user: { ...s.user } } : { signedIn: false, user: null };
    },
    isSignedIn() { return Boolean(load()); },

    /** Send a 6-digit code (and a link) to this email. Creates the account the first time. */
    async requestCode(email) {
      const e = cleanEmail(email);
      await call('/otp', { body: { email: e, create_user: true } });
      return { sent: true };
    },

    /** Check the code. On success the session is stored. */
    async verifyCode(email, code) {
      const e = cleanEmail(email);
      const token = cleanCode(code);
      const resp = await call('/verify', { body: { type: 'email', email: e, token } });
      const s = sessionFrom(resp);
      s.user = { ...s.user, email: s.user.email || e.toLowerCase(), verified: true };   // a good code proves the address
      save(s);
      return api.current();
    },

    /** Where to send the browser for Google. */
    googleUrl() {
      return base() + '/authorize?provider=google&redirect_to=' + encodeURIComponent(appUrl(loc, cfg));
    },
    startGoogle() { redirect(api.googleUrl()); },
    /**
     * Where to send the browser for Microsoft (work, school or personal accounts): Supabase's Azure provider. The `email` scope is
     * required, or Microsoft returns no address. The session comes back the same way as Google's (the address fragment).
     */
    microsoftUrl() {
      return base() + '/authorize?provider=azure&scopes=' + encodeURIComponent('email') + '&redirect_to=' + encodeURIComponent(appUrl(loc, cfg));
    },
    startMicrosoft() { redirect(api.microsoftUrl()); },

    /**
     * Call once at start-up. If the address holds Google's tokens (or an error), read them, clear the fragment from the
     * address bar, and store the session. Returns null when there was nothing to read.
     * @returns {Promise<null|{signedIn:true}|{error:string,cancelled?:boolean}>}
     */
    async consumeRedirect() {
      const parsed = parseAuthFragment(loc.hash, loc.search);
      if (!parsed) return null;
      try { if (hist && hist.replaceState) hist.replaceState(null, '', loc.pathname || '/'); } catch (e) { /* ignore */ }
      if (parsed.error) {
        if (parsed.error.cancelled) return { error: 'Google sign-in was cancelled.', cancelled: true };
        return { error: FRIENDLY[parsed.error.code] || 'Google sign-in did not go through. Please try again.' };
      }
      const u = await call('/user', { method: 'GET', token: parsed.accessToken });
      save(sessionFrom({ access_token: parsed.accessToken, refresh_token: parsed.refreshToken, expires_in: parsed.expiresIn }, u));
      return { signedIn: true };
    },

    /** A valid access token, refreshed first when it is close to expiry. Rejects with code "unauthenticated" when signed out. */
    getAccessToken(force) {
      if (inflight) return inflight;
      const s = load();
      if (!s) return Promise.reject(new AuthError('unauthenticated', 'Please sign in first.'));
      if (!force && s.expiresAt - now() > REFRESH_MARGIN_MS) return Promise.resolve(s.accessToken);
      inflight = (async () => {
        const r = await http('/token?grant_type=refresh_token', { body: { refresh_token: s.refreshToken } });
        if (!r.ok) {
          const code = supaCode(r.json, r.status);
          if (FATAL_REFRESH.includes(code) || r.status === 401 || r.status === 403 || r.status === 400) {
            wipe();
            throw new AuthError('unauthenticated', EXPIRED);
          }
          throw mapSupaError(r.json, r.status);
        }
        const cur = load();
        if (!cur || cur.refreshToken !== s.refreshToken) throw new AuthError('unauthenticated', 'Please sign in first.');   // signed out meanwhile
        const j = r.json || {};
        if (!j.access_token) throw new AuthError('auth_failed', 'Sign-in did not go through. Check your internet connection and try again.');
        const next = { ...cur, accessToken: j.access_token, refreshToken: j.refresh_token || cur.refreshToken, expiresAt: now() + (Number(j.expires_in) || 3600) * 1000 };
        save(next);
        return next.accessToken;
      })().finally(() => { inflight = null; });
      return inflight;
    },

    /** Drop the session here first, then end it on the server (best effort, this device only). */
    async signOut() {
      const s = load();
      wipe();
      if (!s) return;
      try { await Promise.race([http('/logout?scope=local', { token: s.accessToken }), new Promise((r) => setTimeout(r, 3000))]); } catch (e) { /* already signed out here */ }
    },
    /** Forget the session without calling the server (used when the server already said it is gone). */
    forget() { wipe(); }
  };
  return api;
}
