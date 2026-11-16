// lib/hotlist.js - the hotlist builder's formatter (spec docs/specs/HOTLIST_BUILDER_SPEC.md). Pure: no DOM, no chrome.*, no clock unless
// `today` is left out. Needs lib/shared.js first (BP.splitSkills, BP.csvCell, BP.escapeHtml, BP.pitch*). Exposes BP.Hotlist.
// Used by the dashboard's Bench page (dashboard/views/bench.js) and the team web app's Bench screen (webapp/js/screens/bench.js, loaded
// through webapp/js/bp-lib.js), so both produce the very same text, table and file.
//
//   fromExtension(c, today)       an extension consultant  -> entry     (today: 'YYYY-MM-DD', default the computer's day)
//   fromTeam(c, today)            a team web-app consultant -> entry     (today: 'YYYY-MM-DD', for "Available from ...")
//   entry = { id, name, role, years, skills: [], visa, location, relocation: 'yes'|'no'|'negotiable'|'', terms, rate, availability }
//   cleanPrefs(saved)             { columns: [keys in order], nameStyle }   unknown or broken values fall back to DEFAULT_PREFS
//   table(entries, prefs)         { headers, rows }   the chosen columns, in order (the CSV / Excel content, before the formula guard)
//   text(entries, prefs, opts)    { subject, body }   plain-text email           opts: { myName, today }
//   html(entries, prefs, opts)    HTML string: greeting, a <table>, sign-off      (every value escaped; no colours, no classes)
//   csv(entries, prefs)           CSV text with a BOM; every cell through BP.csvCell (formula guard)
//   profile(entry, opts)          the masked one-page profile summary of ONE consultant (no contact details):
//                                 { name, headline, facts: [[label, value]], skills: [], note, text }   opts: { nameStyle: 'short'|'initials', rate, myName }
//   profileText(entries, opts)    the profile summaries one after another (the hotlist's "Add profile summaries" option and pitch drafts)
//   cleanProfileOpts(saved)       { nameStyle, rate }   'full' is never allowed: a profile summary is always masked
//
// Privacy (hard rule): an entry holds only the fields above. A consultant's phone, email, notes, resume and owner never reach an
// entry, so no output can contain them. The visa column is the work-authorisation TYPE only (BP.visaLabel): the free-text visa note
// and the work-authorisation end date (workAuthUntil) never reach an entry either.
// The profile summary is built from an entry too, so it has the same guarantee; its name is always masked (initials or first name + last
// initial) and nothing about the resume file is read or changed (a summary, not an edited resume).
(function (root) {
  'use strict';

  const BP = root.BP;
  const COLUMNS = [
    ['name', 'Consultant'], ['role', 'Role'], ['experience', 'Experience'], ['skills', 'Top skills'], ['visa', 'Visa'],
    ['location', 'Location'], ['terms', 'Terms'], ['rate', 'Rate'], ['availability', 'Availability']
  ];
  const COLUMN_KEYS = COLUMNS.map(c => c[0]);
  const COLUMN_LABELS = Object.fromEntries(COLUMNS);
  const NAME_STYLES = [['short', 'First name + last initial'], ['initials', 'Initials'], ['full', 'Full name']];
  const NAME_STYLE_KEYS = NAME_STYLES.map(s => s[0]);
  const DEFAULT_PREFS = Object.freeze({ columns: COLUMN_KEYS.filter(k => k !== 'rate'), nameStyle: 'short', profiles: false });
  const MAX_SKILLS = 5;
  const PREVIEW_FREE = 3;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const str = (v, max) => BP.pitchClean(v, max || 120);

  function relocationOf(v) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s === 'yes' || s === 'no' || s === 'negotiable' ? s : '';
  }
  function termsOf(v) {
    const t = str(v, 10).toUpperCase();
    return t === 'ANY' ? 'C2C / W2' : t;
  }
  function skillsOf(v) {
    const list = Array.isArray(v) ? v.map(s => str(s, 40)).filter(Boolean) : BP.splitSkills(v);
    const seen = new Set();
    return list.filter(s => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  function fromExtension(c, today) {
    const x = c || {};
    return {
      id: String(x.id || ''), name: str(x.name, 80), role: str(x.title, 80), years: str(x.experienceYears, 20), skills: skillsOf(x.skills),
      visa: str(BP.visaLabel(x), 30), location: str(x.location, 60), relocation: relocationOf(x.relocation), terms: termsOf(x.taxTerms),
      rate: str(x.rate, 60), availability: BP.availabilityText(x, today || BP.todayStr()) || BP.pitchAvailability(x.availability)
    };
  }

  function dayLabel(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '';
  }
  function fromTeam(c, today) {
    const x = c || {};
    const on = String(x.availableOn || '');
    const availability = !on ? '' : (!today || on <= today) ? 'Available now' : dayLabel(on) ? 'Available from ' + dayLabel(on) : '';
    return {
      id: String(x.id || ''), name: str(x.name, 80), role: str(x.title, 80), years: str(x.experienceYears, 20), skills: skillsOf(x.skills),
      visa: str(BP.visaLabel(x), 30), location: str(x.location, 60), relocation: relocationOf(x.relocation), terms: termsOf(x.taxTerms),
      rate: str(x.rate, 60), availability
    };
  }

  function cleanPrefs(saved) {
    const s = saved && typeof saved === 'object' ? saved : {};
    const seen = new Set();
    const cols = Array.isArray(s.columns) ? s.columns.filter(k => COLUMN_KEYS.includes(k) && !seen.has(k) && seen.add(k)) : [];
    return {
      columns: cols.length ? cols : DEFAULT_PREFS.columns.slice(),
      nameStyle: NAME_STYLE_KEYS.includes(s.nameStyle) ? s.nameStyle : DEFAULT_PREFS.nameStyle,
      profiles: s.profiles === true
    };
  }

  function shownName(name, style) {
    const words = String(name || '').split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    if (style === 'full') return words.join(' ');
    const initial = (w) => w.charAt(0).toUpperCase() + '.';
    if (style === 'initials') return words.map(initial).join('');
    return words.length === 1 ? words[0] : words[0] + ' ' + initial(words[words.length - 1]);
  }

  function locationText(e) {
    if (!e.location) return '';
    if (e.relocation === 'yes') return e.location + ' (open to relocate)';
    if (e.relocation === 'negotiable') return e.location + ' (relocation negotiable)';
    return e.location;
  }

  function cell(e, key, prefs) {
    switch (key) {
      case 'name': return shownName(e.name, prefs.nameStyle);
      case 'role': return e.role;
      case 'experience': return BP.pitchExperience(e.years);
      case 'skills': return e.skills.slice(0, MAX_SKILLS).join(', ');
      case 'visa': return e.visa;
      case 'location': return locationText(e);
      case 'terms': return e.terms;
      case 'rate': return e.rate;
      case 'availability': return e.availability;
      default: return '';
    }
  }

  function table(entries, prefs) {
    const p = cleanPrefs(prefs);
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    return { headers: p.columns.map(k => COLUMN_LABELS[k]), rows: list.map(e => p.columns.map(k => cell(e, k, p))) };
  }

  function todayYmd(today) {
    if (today) return today;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function subject(entries, today) {
    const roles = [];
    const seen = new Set();
    for (const e of entries) { const k = e.role.toLowerCase(); if (e.role && !seen.has(k)) { seen.add(k); roles.push(e.role); } }
    const named = roles.slice(0, 3).join(', ');
    const more = roles.length > 3 ? ` + ${roles.length - 3} more` : '';
    const n = entries.length;
    return `Hotlist ${dayLabel(todayYmd(today))}: ` + (named ? named + more : `${n} available consultant${n === 1 ? '' : 's'}`);
  }

  const GREETING = 'Hi,';
  const INTRO = 'Please find our available consultants below. Reply with the role you have open and I will send the resume.';
  const signOff = (myName) => ['Thanks & Regards,', str(myName, 60)].filter(Boolean);

  function text(entries, prefs, opts) {
    const o = opts || {};
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const t = table(list, prefs);
    const lines = t.rows.map((r, i) => `${i + 1}. ${r.filter(Boolean).join(' | ')}`);
    const p = cleanPrefs(prefs);
    const extra = p.profiles && list.length ? ['', PROFILES_HEADING, '', profileText(list, profileOptsFor(p)), ''] : [];
    const body = [GREETING, '', INTRO, '', ...lines, ...extra, '', ...signOff(o.myName)].join('\n');
    return { subject: subject(list, o.today), body };
  }

  function html(entries, prefs, opts) {
    const o = opts || {};
    const esc = BP.escapeHtml;
    const t = table(entries, prefs);
    const th = t.headers.map(h => `<th align="left" style="border:1px solid;padding:4px 8px">${esc(h)}</th>`).join('');
    const trs = t.rows.map(r => '<tr>' + r.map(v => `<td style="border:1px solid;padding:4px 8px">${esc(v)}</td>`).join('') + '</tr>').join('');
    const p = cleanPrefs(prefs);
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const profiles = p.profiles && list.length
      ? `<p><b>${esc(PROFILES_HEADING)}</b></p>` + list.map(e => profileHtmlBlock(profile(e, profileOptsFor(p)))).join('')
      : '';
    return `<p>${esc(GREETING)}</p><p>${esc(INTRO)}</p>` +
      `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>` +
      profiles +
      `<p>${signOff(o.myName).map(esc).join('<br>')}</p>`;
  }

  // ── Profile summary: one consultant on one page, contact details left out (A9, the masked profile) ──
  // Built from an entry (fromExtension / fromTeam), so phone, email, LinkedIn, notes, the resume and the work-authorisation end date can never
  // reach it. The name is always masked. Printed from the browser (Save as PDF) and attached by the user; BenchPilot sends nothing.
  const PROFILE_NAME_STYLES = NAME_STYLES.filter(n => n[0] !== 'full');
  const PROFILE_NAME_KEYS = PROFILE_NAME_STYLES.map(n => n[0]);
  const PROFILE_SKILLS = 20;
  const PROFILES_HEADING = 'Profile summaries';
  const PROFILE_NOTE = 'Contact details are not included in this summary. Reply to arrange an interview.';
  function cleanProfileOpts(saved) {
    const s = saved && typeof saved === 'object' ? saved : {};
    return { nameStyle: PROFILE_NAME_KEYS.includes(s.nameStyle) ? s.nameStyle : 'short', rate: s.rate !== false };
  }
  // The hotlist's own choices carry over to its profile summaries: the name style (a full name becomes first name + last initial) and the rate
  // only when the Rate column is on.
  function profileOptsFor(prefs) {
    return cleanProfileOpts({ nameStyle: prefs.nameStyle, rate: prefs.columns.includes('rate') });
  }
  function profile(entry, opts) {
    const e = entry || {};
    const o = cleanProfileOpts(opts);
    const name = shownName(e.name, o.nameStyle) || 'Consultant';
    const exp = BP.pitchExperience(e.years).replace(/\byrs?\b/, 'years');   // a page, not a one-line pitch: spelt out
    const skills = Array.isArray(e.skills) ? e.skills.slice(0, PROFILE_SKILLS) : [];
    const facts = [
      ['Experience', exp], ['Work authorisation', e.visa], ['Location', locationText(e || {})], ['Availability', e.availability],
      ['Tax terms', e.terms], ['Rate', o.rate ? e.rate : '']
    ].filter(f => f[1]);
    const headline = [e.role, exp].filter(Boolean).join(' · ');
    const text = [`Consultant profile: ${name}`, headline, '', ...facts.map(f => `${f[0]}: ${f[1]}`),
      skills.length ? `Skills: ${skills.join(', ')}` : '', '', PROFILE_NOTE].filter((l, i, all) => l || (all[i - 1] && i < all.length - 1)).join('\n');
    return { name, headline, facts, skills, note: PROFILE_NOTE, text };
  }
  function profileText(entries, opts) {
    return (Array.isArray(entries) ? entries.filter(Boolean) : []).map(e => profile(e, opts).text).join('\n\n---\n\n');
  }
  function profileHtmlBlock(pr) {
    const esc = BP.escapeHtml;
    return `<p><b>${esc(pr.name)}</b>${pr.headline ? '<br>' + esc(pr.headline) : ''}<br>` +
      pr.facts.map(f => `${esc(f[0])}: ${esc(f[1])}`).join('<br>') +
      (pr.skills.length ? `<br>Skills: ${esc(pr.skills.join(', '))}` : '') + '</p>';
  }

  function csv(entries, prefs) {
    const t = table(entries, prefs);
    const c = BP.csvCell;
    return '﻿' + [t.headers.map(c).join(','), ...t.rows.map(r => r.map(c).join(','))].join('\r\n');
  }

  BP.Hotlist = {
    COLUMNS, COLUMN_KEYS, COLUMN_LABELS, NAME_STYLES, DEFAULT_PREFS, MAX_SKILLS, PREVIEW_FREE,
    fromExtension, fromTeam, cleanPrefs, shownName, table, text, html, csv,
    PROFILE_NAME_STYLES, PROFILE_SKILLS, PROFILE_NOTE, PROFILES_HEADING, cleanProfileOpts, profile, profileText
  };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP.Hotlist;
}
