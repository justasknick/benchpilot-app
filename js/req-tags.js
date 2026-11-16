// webapp/js/req-tags.js - full requirement tags (backlog W3, migration 0026_requirement_tags.sql). Pure: no DOM, no storage.
//
//   Tag fields on a requirement row: visaAllowed[], visaNotAllowed[], termsTags[] (C2C/W2/1099), workModeTag ('remote'|'hybrid'|'onsite'|''),
//   rateMin, rateMax (numbers or null), rateUnit ('hr'|'day'|'week'|'month'|'year'|''), durationMonths (1-120 or null).
//
//   tagsFromFreeText(row)        the unambiguous reading of the free text; the SAME rules as public.bp_requirement_tags in 0026 (keep in step)
//   withTags(row)                the row with every tag field set: kept when present, else read from the free text (demo rows, rows
//                                saved before 0026, the extension's capture before its trigger ran)
//   tagsFromParsed(BP, text)     the tags from pasted text with the extension's own parser (BP.parseRequirementFields, BP.extractPostTags,
//                                parseDurationMonths); null when the parser is not loaded
//   cleanTags(row)               tag fields checked against the 0026 constraints (unknown values dropped, a reversed rate swapped)
//   acceptsVisa(r, visa)         the post takes this visa: not ruled out, and listed or no list
//   filterByTags(rows, f)        { visa, terms, workMode, minRate (per hour), minMonths }
//   tagLabels(r)                 short chips: "H1B, GC, USC", "C2C", "Hybrid", "$70-75/hr", "12 months"

/** The extension's requirement visa codes (lib/requirement.js VISA_CODES, the 0026 check constraint): BP.VISA_TYPES without "Other", plus EAD. */
export const REQ_VISA_CODES = ['USC', 'GC', 'GC-EAD', 'H1B', 'H4-EAD', 'L2-EAD', 'OPT', 'STEM OPT', 'CPT', 'TN', 'EAD'];
export const TERMS_TAGS = ['C2C', 'W2', '1099'];
export const WORK_MODE_TAGS = ['remote', 'hybrid', 'onsite'];
export const RATE_UNITS = { hr: '/hr', day: '/day', week: '/week', month: '/month', year: '/year' };
const MODE_LABELS = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' };

const lc = (v) => String(v == null ? '' : v).toLowerCase();
const NEG = /\b(?:no|not|except|excluding|without|nor)\b/;
const ordered = (list, all) => all.filter((c) => list.includes(c));

export function visaFromText(text) {
  let v = lc(text);
  if (NEG.test(v)) return [];
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
  return ordered(out, REQ_VISA_CODES);
}

function termsFromText(text) {
  const t = lc(text);
  if (NEG.test(t)) return [];
  const out = [];
  if (/\bc2c\b|\bcorp[\s-]*to[\s-]*corp\b/.test(t)) out.push('C2C');
  if (/\bw-?2\b/.test(t)) out.push('W2');
  if (/\b1099\b/.test(t)) out.push('1099');
  return out;
}

function modeFromText(text) {
  const m = lc(text);
  const out = [];
  if (/\bremote\b/.test(m)) out.push('remote');
  if (/\bhybrid\b/.test(m)) out.push('hybrid');
  if (/\bon[\s-]*site\b|\bonsite\b/.test(m)) out.push('onsite');
  return out.length === 1 ? out[0] : '';
}

function rateFromText(text) {
  let r = lc(text).replace(/\bc2c\b|\bw-?2\b|\b1099\b|\bh-?1-?b\b|\bh-?4\b|\bl-?2\b/g, ' ').replace(/(\d),(\d{3})/g, '$1$2');
  const nums = [...r.matchAll(/(\d+(?:\.\d+)?\s*k?)\b/g)].map((m) => m[1]);
  const units = [];
  if (/\/\s*h(?:r|our)?s?\b|\bper\s+hour\b|\bhourly\b|\bhrs?\b|\bph\b/.test(r)) units.push('hr');
  if (/\bper\s+day\b|\/\s*day\b|\bdaily\b/.test(r)) units.push('day');
  if (/\bper\s+week\b|\/\s*w(?:ee)?k\b|\bweekly\b/.test(r)) units.push('week');
  if (/\bper\s+month\b|\/\s*mo(?:nth)?\b|\bmonthly\b/.test(r)) units.push('month');
  if (/\bper\s+(?:year|annum)\b|\/\s*y(?:ea)?r\b|\bannual(?:ly)?\b|\bp\.?a\.?\b|\bk\b|\d\s*k\b/.test(r)) units.push('year');
  const none = { rateMin: null, rateMax: null, rateUnit: '' };
  if (nums.length < 1 || nums.length > 2 || units.length !== 1) return none;
  const val = (s) => Number(s.replace(/[k\s]/g, '')) * (s.includes('k') ? 1000 : 1);
  const min = val(nums[0]);
  const max = val(nums[nums.length - 1]);
  if (!(min <= max) || max >= 1e7) return none;
  return { rateMin: min, rateMax: max, rateUnit: units[0] };
}

function monthsFromText(text) {
  const d = lc(text);
  const nums = d.match(/\d+/g);
  if (!nums || nums.length !== 1 || nums[0].length > 3) return null;
  let m = null;
  if (/^\D*\d+\s*\+?\s*(?:months?|mos?)\b/.test(d)) m = Number(nums[0]);
  else if (/^\D*\d+\s*\+?\s*(?:years?|yrs?)\b/.test(d)) m = Number(nums[0]) * 12;
  return m !== null && m >= 1 && m <= 120 ? m : null;
}

/** The same reading as public.bp_requirement_tags (0026). visaNotAllowed is never read from free text. */
export function tagsFromFreeText(row) {
  const r = row || {};
  return {
    visaAllowed: visaFromText(r.visaText), visaNotAllowed: [], termsTags: termsFromText(r.taxTerms), workModeTag: modeFromText(r.workMode),
    ...rateFromText(r.rateText), durationMonths: monthsFromText(r.duration)
  };
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) >= 1e7 ? null : Number(v));

/** Tag fields checked against the 0026 constraints. */
export function cleanTags(row) {
  const r = row || {};
  const list = (v, all) => ordered(Array.isArray(v) ? v : String(v || '').split(','), all).filter((c, i, a) => a.indexOf(c) === i);
  const visaNotAllowed = list((r.visaNotAllowed || []).map((x) => String(x).trim()), REQ_VISA_CODES);
  const visaAllowed = list((r.visaAllowed || []).map((x) => String(x).trim()), REQ_VISA_CODES).filter((c) => !visaNotAllowed.includes(c));
  let rateMin = num(r.rateMin);
  let rateMax = num(r.rateMax);
  if (rateMin === null) rateMin = rateMax;
  if (rateMax === null) rateMax = rateMin;
  if (rateMin !== null && rateMin > rateMax) [rateMin, rateMax] = [rateMax, rateMin];
  const rateUnit = RATE_UNITS[r.rateUnit] && rateMin !== null ? r.rateUnit : '';
  const months = Number(r.durationMonths);
  return {
    visaAllowed, visaNotAllowed,
    termsTags: list(r.termsTags, TERMS_TAGS),
    workModeTag: WORK_MODE_TAGS.includes(r.workModeTag) ? r.workModeTag : '',
    rateMin: rateUnit ? rateMin : null, rateMax: rateUnit ? rateMax : null, rateUnit,
    durationMonths: Number.isInteger(months) && months >= 1 && months <= 120 ? months : null
  };
}

const TAG_KEYS = ['visaAllowed', 'visaNotAllowed', 'termsTags', 'workModeTag', 'rateMin', 'rateMax', 'rateUnit', 'durationMonths'];
/** True when the row carries no tag at all (the 0026 backfill / trigger condition). */
export function hasNoTags(r) {
  const x = r || {};
  return !(x.visaAllowed || []).length && !(x.visaNotAllowed || []).length && !(x.termsTags || []).length && !x.workModeTag
    && (x.rateMin === null || x.rateMin === undefined) && !x.rateUnit && (x.durationMonths === null || x.durationMonths === undefined);
}

/** The row with every tag field set. A row that has no tag yet gets the free-text reading (as the 0026 backfill does). */
export function withTags(row) {
  const r = row || {};
  const missing = TAG_KEYS.every((k) => r[k] === undefined) || hasNoTags(r);
  return { ...r, ...cleanTags(missing ? tagsFromFreeText(r) : r) };
}

/** Tags from pasted text, with the extension's parser. null when BP is not loaded (the caller then uses tagsFromFreeText). */
export function tagsFromParsed(BP, text) {
  if (!BP || !BP.parseRequirementFields) return null;
  const raw = String(text || '');
  let f = {};
  let t = {};
  try { f = BP.parseRequirementFields(raw, { now: Date.now() }) || {}; } catch (e) { f = {}; }
  try { t = BP.extractPostTags ? BP.extractPostTags(raw) || {} : {}; } catch (e) { t = {}; }
  const rate = f.rate || {};
  const termsText = [rate.terms, ...(Array.isArray(t.engagement) ? t.engagement : [])].filter(Boolean).join(' ');
  let months = null;
  try { months = f.duration && BP.parseDurationMonths ? BP.parseDurationMonths(f.duration) : monthsFromText(f.duration); } catch (e) { months = null; }
  return cleanTags({
    visaAllowed: f.visaAllowed || [], visaNotAllowed: f.visaNotAllowed || [],
    termsTags: termsFromText(termsText),
    workModeTag: WORK_MODE_TAGS.includes(t.workMode) ? t.workMode : modeFromText(t.workMode),
    rateMin: rate.min, rateMax: rate.max, rateUnit: rate.unit, durationMonths: months
  });
}

/** The post takes this visa: not ruled out, and listed (or the post lists none). */
export function acceptsVisa(r, visa) {
  const v = String(visa || '');
  if (!v) return true;
  if ((r.visaNotAllowed || []).includes(v)) return false;
  return !(r.visaAllowed || []).length || r.visaAllowed.includes(v);
}

const HOURS = { hr: 1, day: 8, week: 40, month: 160, year: 2080 };
/** The top of the rate as an hourly figure (8 h day, 40 h week, 160 h month, 2,080 h year), or null. */
export function hourlyMax(r) {
  return r.rateMax !== null && r.rateMax !== undefined && HOURS[r.rateUnit] ? r.rateMax / HOURS[r.rateUnit] : null;
}

/**
 * @param {object[]} rows  requirement rows (withTags applied)
 * @param {{visa?:string, uscGcOnly?:boolean, terms?:string, workMode?:string, minRate?:number|string, minMonths?:number|string}} f
 *   visa: the post takes it · uscGcOnly: the post lists only USC and/or GC · terms: the post names it · workMode: equal ·
 *   minRate: pays at least this per hour (posts with no rate are left out) · minMonths: at least this long (no duration: left out)
 */
export function filterByTags(rows, f) {
  const q = f || {};
  const minRate = Number(q.minRate) || 0;
  const minMonths = Number(q.minMonths) || 0;
  return (rows || []).filter((r) => {
    if (q.visa && !acceptsVisa(r, q.visa)) return false;
    if (q.uscGcOnly && !((r.visaAllowed || []).length && r.visaAllowed.every((v) => v === 'USC' || v === 'GC'))) return false;
    if (q.terms && !(r.termsTags || []).includes(q.terms)) return false;
    if (q.workMode && r.workModeTag !== q.workMode) return false;
    if (minRate) { const h = hourlyMax(r); if (h === null || h < minRate) return false; }
    if (minMonths && !(r.durationMonths >= minMonths)) return false;
    return true;
  });
}

const money = (n) => '$' + (n >= 1000 && n % 1000 === 0 ? n / 1000 + 'k' : String(n));
export function rateLabel(r) {
  if (r.rateMin === null || r.rateMin === undefined || !RATE_UNITS[r.rateUnit]) return '';
  return (r.rateMin === r.rateMax ? money(r.rateMin) : money(r.rateMin) + '-' + money(r.rateMax).slice(1)) + RATE_UNITS[r.rateUnit];
}
export function durationLabel(m) {
  if (!m) return '';
  return m % 12 === 0 && m >= 12 ? (m === 12 ? '1 year' : m / 12 + ' years') : m + (m === 1 ? ' month' : ' months');
}

/** Short tag labels for a row: [{ text, kind }]. */
export function tagLabels(r) {
  const out = [];
  if ((r.visaAllowed || []).length) out.push({ text: r.visaAllowed.join(', '), kind: 'neutral' });
  if ((r.visaNotAllowed || []).length) out.push({ text: 'No ' + r.visaNotAllowed.join(', '), kind: 'warn' });
  for (const t of r.termsTags || []) out.push({ text: t, kind: 'neutral' });
  if (r.workModeTag) out.push({ text: MODE_LABELS[r.workModeTag], kind: 'neutral' });
  const rate = rateLabel(r);
  if (rate) out.push({ text: rate, kind: 'neutral' });
  if (r.durationMonths) out.push({ text: durationLabel(r.durationMonths), kind: 'neutral' });
  return out;
}
