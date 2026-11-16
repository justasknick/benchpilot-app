// webapp/js/config.js - where the live web app talks to.
// Both Supabase values are public by design (the same pair ships inside the Chrome extension, lib/config.js):
// the publishable key only allows what row-level security permits. Never put a secret key here.

export const CONFIG = Object.freeze({
  SUPABASE_URL: 'https://uhgtlyxarozzdgdizoaz.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_pV2FThlwZ8OnVXEQqVXDJg_9mDrC2q4',
  APP_URL: 'https://justasknick.github.io/benchpilot-app/',
  // The help pages on the public website (website/help/).
  HELP_URL: 'https://justasknick.github.io/benchpilot-site/help/',
  // Extra sign-in providers. A provider's button shows only when it is true here AND the provider is turned on in Supabase
  // (Authentication -> Providers). "Sign in with Microsoft" = Supabase's Azure provider: Nick's setup steps are in
  // docs/setup/MICROSOFT_SIGN_IN.md; set azure to true only after that is done, or the button leads to "provider is not enabled".
  AUTH_PROVIDERS: Object.freeze({ azure: false })
});

/** True when the sign-in provider's button may show (CONFIG.AUTH_PROVIDERS). Google and the email code are always on. */
export function providerEnabled(name, config) {
  const p = (config || CONFIG).AUTH_PROVIDERS || {};
  return Object.prototype.hasOwnProperty.call(p, name) && p[name] === true;
}

/** True when the URL asks for the demo workspace (`?demo=1`). */
export function wantsDemo(search) {
  try { return new URLSearchParams(String(search || '')).get('demo') === '1'; } catch (e) { return false; }
}

/**
 * Where Google sends the person back to. The published address is the one on Supabase's redirect list.
 * On localhost (running the app from the repo for development) the page's own address is used instead; add it to the
 * redirect list yourself if you want to test Google sign-in locally.
 */
export function appUrl(loc, config) {
  const cfg = config || CONFIG;
  const l = loc || (typeof location !== 'undefined' ? location : null);
  if (l && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(l.hostname || '')) return l.origin + l.pathname;
  return cfg.APP_URL;
}
