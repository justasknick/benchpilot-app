// Requirements: newest first, with source (extension / pasted / import / team inbox / the job board, 0037) and recruiter, and full tags (skills, visa, tax terms, work mode, rate,
// duration: migration 0026, webapp/js/req-tags.js) with filters. The same role posted by several vendors is one row, "Same role from N vendors"
// (the extension's v1.18 grouping, BP.SameRole, worked out in the browser). "Paste a requirement" fills the fields using the extension's own
// parser (bp-lib.js); "Add a requirement" and "Edit" use the same form. The form saves in demo and live mode.

import { h, clear } from '../dom.js';
import { pageHeader, table, chip, field, input, select, note, empty, emptyState, sampleDataButton, button, toast, plural, SOURCE_LABELS, BOARD_LABELS, WORK_MODES } from '../ui.js';
import { fmtShort } from '../dates.js';
import { loadBP, parsePastedRequirement } from '../bp-lib.js';
import { sameRoleGroups, collapseSameRole } from '../team-p2.js';
import { draftButton } from '../draft.js';
import { REQ_VISA_CODES, TERMS_TAGS, cleanTags, tagsFromFreeText, tagsFromParsed, filterByTags, tagLabels } from '../req-tags.js';
import { filterByDesk } from '../desks.js';
import { deskFilterField } from '../desk-ui.js';
import { deleteButton } from '../delete-ui.js';

const SAMPLE_POST = `Hiring: Senior Java Developer
End Client: BrightField Bank, Inc.
Location: Charlotte, NC (Hybrid)
Rate: $70-75/hr C2C
Duration: 12 months
Job ID: BF-2291
Visa: H1B, GC, USC. No OPT.
Skills: Java, Spring Boot, Kafka
Contact: Dana L. dana.l@example.com 555-0101`;

const UNIT_LABELS = { hr: 'Per hour', day: 'Per day', week: 'Per week', month: 'Per month', year: 'Per year' };
const EMPTY_VALUES ={ title: '', endClient: '', jobRef: '', rateText: '', workMode: '', location: '', visaText: '', taxTerms: '', duration: '', skills: [] };

/**
 * The Source filter's choices. "Extension" only when a requirement came from the extension: team mode in the extension is off for now
 * (the extension's FEATURES.team flag), so the option would always show an empty list. A chosen value always stays listed.
 */
export function sourceOptions(rows, current) {
  const hasExt = (rows || []).some((r) => r && r.source === 'extension') || current === 'extension';
  return { '': 'All', ...(hasExt ? { extension: SOURCE_LABELS.extension } : {}), paste: SOURCE_LABELS.paste, import: SOURCE_LABELS.import,
    inbox: SOURCE_LABELS.inbox, board: SOURCE_LABELS.board };
}

/** The Source cell: the job board by name for a job from a board alert (0037), else the source. Exported for the test. */
export function sourceChip(r) {
  if (r.source === 'board') return chip(BOARD_LABELS[r.sourceBoard] || SOURCE_LABELS.board, 'accent');
  return chip(SOURCE_LABELS[r.source] || r.source, 'neutral');
}

/** Tags: up to 4 skills, then visa, tax terms, work mode, rate and duration. */
function tags(r) {
  const skills = (r.skills || []).slice(0, 4).map((t) => chip(t, 'neutral'));
  const more = (r.skills || []).length > 4 ? chip('+' + ((r.skills || []).length - 4), 'neutral') : null;
  const rest = tagLabels(r).map((t) => chip(t.text, t.kind));
  return skills.length || rest.length ? h('div', { class: 'chips tag-row' }, skills, more, rest) : null;
}

/** "Same role from N vendors" and, when the rows are grouped, the other vendors' copies. */
function sameRoleLine(ctx, r, group, grouped) {
  if (!group || group.requirements.length < 2) return null;
  const label = group.vendorCount > 1 ? `Same role from ${group.vendorCount} vendors` : `Same role posted ${group.requirements.length} times`;
  if (!grouped) return h('div', { class: 'tag-row' }, chip(label, 'accent'));
  const others = group.requirements.filter((x) => x.id !== r.id);
  return h('details', { class: 'same-role' },
    h('summary', null, chip(label, 'accent')),
    h('ul', { class: 'same-role-list' }, others.map((x) => h('li', null,
      [ctx.lk.vendorName(x.vendorCompanyId) || 'Vendor not named', x.rateText, x.postedOn ? 'posted ' + fmtShort(x.postedOn) : '', x.status === 'closed' ? 'closed' : '']
        .filter(Boolean).join(' · ')))));
}

function checks(name, codes, selected) {
  const boxes = codes.map((c) => h('input', { type: 'checkbox', value: c, checked: selected.includes(c), id: name + '-' + c.replace(/\W+/g, '') }));
  const set = h('fieldset', { class: 'fieldset' }, h('legend', null, name),
    h('div', { class: 'check-row' }, boxes.map((b) => h('div', { class: 'field check' }, b, h('label', { for: b.id }, b.value)))));
  return { el: set, value: () => boxes.filter((b) => b.checked).map((b) => b.value) };
}

export async function render(ctx) {
  const f = { q: '', status: '', source: '', board: '', visa: '', uscGcOnly: false, terms: '', workMode: '', minRate: '', minMonths: '', deskId: '' };
  const view = { grouped: true };
  const listBox = h('div', { 'aria-live': 'polite' });
  const formBox = h('div');
  const BP = await loadBP();
  const SR = BP && BP.SameRole ? BP.SameRole : null;
  const canEdit = ctx.can('edit_records');

  let firstRows = null;   // the first, unfiltered list: decides whether the Source filter offers "Extension"
  async function drawList() {
    const rows = filterByDesk('requirement', filterByTags(await ctx.store.listRequirements(f), f), f.deskId, ctx.lk.deskIdx);
    if (firstRows === null) firstRows = rows;
    const groups = sameRoleGroups(SR, rows);
    const shown = view.grouped ? collapseSameRole(rows, groups) : rows.map((row) => ({ row, group: groups.get(row.id) }));
    clear(listBox);
    if (!rows.length) {
      listBox.append(firstRows.length ? empty('No requirements match.') : emptyState({
        icon: 'requirements', title: 'No requirements yet',
        text: 'Requirements the team captures with the extension, forwards to the team inbox or pastes here show up in this list.',
        action: canEdit ? button('Paste a requirement', { variant: 'primary', onclick: openPaste }) : null,
        secondary: sampleDataButton(ctx)
      }));
      return;
    }
    const roles = collapseSameRole(rows, groups).length;
    listBox.append(
      h('p', { class: 'muted' }, roles < rows.length ? `${plural(rows.length, 'requirement')}, ${plural(roles, 'role')}` : plural(rows.length, 'requirement')),
      table([
        { label: 'Requirement', cell: (x) => h('div', null, h('span', { class: 'strong' }, x.row.title), h('br'), h('span', { class: 'muted' }, x.row.endClient || 'End client not named'),
          tags(x.row), sameRoleLine(ctx, x.row, x.group, view.grouped)) },
        { label: 'Vendor', cell: (x) => ctx.lk.vendorName(x.row.vendorCompanyId) || '-' },
        { label: 'Rate', cell: (x) => x.row.rateText || '-' },
        { label: 'Where', cell: (x) => [x.row.location, x.row.workMode && !String(x.row.location).toLowerCase().includes(x.row.workMode) ? WORK_MODES[x.row.workMode] : ''].filter(Boolean).join(', ') || '-' },
        { label: 'Source', cell: (x) => sourceChip(x.row) },
        { label: 'Recruiter', class: 'nowrap', cell: (x) => ctx.lk.memberName(x.row.createdBy) },
        { label: 'Posted', class: 'nowrap', cell: (x) => fmtShort(x.row.postedOn) },
        { label: 'Status', cell: (x) => chip(x.row.status === 'open' ? 'Open' : 'Closed', x.row.status === 'open' ? 'ok' : 'neutral') },
        { label: '', class: 'right', cell: (x) => h('div', { class: 'row-end' },
          draftButton(ctx, formBox, { kind: 'pitch', requirement: x.row, contactId: x.row.vendorContactId, vendorId: x.row.vendorCompanyId }, 'Draft email', 'Draft an email about ' + x.row.title),
          canEdit ? button('Edit', { variant: 'secondary', 'aria-label': 'Edit ' + x.row.title, onclick: () => openForm({ existing: x.row }) }) : null) }
      ], shown, { caption: 'Requirements, newest first' + (view.grouped ? ', the same role from several vendors shown once' : '') }));
  }

  /**
   * The requirement form: create (blank), paste (fields read from the text) or edit (an existing row).
   * @param {{values?:object, tags?:object, rawText?:string, existing?:object}} o
   */
  function requirementForm(o) {
    const ex = o.existing || null;
    const values = ex ? { ...EMPTY_VALUES, ...ex } : { ...EMPTY_VALUES, ...(o.values || {}) };
    const t = cleanTags(ex || o.tags || tagsFromFreeText(values));
    const vendors = { '': 'Pick a company' };
    for (const v of ctx.lk.vendors) vendors[v.id] = v.name;
    const contactSel = select({ '': 'Pick a contact' }, '');
    const fillContacts = (companyId, selected) => {
      clear(contactSel);
      contactSel.append(h('option', { value: '' }, 'Pick a contact'));
      for (const c of ctx.lk.contacts.filter((x) => x.companyId === companyId)) contactSel.append(h('option', { value: c.id, selected: c.id === selected }, c.name));
    };
    const vendorSel = select(vendors, values.vendorCompanyId || '', { onchange: () => fillContacts(vendorSel.value, '') });
    fillContacts(values.vendorCompanyId || '', values.vendorContactId || '');
    const num = (v, props) => input({ type: 'number', min: '0', inputmode: 'decimal', value: v === null || v === undefined ? '' : String(v), ...props });
    const el = {
      title: input({ value: values.title }), endClient: input({ value: values.endClient }), jobRef: input({ value: values.jobRef }),
      rateText: input({ value: values.rateText }), location: input({ value: values.location }),
      workMode: select(WORK_MODES, t.workModeTag || values.workMode), duration: input({ value: values.duration }), visaText: input({ value: values.visaText }),
      skills: input({ value: (values.skills || []).join(', ') }),
      rateMin: num(t.rateMin, { step: '0.01' }), rateMax: num(t.rateMax, { step: '0.01' }),
      rateUnit: select({ '': 'Not stated', ...UNIT_LABELS }, t.rateUnit),
      durationMonths: num(t.durationMonths, { step: '1', max: '120' }),
      status: select({ open: 'Open', closed: 'Closed' }, ex ? ex.status : 'open')
    };
    const visaOk = checks('Visas it takes', REQ_VISA_CODES, t.visaAllowed);
    const visaNo = checks('Visas it rules out', REQ_VISA_CODES, t.visaNotAllowed);
    const terms = checks('Tax terms', TERMS_TAGS, t.termsTags.length ? t.termsTags : TERMS_TAGS.filter((x) => x === values.taxTerms));
    const msg = h('div', { 'aria-live': 'polite' });
    const heading = ex ? 'Edit the requirement' : o.rawText ? 'Check the fields' : 'Add a requirement';
    const form = h('form', { class: 'card form', novalidate: true },
      h('h2', null, heading),
      o.rawText ? h('p', { class: 'muted' }, 'These were read from the text. A field the text does not state is left empty. Fix anything that is wrong, then save.') : null,
      h('div', { class: 'grid' },
        field('Title', el.title), field('End client', el.endClient), field('Job reference', el.jobRef), field('Rate as written', el.rateText),
        field('Rate from', el.rateMin), field('Rate to', el.rateMax), field('Rate per', el.rateUnit),
        field('Location', el.location), field('Work mode', el.workMode),
        field('Duration as written', el.duration), field('Duration in months', el.durationMonths),
        h('div', { class: 'field wide' }, visaOk.el), h('div', { class: 'field wide' }, visaNo.el), h('div', { class: 'field wide' }, terms.el),
        field('Visa notes', el.visaText, { hint: 'As the post says it' }), field('Skills', el.skills, { hint: 'Separate with commas' }),
        field('Vendor company', vendorSel), field('Vendor contact', contactSel),
        ex ? field('Status', el.status) : null),
      msg,
      h('div', { class: 'row-end' },
        ex ? deleteButton(ctx, { kind: 'requirement', name: ex.title, run: () => ctx.store.deleteRequirement(ex.id), done: () => ctx.refresh() }) : null,
        button('Cancel', { variant: 'ghost', onclick: () => clear(formBox) }),
        h('button', { type: 'submit', class: 'btn btn-primary' }, ex ? 'Save changes' : 'Save requirement')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(msg);
      const tagged = cleanTags({
        visaAllowed: visaOk.value(), visaNotAllowed: visaNo.value(), termsTags: terms.value(), workModeTag: el.workMode.value,
        rateMin: el.rateMin.value, rateMax: el.rateMax.value, rateUnit: el.rateUnit.value, durationMonths: el.durationMonths.value
      });
      if ((el.rateMin.value || el.rateMax.value) && !el.rateUnit.value) { msg.append(note('warn', 'Pick what the rate is per (hour, day, ...), or clear the rate numbers.')); el.rateUnit.focus(); return; }
      try {
        await ctx.store.saveRequirement({
          ...(ex ? { id: ex.id, source: ex.source, sourceBoard: ex.sourceBoard, sourceUrl: ex.sourceUrl, postedOn: ex.postedOn, rawText: ex.rawText, status: el.status.value }
            : { source: o.rawText ? 'paste' : 'manual', rawText: o.rawText || '' }),
          title: el.title.value, endClient: el.endClient.value, jobRef: el.jobRef.value, rateText: el.rateText.value, location: el.location.value,
          workMode: el.workMode.value, taxTerms: tagged.termsTags.join('/'), duration: el.duration.value, visaText: el.visaText.value, skills: el.skills.value,
          vendorCompanyId: vendorSel.value, vendorContactId: contactSel.value,
          ...tagged
        });
        toast(ex ? 'Requirement saved.' : 'Requirement added.');
        ctx.refresh();
      } catch (err) { msg.append(note('danger', err.message)); el.title.focus(); }
    });
    return form;
  }

  function openForm(o) {
    clear(formBox);
    const form = requirementForm(o);
    formBox.append(form);
    form.querySelector('input').focus();
  }

  function openPaste() {
    clear(formBox);
    const ta = h('textarea', { rows: 8, placeholder: 'Paste the requirement text here', 'aria-describedby': 'paste-hint' });
    const hint = h('span', { class: 'hint', id: 'paste-hint' }, 'Nothing is sent anywhere. The fields are read in your browser.');
    const out = h('div');
    const readBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Read the fields');
    readBtn.addEventListener('click', async () => {
      clear(out);
      if (!ta.value.trim()) { out.append(note('warn', 'Paste some text first.')); ta.focus(); return; }
      const values = parsePastedRequirement(BP, ta.value, Date.now());
      if (!BP) out.append(note('warn', 'The reader could not load, so fill the fields by hand.'));
      const form = requirementForm({ values, tags: tagsFromParsed(BP, ta.value) || tagsFromFreeText(values), rawText: ta.value });
      out.append(form);
      form.querySelector('input').focus();
    });
    formBox.append(h('section', { class: 'card' },
      h('h2', null, 'Paste a requirement'),
      h('div', { class: 'field wide' }, h('label', { for: 'paste-text' }, 'Requirement text'), Object.assign(ta, { id: 'paste-text' }), hint),
      h('div', { class: 'row-end' },
        button('Use a sample', { variant: 'ghost', onclick: () => { ta.value = SAMPLE_POST; ta.setSelectionRange(0, 0); ta.focus(); ta.scrollTop = 0; } }),
        button('Close', { variant: 'ghost', onclick: () => clear(formBox) }),
        readBtn)),
    out);
    ta.focus();
  }

  const set = (k) => (e) => { f[k] = e.target.value; drawList(); };
  const visaOptions = { '': 'Any', uscgc: 'USC / GC only', ...Object.fromEntries(REQ_VISA_CODES.map((c) => [c, 'Takes ' + c])) };
  await drawList();
  const groupBox = h('input', { type: 'checkbox', id: 'req-group', checked: true, onchange: (e) => { view.grouped = e.target.checked; drawList(); } });
  const filters = h('div', { class: 'filters' },
    field('Search', input({ type: 'search', placeholder: 'Title, client, skill', oninput: set('q') })),
    field('Status', select({ '': 'All', open: 'Open', closed: 'Closed' }, '', { onchange: set('status') })),
    field('Source', select(sourceOptions(firstRows, f.source), '', { onchange: set('source') })),
    field('Job board', select({ '': 'All', ...BOARD_LABELS }, '', { onchange: set('board') })),
    field('Visa', select(visaOptions, '', { onchange: (e) => { f.uscGcOnly = e.target.value === 'uscgc'; f.visa = f.uscGcOnly ? '' : e.target.value; drawList(); } }),
      { hint: 'Takes: the post lists it or names no visa' }),
    field('Tax terms', select({ '': 'Any', ...Object.fromEntries(TERMS_TAGS.map((x) => [x, x])) }, '', { onchange: set('terms') })),
    field('Work mode', select({ ...WORK_MODES, '': 'Any' }, '', { onchange: set('workMode') })),
    field('Min rate ($/hr)', input({ type: 'number', min: '0', inputmode: 'decimal', oninput: set('minRate') }), { hint: 'Posts with no rate are left out' }),
    field('Min months', input({ type: 'number', min: '0', inputmode: 'numeric', oninput: set('minMonths') })),
    deskFilterField(ctx, (v) => { f.deskId = v; drawList(); }),
    h('div', { class: 'field check' }, groupBox, h('label', { for: 'req-group' }, 'Show the same role once')));

  return h('div', { class: 'stack' },
    pageHeader('Requirements', 'Everything the team has captured, newest first', [
      button('Add a requirement', { variant: 'secondary', disabled: !canEdit, onclick: () => openForm({}) }),
      button('Paste a requirement', { variant: 'primary', disabled: !canEdit, onclick: openPaste })]),
    formBox, filters, listBox);
}
