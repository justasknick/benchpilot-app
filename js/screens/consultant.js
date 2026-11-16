// Consultant page: profile, edit, resume versions (upload, open, delete; migration 0024) and this consultant's submissions.
// Also exports the add/edit form used by Bench.

import { h, clear, append } from '../dom.js';
import { pageHeader, card, table, chip, field, input, select, note, empty, button, toast, STATUS_LABELS, STATUS_KIND, STAGE_LABELS, STAGE_KIND, TAX_TERMS, plural } from '../ui.js';
import { benchDays, BENCH_STATUSES } from '../stats.js';
import { fmtShort, fmtLong } from '../dates.js';
import { checkResume, fmtSize, RESUME_ACCEPT, RESUME_KEEP, DOCX_TYPE } from '../resume.js';
import { deskPicker } from '../desk-ui.js';
import { capNote } from './bench-cap.js';
import { deleteButton } from '../delete-ui.js';
import { CONSULTANT_HAS_SUBMISSIONS } from '../record-delete.js';
import { VISA_TYPES, consultantVisaType, workAuthAlert, RATE_UNITS, RATE_UNIT_LABELS, normalizeRateUnit, cleanRateMin, rateMinText } from '../consultant-profile.js';
import { consentCard, contactLogCard } from '../consent-ui.js';
import { ERASED_NAME } from '../consent.js';
import { loadResumeLib, loadHotlistLib } from '../bp-lib.js';
import { profilePanel } from '../profile-summary.js';
import { consultantLinkCard } from '../link-ui.js';

export function consultantForm(ctx, c, handlers) {
  const v = c || { name: '', title: '', skills: [], visa: '', visaType: '', workAuthUntil: '', taxTerms: 'C2C', rate: '', rateMin: null, rateUnit: 'hr', location: '', relocation: false, availableOn: '', status: 'marketing', ownerRecruiterId: ctx.session.user.id, notes: '' };
  const type = consultantVisaType(v);
  const recruiters = Object.fromEntries(ctx.lk.members.filter((m) => !m.removedAt || m.id === v.ownerRecruiterId).map((m) => [m.id, m.name]));
  const canReassign = ctx.can('reassign');
  const f = {
    name: input({ value: v.name, required: true, autocomplete: 'off' }),
    title: input({ value: v.title }),
    skills: input({ value: v.skills.join(', ') }),
    visaType: select({ '': 'Not recorded', ...Object.fromEntries(VISA_TYPES.map((t) => [t, t])) }, type),
    workAuthUntil: input({ type: 'date', value: v.workAuthUntil || '' }),
    visa: input({ value: v.visa && v.visa !== type ? v.visa : '', placeholder: 'e.g. H1B transfer ready', maxlength: '60' }),
    rateMin: input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: cleanRateMin(v.rateMin) === null ? '' : String(cleanRateMin(v.rateMin)), placeholder: 'e.g. 60' }),
    rateUnit: select(Object.fromEntries(RATE_UNITS.map((u) => [u, RATE_UNIT_LABELS[u]])), normalizeRateUnit(v.rateUnit)),
    taxTerms: select(Object.fromEntries(TAX_TERMS.map((t) => [t, t])), v.taxTerms),
    rate: input({ value: v.rate, placeholder: '$65/hr' }),
    location: input({ value: v.location }),
    relocation: h('input', { type: 'checkbox', checked: v.relocation }),
    availableOn: input({ type: 'date', value: v.availableOn }),
    status: select(STATUS_LABELS, v.status),
    owner: select(recruiters, v.ownerRecruiterId, { disabled: !canReassign && Boolean(c) }),
    notes: h('textarea', { rows: 3 }, v.notes),
    desk: deskPicker(ctx, v.deskId)             // Agency desks (0036): owners and managers, once a desk exists; else null
  };
  const msg = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'card form', novalidate: true },
    h('h2', null, c ? 'Edit consultant' : 'Add consultant'),
    h('div', { class: 'grid' },
      field('Name', f.name), field('Role', f.title),
      field('Skills', f.skills, { hint: 'Separate with commas', wide: true }),
      field('Work authorisation', f.visaType, { hint: 'Matching hides requirements that do not take this type.' }),
      field('Authorised until', f.workAuthUntil, { hint: 'Only the end date. Today reminds the team 120, 90, 60, 30 and 7 days before. Never store document copies or numbers.' }),
      field('Visa note', f.visa), field('Tax terms', f.taxTerms),
      field('Rate', f.rate),
      field('Minimum rate', f.rateMin, { hint: 'New submissions warn when the rate asked is lower.' }), field('Minimum rate per', f.rateUnit),
      field('Location', f.location),
      field('Available from', f.availableOn), field('Status', f.status),
      field('Recruiter', f.owner, { hint: !canReassign && c ? 'Only owners and managers can reassign a consultant.' : null }),
      f.desk ? field('Desk', f.desk, { hint: "Left on the recruiter's desk, the consultant moves with them." }) : null,
      h('div', { class: 'field check' }, f.relocation, h('label', { for: (f.relocation.id = 'reloc-' + (v.id || 'new')) }, 'Open to relocation')),
      ctx.store.capabilities.consultantNotes ? field('Notes', f.notes, { wide: true }) : null),
    msg,
    h('div', { class: 'row-end' },
      handlers.onCancel ? button('Cancel', { variant: 'ghost', onclick: handlers.onCancel }) : null,
      h('button', { type: 'submit', class: 'btn btn-primary' }, c ? 'Save changes' : 'Add consultant')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    try {
      const saved = await ctx.store.saveConsultant({
        ...(c ? { id: c.id, benchSince: c.benchSince, resumeName: c.resumeName } : {}),
        name: f.name.value, title: f.title.value, skills: f.skills.value, taxTerms: f.taxTerms.value,
        visaType: f.visaType.value, workAuthUntil: f.workAuthUntil.value, visa: f.visa.value || f.visaType.value,   // a blank note keeps the type readable as text
        rateMin: f.rateMin.value, rateUnit: f.rateUnit.value,
        rate: f.rate.value, location: f.location.value, relocation: f.relocation.checked, availableOn: f.availableOn.value,
        status: f.status.value, ownerRecruiterId: f.owner.value, notes: f.notes.value, ...(f.desk ? { deskId: f.desk.value } : {})
      });
      toast(c ? 'Saved.' : 'Consultant added.');
      handlers.onSaved(saved);
    } catch (err) {
      msg.append(err && err.code === 'plan_limit' ? capNote(ctx, 'danger') : note('danger', err.message));   // 0038 Starter cap
      f.name.focus();
    }
  });
  return form;
}

/** A chip next to the end date once a reminder is due (120 days or closer). */
export function authChip(c, today) {
  const a = workAuthAlert(c.workAuthUntil, today);
  return a ? [' ', chip(a.label, a.days <= 30 ? 'danger' : 'warn')] : [];
}

export async function render(ctx) {
  const c = await ctx.store.getConsultant(ctx.route.id);
  if (!c) return h('div', { class: 'stack' }, pageHeader('Consultant not found'), empty('This consultant is not in your workspace.'), h('a', { href: '#bench' }, 'Back to the bench'));
  const subs = await ctx.store.listSubmissions({ consultantId: c.id });
  const subsCard = () => card('Submissions', subs.length ? table([
    { label: 'Date', class: 'nowrap', cell: (s) => fmtShort(s.submittedOn) },
    { label: 'End client', cell: (s) => s.endClient || '-' },
    { label: 'Through', cell: (s) => ctx.lk.vendorName(s.vendorCompanyId) || '-' },
    { label: 'By', class: 'nowrap', cell: (s) => ctx.lk.memberName(s.recruiterId) },
    { label: 'Stage', cell: (s) => chip(STAGE_LABELS[s.stage], STAGE_KIND[s.stage]) }
  ], subs, { caption: 'Submissions for ' + c.name }) : empty('Not submitted anywhere yet.'));
  // Staffing P5: an erased consultant is kept only so the submissions still count. Nothing personal is left to show or change.
  if (c.erased) {
    return h('div', { class: 'stack' },
      pageHeader(ERASED_NAME, 'Kept only for the counts', [h('a', { class: 'btn btn-ghost', href: '#bench' }, 'Back to bench')]),
      note('info', 'This consultant asked for their data to be erased. Their name, profile, resume files and notes are gone; their submissions stay so the reports still add up.'),
      subsCard());
  }
  const box = h('div', { class: 'stack' });
  // The masked profile summary opens here, under the header (js/profile-summary.js).
  const panelHost = h('div');
  async function openProfile() {
    try {
      const H = await loadHotlistLib();
      clear(panelHost).append(profilePanel(ctx, c, H, { onClose: () => clear(panelHost) }));
      if (panelHost.scrollIntoView) panelHost.scrollIntoView({ block: 'nearest' });
    } catch (e) { clear(panelHost).append(note('danger', 'The profile summary could not load. Reload the page to try again.')); }
  }

  function draw(editing) {
    clear(box);
    clear(panelHost);
    const onBench = BENCH_STATUSES.includes(c.status);
    box.append(
      pageHeader(c.name, c.title, [
        h('a', { class: 'btn btn-ghost', href: '#bench' }, 'Back to bench'),
        button('Profile summary', { variant: 'ghost', title: 'A masked one-page profile with no contact details, to print or save as PDF', onclick: openProfile }),
        button('Edit', { variant: 'secondary', disabled: !ctx.can('edit_records'), onclick: () => draw(true) }),
        ctx.can('edit_records') ? h('a', { class: 'btn btn-primary', href: '#submissions?new=' + c.id }, 'New submission') : null,
        deleteButton(ctx, { kind: 'consultant', name: c.name, blocked: subs.length ? CONSULTANT_HAS_SUBMISSIONS : '', run: () => ctx.store.deleteConsultant(c.id), done: () => ctx.go('#bench') })
      ]));
    if (editing) { box.append(consultantForm(ctx, c, { onSaved: () => ctx.refresh(), onCancel: () => draw(false) })); return; }
    append(box,
      panelHost,
      h('div', { class: 'cols' },
        card('Profile', h('dl', { class: 'facts' },
          ...[
            ['Status', chip(STATUS_LABELS[c.status] || c.status, STATUS_KIND[c.status])],
            ['Bench days', onBench ? plural(benchDays(c, ctx.session.today), 'day') + ' (since ' + fmtLong(c.benchSince) + ')' : 'Not on the bench'],
            ['Recruiter', ctx.lk.memberName(c.ownerRecruiterId)],
            ['Work authorisation', consultantVisaType(c) || '-'],
            ['Authorised until', c.workAuthUntil ? h('span', null, fmtLong(c.workAuthUntil), ...authChip(c, ctx.session.today)) : '-'],
            ...(c.visa && c.visa !== consultantVisaType(c) ? [['Visa note', c.visa]] : []),
            ['Tax terms', c.taxTerms || '-'], ['Rate', c.rate || '-'], ['Minimum rate', rateMinText(c) || '-'],
            ['Location', c.location + (c.relocation ? ' (open to relocation)' : '')],
            ...(c.locationPref ? [['Location preference', h('span', null, c.locationPref, ' ', chip('From the consultant', 'neutral'))]] : []),
            ['Available from', c.availableOn ? fmtLong(c.availableOn) : '-']
          ].flatMap(([k, val]) => [h('dt', null, k), h('dd', null, val)]))),
        card('Skills and notes', h('div', null,
          h('p', { class: 'chips' }, c.skills.length ? c.skills.map((s) => chip(s, 'neutral')) : '-'),
          ctx.store.capabilities.consultantNotes ? (c.notes ? h('p', null, c.notes) : h('p', { class: 'muted' }, 'No notes.')) : null))),
      ctx.store.capabilities.resumes ? resumeCard(ctx, c) : null,
      // Staffing P5: consent, the data notice, export and erase; and the typed contact log.
      h('div', { class: 'cols' },
        consentCard(ctx, c, { submissions: subs.length, onErased: () => ctx.go('#bench') }),
        contactLogCard(ctx, { entity: 'consultant', entityId: c.id, name: c.name })),
      // 0056: the consultant self-service link (owners and managers)
      consultantLinkCard(ctx, c, subs),
      subsCard());
  }
  draw(false);
  return box;
}

/**
 * The Resume card: the last RESUME_KEEP versions (newest = current), Upload for anyone who can edit, Open (a link that works for a minute),
 * Delete for owners and managers. Files sit in the team's private storage; the check is the extension's own (PDF or .docx, up to 5 MB).
 */
export function resumeCard(ctx, c, deps) {
  const d = deps || {};
  const loadLib = d.loadLib || loadResumeLib;
  const openUrl = d.openUrl || ((url) => window.open(url, '_blank', 'noopener'));
  const ask = d.confirm || ((text) => confirm(text));
  const body = h('div', { class: 'stack-tight resume-body' });
  const msg = h('div', { 'aria-live': 'polite' });
  const canUpload = ctx.can('edit_records');
  const canDelete = ctx.can('delete_resume');
  const inputId = 'resume-file-' + c.id;
  const fileIn = h('input', { type: 'file', id: inputId, accept: RESUME_ACCEPT, class: 'sr-only' });
  const pick = h('label', { for: inputId, class: 'btn btn-secondary' }, 'Upload resume');
  let busy = false;

  async function upload(file) {
    if (busy) return;
    busy = true;
    clear(msg);
    msg.append(note('info', 'Uploading ' + file.name + ' ...'));
    try {
      const lib = await loadLib();
      const check = await checkResume(file, lib);
      if (check.problem) throw new Error(check.problem);
      const r = await ctx.store.uploadResume(c.id, file, check);
      clear(msg);
      toast(r.pruned ? 'Resume uploaded. The oldest version was removed (the last ' + RESUME_KEEP + ' are kept).' : 'Resume uploaded.');
      await draw();
    } catch (err) {
      clear(msg);
      msg.append(note('danger', err.message || 'The upload did not go through. Please try again.'));
    } finally { busy = false; }
  }
  fileIn.addEventListener('change', () => { const f = fileIn.files && fileIn.files[0]; fileIn.value = ''; if (f) upload(f); });

  async function open(v, btn) {
    clear(msg);
    btn.disabled = true;
    try { openUrl(await ctx.store.resumeLink(v)); } catch (err) { msg.append(note('danger', err.message)); } finally { btn.disabled = false; }
  }
  async function remove(v, btn) {
    if (!ask('Delete ' + (v.fileName || 'this version') + '? The file is removed for the whole team.')) return;
    clear(msg);
    btn.disabled = true;
    try { await ctx.store.deleteResume(v.id); toast('Resume version deleted.'); await draw(); } catch (err) { btn.disabled = false; msg.append(note('danger', err.message)); }
  }

  async function draw() {
    let versions = [];
    let failed = '';
    try { versions = await ctx.store.listResumes(c.id); } catch (err) { failed = err.message || 'The resume list could not load.'; }
    clear(body);
    body.append(
      failed ? note('danger', failed) : versions.length ? table([
        { label: 'File', cell: (v) => h('span', null, v.fileName || 'resume', ' ', v === versions[0] ? chip('Current', 'ok') : null) },
        { label: 'Type', cell: (v) => (v.mime === DOCX_TYPE ? 'Word' : 'PDF') },
        { label: 'Size', cell: (v) => fmtSize(v.size) },
        { label: 'Added', cell: (v) => (v.uploadedAt ? fmtShort(String(v.uploadedAt).slice(0, 10)) : '-') + (v.uploadedBy ? ' by ' + ctx.lk.memberName(v.uploadedBy) : '') },
        { label: 'Actions', cell: (v) => h('span', { class: 'row-end' },
          button(v.mime === DOCX_TYPE ? 'Download' : 'Open', { variant: 'ghost', onclick: (e) => open(v, e.currentTarget) }),
          canDelete ? button('Delete', { variant: 'ghost', onclick: (e) => remove(v, e.currentTarget) }) : null) }
      ], versions, { caption: 'Resume versions for ' + c.name }) : empty('No resume yet.'),
      h('p', { class: 'muted' }, 'PDF or Word (.docx), up to 5 MB. The last ' + RESUME_KEEP + ' versions are kept, in your team\'s private storage. ' +
        'Links to open a file work for one minute.'),
      msg,
      canUpload ? h('div', { class: 'row-end' }, fileIn, pick) : h('p', { class: 'muted' }, 'Your workspace is read-only, so files cannot be added.'));
  }
  draw();
  return card('Resume', body);
}
