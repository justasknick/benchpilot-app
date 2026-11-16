// lib/posted.js - when was a LinkedIn post published? (v1.6.0 "Today")
//
// LinkedIn shows a relative time in the post header: "3h", "2d •", "1w", "1mo", "now", "Just now",
// "3 hours ago", "Edited • 2d". The drawer reads those strings from the header (content.js) and this file
// turns one into an approximate timestamp. Pure and deterministic: no DOM, no storage, no clock unless
// `nowMs` is left out.
//
//   BP.parseRelativePosted(text, nowMs)   -> { postedAt: ISO, postedLabel: '3h' } | null
//   BP.findPostedInTexts(texts, nowMs)    -> first parse among candidate strings, or null
//   BP.sanitizePosted(lead, nowMs)        -> { postedAt?, postedLabel? } validated copy (worker uses it)
//   BP.postedAgo(lead, nowMs)             -> { label: 'Posted 3h ago' | 'Saved 3d ago', freshness, ms, source }
//   BP.leadPostedMs(lead)                 -> posted time in ms, or NaN

(function (root) {
  'use strict';
  const BP = root.BP = root.BP || {};

  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  // postedAt may not be in the future by more than this, nor older than this (worker validation).
  const FUTURE_SLACK_MS = HOUR;
  const MAX_AGE_MS = 366 * DAY;

  // unit word -> { key (label suffix), ms }
  const UNITS = [
    [/^(?:s|sec|secs|second|seconds)$/, 's', 1000],
    [/^(?:m|min|mins|minute|minutes)$/, 'm', MIN],
    [/^(?:h|hr|hrs|hour|hours)$/, 'h', HOUR],
    [/^(?:d|day|days)$/, 'd', DAY],
    [/^(?:w|wk|wks|week|weeks)$/, 'w', 7 * DAY],
    [/^(?:mo|mos|month|months)$/, 'mo', 30 * DAY],
    [/^(?:y|yr|yrs|year|years)$/, 'y', 365 * DAY]
  ];

  // Whole-segment patterns. Anchored on purpose: "5 years of Java" is not a posted time.
  const NOW_RE = /^(?:now|just now|moments? ago|a moment ago|few seconds ago)$/i;
  const REL_RE = /^(\d{1,3})\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)(?:\s+ago)?$/i;
  const A_UNIT_RE = /^(?:an?|one)\s+(second|minute|hour|day|week|month|year)\s+ago$/i;
  // Words LinkedIn glues around the time in the same text node.
  const NOISE_RE = /\b(?:edited|visible to anyone on or off linkedin|visible to anyone|promoted|following|• following)\b/gi;

  function segmentsOf(text) {
    return String(text == null ? '' : text)
      .replace(NOISE_RE, ' ')
      .split(/[•·|\n\r∙⋅]+/)
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  function parseSegment(seg) {
    if (NOW_RE.test(seg)) return { n: 0, key: 'now', ms: 0 };
    const a = A_UNIT_RE.exec(seg);
    if (a) {
      const u = UNITS.find(([re]) => re.test(a[1].toLowerCase()));
      return u ? { n: 1, key: u[1], ms: u[2] } : null;
    }
    const m = REL_RE.exec(seg);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const u = UNITS.find(([re]) => re.test(unit));
    if (!u || !(n >= 0)) return null;
    // LinkedIn writes a post's age compactly ("1yr", "11mo") or with "ago". "1 yr" / "11 mos" with a space and no "ago"
    // is a length of time (a job tenure or experience in the header area), not when the post went up: about 60 saved
    // records got a 2025 date that way (real-data check, 10 Nov 2026).
    if ((u[1] === 'mo' || u[1] === 'y') && /\d\s/.test(seg) && !/\bago$/i.test(seg)) return null;
    return { n, key: u[1], ms: n * u[2] };
  }

  // "3h" / "2 days ago" / "Edited • 1w" -> { postedAt, postedLabel }; anything else -> null.
  function parseRelativePosted(text, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    for (const seg of segmentsOf(text)) {
      const p = parseSegment(seg);
      if (!p) continue;
      // Older than a year is never stored, and "5 years" is far more likely a headline than a post age.
      if (p.key === 'y' && p.n !== 1) continue;
      if (p.key === 'mo' && p.n > 12) continue;
      if (p.key === 'now' || (p.key === 's')) return { postedAt: new Date(now).toISOString(), postedLabel: 'now' };
      if (p.n === 0) return { postedAt: new Date(now).toISOString(), postedLabel: 'now' };
      return { postedAt: new Date(now - p.ms).toISOString(), postedLabel: p.n + p.key };
    }
    return null;
  }

  // Candidate strings are tried in order (most specific first), so the caller puts the header's time
  // element before the generic text of the header.
  function findPostedInTexts(texts, nowMs) {
    for (const t of texts || []) {
      if (typeof t !== 'string' || t.length > 400) continue;
      const r = parseRelativePosted(t, nowMs);
      if (r) return r;
    }
    return null;
  }

  // Worker-side validation: ISO date, not in the future by more than 1 h, not older than a year.
  function sanitizePosted(lead, nowMs) {
    const out = {};
    if (!lead || typeof lead.postedAt !== 'string') return out;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (!/^\d{4}-\d{2}-\d{2}T/.test(lead.postedAt)) return out;
    const ms = Date.parse(lead.postedAt);
    if (!Number.isFinite(ms) || ms > now + FUTURE_SLACK_MS || ms < now - MAX_AGE_MS) return out;
    out.postedAt = new Date(ms).toISOString();
    const label = typeof lead.postedLabel === 'string' ? lead.postedLabel.trim() : '';
    out.postedLabel = /^(?:now|\d{1,3}(?:mo|[smhdwy]))$/.test(label) ? label : '';
    return out;
  }

  function leadPostedMs(lead) {
    if (!lead || typeof lead.postedAt !== 'string') return NaN;
    return Date.parse(lead.postedAt);
  }

  function leadSavedMs(lead) {
    if (!lead) return NaN;
    const a = Date.parse(lead.savedAt || '');
    return Number.isFinite(a) ? a : Date.parse(lead.extractedAt || '');
  }

  // "3h" style span for an age in ms (always rounds down; < 1 min -> 'just now').
  function agoText(ageMs) {
    const age = Math.max(0, ageMs);
    if (age < MIN) return 'just now';
    if (age < HOUR) return Math.floor(age / MIN) + 'm ago';
    if (age < DAY) return Math.floor(age / HOUR) + 'h ago';
    if (age < 7 * DAY) return Math.floor(age / DAY) + 'd ago';
    if (age < 30 * DAY) return Math.floor(age / (7 * DAY)) + 'w ago';
    if (age < 365 * DAY) return Math.floor(age / (30 * DAY)) + 'mo ago';
    return Math.floor(age / (365 * DAY)) + 'y ago';
  }

  function freshnessOf(ageMs) {
    return ageMs < DAY ? 'fresh' : ageMs < 3 * DAY ? 'recent' : 'old';
  }

  // For the UI chip: "Posted 3h ago" when postedAt is known, else "Saved 3d ago" from the save time.
  // freshness: 'fresh' (< 24 h, green) | 'recent' (< 3 days, neutral) | 'old' (grey).
  function postedAgo(lead, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const posted = leadPostedMs(lead);
    if (Number.isFinite(posted)) {
      const age = now - posted;
      const t = agoText(age);
      return { label: t === 'just now' ? 'Posted just now' : 'Posted ' + t, freshness: freshnessOf(age), ms: posted, source: 'posted' };
    }
    const saved = leadSavedMs(lead);
    if (Number.isFinite(saved)) {
      const age = now - saved;
      const t = agoText(age);
      return { label: t === 'just now' ? 'Saved just now' : 'Saved ' + t, freshness: freshnessOf(age), ms: saved, source: 'saved' };
    }
    return { label: '', freshness: 'old', ms: NaN, source: 'none' };
  }

  Object.assign(BP, { parseRelativePosted, findPostedInTexts, sanitizePosted, postedAgo, leadPostedMs, leadSavedMs: leadSavedMs });
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP;
}
