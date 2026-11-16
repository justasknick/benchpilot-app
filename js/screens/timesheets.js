// Timesheets (migration 0055, staffing F1): weekly regular and overtime hours per placement, who approved them (typed), and the status
// draft -> submitted -> approved. No files and no client logins: the person types what the client approved. A week on an invoice is locked
// until the invoice is removed. "Missing" = finished weeks a placement ran in with no timesheet, once the placement is on timesheets (it has
// its first week). Every member records weeks; owners and managers delete them. Team plans (plan-gate 'invoicing'). Rules: BP.Timesheets.

import { h, clear } from '../dom.js';
import { pageHeader, card, table, chip, empty, emptyState, button, toast, select, field, input, note, lockNote, plural } from '../ui.js';
import { loadDraftLib } from '../bp-lib.js';
import { FEATURE_FROM } from '../plan-gate.js';
import { canDeleteRecords } from '../record-delete.js';
import { placementInfo, placementLabel, invoicingOn, hoursText, TIMESHEET_KIND } from '../invoicing-ui.js';

export async function render(ctx) {
  const header = pageHeader('Timesheets', 'Weekly hours per placement, who approved them, and the weeks still missing');
  if (!invoicingOn(ctx)) {
    return h('div', { class: 'stack' }, header, card('Timesheets, invoices and commission', lockNote(ctx, { badge: FEATURE_FROM.invoicing,
      text: 'Record the weekly hours of every placement, see the weeks still missing, and turn approved weeks into invoices. Included from ' + FEATURE_FROM.invoicing + '.', plan: true })));
  }
  const BP = await loadDraftLib();
  const T = BP.Timesheets;
  ctx.lk.requirements = ctx.lk.requirements || await ctx.store.listRequirements();
  const [placements, submissions, sheets] = await Promise.all([ctx.store.listPlacements(), ctx.store.listSubmissions({}), ctx.store.listTimesheets({})]);
  const today = ctx.session.today;
  const me = ctx.session.user.id;
  const info = placementInfo(ctx, placements, submissions);
  const byId = new Map(info.map((r) => [r.id, r]));
  const view = { placementId: ctx.route.params.placement && byId.has(ctx.route.params.placement) ? ctx.route.params.placement : '', mine: false };
  const canWrite = ctx.can('edit_records');
  const formBox = h('div');
  const body = h('div', { class: 'stack', 'aria-live': 'polite' });

  const sheetsOf = (id) => sheets.filter((t) => t.placementId === id);
  const onSheets = info.filter((r) => sheetsOf(r.id).length);
  const missing = BP.Invoices.reminders(onSheets.map((r) => ({ ...r, timesheets: sheetsOf(r.id) })), today, T.MISSING_WEEKS);

  function openForm(r, sheet, week) {
    clear(formBox);
    const x = sheet || { weekStart: week || T.weekStartOf(today), regular: '', ot: '', approvedBy: '', status: 'draft' };
    const el = {
      placement: sheet ? null : select(Object.fromEntries(info.map((p) => [p.id, placementLabel(p)])), r ? r.id : (view.placementId || (info[0] && info[0].id) || '')),
      week: input({ type: 'date', value: x.weekStart, required: true }),
      regular: input({ inputmode: 'decimal', value: x.regular === '' ? '' : String(x.regular), placeholder: '40', class: 'rate-in' }),
      ot: input({ inputmode: 'decimal', value: x.ot ? String(x.ot) : '', placeholder: '0', class: 'rate-in' }),
      status: select(Object.fromEntries(T.STATUSES.map((s) => [s, T.STATUS_LABELS[s]])), x.status),
      approvedBy: input({ value: x.approvedBy || '', maxlength: String(T.APPROVER_MAX), placeholder: 'e.g. Dana L., client manager' })
    };
    const weekHint = h('span', { class: 'hint', 'aria-live': 'polite' });
    const paintWeek = () => { weekHint.textContent = T.weekStartOf(el.week.value) ? 'Week of ' + T.weekLabel(el.week.value) : ''; };
    el.week.addEventListener('input', paintWeek);
    const msg = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'btn btn-primary' }, sheet ? 'Save week' : 'Add week');
    const target = () => byId.get(sheet ? sheet.placementId : el.placement.value);
    const form = h('form', { class: 'ts-form', novalidate: true, 'aria-label': sheet ? 'Edit a week' : 'Add a week' },
      h('h3', { class: 'form-title' }, sheet ? 'Edit the week of ' + T.weekLabel(sheet.weekStart) + (r ? ' for ' + r.consultantName : '') : 'Add a week'),
      h('div', { class: 'grid' },
        el.placement ? field('Placement', el.placement, { wide: true }) : null,
        field('Any day of the week', el.week, { hint: 'Weeks run Monday to Sunday.' }), weekHint,
        field('Regular hours', el.regular), field('Overtime hours', el.ot),
        field('Status', el.status), field('Approved by', el.approvedBy, { hint: 'Who approved the hours at the client or vendor. Needed for Approved.' })),
      msg,
      h('div', { class: 'row-end' }, button('Cancel', { variant: 'ghost', onclick: () => clear(formBox) }), save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(msg);
      const p = target();
      if (!p) { msg.append(note('danger', 'Pick the placement.')); return; }
      const c = T.cleanTimesheet({ weekStart: el.week.value, regular: el.regular.value, ot: el.ot.value, status: el.status.value, approvedBy: el.approvedBy.value },
        { before: sheet || null, placement: p.placement });
      if (!c.ok) { msg.append(note('danger', c.error)); return; }
      save.disabled = true;
      try {
        await ctx.store.saveTimesheet({ ...c.timesheet, id: sheet ? sheet.id : undefined, placementId: p.id });
        toast(sheet ? 'Week saved.' : 'Week added.'); ctx.refresh();
      } catch (err) { msg.append(note('danger', err.message)); save.disabled = false; }
    });
    paintWeek();
    formBox.append(card(null, form, { class: 'form-card' }));
    (el.regular).focus();
  }

  async function remove(t) {
    try { await ctx.store.deleteTimesheet(t.id); toast('Week removed.'); ctx.refresh(); } catch (err) { toast(err.message); }
  }

  function draw() {
    clear(body);
    let rows = sheets.filter((t) => byId.has(t.placementId) && (!view.placementId || t.placementId === view.placementId));
    if (view.mine) rows = rows.filter((t) => byId.get(t.placementId).recruiterId === me);
    const awaiting = sheets.filter((t) => t.status === 'submitted').length;
    const ready = sheets.filter((t) => t.status === 'approved' && !t.invoiceId);
    const month = today.slice(0, 7);
    const monthHours = T.hoursTotal(sheets.filter((t) => t.weekStart.slice(0, 7) === month || T.weekEndOf(t.weekStart).slice(0, 7) === month));
    const tile = (n, label, sub) => h('div', { class: 'tile' }, h('span', { class: 'tile-num' }, String(n)), h('span', { class: 'tile-label' }, label), sub ? h('span', { class: 'tile-hint' }, sub) : null);
    body.append(h('div', { class: 'tiles tiles--4' },
      tile(missing.missingCount, 'Weeks missing', missing.missingCount ? 'on ' + plural(missing.missing.length, 'placement') : 'Every week is in'),
      tile(awaiting, 'Waiting for approval', 'Submitted, not approved yet'),
      tile(hoursText(T.hoursTotal(ready).total), 'Approved, not invoiced', plural(ready.length, 'week')),
      tile(hoursText(monthHours.total), 'Hours this month', 'Weeks that touch ' + new Date(month + '-15T00:00:00Z').toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }))));

    if (missing.missing.length) {
      body.append(card('Weeks missing', table([
        { label: 'Placement', cell: (m) => h('span', { class: 'strong' }, placementLabel(m.item)) },
        { label: 'Weeks', cell: (m) => h('div', { class: 'ts-weeks' }, m.weeks.slice(0, 4).map((w) => chip(T.weekLabel(w), 'warn')), m.weeks.length > 4 ? h('span', { class: 'muted' }, ' and ' + (m.weeks.length - 4) + ' more') : null) },
        { label: '', class: 'right', cell: (m) => button('Add the oldest', { variant: 'secondary', disabled: !canWrite, 'aria-label': 'Add the week of ' + T.weekLabel(m.weeks[m.weeks.length - 1]) + ' for ' + m.item.consultantName,
          onclick: () => openForm(m.item, null, m.weeks[m.weeks.length - 1]) }) }
      ], missing.missing, { caption: 'Placements with finished weeks and no timesheet' }), { class: 'ts-missing' }));
    }

    if (!sheets.length) {
      body.append(emptyState({ icon: 'clock', title: 'No timesheets yet', text: info.length
        ? 'Add the first week of a placement. From then on, BenchPilot lists every finished week that has no timesheet.'
        : 'Timesheets belong to placements. Add a placement from a submission at Offer or Placed first.',
      action: info.length ? button('Add a week', { variant: 'primary', disabled: !canWrite, onclick: () => openForm(null) }) : h('a', { class: 'btn btn-primary', href: '#placements' }, 'Open placements') }));
      return;
    }
    body.append(rows.length ? table([
      { label: 'Week', class: 'nowrap', cell: (t) => h('span', { class: 'strong' }, T.weekLabel(t.weekStart)) },
      { label: 'Placement', cell: (t) => { const p = byId.get(t.placementId); return h('div', null, h('a', { href: '#consultant-' + p.placement.consultantId }, p.consultantName), h('div', { class: 'muted' }, [...new Set([p.endClient, p.vendorName].filter(Boolean))].join(' · '))); } },
      { label: 'Regular', class: 'num', cell: (t) => h('span', { class: 'mono' }, hoursText(t.regular)) },
      { label: 'Overtime', class: 'num', cell: (t) => h('span', { class: 'mono' }, t.ot ? hoursText(t.ot) : '-') },
      { label: 'Approved by', cell: (t) => t.approvedBy || h('span', { class: 'muted' }, '-') },
      { label: 'Status', cell: (t) => h('div', null, chip(T.STATUS_LABELS[t.status], TIMESHEET_KIND[t.status]), t.invoiceId ? [' ', chip('Invoiced', 'accent')] : null) },
      { label: '', class: 'right', cell: (t) => h('div', { class: 'row-end' },
        button('Edit', { variant: 'ghost', disabled: !canWrite || Boolean(t.invoiceId), title: t.invoiceId ? 'This week is on an invoice. Remove the invoice first.' : null,
          'aria-label': 'Edit the week of ' + T.weekLabel(t.weekStart), onclick: () => openForm(byId.get(t.placementId), t) }),
        canDeleteRecords(ctx.session.role, !ctx.readOnly) && !t.invoiceId ? button('Remove', { variant: 'ghost', 'aria-label': 'Remove the week of ' + T.weekLabel(t.weekStart), onclick: () => remove(t) }) : null) }
    ], rows, { caption: 'Timesheets, newest week first' }) : empty('No week matches these filters.'));
  }

  const filters = h('div', { class: 'filters' },
    field('Placement', select({ '': 'All placements', ...Object.fromEntries(info.map((p) => [p.id, placementLabel(p)])) }, view.placementId,
      { onchange: (e) => { view.placementId = e.target.value; draw(); } })),
    ctx.session.role === 'recruiter' ? null : field('Recruiter', select({ all: 'Everyone', mine: 'My placements' }, 'all', { onchange: (e) => { view.mine = e.target.value === 'mine'; draw(); } })));
  draw();
  return h('div', { class: 'stack' },
    pageHeader('Timesheets', 'Weekly hours per placement, who approved them, and the weeks still missing',
      button('Add a week', { variant: 'primary', disabled: !canWrite || !info.length, title: canWrite ? null : 'The workspace is read-only.', onclick: () => openForm(null) })),
    formBox, filters, body,
    h('p', { class: 'hint' }, 'Type the hours the client approved; BenchPilot keeps no timesheet files and gives the client no login. Approved weeks become invoices on the Invoices screen (owners and managers). A week on an invoice is locked until the invoice is removed.'));
}
