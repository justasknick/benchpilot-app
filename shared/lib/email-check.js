// lib/email-check.js - the email check (backlog W6): a WARNING about an address that looks wrong, never a block. Pure: no DOM, no
// chrome.*, no network. Loaded by the dashboard (lead panel, Paste a requirement), by the web app (vendor contact form, via bp-lib
// loadEmailCheckLib) and by node tests. Exposes BP.EmailCheck. Standalone: needs nothing else from BP.
//
//   check(email) -> { email, domain, warnings: [{ code, text, suggestion? }] }   no warnings = looks fine (or the box is empty)
//   domainOf(email) -> 'example.com' | ''
//
// Warning codes (most useful first; at most one per code):
//   format      not an address at all (no @, spaces, nothing after the @ ...)
//   double_dot  two dots in a row, or a dot at the start or end of the name or the domain
//   typo        a common misspelling of a big mail provider (gmial.com -> gmail.com); `suggestion` is the corrected address
//   bad_tld     the ending is not a real one (.con, .cmo, a number, one letter)
//   disposable  a throw-away inbox service (mailinator.com ...): a real recruiter does not post from one
// The mail server (MX) check is separate and runs on the server (`team` function action email-check, web app only): this file never
// looks anything up.
//
// The lists are short on purpose; add to them when a real case shows up:
//   PROVIDERS   big free-mail domains a typo is measured against (one letter off, or two letters swapped)
//   KNOWN_GOOD  real domains that are one letter from a provider and must never be "corrected" (ymail.com, mail.com ...)
//   TYPOS       misspellings further than one letter that we have seen (gmaill.com is one letter, gamil.com is a swap; both found anyway)
//   BAD_TLDS    misspelt endings (.con for .com ...)
//   DISPOSABLE  throw-away inbox services (the well-known ones; not a complete list and not meant to be)
(function (root) {
  'use strict';
  const BP = root.BP = root.BP || {};

  const PROVIDERS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'rediffmail.com', 'yahoo.co.in', 'protonmail.com', 'live.com'];
  const KNOWN_GOOD = new Set(['ymail.com', 'mail.com', 'email.com', 'gmx.com', 'live.in', 'outlook.in', 'hotmail.co.uk', 'yahoo.co.uk', 'yahoo.in',
    'rediff.com', 'aol.com', 'me.com', 'mac.com', 'proton.me', 'zoho.com', 'zohomail.com']);
  const TYPOS = {
    'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com',
    'gmaill.com': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmailcom': 'gmail.com', 'gmaiil.com': 'gmail.com',
    'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yhoo.com': 'yahoo.com', 'yaoo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com',
    'outlok.com': 'outlook.com', 'outllok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'oulook.com': 'outlook.com', 'outlook.co': 'outlook.com',
    'outlook.con': 'outlook.com', 'hotmal.com': 'hotmail.com', 'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmil.com': 'hotmail.com',
    'hotmail.co': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'iclod.com': 'icloud.com', 'icoud.com': 'icloud.com', 'rediffmal.com': 'rediffmail.com',
    'redifmail.com': 'rediffmail.com'
  };
  const BAD_TLDS = new Set(['con', 'cmo', 'ocm', 'cpm', 'comm', 'vom', 'xom', 'cim', 'coom', 'nte', 'nett', 'ogr', 'orgg', 'ent']);
  const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com', 'tempmail.com',
    'temp-mail.org', 'yopmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com']);

  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
  function domainOf(email) {
    const e = norm(email);
    const at = e.lastIndexOf('@');
    return at > 0 ? e.slice(at + 1) : '';
  }

  // One letter added, missing or changed, or two neighbours swapped.
  function oneOff(a, b) {
    if (a === b || Math.abs(a.length - b.length) > 1) return false;
    if (a.length === b.length) {
      const diff = [];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
      if (diff.length === 1) return true;
      return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
    }
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    let i = 0;
    while (i < s.length && s[i] === l[i]) i++;
    return s.slice(i) === l.slice(i + 1);
  }

  function typoFor(domain) {
    if (!domain || KNOWN_GOOD.has(domain) || PROVIDERS.includes(domain)) return '';
    if (TYPOS[domain]) return TYPOS[domain];
    // Short domains are one letter from too many real ones (aol.com, me.com): only providers of 9+ characters are measured.
    const hit = PROVIDERS.find((p) => p.length >= 9 && oneOff(domain, p));
    return hit || '';
  }

  function check(email) {
    const raw = String(email == null ? '' : email).trim();
    const out = { email: raw.toLowerCase(), domain: '', warnings: [] };
    if (!raw) return out;
    const add = (code, text, suggestion) => { if (!out.warnings.some((w) => w.code === code)) out.warnings.push(suggestion ? { code, text, suggestion } : { code, text }); };
    const e = raw.toLowerCase();
    const at = e.lastIndexOf('@');
    const local = at > 0 ? e.slice(0, at) : '';
    const domain = at > 0 ? e.slice(at + 1) : '';
    out.domain = domain;
    if (at <= 0 || !domain || /\s/.test(e) || e.indexOf('@') !== at || e.length > 254) {
      add('format', 'This does not look like an email address.');
      return out;
    }
    if (/\.\./.test(e) || /^\.|\.$/.test(local) || /^[.-]|[.-]$/.test(domain)) add('double_dot', 'Check the dots: two in a row, or one at the start or end.');
    if (!domain.includes('.')) { add('format', 'The part after @ needs a dot, like name@company.com.'); return out; }
    const typo = typoFor(domain.replace(/\.{2,}/g, '.'));
    if (typo) add('typo', `Did you mean ${local}@${typo}?`, `${local}@${typo}`);
    const tld = domain.slice(domain.lastIndexOf('.') + 1);
    if (!typo && (BAD_TLDS.has(tld) || !/^(?:[a-z]{2,24}|xn--[a-z0-9-]{1,59})$/.test(tld))) add('bad_tld', `".${tld}" is not a real ending. Check the end of the address.`);
    if (DISPOSABLE.has(domain)) add('disposable', 'This is a throw-away inbox service. Replies may never be read.');
    return out;
  }

  BP.EmailCheck = { PROVIDERS, KNOWN_GOOD, TYPOS, BAD_TLDS, DISPOSABLE, check, domainOf, oneOff };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP.EmailCheck;
}
