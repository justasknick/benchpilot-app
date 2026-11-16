// webapp/js/audit-lib.js - the activity log ("who changed what") as plain-language lines. Pure, no DOM.
//
// The log (public.activity_log, migration 0011) holds ids only: actor, action, entity, entity_id and a few non-personal status fields
// in before/after. Names are resolved here from the team book the screen already loaded; an id the book no longer has reads
// "a consultant" etc. Nothing from the log is shown except whitelisted status fields, so no email or phone can reach the screen or CSV.
//
// Two vocabularies reach this file and both are normalised to { kind, verb }:
//   live   triggers: action insert|update|delete, entity = table name (consultants, vendor_companies, ...)
//          functions: action 'member.set_role', 'invite.create', 'team.export', ... (0012-0023, bp_team_log_event)
//   demo   DemoStore._log: 'consultant_added', 'role_changed', ... with a singular entity

/** Entity kinds a person can filter on, with the raw `entity` values (live and demo) each one covers. */
export const AUDIT_KINDS = {
  consultant: { label: 'Consultants', noun: 'consultant', entities: ['consultants', 'consultant'] },
  requirement: { label: 'Requirements', noun: 'requirement', entities: ['requirements', 'requirement'] },
  vendor: { label: 'Vendors', noun: 'vendor', entities: ['vendor_companies', 'vendor_company'] },
  contact: { label: 'Vendor contacts', noun: 'vendor contact', entities: ['vendor_contacts', 'vendor_contact'] },
  submission: { label: 'Submissions', noun: 'submission', entities: ['submissions', 'submission'] },
  member: { label: 'People and invites', noun: 'member', entities: ['team_member', 'member', 'team_invite', 'invite'] },
  inbox: { label: 'Inbox', noun: 'inbox', entities: ['inbox_address', 'inbox_message'] },
  desk: { label: 'Desks', noun: 'desk', entities: ['team_desks', 'desk'] },
  seat: { label: 'Desk seats', noun: 'desk seat', entities: ['team_desk_members', 'desk_member'] },
  template: { label: 'Email templates', noun: 'template', entities: ['team_templates', 'template', 'team_branding'] },
  team: { label: 'Workspace', noun: 'workspace', entities: ['team', 'report_run'] }
};

const KIND_OF = new Map();
for (const [kind, k] of Object.entries(AUDIT_KINDS)) for (const e of k.entities) KIND_OF.set(e, kind);

/** Raw `entity` values for one kind ('' = all kinds -> null, no filter). */
export function entitiesFor(kind) {
  return kind && AUDIT_KINDS[kind] ? AUDIT_KINDS[kind].entities.slice() : null;
}

// Function and demo actions -> a phrase. {x} is the record's name (or "a <noun>").
const PHRASES = {
  'member.set_role': 'changed the role of {x}', role_changed: 'changed the role of {x}',
  'member.remove': 'removed {x} from the team', member_removed: 'removed {x} from the team',
  'invite.create': 'sent an invite', member_invited: 'sent an invite',
  'invite.revoke': 'cancelled an invite', invite_revoked: 'cancelled an invite',
  'invite.resend': 'sent an invite again',
  'member.leave': 'left the team',
  'invite.accept': 'joined the team',
  'team.transfer_owner': 'made {x} the owner',
  'team.create': 'created the workspace',
  'team.settings': 'changed the workspace settings', team_updated: 'changed the workspace settings',
  'team.export': 'exported the whole book',
  'team.import': 'imported a book', team_import: 'imported a book',
  'team.delete': 'deleted the workspace',
  'team.marked_for_deletion': 'closed the workspace',
  'team.paid': 'paid for the plan',
  'team.refund': 'recorded a refund',
  'team.pilot_extended': 'extended the pilot',
  'team.pilot_extension_requested': 'asked for a longer pilot',
  'team.referred': 'recorded a referral',
  'inbox.address_create': 'created an inbox address', inbox_address_created: 'created an inbox address',
  'inbox.address_disable': 'turned off an inbox address', inbox_address_disabled: 'turned off an inbox address',
  'inbox.mark': 'sorted inbox emails', 'inbox.item_mark': 'sorted jobs in a job-board alert',
  'ext.save': 'saved {x} from LinkedIn',
  'resume.add': 'uploaded a resume for {x}', resume_added: 'uploaded a resume for {x}',
  'resume.delete': 'deleted a resume of {x}', resume_deleted: 'deleted a resume of {x}',
  guard_override: 'submitted {x} past the duplicate guard',
  templates_seeded: 'saved the starting email templates', branding_updated: 'changed the company signature',
  desk_seat: 'changed who sits on a desk',
    'report.sent': 'sent the morning report', 'report.failed': 'could not send the morning report', 'report.skipped': 'skipped the morning report'
};

const VERBS = { insert: 'added', update: 'changed', delete: 'deleted', added: 'added', created: 'added', updated: 'changed', deleted: 'deleted' };

/** Status fields that may be shown (the same list the 0011 trigger keeps, plus role). Anything else in before/after is ignored. */
const SAFE = { status: 'status', stage: 'stage', tier: 'tier', rtr_status: 'RTR', do_not_contact: 'do not contact', source: 'source', role: 'role' };
const FIELD_LABELS = {
  name: 'name', title: 'title', skills: 'skills', visa: 'visa', tax_terms: 'tax terms', rate: 'rate', location: 'location', relocation: 'relocation',
  available_on: 'available date', status: 'status', owner_recruiter: 'recruiter', stage: 'stage', rtr_status: 'RTR', tier: 'tier', do_not_contact: 'do not contact',
  end_client: 'end client', job_ref: 'job ref', rate_text: 'rate', work_mode: 'work mode', notes: 'notes', email: 'email', phone: 'phone', linkedin_url: 'LinkedIn',
  company_id: 'company', vendor_company_id: 'vendor', vendor_contact_id: 'vendor contact', consultant_id: 'consultant', requirement_id: 'requirement',
  recruiter_id: 'recruiter', submitted_on: 'submitted date', override_reason: 'guard reason', domain: 'domain', source: 'source', tags: 'tags',
  subject: 'subject', body: 'text', kind: 'kind', company_name: 'company name', website: 'website',
  desk_id: 'desk', office: 'office'
};

const plainValue = (v) => {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  const s = String(v == null ? '' : v);
  if (!s || s.length > 40 || /@|\d{6,}/.test(s)) return '';      // never a long value, an email or a phone-like number
  return s.replace(/_/g, ' ');
};

/** Normalise one row from either store into { kind, verb, action }. `verb` is set for record changes, `action` keeps the raw key. */
export function classify(row) {
  const entity = String(row.entity || '');
  const action = String(row.action || '');
  const kind = KIND_OF.get(entity) || 'team';
  if (PHRASES[action]) return { kind, verb: '', action };
  if (VERBS[action]) return { kind, verb: VERBS[action], action };
  const m = /_(added|created|updated|deleted)$/.exec(action);            // demo: 'consultant_added', 'submission_created'
  if (m) return { kind, verb: VERBS[m[1]], action };
  return { kind, verb: '', action };
}

/**
 * The name of the record a row is about, from the team book (`lk` = ctx.lk plus requirements and submissions maps).
 * @returns {string} a name, or '' when the book does not have it
 */
export function recordName(kind, id, lk) {
  if (!id || !lk) return '';
  const get = (fn) => { const v = typeof fn === 'function' ? fn(id) : ''; return v && v !== 'Unknown' ? v : ''; };
  if (kind === 'consultant') return get(lk.consultantName);
  if (kind === 'vendor') return get(lk.vendorName);
  if (kind === 'contact') return get(lk.contactName);
  if (kind === 'member') return get(lk.memberName);
  if (kind === 'desk') return get(lk.deskName);
  if (kind === 'requirement') { const r = lk.requirements && lk.requirements.get(id); return r ? r.title || r.endClient || '' : ''; }
  if (kind === 'submission') {
    const s = lk.submissions && lk.submissions.get(id);
    if (!s) return '';
    const who = get(() => lk.consultantName(s.consultantId));
    return who ? who + (s.endClient ? ' at ' + s.endClient : '') : '';
  }
  return '';
}

/** "stage: submitted to interview" for the whitelisted fields that moved; otherwise the names of the changed fields. */
export function changeDetail(before, after) {
  const b = before && typeof before === 'object' ? before : {};
  const a = after && typeof after === 'object' ? after : {};
  const parts = [];
  for (const [k, label] of Object.entries(SAFE)) {
    if (!(k in a) || !(k in b)) continue;
    const from = plainValue(b[k]), to = plainValue(a[k]);
    if (from !== to && to) parts.push(label + ': ' + (from ? from + ' to ' + to : to));
  }
  if (parts.length) return parts.join(', ');
  const changed = Array.isArray(a.changed) ? a.changed : [];
  const labels = [...new Set(changed.map((f) => FIELD_LABELS[f]).filter(Boolean))];
  return labels.length ? labels.join(', ') : '';
}

/**
 * One plain-language line: { when, person, text, kind, kindLabel, record }.
 * @param {{at:string, actor:string, action:string, entity:string, entityId:string, before?:object, after?:object}} row  listAudit row
 * @param {object} lk  ctx.lk (memberName, consultantName, vendorName, contactName) + requirements / submissions Maps
 */
export function auditLine(row, lk) {
  const { kind, verb, action } = classify(row);
  const info = AUDIT_KINDS[kind];
  const name = recordName(kind, row.entityId, lk);
  const record = name || (info.noun === 'workspace' ? '' : 'a ' + info.noun);
  const person = row.actor ? (recordName('member', row.actor, lk) || 'A former member') : 'BenchPilot';
  let text;
  if (verb) {
    const detail = verb === 'changed' ? changeDetail(row.before, row.after) : '';
    text = verb + ' ' + (name ? info.noun + ' ' + name : record) + (detail ? ' (' + detail + ')' : '');
  } else if (PHRASES[action]) {
    text = PHRASES[action].replace('{x}', record || 'a member');
    if (action === 'member.set_role' || action === 'role_changed') { const d = changeDetail(row.before, row.after); if (d) text += ' (' + d + ')'; }
  } else {
    text = 'did "' + action.replace(/[._]/g, ' ') + '" on ' + (record || 'the workspace');
  }
  return { when: row.at || '', person, text, kind, kindLabel: info.label, record: name };
}

/** "14 Nov 2026, 10:32" in the browser's time zone (a day-only demo date stays a day). */
export function fmtWhen(at) {
  const s = String(at || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The CSV rows for "Export this list": the lines as shown, never the raw before/after. */
export function auditCsvRows(lines) {
  return lines.map((l) => ({ When: l.when, Person: l.person, What: l.text, Type: l.kindLabel }));
}

/**
 * Local-day range -> ISO timestamps for the query: from 00:00 of `from` up to (not including) 00:00 of the day after `to`.
 * Either side may be ''. A `to` before `from` is swapped.
 */
export function dayRange(from, to) {
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  let f = ok(from) ? from : '', t = ok(to) ? to : '';
  if (f && t && t < f) [f, t] = [t, f];
  const start = (d) => new Date(d + 'T00:00:00').toISOString();
  const next = (d) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + 1); return x.toISOString(); };
  return { fromTs: f ? start(f) : '', toTs: t ? next(t) : '', from: f, to: t };
}

export const AUDIT_PAGE = 50;
export const AUDIT_EXPORT_MAX = 5000;
