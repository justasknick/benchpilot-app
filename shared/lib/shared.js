// lib/shared.js - Constants and helpers shared by every BenchPilot context
// (service worker, content script, popup, dashboard, options, upgrade page).

(function (root) {
  'use strict';

  const CFG = root.BP_CONFIG || {};

  // ── Lead statuses (single source of truth) ──────────────────────────────
  const STATUSES = ['New', 'Contacted', 'Responded', 'Interview', 'Closed'];
  const STATUS_EMOJI = { New: '🆕', Contacted: '📨', Responded: '✅', Interview: '🎤', Closed: '🔒' };
  // Values written by v1.0.x drawer before statuses were unified
  const LEGACY_STATUS_MAP = { 'New Lead': 'New', 'Profile Sent': 'Contacted', 'Hot Lead': 'Responded' };

  function normalizeStatus(status) {
    if (STATUSES.includes(status)) return status;
    return LEGACY_STATUS_MAP[status] || 'New';
  }

  // ── Defaults ─────────────────────────────────────────────────────────────
  const DEFAULT_DESIGNATIONS = [
    'Technical Recruiter', 'US IT Recruiter', 'IT Recruiter', 'Recruiter',
    'Lead Recruiter', 'Lead IT Recruiter', 'Lead Technical Recruiter',
    'Talent Acquisition', 'Talent Acquisition Specialist', 'Lead Talent Acquisition Specialist',
    'Account Manager', 'Sourcer', 'Staffing', 'Recruitment', 'Delivery Manager'
  ];

  const DEFAULT_BLACKLIST = [
    'example.com', 'domain.com', 'sample.com', 'test.com', 'email.com',
    'sentry.io', 'w3.org', 'schema.org', 'cloudflare.com', 'linkedin.com'
  ];

  // ── Companies (v1.5 data foundation) ─────────────────────────────────────
  // A company groups recruiters by email domain. Free-mail domains never form one.
  const COMPANY_LABELS = {
    none: 'No label',
    trusted: 'Trusted',
    avoid: 'Avoid',
    'direct-client': 'Direct client',
    'prime-vendor': 'Prime vendor',
    'implementation-partner': 'Implementation partner',
    'bench-seller': 'Bench seller (not hiring)'
  };
  const COMPANY_LABEL_KEYS = Object.keys(COMPANY_LABELS);

  // Exact free-mail domains, plus families that exist under many country domains (yahoo.co.in...).
  const FREE_MAIL_DOMAINS = [
    'gmail.com', 'googlemail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
    'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'mail.com', 'rediffmail.com',
    'yahoo.com', 'yahoo.co.in', 'hotmail.com'   // also matched by FREE_MAIL_FAMILY; listed so plain .includes() keeps working
  ];
  // Old name, kept so nothing that still reads it breaks. Same list: use BP.isFreeMailDomain() for new code.
  const FREE_EMAIL_DOMAINS = FREE_MAIL_DOMAINS;
  const FREE_MAIL_FAMILY = /^(yahoo|hotmail|yandex|gmx)\.[a-z]{2,}(\.[a-z]{2,})?$/;

  // Lower-case domain of an email, or '' when it has none.
  function emailDomain(email) {
    const s = String(email || '').trim().toLowerCase();
    const at = s.lastIndexOf('@');
    if (at < 1) return '';
    const d = s.slice(at + 1);
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : '';
  }

  function isFreeMailDomain(domain) {
    const d = String(domain || '').trim().toLowerCase();
    return FREE_MAIL_DOMAINS.includes(d) || FREE_MAIL_FAMILY.test(d);
  }

  // Company id for an email (its business domain), or null for free-mail / invalid addresses.
  function companyIdForEmail(email) {
    const d = emailDomain(email);
    return d && !isFreeMailDomain(d) ? d : null;
  }

  // Most common non-empty name (case-insensitive; ties go to the one seen first). Returns the
  // first-seen spelling, or `fallback` when there is none.
  function pickCompanyName(names, fallback = '') {
    const counts = new Map();
    for (const raw of names || []) {
      const n = String(raw || '').trim();
      if (!n) continue;
      const k = n.toLowerCase();
      const e = counts.get(k);
      if (e) e.n++; else counts.set(k, { name: n, n: 1 });
    }
    let best = null;
    for (const e of counts.values()) if (!best || e.n > best.n) best = e;
    return best ? best.name : fallback;
  }

  const DEFAULT_TEMPLATES = [
    {
      id: 'intro',
      name: 'Consultant intro',
      subject: 'Available consultant for your {requirement} role',
      body:
        'Hi {firstName},\n\n' +
        'I came across your {requirement} requirement {location}. I have a strong consultant available ' +
        'who matches this role and can start immediately.\n\n' +
        'Could you share the full job description and rate? I will send the resume right away.\n\n' +
        'Thanks & Regards,\n{myName}'
    },
    {
      id: 'consultant',
      name: 'Submit a consultant',
      subject: '{consultantTitle} available for your {requirement} role - {consultantVisa}',
      body:
        'Hi {firstName},\n\n' +
        'I saw your {requirement} requirement {location} and have a matching consultant:\n\n' +
        'Name: {consultantName}\n' +
        'Role: {consultantTitle}\n' +
        'Experience: {consultantExperience}\n' +
        'Key skills: {consultantSkills}\n' +
        'Visa: {consultantVisa}\n' +
        'Location: {consultantLocation}\n' +
        'Availability: {consultantAvailability}\n' +
        'Rate: {consultantRate}\n\n' +
        'Resume: {consultantResume}\n\n' +
        'Please let me know if we can submit. Happy to share more details.\n\n' +
        'Thanks & Regards,\n{myName}'
    },
    {
      id: 'hotlist',
      name: 'Hotlist share',
      subject: 'Available bench consultants - {technologies}',
      body:
        'Hi {firstName},\n\n' +
        'Hope you are doing well. Sharing our currently available consultants. ' +
        'Please let me know if any of them fit your open requirements at {company}.\n\n' +
        '<paste hotlist here>\n\n' +
        'Thanks & Regards,\n{myName}'
    }
  ];

  const MAX_CONSULTANTS = 200;
  const MAX_TEMPLATES = 10;

  // ── Plan tiers: the ONE table every context gates through ───────────────
  // Every tier saves unlimited recruiter contacts (since v1.20, Solo, decision F6): there is no contact limit to configure.
  // On sale: Free and Solo. Basic and Pro are retired (not sold; holders keep them until they end). Basic is never worse than
  // Free (unlimited contacts too). Pro keeps sync for the owner accounts and the store reviewer key.
  // vendorCheckins / morningSummary: Today's homework extras (quiet-vendor check-ins, yesterday's numbers), decision 14 Nov.
  // placements: staffing P3's month gross margin and the placements CSV for an accounting tool (recording interviews and placements is free).
  // invoicing (schema 21, lib/invoicing.js): invoices from timesheets, print / PDF, the invoice CSV and the commission estimate. Recording
  // timesheet weeks is free on every plan.
  const PRO_FEATURES = { csvExport: true, followUps: true, csvImport: true, jsonExport: true, matcher: true, cleanupActions: true, resumeVersions: true,
    vendorCheckins: true, morningSummary: true, placements: true, targets: true, invoicing: true };
  // What rides on the encrypted sync copy, with the server's sync gate (SYNC_PLANS: Solo or Pro): the web app's My book reads the synced
  // book, and the personal inbox address (docs/specs/SOLO_INBOX_SPEC.md) uses the same gate. Listed here so plan pages name them.
  const SYNC_FEATURES = { sync: true, webBook: true, inbox: true };
  const TIERS = {
    free:  { label: 'Free',  consultants: 3,  templates: 1, quickNotes: 3,
             features: { csvImport: true } },
    basic: { label: 'Basic', consultants: 10, templates: 3, quickNotes: 20,
             features: { csvExport: true, followUps: true, csvImport: true, jsonExport: true, cleanupActions: true } },
    pro:   { label: 'Pro',   consultants: MAX_CONSULTANTS, templates: MAX_TEMPLATES, quickNotes: Infinity,
             features: { ...PRO_FEATURES, ...SYNC_FEATURES, hotlist: true, smartLists: true } },
    solo:  { label: 'Solo',  consultants: MAX_CONSULTANTS, templates: MAX_TEMPLATES, quickNotes: Infinity,
             features: { ...PRO_FEATURES, ...SYNC_FEATURES, hotlist: true, smartLists: true } }
  };
  // Order = rank (mirrors PAID_TIERS in supabase/functions/_shared/plans.js): Solo has everything Pro has plus sync.
  const TIER_ORDER = ['free', 'basic', 'pro', 'solo'];
  // The one plan on sale: every "Upgrade" button points here.
  const SELL_TIER = 'solo';
  // The plan ids on sale: the one list the upgrade page, the account page and the checkout call accept. Mirrors the sellable PLANS
  // in supabase/functions/_shared/plans.js (tests/plans-account.test.js checks both match); the server stays the source of truth.
  const SELL_PLANS = Object.freeze({
    solo_monthly: Object.freeze({ tier: 'solo', days: 31 }),
    solo_yearly: Object.freeze({ tier: 'solo', days: 366 }),
    solo_founding: Object.freeze({ tier: 'solo', days: 31, founding: true })
  });
  const isSellPlan = (id) => Object.prototype.hasOwnProperty.call(SELL_PLANS, id);
  // Every feature and no limits (Pro holders keep this until their plan ends).
  function isFullPlan(t) { const x = tierOf(t); return x === 'solo' || x === 'pro'; }
  // The button text for a plan that is not full: "Upgrade to Solo". Full plans have nothing to upgrade to.
  function upgradeLabel(t) { return isFullPlan(t) ? '' : 'Upgrade to ' + TIERS[SELL_TIER].label; }
  // Every plan feature's name. The key order is the order plan pages list them in (BP.planFeatureKeys, tierFeatureList, the Upgrade
  // page's comparison table): add a feature to TIERS and here, and every plan list picks it up.
  const FEATURE_LABELS = {
    sync: 'Sync across computers (encrypted, only you can read it)',
    webBook: 'My book in the web app: your vendor book in any browser',
    inbox: 'Personal inbox address: forward requirement emails, encrypted as they arrive',
    csvExport: 'CSV, Excel and JSON export', followUps: 'Follow-up dates with a due count on the toolbar icon',
    cleanupActions: 'Fix my data actions (merge, dismiss, delete bounced)',
    resumeVersions: 'Resume version history', matcher: 'Tech matcher',
    hotlist: 'Hotlist builder (email text, table, Excel and CSV)', smartLists: 'Saved smart lists in your vendor book',
    vendorCheckins: "Today's homework: check-ins with quiet Trusted vendors", morningSummary: "Today's homework: yesterday's numbers each morning",
    placements: 'Placements: monthly gross margin and a CSV for QuickBooks',
    targets: 'Weekly and monthly targets with your submission funnel',
    invoicing: 'Invoices from your timesheets, print or PDF, and a commission estimate',
    csvImport: 'CSV import (free)', jsonExport: 'JSON export'
  };
  // Features that are not their own line on a plan list: JSON export is part of "CSV, Excel and JSON export".
  const FEATURE_LIST_SKIP = { jsonExport: true };
  // The features that tell plans apart, in FEATURE_LABELS order: a feature every plan has (CSV import) belongs to "On every plan".
  function planFeatureKeys() {
    return Object.keys(FEATURE_LABELS).filter((k) => !FEATURE_LIST_SKIP[k] && !Object.values(TIERS).every((t) => t.features[k]));
  }
  // One line for every place a locked follow-up control is shown (Settings, lead panel). Matches the behaviour: submissions always get a
  // follow-up date; lead follow-up dates and the settings for them need a paid plan (Solo).
  const FOLLOWUP_PLAN_NOTE = 'Free: follow-ups on submissions. Solo: follow-up dates on any recruiter.';

  // Display currency for the plans page. India visitors see rupees, everyone else dollars. DISPLAY ONLY: checkout is in rupees (Razorpay)
  // for now, and the amounts and plan ids sent to the server do not change. Mirrors website/assets/currency.js (same rule, same USD prices).
  const USD_PRICES = { solo: { monthly: 12, yearly: 99 } };
  function detectCurrency(timeZone, language) {
    if (timeZone && ['Asia/Kolkata', 'Asia/Calcutta'].includes(String(timeZone))) return 'INR';
    if (!timeZone && /-IN$/i.test(String(language || ''))) return 'INR';
    return 'USD';
  }

  // Accepts a tier string, a plan object ({ tier }) or a GET_STATE result ({ plan: { tier } }).
  function tierOf(x) {
    let t = x;
    if (t && typeof t === 'object') t = t.plan ? t.plan.tier : t.tier;
    return TIERS[t] ? t : 'free';
  }
  function limit(tier, key) { return TIERS[tierOf(tier)][key]; }
  function can(tier, feature) { return Boolean(TIERS[tierOf(tier)].features[feature]); }
  // The plan to name in "X is a <plan> feature" messages: Free when Free has it, otherwise the plan on sale.
  function minTierFor(feature) { return TIERS.free.features[feature] ? 'free' : SELL_TIER; }
  function tierLabel(tier) { return TIERS[tierOf(tier)].label; }
  // The text of a lock badge on a control the current plan cannot use ("SOLO"). Every UI builds its badge from this, never from a
  // hard-coded plan name, so retiring or renaming a plan cannot leave a stale badge behind (tests/plan-labels.test.js).
  function lockBadgeText(feature) { return tierLabel(minTierFor(feature)).toUpperCase(); }
  // The price line shown next to a paywall: "Solo ₹499/month or ₹3,999/year" (India) or "Solo $12/month or $99/year" (elsewhere, display
  // only). The two list prices, not a "from" price: the founding price (limited places) and the yearly price per month are both lower
  // than the monthly price, so "from ₹499/month" was not true. Built from CFG.PRICING and USD_PRICES so it always matches the Upgrade page.
  // currency: 'INR' | 'USD' (BP.detectCurrency).
  function sellPriceLine(currency) {
    const P = (CFG.PRICING && CFG.PRICING[SELL_TIER]) || null;
    const usd = USD_PRICES[SELL_TIER];
    const pair = currency === 'USD'
      ? (usd ? ['$' + usd.monthly, '$' + usd.yearly] : null)
      : (P ? ['₹' + Number(P.monthlyInr).toLocaleString('en-IN'), '₹' + Number(P.yearlyInr).toLocaleString('en-IN')] : null);
    return pair ? `${TIERS[SELL_TIER].label} ${pair[0]}/month or ${pair[1]}/year` : '';
  }
  // The server's live offers from GET /me ({ offers: { soloFoundingLeft, soloFounder } }), cleaned. soloFoundingLeft is a whole number >= 0,
  // or null when the server does not say (an older server without the field, or no limit known): null never disables anything.
  // soloFounder is true only when the server said this account holds a founding place it may still renew (its 12-month lock).
  function offersFromMe(me) {
    const o = me && typeof me.offers === 'object' && me.offers ? me.offers : {};
    const n = o.soloFoundingLeft;
    return { soloFoundingLeft: typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null, soloFounder: o.soloFounder === true };
  }
  // True only when the server said every founding place is taken and this account is not a founder (a founder keeps renewing at the
  // founding price for 12 months after their first founding payment, sold out or not: the server's /checkout rule).
  function foundingSoldOut(offers) { return Boolean(offers) && offers.soloFoundingLeft === 0 && offers.soloFounder !== true; }
  // The newest payment from GET /me ({ lastPayment: { date, plan, amount, currency } }), cleaned for the account page, or null.
  function lastPaymentFromMe(me) {
    const lp = me && me.lastPayment;
    if (!lp || typeof lp !== 'object' || !Number.isSafeInteger(lp.amount) || !/^\d{4}-\d{2}-\d{2}$/.test(String(lp.date))) return null;
    return { date: lp.date, plan: String(lp.plan || '').slice(0, 40), amount: lp.amount, currency: lp.currency === 'USD' ? 'USD' : 'INR' };
  }
  // A signed-in account's paid plan that has ended (stored as lastPaidPlan { tier, exp } when the account licence is removed), cleaned:
  // { tier, exp } with a paid tier and a past 'YYYY-MM-DD' end, or null.
  function endedPlan(rec) {
    if (!rec || typeof rec !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(rec.exp))) return null;
    const tier = tierOf(rec.tier);
    if (tier === 'free' || daysUntil(rec.exp) >= 0) return null;
    return { tier, exp: rec.exp };
  }
  // This browser's display currency (time zone first, then language): the one place UIs ask, so paywalls and the plans page agree.
  function browserCurrency() {
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { /* no Intl: fall back to the language */ }
    const lang = typeof navigator !== 'undefined' ? navigator.language : '';
    return detectCurrency(tz, lang);
  }

  // A paid plan that ends in this many days or fewer can be extended from the upgrade page (the server adds the new days to the
  // current end date, so none are lost). Takes a GET_STATE result or its `plan`. Returns { tier, label, daysLeft } or null.
  // Only the plan on sale can be bought, so a retired plan (Basic, Pro) renews as Solo: `tier` is what the buyer would pay for.
  const EXTEND_WINDOW_DAYS = 14;
  function extendOffer(stateOrPlan) {
    const p = stateOrPlan && stateOrPlan.plan ? stateOrPlan.plan : stateOrPlan;
    if (!p || !p.isPaid || p.expired) return null;
    const d = Number(p.daysLeft);
    if (!Number.isFinite(d) || d < 0 || d > EXTEND_WINDOW_DAYS) return null;
    const tier = tierOf(p.tier);
    if (tier === 'free') return null;
    return { tier: SELL_TIER, label: (tier === SELL_TIER ? 'Extend ' : 'Renew as ') + TIERS[SELL_TIER].label, daysLeft: d };
  }
  // The button text after a paid plan has ended: only the plan on sale can be bought, so it is always "Renew as Solo".
  function renewLabel() { return 'Renew as ' + TIERS[SELL_TIER].label; }
  // After a paid plan ends, the drawer and popup say so (with "Renew as Solo") for this many days, then stay quiet.
  const EXPIRED_NOTICE_DAYS = 7;
  // The ONE rule for "your plan is ending / has ended" notices (popup, drawer, dashboard). Takes a GET_STATE result or its `plan`.
  // { kind: 'ending', tier, label, daysLeft }  - the extendOffer window (EXTEND_WINDOW_DAYS);
  // { kind: 'expired', tier, label, daysAgo }  - a paid plan that ended EXPIRED_NOTICE_DAYS or fewer days ago;
  // null otherwise.
  function planNotice(stateOrPlan) {
    const p = stateOrPlan && stateOrPlan.plan ? stateOrPlan.plan : stateOrPlan;
    const ext = extendOffer(p);
    if (ext) return { kind: 'ending', ...ext };
    if (!p || !p.expired) return null;
    const ago = -Number(p.daysLeft);
    if (!Number.isFinite(ago) || ago < 1 || ago > EXPIRED_NOTICE_DAYS) return null;
    return { kind: 'expired', tier: SELL_TIER, label: renewLabel(), daysAgo: ago };
  }

  // Monthly rupee price of each paid tier: leftover days convert by this ratio when a buyer changes tier (floored).
  // Mirrors TIER_PRICE and convertRemainingDays in supabase/functions/_shared/plans.js; the server decides the real end date.
  const TIER_PRICE_INR = { basic: 299, pro: 599, solo: 499 };
  function convertDays(fromTier, toTier, remaining) {
    const r = Math.max(0, Math.floor(Number(remaining) || 0));
    if (fromTier === toTier) return r;
    const from = TIER_PRICE_INR[fromTier], to = TIER_PRICE_INR[toTier];
    return from && to ? Math.floor((r * from) / to) : 0;
  }
  function tierRank(tier) { return TIER_ORDER.indexOf(tierOf(tier)); }
  // Signed license payload -> tier. A missing tier means Pro (legacy / manually issued keys).
  function licenseTier(payload) {
    if (payload && (payload.tier === 'basic' || payload.tier === 'pro' || payload.tier === 'solo')) return payload.tier;
    return payload && payload.plan === 'basic' ? 'basic' : 'pro';
  }

  // Bullet lines for pricing / comparison UIs, generated from the table above.
  function tierFeatureList(tier) {
    const t = tierOf(tier);
    const T = TIERS[t];
    const out = [
      'Unlimited recruiter contacts',
      `${T.consultants >= MAX_CONSULTANTS ? 'Up to ' + MAX_CONSULTANTS : T.consultants} bench consultants with auto-matching`,
      `${T.templates} pitch email template${T.templates === 1 ? '' : 's'}`
    ];
    out.push(Number.isFinite(T.quickNotes) ? `${T.quickNotes} quick notes` : 'Unlimited quick notes');
    // Generated from FEATURE_LABELS / TIERS, so a new plan feature appears here without a hand-kept list.
    for (const k of planFeatureKeys()) if (T.features[k]) out.push(FEATURE_LABELS[k]);
    if (T.features.csvImport) out.push('Excel and CSV import (free on every plan)');
    out.push('Full backup and restore (free on every plan)');
    return out;
  }

  // ── Phone labels ──────────────────────────────────────────────────────────
  const PHONE_TYPES = ['unknown', 'mobile', 'office'];
  const PHONE_TYPE_LABELS = { unknown: 'Unknown', mobile: 'Mobile', office: 'Office' };

  function normalizePhoneType(t) { return PHONE_TYPES.includes(t) ? t : 'unknown'; }

  // Extension written straight after a phone number: "555-123-4567 x123", "... ext 112", "Ext: 112".
  // `phone` must be the exact number string as it appears in `text`. Returns digits or ''.
  function phoneExtAfter(text, phone) {
    const t = String(text || '');
    const p = String(phone || '');
    const i = p ? t.indexOf(p) : -1;
    if (i === -1) return '';
    const m = t.slice(i + p.length, i + p.length + 24).match(/^\s*[,;]?\s*(?:ext(?:ension)?\.?|x)\s*[:.#-]?\s*(\d{1,6})(?!\d)/i);
    return m ? m[1] : '';
  }

  // "555-123-4567 x12" typed into one field -> { phone: '555-123-4567', ext: '12' }
  function splitPhoneExt(value) {
    const s = String(value || '').trim();
    const m = s.match(/^(.*?\d)\s*[,;]?\s*(?:ext(?:ension)?\.?|x)\s*[:.#-]?\s*(\d{1,6})\s*$/i);
    return m ? { phone: m[1].trim(), ext: m[2] } : { phone: s, ext: '' };
  }

  // Short label shown next to a phone number: "Office x112", "Mobile", or '' when unknown.
  function phoneLabel(lead) {
    const l = lead || {};
    const type = normalizePhoneType(l.phoneType);
    const ext = String(l.phoneExt || '').replace(/\D/g, '');
    const base = type === 'unknown' ? (ext ? 'Office' : '') : PHONE_TYPE_LABELS[type];
    return ext ? `${base} x${ext}` : base;
  }

  // https://wa.me/<digits>. US 10-digit numbers get a leading 1. '' when the number is unusable.
  function whatsappUrl(phone) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.length === 10) d = '1' + d;
    return d.length >= 11 && d.length <= 15 ? `https://wa.me/${d}` : '';
  }

  // ── Time zones (IST <-> US) ───────────────────────────────────────────────
  // Pure functions on IANA zones via Intl, so daylight saving is automatic. Every function that
  // depends on "now" takes an explicit Date so it can be tested deterministically.
  const TZ = (function () {
    const ZONES = {
      IST: 'Asia/Kolkata', ET: 'America/New_York', CT: 'America/Chicago',
      MT: 'America/Denver', PT: 'America/Los_Angeles'
    };
    const ORDER = ['IST', 'ET', 'CT', 'MT', 'PT'];
    const ALIAS = {
      est: 'ET', edt: 'ET', et: 'ET', eastern: 'ET',
      cst: 'CT', cdt: 'CT', ct: 'CT', central: 'CT',
      mst: 'MT', mdt: 'MT', mt: 'MT', mountain: 'MT',
      pst: 'PT', pdt: 'PT', pt: 'PT', pacific: 'PT'
    };

    const partsFmt = {};
    function partsOf(ms, zone) {
      const f = partsFmt[zone] || (partsFmt[zone] = new Intl.DateTimeFormat('en-US', {
        timeZone: ZONES[zone], hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric'
      }));
      const o = {};
      for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
      if (o.hour === 24) o.hour = 0;
      return o;
    }

    // Zone offset from UTC in minutes at instant `ms`.
    function offsetMinutes(zone, ms) {
      const p = partsOf(ms, zone);
      const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
    }

    // Wall-clock time in `zone` -> UTC ms (re-checks the offset so the DST switch day is right).
    function wallToUtc(y, mo, d, h, mi, zone) {
      const guess = Date.UTC(y, mo - 1, d, h, mi);
      const first = guess - offsetMinutes(zone, guess) * 60000;
      return guess - offsetMinutes(zone, first) * 60000;
    }

    const abbrFmt = {};
    function abbr(zone, date) {
      if (zone === 'IST') return 'IST';
      const f = abbrFmt[zone] || (abbrFmt[zone] = new Intl.DateTimeFormat('en-US', { timeZone: ZONES[zone], timeZoneName: 'short' }));
      const part = f.formatToParts(date).find(p => p.type === 'timeZoneName');
      return part ? part.value : zone;
    }

    // "10 AM", "8:30 PM" (minutes only when non-zero)
    function fmt12(h, m) {
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return `${h12}${m ? ':' + pad2(m) : ''} ${h >= 12 ? 'PM' : 'AM'}`;
    }
    // Clock display always shows minutes: "8:05 PM"
    function fmtClock(h, m) {
      return `${h % 12 === 0 ? 12 : h % 12}:${pad2(m)} ${h >= 12 ? 'PM' : 'AM'}`;
    }

    // [{ key, abbr, time, weekday }] for the clock strip.
    function clocks(date) {
      const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
      return ORDER.map(key => {
        const p = partsOf(date.getTime(), key);
        return {
          key, abbr: abbr(key, date), time: fmtClock(p.hour, p.minute),
          weekday: wd.format(new Date(Date.UTC(p.year, p.month - 1, p.day)))
        };
      });
    }

    // The wall time h:m in `from`, on the calendar day it currently is in `from` (at `date`),
    // shown in zone `to`. dayShift = calendar days between the two results (0, 1 or -1).
    function convert(h, m, from, to, date) {
      const src = partsOf(date.getTime(), from);
      const utc = wallToUtc(src.year, src.month, src.day, h, m, from);
      const t = partsOf(utc, to);
      const dayShift = Math.round((Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(src.year, src.month - 1, src.day)) / 86400000);
      return { hour: t.hour, minute: t.minute, dayShift, label: fmt12(t.hour, t.minute), abbr: abbr(to, new Date(utc)) };
    }

    // Converter for the popup: time in `from` -> every other zone.
    function convertAll(h, m, from, date) {
      return ORDER.filter(k => k !== from).map(to => {
        const r = convert(h, m, from, to, date);
        return { key: to, abbr: r.abbr, time: fmtClock(r.hour, r.minute), dayShift: r.dayShift };
      });
    }

    // ── Finding times in post text ──
    // A time only counts when a US zone follows it: "10 AM EST", "10:30am CST", "9 - 11 AM PT",
    // "14:00 EST", "10 am (CST)", "11AM Eastern". "5+ years", "10 AM" alone and phone numbers never match.
    const ZONE_WORDS = 'EST|EDT|ET|CST|CDT|CT|MST|MDT|MT|PST|PDT|PT|Eastern|Central|Mountain|Pacific';
    const RE_SRC =
      '(?<![\\w:.$+\\-])(\\d{1,2})(?::(\\d{2}))?\\s*(?:([ap])\\.?m(?![a-z])\\.?)?' +
      '(?:\\s*(?:-|\\u2013|\\u2014|to)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(?:([ap])\\.?m(?![a-z])\\.?)?)?' +
      '\\s*\\(?\\s*(' + ZONE_WORDS + ')(?![a-z])';

    // One endpoint: 12-hour needs a meridiem; without one only "HH:MM" (24-hour) counts.
    function endpoint(hStr, mStr, mer) {
      const h = Number(hStr);
      const m = mStr === undefined ? 0 : Number(mStr);
      if (m > 59) return null;
      if (mer) return h >= 1 && h <= 12 ? { h: (h % 12) + (mer === 'p' ? 12 : 0), m } : null;
      return mStr !== undefined && h <= 23 ? { h, m } : null;
    }

    // -> [{ raw, index, zone: 'ET'|'CT'|'MT'|'PT', zoneText, start: {h,m}, end: {h,m}|null }]
    function parseTimes(text) {
      const out = [];
      const s = String(text || '');
      if (!/\d/.test(s)) return out;
      const re = new RegExp(RE_SRC, 'gi');
      let m;
      while ((m = re.exec(s)) && out.length < 4) {
        const [raw, h1, m1, p1raw, h2, m2, p2raw, z] = m;
        const p2 = p2raw && p2raw.toLowerCase();
        let mer1 = p1raw && p1raw.toLowerCase();
        let start;
        let end = null;
        if (h2 !== undefined) {
          end = endpoint(h2, m2, p2);
          if (!end) continue;
          if (!mer1 && p2) {
            // "9 - 11 AM EST": the first time shares the second's AM/PM, unless that runs backwards.
            start = endpoint(h1, m1, p2);
            if (start && start.h * 60 + start.m > end.h * 60 + end.m) start = endpoint(h1, m1, p2 === 'p' ? 'a' : 'p');
          } else {
            start = endpoint(h1, m1, mer1);
          }
        } else {
          start = endpoint(h1, m1, mer1);
        }
        if (!start) continue;
        out.push({ raw: raw.trim(), index: m.index, zone: ALIAS[z.toLowerCase()], zoneText: z.length <= 3 ? z.toUpperCase() : z, start, end });
      }
      return out;
    }

    function shiftNote(n) { return n > 0 ? ' (next day)' : n < 0 ? ' (previous day)' : ''; }

    // "10 AM EST -> 8:30 PM IST" strings for one parsed match, converted for the day it is now in that zone.
    function describe(match, date) {
      const a = convert(match.start.h, match.start.m, match.zone, 'IST', date);
      let src = fmt12(match.start.h, match.start.m);
      let dst = a.label;
      let note = shiftNote(a.dayShift);
      if (match.end) {
        const b = convert(match.end.h, match.end.m, match.zone, 'IST', date);
        src += ' - ' + fmt12(match.end.h, match.end.m);
        // Mark the start too only when the two ends land on different days.
        dst += (a.dayShift !== b.dayShift ? shiftNote(a.dayShift) : '') + ' - ' + b.label;
        note = shiftNote(b.dayShift);
      }
      return {
        from: `${src} ${match.zoneText}`,
        to: `${dst} IST${note}`,
        text: `${src} ${match.zoneText} → ${dst} IST${note}`
      };
    }

    // Convenience: every conversion found in `text` -> [{ from, to, text }]
    function convertText(text, date) {
      return parseTimes(text).map(m => describe(m, date));
    }

    return { ZONES, ORDER, offsetMinutes, abbr, clocks, convert, convertAll, parseTimes, describe, convertText, fmt12 };
  })();

  const VISA_TYPES = ['USC', 'GC', 'GC-EAD', 'H1B', 'H4-EAD', 'L2-EAD', 'OPT', 'CPT', 'STEM OPT', 'TN', 'Other'];

  // ── Dates (local time, YYYY-MM-DD) ───────────────────────────────────────
  function pad2(n) { return String(n).padStart(2, '0'); }

  function todayStr(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function addDays(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return todayStr(new Date(y, m - 1, d + days));
  }

  // A plan date for people: '2026-12-01' -> '1 Dec 2026'. Every place that shows a plan's end date (popup, account page, dashboard)
  // uses this, so they read the same. Anything that is not YYYY-MM-DD is returned as it is.
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function planDate(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m || !MONTHS_SHORT[Number(m[2]) - 1]) return String(dateStr || '');
    return `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1]} ${m[1]}`;
  }

  function daysUntil(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const target = new Date(y, m - 1, d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((target - today) / 86400000);
  }


  // ── Consultant profile: work authorisation, minimum rate, availability, bench status (staffing P1) ───────────────────────────────
  // The extension and the team web app use these same rules (the web app has ES-module twins in webapp/js/consultant-profile.js, held
  // equal by webapp/tests/consultant-profile.test.mjs; the server backfill is public.bp_consultant_visa_type, migration 0045).
  // Only the work-authorisation TYPE and END DATE are kept: never a document, a number or a copy of a card.
  const DAY_MS_P1 = 86400000;
  const isIsoDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s));
  // Whole days from one 'YYYY-MM-DD' to another (b - a), by the calendar, never by the clock.
  function dayDiff(a, b) {
    const [y1, m1, d1] = a.split('-').map(Number);
    const [y2, m2, d2] = b.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS_P1);
  }

  // Free text -> one VISA_TYPES code ('' when empty). Reads the text like the requirement tags (migration 0026, the "no / not / except"
  // guard included) and keeps the first code in list order, so "USC/GC" is USC and "GC EAD" is GC-EAD (not GC). Text that names no
  // known type, or only a bare "EAD", is 'Other'.
  const VISA_CODE_ORDER = ['USC', 'GC', 'GC-EAD', 'H1B', 'H4-EAD', 'L2-EAD', 'OPT', 'STEM OPT', 'CPT', 'TN', 'EAD'];
  function visaCodesIn(text) {
    let v = String(text == null ? '' : text).toLowerCase();
    if (/\b(?:no|not|except|excluding|without|nor)\b/.test(v)) return [];
    const out = [];
    if (/\busc\b|\bus\s*citizens?\b|\bcitizens?\b/.test(v)) out.push('USC');
    const take = (re, code) => { if (re.test(v)) { out.push(code); v = v.replace(new RegExp(re.source, 'g'), ' '); } };
    take(/\bgc[\s-]*ead\b/, 'GC-EAD');
    take(/\bh-?4[\s-]*ead\b/, 'H4-EAD');
    take(/\bl-?2[\s-]*ead\b/, 'L2-EAD');
    take(/\bstem[\s-]*opt\b/, 'STEM OPT');
    if (/\bgc\b|\bgreen\s*cards?\b/.test(v)) out.push('GC');
    if (/\bh-?1-?b\b/.test(v)) out.push('H1B');
    if (/\bopt\b/.test(v)) out.push('OPT');
    if (/\bcpt\b/.test(v)) out.push('CPT');
    if (/\btn\b/.test(v)) out.push('TN');
    if (/\bead\b/.test(v)) out.push('EAD');
    return VISA_CODE_ORDER.filter(c => out.includes(c));
  }
  function normalizeVisa(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return '';
    const exact = VISA_TYPES.find(t => t.toLowerCase() === s.toLowerCase());
    if (exact) return exact;
    return visaCodesIn(s).filter(c => c !== 'EAD')[0] || 'Other';
  }
  // The consultant's work-authorisation type: the saved visaType, else read from the older free-text visa ('' when neither).
  function consultantVisaType(c) {
    const x = c || {};
    return VISA_TYPES.includes(x.visaType) ? x.visaType : normalizeVisa(x.visa);
  }

  // What a pitch, a template or the hotlist prints for the visa: the type, or nothing for 'Other' / unknown (the free-text note and the
  // end date are never printed).
  function visaLabel(c) {
    const t = consultantVisaType(c);
    return t === 'Other' ? '' : t;
  }

  // Reminders before the work authorisation ends, in days, and on the day itself (0). An end date in the past stays on the list.
  const WORK_AUTH_STEPS = [120, 90, 60, 30, 7, 0];
  // until, today: 'YYYY-MM-DD'. -> null (no date, or more than 120 days away) or { days, step, expired, label }. step is the reminder
  // the date has reached (120, 90, 60, 30, 7 or 0), so a reminder ticked off at one step comes back at the next.
  function workAuthAlert(until, today) {
    if (!isIsoDay(until) || !isIsoDay(today)) return null;
    const days = dayDiff(today, until);
    if (days > WORK_AUTH_STEPS[0]) return null;
    const step = days <= 0 ? 0 : WORK_AUTH_STEPS.filter(s => s >= days).pop();
    const label = days < 0 ? `Ended ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'Ends today' : `Ends in ${days} day${days === 1 ? '' : 's'}`;
    return { days, step, expired: days < 0, label };
  }
  // Consultants still on the bench (not placed, not inactive) whose work authorisation ends within `within` days (default 120), soonest
  // first. -> [{ id, name, visaType, until, days, step, expired, label }]
  function expiringWorkAuth(consultants, today, within) {
    const max = Number.isFinite(within) ? within : WORK_AUTH_STEPS[0];
    const out = [];
    for (const c of Array.isArray(consultants) ? consultants : []) {
      if (!c || !onBench(c)) continue;
      const a = workAuthAlert(c.workAuthUntil, today);
      if (!a || a.days > max) continue;
      out.push({ id: c.id, name: c.name || '', visaType: consultantVisaType(c), until: c.workAuthUntil, ...a });
    }
    return out.sort((a, b) => a.days - b.days || String(a.name).localeCompare(String(b.name)));
  }

  // Minimum rate: a number and a unit (per hour unless chosen). Other units become an hourly figure only to warn (8 h a day, 2080 a year).
  const RATE_UNITS = ['hr', 'day', 'month', 'year'];
  const RATE_UNIT_LABELS = { hr: 'per hour', day: 'per day', month: 'per month', year: 'per year' };
  const HOURS_PER = { hr: 1, day: 8, month: 2080 / 12, year: 2080 };
  function normalizeRateUnit(u) { return RATE_UNITS.includes(u) ? u : 'hr'; }
  // A clean minimum: a positive number under 10 million, two decimals, else null.
  function cleanRateMin(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
  }
  function rateMinHourly(c) {
    const n = cleanRateMin(c && c.rateMin);
    return n === null ? null : Math.round((n / HOURS_PER[normalizeRateUnit(c.rateUnit)]) * 100) / 100;
  }
  function rateMinText(c) {
    const n = cleanRateMin(c && c.rateMin);
    if (n === null) return '';
    return '$' + n.toLocaleString('en-US') + '/' + normalizeRateUnit(c.rateUnit);
  }
  // The asked rate (text, or a number per hour) against the consultant's minimum. -> null, or { min, ask } (per hour) when below it.
  function belowRateMin(ask, c) {
    const a = typeof ask === 'number' ? ask : parseRate(ask);
    const min = rateMinHourly(c);
    return a !== null && a > 0 && min !== null && a < min ? { min, ask: a } : null;
  }

  // Bench status: the same five as the team web app. Only Marketing and In interview are matched and go on the hotlist.
  const BENCH_STATUS = ['marketing', 'interviewing', 'on_hold', 'placed', 'inactive'];
  const BENCH_STATUS_LABELS = { marketing: 'Marketing', interviewing: 'In interview', on_hold: 'On hold', placed: 'Placed', inactive: 'Inactive' };
  const MATCH_BENCH_STATUS = ['marketing', 'interviewing'];
  // A record without benchStatus (saved before schema 14) reads from its old Active switch.
  function benchStatusOf(c) {
    const x = c || {};
    if (BENCH_STATUS.includes(x.benchStatus)) return x.benchStatus;
    return x.active === false ? 'inactive' : 'marketing';
  }
  function onBench(c) { return ['marketing', 'interviewing', 'on_hold'].includes(benchStatusOf(c)); }

  // Availability: availableOn 'YYYY-MM-DD' -> 'now' (today or earlier), 'soon' (within AVAILABLE_SOON_DAYS), 'later', 'unknown' (no date).
  // A consultant who is free only later is held out of matching and the hotlist until the date comes near.
  const AVAILABLE_SOON_DAYS = 30;
  function availabilityOf(c, today) {
    const on = c && c.availableOn;
    if (!isIsoDay(on) || !isIsoDay(today)) return { state: 'unknown', days: null };
    const days = dayDiff(today, on);
    return { state: days <= 0 ? 'now' : days <= AVAILABLE_SOON_DAYS ? 'soon' : 'later', days: Math.max(0, days) };
  }
  // "Available now" / "Available from 21 Nov" / '' (no date).
  function availabilityText(c, today) {
    const a = availabilityOf(c, today);
    if (a.state === 'unknown') return '';
    if (a.state === 'now') return 'Available now';
    const [, m, d] = c.availableOn.split('-').map(Number);
    return `Available from ${d} ${MONTHS_SHORT[m - 1]}`;
  }
  // The one "can this consultant be pitched now?" rule: Marketing or In interview, and free now or within AVAILABLE_SOON_DAYS.
  // nowOrToday: ms or 'YYYY-MM-DD' (default: now).
  function isMatchable(c, nowOrToday) {
    if (!c || typeof c !== 'object' || !MATCH_BENCH_STATUS.includes(benchStatusOf(c))) return false;
    const today = isIsoDay(nowOrToday) ? nowOrToday : todayStr(Number.isFinite(nowOrToday) ? new Date(nowOrToday) : new Date());
    return availabilityOf(c, today).state !== 'later';
  }
  // Older free-text availability -> a date when it reads clearly ('Immediate', '2 weeks', '30 days', '1 month', '2026-12-01'); else ''.
  function availableOnFromText(text, today) {
    const s = String(text == null ? '' : text).trim().toLowerCase();
    if (!s || !isIsoDay(today)) return '';
    if (/^(?:available\s+)?(?:immediate(?:ly)?|now|asap|right away)\b/.test(s)) return today;
    if (isIsoDay(s)) return s;
    const m = /^(?:available\s+)?(?:in\s+)?(\d{1,3})\s*(days?|weeks?|wks?|months?)\b/.exec(s);
    if (!m) return '';
    const n = Number(m[1]);
    const days = /^d/.test(m[2]) ? n : /^w/.test(m[2]) ? n * 7 : n * 30;
    return days > 0 && days <= 365 ? addDays(today, days) : '';
  }

  // ── Person names ──────────────────────────────────────────────────────────
  // ── Display titles ────────────────────────────────────────────────────────────────────────────────────
  // Recruiters type "SENIOR DATA ENGINEER". For DISPLAY only (never stored): a title that is mostly upper-case becomes Title Case, keeping
  // known acronyms and tech names as written (AWS, SQL, .NET, DevOps, PL/SQL ...) and "Sr." / "Jr.". Mixed-case titles are left untouched.
  const TITLE_KEEP = ['AI', 'ML', 'AI/ML', 'SRE', 'AWS', 'GCP', 'SQL', 'ETL', 'ELT', 'UI', 'UX', 'QA', 'SAP', 'BI', 'API', 'IT', '.NET', 'C#', 'C++', 'iOS',
    'DevOps', 'J2EE', 'SDET', 'PL/SQL', 'CI/CD', 'ERP', 'CRM', 'HR', 'PM', 'BA', 'GenAI', 'LLM', 'NLP', 'MLOps', 'DBA', 'OCI', 'SFDC', 'SSIS', 'SSRS', 'ADF',
    // Common in US IT staffing titles
    'ABAP', 'HANA', 'BW', 'FICO', 'MDM', 'IAM', 'SOC', 'SIEM', 'SSO', 'EDI', 'HL7', 'FHIR', 'EHR', 'QE', 'TPM', 'BSA', 'PMO', 'RPA',
    'SQA', 'UAT', 'ITSM', 'SCCM', 'MDX', 'BIM', 'GIS', 'SDE', 'SWE', 'VP', 'CTO', 'CIO', 'IoT', 'AR/VR', 'SaaS', 'PaaS', 'IaaS', 'B2B',
    'MS', 'SQL/BI', 'ETL/ELT', 'HCM', 'SCM', 'OIC', 'OTM', 'EBS', 'JD', 'SAFe', 'GxP', 'CSV', 'NOC', 'WMS', 'POS', 'ADO', 'AEM', 'MuleSoft',
    'ServiceNow', 'Salesforce', 'PowerBI', 'Power BI', 'iPaaS', 'TIBCO', 'COBOL', 'JCL', 'DB2', 'CICS', 'IMS', 'VMware', 'Linux', 'UNIX',
    'Sr.', 'Jr.', 'Sr', 'Jr'];
  const TITLE_KEEP_MAP = Object.fromEntries(TITLE_KEEP.map(k => [k.toLowerCase(), k]));
  const TITLE_SMALL = new Set(['and', 'or', 'of', 'for', 'with', 'in', 'the', 'to', 'a', 'an', 'at', 'on']);
  function titleWord(core, first) {
    const lower = core.toLowerCase();
    if (TITLE_KEEP_MAP[lower]) return TITLE_KEEP_MAP[lower];
    if (/\d/.test(core) && /^[A-Z0-9#+.]+$/.test(core)) return core;   // W2, C2C, H1B, J2EE-like codes
    if (!first && TITLE_SMALL.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  function displayTitle(raw) {
    const s = raw === null || raw === undefined ? '' : String(raw);
    const letters = s.replace(/[^A-Za-z]/g, '');
    if (letters.length < 3) return s;
    const upper = letters.replace(/[^A-Z]/g, '').length;
    if (upper / letters.length < 0.7) return s;
    let first = true;
    return s.replace(/[^\s]+/g, (token) => {
      const m = /^([^A-Za-z0-9.#+]*)(.*?)([^A-Za-z0-9#+]*)$/.exec(token);
      const lead = m[1], core = m[2], tail = m[3];
      if (!core) return token;
      let out;
      if (TITLE_KEEP_MAP[core.toLowerCase()]) out = TITLE_KEEP_MAP[core.toLowerCase()];
      else if (/[\/\-]/.test(core)) out = core.split(/([\/\-])/).map(p => (/^[\/\-]$/.test(p) || !p ? p : titleWord(p, first))).join('');
      else out = titleWord(core, first);
      first = false;
      return lead + out + tail;
    });
  }

  // LinkedIn appends the connection degree, pronouns and badges to names ("Bhuvana Ramarao 2nd",
  // "Priya S (She/Her)", "Ravi K • 3rd+ • Following"). Returns just the person's name.
  // Display only: the scanner stores 'Recruiter Lead' / 'Staffing Partner' when a post shows no name or company. Those words must
  // never read as a real person or company, so screens show these plain phrases instead. The stored value is not changed.
  // `fallback` (for example the email) is used only when the name is truly empty; the stored placeholder always reads "Name not shown".
  function shownRecruiterName(raw, fallback) {
    const n = cleanPersonName(raw);
    if (n === 'Recruiter Lead') return 'Name not shown';
    return n || fallback || 'Name not shown';
  }
  function shownCompanyName(raw) {
    const c = String(raw === null || raw === undefined ? '' : raw).trim();
    return !c || c === '\u2014' || c === 'Staffing Partner' ? 'Company not shown' : c;
  }
  function cleanPersonName(raw) {
    let n = String(raw === null || raw === undefined ? '' : raw).split('\n')[0];
    n = n.replace(/\s*\((?:he|she|they|him|her|them|xe|ze)\b[^)]*\)/gi, '');
    n = n.replace(/\s*(?:View profile.*|Premium|Influencer)$/i, '');
    for (let i = 0; i < 4; i++) {
      const before = n;
      n = n
        .replace(/\s*[•·|]\s*(?:following|follow|you|premium|verified|influencer)\s*$/i, '')
        .replace(/(?:\s*[•·|,]\s*|\s+)(?:1st|2nd|3rd)\+?(?:\s+degree(?:\s+connection)?)?\s*$/i, '');
      if (n === before) break;
    }
    return n.replace(/^[•·\-\s]+/, '').replace(/\s+/g, ' ').trim();
  }

  // ── Emails ────────────────────────────────────────────────────────────────
  // Lowercased address, or '' when it is not a usable email (same rule the service worker applies).
  function normalizeEmail(value) {
    const e = String(value || '').trim().replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : '';
  }

  // ── Duplicate leads ───────────────────────────────────────────────────────
  // LinkedIn renders the same post in several places (feed, profile Activity carousel, featured) and the
  // text it shows can be clipped or run together, so one address can be found as "john@x.co",
  // "john@x.com" and "john@x.comlocation", or with a phone number glued on the front.
  const KNOWN_TLDS = new Set(['com', 'net', 'org', 'io', 'co', 'us', 'in', 'ai', 'info', 'biz', 'edu', 'gov',
    'dev', 'tech', 'app', 'cloud', 'solutions', 'group', 'llc', 'inc']);

  function normText(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Stable identity of the post a lead came from: its URN when known, else requirement text on that page.
  function leadPostKey(lead) {
    const l = lead || {};
    if (l.postUrn) return 'u:' + l.postUrn;
    const req = normText(l.requirement);
    return req ? 'r:' + req + '|' + String(l.sourceUrl || '') : '';
  }

  // Given two different addresses from the same post, returns the one that is a damaged copy of the other
  // (the one to drop), or '' when they look like two real addresses.
  function damagedEmailOf(a, b) {
    const ia = a.lastIndexOf('@'), ib = b.lastIndexOf('@');
    const la = a.slice(0, ia), da = a.slice(ia + 1);
    const lb = b.slice(0, ib), db = b.slice(ib + 1);
    if (da === db) {
      // Digits or punctuation glued on the front: "5551234567john@x.com"
      const [longer, shorter] = la.length > lb.length ? [la, lb] : [lb, la];
      if (longer !== shorter && longer.endsWith(shorter) && /^[\d\-+._()/=]+$/.test(longer.slice(0, longer.length - shorter.length))) {
        return la.length > lb.length ? a : b;
      }
      return '';
    }
    if (la !== lb) return '';
    // Clipped or run-together domain: "x.co" / "x.com" / "x.comlocation" (only letters differ)
    const [longer, shorter] = da.length > db.length ? [da, db] : [db, da];
    if (!longer.startsWith(shorter) || !/^[a-z]+$/.test(longer.slice(shorter.length))) return '';
    const known = (d) => KNOWN_TLDS.has(d.split('.').pop());
    const keep = known(longer) ? longer : shorter;
    return keep === da ? b : a;
  }

  // One lead per address and per damaged copy of it. First occurrence wins; order is kept.
  // ── Per-post lead identity (page scanner + save) ──────────────────────────
  // One lead per (address, post): the same recruiter posting three requirements gives three page leads.
  function textHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function pageLeadKey(email, postUrn, postText) {
    const e = String(email || '').trim().toLowerCase();
    if (postUrn) return e + '|u:' + postUrn;
    const t = normText(postText).slice(0, 200);
    return e + '|' + (t ? 't:' + textHash(t) : '');
  }

  // A page lead is "rich" once role, location and posted time are all known: nothing more to learn from re-reading it.
  function isRichLead(lead) {
    if (!lead) return false;
    return ['requirement', 'location', 'postedAt'].every(k => !cleanupIsEmpty(lead[k]));
  }

  // The same post seen again: keep what we had, fill only what was empty.
  function mergeRicherLead(oldLead, newLead) {
    const out = Object.assign({}, oldLead);
    for (const k of Object.keys(newLead || {})) {
      if (cleanupIsEmpty(out[k]) && !cleanupIsEmpty(newLead[k])) out[k] = newLead[k];
    }
    return out;
  }

  // Storage holds one record per address. When several requirements from one address arrive in a single save,
  // keep the newest (by posted time, later in the list on a tie) and, on equal time, the one with more filled fields.
  function collapseLeadsByEmail(leads) {
    const best = new Map();
    const order = [];
    const richness = (l) => ['requirement', 'location', 'notes', 'phone', 'recruiterName', 'companyName'].filter(k => !cleanupIsEmpty(l[k])).length;
    const when = (l) => { const t = Date.parse(l.postedAt || ''); return Number.isFinite(t) ? t : 0; };
    for (const lead of leads || []) {
      const e = normalizeEmail(lead && lead.email);
      if (!e) { order.push(lead); continue; }
      if (!best.has(e)) { best.set(e, lead); order.push(e); continue; }
      const cur = best.get(e);
      const a = when(lead), b = when(cur);
      if (a > b || (a === b && richness(lead) >= richness(cur))) best.set(e, lead);
    }
    return order.map(x => (typeof x === 'string' ? best.get(x) : x));
  }

  // A recruiter's second requirement (a different post) is kept: the identity is address + post.
  function dedupeLeads(leads) {
    const byKey = new Map();   // 'email|postKey' -> { e, lead }
    for (const lead of leads || []) {
      const e = normalizeEmail(lead && lead.email);
      if (!e) continue;
      const k = e + '|' + leadPostKey(lead);
      if (!byKey.has(k)) byKey.set(k, { e, lead });
    }
    const groups = new Map();
    for (const { e, lead } of byKey.values()) {
      const key = leadPostKey(lead);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(e);
    }
    const drop = new Set();   // 'email|postKey'
    for (const [key, set] of groups) {
      const emails = [...set];
      for (let i = 0; i < emails.length; i++) {
        for (let j = i + 1; j < emails.length; j++) {
          if (drop.has(emails[i] + '|' + key) || drop.has(emails[j] + '|' + key)) continue;
          const bad = damagedEmailOf(emails[i], emails[j]);
          if (bad) drop.add(bad + '|' + key);
        }
      }
    }
    return [...byKey].filter(([k]) => !drop.has(k)).map(([, v]) => v.lead);
  }

  // ── Database cleanup (v1.5): duplicates, missing data ─────────────────────
  // Pure helpers behind the dashboard's Cleanup view. Nothing here touches storage; the service worker
  // applies merges (MERGE_LEADS) and the dashboard only displays results. Detection is bucket/lookup based
  // (union-find over hash maps), so 5,000 leads take a few milliseconds, never an all-pairs scan.
  const CLEANUP_PLACEHOLDERS = new Set(['', '—', 'Staffing Partner']);
  const CLEANUP_MAX_SHARED_PHONE = 40; // a number on more leads than this is a switchboard, not a person

  function cleanupIsEmpty(v) {
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'string') return CLEANUP_PLACEHOLDERS.has(v.trim());
    return false;
  }

  // Normalised person name ("Priya  Shah 2nd" -> "priya shah"), or '' when it is under two words
  // (a first name alone is too weak to call two leads the same person).
  function cleanupNameKey(lead) {
    const n = normText(cleanPersonName(lead && lead.recruiterName));
    return n.split(' ').filter(Boolean).length >= 2 ? n : '';
  }

  // Last 10 digits of a phone number, or '' when it has fewer than 10 digits.
  function cleanupPhoneKey(phone) {
    const d = String(phone || '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : '';
  }

  function cleanupProfileKey(lead) {
    const u = canonicalProfileUrl(lead && lead.linkedinProfile);
    return u ? u.toLowerCase() : '';
  }

  // Two names are compatible for the shared-phone rule unless both are known and clearly differ.
  function cleanupNamesCompatible(a, b) {
    if (!a || !b) return true;
    if (a === b) return true;
    return a.split(' ').pop() === b.split(' ').pop();
  }

  // Stable identity of a group of leads: their lower-case emails, sorted. A dismissed group stays hidden
  // until its membership changes.
  function duplicateSignature(emails) {
    return (emails || []).map(e => String(e || '').toLowerCase()).sort().join('|');
  }

  // Groups of leads that are probably one person. Returns
  //   [{ signature, emails: [...], leads: [...], reasons: [string] }]
  // largest group first. `dismissed` is an array/Set of signatures the user marked "Not duplicates".
  // Rules (any one links two leads): same name + same company; one email a damaged copy of another;
  // same LinkedIn profile; same phone (10+ digits) with names that do not clearly differ.
  function findDuplicateGroups(leads, dismissed) {
    const list = [], emails = [];
    for (const l of Array.isArray(leads) ? leads : []) {
      const e = l ? normalizeEmail(l.email) : '';
      if (e) { list.push(l); emails.push(e); }
    }
    const skip = dismissed instanceof Set ? dismissed : new Set(dismissed || []);
    const n = list.length;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const edges = []; // [i, j, reason]
    const link = (i, j, reason) => {
      if (i === j) return;
      edges.push([i, j, reason]);
      const a = find(i), b = find(j);
      if (a !== b) parent[b] = a;
    };
    const bucket = (map, key, i) => { const b = map.get(key); if (b) b.push(i); else map.set(key, [i]); };

    const byEmail = new Map();
    emails.forEach((e, i) => { if (!byEmail.has(e)) byEmail.set(e, i); });

    const byNameCo = new Map(), byProfile = new Map(), byPhone = new Map();
    for (let i = 0; i < n; i++) {
      const l = list[i];
      const nk = cleanupNameKey(l);
      if (nk && l.companyId) bucket(byNameCo, nk + '|' + l.companyId, i);
      const pk = cleanupProfileKey(l);
      if (pk) bucket(byProfile, pk, i);
      const ph = cleanupPhoneKey(l.phone);
      if (ph) bucket(byPhone, ph, i);
    }
    // Rule 1: same name + same company. Rule 3: same LinkedIn profile.
    for (const ids of byNameCo.values()) for (let k = 1; k < ids.length; k++) link(ids[0], ids[k], 'Same name at the same company');
    for (const ids of byProfile.values()) for (let k = 1; k < ids.length; k++) link(ids[0], ids[k], 'Same LinkedIn profile');
    // Rule 4: same phone, unless both leads carry clearly different names.
    for (const ids of byPhone.values()) {
      if (ids.length > CLEANUP_MAX_SHARED_PHONE) continue;
      for (let k = 1; k < ids.length; k++) {
        const nk = cleanupNameKey(list[ids[k]]);
        for (let m = 0; m < k; m++) {
          if (cleanupNamesCompatible(nk, cleanupNameKey(list[ids[m]]))) { link(ids[m], ids[k], 'Same phone number'); break; }
        }
      }
    }
    // Rule 2: damaged email copies, found by looking up the clean address a damaged one could come from.
    for (let i = 0; i < n; i++) {
      const e = emails[i];
      const at = e.lastIndexOf('@');
      const local = e.slice(0, at), domain = e.slice(at + 1);
      const candidates = [];
      // glued-on prefix: "5551234567john@x.com" -> "john@x.com"
      const glued = /^[\d\-+._()/=]+/.exec(local);
      if (glued) for (let k = 1; k <= glued[0].length && k < local.length; k++) candidates.push(local.slice(k) + '@' + domain);
      // run-together or clipped domain: "john@x.comlocation" -> "john@x.com"
      for (let k = 3; k < domain.length; k++) candidates.push(local + '@' + domain.slice(0, k));
      // The reverse direction is found when the longer (damaged) address is the one being visited.
      for (const c of candidates) {
        const j = byEmail.get(c);
        if (j !== undefined && j !== i && damagedEmailOf(e, c)) link(i, j, 'One email looks like a damaged copy of the other');
      }
    }

    const comps = new Map();
    for (let i = 0; i < n; i++) bucket(comps, find(i), i);
    const reasonsOf = new Map();
    for (const [i, , why] of edges) {
      const r = find(i);
      const s = reasonsOf.get(r);
      if (s) s.add(why); else reasonsOf.set(r, new Set([why]));
    }
    const out = [];
    for (const [r, ids] of comps) {
      if (ids.length < 2) continue;
      const groupEmails = ids.map(i => emails[i]);
      const signature = duplicateSignature(groupEmails);
      if (skip.has(signature)) continue;
      out.push({ signature, emails: groupEmails, leads: ids.map(i => list[i]), reasons: [...(reasonsOf.get(r) || [])] });
    }
    out.sort((a, b) => b.emails.length - a.emails.length || (a.signature < b.signature ? -1 : 1));
    return out;
  }

  // The record a merge keeps by default: the one with the most filled-in fields; ties go to the earliest saved. One rule for Fix my
  // data (dashboard/views/cleanup.js) and the Vendor Book's batch "Merge safe ones" (the worker).
  const CLEANUP_KEEP_FIELDS = ['recruiterName', 'companyName', 'designation', 'phone', 'location', 'linkedinProfile',
    'requirement', 'technologies', 'notes'];
  function defaultKeepEmail(group) {
    const leads = (group && Array.isArray(group.leads) ? group.leads : []).filter(Boolean);
    if (!leads.length) return '';
    const score = (l) => CLEANUP_KEEP_FIELDS.filter(f => l[f] && String(l[f]).trim() && l[f] !== '—').length;
    const ranked = leads.slice().sort((a, b) =>
      score(b) - score(a) || String(a.savedAt || '9999').localeCompare(String(b.savedAt || '9999')));
    return normalizeEmail(ranked[0].email);
  }

  // Merges duplicate records into `keep` and returns the single resulting lead (inputs are not changed).
  //   - the kept record's non-empty fields win; empty ones are filled from `others`, in order
  //   - phone type and extension travel with the phone number they describe
  //   - notes are joined with a separator (a note already contained is not repeated)
  //   - activity timelines are combined, de-duplicated, sorted oldest to newest, last 50 kept
  //   - savedAt is the earliest; lastContactDate the latest; status the most advanced in STATUSES
  //   - followUpDate: the kept record's, else the soonest of the others
  // `now` (ISO string) stamps the audit entry added to the activity timeline.
  const CLEANUP_NOTES_SEPARATOR = '\n---\n';
  const CLEANUP_SPECIAL_FIELDS = new Set(['email', 'activity', 'notes', 'status', 'savedAt', 'bounced', 'sno',
    'companyId', 'phone', 'phoneType', 'phoneExt', 'followUpDate', 'lastContactDate']);

  // Undo of the last duplicate merge. snapshot = { keep (record before the merge), merged (record the merge
  // wrote), others (deleted records) }. Re-adds deleted records whose email is free again; restores the kept
  // record only if nobody changed it since the merge (otherwise the user's later edits win and it stays as is).
  // Returns { allLeads, restored, keptRestored }.
  function undoLeadMerge(allLeads, snapshot) {
    const leads = Array.isArray(allLeads) ? allLeads.slice() : [];
    if (!snapshot || !snapshot.keep || !Array.isArray(snapshot.others)) return { allLeads: leads, restored: 0, keptRestored: false };
    const key = (l) => String((l && l.email) || '').toLowerCase();
    let keptRestored = false;
    const ki = leads.findIndex(l => key(l) === key(snapshot.keep));
    if (ki !== -1 && JSON.stringify(leads[ki]) === JSON.stringify(snapshot.merged)) {
      leads[ki] = snapshot.keep;
      keptRestored = true;
    }
    const present = new Set(leads.map(key));
    let restored = 0;
    for (const o of snapshot.others) {
      if (!o || present.has(key(o))) continue;
      leads.push(o);
      present.add(key(o));
      restored++;
    }
    return { allLeads: leads, restored, keptRestored };
  }

  function mergeLeadRecords(keep, others, now) {
    const rest = (others || []).filter(Boolean);
    const all = [keep, ...rest];
    const out = { ...keep };

    for (const o of rest) {
      for (const k of Object.keys(o)) {
        if (CLEANUP_SPECIAL_FIELDS.has(k)) continue;
        if (cleanupIsEmpty(out[k]) && !cleanupIsEmpty(o[k])) out[k] = o[k];
      }
    }
    if (cleanupIsEmpty(out.phone)) {
      const src = rest.find(o => !cleanupIsEmpty(o.phone));
      if (src) {
        out.phone = src.phone;
        if (src.phoneType !== undefined) out.phoneType = src.phoneType;
        if (src.phoneExt !== undefined) out.phoneExt = src.phoneExt;
      }
    }
    if (out.companyId === undefined || out.companyId === null) {
      const src = rest.find(o => o.companyId);
      if (src) out.companyId = src.companyId;
    }

    const notes = [];
    for (const l of all) {
      const t = String(l.notes || '').trim();
      if (t && !notes.some(x => x.includes(t))) notes.push(t);
    }
    out.notes = notes.join(CLEANUP_NOTES_SEPARATOR);

    const seen = new Set();
    const activity = [];
    for (const l of all) {
      for (const a of Array.isArray(l.activity) ? l.activity : []) {
        const sig = (a.at || '') + '|' + (a.type || '') + '|' + (a.text || '');
        if (!seen.has(sig)) { seen.add(sig); activity.push(a); }
      }
    }
    if (rest.length) {
      activity.push({
        at: now || new Date().toISOString(), type: 'note',
        text: `Merged ${rest.length} duplicate record${rest.length === 1 ? '' : 's'} (${rest.map(o => o.email).join(', ')})`.slice(0, 200)
      });
    }
    const time = (a) => { const t = Date.parse(a.at); return isNaN(t) ? 0 : t; };
    activity.sort((a, b) => time(a) - time(b)); // stable: equal times keep their input order
    out.activity = activity.slice(-50);

    const saved = all.map(l => l.savedAt).filter(s => typeof s === 'string' && !isNaN(Date.parse(s)));
    if (saved.length) out.savedAt = saved.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));

    out.status = STATUSES[Math.max(...all.map(l => STATUSES.indexOf(normalizeStatus(l.status))))];

    const contacts = all.map(l => l.lastContactDate).filter(Boolean).sort();
    if (contacts.length) out.lastContactDate = contacts[contacts.length - 1];
    if (!out.followUpDate) {
      const fu = rest.map(o => o.followUpDate).filter(Boolean).sort()[0];
      if (fu) out.followUpDate = fu;
    }
    return out;
  }

  // The "missing data" filters; `key` is also what the Leads view filters by.
  const MISSING_FIELDS = [
    { key: 'noPhone', label: 'No phone', test: l => cleanupIsEmpty(l.phone) },
    { key: 'noCompany', label: 'No company', test: l => !l.companyId },
    { key: 'noDesignation', label: 'No designation', test: l => cleanupIsEmpty(l.designation) },
    { key: 'noLinkedin', label: 'No LinkedIn profile', test: l => !safeHttpUrl(l.linkedinProfile) },
    { key: 'noLocation', label: 'No location', test: l => cleanupIsEmpty(l.location) }
  ];
  function missingDataCounts(leads) {
    const counts = {};
    for (const f of MISSING_FIELDS) counts[f.key] = 0;
    for (const l of Array.isArray(leads) ? leads : []) {
      if (l) for (const f of MISSING_FIELDS) if (f.test(l)) counts[f.key]++;
    }
    return counts;
  }
  function leadMissing(lead, key) {
    const f = MISSING_FIELDS.find(x => x.key === key);
    return Boolean(f && lead && f.test(lead));
  }

  // ── LinkedIn profile parsing (pure text helpers; the DOM reading lives in content.js) ──
  function cleanLines(lines) {
    const out = [];
    for (const raw of lines || []) {
      const l = String(raw === null || raw === undefined ? '' : raw).replace(/\s+/g, ' ').trim();
      if (l && l !== out[out.length - 1]) out.push(l);
    }
    return out;
  }

  function profileSlugFromPath(pathname) {
    const m = String(pathname || '').match(/^\/in\/([^/?#]+)/i);
    if (!m) return '';
    let s = m[1];
    try { s = decodeURIComponent(s); } catch (_) {}
    s = s.toLowerCase();
    return s === 'me' ? '' : s;
  }

  // https://www.linkedin.com/in/<slug>/ for any linkedin.com profile URL (sub-pages, overlays, tracking params), else ''.
  function canonicalProfileUrl(href) {
    try {
      const u = new URL(href, 'https://www.linkedin.com');
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return '';
      const m = u.pathname.match(/^\/in\/([^/?#]+)/i);
      return m ? `https://www.linkedin.com/in/${m[1]}/` : '';
    } catch (_) {
      return '';
    }
  }

  // "1 yr 7 mos" / "8 months" / "2 years" -> months, or null when there is no duration in the text.
  function parseDurationMonths(text) {
    const s = String(text || '');
    const y = s.match(/(\d+)\s*(?:yrs?|years?)\b/i);
    const m = s.match(/(\d+)\s*(?:mos?|months?)\b/i);
    if (!y && !m) return /less than a year/i.test(s) ? 0 : null;
    return (y ? Number(y[1]) * 12 : 0) + (m ? Number(m[1]) : 0);
  }

  // 19 -> "1 yr 7 mos" (LinkedIn's own wording); 0 or invalid -> ''.
  function formatTenure(months) {
    if (!Number.isFinite(months) || months <= 0) return '';
    const y = Math.floor(months / 12);
    const m = months % 12;
    const parts = [];
    if (y) parts.push(`${y} ${y === 1 ? 'yr' : 'yrs'}`);
    if (m) parts.push(`${m} ${m === 1 ? 'mo' : 'mos'}`);
    return parts.join(' ');
  }

  // "2nd", "· 3rd+", "Priya 1st degree connection" -> '1st' | '2nd' | '3rd'; '' when there is no degree marker.
  function parseConnectionDegree(text) {
    const m = String(text || '').match(/(?:^|[\s·•(])(1st|2nd|3rd)\+?(?=$|[\s·•)])/i);
    return m ? m[1].toLowerCase() : '';
  }
  function degreeToken(line) {
    const m = String(line || '').match(/^[·•\s]*(1st|2nd|3rd)\+?(?:\s+degree(?:\s+connection)?)?[·•\s]*$/i);
    return m ? m[1].toLowerCase() : '';
  }

  // Name from the tab title: "(3) Priya Sharma - Sr Recruiter - Acme | LinkedIn" -> "Priya Sharma".
  function nameFromPageTitle(title) {
    const t = String(title || '').replace(/^\(\d+\+?\)\s*/, '').replace(/\s*[|·]\s*LinkedIn\s*$/i, '');
    const n = cleanPersonName(t.split(/\s+[-–—]\s+/)[0]);
    return n.length <= 80 ? n : '';
  }

  // "Current company: Refocus LLC. Click to skip to experience card" -> "Refocus LLC"
  function parseCurrentCompanyLabel(label) {
    if (!/^current company:/i.test(String(label || ''))) return '';
    return String(label).replace(/^current company:\s*/i, '').replace(/\.?\s*click to.*$/i, '').trim();
  }

  // Top-card entries [{ text, href, label }] -> current company name, or ''.
  // Order: aria-label "Current company: X. ..." first, then the first /company/ (or /showcase/) link with text.
  // /school/ entries and generic links are never taken as the company.
  function pickCurrentCompany(items) {
    const list = Array.isArray(items) ? items : [];
    for (const it of list) {
      const c = parseCurrentCompanyLabel(it && it.label);
      if (c) return c;
    }
    for (const it of list) {
      const href = String((it && it.href) || '');
      if (!/\/(?:company|showcase)\//i.test(href) || /\/school\//i.test(href)) continue;
      const line = cleanLines(String((it && it.text) || '').split('\n'))[0] || '';
      if (line && line.length <= 100) return line;
    }
    return '';
  }

  // "Current company: X" for the tenure guard: does the experience entry's company match the top-card company?
  function sameCompany(a, b) {
    const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const x = n(a), y = n(b);
    return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)));
  }

  const TOPCARD_NOISE =/^(?:[·•]|\(?(?:he|she|they)\/[a-z/]+\)?|(?:[·•]\s*)?contact info|message|connect|follow|following|pending|more|save in sales navigator|open to|premium|verified|send profile in a message|resources|book an appointment|visit my website|edit profile|view .* profile|\d[\d,+]*\+?\s+(?:connections?|followers?)|.*\bmutual connections?\b.*)$/i;
  const LOOKS_LIKE_LOCATION = /,|\b(?:area|metropolitan|region|united states|india|canada|united kingdom)\b/i;

  // Lines of the profile top card (innerText split) -> { degree, headline, location }.
  function parseTopCard(lines, name) {
    const L = cleanLines(lines);
    const want = normText(name);
    let start = want ? L.findIndex(l => normText(l).startsWith(want)) : -1;
    let degree = '';
    // The name is often repeated (visually-hidden copy, "Name 1st"): consume every leading name line.
    while (start !== -1 && start < L.length && normText(L[start]).startsWith(want)) {
      degree = degree || parseConnectionDegree(L[start].slice(String(name).length));
      start++;
    }
    const rest = [];
    for (const line of (start === -1 ? L : L.slice(start))) {
      const d = degreeToken(line);
      if (d) { if (!degree) degree = d; continue; }
      if (TOPCARD_NOISE.test(line)) continue;
      rest.push(line);
    }
    const headline = rest[0] || '';
    const location = rest.slice(1).find(l => l.length <= 80 && LOOKS_LIKE_LOCATION.test(l)) || '';
    return { degree, headline, location };
  }

  // Lines of the first Experience entry -> { title, company, current, months, tenure } or null.
  // Handles one role ("Title / Company · Full-time / Jan 2023 - Present · 1 yr 7 mos") and a company
  // with several roles ("Company / Full-time · 3 yrs / Title / ... dates"; the first role is the current one).
  const DATE_RANGE = /(?:\b[a-z]{3,9}\.?\s+)?(?:19|20)\d{2}\s*[-–—]\s*(?:present|(?:\b[a-z]{3,9}\.?\s+)?(?:19|20)\d{2})/i;
  const EMPLOYMENT_TYPE = /^(?:full-?time|part-?time|contract|self-?employed|freelance|internship|apprenticeship|seasonal|permanent|temporary)$/i;

  function isDurationOnly(line) {
    if (parseDurationMonths(line) === null || DATE_RANGE.test(line)) return false;
    const rest = line.replace(/\d+\s*(?:yrs?|years?|mos?|months?)\b/gi, '').replace(/[·\s]/g, '');
    return rest === '' || EMPLOYMENT_TYPE.test(rest);
  }

  function parseExperienceLines(lines) {
    const L = cleanLines(lines);
    const d = L.findIndex(l => DATE_RANGE.test(l));
    if (d < 1) return null;
    const grouped = d >= 3 && isDurationOnly(L[1]);
    const title = grouped ? L[2] : (d >= 2 ? L[d - 2] : L[0]);
    const company = grouped ? L[0] : (d >= 2 ? L[d - 1].split(/\s+·\s+/)[0] : '');
    const parts = L[d].split('·');
    const months = parts.length > 1 ? parseDurationMonths(parts[parts.length - 1]) : null;
    return {
      title: title.trim(),
      company: company.trim(),
      current: /present/i.test(L[d]),
      months,
      tenure: months ? formatTenure(months) : ''
    };
  }

  // ── LinkedIn "Contact info" dialog (email / phone / website of a 1st-degree connection) ──
  // "(Mobile)" -> mobile, "(Work)" -> office, anything else -> unknown.
  function phoneTypeFromLabel(label) {
    const s = String(label || '').toLowerCase();
    if (/mobile|cell/.test(s)) return 'mobile';
    if (/work|office|business/.test(s)) return 'office';
    return 'unknown';
  }

  // "+1 469-555-0123 (Mobile)" / "469 555 0123 x12 (Work)" -> { value, ext, type } or null.
  function parsePhoneLine(line) {
    const m = String(line || '').trim().match(/^(.*?)\s*(?:\(([A-Za-z ]{2,20})\))?\s*$/);
    const { phone, ext } = splitPhoneExt(m ? m[1] : '');
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15 || !/^[+\d(][\d\s().+-]*$/.test(phone)) return null;
    return { value: phone, ext, type: phoneTypeFromLabel(m && m[2]) };
  }

  const CONTACT_HEADINGS = { 'your profile': 'profile', website: 'websites', websites: 'websites', phone: 'phones', phones: 'phones',
    email: 'emails', emails: 'emails', address: 'address', birthday: 'birthday', connected: 'connected', 'connected since': 'connected',
    twitter: 'twitter', im: 'im', x: 'twitter' };
  const PHONE_LABEL = '(?:mobile|cell|work|home|office|business|other)';
  const PHONE_LABEL_END = new RegExp('\\(' + PHONE_LABEL + '\\)\\s*$', 'i');
  const PHONE_LABEL_ONLY = new RegExp('^\\(' + PHONE_LABEL + '\\)$', 'i');
  const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  // innerText of the dialog -> { emails: [], phones: [{ value, ext, type }], websites: [] }
  function parseContactInfoText(text) {
    const lines = cleanLines(String(text || '').split(/\r?\n/));
    const out = { emails: [], phones: [], websites: [] };
    let section = '';
    for (const line of lines) {
      const head = CONTACT_HEADINGS[line.toLowerCase()];
      if (head) { section = head; continue; }

      for (const raw of line.match(EMAIL_IN_TEXT) || []) {
        const e = normalizeEmail(raw);
        if (e && !out.emails.includes(e)) out.emails.push(e);
      }

      if (section === 'phones' || PHONE_LABEL_END.test(line)) {
        if (PHONE_LABEL_ONLY.test(line)) {
          const last = out.phones[out.phones.length - 1];
          if (last && last.type === 'unknown') last.type = phoneTypeFromLabel(line);
          continue;
        }
        const p = parsePhoneLine(line);
        if (p && !out.phones.some(x => x.value === p.value)) out.phones.push(p);
      } else if (section === 'websites') {
        const m = line.match(/\bhttps?:\/\/[^\s)]+|\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s)]*)?/i);
        if (m && !/linkedin\.com/i.test(m[0])) {
          const href = safeHttpUrl(/^https?:/i.test(m[0]) ? m[0] : 'https://' + m[0]);
          if (href && !out.websites.includes(href)) out.websites.push(href);
        }
      }
    }
    return out;
  }

  // ── Escaping ─────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Quotes a CSV cell and neutralises spreadsheet formulas (scraped text is untrusted).
  // Phone numbers like "+1 (555)..." are left alone.
  function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=@\t\r]/.test(s) || /^[+\-](?![\d\s(])/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  }

  function safeHttpUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
    } catch (_) {
      return '';
    }
  }

  // ── Consultant ↔ requirement matching ────────────────────────────────────
  // Consultant: { id, name, title, skills: 'Java, Spring Boot, AWS', experienceYears, visa,
  //               rate, location, relocation, availability, resumeUrl, notes, active }
  function splitSkills(text) {
    // "CI/CD", "PL/SQL" and "TCP/IP" are one skill each: hide their slash while splitting on "/".
    return String(text || '')
      .replace(/\b(CI|PL|TCP)\s*\/\s*(CD|SQL|IP)\b/gi, '$1\u0001$2')
      .split(/[,;|/\n]+/)
      .map(s => s.replace(/\u0001/g, '/').trim())
      .filter(s => s.length > 0 && s.length <= 40);
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Whole-word match that also works for skills like ".NET", "C#", "C++", "Node.js"
  function containsSkill(haystackLower, skill) {
    const s = skill.toLowerCase().trim();
    if (!s) return false;
    return new RegExp(`(?<![a-z0-9])${escapeRegex(s)}(?![a-z0-9])`).test(haystackLower);
  }

  // ── Resume PDF: file checks, skill dictionary and text parsing ──────────
  const RESUME_MAX_BYTES = 5 * 1024 * 1024;

  const RESUME_PDF_TYPE = 'application/pdf';
  const RESUME_DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const RESUME_OLD_DOC_MESSAGE = 'Old Word .doc files can\u2019t be read. Please save it as .docx or PDF and upload again.';

  // What the first bytes of a file say it is: 'pdf', 'docx' (a ZIP; word/document.xml is checked
  // separately), 'doc' (old Word 97-2003 / OLE2) or ''. headerText is the file's first bytes as latin1 text.
  function resumeKind(headerText) {
    const h = String(headerText || '').slice(0, 1024);
    if (h.indexOf('%PDF-') !== -1) return 'pdf';
    if (h.slice(0, 4) === 'PK\u0003\u0004') return 'docx';
    if (h.slice(0, 4) === '\u00d0\u00cf\u0011\u00e0') return 'doc';
    return '';
  }

  // MIME type to store for a given kind ('pdf' | 'docx'); anything else is treated as PDF (older records).
  function resumeMime(kind) { return kind === 'docx' ? RESUME_DOCX_TYPE : RESUME_PDF_TYPE; }

  // Type of a stored record, with older PDF-only records (no type saved) defaulting to PDF.
  function resumeRecordType(rec) {
    const r = rec || {};
    if (r.type === RESUME_DOCX_TYPE) return RESUME_DOCX_TYPE;
    if (r.type === RESUME_PDF_TYPE) return RESUME_PDF_TYPE;
    return /\.docx$/i.test(String(r.fileName || '')) ? RESUME_DOCX_TYPE : RESUME_PDF_TYPE;
  }

  // meta: { name, type, size }; headerText: the first bytes of the file as text;
  // extra.docxOk: true when a ZIP file really contains word/document.xml (the caller checks that).
  // Returns '' when the file is acceptable, otherwise the message to show.
  function checkResumeFile(meta, headerText, extra) {
    const m = meta || {};
    const size = Number(m.size) || 0;
    if (size <= 0) return 'That file is empty.';
    if (size > RESUME_MAX_BYTES) return 'That file is larger than 5 MB.';
    const kind = resumeKind(headerText);
    const name = String(m.name || '');
    const type = m.type === 'application/octet-stream' ? '' : String(m.type || '');
    if (kind === 'doc' || type === 'application/msword' || (!type && /\.doc$/i.test(name))) return RESUME_OLD_DOC_MESSAGE;
    const wantsDocx = type === RESUME_DOCX_TYPE || (!type && /\.docx$/i.test(name));
    const wantsPdf = type === RESUME_PDF_TYPE || (!type && /\.pdf$/i.test(name));
    if (!wantsDocx && !wantsPdf) return 'Please choose a PDF or Word (.docx) file.';
    if (wantsDocx) {
      if (kind !== 'docx' || !(extra && extra.docxOk === true)) return 'That file is not a valid Word (.docx) document.';
      return '';
    }
    if (kind !== 'pdf') return 'That file is not a valid PDF.';
    return '';
  }

  // Common US IT skills and technologies (canonical spelling shown to the user).
  const SKILL_DICTIONARY = [
    'Java', 'JavaScript', 'TypeScript', 'Python', 'C', 'C++', 'C#', '.NET', '.NET Core', 'ASP.NET', 'VB.NET',
    'Go', 'Rust', 'Ruby', 'Ruby on Rails', 'PHP', 'Scala', 'Kotlin', 'Swift', 'Objective-C', 'R', 'Perl',
    'Shell Scripting', 'Bash', 'PowerShell', 'SQL', 'PL/SQL', 'T-SQL', 'HTML', 'CSS', 'Sass',
    'Spring', 'Spring Boot', 'Spring MVC', 'Hibernate', 'Microservices', 'REST API', 'SOAP', 'GraphQL', 'gRPC',
    'JSON', 'XML', 'Maven', 'Gradle', 'JUnit', 'Mockito', 'Selenium', 'Cypress', 'Playwright', 'TestNG',
    'Angular', 'AngularJS', 'React', 'Redux', 'Next.js', 'Vue.js', 'Node.js', 'Express.js', 'NestJS', 'jQuery',
    'Django', 'Flask', 'FastAPI', 'Laravel', 'Entity Framework', 'LINQ', 'Blazor', 'WPF', 'Xamarin',
    'AWS', 'Azure', 'GCP', 'EC2', 'S3', 'Lambda', 'EKS', 'CloudFormation', 'Terraform', 'Ansible', 'Puppet', 'Chef',
    'Docker', 'Kubernetes', 'OpenShift', 'Jenkins', 'GitLab CI', 'GitHub Actions', 'CI/CD', 'Git', 'Bitbucket',
    'Linux', 'Unix', 'Windows Server', 'VMware', 'Nginx', 'Apache Tomcat', 'WebLogic', 'WebSphere', 'JBoss',
    'MySQL', 'PostgreSQL', 'Oracle', 'SQL Server', 'MongoDB', 'Cassandra', 'DynamoDB', 'Redis', 'Elasticsearch',
    'Snowflake', 'Redshift', 'Teradata', 'DB2', 'Neo4j', 'NoSQL',
    'Kafka', 'RabbitMQ', 'ActiveMQ', 'Hadoop', 'Spark', 'Hive', 'Airflow', 'Databricks', 'PySpark', 'ETL',
    'Informatica', 'Talend', 'SSIS', 'SSRS', 'DBT', 'Data Warehousing', 'Data Modeling',
    'Tableau', 'Power BI', 'Looker', 'Splunk', 'Grafana', 'Prometheus', 'Datadog',
    'Machine Learning', 'Deep Learning', 'TensorFlow', 'PyTorch', 'scikit-learn', 'Pandas', 'NumPy', 'NLP', 'MLOps',
    'Salesforce', 'Apex', 'SAP', 'ServiceNow', 'Workday', 'Dynamics 365', 'SharePoint', 'Power Apps', 'MuleSoft',
    'Guidewire', 'Oracle EBS', 'PeopleSoft', 'Pega', 'Appian',
    'Agile', 'Scrum', 'Kanban', 'JIRA', 'Confluence', 'DevOps', 'SRE', 'TDD', 'BDD',
    'Android', 'iOS', 'React Native', 'Flutter', 'Cybersecurity', 'SIEM', 'IAM', 'OAuth', 'SSO',
    'Postman', 'SoapUI', 'JMeter', 'Business Analysis', 'UML', 'Excel'
  ];

  // Other ways people write a skill -> canonical name.
  const SKILL_ALIASES = {
    'nodejs': 'Node.js', 'node js': 'Node.js', 'reactjs': 'React', 'react.js': 'React',
    'vuejs': 'Vue.js', 'vue.js': 'Vue.js', 'expressjs': 'Express.js', 'express js': 'Express.js', 'nextjs': 'Next.js',
    'golang': 'Go', 'k8s': 'Kubernetes', 'postgres': 'PostgreSQL', 'amazon web services': 'AWS',
    'microsoft azure': 'Azure', 'google cloud': 'GCP', 'google cloud platform': 'GCP', 'dotnet': '.NET',
    'asp.net core': '.NET Core', 'c sharp': 'C#', 'restful': 'REST API', 'rest apis': 'REST API',
    'restful api': 'REST API', 'restful apis': 'REST API', 'ms sql server': 'SQL Server',
    'mssql': 'SQL Server', 'mongo db': 'MongoDB', 'apache spark': 'Spark', 'apache kafka': 'Kafka',
    'powerbi': 'Power BI', 'springboot': 'Spring Boot', 'angular js': 'AngularJS', 'sfdc': 'Salesforce',
    'unix shell': 'Shell Scripting', 'shell scripts': 'Shell Scripting',
    // v1.6.1 matching: more spellings, used on both the post side and the consultant side
    'dot net': '.NET', 'dot-net': '.NET', 'node': 'Node.js', 'mongo': 'MongoDB', 'cicd': 'CI/CD', 'ci cd': 'CI/CD', 'ci-cd': 'CI/CD',
    'sprint boot': 'Spring Boot', 'spring-boot': 'Spring Boot', 'service now': 'ServiceNow', 'sales force': 'Salesforce',
    'js': 'JavaScript', 'ts': 'TypeScript', 'ml': 'Machine Learning', 'snow': 'ServiceNow', 'ai/ml': 'Machine Learning',
    'postgre sql': 'PostgreSQL', 'react native js': 'React Native'
  };
  // Short spellings that are also ordinary words or common letters: in free text they only count in capitals
  // and standing alone ("JS", "TS", "ML", "AI", "SNOW"), never inside another word.
  const SHORT_CAPS_SKILLS = { JS: 'JavaScript', TS: 'TypeScript', ML: 'Machine Learning', AI: 'AI', SNOW: 'ServiceNow' };
  // Aliases that are ordinary words in free text: only used when the consultant typed them in a skills list.
  const LIST_ONLY_ALIASES = new Set(['js', 'ts', 'ml', 'snow', 'node', 'ai/ml']);
  // Go / R / C in a sentence count only with a tech word next to them ("Go developer", "R programming",
  // "C programming"); "go ahead" and "R&D" never do.
  const STRICT_CONTEXT = {
    Go: 'Go\\s+(?:developers?|engineers?|programmers?|programming|language|lang|backend|microservices)',
    R: 'R\\s+(?:programming|language|developers?|studio|shiny)',
    C: 'C\\s+(?:programming|language|developers?)'
  };
  // Skills that are single letters or ordinary words: match with exact case, and only as a list item
  // (", C," / "C/C++" / "Languages: Python, R"), so "Vitamin C" or "Go to market" never count.
  const STRICT_SKILLS = new Set(['C', 'R', 'Go']);
  // Skills that are also plain words: match with exact case.
  const CASE_SENSITIVE_SKILLS = new Set(['Spring', 'Spark', 'Oracle', 'Swift', 'Chef', 'Puppet', 'Lambda', 'Excel', 'Hive', 'Apex', 'Git']);

  let skillTermCache = null;
  function skillTerms() {
    if (skillTermCache) return skillTermCache;
    skillTermCache = [];
    const push = (term, canonical) => {
      const exact = term === canonical;
      if (exact && STRICT_SKILLS.has(canonical)) {
        skillTermCache.push({ canonical, re: new RegExp('(?:^|[\\s,;/|•·(])' + escapeRegex(term) + '(?=\\s*(?:[,;/|•·)]|$))', 'm') });
        if (STRICT_CONTEXT[canonical]) skillTermCache.push({ canonical, re: new RegExp('(?<![A-Za-z0-9])' + STRICT_CONTEXT[canonical] + '(?![A-Za-z0-9])') });
        return;
      }
      const flags = exact && CASE_SENSITIVE_SKILLS.has(canonical) ? '' : 'i';
      // No letter or digit on either side. A name that does not end in "+" or "#" may not run into one
      // (so "C" never matches "C++" or "C#", and "Java" never matches "JavaScript").
      const tail = /[+#]$/.test(term) ? '' : '(?![+#])';
      skillTermCache.push({ canonical, re: new RegExp('(?<![A-Za-z0-9])' + escapeRegex(term) + '(?![A-Za-z0-9])' + tail, flags) });
    };
    SKILL_DICTIONARY.forEach(s => push(s, s));
    Object.keys(SKILL_ALIASES).forEach(a => { if (!LIST_ONLY_ALIASES.has(a)) push(a, SKILL_ALIASES[a]); });
    // JS / TS / ML / AI / SNOW: capitals only, standing alone, never inside "R&D"-style fragments.
    Object.keys(SHORT_CAPS_SKILLS).forEach(a => skillTermCache.push({
      canonical: SHORT_CAPS_SKILLS[a], re: new RegExp('(?<![A-Za-z0-9&])' + a + '(?![A-Za-z0-9&])') }));
    return skillTermCache;
  }

  // Skills found in free text, in the order they first appear, without duplicates.
  function extractSkills(text) {
    const src = String(text || '');
    const found = new Map();
    for (const t of skillTerms()) {
      const m = t.re.exec(src);
      if (!m) continue;
      const at = m.index;
      if (!found.has(t.canonical) || found.get(t.canonical) > at) found.set(t.canonical, at);
    }
    // "Spring" is implied by the more specific names, so it is not listed next to them.
    if (found.has('Spring Boot') || found.has('Spring MVC')) found.delete('Spring');
    return [...found.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);
  }

  const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
    'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
    'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
  const RESUME_TITLE_WORD = /\b(?:developer|engineer|architect|analyst|consultant|administrator|admin|manager|lead|scientist|tester|programmer|designer|specialist|devops|sre|dba|qa|director|strategist|coordinator)\b/i;
  const RESUME_NOT_A_NAME = /\b(?:resume|résumé|curriculum|vitae|cv|summary|objective|profile|contact|experience|education|skills?|technical|professional|address|email|e-mail|phone|mobile|linkedin|page|references|certifications?|projects?|work|history|authorized|authorization|visa|citizen)\b/i;

  function titleCaseWord(w) {
    return w.replace(/[A-Za-z]+/g, p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  }

  function resumeLines(text) {
    return String(text || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  function looksLikeName(line) {
    if (line.length > 40 || /[0-9@:/\\|•·]/.test(line)) return false;
    if (RESUME_NOT_A_NAME.test(line) || RESUME_TITLE_WORD.test(line)) return false;
    const tokens = line.split(' ');
    if (tokens.length < 2 || tokens.length > 4) return false;
    if (extractSkills(line).length) return false;
    const allCaps = line === line.toUpperCase();
    const okToken = allCaps
      ? (t) => /^[A-Z][A-Z'’.-]*$/.test(t)
      : (t) => /^(?:[A-Z][a-z]*(?:['’-]?[A-Z][a-z]+)?|[A-Z]\.|de|van|von|bin|al|la|del|da)$/.test(t);
    return tokens.every(okToken) && tokens.filter(t => t.replace(/[^A-Za-z]/g, '').length >= 2).length >= 2;
  }

  function pickResumeName(lines) {
    for (let i = 0; i < Math.min(lines.length, 12); i++) {
      const l = lines[i];
      if (looksLikeName(l)) return { name: l === l.toUpperCase() ? titleCaseWord(l) : l, index: i };
    }
    return { name: '', index: -1 };
  }

  function titleFromLine(line) {
    if (/@|https?:|www\./i.test(line) || /\d{3}[\s.)-]*\d{3}/.test(line)) return '';
    const parts = line.replace(/^(?:title|role|designation|position)\s*:\s*/i, '').split(/\s+[|–—-]\s+|\s*\|\s*|\s*•\s*/);
    const hit = parts.find(p => RESUME_TITLE_WORD.test(p) && p.trim().length >= 4 && p.trim().length <= 70);
    if (!hit) return '';
    const t = hit.trim().replace(/^[^A-Za-z0-9.#+]+|[,;:]+$/g, '');
    return t.split(' ').length > 8 ? '' : t;
  }

  function pickResumeTitle(lines, nameIndex) {
    const start = nameIndex >= 0 ? nameIndex + 1 : 0;
    for (let i = start; i < Math.min(lines.length, start + 8); i++) {
      if (/^(?:professional\s+)?(?:summary|objective|profile|experience|education|technical skills)\b/i.test(lines[i])) break;
      const t = titleFromLine(lines[i]);
      if (t) return t;
    }
    // "... as a Senior Java Developer ..." in the summary
    const m = lines.slice(0, 25).join(' ').match(/\b(?:as|is) an? ((?:(?:Senior|Sr\.?|Lead|Principal|Junior|Jr\.?)\s+)?(?:[A-Z][\w.#+/-]*\s+){0,3}(?:Developer|Engineer|Architect|Analyst|Consultant|Administrator|Tester|Scientist))\b/);
    return m ? m[1].trim() : '';
  }

  function pickResumeEmail(text) {
    const all = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    const good = all.find(e => !/^(?:no-?reply|donotreply)@/i.test(e));
    return good ? good.toLowerCase() : '';
  }

  // US numbers: (555) 123-4567, 555-123-4567, 555.123.4567, +1 555 123 4567, 5551234567
  function pickResumePhone(text) {
    const re = /(?<!\d)(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g;
    const m = re.exec(String(text || ''));
    return m ? m[0].trim().replace(/\s+/g, ' ') : '';
  }

  function pickResumeLocation(text) {
    const re = new RegExp("\\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}),\\s*(" + US_STATES.join('|') + ')\\b(?![A-Za-z])', 'g');
    const src = String(text || '');
    let m;
    while ((m = re.exec(src))) {
      if (extractSkills(m[1]).length) continue; // "Java, OR" is not Oregon
      return `${m[1]}, ${m[2]}`;
    }
    return '';
  }

  function pickResumeYears(text) {
    const src = String(text || '');
    const pats = [
      /\b(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b(?:\s+of)?(?:\s+[\w.#+/&-]+,?){0,5}?\s+(?:experience|exp)\b/i,
      /\bexperience\s+(?:of\s+|for\s+)?(?:over\s+|more than\s+)?(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/i,
      /\b(?:over|more than)\s+(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/i,
      /\b(\d{1,2})\s*\+\s*(?:years?|yrs?)\b/i
    ];
    for (const re of pats) {
      const m = re.exec(src);
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= 45) return String(Number(m[1]));
    }
    return '';
  }

  // Text of a resume -> { name, title, email, phone, location, experienceYears, skills: [] }.
  // Anything not found is '' (or []). Pure function: nothing is saved from here.
  function parseResumeText(text) {
    const lines = resumeLines(text);
    const joined = lines.join('\n');
    const nm = pickResumeName(lines);
    return {
      name: nm.name,
      title: pickResumeTitle(lines, nm.index),
      email: pickResumeEmail(joined),
      phone: pickResumePhone(joined),
      location: pickResumeLocation(joined),
      experienceYears: pickResumeYears(joined),
      skills: extractSkills(joined)
    };
  }

  const TITLE_STOPWORDS = new Set(['sr', 'senior', 'jr', 'junior', 'lead', 'engineer', 'developer', 'consultant',
    'analyst', 'specialist', 'architect', 'manager', 'the', 'and', 'of', 'with', 'for', 'full', 'stack', 'software']);

  function titleKeywords(title) {
    return String(title || '').toLowerCase().split(/[^a-z0-9#+.]+/)
      .map(w => w.replace(/^\.+|\.+$/g, ''))
      .filter(w => w.length > 1 && !TITLE_STOPWORDS.has(w));
  }

  // ── Bench matching (v1.5.2): a 0-100 % score with reasons, strict on purpose ──
  // Weights (v1.18): skills 45 + title 12 + location 10 + experience 8 + visa 7 + terms 5 + rate 5 + recency 8 (see scoreMatch).
  // Hard exclusions (never returned, whatever the score): hotlists, bench sellers and recruiter job
  // openings; posts whose tax terms do not fit the consultant (c.taxTerms, see leadTermsFit below; a consultant
  // without the field counts as C2C); a local-only post for another state without relocation; a visa the post rules out.
  const MATCH_THRESHOLD = 60;
  // Skills that appear in most posts: one of these alone proves nothing, so they count for less.
  const GENERIC_SKILLS = new Set(['ai', 'ml', 'sql', 'data', 'cloud', 'api', 'apis', 'web', 'linux', 'git', 'excel', 'agile',
    'scrum', 'rest', 'html', 'css', 'json', 'xml', 'jira', 'testing', 'automation', 'analytics', 'office', 'windows']);
  const GENERIC_WEIGHT = 0.4;
  const SKILL_TARGET = 5;   // a post rarely needs more than ~5 of a consultant's skills

  // Engagement of the post: the tags written at save time, else read from the text (older leads).
  const FULLTIME_RE = /\b(?:full[\s-]*time|fte|permanent|perm)\b/i;
  const CONTRACT_OK_RE = /\bc2c\b|\bcorp[\s-]*(?:to|2)[\s-]*corp\b|\b1099\b|\bcontract\b|\bc2h\b/i;
  const NO_C2C_RE = /\b(?:no|not|non)[\s-]*(?:c2c|corp[\s-]*to[\s-]*corp)\b|\bc2c\s*(?:is\s*)?not\s*(?:allowed|accepted|considered)\b|\bw-?2\s*(?:only|candidates?\s*only)\b|\bonly\s*w-?2\b/i;
  // ── Tax terms (W2 support) ──
  // Consultant.taxTerms: 'C2C' | 'W2' | '1099' | 'Any'. Missing or unknown = 'C2C' (what every consultant was before the field existed).
  const TAX_TERMS = ['C2C', 'W2', '1099', 'Any'];
  const WORK_TERMS = ['C2C', 'W2', 'Both'];
  function normalizeTaxTerms(v) { return TAX_TERMS.includes(v) ? v : 'C2C'; }
  // The Settings choice "I mostly work on" -> the default tax terms of a new consultant ('Both' = 'Any').
  function defaultTaxTerms(workTerms) { return workTerms === 'W2' ? 'W2' : workTerms === 'Both' ? 'Any' : 'C2C'; }
  // ... and the default of the Terms filter ('Both' = all).
  function defaultTermsFilter(workTerms) { return workTerms === 'W2' ? 'w2' : workTerms === 'C2C' ? 'c2c' : 'all'; }

  // Feature flags (lib/config.js FEATURES). Only a literal true turns a feature on, and a remote OFF switch (lib/remote-config.js, from
  // `me`) wins over it. Remote config can never turn a feature on.
  function featureOn(name) {
    const f = (root.BP_CONFIG && root.BP_CONFIG.FEATURES) || {};
    if (f[name] !== true) return false;
    const rc = root.BP && root.BP.RemoteConfig;
    return !(rc && rc.isOff(name));
  }
  // Settings page: take out the pieces of a feature that is switched off (today: the Sync nav link and section). doc = document.
  function hideDisabledFeatures(doc) {
    if (featureOn('sync')) return;
    const link = doc.querySelector('#side-nav a[href="#sec-sync"]');
    if (link) (link.closest('li') || link).remove();
    const sec = doc.getElementById('sec-sync');
    if (sec) sec.remove();
    // Any other text that only makes sense with sync on.
    doc.querySelectorAll('[data-feature="sync"]').forEach((el) => el.remove());
  }

  // A link into the web app (CFG.WEBAPP_URL): webappUrl('#book') -> 'https://.../benchpilot-app/#book'. '' when not configured.
  function webappUrl(hash) {
    const base = String(CFG.WEBAPP_URL || '');
    if (!/^https:\/\//.test(base)) return '';
    return base.replace(/#.*$/, '') + (hash ? (String(hash).startsWith('#') ? hash : '#' + hash) : '');
  }
  // Static pages carry no plan names or web app addresses in their HTML: lock badges are <span data-lock-feature="sync"> and web app
  // links are <a data-webapp-path="#book">; this fills both from BP.lockBadgeText / BP.webappUrl. A link with no address is hidden.
  function applyPageLinks(doc) {
    doc.querySelectorAll('[data-lock-feature]').forEach((el) => { el.textContent = lockBadgeText(el.getAttribute('data-lock-feature')); });
    doc.querySelectorAll('[data-webapp-path]').forEach((el) => {
      const url = webappUrl(el.getAttribute('data-webapp-path'));
      if (url) el.setAttribute('href', url); else el.hidden = true;
    });
    doc.querySelectorAll('[data-site-path]').forEach((el) => {
      const base = String(CFG.WEBSITE_URL || '');
      if (/^https:\/\//.test(base)) el.setAttribute('href', base.replace(/\/+$/, '') + '/' + el.getAttribute('data-site-path')); else el.hidden = true;
    });
  }

  // What a post says about terms. Tags written at save time win; older leads are read from the text.
  const C2C_WORD_RE = /\bc2c\b|\bcorp[\s-]*(?:to|2)[\s-]*corp\b/i;
  const NO_C2C_ONLY_RE = /\b(?:no|not|non)[\s-]*(?:c2c|corp[\s-]*to[\s-]*corp)\b|\bc2c\s*(?:is\s*)?not\s*(?:allowed|accepted|considered)\b/gi;
  const W2_WORD_RE = /\bw-?2\b/i;
  const NO_W2_RE = /\b(?:no|not|non)[\s-]*w-?2\b/i;
  function postTerms(lead, hay) {
    const tags = Array.isArray(lead.engagement) ? lead.engagement : [];
    if (tags.length) {
      return { c2c: tags.includes('c2c'), w2: tags.includes('w2'), p1099: tags.includes('1099'),
        contract: tags.includes('contract') || tags.includes('c2h'), fulltime: tags.includes('fulltime'), tagged: true };
    }
    const noNeg = hay.replace(NO_C2C_ONLY_RE, ' ');
    return { c2c: C2C_WORD_RE.test(noNeg), w2: W2_WORD_RE.test(hay) && !NO_W2_RE.test(hay), p1099: /\b1099\b/.test(noNeg),
      contract: /\bcontract\b|\bc2h\b/i.test(noNeg), fulltime: FULLTIME_RE.test(hay), tagged: false };
  }

  // Do the post's terms fit the consultant's tax terms? -> { ok, known, chip }.
  //   known = the post states terms that fit (gives the score its engagement points).
  //   chip  = the short reason text: 'C2C ok' / 'W2 ok' / '1099 ok' when it fits, 'C2C only ✗' / 'W2 only ✗' / 'Full-time ✗' when it does not.
  // C2C and 1099 consultants: W2-only, "no C2C" and full-time posts (without a contract term) are out, as they always were.
  // W2 consultants: a post that names C2C or 1099 but not W2 is out ("C2C only"); W2 posts and posts that state no terms are in;
  //   a full-time post is out unless it also says W2 contract.
  // Any: C2C, W2 and 1099 posts are all in; a full-time post is out unless it also names a contract term.
  function leadTermsFit(lead, taxTerms, hayIn) {
    const terms = normalizeTaxTerms(taxTerms);
    const hay = hayIn !== undefined ? hayIn : [lead.requirement, lead.technologies, lead.notes, lead.headline].filter(Boolean).join(' | ').toLowerCase();
    const t = postTerms(lead, hay);
    if (terms === 'C2C' || terms === '1099') {
      if (t.tagged) {
        const contract = t.c2c || t.p1099 || t.contract;
        const c2cWord = t.c2c || t.p1099;
        if (t.fulltime && !contract) return { ok: false, chip: 'Full-time ✗' };
        if (t.w2 && !c2cWord) return { ok: false, chip: 'W2 only ✗' };
        return { ok: true, known: c2cWord || contract, chip: c2cWord || contract ? 'C2C ok' : '' };
      }
      if (NO_C2C_RE.test(hay)) return { ok: false, chip: 'W2 only ✗' };
      if (FULLTIME_RE.test(hay) && !CONTRACT_OK_RE.test(hay)) return { ok: false, chip: 'Full-time ✗' };
      const known = CONTRACT_OK_RE.test(hay);
      return { ok: true, known, chip: known ? 'C2C ok' : '' };
    }
    if (terms === 'W2') {
      if ((t.c2c || t.p1099) && !t.w2) return { ok: false, chip: t.p1099 && !t.c2c ? '1099 only ✗' : 'C2C only ✗' };
      if (t.fulltime && !(t.w2 && t.contract)) return { ok: false, chip: 'Full-time ✗' };
      return { ok: true, known: t.w2, chip: t.w2 ? 'W2 ok' : '' };
    }
    // Any
    const contract = t.c2c || t.p1099 || t.contract;
    if (t.fulltime && !contract) return { ok: false, chip: 'Full-time ✗' };
    const known = t.c2c || t.p1099 || t.w2 || t.contract;
    return { ok: true, known, chip: t.c2c ? 'C2C ok' : t.w2 ? 'W2 ok' : t.p1099 ? '1099 ok' : '' };
  }
  function leadEngagementOk(lead, hay, taxTerms) {
    const r = leadTermsFit(lead, taxTerms, hay);
    return r.ok ? { ok: true, known: Boolean(r.known), chip: r.chip } : { ok: false, chip: r.chip };
  }

  // The "Terms" filter on requirement lists: 'all' | 'c2c' | 'w2' | 'fulltime'. Uses the lead's engagement tags,
  // and the text for older leads that have none.
  const TERMS_FILTERS = ['all', 'c2c', 'w2', 'fulltime'];
  function normalizeTermsFilter(v) { return TERMS_FILTERS.includes(v) ? v : 'all'; }
  // The filter to start with: the last choice (bp_terms_filter) if there is one, else the Settings choice "I mostly work on".
  function termsFilterInitial(stored) {
    const s = stored || {};
    return s.bp_terms_filter !== undefined ? normalizeTermsFilter(s.bp_terms_filter) : defaultTermsFilter(s.bp_work_terms);
  }
  function leadMatchesTerms(lead, filter) {
    const f = normalizeTermsFilter(filter);
    if (f === 'all') return true;
    const l = lead || {};
    if (f === 'fulltime') {
      if (Array.isArray(l.engagement) && l.engagement.length) return l.engagement.includes('fulltime');
      return FULLTIME_RE.test([l.directClientVms, l.notes, l.requirement].filter(Boolean).join(' '));
    }
    return root.BP.leadHasTag(l, f);
  }

  // Visa wording in the post that rules a consultant out. An unknown consultant visa is never excluded.
  const VISA_ALIASES = { USC: /\busc\b|\bus\s*citizen|\bcitizen/i, GC: /\bgc\b|green\s*card/i, 'GC-EAD': /\bgc[\s-]*ead\b|\bead\b/i,
    H1B: /\bh-?1b?\b/i, 'H4-EAD': /\bh-?4\b/i, 'L2-EAD': /\bl-?2\b/i, OPT: /\bopt\b/i, CPT: /\bcpt\b/i, 'STEM OPT': /\bopt\b/i, TN: /\btn\b/i };
  const ONLY_GC_USC_RE = /\b(?:gc|usc|us\s*citizens?|u\.s\.\s*citizens?|green\s*card)\b[^.\n]{0,25}\bonly\b|\bonly\b[^.\n]{0,20}\b(?:gc|usc|us\s*citizens?|green\s*card)\b/i;
  // "Independent visa only" means not tied to an employer sponsor: H1B is out. OPT/CPT are left alone (unclear).
  const NO_H1B_RE = /\bno\s+h-?1b?\b|\bh-?1b?\s+(?:(?:transfers?|candidates?|visa)\s+)?(?:is\s+|are\s+)?not\s+(?:allowed|accepted|considered|open)\b|\bwithout\s+h-?1b\b|\bindependent\s+(?:visa|only)\b/i;
  function visaExcludes(visa, hay) {
    const v = String(visa || '').trim().toUpperCase();
    if (!VISA_ALIASES[v]) return false;
    if (v === 'H1B' && NO_H1B_RE.test(hay)) return true;
    const m = ONLY_GC_USC_RE.exec(hay);
    if (m && v !== 'USC' && v !== 'GC') {
      // "Only GC, USC, H4 EAD" names the consultant's own visa: not excluded
      const win = hay.slice(Math.max(0, m.index - 30), m.index + m[0].length + 40);
      return !VISA_ALIASES[v].test(win);
    }
    return false;
  }

  function leadYears(hay) {
    const m = /\b(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/.exec(hay);
    return m && Number(m[1]) >= 1 && Number(m[1]) <= 40 ? Number(m[1]) : 0;
  }

  // ── Skill names: one spelling for both sides (v1.6.1) ──
  // "ReactJS" and "React", "K8s" and "Kubernetes", "Dot Net" and ".NET" all become the same key.
  let skillKeyMap = null;
  function skillKeyOf(skill) {
    if (!skillKeyMap) {
      skillKeyMap = new Map();
      SKILL_DICTIONARY.forEach(s => skillKeyMap.set(s.toLowerCase(), s.toLowerCase()));
      Object.keys(SKILL_ALIASES).forEach(a => skillKeyMap.set(a, SKILL_ALIASES[a].toLowerCase()));
      Object.keys(SHORT_CAPS_SKILLS).forEach(a => skillKeyMap.set(a.toLowerCase(), SHORT_CAPS_SKILLS[a].toLowerCase()));
    }
    const k = String(skill || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return skillKeyMap.get(k) || k;
  }
  // A skill that implies another one for matching: ASP.NET and .NET Core are .NET; Spring and Spring Boot go together.
  const SKILL_IMPLIES = { '.net': ['asp.net', '.net core'], 'asp.net': ['.net'], '.net core': ['.net'],
    'spring boot': ['spring'], 'spring': ['spring boot'] };
  function skillWeight(key) { return GENERIC_SKILLS.has(key) || key === 'rest api' || key === 'machine learning' ? GENERIC_WEIGHT : 1; }

  let dictKeySet = null;
  function isDictionaryKey(key) {
    if (!dictKeySet) {
      dictKeySet = new Set();
      SKILL_DICTIONARY.forEach(s => dictKeySet.add(s.toLowerCase()));
      Object.keys(SKILL_ALIASES).forEach(a => dictKeySet.add(SKILL_ALIASES[a].toLowerCase()));
      Object.keys(SHORT_CAPS_SKILLS).forEach(a => dictKeySet.add(SHORT_CAPS_SKILLS[a].toLowerCase()));
    }
    return dictKeySet.has(key);
  }

  // The post's tech skills: [{ key, name }], read from the post text with the same dictionary as resumes.
  function postSkillList(lead) {
    const raw = [lead.requirement, lead.technologies, lead.notes, lead.headline].filter(Boolean).join(' | ');
    const seen = new Set();
    const out = [];
    for (const name of extractSkills(raw)) {
      const key = skillKeyOf(name);
      if (!seen.has(key)) { seen.add(key); out.push({ key, name }); }
    }
    return out;
  }
  function haveSkill(haveKeys, key) {
    if (haveKeys.has(key)) return true;
    return (SKILL_IMPLIES[key] || []).some(k => haveKeys.has(k));
  }

  // Must-have skills: the ones in the post's title and tech line, and in a "must have / required / mandatory" line of the text.
  // Generic skills (SQL, Agile ...) are never must-haves.
  const MUST_LINE_RE = /\bmust[\s-]*haves?\b|\bmust\s+have\b|\bmandatory\b|\brequired\s+skills?\b|\bskills?\s+required\b|\bkey\s+skills?\b|\bprimary\s+skills?\b/i;
  function mustSkillKeys(lead) {
    const keys = new Set();
    for (const n of extractSkills([lead.requirement, lead.technologies].filter(Boolean).join(' | '))) keys.add(skillKeyOf(n));
    for (const line of String(lead.notes || '').split(/\n|[.;](?=\s)/)) {
      if (MUST_LINE_RE.test(line)) for (const n of extractSkills(line)) keys.add(skillKeyOf(n));
    }
    for (const k of [...keys]) if (skillWeight(k) !== 1) keys.delete(k);
    return keys;
  }

  // Visa: the post's own fields (visaAllowed / visaNotAllowed, read at save time) against the consultant's visa.
  //   -> 'fits' (the post lists it), 'open' (no conflict: USC / GC, or only a not-allowed list without it),
  //      'out' (the post leaves it out), 'unknown' (the consultant's visa or the post's rules are not known).
  const VISA_EQUIV = { OPT: ['OPT', 'STEM OPT'], 'STEM OPT': ['STEM OPT', 'OPT'], 'GC-EAD': ['GC-EAD', 'EAD'], 'H4-EAD': ['H4-EAD', 'EAD'], 'L2-EAD': ['L2-EAD', 'EAD'] };
  function postVisaFit(lead, visa) {
    const v = String(visa || '').trim().toUpperCase();
    if (!v) return 'unknown';
    const codes = VISA_EQUIV[v] || [v];
    const allowed = Array.isArray(lead.visaAllowed) ? lead.visaAllowed : [];
    const notAllowed = Array.isArray(lead.visaNotAllowed) ? lead.visaNotAllowed : [];
    if (notAllowed.some(x => codes.includes(x))) return 'out';
    if (allowed.length) {
      if (allowed.some(x => codes.includes(x))) return 'fits';
      return v === 'USC' || v === 'GC' ? 'open' : 'out';
    }
    if (notAllowed.length || v === 'USC' || v === 'GC') return 'open';
    return 'unknown';
  }

  // Rate: the post's hourly rate (the top of a range) against the consultant's own rate. null when either side is not known.
  function postHourlyRate(lead) {
    const r = lead && lead.rate;
    if (!r || typeof r !== 'object') return null;
    if (r.unit && r.unit !== 'hr') return null;
    const top = Number(r.max) > 0 ? Number(r.max) : Number(r.min) > 0 ? Number(r.min) : null;
    return top && top < 1000 ? top : null;
  }

  // "Needs a look": posts BenchPilot could not read with confidence (the post type is unclear, it may be a job seeker, or no
  // skill could be read from it). They still match, but never as a strong match, and they carry a "Needs a look" label.
  const STRONG_MATCH = 75;
  function needsLookWhy(lead, postSkillCount) {
    const l = lead || {};
    if (l.postType === 'unclear') return 'BenchPilot could not tell if this is a requirement';
    if (l.candidate === 'check') return 'This may be a job seeker, not a recruiter';
    if (postSkillCount === 0) return 'No skills could be read from this post';
    return '';
  }
  // Cached per lead object (lists call this for every saved lead on each render); the key notices edits to the fields it reads.
  const lookCache = new WeakMap();
  // BP.needsLookReason(lead) -> '' or the plain reason; BP.needsLook(lead) -> boolean.
  function needsLookReason(lead) {
    if (!lead || typeof lead !== 'object' || !isHiringLead(lead)) return '';
    const sig = [lead.postType, lead.candidate, lead.requirement, lead.technologies, lead.notes, lead.headline].join('\u0001');
    const hit = lookCache.get(lead);
    if (hit && hit.sig === sig) return hit.v;
    const v = needsLookWhy(lead, postSkillList(lead).length);
    lookCache.set(lead, { sig, v });
    return v;
  }
  function needsLook(lead) { return Boolean(needsLookReason(lead)); }

  // Score one consultant against one lead (v1.18 scale). Returns null when excluded or below the threshold.
  // With opts.explain a near miss comes back instead of null ({ blocked, blockers, percent, reasons, missing }),
  // for a later "why not" view. A match always carries reasons, missing and blockers (empty) arrays, and
  // breakdown: [{ key, label, pts, max, note }] (the points per part: "why this score").
  // Weights: skills 45 (must-haves count double) + title 12 + location 10 + experience 8 + visa 7 + terms 5 + rate 5 + recency 8.
  // A part that is not known on one side earns a low neutral share: never full marks, never zero. opts.now (ms) sets the clock.
  function scoreMatch(lead, c, opts) {
    if (!lead || !c) return null;
    // Hotlists, recruiter jobs, bench sellers and job seekers are never matched, nor is a post that says the role is filled (v1.17).
    if (!isHiringLead(lead) || lead.closed === true) return null;
    const hay = [lead.requirement, lead.technologies, lead.notes, lead.headline].filter(Boolean).join(' | ').toLowerCase();
    if (!hay) return null;
    const eng = leadEngagementOk(lead, hay, c.taxTerms);
    if (!eng.ok) return null;
    const visaType = consultantVisaType(c);
    if (visaExcludes(visaType, hay)) return null;
    const explain = Boolean(opts && opts.explain);
    const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();

    const reasons = [];
    const missing = [];
    const blockers = [];
    const breakdown = [];
    const part = (key, label, p, max, note) => { breakdown.push({ key, label, pts: Math.round(p * 10) / 10, max, note: note || '' }); return p; };

    // Skills (45): weighted share of the POST's skills the consultant has; must-haves weigh 2, generic skills 0.4.
    // A post with fewer than 3 readable skills falls back to the consultant's own skills found in the post, at most 38 of 45
    // (a thin post proves less).
    const all = splitSkills(c.skills);
    const postNeeds = postSkillList(lead);
    const haveKeys = new Set(all.map(skillKeyOf));
    const postKeys = new Set(postNeeds.map(n => n.key));
    const matchedSkills = all.filter(s => {
      const k = skillKeyOf(s);
      if (haveSkill(postKeys, k)) return true;
      // skills the dictionary does not know are also looked for in the text (Go, R, C, AI are in the dictionary,
      // so they only count when the post names them as skills)
      return !isDictionaryKey(k) && k.length > 2 && containsSkill(hay, s);
    });
    const weight = s => skillWeight(skillKeyOf(s));
    const wMatched = matchedSkills.reduce((n, s) => n + weight(s), 0);
    const wAll = all.reduce((n, s) => n + weight(s), 0);
    const reqWords = new Set(titleKeywords(lead.requirement));
    const cWords = titleKeywords(c.title);
    const titleHits = cWords.filter(w => reqWords.has(w)).length;
    const titleMatch = titleHits > 0;
    // One shared skill is not a match: need two, or one plus the same role.
    if (matchedSkills.length < 2 && !(matchedSkills.length === 1 && titleMatch)) return null;
    let pts = 0;
    let capAt = 100;
    if (postNeeds.length >= 3) {
      const must = mustSkillKeys(lead);
      const w = s => (must.has(s.key) ? 2 : skillWeight(s.key));
      const wNeed = postNeeds.reduce((n, s) => n + w(s), 0);
      const wHave = postNeeds.filter(s => haveSkill(haveKeys, s.key)).reduce((n, s) => n + w(s), 0);
      const cover = wNeed > 0 ? wHave / wNeed : 0;
      const lackMust = postNeeds.filter(s => must.has(s.key) && !haveSkill(haveKeys, s.key)).map(s => s.name);
      const lackOther = postNeeds.filter(s => !must.has(s.key) && !haveSkill(haveKeys, s.key) && skillWeight(s.key) === 1).map(s => s.name);
      const lacking = lackMust.concat(lackOther);
      if (lacking.length) missing.push(`skills: ${lacking.slice(0, 4).join(', ')}`);
      pts += part('skills', 'Skills', 45 * cover, 45,
        `${Math.round(cover * 100)}% of the post's skills${lackMust.length ? `, missing must-have ${lackMust.slice(0, 3).join(', ')}` : ''}`);
      // Covers under half of what the post asks for: never shown as a match, whatever else fits.
      if (cover < 0.5) { capAt = MATCH_THRESHOLD - 1; blockers.push(`skills: covers ${Math.round(cover * 100)}% of the post's skills`); }
    } else {
      const share = Math.min(1, wMatched / Math.max(1, Math.min(wAll, SKILL_TARGET)));
      pts += part('skills', 'Skills', 38 * share, 45, 'The post names few skills');
    }
    reasons.push(matchedSkills.slice(0, 4).join(', '));

    // Title (12): share of the consultant's title keywords in the requirement title; unknown title is neutral-low.
    if (!cWords.length) pts += part('title', 'Title', 4, 12, 'No title on the consultant');
    else if (titleMatch) { pts += part('title', 'Title', Math.max(5, 12 * titleHits / cWords.length), 12); reasons.push('title match'); }
    else { pts += part('title', 'Title', 0, 12, 'Different title'); missing.push('title'); }

    // Location (10): local-only needs the state (or relocation); remote always fits.
    const mode = String(lead.workMode || '').toLowerCase();
    const remote = mode === 'remote' || (!mode && /\bremote\b/i.test(lead.location || ''));
    if (lead.localOnly === true) {
      if (!consultantFitsLocal(c, lead)) blockers.push(`location (${String(lead.localState || '').toUpperCase() || 'local only'})`);
      pts += part('location', 'Location', lead.localState ? 10 : 5, 10, lead.localState ? '' : 'Local only, state not stated');
      if (lead.localState) reasons.push(`Local to ${String(lead.localState).toUpperCase()}`);
    } else if (remote) {
      pts += part('location', 'Location', 10, 10); reasons.push('Remote');
    } else {
      const want = usStateOf(lead.localState || lead.location);
      const have = usStateOf(c.location);
      if (!want || !have) pts += part('location', 'Location', 4, 10, 'Location not known');
      else if (want === have) { pts += part('location', 'Location', 10, 10); reasons.push(`Same state (${have})`); }
      else if (RELOCATE_YES.test(String(c.relocation || '').trim())) { pts += part('location', 'Location', 7, 10); reasons.push('Open to relocate'); }
      else {
        // Onsite or hybrid in another state and the consultant will not relocate: not a match.
        part('location', 'Location', 0, 10);
        blockers.push(`location (${want}, no relocation)`); missing.push(`location (${want})`);
      }
    }

    // Experience (8): years asked in the post vs the consultant's; unknown is neutral-low.
    const need = leadYears(hay);
    const yrs = parseFloat(c.experienceYears);
    if (!need || !(yrs > 0)) pts += part('experience', 'Experience', 3, 8, 'Years not known');
    else if (yrs >= need) { pts += part('experience', 'Experience', 8, 8); reasons.push(`${Math.round(yrs)}+ yrs`); }
    else if (yrs >= need - 2) pts += part('experience', 'Experience', 4, 8, `Post asks ${need}+ years`);
    else { pts += part('experience', 'Experience', 1, 8); missing.push(`experience (needs ${need}+)`); }

    // Visa (7): the post's visa rules against the consultant's visa.
    const visa = postVisaFit(lead, visaType);
    const vName = visaType.toUpperCase();
    if (visa === 'fits') { pts += part('visa', 'Visa', 7, 7); reasons.push(`Visa ${vName} ok`); }
    else if (visa === 'open') pts += part('visa', 'Visa', 5, 7);
    else if (visa === 'out') { part('visa', 'Visa', 0, 7); blockers.push(`visa (post does not take ${vName})`); }
    else pts += part('visa', 'Visa', 2, 7, 'Visa not known');

    // Tax terms (5): C2C / W2 / 1099 stated and fitting the consultant's terms.
    pts += part('terms', 'Terms', eng.known ? 5 : 2, 5, eng.known ? '' : 'Terms not stated');
    if (eng.known && eng.chip) reasons.push(eng.chip);

    // Rate (5): only scored when both the post's hourly rate and the consultant's rate are known.
    const postRate = postHourlyRate(lead);
    const myRate = parseRate(c.rate);
    if (postRate === null || myRate === null) pts += part('rate', 'Rate', 2, 5, 'Rate not known');
    else if (postRate >= myRate) { pts += part('rate', 'Rate', 5, 5); reasons.push(`Rate fits (up to $${postRate}/h)`); }
    else if (postRate >= myRate * 0.9) { pts += part('rate', 'Rate', 2, 5); missing.push(`rate (post pays up to $${postRate}/h)`); }
    else { part('rate', 'Rate', 0, 5); missing.push(`rate (post pays up to $${postRate}/h)`); }

    // Recency (8): newer posts rank higher; unknown age is neutral-low.
    const age = requirementAgeMs(lead, now);
    const days = Number.isFinite(age) ? age / POOL_DAY_MS : NaN;
    if (!Number.isFinite(days)) pts += part('recency', 'Posted', 3, 8, 'Post date not known');
    else if (days <= 2) { pts += part('recency', 'Posted', 8, 8); reasons.push('Posted in the last 2 days'); }
    else if (days <= 7) pts += part('recency', 'Posted', 6, 8);
    else if (days <= 14) pts += part('recency', 'Posted', 3, 8);
    else pts += part('recency', 'Posted', 0, 8, 'Older than 14 days');

    let percent = Math.max(0, Math.min(100, Math.round(pts)));
    if (blockers.length) percent = Math.min(percent, MATCH_THRESHOLD - 1);
    percent = Math.min(percent, capAt);
    const look = needsLookWhy(lead, postNeeds.length);
    if (look) percent = Math.min(percent, STRONG_MATCH - 1);   // an unclear post is never a strong match
    const out = { consultant: c, score: percent, percent, matchedSkills, titleMatch, reasons, missing, blockers, breakdown };
    if (look) { out.needsLook = true; out.needsLookWhy = look; }
    if (percent < MATCH_THRESHOLD || blockers.length) {
      if (!explain) return null;
      out.blocked = true;
    }
    return out;
  }

  // Returns [{ consultant, score, percent, matchedSkills, titleMatch, reasons, missing }] best first, only
  // matches at or above MATCH_THRESHOLD. score === percent (it used to be a count of shared skills).
  function matchConsultants(lead, consultants) {
    if (!lead) return [];
    return (consultants || [])
      .filter(c => isMatchable(c))
      .map(c => scoreMatch(lead, c))
      .filter(Boolean)
      .sort((a, b) => b.percent - a.percent);
  }

  // ── Pitch email templates ────────────────────────────────────────────────
  function firstNameOf(name) {
    const n = (name || '').trim();
    if (!n || /^recruiter/i.test(n)) return 'there';
    return n.split(/\s+/)[0];
  }

  // consultant is optional; its variables are blank when no consultant is chosen.
  function fillTemplate(text, lead, myName, consultant) {
    const c = consultant || {};
    const vars = {
      firstName: firstNameOf(lead.recruiterName),
      recruiterName: lead.recruiterName || '',
      company: lead.companyName && lead.companyName !== 'Staffing Partner' ? lead.companyName : 'your team',
      requirement: lead.requirement || 'open',
      location: lead.location && lead.location !== 'United States' ? `(${lead.location})` : '',
      technologies: lead.technologies || 'IT',
      myName: myName || '',
      consultantName: c.name || '',
      consultantTitle: c.title || '',
      consultantSkills: c.skills || '',
      consultantExperience: c.experienceYears ? `${c.experienceYears}+ years` : '',
      consultantVisa: visaLabel(c),
      consultantRate: c.rate || '',
      consultantLocation: c.location || '',
      consultantAvailability: availabilityText(c, todayStr()) || c.availability || '',
      consultantResume: c.resumeUrl || ''
    };
    return String(text || '')
      .replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m))
      .replace(/[ \t]+([,.)])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function buildComposeUrl(client, to, subject, body) {
    const e = encodeURIComponent;
    if (client === 'outlook') {
      return `https://outlook.office.com/mail/deeplink/compose?to=${e(to)}&subject=${e(subject)}&body=${e(body)}`;
    }
    if (client === 'mailto') {
      return `mailto:${e(to)}?subject=${e(subject)}&body=${e(body)}`;
    }
    return `https://mail.google.com/mail/?view=cm&fs=1&to=${e(to)}&su=${e(subject)}&body=${e(body)}`;
  }

  // Template used by "Pitch" (consultant=false) or "Submit consultant" (consultant=true).
  // "Submit" always uses the 'consultant' template when present; for plain Pitch a plan that
  // allows one template always uses the first, whatever is stored.
  function pickTemplate(templates, activeTemplateId, tier, consultant) {
    const list = Array.isArray(templates) && templates.length ? templates : DEFAULT_TEMPLATES;
    if (consultant) {
      const c = list.find(t => t.id === 'consultant') || DEFAULT_TEMPLATES.find(t => t.id === 'consultant');
      if (c) return c;
    }
    const max = limit(tier, 'templates');
    if (max <= 1) return list[0];
    const idx = list.findIndex(t => t.id === activeTemplateId);
    return idx !== -1 && idx < max ? list[idx] : list[0];
  }

  // ── Pitch messages from the bench (template-based, offline, no AI) ───────
  // BP.pitchMessages(consultant, { lead, firstName, role, myName }) -> { connection, dm, hotlist }
  //   connection: LinkedIn connection note, never more than PITCH_CONNECTION_LIMIT characters; facts are
  //               dropped lowest-priority first, never mid-word.
  //   dm:         3-5 short lines for a 1st-degree recruiter.
  //   hotlist:    one line for posts / WhatsApp groups.
  // Empty consultant fields are omitted. With no lead/firstName the greeting is "Hi there,".
  const PITCH_CONNECTION_LIMIT = 200;

  function pitchClean(v, max) {
    const s = String(v == null ? '' : v).replace(/\{\w*\}/g, ' ').replace(/\s+/g, ' ').trim();
    return max ? pitchClip(s, max) : s;
  }

  // Cut at a word boundary, never mid-word.
  function pitchClip(s, max) {
    if (s.length <= max) return s;
    const cut = s.slice(0, max + 1);
    const sp = cut.lastIndexOf(' ');
    return (sp > 0 ? cut.slice(0, sp) : cut.slice(0, max)).replace(/[\s,;:|\-–(]+$/, '');
  }

  function pitchArticle(word) {
    const w = String(word || '').split(/\s+/)[0];
    if (!w) return 'a';
    if (/^[A-Z0-9]{2,5}$/.test(w)) return /^[AEFHILMNORSX]/.test(w) ? 'an' : 'a';
    return /^[aeiou]/i.test(w) && !/^(uni|use|eur|one)/i.test(w) ? 'an' : 'a';
  }

  function pitchExperience(v) {
    const s = pitchClean(v, 20);
    if (!s) return '';
    if (/^\d+(\.\d+)?$/.test(s)) return `${s}+ yrs`;
    if (/^\d+\s*-\s*\d+$/.test(s)) return `${s.replace(/\s+/g, '')} yrs`;
    return /[a-z]/i.test(s) ? s : `${s} yrs`;
  }

  function pitchAvailability(v) {
    const s = pitchClean(v, 40);
    if (!s) return '';
    if (/^(immediate|now|asap)/i.test(s)) return 'Available now';
    if (/^available/i.test(s)) return s.charAt(0).toUpperCase() + s.slice(1);
    return /^\d/.test(s) ? `Available in ${s}` : `Available ${s}`;
  }

  function pitchLocation(c, withReloc) {
    const loc = pitchClean(c.location, 60);
    if (!loc || !withReloc) return loc;
    const r = String(c.relocation || '').trim().toLowerCase();
    if (r === 'yes') return `${loc} (open to relocate)`;
    if (r === 'negotiable') return `${loc} (relocation negotiable)`;
    return loc;
  }

  function pitchMessages(consultant, opts) {
    const c = consultant || {};
    const o = opts || {};
    const lead = o.lead || {};
    const fn = pitchClean(o.firstName, 30) || (lead.recruiterName ? pitchClean(firstNameOf(pitchClean(lead.recruiterName, 80)), 30) : '');
    const first = fn && !/^(there|recruiter)$/i.test(fn) ? fn : 'there';
    const greet = `Hi ${first},`;
    const role = pitchClean(o.role || lead.requirement, 60);
    const me = pitchClean(o.myName, 40);
    const title = pitchClean(c.title, 80) || 'consultant';
    const exp = pitchExperience(c.experienceYears);
    const visa = pitchClean(visaLabel(c), 20);
    const avail = availabilityText(c, o.today || todayStr()) || pitchAvailability(c.availability);
    const rate = pitchClean(c.rate, 60);
    const eng = ((rate.match(/\b(C2C|W2|1099|C2H)\b/i) || [])[1] || '').toUpperCase();
    const skillList = splitSkills(pitchClean(c.skills));

    // Hotlist: Title | exp | visa | location | engagement | availability
    const hotlist = [title === 'consultant' ? 'Consultant' : title, exp, visa, pitchLocation(c, true), eng, avail]
      .filter(Boolean).join(' | ');

    // Connection note: pieces are dropped in this order until it fits (highest priority kept longest).
    const parts = { sign: Boolean(me), closing: true, skills: true, role: Boolean(role), eng: true, reloc: true, avail: true, exp: true, visa: true, loc: true };
    const drop = ['sign', 'closing', 'skills', 'role', 'eng', 'reloc', 'avail', 'exp', 'visa', 'loc'];
    const build = (p, ttl) => {
      const facts = [p.exp ? exp : '', p.visa ? visa : '', p.loc ? pitchLocation(c, p.reloc) : '', p.eng ? eng : '',
        p.avail ? avail : '', p.skills ? skillList.slice(0, 3).join(', ') : ''].filter(Boolean);
      let s = `${greet} I have ${pitchArticle(ttl)} ${ttl}`;
      if (p.role) s += ` for your ${role} role`;
      if (facts.length) s += `: ${facts.join(' | ')}`;
      s += '.';
      if (p.closing) s += ' Happy to share the profile.';
      if (p.sign) s += ` - ${me}`;
      return s;
    };
    let connection = build(parts, title);
    for (let i = 0; i < drop.length && connection.length > PITCH_CONNECTION_LIMIT; i++) {
      parts[drop[i]] = false;
      connection = build(parts, title);
    }
    // Only greeting + title remain: shorten the title at a word boundary.
    let max = title.length;
    while (connection.length > PITCH_CONNECTION_LIMIT && max > 1) {
      max = Math.max(1, max - Math.max(1, connection.length - PITCH_CONNECTION_LIMIT));
      connection = build(parts, pitchClip(title, max) || 'consultant');
    }
    if (connection.length > PITCH_CONNECTION_LIMIT) connection = pitchClip(connection, PITCH_CONNECTION_LIMIT);

    // Short DM: greeting, intro, key facts, skills / rate, closing.
    const a = pitchArticle(title);
    const lines = [greet];
    lines.push(role
      ? `I have ${a} ${title} on the bench who fits your ${role} requirement.`
      : `I have ${a} ${title} available on the bench.`);
    const dmFacts = [exp, visa, pitchLocation(c, true), rate ? '' : eng, avail].filter(Boolean).join(' | ');
    if (dmFacts) lines.push(dmFacts);
    const extra = [skillList.length ? `Key skills: ${skillList.slice(0, 6).join(', ')}.` : '', rate ? `Rate: ${rate}.` : ''].filter(Boolean).join(' ');
    if (extra) lines.push(extra);
    lines.push(`Can I send the profile?${me ? ` Thanks, ${me}` : ''}`);

    return { connection, dm: lines.join('\n'), hotlist };
  }

  // ══ Quick notes (v1.5, issue #10) ═══════════════════════════════════════════
  // Saved text snippets reused all day. Stored as chrome.storage.local.quickNotes:
  //   [{ id, title (<=40), text (<=2000), createdAt, updatedAt, order }]
  // Pure helpers only; the service worker (single writer) and the UI call these.
  const QUICK_NOTE_TITLE_MAX = 40;
  const QUICK_NOTE_TEXT_MAX = 2000;

  const DEFAULT_QUICK_NOTES = [
    { title: 'Intro',
      text: 'Hi {firstName}, this is {myName}. I work with a bench of vetted consultants and would love to be on your vendor list for upcoming requirements. Happy to share profiles that match what you are hiring for. Thanks!' },
    { title: 'Hotlist line',
      text: 'Available consultants: [Role] | [Skills] | [Visa] | [Location] | [Rate]. Profiles ready to submit. Please reply with your requirement and I will send a resume today.' },
    { title: 'Follow-up',
      text: 'Hi {firstName}, following up on my earlier note. Do you have any open requirements my consultants could help with? I can send matching profiles right away. Thanks, {myName}' }
  ];

  function clipStr(v, max) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max); }

  // Clips and trims user input. Title is single-line.
  function sanitizeQuickNote(input) {
    const n = input || {};
    return {
      title: clipStr(n.title, QUICK_NOTE_TITLE_MAX).replace(/\s*\n\s*/g, ' '),
      text: clipStr(n.text, QUICK_NOTE_TEXT_MAX)
    };
  }

  // -> { ok: true, note: { title, text } } or { ok: false, error }
  function validateQuickNote(input) {
    const note = sanitizeQuickNote(input);
    if (!note.title) return { ok: false, error: 'Give the note a title.' };
    if (!note.text) return { ok: false, error: 'The note text is empty.' };
    return { ok: true, note };
  }

  // Adding is blocked at the plan limit; existing notes stay usable after a downgrade.
  function canAddQuickNote(tier, count) {
    return (Number(count) || 0) < limit(tier, 'quickNotes');
  }

  // "2 of 3 on Free" or "5 notes on Pro" (unlimited)
  function quickNoteUsageText(tier, count) {
    const n = Number(count) || 0;
    const max = limit(tier, 'quickNotes');
    return Number.isFinite(max)
      ? `${n} of ${max} on ${tierLabel(tier)}`
      : `${n} note${n === 1 ? '' : 's'} on ${tierLabel(tier)}`;
  }

  function quickNoteLimitMessage(tier) {
    const t = tierOf(tier);
    return isFullPlan(t)
      ? 'You have reached the quick notes limit.'
      : `The ${tierLabel(t)} plan includes ${limit(t, 'quickNotes')} quick notes. Upgrade to ${tierLabel(SELL_TIER)} for unlimited notes.`;
  }

  // Record ids: prefix + time (base 36) + 10 characters from crypto.getRandomValues (about 51 bits). Before, ids used 4 characters
  // of Math.random, so two records made in the same millisecond could share an id (a test caught it at random). Every id
  // generator in the extension uses this one function.
  const ID_ABC = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function randomIdPart(n) {
    const bytes = new Uint8Array(Math.max(1, Math.min(32, Number(n) || 10)));
    root.crypto.getRandomValues(bytes);
    let r = '';
    for (const b of bytes) r += ID_ABC[b % 36];
    return r;
  }
  function newId(prefix) { return String(prefix || '') + Date.now().toString(36) + randomIdPart(10); }
  function newQuickNoteId() { return newId('qn'); }

  // Seed notes for a first run (only used when quickNotes is absent in storage).
  function defaultQuickNotes(now) {
    const at = now || new Date().toISOString();
    return DEFAULT_QUICK_NOTES.map((n, i) => ({
      id: 'qn-default-' + (i + 1), title: n.title, text: n.text, createdAt: at, updatedAt: at, order: i
    }));
  }

  // Sorted by order (stable), tolerant of junk. Always returns a new array.
  function sortQuickNotes(list) {
    return (Array.isArray(list) ? list : [])
      .filter(n => n && typeof n === 'object' && n.id)
      .map((n, i) => ({ n, i }))
      .sort((a, b) => ((Number(a.n.order) || 0) - (Number(b.n.order) || 0)) || (a.i - b.i))
      .map(x => x.n);
  }

  // Re-numbers order 0..n-1 following the array order.
  function renumberQuickNotes(list) {
    return list.map((n, i) => ({ ...n, order: i }));
  }

  // dir: -1 (up) or 1 (down). Returns the renumbered list (same order at the edges).
  function moveQuickNote(list, id, dir) {
    const sorted = sortQuickNotes(list);
    const i = sorted.findIndex(n => n.id === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i === -1 || j < 0 || j >= sorted.length) return renumberQuickNotes(sorted);
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
    return renumberQuickNotes(sorted);
  }

  // Applies an explicit id order; ids not listed keep their relative order at the end.
  function reorderQuickNotes(list, ids) {
    const sorted = sortQuickNotes(list);
    const byId = new Map(sorted.map(n => [n.id, n]));
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
    }
    for (const n of sorted) if (byId.has(n.id)) out.push(n);
    return renumberQuickNotes(out);
  }

  // Fills only the placeholders we actually know; anything unknown stays visible as {token}.
  // ctx: { recruiterName, firstName, company, myName }
  function fillQuickNote(text, ctx) {
    const c = ctx || {};
    const recruiter = String(c.recruiterName || '').trim();
    const known = /^recruiter/i.test(recruiter) ? '' : recruiter;
    const vars = {
      firstName: String(c.firstName || (known ? firstNameOf(known) : '')).trim(),
      recruiterName: known,
      company: String(c.company || '').trim(),
      myName: String(c.myName || '').trim()
    };
    return String(text == null ? '' : text).replace(/\{(\w+)\}/g, (m, key) => (vars[key] ? vars[key] : m));
  }

  // Resolves to the worker's response, or {} if the extension was reloaded / unreachable.
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError;
          resolve(response || {});
        });
      } catch (_) {
        resolve({});
      }
    });
  }

  // ── Vendors view helpers (v1.5) ──────────────────────────────────────────
  // Pure functions behind the dashboard "Vendors" view. They never touch storage or the DOM.
  // `leads` and `companies` are the arrays saved by the service worker (see lib/migrations.js).

  // Latest of a lead's lastContactDate (YYYY-MM-DD) and savedAt (ISO), as epoch ms; 0 when neither is valid.
  function leadActivityTime(lead) {
    let best = 0;
    for (const v of [lead && lead.lastContactDate, lead && lead.savedAt]) {
      const t = typeof v === 'string' && v ? Date.parse(v) : NaN;
      if (!isNaN(t) && t > best) best = t;
    }
    return best;
  }

  // One row per company: { company, leads, count, bounced, lastActivity }.
  // Leads are indexed by companyId once (O(leads + companies)); rows keep the order of `companies`.
  function companyStats(companies, leads) {
    const byCompany = new Map();
    for (const l of leads || []) {
      const id = l && l.companyId;
      if (typeof id !== 'string' || !id) continue;
      let arr = byCompany.get(id);
      if (!arr) { arr = []; byCompany.set(id, arr); }
      arr.push(l);
    }
    return (companies || []).map((company) => {
      const own = byCompany.get(company.id) || [];
      let last = 0, bounced = 0;
      for (const l of own) {
        const t = leadActivityTime(l);
        if (t > last) last = t;
        if (l.bounced) bounced++;
      }
      return { company, leads: own, count: own.length, bounced, lastActivity: last };
    });
  }

  // Case-insensitive match on name, domain and aliases. An empty query matches everything.
  function companyMatchesQuery(company, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    if (String(company.name || '').toLowerCase().includes(q)) return true;
    if (String(company.domain || company.id || '').toLowerCase().includes(q)) return true;
    return (company.aliases || []).some((a) => String(a).toLowerCase().includes(q));
  }

  // opts: { query, label ('' = any, else a label key), showEmpty (default false) }
  function filterCompanyRows(rows, opts) {
    const o = opts || {};
    return (rows || []).filter((r) => {
      if (!o.showEmpty && r.count === 0) return false;
      if (o.label && (r.company.label || 'none') !== o.label) return false;
      return companyMatchesQuery(r.company, o.query);
    });
  }

  // key: 'name' (A-Z) | 'recruiters' (most first) | 'activity' (newest first). Ties fall back to name.
  // Returns a new array.
  function sortCompanyRows(rows, key) {
    const byName = (a, b) => String(a.company.name || '').localeCompare(String(b.company.name || ''), undefined, { sensitivity: 'base' });
    const cmp = key === 'recruiters' ? (a, b) => b.count - a.count || byName(a, b)
      : key === 'activity' ? (a, b) => b.lastActivity - a.lastActivity || byName(a, b)
      : byName;
    return (rows || []).slice().sort(cmp);
  }

  // ── Rate and margin calculator (pure math, USD per hour) ────────────────
  // Margin per hour = bill - pay x (1 + burden, W2 only) - bill x fee% - fixed.
  // Values stay unrounded here; round to cents only when showing them.
  const RATE_TYPES = ['W2', '1099', 'C2C'];
  const RATE_DEFAULTS = { type: 'C2C', pay: 0, bill: 0, burdenPct: 15, feePct: 0, fixed: 0, hours: 160, targetPct: 20 };

  function rateNum(v, fallback) {
    if (typeof v === 'string') v = v.replace(/[$,%\s]/g, '');
    if (v === '' || v === null || v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function rateInputs(input) {
    const i = input || {};
    const type = RATE_TYPES.includes(String(i.type).toUpperCase()) ? String(i.type).toUpperCase() : 'C2C';
    return {
      type,
      pay: Math.max(0, rateNum(i.pay, 0)),
      bill: Math.max(0, rateNum(i.bill, 0)),
      burden: type === 'W2' ? Math.max(0, rateNum(i.burdenPct, RATE_DEFAULTS.burdenPct)) / 100 : 0,
      fee: Math.max(0, rateNum(i.feePct, 0)) / 100,
      fixed: Math.max(0, rateNum(i.fixed, 0)),
      hours: Math.max(0, rateNum(i.hours, RATE_DEFAULTS.hours)),
      target: rateNum(i.targetPct, RATE_DEFAULTS.targetPct) / 100
    };
  }

  // Returns { valid, marginHr, marginPct, monthly, payCost, feeCost }; valid is false when the bill rate is empty or zero.
  function rateMargin(input) {
    const r = rateInputs(input);
    if (!(r.bill > 0)) return { valid: false, marginHr: 0, marginPct: 0, monthly: 0, payCost: 0, feeCost: 0 };
    const payCost = r.pay * (1 + r.burden);
    const feeCost = r.bill * r.fee;
    const marginHr = r.bill - payCost - feeCost - r.fixed;
    return { valid: true, marginHr, marginPct: (marginHr / r.bill) * 100, monthly: marginHr * r.hours, payCost, feeCost };
  }

  // Highest pay rate that still gives the target margin % of the bill rate. Null when the bill rate is empty or zero,
  // or when the target cannot be reached even at a pay rate of zero.
  function maxPayForMargin(input) {
    const r = rateInputs(input);
    if (!(r.bill > 0) || r.target >= 1) return null;
    const pay = (r.bill * (1 - r.fee - r.target) - r.fixed) / (1 + r.burden);
    return pay > 0 ? pay : null;
  }

  // Pulls an hourly rate out of free text like "$65/hr", "65", "65 C2C", "$60-70/hr" (takes the low end).
  // Ignores annual or monthly figures and anything unparseable. Returns a number or null.
  function parseRate(text) {
    const t = String(text === null || text === undefined ? '' : text).toLowerCase();
    if (!t.trim()) return null;
    if (/(\/\s*(yr|year|annum|mo|month)|\bper\s*(year|annum|month)|\d\s*k\b|\blpa\b|annual)/.test(t)) return null;
    const m = /(\d{1,3}(?:\.\d{1,2})?)(?![\d,])/.exec(t.replace(/(\d),(?=\d{3})/g, '$1'));
    if (!m) return null;
    const n = Number(m[1]);
    return n > 0 && n < 1000 ? n : null;
  }

  // ── Who owns an email? (v1.6.1) ──────────────────────────────────────────
  // Bench sellers re-post other vendors' requirements in C2C groups, so the person who posted is not
  // always the person whose email is in the post. These pure helpers decide, from names and companies
  // only, whether the poster is plausibly the owner of an email. Nothing here reads the DOM.
  const NAME_TITLE_WORDS = new Set(['mr', 'mrs', 'ms', 'dr', 'jr', 'sr', 'ii', 'iii', 'phd', 'pmp', 'mba']);
  // Mailbox words: an address made only of these (hr@, jobs@, recruiting@) belongs to a team, not a person.
  const GENERIC_LOCAL_WORDS = new Set(['hr', 'jobs', 'job', 'careers', 'career', 'recruiter', 'recruiters', 'recruiting',
    'recruitment', 'talent', 'hiring', 'staffing', 'resumes', 'resume', 'cv', 'info', 'admin', 'sales', 'bench', 'team',
    'hello', 'contact', 'support', 'office', 'mail', 'apply', 'applications', 'bd', 'vendor', 'vendors', 'requirements',
    'req', 'reqs', 'ta', 'benchsales', 'marketing', 'usa', 'india', 'it', 'consultant', 'consultants', 'c2c', 'ops',
    'payroll', 'accounts', 'billing', 'noreply', 'donotreply', 'us', 'professionals', 'candidates', 'submissions']);
  // Words that carry no brand in a company name ("TEKSOLVE IT SOLUTIONS LLC" is just "teksolve").
  const COMPANY_NOISE_WORDS = new Set(['inc', 'llc', 'llp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
    'solutions', 'solution', 'technologies', 'technology', 'tech', 'it', 'group', 'services', 'service', 'consulting',
    'consultants', 'systems', 'global', 'usa', 'us', 'india', 'pvt', 'private', 'staffing', 'software', 'infotech',
    'info', 'labs', 'international', 'enterprises', 'partners', 'talent', 'and', 'the', 'of']);
  const COMPANY_NOISE_SUFFIXES = ['solutions', 'solution', 'technologies', 'technology', 'consulting', 'services', 'systems',
    'software', 'infotech', 'staffing', 'global', 'group', 'corp', 'tech', 'inc', 'llc', 'ltd', 'usa'];

  function nameTokens(name) {
    let s = String(name || '');
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) { /* old engines keep the accents */ }
    return s.toLowerCase().split(/[^a-z]+/).filter(t => t && !NAME_TITLE_WORDS.has(t));
  }

  // "Mdayaz.Ahmad+jobs12@nityo.com" -> ['mdayaz', 'ahmad']
  function emailLocalParts(email) {
    const s = String(email || '').trim().toLowerCase();
    const at = s.lastIndexOf('@');
    const local = (at === -1 ? s : s.slice(0, at)).split('+')[0];
    return local.split(/[._\-]+/).map(p => p.replace(/[^a-z]/g, '')).filter(Boolean);
  }

  // Does `part` (one piece of an email local part) stand for the name token `tok`?
  // Equal, a nickname-style prefix ("ravi" of "ravindra") or the other way round ("krishnan" for "krishna").
  function partMatchesToken(part, tok) {
    if (!part || !tok) return false;
    if (part === tok) return true;
    if (part.length === 1) return part === tok[0];
    if (part.length >= 3 && tok.length > part.length && tok.startsWith(part)) return true;
    if (tok.length >= 4 && part.length > tok.length && part.startsWith(tok)) return true;
    return false;
  }

  // True when the email's local part reads as this person's name: first, last, first+last, f+last,
  // last+f, first.last (any order), digits and separators ignored, a team word such as "hr" tolerated.
  function emailMatchesName(email, name) {
    const tokens = nameTokens(name);
    if (!tokens.length) return false;
    let parts = emailLocalParts(email);
    if (!parts.length) return false;
    const trimmed = parts.filter(p => !GENERIC_LOCAL_WORDS.has(p));
    if (trimmed.length) parts = trimmed;
    else return false;   // only team words: that is a shared mailbox, not this person
    const joined = parts.join('');

    const cand = new Set();
    for (const t of tokens) if (t.length >= 2) cand.add(t);
    const use = tokens.slice(0, 4);
    if (use.length >= 2) cand.add(use.map(t => t[0]).join(''));   // initials in name order: "ps" for Priya Sharma
    for (let i = 0; i < use.length; i++) {
      for (let j = 0; j < use.length; j++) {
        if (i === j) continue;
        cand.add(use[i] + use[j]);
        cand.add(use[i][0] + use[j]);
        cand.add(use[i] + use[j][0]);
      }
    }
    if (cand.has(joined)) return true;
    if (parts.length === 1) return tokens.some(t => t.length >= 3 && partMatchesToken(parts[0], t));
    return parts.every(p => tokens.some(t => partMatchesToken(p, t)));
  }

  // Loose version for cleanup: ANY piece of the address (3+ letters) resembling any name token.
  function emailNameOverlap(email, name) {
    const tokens = nameTokens(name);
    return emailLocalParts(email).some(p => p.length >= 3 && tokens.some(t => t.length >= 3 && partMatchesToken(p, t)));
  }

  // An address that looks like a person (mdayaz.ahmad@, nayak@) and not a team box (hr@, jobs@, recruiting@).
  function emailLooksPersonal(email) {
    const parts = emailLocalParts(email).filter(p => !GENERIC_LOCAL_WORDS.has(p));
    return parts.length > 0 && parts.every(p => p.length >= 2) && parts.join('').length >= 3;
  }

  // Registrable label of a domain: "mail.nityo.com" -> "nityo", "acme.co.uk" -> "acme".
  function domainBrand(domain) {
    const labels = String(domain || '').trim().toLowerCase().split('.').filter(Boolean);
    if (labels.length < 2) return labels[0] || '';
    let i = labels.length - 2;
    if (i >= 1 && ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'].includes(labels[i]) && labels[labels.length - 1].length === 2) i--;
    return labels[i];
  }

  function brandKey(brand) {
    let b = String(brand || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (let n = 0; n < 3; n++) {
      const suf = COMPANY_NOISE_SUFFIXES.find(s => b.length - s.length >= 3 && b.endsWith(s));
      if (!suf) break;
      b = b.slice(0, -suf.length);
    }
    return b;
  }

  function companyKeys(company) {
    const tokens = String(company || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !COMPANY_NOISE_WORDS.has(t));
    if (!tokens.length) return [];
    const keys = [tokens.join(''), tokens[0]];
    if (tokens.length > 1) keys.push(tokens[0] + tokens[1]);
    return [...new Set(keys.filter(k => k.length >= 3))];
  }

  // Does this email domain belong to this company name? Free-mail never matches.
  function domainMatchesCompany(domain, company) {
    if (!domain || isFreeMailDomain(domain)) return false;
    const brand = brandKey(domainBrand(domain));
    if (brand.length < 3) return false;
    return companyKeys(company).some(k => k === brand || (Math.min(k.length, brand.length) >= 4 && (k.startsWith(brand) || brand.startsWith(k))));
  }

  // "US IT Bench Sales Recruiter at TEKSOLVE IT SOLUTIONS LLC | Hiring" -> "TEKSOLVE IT SOLUTIONS LLC"
  function companyFromHeadline(headline) {
    const s = String(headline || '');
    let last = '';
    const re = /(?:\bat\b|@)\s+([^|•·,;()]+)/gi;
    let m;
    while ((m = re.exec(s))) last = m[1].trim();
    return last.length > 1 ? last.slice(0, 120) : '';
  }

  // The decision: is this email plausibly the poster's own?
  //   { email, authorName, authorHeadline, authorCompany, sigName }
  // Owned when the address reads as the poster's name, or (business domains only) the domain's brand
  // matches the poster's company (from authorCompany or "... at X" in the headline). A signature name
  // next to the email that fits the address but not the poster means the email is somebody else's.
  function emailOwnedByAuthor(input) {
    const i = input || {};
    const email = String(i.email || '').trim().toLowerCase();
    if (!email) return false;
    const authorOk = emailMatchesName(email, i.authorName);
    if (i.sigName && !authorOk && emailMatchesName(email, i.sigName)) return false;
    if (authorOk) return true;
    const domain = emailDomain(email);
    const business = Boolean(domain) && !isFreeMailDomain(domain);
    const companies = [i.authorCompany, companyFromHeadline(i.authorHeadline)].filter(Boolean);
    if (business && companies.some(c => domainMatchesCompany(domain, c))) return true;

    // The poster signed right next to the email ("Ravi Kumar / rk123@gmail.com"): their own address, even
    // when it doesn't read as their name. Not when the address spells out someone else's full name, or is
    // another company's domain: then the poster's sign-off only sits near a re-shared email.
    if (samePersonName(i.sigName, i.authorName)) {
      if (emailNamesSomeoneElse(email, i.authorName)) return false;
      if (business && companies.length) return false;
      return true;
    }
    return false;
  }

  // Both names are the same person: the shorter one (2+ name parts) is wholly inside the longer one.
  function samePersonName(a, b) {
    const ta = nameTokens(a).filter(t => t.length >= 2);
    const tb = nameTokens(b).filter(t => t.length >= 2);
    if (!ta.length || !tb.length) return false;
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    return short.length >= 2 && short.every(t => long.includes(t));
  }

  // "mdayaz.ahmad@" reads as a full name (two 3+ letter parts) with nothing in common with this person.
  function emailNamesSomeoneElse(email, name) {
    const parts = emailLocalParts(email).filter(p => !GENERIC_LOCAL_WORDS.has(p) && p.length >= 3);
    return parts.length >= 2 && !emailNameOverlap(email, name);
  }

  // "mdayaz.ahmad@nityo.com" -> "Mdayaz Ahmad"; a team mailbox (hr@, jobs@) -> '' (a team has no person's name).
  function nameFromEmail(email) {
    const username = String(email || '').split('@')[0];
    if (!username) return 'Recruiter Lead';
    if (isTeamMailbox(email)) return '';
    const parts = username.split(/[._\-]/).filter(p => p.length > 0 && !/^\d+$/.test(p));
    if (parts.length > 0) return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
    return username.charAt(0).toUpperCase() + username.slice(1);
  }

  // "nityo.com" -> "Nityo" (null for free-mail / invalid)
  function companyNameFromDomain(domain) {
    const d = String(domain || '').trim().toLowerCase();
    if (!d || isFreeMailDomain(d)) return '';
    const b = domainBrand(d);
    return b ? b.charAt(0).toUpperCase() + b.slice(1) : '';
  }

  // Who the saved contact is, given a post and its poster. Pure so it is unit-tested; content.js feeds it
  // what it read from the page. `author` = { name, headline, company, linkedinUrl, sigName, sigTitle, sigCompany, sigPhone,
  // posterHeadline, posterCompany }. `extractPhone(text)` finds a phone number in a piece of text.
  // -> { owned, recruiterName, companyName, designation, headline, phone, profileUrl, sharedBy|null }
  function attributeEmailContact(input) {
    const i = input || {};
    const email = String(i.email || '').trim();
    const author = i.author || {};
    const text = String(i.postText || '');
    const phoneOf = typeof i.extractPhone === 'function' ? i.extractPhone : () => '';
    const domain = emailDomain(email);
    const multi = Boolean(i.multi);
    const profileOk = /linkedin\.com\/(?:in|company)\//i.test(author.linkedinUrl || '');
    const owned = !multi && emailOwnedByAuthor({
      email,
      authorName: author.name,
      authorHeadline: author.posterHeadline !== undefined ? author.posterHeadline : author.headline,
      authorCompany: author.posterCompany,
      sigName: author.sigName
    });
    const sigLooksLikeName = (n) => root.BP && typeof root.BP.looksLikePersonName === 'function' ? root.BP.looksLikePersonName(n) : /^\S+\s+\S+/.test(n);

    if (owned) {
      return { owned: true, sharedBy: null, profileUrl: profileOk ? author.linkedinUrl : '' };
    }

    // The email belongs to someone else (a re-post, a vendor list, a group thread): never the poster's details.
    let recruiterName = '';
    const sig = cleanPersonName(author.sigName);
    const sigIsPoster = sig && nameTokens(author.name).length && nameTokens(sig).every(t => nameTokens(author.name).includes(t));
    if (sig && !sigIsPoster && sigLooksLikeName(sig)) recruiterName = sig;
    if (!recruiterName) recruiterName = nameFromEmail(email);

    const companyName = companyNameFromDomain(domain) || author.sigCompany || 'Staffing Partner';
    const sigTitle = String(author.sigTitle || '').trim();

    // Phone: only one printed on the same line as this email (the poster's own number is often elsewhere).
    let phone = author.sigPhone || '';
    if (!phone) {
      const lower = email.toLowerCase();
      const line = text.split(/\r?\n/).find(l => l.toLowerCase().includes(lower));
      if (line) phone = phoneOf(line) || '';
    }

    let sharedBy = null;
    const posterName = cleanPersonName(author.name);
    if (!multi && posterName && posterName !== 'Recruiter Lead') {
      sharedBy = {
        name: posterName,
        headline: String(author.posterHeadline !== undefined ? author.posterHeadline : author.headline || '').trim().slice(0, 120),
        url: profileOk ? author.linkedinUrl : ''
      };
    }
    return {
      owned: false,
      recruiterName,
      companyName,
      sigTitle,
      phone: phone || '—',
      profileUrl: '',
      sharedBy
    };
  }

  // "X reposted this", "Y likes this", "Z commented on this": a header line about someone reacting to the post,
  // never the author. content.js skips profile links that sit inside such a line.
  // The feed also writes it without "this": "Riya V commented", "Asha and 2 others reacted" (22 Oct: the commenter was
  // taken for the author, so the real recruiter's post failed the recruiter check and was dropped).
  const SOCIAL_CONTEXT_RE = /\b(?:likes?|loves?|celebrates?|supports?|finds?|reposted|commented|replied|follows?|shared|reacted|is hiring|are hiring|was mentioned|mentioned)\b[^\n]{0,40}\b(?:this|in this|on this)\b|\breposted this\b|\bcommented on this\b|^[^\n]{1,80}?\s(?:commented|reposted|replied|reacted)\s*$/im;

  // A re-shared post nests the ORIGINAL post inside the re-poster's card. When the email sits in that
  // inner block, the inner block's actor is the author to look at, not the person who re-shared it.
  // `rootEl` only needs querySelectorAll() and textContent (so tests can pass plain objects).
  const RESHARE_SELECTOR = '.update-components-mini-update-v2, .feed-shared-update-v2__reshare, .update-components-reshare, .feed-shared-mini-update-v2, [class*="reshare"]';
  function pickReshareScope(rootEl, email) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return rootEl;
    const e = String(email || '').toLowerCase();
    if (!e) return rootEl;
    let inner = [];
    try { inner = Array.from(rootEl.querySelectorAll(RESHARE_SELECTOR)); } catch (_) { return rootEl; }
    for (const el of inner) {
      if (el === rootEl) continue;
      if (String(el.textContent || '').toLowerCase().includes(e)) return el;
    }
    return rootEl;
  }

  // Whitelist for lead.sharedBy: short strings, LinkedIn profile URL only. null when there is nothing usable.
  function sanitizeSharedBy(value) {
    if (!value || typeof value !== 'object') return null;
    const clipS = (v, n) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);
    const name = clipS(value.name, 80);
    if (!name) return null;
    let url = '';
    try {
      const u = new URL(String(value.url || ''));
      if (u.protocol === 'https:' && /(^|\.)linkedin\.com$/i.test(u.hostname) && /^\/(?:in|company)\//i.test(u.pathname)) {
        url = (u.origin + u.pathname).slice(0, 300);
      }
    } catch (_) { /* not a URL */ }
    return { name, headline: clipS(value.headline, 120), url };
  }

  // ── Text clean-up: HTML entities that leaked into post text ("Python &amp; SQL", "Python amp; SQL") ──
  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeEntities(text) {
    let s = String(text === undefined || text === null ? '' : text);
    if (!/&|\bamp;/i.test(s)) return s;
    for (let i = 0; i < 2; i++) {   // twice: "&amp;amp;" is double-escaped
      s = s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e) => {
        if (e[0] === '#') {
          const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
        }
        const v = NAMED_ENTITIES[e.toLowerCase()];
        return v === undefined ? m : v;
      });
    }
    // The "&" itself was lost: " amp; " between two words is an ampersand.
    return s.replace(/(^|[\s(\/])amp;(?=\s|$)/gi, '$1&');
  }

  // Does the post read like someone asking for candidates? A coarse gate only (BP.classifyPost tells requirement from hotlist).
  const HIRING_INTENT = /\b(?:hiring|we\s+are\s+looking|looking\s+for|requirements?|job\s+opening|open\s+position|c2c|corp[\s-]*to[\s-]*corp|w2|1099|share\s+(?:your\s+|the\s+)?(?:updated\s+)?(?:resume|profile|cv)s?|(?:send|forward|email|mail|drop)\s+(?:your\s+|me\s+|the\s+)?(?:updated\s+|latest\s+)?(?:resume|profile|cv)s?|(?:resume|profile|cv)s?\s+(?:to|at)|interested\s+(?:candidates|consultants|folks|professionals)|consultants?|contract\s+(?:role|position|to\s+hire)|immediate\s+(?:need|joiner)|job\s+description|must[\s-]*have\s+skills|job\s+role|required\s+skill(?:s|\s*set)?|skill\s*set\s+required)\b/i;
  function hasHiringIntent(text) {
    return HIRING_INTENT.test(decodeEntities(text));
  }

  // ── The signed-in member's own details: never captured as a lead ──
  // Identity = the profile slug(s) (detected from the page, cached locally) plus what Settings > My profile already holds.
  function slugFromProfileUrl(url) {
    const c = canonicalProfileUrl(url);
    if (!c) return '';
    try { return profileSlugFromPath(new URL(c).pathname); } catch (_) { return ''; }
  }
  function ownIdentity(myProfile, ownSlug) {
    const p = myProfile && typeof myProfile === 'object' ? myProfile : {};
    const slugs = new Set();
    const emails = new Set();
    const s1 = slugFromProfileUrl(p.linkedin);
    if (s1) slugs.add(s1);
    const s2 = String(ownSlug || '').trim().toLowerCase();
    if (/^[^\s\/?#]{1,100}$/.test(s2) && s2 !== 'me') slugs.add(s2);
    const e = normalizeEmail(p.email);
    if (e) emails.add(e);
    return { slugs, emails, empty: !slugs.size && !emails.size };
  }
  function isOwnProfileUrl(url, own) {
    const s = slugFromProfileUrl(url);
    return Boolean(s && own && own.slugs && own.slugs.has(s));
  }
  function isOwnEmail(email, own) {
    const e = normalizeEmail(email);
    return Boolean(e && own && own.emails && own.emails.has(e));
  }
  // A lead is "you" when its profile URL or its email is yours.
  function isOwnLead(lead, own) {
    if (!lead || !own || own.empty) return false;
    return isOwnProfileUrl(lead.linkedinProfile, own) || isOwnEmail(lead.email, own);
  }
  // The leads in allLeads that are the user. `keep` = emails the user chose to keep after an undo.
  function findOwnLeads(allLeads, own, keep) {
    const kept = new Set((Array.isArray(keep) ? keep : []).map(e => String(e || '').toLowerCase()));
    return (Array.isArray(allLeads) ? allLeads : []).filter(l => l && isOwnLead(l, own) && !kept.has(String(l.email || '').toLowerCase()));
  }

  root.BP = {
    decodeEntities, hasHiringIntent, slugFromProfileUrl, ownIdentity, isOwnProfileUrl, isOwnEmail, isOwnLead, findOwnLeads,
    nameTokensOf: nameTokens, emailOwnedByAuthor, emailMatchesName, emailNameOverlap, emailLooksPersonal, emailLocalParts,
    domainMatchesCompany, companyFromHeadline, nameFromEmail, companyNameFromDomain, attributeEmailContact,
    sanitizeSharedBy, SOCIAL_CONTEXT_RE, pickReshareScope,
    CFG,
    STATUSES,
    STATUS_EMOJI,
    normalizeStatus,
    DEFAULT_DESIGNATIONS,
    DEFAULT_BLACKLIST,
    FREE_EMAIL_DOMAINS,
    COMPANY_LABELS,
    COMPANY_LABEL_KEYS,
    FREE_MAIL_DOMAINS,
    emailDomain,
    isFreeMailDomain,
    companyIdForEmail,
    pickCompanyName,
    DEFAULT_TEMPLATES,
    MAX_TEMPLATES,
    MAX_CONSULTANTS,
    TIERS,
    TIER_ORDER,
    SELL_TIER,
    SELL_PLANS,
    isSellPlan,
    TIER_PRICE_INR,
    convertDays,
    isFullPlan,
    upgradeLabel,
    FEATURE_LABELS,
    planFeatureKeys,
    tierOf,
    limit,
    can,
    minTierFor,
    tierLabel,
    lockBadgeText,
    sellPriceLine,
    browserCurrency,
    offersFromMe,
    foundingSoldOut,
    lastPaymentFromMe,
    endedPlan,
    extendOffer,
    renewLabel,
    planNotice,
    EXPIRED_NOTICE_DAYS,
    FOLLOWUP_PLAN_NOTE,
    EXTEND_WINDOW_DAYS,
    tierRank,
    licenseTier,
    PHONE_TYPES,
    PHONE_TYPE_LABELS,
    normalizePhoneType,
    phoneExtAfter,
    splitPhoneExt,
    phoneLabel,
    whatsappUrl,
    TZ,
    tierFeatureList,
    USD_PRICES,
    detectCurrency,
    VISA_TYPES, normalizeVisa, consultantVisaType, visaLabel, WORK_AUTH_STEPS, workAuthAlert, expiringWorkAuth,
    RATE_UNITS, RATE_UNIT_LABELS, normalizeRateUnit, cleanRateMin, rateMinHourly, rateMinText, belowRateMin,
    BENCH_STATUS, BENCH_STATUS_LABELS, MATCH_BENCH_STATUS, benchStatusOf, onBench, AVAILABLE_SOON_DAYS, availabilityOf, availabilityText, isMatchable, availableOnFromText,
    featureOn, hideDisabledFeatures, webappUrl, applyPageLinks,
    TAX_TERMS, WORK_TERMS, normalizeTaxTerms, defaultTaxTerms, defaultTermsFilter, leadTermsFit, TERMS_FILTERS, normalizeTermsFilter, termsFilterInitial, leadMatchesTerms,
    splitSkills,
    skillKeyOf,
    RESUME_MAX_BYTES,
    checkResumeFile, resumeKind, resumeMime, resumeRecordType, RESUME_PDF_TYPE, RESUME_DOCX_TYPE,
    SKILL_DICTIONARY,
    extractSkills,
    parseResumeText, pickResumePhone,
    containsSkill,
    matchConsultants,
    scoreMatch, STRONG_MATCH, needsLook, needsLookReason, postVisaFit, postHourlyRate,
    MATCH_THRESHOLD,
    todayStr,
    addDays,
    daysUntil,
    planDate,
    escapeHtml,
    csvCell,
    safeHttpUrl,
    cleanPersonName, displayTitle, shownRecruiterName, shownCompanyName,
    normalizeEmail,
    leadPostKey,
    dedupeLeads, pageLeadKey, isRichLead, mergeRicherLead, collapseLeadsByEmail,
    duplicateSignature,
    findDuplicateGroups,
    defaultKeepEmail,
    mergeLeadRecords,
    undoLeadMerge,
    MISSING_FIELDS,
    missingDataCounts,
    leadMissing,
    cleanLines,
    profileSlugFromPath,
    canonicalProfileUrl,
    parseDurationMonths,
    formatTenure,
    parseConnectionDegree,
    nameFromPageTitle,
    parseCurrentCompanyLabel,
    pickCurrentCompany,
    sameCompany,
    parseTopCard,
    parseExperienceLines,
    phoneTypeFromLabel,
    parsePhoneLine,
    parseContactInfoText,
    firstNameOf,
    fillTemplate,
    buildComposeUrl,
    pickTemplate,
    pitchMessages, pitchClean, pitchExperience, pitchAvailability,
    PITCH_CONNECTION_LIMIT,
    // quick notes (issue #10)
    QUICK_NOTE_TITLE_MAX, QUICK_NOTE_TEXT_MAX, DEFAULT_QUICK_NOTES,
    sanitizeQuickNote, validateQuickNote, canAddQuickNote, quickNoteUsageText, quickNoteLimitMessage,
    newQuickNoteId,
    newId, randomIdPart, defaultQuickNotes, sortQuickNotes, renumberQuickNotes, moveQuickNote, reorderQuickNotes, fillQuickNote,
    rateMargin,
    maxPayForMargin,
    parseRate,
    RATE_TYPES,
    RATE_DEFAULTS,
    send
  };

  // Vendors view helpers (block above).
  Object.assign(root.BP, { leadActivityTime, companyStats, companyMatchesQuery, filterCompanyRows, sortCompanyRows });

  // ── US states, local-only matching and job applications (issue #44) ───────
  const STATE_BY_NAME = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA', 'colorado': 'CO',
    'connecticut': 'CT', 'delaware': 'DE', 'district of columbia': 'DC', 'florida': 'FL', 'georgia': 'GA',
    'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS', 'kentucky': 'KY',
    'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD', 'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN',
    'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH',
    'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
    'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI',
    'south carolina': 'SC', 'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT',
    'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY'
  };
  // Well-known tech hubs, so "Dallas" or "Bay Area" alone still gives a state. Ambiguous names
  // (Arlington, Cambridge, Wilmington, Rochester) are left out on purpose.
  const STATE_BY_CITY = {
    'new york city': 'NY', 'nyc': 'NY', 'brooklyn': 'NY', 'buffalo': 'NY', 'albany': 'NY', 'jersey city': 'NJ', 'newark': 'NJ',
    'edison': 'NJ', 'princeton': 'NJ', 'iselin': 'NJ', 'piscataway': 'NJ', 'philadelphia': 'PA', 'pittsburgh': 'PA',
    'boston': 'MA', 'hartford': 'CT', 'stamford': 'CT', 'providence': 'RI', 'baltimore': 'MD', 'richmond': 'VA',
    'mclean': 'VA', 'reston': 'VA', 'tysons': 'VA', 'herndon': 'VA', 'ashburn': 'VA', 'mechanicsville': 'VA',
    'charlotte': 'NC', 'raleigh': 'NC', 'durham': 'NC', 'cary': 'NC', 'atlanta': 'GA', 'alpharetta': 'GA',
    'tampa': 'FL', 'miami': 'FL', 'orlando': 'FL', 'jacksonville': 'FL', 'nashville': 'TN', 'memphis': 'TN',
    'birmingham': 'AL', 'new orleans': 'LA', 'little rock': 'AR', 'louisville': 'KY', 'columbus': 'OH', 'cleveland': 'OH',
    'cincinnati': 'OH', 'detroit': 'MI', 'indianapolis': 'IN', 'chicago': 'IL', 'schaumburg': 'IL', 'milwaukee': 'WI',
    'madison': 'WI', 'minneapolis': 'MN', 'des moines': 'IA', 'omaha': 'NE', 'kansas city': 'MO', 'st. louis': 'MO',
    'st louis': 'MO', 'oklahoma city': 'OK', 'austin': 'TX', 'dallas': 'TX', 'plano': 'TX', 'irving': 'TX',
    'frisco': 'TX', 'houston': 'TX', 'san antonio': 'TX', 'fort worth': 'TX', 'denver': 'CO', 'salt lake city': 'UT',
    'phoenix': 'AZ', 'tempe': 'AZ', 'scottsdale': 'AZ', 'las vegas': 'NV', 'albuquerque': 'NM', 'boise': 'ID',
    'seattle': 'WA', 'bellevue': 'WA', 'redmond': 'WA', 'kirkland': 'WA', 'portland': 'OR', 'san francisco': 'CA',
    'bay area': 'CA', 'san jose': 'CA', 'sunnyvale': 'CA', 'santa clara': 'CA', 'mountain view': 'CA', 'palo alto': 'CA',
    'fremont': 'CA', 'los angeles': 'CA', 'san diego': 'CA', 'sacramento': 'CA', 'irvine': 'CA', 'honolulu': 'HI',
    'anchorage': 'AK'
  };
  const STATE_NAME_RE = new RegExp('\\b(' + Object.keys(STATE_BY_NAME).sort((a, b) => b.length - a.length).join('|') + ')\\b', 'i');
  const STATE_CITY_RE = new RegExp('\\b(' + Object.keys(STATE_BY_CITY).sort((a, b) => b.length - a.length)
    .map(k => k.replace(/[.]/g, '\\.')).join('|') + ')(?![A-Za-z])', 'i');
  const STATE_CODE_SET = new Set(US_STATES);

  // "Bellevue, WA" / "Dallas TX" / "Texas" / "Bay Area" / "TX" -> two-letter code, or '' when no US state is found.
  // Meant for location fields and short phrases; it takes the first state it finds.
  function usStateOf(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (/^[A-Z]{2}$/.test(s)) return STATE_CODE_SET.has(s) ? s : '';
    if (/\bWashington,?\s+D\.?C\.?(?![A-Za-z])|(?:^|[\s,(])D\.C\.(?![A-Za-z])/i.test(s)) return 'DC';
    // "City, ST" (any comma-separated uppercase code) and "(TX)"
    const re = /(?:,|\()\s*([A-Z]{2})\b(?![A-Za-z])/g;
    let m;
    while ((m = re.exec(s))) if (STATE_CODE_SET.has(m[1])) return m[1];
    // "Dallas TX 75201" - a bare code only at the end of the place name
    const tail = /\b[A-Z][a-z][A-Za-z.'-]*\s+([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:\([^)]*\))?\s*$/.exec(s);
    if (tail && STATE_CODE_SET.has(tail[1])) return tail[1];
    const name = STATE_NAME_RE.exec(s);
    if (name) return STATE_BY_NAME[name[1].toLowerCase()];
    const city = STATE_CITY_RE.exec(s);
    if (city) return STATE_BY_CITY[city[1].toLowerCase()];
    return '';
  }

  // A local-only requirement (lead.localOnly + lead.localState) needs a consultant who is already in that state
  // or says they will relocate. Anything else about the lead matches as before.
  const RELOCATE_YES = /^(?:yes|y|true|willing|open|ready)\b|\bwilling\b|\bopen\s+to\s+relocat/i;
  function consultantFitsLocal(consultant, lead) {
    if (!lead || !lead.localOnly) return true;
    const want = String(lead.localState || '').toUpperCase();
    if (!want) return true;   // local-only, but the state could not be read: do not hide anyone
    const c = consultant || {};
    if (RELOCATE_YES.test(String(c.relocation || '').trim())) return true;
    return usStateOf(c.location) === want;
  }

  // Subject and body of an application email for a job opening. Pure; the drawer opens it in the
  // user's mail client and never sends it. Empty profile fields are left out, not shown as placeholders.
  function buildJobApplication(job, profile) {
    const j = job || {};
    const p = profile || {};
    const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 300);
    const name = clean(p.name, 80);
    const title = clean(j.title, 100) || 'open position';
    const first = j.contactName && !/^recruiter/i.test(String(j.contactName)) ? String(j.contactName).trim().split(/\s+/)[0] : '';
    const lines = [first ? `Hi ${first},` : 'Hi,', ''];
    const company = clean(j.company, 80);
    lines.push(`I came across your ${title} opening${company ? ' at ' + company : ''} and would like to apply.`);
    const mine = clean(p.title, 100);
    if (mine) lines.push(`I am a ${mine}.`);
    const summary = clean(p.summary, 500);
    if (summary) lines.push('', summary);
    const contact = [];
    const phone = clean(p.phone, 40);
    const linkedin = clean(p.linkedin, 200);
    if (phone) contact.push(`Phone: ${phone}`);
    if (linkedin) contact.push(`LinkedIn: ${linkedin}`);
    if (contact.length) lines.push('', ...contact);
    lines.push('', 'My resume is attached.', '', 'Thank you,');
    if (name) lines.push(name);
    return { subject: `Application: ${title} – ${name || 'your name'}`, body: lines.join('\n') };
  }

  // ── Recruiter type (v1.12): tech recruiter, bench sales or company HR ────────────────────────────────
  // One pure reading of "who is this person?" from what is saved: the post type, the poster's headline, the company label and,
  // above all, the user's own choice. Bench sales contacts stay in their own list; they never reach the pitch list or matches.
  //   BP.recruiterType(lead, { companies }) -> { type: 'tech' | 'bench' | 'company-hr' | 'unknown', why: [short reasons], manual: boolean }
  // Stored on save as lead.recruiterType + lead.recruiterTypeManual; lead.benchSeller (boolean) is kept in step (bench = true).
  const RECRUITER_TYPES = ['tech', 'bench', 'company-hr', 'unknown'];
  const RECRUITER_TYPE_LABELS = { tech: 'Tech recruiter', bench: 'Bench sales', 'company-hr': 'Company HR', unknown: 'Not sure' };
  // The Type filter row: All, then one entry per pickable type. Technical recruiters also holds contacts we could not tell.
  const TYPE_FILTERS = [['all', 'All'], ['tech', 'Technical recruiters'], ['bench', 'Bench sales'], ['company-hr', 'Company HR']];
  const TYPE_FILTER_KEYS = TYPE_FILTERS.map(f => f[0]);
  const BENCH_TITLE_RE = /\bbench\s*(?:sales|marketing|recruit\w*|team|consultants?)\b|\bus\s*it\s+bench\b|\bmarketing\s+(?:consultants?|recruiters?)\b|\bhot\s*-?\s*list\b/i;
  const TECH_TITLE_RE = /\b(?:technical|tech|it)\s+recruit\w*|\bsr\.?\s+(?:it\s+|technical\s+|us\s+it\s+)?recruit\w*|\bsenior\s+(?:it\s+|technical\s+|us\s+it\s+)?recruit\w*|\btalent\s+acquisition\b|\bus\s*it\s+recruit\w*|\brecruitment\s+(?:lead|manager|consultant|specialist)\b|\bdelivery\b|\bsourcer\b/i;
  const PLAIN_RECRUITER_RE = /\brecruit(?:er|ment)\b/i;
  const HR_TITLE_RE = /\bhuman\s+resources\b|\bhr\b|\bpeople\s+(?:operations|partner|team|ops)\b/i;
  const COMPANY_SUFFIX_RE = /\b(?:inc|llc|ltd|corp|corporation|co|solutions|technologies|services|group|consulting|systems|global)\.?$/i;
  const STAFFING_LABELS = ['prime-vendor', 'implementation-partner', 'bench-seller'];

  // Roles in a headline: "Sr. Recruiter at Acme Bench Sales Inc | Hiring" -> ["Sr. Recruiter", "Hiring"]. The part after "at", "@" or "with" is
  // the employer, so a company called "Bench Sales Inc" never makes the person a bench seller. A segment that is only a company name is dropped.
  function headlineRoles(text) {
    const out = [];
    for (const raw of String(text || '').split(/[|•·\n]+|\s[-–—]\s/)) {
      const seg = raw.replace(/\s+(?:at|@|with)\s+.*$/i, '').replace(/^\s*(?:at|@)\s+.*$/i, '').trim();
      if (seg && !COMPANY_SUFFIX_RE.test(seg)) out.push(seg);
    }
    return out;
  }

  function recruiterCompany(lead, companies) {
    const list = Array.isArray(companies) ? companies : [];
    if (!list.length) return null;
    const id = (lead && lead.companyId) || companyIdForEmail(lead && lead.email);
    if (!id) return null;
    return list.find(c => c && c.id === id) || list.find(c => c && Array.isArray(c.aliases) && c.aliases.includes(id)) || null;
  }

  function recruiterType(lead, opts) {
    const l = lead || {};
    const company = recruiterCompany(l, opts && opts.companies);
    const label = company ? company.label : '';
    // The user's own call always wins. Old data (before types) stored the call as a bare benchSeller boolean.
    if (l.recruiterTypeManual === true && RECRUITER_TYPES.includes(l.recruiterType)) return { type: l.recruiterType, why: ['You set this'], manual: true };
    const legacyManual = l.recruiterTypeManual === undefined && typeof l.benchSeller === 'boolean';
    if (legacyManual && l.benchSeller === true) return { type: 'bench', why: ['You marked this as bench sales'], manual: true };
    const skipBench = legacyManual && l.benchSeller === false;   // un-marked by the user: bench signals no longer count

    const roles = headlineRoles([l.headline, l.designation].filter(Boolean).join(' | '));
    const headBench = roles.some(r => BENCH_TITLE_RE.test(r));
    const headTech = roles.some(r => TECH_TITLE_RE.test(r));
    const headRecruiter = roles.some(r => PLAIN_RECRUITER_RE.test(r));
    const headHr = roles.some(r => HR_TITLE_RE.test(r));
    const hotlist = l.postType === 'hotlist';
    const tail = (arr) => (skipBench ? arr.concat(['You said not bench sales']) : arr).slice(0, 3);

    if (!skipBench) {
      const why = [];
      if (headBench) why.push('Headline says bench sales');
      if (hotlist) why.push('Posted a hotlist');
      // A company label alone does not outweigh a technical-recruiter headline; a bench word in the headline or a hotlist does.
      if (label === 'bench-seller' && (!headTech || headBench || hotlist)) why.push('Company is labelled Bench seller');
      if (why.length) return { type: 'bench', why: why.slice(0, 3), manual: false };
    }
    if (label === 'direct-client') return { type: 'company-hr', why: tail(['Company is a direct client']), manual: skipBench };
    if (headHr && !headTech && !STAFFING_LABELS.includes(label)) return { type: 'company-hr', why: tail(['Headline says HR']), manual: skipBench };
    if (headTech) return { type: 'tech', why: tail(['Headline says technical recruiter']), manual: skipBench };
    if (l.postType === 'requirement') return { type: 'tech', why: tail(['Posted a requirement']), manual: skipBench };
    if (headRecruiter) return { type: 'tech', why: tail(['Headline says recruiter']), manual: skipBench };
    return { type: 'unknown', why: tail([]), manual: skipBench };
  }

  // Unsure contacts sit with the technical recruiters in lists, filters and exports, so nobody drops out by default.
  function recruiterTypeGroup(type) { return type === 'unknown' || !RECRUITER_TYPES.includes(type) ? 'tech' : type; }
  // filter: 'all' | 'tech' | 'bench' | 'company-hr'
  function matchesTypeFilter(type, filter) {
    return !filter || filter === 'all' || recruiterTypeGroup(type) === filter;
  }
  function normalizeTypeFilter(v) { return TYPE_FILTER_KEYS.includes(v) ? v : 'all'; }
  // The fields a lead carries after a save: type, whether the user chose it, and benchSeller kept in step. Returns a new lead.
  function withRecruiterType(lead, opts) {
    const r = recruiterType(lead, opts);
    const out = { ...lead, recruiterType: r.type, recruiterTypeManual: r.manual };
    if (r.type === 'bench') out.benchSeller = true;
    else if (typeof out.benchSeller === 'boolean') out.benchSeller = false;
    return out;
  }

  Object.assign(root.BP, { RECRUITER_TYPES, RECRUITER_TYPE_LABELS, TYPE_FILTERS, TYPE_FILTER_KEYS, headlineRoles, recruiterType, recruiterTypeGroup, matchesTypeFilter, normalizeTypeFilter, withRecruiterType });

  // ── v1.17 clean data: job seekers, team mailboxes, stale requirements and the one match pool ──────────
  // Pure helpers shared by the drawer, the worker, the dashboard, Radar and Today, so every screen applies the same rules.

  // Team mailbox: an address made only of team words (hr@, jobs@, info@, recruiting@). It belongs to a team, not a person,
  // so it is never given a person's name ("Hr") and never uses up a monthly contact.
  function isTeamMailbox(email) {
    const parts = emailLocalParts(email);
    return parts.length > 0 && parts.every(p => GENERIC_LOCAL_WORDS.has(p));
  }

  // Job seekers (candidates): people looking for a job who post their own email. They are not recruiters, so they are kept
  // apart (a Candidates list), never matched and never charged.
  //   BP.detectJobSeeker({ text, headline, name, email, openToWork }) -> { level: 'yes' | 'check' | '', score, reasons }
  //   'yes' only with direct evidence (the #OpenToWork label or first-person job-hunting words); 'check' when unsure.
  const SEEKER_FIRST_PERSON = [
    /\b(?:i\s*(?:am|'m|’m)|myself)\b[^.\n]{0,40}?\b(?:looking|seeking|searching|open|available)\s+(?:for\s+|to\s+)?(?:(?:a|an|new|full[\s-]*time|immediate|exciting|suitable|the\s+right)\s+)*(?:job|jobs|role|roles|opportunit\w*|position|positions|openings?|employment|work)\b/i,
    /\bmy\s+(?:updated\s+)?(?:resume|cv|résumé)\b/i,
    /\b(?:please|kindly|pls)\s+refer\s+me\b|\breferrals?\s+(?:would\s+be|are|is)\s+(?:highly\s+)?appreciated\b/i,
    /\bi\s+(?:have|bring|possess)\s+(?:over\s+|around\s+|nearly\s+)?\d{1,2}\+?\s*(?:years?|yrs)\b/i,
    /\b(?:immediate(?:ly)?\s+joiner|available\s+to\s+join\s+immediately|currently\s+serving\s+(?:my\s+)?notice)\b/i,
    /\b(?:i\s+was|i\s+have\s+been|i\s+got)\s+(?:laid\s+off|impacted\s+by\s+(?:a\s+)?layoff)/i
  ];
  const SEEKER_OPEN_TO_WORK = /#?\bopen\s*_?\s*to\s*_?\s*work\b|#opentowork|\bopen\s+for\s+(?:new\s+)?(?:opportunities|roles|jobs)\b/i;
  const RECRUITING_WORDS = /\brecruit\w*|\btalent\b|\bstaffing\b|\bsourc(?:er|ing)\b|\bhiring\b|\bhr\b|\bhuman\s+resources\b|\bbench\b|\bsales\b|\baccount\s+(?:manager|executive)\b|\bbusiness\s+development\b|\bbdm\b|\bdelivery\s+(?:manager|lead|head)\b|\bvendor\b|\bpartner(?:ship)?s?\b|\bfounder\b|\bceo\b|\bpresident\b|\bowner\b|\bplacement\b|\bconsultancy\b|\bpeople\s+(?:ops|operations|partner)\b|\bc2c\b|\bw2\b/i;
  const TECH_ROLE_WORDS = /\b(?:developer|engineer|architect|analyst|administrator|tester|qa|sdet|programmer|scientist|devops|sre|dba|full\s*stack|front\s*end|back\s*end|scrum\s+master|product\s+owner|java|python|salesforce|sap|aws|azure|react|angular|node)\b|\.net\b/i;
  const SEEKER_HEADLINE = /\b(?:seeking|looking\s+for)\s+(?:new\s+|full[\s-]*time\s+)?(?:opportunit\w*|roles?|jobs?|positions?)\b|\bopen\s+to\s+work\b|\bactively\s+(?:looking|seeking)\b|\bjob\s+seeker\b/i;
  // Words of a real requirement: a vendor writes these, a job seeker does not.
  const REQUIREMENT_EVIDENCE = [
    /\b(?:end\s+)?client\s*[:–—-]/i,
    /\brate\s*[:–—-]?\s*\$?\s*\d|\$\s*\d{2,3}\s*(?:\/|per\s*)\s*h(?:ou)?r\b|\bpay\s*rate\b/i,
    /\b(?:duration|contract\s+length)\s*[:–—-]/i,
    /\b(?:send|share|submit|forward)\s+(?:me\s+)?(?:your\s+|the\s+|matching\s+|suitable\s+)?(?:profiles?|resumes?|candidates?|consultants?)\b/i,
    /\bwe\s*(?:are|'re|’re)\s+(?:hiring|looking)\b|\bmy\s+client\b|\bour\s+client\b/i
  ];

  function detectJobSeeker(input) {
    const o = input || {};
    const text = String(o.text || '');
    const headline = String(o.headline || '');
    const reasons = [];
    let score = 0;
    let direct = false;
    const add = (w, reason) => { score += w; if (reason && w > 0) reasons.push(reason); };

    if (o.openToWork === true) { add(60, 'Profile shows #OpenToWork'); direct = true; }
    else if (SEEKER_OPEN_TO_WORK.test(text) || SEEKER_OPEN_TO_WORK.test(headline)) { add(45, 'Says open to work'); direct = true; }
    const firstPerson = SEEKER_FIRST_PERSON.filter(re => re.test(text)).length;
    if (firstPerson) { add(firstPerson >= 2 ? 45 : 30, 'Writes about their own job search'); direct = true; }
    if (SEEKER_HEADLINE.test(headline)) { add(30, 'Headline says looking for a job'); direct = true; }

    const recruitingHeadline = RECRUITING_WORDS.test(headline);
    if (headline && !recruitingHeadline && headlineRoles(headline).some(r => TECH_ROLE_WORDS.test(r))) add(20, 'Headline is a tech role, not recruiting');
    if (recruitingHeadline) add(-45);

    const email = String(o.email || '');
    const domain = email.split('@')[1] || '';
    if (domain && isFreeMailDomain(domain) && o.name && emailMatchesName(email, o.name)) add(15, 'Personal email in their own name');

    const evidence = REQUIREMENT_EVIDENCE.filter(re => re.test(text)).length;
    if (/\b\d{1,2}\+?\s*(?:years?|yrs)\b/i.test(text) && TECH_ROLE_WORDS.test(text) && !evidence) add(10, 'Lists years and skills, no client or rate');
    add(-15 * evidence);

    const level = score >= 60 && direct ? 'yes' : score >= 35 ? 'check' : '';
    return { level, score, reasons: level ? reasons.slice(0, 4) : [] };
  }

  // The stored call: 'yes' (a job seeker), 'check' (unsure, shown with a "Check" label) or 'no' (the user said recruiter).
  const CANDIDATE_VALUES = ['yes', 'check', 'no'];
  function isJobSeekerLead(lead) { return Boolean(lead) && lead.candidate === 'yes'; }
  function needsSeekerCheck(lead) { return Boolean(lead) && lead.candidate === 'check'; }

  // Hiring leads: a requirement-side contact. Hotlists, recruiter jobs, bench sellers and job seekers are not.
  function isHiringLead(lead) {
    if (!lead) return false;
    const l = lead;
    return !(l.postType === 'hotlist' || l.postType === 'recruiter-job' || l.benchSeller === true || l.recruiterType === 'bench' || l.candidate === 'yes');
  }

  // Closed or stale requirements: "position filled" style wording, a deadline in the past, or older than 30 days.
  const STALE_AFTER_DAYS = 30;
  const MATCH_WINDOW_DAYS = 14;
  const POOL_DAY_MS = 86400000;
  const CLOSED_PHRASES = /\b(?:position|role|requirement|req|job|opening|vacancy)\s+(?:is\s+|has\s+been\s+|have\s+been\s+|now\s+)?(?:filled|closed|on\s+hold)\b|\bno\s+longer\s+(?:accepting|available|open|taking)\b|\b(?:closed|not\s+accepting(?:\s+any)?(?:\s+more)?)\s+(?:for\s+)?(?:submissions?|resumes?|profiles?|applications?)\b|^\s*(?:update\s*[:\-]\s*)?(?:closed|filled|position\s+closed)\b/im;
  function hasClosedWording(text) { return CLOSED_PHRASES.test(String(text || '')); }

  // When the requirement went up: the post time, else the save time. Age in ms, NaN when neither is known.
  function requirementAgeMs(lead, nowMs) {
    const l = lead || {};
    let t = typeof l.postedAt === 'string' ? Date.parse(l.postedAt) : NaN;
    if (!Number.isFinite(t)) t = Date.parse(l.savedAt || l.extractedAt || '');
    return Number.isFinite(t) ? Math.max(0, nowMs - t) : NaN;
  }
  //   BP.requirementState(lead, nowMs) -> { state: 'open' | 'stale' | 'closed', why }
  function requirementState(lead, nowMs) {
    const l = lead || {};
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (l.closed === true) return { state: 'closed', why: 'The post says the position is filled or closed' };
    if (typeof l.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l.deadline) && l.deadline < todayStr(new Date(now))) {
      return { state: 'stale', why: 'The deadline has passed' };
    }
    const age = requirementAgeMs(l, now);
    if (Number.isFinite(age) && age > STALE_AFTER_DAYS * POOL_DAY_MS) return { state: 'stale', why: `Older than ${STALE_AFTER_DAYS} days` };
    return { state: 'open', why: '' };
  }

  // The one match pool (drawer, Radar, Today, Match workspace): hiring leads only, not Closed, not stale or filled, and posted
  // (else saved) within the last 14 days. Per-consultant "submitted" and "skipped / not relevant" are applied by each screen on top.
  function inMatchPool(lead, nowMs, opts) {
    if (!isHiringLead(lead)) return false;
    if (normalizeStatus(lead.status) === 'Closed') return false;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (requirementState(lead, now).state !== 'open') return false;
    const days = opts && Number(opts.days) > 0 ? Number(opts.days) : MATCH_WINDOW_DAYS;
    const age = requirementAgeMs(lead, now);
    return !Number.isFinite(age) || age <= days * POOL_DAY_MS;
  }

  // ── Same role from several vendors (v1.18: moved here from lib/match-workspace.js, so the drawer and the Match workspace share it) ──
  const SAME_ROLE_WINDOW_DAYS = 14;
  const TITLE_NOISE = new Set(['remote', 'hybrid', 'onsite', 'on', 'site', 'w2', 'c2c', '1099', 'contract', 'urgent', 'hiring', 'position', 'opening', 'role', 'immediate', 'requirement', 'need', 'needed', 'looking', 'for', 'a', 'an', 'the', 'and', 'with', 'job', 'long', 'term', 'only', 'usc', 'gc', 'ead', 'f2f', 'in', 'person', 'direct', 'client']);
  const WORD_FIX = { sr: 'senior', jr: 'junior', dev: 'developer', engg: 'engineer', mgr: 'manager', lead: 'lead' };
  // "Sr. Java Developer (Remote) - W2" and "Senior Java Developer" read the same.
  function normTitle(v) {
    const words = String(v == null ? '' : v).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9#+.]+/g, ' ').replace(/\.+(?=\s|$)/g, '').trim().split(/\s+/).filter(Boolean);
    return words.map((w) => WORD_FIX[w] || w).filter((w) => !TITLE_NOISE.has(w)).join(' ');
  }
  const CLIENT_NOISE = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'the', 'of', 'group', 'limited', 'plc']);
  function normClient(v) {
    const s = String(v == null ? '' : v).toLowerCase();
    if (/^(?:—|-|n\/a|na|not stated|undisclosed|confidential|direct client|client|end client)?$/.test(s.trim())) return '';
    return s.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !CLIENT_NOISE.has(w)).join(' ');
  }
  function normJobId(v) {
    const s = String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, '');
    return s.length >= 3 ? s : '';
  }

  // items: [{ title, endClient, jobId, ms }]. Two posts are the same role when they share a job ID, or share a normalised title AND a named end
  // client, and were posted within `windowDays` (default 14) of each other (chained, so a post between two others joins them).
  // Returns groups in the order their first item appears: [{ id, indexes: [i, ...] }]. Every item is in exactly one group; a lone post is a group of one.
  function groupSameRole(items, opts) {
    const list = Array.isArray(items) ? items : [];
    const win = ((opts && opts.windowDays) || SAME_ROLE_WINDOW_DAYS) * POOL_DAY_MS;
    const parent = list.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
    const buckets = new Map();
    list.forEach((it, i) => {
      const x = it || {};
      const job = normJobId(x.jobId);
      const title = normTitle(x.title);
      const client = normClient(x.endClient);
      if (job) { const k = 'j:' + job; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(i); }
      if (title && client) { const k = 't:' + title + '|' + client; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(i); }
    });
    for (const idx of buckets.values()) {
      if (idx.length < 2) continue;
      const sorted = idx.slice().sort((a, b) => (Number(list[a].ms) || 0) - (Number(list[b].ms) || 0) || a - b);
      for (let n = 1; n < sorted.length; n++) {
        const gap = (Number(list[sorted[n]].ms) || 0) - (Number(list[sorted[n - 1]].ms) || 0);
        if (gap <= win) union(sorted[n], sorted[n - 1]);
      }
    }
    const byRoot = new Map();
    const out = [];
    list.forEach((_, i) => {
      const r = find(i);
      if (!byRoot.has(r)) { const g = { id: 'g' + r, indexes: [] }; byRoot.set(r, g); out.push(g); }
      byRoot.get(r).indexes.push(i);
    });
    return out;
  }
  root.BP.SameRole = { normTitle, normClient, normJobId, groupSameRole, WINDOW_DAYS: SAME_ROLE_WINDOW_DAYS };

  // ── Requirement filters (v1.18): visa, rate, end client, contacted, free-mail, closes soon ──
  // f: { visa: '' | <visa code>, rate: '' | 'has' | 'none', rateMin, rateMax (hourly, numbers or ''), client: '' | 'named' | 'hidden' | 'none',
  //      contacted: '' | 'yes' | 'no', mail: '' | 'free' | 'corporate', closes: '' | <days> }
  // ctx: { contacted(lead) -> boolean (optional: a submission counts as contact), now }
  const LEAD_FILTER_DEFAULTS = Object.freeze({ visa: '', rate: '', rateMin: '', rateMax: '', client: '', contacted: '', mail: '', closes: '' });
  const VISA_FILTER_OPTIONS = ['USC', 'GC', 'GC-EAD', 'H1B', 'H4-EAD', 'L2-EAD', 'OPT', 'CPT', 'TN'];
  const CLOSES_OPTIONS = [['3', 'Closes in 3 days'], ['7', 'Closes in 7 days'], ['14', 'Closes in 14 days']];
  const CONTACTED_STATUSES = ['Contacted', 'Responded', 'Interview'];
  function leadContacted(lead, ctx) {
    if (CONTACTED_STATUSES.includes(normalizeStatus(lead && lead.status))) return true;
    return Boolean(ctx && typeof ctx.contacted === 'function' && ctx.contacted(lead));
  }
  function leadDaysToDeadline(lead, nowMs) {
    const d = lead && typeof lead.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(lead.deadline) ? lead.deadline : '';
    if (!d) return null;
    const today = todayStr(new Date(Number.isFinite(nowMs) ? nowMs : Date.now()));
    return Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / POOL_DAY_MS);
  }
  function leadPassesFilters(lead, f, ctx) {
    const l = lead || {};
    const o = f || {};
    const now = ctx && Number.isFinite(ctx.now) ? ctx.now : Date.now();
    if (o.visa) {
      const hay = [l.requirement, l.technologies, l.notes, l.headline].filter(Boolean).join(' | ').toLowerCase();
      if (visaExcludes(o.visa, hay) || postVisaFit(l, o.visa) === 'out') return false;
    }
    if (o.rate || o.rateMin !== '' && o.rateMin != null || o.rateMax !== '' && o.rateMax != null) {
      const hasRate = Boolean(l.rate && typeof l.rate === 'object' && (Number(l.rate.min) > 0 || Number(l.rate.max) > 0));
      if (o.rate === 'none') { if (hasRate) return false; }
      else {
        if (o.rate === 'has' && !hasRate) return false;
        const lo = Number(o.rateMin) > 0 ? Number(o.rateMin) : null;
        const hi = Number(o.rateMax) > 0 ? Number(o.rateMax) : null;
        if (lo !== null || hi !== null) {
          const r = l.rate || {};
          if (!hasRate || (r.unit && r.unit !== 'hr')) return false;
          const min = Number(r.min) > 0 ? Number(r.min) : Number(r.max);
          const max = Number(r.max) > 0 ? Number(r.max) : Number(r.min);
          if (lo !== null && max < lo) return false;
          if (hi !== null && min > hi) return false;
        }
      }
    }
    if (o.client) {
      const named = Boolean(String(l.endClient || '').trim());
      if (o.client === 'named' && !named) return false;
      if (o.client === 'hidden' && l.endClientHidden !== true) return false;
      if (o.client === 'none' && (named || l.endClientHidden === true)) return false;
    }
    if (o.contacted === 'yes' && !leadContacted(l, ctx)) return false;
    if (o.contacted === 'no' && leadContacted(l, ctx)) return false;
    if (o.mail) {
      const d = emailDomain(l.email);
      if (!d) return false;
      if ((o.mail === 'free') !== isFreeMailDomain(d)) return false;
    }
    if (o.closes) {
      const left = leadDaysToDeadline(l, now);
      if (left === null || left < 0 || left > Number(o.closes)) return false;
    }
    return true;
  }

  Object.assign(root.BP, {
    LEAD_FILTER_DEFAULTS, VISA_FILTER_OPTIONS, CLOSES_OPTIONS, leadContacted, leadDaysToDeadline, leadPassesFilters,
    isTeamMailbox, detectJobSeeker, CANDIDATE_VALUES, isJobSeekerLead, needsSeekerCheck, isHiringLead,
    STALE_AFTER_DAYS, MATCH_WINDOW_DAYS, hasClosedWording, requirementState, inMatchPool
  });

  Object.assign(root.BP, { US_STATE_CODES: US_STATES.slice(), US_STATE_BY_NAME: STATE_BY_NAME, usStateOf, consultantFitsLocal, buildJobApplication });
})(typeof self !== 'undefined' ? self : globalThis);

// Lets node tests load the pure helpers (no chrome APIs are touched at load time).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
