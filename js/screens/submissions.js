// Submissions: the log with filters, and "New submission", which runs the team-wide guard before saving.
// A match shows a red block. The user can continue only by typing a reason (8+ characters), and the reason is stored.
// P2 (0046): "RTR and rate" (RTR day, end and agreed rate; bill and pay rate; tax terms; vendor chain) on the form and on each row, the
// margin for people who may see pay, the rate-change warning, and "Request RTR" (an email draft to the consultant). js/rtr-ui.js.
// P3 (0051): "Interviews" on each row opens the interviews (with the .ics calendar file) and the placement; moving a submission to Placed
// asks for the start date and the rates ("Skip for now" is always there). js/p3-ui.js.

import { h, clear } from '../dom.js';
import { pageHeader, card, table, chip, field, input, select, note, empty, emptyState, sampleDataButton, button, toast, STAGE_LABELS, STAGE_KIND } from '../ui.js';
import { loadDraftLib } from '../bp-lib.js';
import { ratesSection, rtrCell, rateCell, openRtrDraft } from '../rtr-ui.js';
import { submissionPanel, placementForm } from '../p3-ui.js';
import { fmtShort } from '../dates.js';
import { describeMatch, REASON_LABELS, reasonOk, MIN_REASON_LENGTH } from '../guard.js';
import { draftButton, followUpDraft } from '../draft.js';
import { filterByDesk } from '../desks.js';
import { deskFilterField } from '../desk-ui.js';
import { deleteButton } from '../delete-ui.js';
import { msaWarningFor } from '../agreements.js';
import { belowRateMin, rateMinText, normalizeRateUnit } from '../consultant-profile.js';

/** The soft warning under Rate (staffing P1): the rate asked is below the consultant's minimum. '' when not. Never blocks the save. */
export function rateMinWarning(rate, consultant) {
  const b = consultant ? belowRateMin(rate, consultant) : null;
  if (!b) return '';
  const first = String(consultant.name || '').split(/\s+/)[0] || 'the consultant';
  const unit = normalizeRateUnit(consultant.rateUnit) === 'hr' ? '' : ` (${rateMinText(consultant)})`;
  return `Below ${first}'s minimum of $${b.min}/hr${unit}. Check with ${first} before you send.`;
}

function newSubmissionForm(ctx, BP, startConsultantId, onDone, onCancel, startRequirementId) {
  const consultants = ctx.lk.consultants.filter((c) => c.status !== 'inactive' && c.status !== 'placed');
  const consultantOpts = { '': 'Pick a consultant' };
  for (const c of consultants) consultantOpts[c.id] = c.name + ' - ' + c.title;
  const reqOpts = { '': 'None (enter the end client below)' };
  for (const r of ctx.lk.requirements || []) reqOpts[r.id] = r.title + (r.endClient ? ' - ' + r.endClient : '');
  const vendorOpts = { '': 'Pick a company' };
  for (const v of ctx.lk.vendors) vendorOpts[v.id] = v.name;

  const el = {
    consultant: select(consultantOpts, startConsultantId || ''),
    requirement: select(reqOpts, ''),
    vendor: select(vendorOpts, ''),
    contact: select({ '': 'Pick a contact' }, ''),
    endClient: input({ autocomplete: 'off' }),
    jobRef: input({ autocomplete: 'off' }),
    stage: select(STAGE_LABELS, 'submitted')
  };
  const termsOf = (id) => { const c = ctx.lk.consultants.find((x) => x.id === id); return c && ['C2C', 'W2', '1099'].includes(c.taxTerms) ? c.taxTerms : ''; };
  const rates = ratesSection(BP, { taxTerms: termsOf(startConsultantId) }, { today: ctx.session.today, canPay: ctx.can('see_pay') });
  const ratesBox = h('div', null, rates.el);
  const guardBox = h('div', { 'aria-live': 'polite', class: 'guard-box' });
  const rateBox = h('div', { 'aria-live': 'polite' });
  const paintRate = () => {
    clear(rateBox);
    const text = rateMinWarning(rates.read().billRate, consultants.find((c) => c.id === el.consultant.value));   // P1 minimum, on the P2 bill rate
    if (text) rateBox.append(note('warn', text));
  };
  rates.el.addEventListener('input', paintRate);
  el.consultant.addEventListener('change', paintRate);
  const msg = h('div', { 'aria-live': 'polite' });
  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save submission');
  let matches = [];
  let reasonEl = null;

  function fillContacts() {
    const keep = el.contact.value;
    clear(el.contact);
    el.contact.append(h('option', { value: '' }, 'Pick a contact'));
    for (const c of ctx.lk.contacts.filter((x) => x.companyId === el.vendor.value)) el.contact.append(h('option', { value: c.id, selected: c.id === keep }, c.name));
  }

  function syncSubmit() {
    if (matches.length) {
      submitBtn.textContent = 'Submit anyway and log my reason';
      submitBtn.disabled = !reasonOk(reasonEl && reasonEl.value);
    } else { submitBtn.textContent = 'Save submission'; submitBtn.disabled = false; }
  }

  async function runGuard() {
    clear(msg);
    const q = { consultantId: el.consultant.value, endClient: el.endClient.value, requirementId: el.requirement.value, jobRef: el.jobRef.value };
    const keepReason = reasonEl ? reasonEl.value : '';
    matches = q.consultantId ? await ctx.store.checkGuard(q) : [];
    const msaLine = await msaWarningFor(ctx, ctx.lk.vendors.find((v) => v.id === el.vendor.value));   // vendor agreements (P6): soft, never blocks
    clear(guardBox);
    reasonEl = null;
    const vendor = ctx.lk.vendors.find((v) => v.id === el.vendor.value);
    if (vendor && vendor.tier === 'avoid') guardBox.append(note('warn', `${vendor.name} is marked Avoid: ${vendor.avoidReason || 'no reason recorded'}`));
    if (msaLine) guardBox.append(note('warn', msaLine));
    if (!q.consultantId) { syncSubmit(); return; }
    if (!matches.length) {
      guardBox.append(note('ok', 'No earlier submission found for this consultant in the last 90 days.'));
      syncSubmit();
      return;
    }
    reasonEl = h('textarea', { rows: 2, id: 'guard-reason', 'aria-describedby': 'guard-reason-hint', oninput: syncSubmit }, keepReason);
    guardBox.append(h('div', { class: 'guard-block', role: 'alert' },
      h('h3', null, 'Already submitted'),
      h('ul', null, matches.map((m) => h('li', null,
        describeMatch(m, {
          consultant: ctx.lk.consultantName(m.submission.consultantId), recruiter: ctx.lk.memberName(m.submission.recruiterId), vendor: ctx.lk.vendorName(m.submission.vendorCompanyId)
        }), ' ', h('span', { class: 'why' }, m.reasons.map((r) => REASON_LABELS[r]).join(', ') + '. ' + m.daysAgo + (m.daysAgo === 1 ? ' day ago.' : ' days ago.'))))),
      h('p', null, 'Submitting again through another company can get both rejected. To continue, say why this is different.'),
      h('div', { class: 'field wide' },
        h('label', { for: 'guard-reason' }, 'Reason to continue'),
        reasonEl,
        h('span', { class: 'hint', id: 'guard-reason-hint' }, `At least ${MIN_REASON_LENGTH} characters. It is saved with the submission.`))));
    syncSubmit();
  }

  el.requirement.addEventListener('change', async () => {
    const r = (ctx.lk.requirements || []).find((x) => x.id === el.requirement.value);
    if (r) {
      el.endClient.value = r.endClient; el.jobRef.value = r.jobRef || '';
      if (r.vendorCompanyId) { el.vendor.value = r.vendorCompanyId; fillContacts(); el.contact.value = r.vendorContactId || ''; }
    }
    runGuard();
  });
  el.vendor.addEventListener('change', () => { fillContacts(); runGuard(); });
  el.consultant.addEventListener('change', () => {
    runGuard();
    const t = termsOf(el.consultant.value);
    const sel = rates.el.querySelector('select');
    if (sel && t) { sel.value = t; rates.paint(); }
  });
  el.endClient.addEventListener('input', runGuard);
  el.jobRef.addEventListener('input', runGuard);

  const form = h('form', { class: 'card form', novalidate: true },
    h('h2', null, 'New submission'),
    h('div', { class: 'grid' },
      field('Consultant', el.consultant), field('Requirement', el.requirement),
      field('End client', el.endClient), field('Job reference', el.jobRef),
      field('Through (vendor company)', el.vendor), field('Vendor contact', el.contact),
      field('Stage', el.stage)),
    ratesBox, rateBox,
    guardBox, msg,
    h('div', { class: 'row-end' }, button('Cancel', { variant: 'ghost', onclick: onCancel }), submitBtn));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    if (matches.length && !reasonOk(reasonEl && reasonEl.value)) { msg.append(note('danger', 'Type a reason to continue.')); if (reasonEl) reasonEl.focus(); return; }
    const bad = rates.problem();
    if (bad) { msg.append(note('danger', bad)); return; }
    const p2 = rates.read();
    try {
      await ctx.store.saveSubmission({
        consultantId: el.consultant.value, requirementId: el.requirement.value || null, vendorCompanyId: el.vendor.value, vendorContactId: el.contact.value,
        endClient: el.endClient.value, jobRef: el.jobRef.value, rate: BP.Submissions.rateText(p2.billRate, 'hr'), ...p2, stage: el.stage.value
      }, { overrideReason: reasonEl ? reasonEl.value : '' });
      toast(matches.length ? 'Saved with your reason.' : 'Submission saved.');
      onDone();
    } catch (err) {
      msg.append(note('danger', err.message));
      if (err.code === 'guard_block') await runGuard();
    }
  });
  if (startRequirementId && (ctx.lk.requirements || []).some((x) => x.id === startRequirementId)) {
    el.requirement.value = startRequirementId;           // from Matches: fill the requirement's end client, ref and vendor, then run the guard
    el.requirement.dispatchEvent(new Event('change'));
  } else runGuard();
  return form;
}

/** "RTR and rate" on a saved submission (the RTR usually arrives after it is logged). */
function ratesEditForm(ctx, BP, s, onDone, onCancel, onRequest) {
  const rates = ratesSection(BP, s, { today: ctx.session.today, canPay: ctx.can('see_pay'), consultantName: ctx.lk.consultantName(s.consultantId) });
  const msg = h('div', { 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save RTR and rate');
  const form = h('form', { class: 'card form', novalidate: true },
    h('h2', null, 'RTR and rate: ' + ctx.lk.consultantName(s.consultantId) + (s.endClient ? ', ' + s.endClient : '')),
    rates.el, msg, h('div', { class: 'row-end' }, button('Cancel', { variant: 'ghost', onclick: onCancel }),
      button('Request RTR', { variant: 'secondary', 'aria-label': 'Request RTR from ' + ctx.lk.consultantName(s.consultantId), onclick: () => onRequest(s) }), save));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(msg);
    const bad = rates.problem();
    if (bad) { msg.append(note('danger', bad)); return; }
    const p2 = rates.read();
    save.disabled = true;
    try {
      await ctx.store.saveSubmission({ id: s.id, ...p2, rate: BP.Submissions.rateText(p2.billRate, 'hr') || undefined });
      toast('RTR and rate saved.'); onDone();
    } catch (err) { msg.append(note('danger', err.message)); save.disabled = false; }
  });
  return form;
}

export async function render(ctx) {
  ctx.lk.requirements = await ctx.store.listRequirements();
  const BP = await loadDraftLib();
  const f = { recruiterId: '', consultantId: '', stage: '', sinceDays: 0, deskId: '' };
  const listBox = h('div', { 'aria-live': 'polite' });
  const formBox = h('div');

  // "Request RTR" (from the RTR and rate form): the email draft to the consultant; a submission with no RTR is marked "asked".
  async function requestRtr(s) {
    await openRtrDraft(ctx, formBox, s, async () => {
      if (s.rtrStatus === 'none' && !s.rtrOn && ctx.can('edit_records')) { try { await ctx.store.saveSubmission({ id: s.id, rtrStatus: 'requested' }); drawList(); } catch (e) { /* the draft still opened */ } }
    });
    formBox.scrollIntoView({ block: 'nearest' });
  }

  // P3: the interviews and placement of one submission, under the header (like the RTR and rate form).
  async function openPanel(s) {
    clear(formBox);
    formBox.append(await submissionPanel(ctx, BP, s, () => drawList(), () => clear(formBox)));
    formBox.scrollIntoView({ block: 'nearest' });
  }
  // Moved to Placed with no placement yet: ask for the start date and the rates. "Skip for now" keeps the stage and closes the form.
  async function askPlacement(s) {
    if (!ctx.can('edit_records')) return;
    let has = false;
    try { has = (await ctx.store.listPlacements()).some((p) => p.submissionId === s.id); } catch (e) { has = false; }
    if (has) return;
    clear(formBox);
    formBox.append(placementForm(ctx, BP, s, null, { intro: 'Add the start date and the rates to count the margin. You can do it later from Interviews.',
      cancelText: 'Skip for now', onCancel: () => clear(formBox), onDone: () => { clear(formBox); drawList(); } }));
    formBox.scrollIntoView({ block: 'nearest' });
  }

  let anyAtAll = true;   // false when the workspace has no submission at all (then the empty state, not "no match")
  async function drawList() {
    const rows = filterByDesk('submission', await ctx.store.listSubmissions({ ...f, sinceDays: Number(f.sinceDays) || 0 }), f.deskId, ctx.lk.deskIdx);
    clear(listBox);
    listBox.append(rows.length ? table([
      { label: 'Date', class: 'nowrap', cell: (s) => fmtShort(s.submittedOn) },
      // The guard override ("Continued" and the typed reason) sits under the name: one column fewer, so RTR and Rate fit (P2).
      { label: 'Consultant', cell: (s) => h('div', null, h('a', { href: '#consultant-' + s.consultantId, class: 'strong' }, ctx.lk.consultantName(s.consultantId)),
        s.overrideReason ? h('div', { class: 'override-note' }, chip('Continued', 'warn'), ' ', h('span', { class: 'muted' }, s.overrideReason)) : null) },
      { label: 'End client', cell: (s) => h('div', null, s.endClient || '-', s.jobRef ? [h('br'), h('span', { class: 'muted' }, 'Ref ' + s.jobRef)] : null) },
      { label: 'Through', cell: (s) => ctx.lk.vendorName(s.vendorCompanyId) || '-' },
      { label: 'By', class: 'nowrap', cell: (s) => ctx.lk.memberName(s.recruiterId) },
      {
        label: 'Stage', cell: (s) => {
          const sel = select(STAGE_LABELS, s.stage, {
            'aria-label': `Stage for ${ctx.lk.consultantName(s.consultantId)}, ${s.endClient || 'no end client'}`, class: 'stage-select', disabled: !ctx.can('edit_records'),
            onchange: async (e) => {
              const stage = e.target.value;
              await ctx.store.saveSubmission({ id: s.id, stage }); toast('Stage updated.'); drawList();
              if (stage === 'placed') askPlacement({ ...s, stage });
            }
          });
          return sel;
        }
      },
      { label: 'RTR and rate', cell: (s) => h('div', { class: 'rtr-rate' }, rateCell(BP, s), rtrCell(BP, s, ctx.session.today)) },
      { label: '', class: 'right', cell: (s) => h('div', { class: 'row-end' },
        button('Interviews', { variant: 'ghost', 'aria-label': 'Interviews and placement for ' + ctx.lk.consultantName(s.consultantId), onclick: () => openPanel(s) }),
        button('RTR and rate', { variant: 'ghost', disabled: !ctx.can('edit_records'), 'aria-label': 'RTR and rate for ' + ctx.lk.consultantName(s.consultantId),
          onclick: () => { clear(formBox); formBox.append(ratesEditForm(ctx, BP, s, () => ctx.refresh(), () => clear(formBox), requestRtr)); formBox.scrollIntoView({ block: 'nearest' }); } }),
        draftButton(ctx, formBox, followUpDraft(ctx, s), 'Draft follow-up', 'Draft a follow-up for ' + ctx.lk.consultantName(s.consultantId)),
        deleteButton(ctx, { kind: 'submission', name: ctx.lk.consultantName(s.consultantId) + ', ' + (s.endClient || 'no end client') + ', ' + fmtShort(s.submittedOn),
          run: () => ctx.store.deleteSubmission(s.id), done: () => drawList() })) }
    ], rows, { caption: 'Submission log, newest first' }) : (anyAtAll
      ? empty('No submissions match these filters.')
      : emptyState({
        icon: 'submissions', title: 'No submissions logged yet',
        text: 'Log each consultant you send to a vendor. BenchPilot checks first that no one on the team has sent the same person for the same client.',
        action: ctx.can('edit_records') ? button('New submission', { variant: 'primary', onclick: () => openForm('') }) : null,
        secondary: sampleDataButton(ctx)
      })));
  }

  function openForm(consultantId, requirementId) {
    clear(formBox);
    formBox.append(newSubmissionForm(ctx, BP, consultantId, () => ctx.refresh(), () => { clear(formBox); if (location.hash.includes('new=')) history.replaceState(null, '', '#submissions'); }, requirementId));
    formBox.querySelector('select').focus();
  }

  const members = { '': 'All recruiters' };
  for (const m of ctx.lk.members.filter((x) => !x.removedAt)) members[m.id] = m.name;
  const cons = { '': 'All consultants' };
  for (const c of ctx.lk.consultants) cons[c.id] = c.name;
  const filters = h('div', { class: 'filters' },
    field('Recruiter', select(members, '', { onchange: (e) => { f.recruiterId = e.target.value; drawList(); } })),
    deskFilterField(ctx, (v) => { f.deskId = v; drawList(); }),
    field('Consultant', select(cons, '', { onchange: (e) => { f.consultantId = e.target.value; drawList(); } })),
    field('Stage', select({ '': 'All stages', ...STAGE_LABELS }, '', { onchange: (e) => { f.stage = e.target.value; drawList(); } })),
    field('Date', select({ 0: 'Any time', 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days' }, '0', { onchange: (e) => { f.sinceDays = e.target.value; drawList(); } })));

  anyAtAll = (await ctx.store.listSubmissions({})).length > 0;
  await drawList();
  if (ctx.route.params.new) openForm(ctx.route.params.new === '1' ? '' : ctx.route.params.new, ctx.route.params.req || '');
  return h('div', { class: 'stack' },
    pageHeader('Submissions', 'Every submission from the whole team, newest first', button('New submission', { variant: 'primary', disabled: !ctx.can('edit_records'), onclick: () => openForm('') })),
    formBox, filters, listBox);
}
