// webapp/js/templates.js - team email templates and "Draft email" (backlog W7, migration 0028). Pure: no DOM, no network, no storage.
//
// One implementation of the email text, the extension's:
//   * the placeholders and their filling are BP.fillTemplate (lib/shared.js), through BP.Submissions.fillSubmitEmail (lib/submissions.js),
//     which also blanks unknown placeholders and drops "Label:" lines with no value, exactly as the extension's Submit draft does;
//   * the Gmail / Outlook compose address is BP.buildComposeUrl (lib/shared.js);
//   * the pitch, submit and hotlist defaults are the extension's DEFAULT_TEMPLATES. Follow-up and check-in are team-only kinds; their
//     defaults below use the same placeholders.
// bp-lib.js loadDraftLib() loads those files. The product never sends email: the draft opens in the user's own Gmail or Outlook.

export const TEMPLATE_KINDS = { pitch: 'Pitch', follow_up: 'Follow-up', hotlist_intro: 'Hotlist intro', check_in: 'Check-in' };
export const TEMPLATE_MAX = 40;
export const LIMITS = { name: 60, subject: 200, body: 5000, companyName: 80, website: 200, senderName: 80, jobTitle: 80, phone: 40 };

/** The placeholders a template may use: the keys of the extension's fillTemplate (lib/shared.js). A test checks every one is filled. */
export const PLACEHOLDERS = [
  ['firstName', "The vendor contact's first name"], ['recruiterName', "The vendor contact's full name"], ['company', 'The vendor company'],
  ['requirement', 'The requirement title'], ['location', 'The requirement location, in brackets'], ['technologies', 'The main skills of the requirement'],
  ['myName', 'Your name as you sign'], ['consultantName', 'Consultant name'], ['consultantTitle', 'Consultant title'],
  ['consultantSkills', 'Consultant skills'], ['consultantExperience', 'Consultant experience'], ['consultantVisa', 'Consultant visa'],
  ['consultantRate', 'Consultant rate'], ['consultantLocation', 'Consultant location'], ['consultantAvailability', 'Consultant availability'],
  ['consultantResume', 'Resume link (blank: team resumes are private)']
];

const FOLLOW_UP = {
  seedKey: 'follow_up', kind: 'follow_up', name: 'Follow-up on a submission',
  subject: 'Following up: {consultantName} for your {requirement} role',
  body: 'Hi {firstName},\n\nFollowing up on {consultantName}, whom I submitted for your {requirement} role {location}. ' +
    'Could you share an update on the profile or the next steps?\n\nThanks & Regards,\n{myName}'
};
const CHECK_IN = {
  seedKey: 'check_in', kind: 'check_in', name: 'Check-in with a vendor',
  subject: 'Checking in - new {technologies} requirements?',
  body: 'Hi {firstName},\n\nHope you are doing well. Checking in to see if you have new {technologies} requirements at {company}. ' +
    'We have consultants available to start right away.\n\nThanks & Regards,\n{myName}'
};

/** The defaults a team starts with (seeded the first time an owner or manager opens the templates). BP null = follow-up and check-in only. */
export function defaultTeamTemplates(BP) {
  const ext = (BP && Array.isArray(BP.DEFAULT_TEMPLATES)) ? BP.DEFAULT_TEMPLATES : [];
  const pick = (id) => ext.find((t) => t.id === id);
  const out = [];
  const add = (t, seedKey, kind) => { if (t) out.push({ seedKey, kind, name: t.name, subject: t.subject, body: t.body }); };
  add(pick('intro'), 'pitch', 'pitch');
  add(pick('consultant'), 'submit', 'pitch');
  add(pick('hotlist'), 'hotlist_intro', 'hotlist_intro');
  out.push({ ...FOLLOW_UP }, { ...CHECK_IN });
  return out.map((t, i) => ({ ...t, position: i }));
}

const t = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const line = (v, max) => t(String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' '), max);

/** A template from a form. Returns { ok, template } or { ok:false, error }. */
export function cleanTemplate(row) {
  const r = row || {};
  if (!TEMPLATE_KINDS[r.kind]) return { ok: false, error: 'Pick what the template is for.' };
  const name = line(r.name, LIMITS.name);
  if (!name) return { ok: false, error: 'Give the template a name.' };
  const body = String(r.body == null ? '' : r.body).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!body) return { ok: false, error: 'The email text is empty.' };
  if (body.length > LIMITS.body) return { ok: false, error: `Keep the email under ${LIMITS.body} characters.` };
  const subject = line(r.subject, LIMITS.subject);
  return { ok: true, template: { ...(r.id ? { id: r.id } : {}), kind: r.kind, name, subject, body, position: Number.isInteger(r.position) ? r.position : 0 } };
}

/** The company signature from the form: the website must be an http(s) address (https:// is added to a bare domain). */
export function cleanBranding(row) {
  const r = row || {};
  const companyName = line(r.companyName, LIMITS.companyName);
  let website = line(r.website, LIMITS.website).replace(/\s+/g, '');
  if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
  if (website && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(website)) return { ok: false, error: 'Enter the website as an address, for example https://example.com.' };
  return { ok: true, branding: { companyName, website } };
}

export function cleanSender(row) {
  const r = row || {};
  return { senderName: line(r.senderName, LIMITS.senderName), jobTitle: line(r.jobTitle, LIMITS.jobTitle), phone: line(r.phone, LIMITS.phone) };
}

/**
 * The plain-text signature added under the email: job title, company, phone, website (each only when set). The sender's name is signed
 * by the template's {myName}; it is added here only when the template has no {myName}. No images, no HTML.
 */
export function signatureBlock(branding, sender, opts) {
  const b = branding || {}, s = sender || {};
  const lines = [];
  if (opts && opts.withName && s.senderName) lines.push(s.senderName);
  for (const v of [s.jobTitle, b.companyName, s.phone, b.website]) if (line(v, 200)) lines.push(line(v, 200));
  return lines.join('\n');
}

/** The extension's lead shape (what fillTemplate reads) from a team requirement, its vendor contact and company. */
export function leadFor(o) {
  const x = o || {};
  const r = x.requirement || {}, c = x.contact || {}, v = x.vendor || {};
  return {
    recruiterName: c.name || '', companyName: v.name || '',
    requirement: r.title || '', location: r.location || '',
    technologies: (Array.isArray(r.skills) ? r.skills : []).slice(0, 3).join(', ')
  };
}

/** The extension's consultant shape (what fillTemplate reads) from a team consultant. Team resumes are private: no link goes in. */
export function consultantFor(c, today) {
  if (!c) return null;
  const avail = c.availableOn ? (!today || c.availableOn <= today ? 'Immediately' : 'From ' + c.availableOn) : '';
  return {
    name: c.name || '', title: c.title || '', skills: (Array.isArray(c.skills) ? c.skills : []).join(', '), visa: c.visa || '', visaType: c.visaType || '',
    rate: c.rate || '', location: c.location || '', availability: avail, experienceYears: c.experienceYears || '', resumeUrl: ''
  };
}

/**
 * Subject and body for one draft, filled by the extension's code, with the signature underneath.
 * @param {object} BP  the extension's BP (with Submissions) from loadDraftLib()
 * @param {{template:object, lead:object, consultant?:object|null, senderName:string, branding?:object, sender?:object, signature?:boolean, extra?:string}} o
 */
export function fillDraft(BP, o) {
  const i = o || {};
  const tpl = i.template || {};
  const filled = BP.Submissions.fillSubmitEmail({ template: tpl, lead: i.lead || {}, consultant: i.consultant || null, senderName: i.senderName || '' });
  const subject = filled.subject;
  // extra: a block under the text and above the signature (the masked profile summary, BP.Hotlist.profile)
  const body = i.extra ? filled.body.replace(/\s+$/, '') + '\n\n' + String(i.extra).trim() : filled.body;
  if (i.signature === false) return { subject, body };
  const sig = signatureBlock(i.branding, i.sender, { withName: !/\{myName\}/.test(String(tpl.body || '')) });
  return { subject, body: sig ? body.replace(/\s+$/, '') + '\n' + sig : body };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * May a draft to `to` be opened? The team book's Do not contact (owners and managers set it, on the contact or on its company) blocks it.
 * @param {{to:string, contacts:Array, vendors:Array, contactId?:string}} o
 * @returns {{ok:boolean, why:''|'to'|'dnc_contact'|'dnc_company', message:string}}
 */
export function draftGate(o) {
  const x = o || {};
  const to = String(x.to || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return { ok: false, why: 'to', message: "Enter the vendor's email address." };
  const contacts = Array.isArray(x.contacts) ? x.contacts : [];
  const vendors = Array.isArray(x.vendors) ? x.vendors : [];
  const hits = contacts.filter((c) => (x.contactId && c.id === x.contactId) || String(c.email || '').trim().toLowerCase() === to);
  if (hits.some((c) => c.doNotContact)) {
    return { ok: false, why: 'dnc_contact', message: 'This contact is marked Do not contact in the team book. No draft was opened. Ask an owner or manager if this is wrong.' };
  }
  const companyIds = new Set(hits.map((c) => c.companyId).filter(Boolean));
  const domain = to.split('@')[1];
  const blocked = vendors.find((v) => v.doNotContact && (companyIds.has(v.id) || (v.domain && String(v.domain).toLowerCase() === domain)));
  if (blocked) {
    return { ok: false, why: 'dnc_company', message: `${blocked.name || 'This vendor'} is marked Do not contact in the team book. No draft was opened. Ask an owner or manager if this is wrong.` };
  }
  return { ok: true, why: '', message: '' };
}

/** The Gmail or Outlook compose address (the extension's BP.buildComposeUrl). Only those two: the web app never builds mailto links. */
export function composeUrl(BP, client, to, subject, body) {
  return BP.buildComposeUrl(client === 'outlook' ? 'outlook' : 'gmail', String(to || '').trim(), subject || '', body || '');
}

/** Templates for a draft: the wanted kind first, then the rest (each kind in its saved order). */
export function orderForKind(list, kind) {
  const rank = (x) => (x.kind === kind ? 0 : 1);
  return (list || []).slice().sort((a, b) => rank(a) - rank(b) || (a.position || 0) - (b.position || 0) || String(a.name).localeCompare(String(b.name)));
}

/**
 * The built-in "Request RTR" email (P2): the extension's own template and fill (BP.Submissions.RTR_TEMPLATE / fillRtrEmail, placeholders
 * {consultant} {role} {end_client} {chain} {rate} {rate_terms} {valid_until} {myName}), with the company signature underneath. The consultant
 * replies "I confirm"; the person sends it from their own Gmail or Outlook. Not legal advice (BP.Submissions.NOT_LEGAL_ADVICE is shown next to it).
 * @param {object} BP  from loadDraftLib()
 * @param {{consultant:object, role:string, endClient:string, vendor:string, chain:string[], rate:number|string, rateUnit:string, taxTerms:string,
 *          validUntil:string, senderName:string, branding?:object, sender?:object}} o
 */
export function fillRtrDraft(BP, o) {
  const i = o || {};
  const { subject, body } = BP.Submissions.fillRtrEmail(i);
  const sig = signatureBlock(i.branding, i.sender, { withName: !String(i.senderName || '').trim() });
  return { subject, body: sig ? body.replace(/\s+$/, '') + '\n' + sig : body };
}
