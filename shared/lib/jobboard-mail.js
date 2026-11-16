// lib/jobboard-mail.js - job-board alert emails (Dice, Indeed, LinkedIn Job Alerts, ZipRecruiter, Monster, CareerBuilder) split into
// their jobs (backlog E16). A recruiter forwards these alerts to a BenchPilot inbox (team #284, Solo #291); one alert holds several jobs in a
// templated layout and comes from a machine sender, so the generic "Paste a requirement" reading (one requirement per email, the sender as
// the contact) does not fit it.
//
//   BP.JobBoardMail.detect(mail)                 -> { id, label } | null      sender domain, forwarded "From:" line, subject, job links
//   BP.JobBoardMail.parse(mail, { now })         -> { source, items[] } | null   null for mail that is not a job-board alert, or has no job
//   BP.JobBoardMail.isMachineSender(email)       -> true for no-reply / alert mailboxes and the boards' own domains (never a contact)
//   mail = { fromEmail, fromName, subject, text }   (text: the plain text the inbox Worker stored, or its HTML part as text)
//   item = { title, company, location, rateText, url, postedText, postedOn, contact: { email, phone } | null, fields, text }
//          fields = BP.parsePastedRequirement(item text) with the board's own title / location / rate put first.
//
// Pure and deterministic: no DOM, no storage, no network. The clock is only read through opts.now (ms, for "Posted 2 days ago").
// Loaded by the web app (webapp/js/bp-lib.js, after requirement.js) and by node tests (require). The extension pages do not use it yet.

(function (root) {
  'use strict';
  if (!root.BP && typeof require === 'function') require('./shared.js');
  if (!(root.BP && root.BP.parsePastedRequirement) && typeof require === 'function') require('./requirement.js');
  const BP = root.BP;

  const MAX_ITEMS = 100;
  const DAY = 86400000;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const URL_TAIL = '[^\\s<>"\'()\\[\\]]+';

  // One entry per board. `domains`: the sender's domain (or a subdomain of it). `sender`: when set, the sender's local part must match too
  // (LinkedIn sends all its mail from linkedin.com; only the job-alert mailboxes are boards). `job`: the board's own job links.
  const SOURCES = [
    { id: 'dice', label: 'Dice', domains: ['dice.com'], brand: /\bdice\b/i,
      job: new RegExp('https?://(?:www\\.)?dice\\.com/(?:job-detail|jobs/detail|apply)/' + URL_TAIL, 'gi') },
    { id: 'indeed', label: 'Indeed', domains: ['indeed.com', 'indeedemail.com'], brand: /\bindeed\b/i,
      job: new RegExp('https?://(?:[a-z]{2,3}\\.)?indeed\\.com/(?:rc/clk|viewjob|m/viewjob|pagead/clk|job/)' + URL_TAIL, 'gi') },
    { id: 'linkedin', label: 'LinkedIn Job Alerts', domains: ['linkedin.com'], sender: /^(?:jobalerts?|jobs-listings|jobs-noreply|job-alerts?)\b/i,
      brand: /\blinkedin\b/i, job: new RegExp('https?://(?:www\\.)?linkedin\\.com/(?:comm/)?jobs/view/' + URL_TAIL, 'gi') },
    { id: 'ziprecruiter', label: 'ZipRecruiter', domains: ['ziprecruiter.com'], brand: /\bzip\s?recruiter\b/i,
      job: new RegExp('https?://(?:www\\.)?ziprecruiter\\.com/(?:km|c|ek|jobs|job|jz)/' + URL_TAIL, 'gi') },
    { id: 'monster', label: 'Monster', domains: ['monster.com'], brand: /\bmonster\b/i,
      job: new RegExp('https?://(?:www\\.)?monster\\.com/(?:job-openings|jobs/[a-z-]*job)/' + URL_TAIL, 'gi') },
    { id: 'careerbuilder', label: 'CareerBuilder', domains: ['careerbuilder.com'], brand: /\bcareer\s?builder\b/i,
      job: new RegExp('https?://(?:www\\.)?careerbuilder\\.com/job/' + URL_TAIL, 'gi') }
  ];
  const BOARD_DOMAINS = SOURCES.flatMap((s) => s.domains);

  // A mailbox no person reads: never a vendor contact, whatever the email says.
  const MACHINE_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notify|notifications?|alerts?|jobalerts?|job-?alerts?|jobs-?(?:listings|noreply)|forwarding-noreply|bounces?|news(?:letter)?)(?:[-_.+].*)?$|(?:^|[-_.+])no-?reply(?:[-_.+]|$)/i;

  const domainOf = (email) => String(email || '').split('@')[1] || '';
  const onDomain = (domain, list) => { const d = String(domain || '').toLowerCase(); return list.some((x) => d === x || d.endsWith('.' + x)); };

  function isMachineSender(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e.includes('@')) return false;
    return MACHINE_LOCAL.test(e.split('@')[0]) || onDomain(domainOf(e), BOARD_DOMAINS);
  }

  function bySender(email) {
    const e = String(email || '').trim().toLowerCase();
    const local = e.split('@')[0];
    return SOURCES.find((s) => onDomain(domainOf(e), s.domains) && (!s.sender || s.sender.test(local))) || null;
  }

  // ── the text ───────────────────────────────────────────────────────────
  const FWD_START = /^(?:-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:?|-{2,}\s*original message\s*-{2,})$/i;
  const HEADER_LINE = /^(?:from|sent|date|to|cc|subject|reply-to)\s*:/i;
  const FOOTER = /^(?:unsubscribe\b|manage (?:your )?(?:job )?(?:alerts?|subscriptions?|email)|you(?:'|’| a)re receiving (?:this|these)|you received this|this (?:email|message) was (?:sent|intended)|(?:©|\(c\))\s*\d{4}|copyright\b|privacy policy|stop receiving|update your (?:email )?preferences|see (?:all|more) (?:jobs|matching jobs)|view (?:all|more) jobs|change (?:this )?alert|edit (?:this )?alert|turn off (?:this )?alert)/i;

  /** The forwarded headers' "From:" addresses (a recruiter who forwards by hand: the board's sender is only in the body). */
  function forwardedSenders(text) {
    const out = [];
    const lines = String(text || '').split('\n');
    for (let i = 0; i < lines.length && i < 400; i++) {
      if (!FWD_START.test(lines[i].trim())) continue;
      for (let j = i + 1; j < lines.length && j < i + 10; j++) {
        const m = /^from\s*:\s*.*?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.exec(lines[j].trim());
        if (m) { out.push(m[1].toLowerCase()); break; }
      }
    }
    return out;
  }

  /** The body without forwarded-message headers, cut at the alert's footer, as trimmed lines (blank lines kept as ''). */
  function bodyLines(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/^\s*>\s?/, '').trim());
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (FWD_START.test(l)) { while (i + 1 < lines.length && (HEADER_LINE.test(lines[i + 1]) || !lines[i + 1])) i += 1; continue; }
      if (FOOTER.test(l) && out.some(Boolean)) break;
      out.push(l);
    }
    return out;
  }

  function jobLinks(text, src) {
    const list = src ? [src] : SOURCES;
    const out = [];
    for (const s of list) for (const m of String(text || '').matchAll(s.job)) out.push({ source: s, url: m[0].replace(/[.,;:!?>]+$/, '') });
    return out;
  }

  /**
   * Which board sent the email, or null. In order: the sender, a forwarded "From:" line, the subject naming the board and a job alert,
   * two or more of one board's job links. One link alone is not enough (a vendor's own email can point at its Dice posting).
   */
  function detect(mail) {
    const m = mail || {};
    const s1 = bySender(m.fromEmail);
    if (s1) return { id: s1.id, label: s1.label };
    for (const f of forwardedSenders(m.text)) { const s = bySender(f); if (s) return { id: s.id, label: s.label }; }
    const subject = String(m.subject || '');
    if (/\bjobs?\b|\balerts?\b/i.test(subject)) {
      const s = SOURCES.find((x) => x.brand.test(subject) && (x.id !== 'linkedin' || /\bjob alert\b|\bjobs? (?:for you|matching|you may be interested in)\b/i.test(subject)));
      if (s) return { id: s.id, label: s.label };
    }
    const counts = new Map();
    for (const l of jobLinks(m.text)) counts.set(l.source, (counts.get(l.source) || 0) + 1);
    for (const [s, n] of counts) if (n >= 2) return { id: s.id, label: s.label };
    return null;
  }

  // ── one line ───────────────────────────────────────────────────────────
  const US_STATE = '(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])';
  const LOC_RE = new RegExp('(?:^|[\\s(])(?:remote|hybrid|on-?site|united states|usa?|anywhere in the us)\\b|,\\s*' + US_STATE + '\\b|^[A-Z][A-Za-z .\'-]+,\\s*[A-Z][a-z]+', 'i');
  const RATE_RE = /\$\s?\d|\b\d{2,3}(?:\.\d+)?\s*(?:\/\s*h(?:ou)?r\b|per hour\b|an hour\b|hourly\b)|\b\d{2,3}k\b|\bUSD\b|\bDOE\b|depends on experience/i;
  const POSTED_RE = /^(?:posted\s*(?:on|:)?\s*)?(?:just posted|today|yesterday|new|\d+\+?\s*(?:minutes?|mins?|hours?|hrs?|days?|d|weeks?|wks?|months?)\s*ago)$|^posted\b|^date posted\b/i;
  const TERMS_RE = /^(?:contract(?:\s*(?:to|-)\s*hire)?|full[- ]?time|part[- ]?time|c2c|corp[- ]to[- ]corp|w-?2|1099|third party|contract\s*-\s*(?:w2|c2c|independent|corp-to-corp)|contract[,/ ]+(?:w2|c2c|1099)(?:[,/ ]+(?:w2|c2c|1099))*)$/i;
  const NOISE_RE = /^(?:[-|•·*]+|apply(?: now)?|easily apply|easy apply|quick apply|1-click apply|view (?:job|details|this job)|see (?:job|details)|job details|more details|details|save(?: job)?|promoted|sponsored|urgently hiring|actively (?:hiring|recruiting)|new|be an early applicant|responsive employer|hiring multiple candidates|\d+\+? applicants?|view similar jobs|read more|learn more|job alert|top match|great match|good match)$/i;
  const INTRO_RE = /\bjobs$|\bnew jobs?\b|\bjobs? (?:for you|matching|that match|you may|based on)\b|\bjob alerts?\b|\byour (?:job )?(?:alert|search)\b|\brecommended\b|^(?:hi|hello|dear)\b|^here (?:are|is)\b|\bmatching your\b|^\d+\s+(?:new\s+)?jobs?\b/i;
  const LABEL_RE = /^(job title|title|position|role|company|employer|client|location|rate|pay|salary|compensation|posted(?: on)?|date posted|job type|employment type|type)\s*:\s*(.*)$/i;
  const SEP_RE = /\s+(?:-|–|—|·|•)\s+/;
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/;
  const URL_RE = /<?\bhttps?:\/\/[^\s<>"')\]]+>?/gi;

  const isLoc = (s) => LOC_RE.test(s) && s.length <= 60 && !/\$/.test(s);
  const isRate = (s) => RATE_RE.test(s) && s.length <= 80;
  const isPosted = (s) => POSTED_RE.test(s) && s.length <= 40;
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const stripBullet = (s) => s.replace(/^(?:[-•·*]|\d{1,3}[.)])\s+/, '').trim();

  /** "Acme Tech | Dallas, TX | $60/hr | Contract" -> its parts by kind. */
  function splitDetails(line) {
    const out = { company: '', location: '', rate: '', posted: '', terms: '', other: [] };
    if (TERMS_RE.test(line)) return null;   // "Contract - W2" is one job type
    const parts = [];
    for (const p of line.split(line.includes('|') ? /\s*\|\s*/ : SEP_RE).map((x) => x.trim()).filter(Boolean)) {
      // "$65 - $75/hr": one rate, not two parts
      if (parts.length && /^\$?\s?\d/.test(p) && /^\$?\s?\d/.test(parts[parts.length - 1])) parts[parts.length - 1] += ' - ' + p; else parts.push(p);
    }
    if (parts.length < 2) return null;
    for (const p of parts) {
      if (!out.location && isLoc(p)) out.location = p;
      else if (!out.rate && isRate(p)) out.rate = p;
      else if (!out.posted && isPosted(p)) out.posted = p;
      else if (!out.terms && TERMS_RE.test(p)) out.terms = p;
      else if (!NOISE_RE.test(p)) out.other.push(p);
    }
    if (!out.location && !out.rate && !out.posted && !out.terms) return null;
    out.company = out.other.shift() || '';
    return out;
  }

  /** "Posted 3 days ago" -> 'YYYY-MM-DD' (from opts.now), '' when the text gives no day. */
  function postedOn(text, now) {
    const t = String(text || '').toLowerCase();
    if (!t || !Number.isFinite(now)) return '';
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    if (/just posted|\btoday\b|\bnew\b|\b\d+\+?\s*(?:minutes?|mins?|hours?|hrs?)\s*ago/.test(t)) return iso(now);
    if (/\byesterday\b/.test(t)) return iso(now - DAY);
    let m = /(\d+)\+?\s*(days?|d|weeks?|wks?)\s*ago/.exec(t);
    if (m) return iso(now - Number(m[1]) * (/^w/.test(m[2]) ? 7 : 1) * DAY);
    m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
    if (m) return m[0];
    m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(t);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(t);
    if (m) return `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return '';
  }

  // ── one job ────────────────────────────────────────────────────────────
  /** The fields of one job from its lines (blank lines dropped). */
  function readJob(lines, src, now) {
    const it = { title: '', company: '', location: '', rateText: '', url: '', postedText: '', postedOn: '', terms: '', extra: [] };
    for (let raw of lines) {
      for (const l of jobLinks(raw, src)) if (!it.url) it.url = l.url;
      raw = stripBullet(raw.replace(URL_RE, ' ').replace(/^\s*(?:view job|apply(?: now)?|link|url|job link|details)\s*:?\s*/i, '').replace(/\s+/g, ' ').trim());
      if (!raw || NOISE_RE.test(raw) || (!it.title && INTRO_RE.test(raw) && !LABEL_RE.test(raw))) continue;
      const lab = LABEL_RE.exec(raw);
      if (lab) {
        const k = lab[1].toLowerCase(); const v = lab[2].trim();
        if (/title|position|role/.test(k) && !it.title) it.title = v;
        else if (/company|employer|client/.test(k) && !it.company) it.company = v;
        else if (k === 'location' && !it.location) it.location = v;
        else if (/rate|pay|salary|compensation/.test(k) && !it.rateText) it.rateText = v;
        else if (/posted/.test(k) && !it.postedText) it.postedText = v;
        else if (/type/.test(k) && !it.terms) it.terms = v;
        continue;
      }
      if (!it.title) { it.title = raw; continue; }
      const d = splitDetails(raw);
      if (d) {
        if (d.company && !it.company) it.company = d.company;
        if (d.location && !it.location) it.location = d.location;
        if (d.rate && !it.rateText) it.rateText = d.rate;
        if (d.posted && !it.postedText) it.postedText = d.posted;
        if (d.terms && !it.terms) it.terms = d.terms;
        continue;
      }
      if (isPosted(raw) && !it.postedText) { it.postedText = raw.replace(/^posted\s*(?:on|:)?\s*/i, '').trim() || raw; continue; }
      if (isRate(raw) && !it.rateText) { it.rateText = raw; continue; }
      if (isLoc(raw) && !it.location) { it.location = raw; continue; }
      if (TERMS_RE.test(raw) && !it.terms) { it.terms = raw; continue; }
      if (!it.company && !it.location && raw.length <= 80 && !/[.!?]$/.test(raw)) { it.company = raw; continue; }
      it.extra.push(raw);
    }
    it.postedOn = postedOn(it.postedText, now);
    return it;
  }

  /** Lines between job links, the link at the start (a "Title <link>" line, or a link with the job after it) or at the end of each job. */
  function blocksByLinks(lines, src) {
    const at = [];
    lines.forEach((l, i) => { if (jobLinks(l, src).length) at.push(i); });
    if (!at.length) return null;
    const titled = at.filter((i) => /[A-Za-z]{3}/.test(lines[i].replace(URL_RE, '').replace(/^\s*(?:view job|apply(?: now)?|link|url|job link|details)\s*:?/i, ''))).length;
    const content = (from, to) => lines.slice(from, to).filter((l) => l && !NOISE_RE.test(l) && !INTRO_RE.test(l)).length;
    const after = content(at[at.length - 1] + 1, lines.length);
    const blocks = [];
    if (titled * 2 > at.length || after >= 2) {
      // The link opens each job: on the title line, or alone on the line after the title.
      const starts = at.map((i) => (titled * 2 > at.length || i === 0 || !lines[i - 1] || at.includes(i - 1) ? i : i - 1));
      starts.forEach((s, k) => blocks.push(lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length)));
    } else {
      at.forEach((e, k) => blocks.push(lines.slice(k ? at[k - 1] + 1 : 0, e + 1)));
    }
    return blocks;
  }

  /**
   * No job links (an HTML alert as text: its links are gone). A job starts at a title-like line once the job before has its details
   * (company and location, rate or posted day); details, labels and description lines join the current job.
   */
  function blocksByLayout(lines) {
    const blocks = [];
    let cur = null; let details = 0; let named = 0;
    const flush = () => { if (cur && cur.length) blocks.push(cur); cur = null; details = 0; named = 0; };
    for (const raw of lines) {
      const l = stripBullet(raw);
      if (!l) continue;
      if (/^[-=_*~•·]{3,}$/.test(l)) { flush(); continue; }
      if (NOISE_RE.test(l)) { if (cur) cur.push(l); continue; }
      const lab = LABEL_RE.exec(l);
      const isTitleLabel = lab && /title|position|role/i.test(lab[1]);
      const detail = (lab && !isTitleLabel) || splitDetails(l) || isPosted(l) || isRate(l) || isLoc(l) || TERMS_RE.test(l);
      if (detail) { if (cur) { cur.push(l); details += 1; } continue; }
      const titleLike = l.length <= 100 && !/[.!?]$/.test(l) && !INTRO_RE.test(l);
      if (isTitleLabel || (titleLike && (!cur || details > 0 || named >= 2))) { flush(); cur = [l]; named = 1; continue; }
      if (cur) { cur.push(l); if (titleLike) named += 1; }
    }
    flush();
    return blocks;
  }

  function contactIn(text) {
    const lines = String(text || '').split('\n');
    for (const e of String(text || '').match(EMAIL_RE) || []) {
      const email = e.toLowerCase();
      if (isMachineSender(email)) continue;
      const i = lines.findIndex((l) => l.toLowerCase().includes(email));
      let phone = '';
      for (const l of [lines[i], lines[i + 1], lines[i - 1]]) { const p = l && PHONE_RE.exec(l); if (p) { phone = p[0].trim(); break; } }
      return { email, phone };
    }
    return null;
  }

  function generic(text, now) {
    if (BP && typeof BP.parsePastedRequirement === 'function') {
      try { return BP.parsePastedRequirement(text, { now }); } catch (e) { /* fall through */ }
    }
    return { title: '', endClient: '', jobRef: '', rateText: '', workMode: '', location: '', visaText: '', taxTerms: '', duration: '', skills: [] };
  }

  /** The job-board alert's jobs, or null (not a board's alert, or no job could be read from it). */
  function parse(mail, opts) {
    const m = mail || {};
    const source = detect(m);
    if (!source) return null;
    const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
    const src = SOURCES.find((s) => s.id === source.id);
    const lines = bodyLines(m.text);
    const blocks = blocksByLinks(lines, src) || blocksByLinks(lines, null) || blocksByLayout(lines);
    const items = [];
    const seen = new Set();
    for (const b of blocks) {
      const job = readJob(b.filter(Boolean), src, now);
      if (!job.title || INTRO_RE.test(job.title) || job.title.length > 140) continue;
      if (!job.url && !job.company && !job.location && !job.rateText && !job.postedText) continue;
      const key = (job.url || (job.title + '|' + job.company + '|' + job.location)).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const head = [job.title, job.company && 'Company: ' + job.company, job.location && 'Location: ' + job.location, job.rateText && 'Rate: ' + job.rateText,
        job.terms && 'Job type: ' + job.terms, job.postedText && 'Posted: ' + job.postedText].filter(Boolean);
      const text = head.concat(job.extra, job.url ? ['Job link: ' + job.url] : []).join('\n').slice(0, 4000);
      const f = generic(text, now);
      const fields = { ...f, title: clip(job.title, 120), location: clip(job.location || f.location, 120), rateText: clip(job.rateText || f.rateText, 60) };
      // The board's job type line ("Contract - W2") names the tax terms more exactly than the free text reading does.
      const named = [['W2', /\bw-?2\b/i], ['C2C', /\bc2c\b|corp[- ]to[- ]corp/i], ['1099', /\b1099\b/]].filter(([, re]) => re.test(job.terms));
      if (named.length === 1) fields.taxTerms = named[0][0];
      items.push({
        title: fields.title, company: clip(job.company, 120), location: fields.location, rateText: fields.rateText, url: job.url.slice(0, 2000),
        postedText: clip(job.postedText, 60), postedOn: job.postedOn, contact: contactIn(b.join('\n')), fields, text
      });
      if (items.length >= MAX_ITEMS) break;
    }
    return items.length ? { source, items } : null;
  }

  BP.JobBoardMail = { MAX_ITEMS, SOURCES: SOURCES.map((s) => ({ id: s.id, label: s.label, domains: s.domains.slice() })), detect, parse, isMachineSender, postedOn };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof self !== 'undefined' ? self : globalThis).BP.JobBoardMail;
}
