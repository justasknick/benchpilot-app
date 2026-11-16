// webapp/js/consultant-links.js - the consultant self-service link and the company sign-up domain (migration 0056). Pure: no DOM, no network.
//
// Consultant link: an owner or manager makes a link for ONE consultant (and, for an RTR, one submission). The consultant opens it without
// an account (consultant-link.html, js/consultant-link-page.js) and confirms an availability date, a minimum rate, a location preference,
// marketing consent and, for an RTR link, the right to represent. The page shows only the firm's name, the consultant's first name and the
// RTR's role and end client. 14 days, cancel at any time; a new link for the same consultant and submission cancels the earlier one.
// The server (team function, 0056 SQL) keeps the same rules; these copies serve the demo store and the screens.
//
// Sign-up domain: the owner can restrict who joins to one email domain (settings.signupDomain). Invites and accepts from other domains
// are refused by the server (bp_team_invite / bp_team_accept and a trigger); the demo store applies the same rule.

export const LINK_DAYS = 14;
export const LOCATION_PREF_MAX = 120;
export const LINK_STATES = { active: 'Open', answered: 'Answered', cancelled: 'Cancelled', ended: 'Ended' };
export const LINK_STATE_KIND = { active: 'accent', answered: 'ok', cancelled: 'neutral', ended: 'neutral' };
export const PUBLIC_DOMAINS = ['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'rediffmail.com', 'zoho.com', 'gmx.com', 'mail.com', 'yandex.com'];
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const RATE_UNIT_WORDS = { hr: 'an hour', day: 'a day', month: 'a month', year: 'a year' };

const str = (v) => (v == null ? '' : String(v));

/** A consultant_links row (REST) -> the screen's shape. */
export function linkFrom(r) {
  const x = r || {};
  const resp = x.response && typeof x.response === 'object' ? x.response : null;
  return {
    id: str(x.id), consultantId: str(x.consultant_id), submissionId: str(x.submission_id), createdAt: str(x.created_at), expiresAt: str(x.expires_at),
    revokedAt: str(x.revoked_at), opens: Number(x.opens) || 0, respondedAt: str(x.responded_at), responses: Number(x.responses) || 0, response: resp
  };
}

/** 'active' | 'answered' | 'cancelled' | 'ended' at `nowMs`. Answered links stay open until they end (the consultant may correct an answer). */
export function linkState(link, nowMs) {
  const l = link || {};
  if (l.revokedAt) return 'cancelled';
  const end = Date.parse(l.expiresAt);
  if (!Number.isFinite(end) || end <= (Number.isFinite(nowMs) ? nowMs : Date.now())) return 'ended';
  return l.respondedAt ? 'answered' : 'active';
}

/** The last answer in words, for the owner or manager: "Available from 2026-12-01 · Minimum 65 an hour · Prefers Remote · Consent given · RTR given". */
export function answerText(response) {
  const r = response && typeof response === 'object' ? response : null;
  if (!r) return '';
  const parts = [];
  if (r.available_on) parts.push('Available from ' + str(r.available_on));
  if (r.rate_min != null && r.rate_min !== '') parts.push(`Minimum ${Number(r.rate_min)} ${RATE_UNIT_WORDS[r.rate_unit] || ''}`.trim());
  if (r.location_pref) parts.push('Prefers ' + str(r.location_pref));
  if (r.consent === 'give') parts.push('Consent given'); else if (r.consent === 'decline') parts.push('Consent declined');
  if (r.rtr === 'give') parts.push('RTR given'); else if (r.rtr === 'decline') parts.push('RTR declined');
  return parts.join(' · ');
}

export const RATE_UNIT_OPTIONS = { hr: 'Hour', day: 'Day', month: 'Month', year: 'Year' };

/** The link's token from the address fragment (#<43 base64url characters>), or '' (the server answers the same for every bad token). */
export function tokenFromHash(hash) {
  const t = String(hash || '').replace(/^#/, '');
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : '';
}

/**
 * The consultant's form -> the link-respond body, or { error } with a message to show. Empty fields are left out (each answer is
 * optional); at least one is needed. The server checks everything again.
 * @param {{availableOn, rateMin, rateUnit, locationPref, consent, rtr}} v  the form's values (strings)
 * @param {boolean} hasRtr  the link asks for the RTR
 */
export function respondBody(v, hasRtr) {
  const x = v || {};
  const body = {};
  if (x.availableOn) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.availableOn)) return { error: 'Enter the date you are available from.' };
    body.available_on = x.availableOn;
  }
  const rate = String(x.rateMin == null ? '' : x.rateMin).trim();
  if (rate) {
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(rate) || Number(rate) <= 0) return { error: 'Enter your minimum rate as a number, like 65 or 65.50.' };
    body.rate_min = rate;
    body.rate_unit = RATE_UNIT_OPTIONS[x.rateUnit] ? x.rateUnit : 'hr';
  }
  const loc = String(x.locationPref || '').replace(/\s+/g, ' ').trim();
  if (loc) {
    if (loc.length > LOCATION_PREF_MAX) return { error: `Keep the location to ${LOCATION_PREF_MAX} characters.` };
    body.location_pref = loc;
  }
  if (x.consent === 'give' || x.consent === 'decline') body.consent = x.consent;
  if (hasRtr && (x.rtr === 'give' || x.rtr === 'decline')) body.rtr = x.rtr;
  if (!Object.keys(body).length) return { error: 'Fill in at least one answer, then send.' };
  return { body };
}

/** The domain as typed -> lower case, without a leading @ or spaces ('' = no rule). */
export function normalizeDomain(v) { return str(v).trim().toLowerCase().replace(/^@/, ''); }

/** '' when the domain is fine for the owner `ownerEmail`, else the message the server would give. '' (no rule) is always fine. */
export function domainProblem(domain, ownerEmail) {
  const d = normalizeDomain(domain);
  if (!d) return '';
  if (d.length > 253 || !DOMAIN_RE.test(d)) return 'Enter a domain like yourcompany.com.';
  if (PUBLIC_DOMAINS.includes(d)) return "That is a public email service. Enter your company's own domain.";
  if (!emailInDomain(ownerEmail, d)) return 'Your own sign-in address must be in that domain, so you are not locked out of your rule.';
  return '';
}

/** True when there is no rule, or the address is exactly in the domain (a subdomain is another domain). */
export function emailInDomain(email, domain) {
  const d = normalizeDomain(domain);
  if (!d) return true;
  const e = str(email).trim().toLowerCase();
  return e.includes('@') && e.slice(e.lastIndexOf('@') + 1) === d;   // after the LAST @, like the server
}

/** The refusal for an invite or a join from another domain (team.js fail(): domain_not_allowed). */
export function domainRefusal(domain) {
  const d = normalizeDomain(domain);
  return d ? `This workspace only lets @${d} addresses join.` : 'This workspace only lets addresses from its own domain join.';
}
