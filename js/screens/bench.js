// Bench: the firm's consultants, with status chips and bench days, and "Hotlist" (screens/hotlist.js: email text, table, CSV; nothing is sent).

import { h, clear } from '../dom.js';
import { pageHeader, table, chip, field, input, select, empty, note, button, emptyState, sampleDataButton, STATUS_LABELS, STATUS_KIND, plural } from '../ui.js';
import { benchDays, BENCH_STATUSES } from '../stats.js';
import { consultantForm } from './consultant.js';
import { hotlistPanel } from './hotlist.js';
import { loadHotlistLib } from '../bp-lib.js';
import { filterByDesk } from '../desks.js';
import { deskFilterField, desksOn } from '../desk-ui.js';
import { benchFull, capNote } from './bench-cap.js';
import { VISA_TYPES, consultantVisaType, expiringWorkAuth, availabilityOf } from '../consultant-profile.js';
import { needsConsent } from '../consent.js';
import { fmtShort } from '../dates.js';

/** The Work authorisation filter: every type, or 'expiring' = on the bench and ending within 90 days (or ended). */
export const WORK_AUTH_FILTER_DAYS = 90;
export function filterWorkAuth(rows, value, today) {
  if (!value) return rows;
  if (value === 'expiring') { const ids = new Set(expiringWorkAuth(rows, today, WORK_AUTH_FILTER_DAYS).map((x) => x.id)); return rows.filter((c) => ids.has(c.id)); }
  return rows.filter((c) => consultantVisaType(c) === value);
}

export async function render(ctx) {
  const f = { q: '', status: '', recruiterId: '', deskId: '', auth: '' };
  const listBox = h('div', { 'aria-live': 'polite' });
  const addBox = h('div');
  const hotBox = h('div');

  async function drawList() {
    const rows = filterWorkAuth(filterByDesk('consultant', await ctx.store.listConsultants(f), f.deskId, ctx.lk.deskIdx), f.auth, ctx.session.today);
    const ending = new Map(expiringWorkAuth(rows, ctx.session.today).map((x) => [x.id, x]));
    clear(listBox);
    listBox.append(rows.length ? table([
      { label: 'Consultant', cell: (c) => h('a', { href: '#consultant-' + c.id, class: 'strong' }, c.name) },
      { label: 'Role', cell: (c) => c.title },
      // Staffing P5: being marketed with no consent recorded (Today's nudge links here)
      { label: 'Status', cell: (c) => h('span', { class: 'chips' }, chip(STATUS_LABELS[c.status] || c.status, STATUS_KIND[c.status]), needsConsent(c) ? chip('No consent', 'warn') : null) },
      { label: 'Work auth. / terms', cell: (c) => h('span', null, [consultantVisaType(c), c.taxTerms].filter(Boolean).join(' / ') || '-',
        ending.has(c.id) ? [' ', chip(ending.get(c.id).label, ending.get(c.id).days <= 30 ? 'danger' : 'warn')] : null) },
      { label: 'Available', class: 'nowrap', cell: (c) => { const a = availabilityOf(c, ctx.session.today); return a.state === 'unknown' ? '-' : a.state === 'now' ? 'Now' : chip('From ' + fmtShort(c.availableOn), a.state === 'later' ? 'neutral' : 'accent'); } },
      { label: 'Recruiter', cell: (c) => ctx.lk.memberName(c.ownerRecruiterId) },
      desksOn(ctx) ? { label: 'Desk', cell: (c) => ctx.lk.deskIdx.name(ctx.lk.deskIdx.consultantDesk(c)) || '-' } : null,
      { label: 'Bench days', class: 'num', cell: (c) => BENCH_STATUSES.includes(c.status) ? String(benchDays(c, ctx.session.today)) : '-' }
    ].filter(Boolean), rows, { caption: 'Bench' }) : empty('No consultants match these filters.'));
  }

  const recruiters = { '': 'All recruiters' };
  for (const m of ctx.lk.members.filter((x) => !x.removedAt)) recruiters[m.id] = m.name;
  const filters = h('div', { class: 'filters' },
    field('Search', input({ type: 'search', placeholder: 'Name, role, skill', oninput: (e) => { f.q = e.target.value; drawList(); } })),
    field('Status', select({ '': 'All statuses', ...STATUS_LABELS }, '', { onchange: (e) => { f.status = e.target.value; drawList(); } })),
    field('Recruiter', select(recruiters, '', { onchange: (e) => { f.recruiterId = e.target.value; drawList(); } })),
    field('Work authorisation', select({ '': 'All types', expiring: `Ending in ${WORK_AUTH_FILTER_DAYS} days`, ...Object.fromEntries(VISA_TYPES.map((t) => [t, t])) }, '', { onchange: (e) => { f.auth = e.target.value; drawList(); } })),
    deskFilterField(ctx, (v) => { f.deskId = v; drawList(); }));

  const addBtn = h('button', {
    type: 'button', class: 'btn btn-primary', 'aria-expanded': 'false', disabled: !ctx.can('edit_records'),
    onclick: () => {
      if (addBox.firstChild) { clear(addBox); addBtn.setAttribute('aria-expanded', 'false'); return; }
      addBtn.setAttribute('aria-expanded', 'true');
      addBox.append(consultantForm(ctx, null, { onSaved: (c) => ctx.go('#consultant-' + c.id), onCancel: () => { clear(addBox); addBtn.setAttribute('aria-expanded', 'false'); } }));
      addBox.querySelector('input').focus();
    }
  }, 'Add consultant');

  const all = await ctx.store.listConsultants();

  // Hotlist: the whole bench (Marketing ticked), formatted by the extension's lib/hotlist.js.
  const closeHot = () => { clear(hotBox); hotBtn.setAttribute('aria-expanded', 'false'); };
  const hotBtn = h('button', {
    type: 'button', class: 'btn btn-secondary', 'aria-expanded': 'false', disabled: !all.length,
    title: 'Build a hotlist email, table or CSV from the bench. Nothing is sent.',
    onclick: async () => {
      if (hotBox.firstChild) { closeHot(); return; }
      hotBtn.setAttribute('aria-expanded', 'true');
      try {
        const H = await loadHotlistLib();
        hotBox.append(hotlistPanel(ctx, await ctx.store.listConsultants(), H, { onClose: closeHot }));
      } catch (e) {
        hotBox.append(note('danger', 'Could not load the hotlist builder. Reload the page and try again.'));
      }
    }
  }, 'Hotlist');

  await drawList();
  return h('div', { class: 'stack' },
    pageHeader('Bench', plural(all.filter((c) => BENCH_STATUSES.includes(c.status)).length, 'consultant') + ' on the bench', [hotBtn, addBtn]),
    benchFull(ctx, all.length) ? capNote(ctx, 'info') : null,
    hotBox, addBox,
    all.length ? [filters, listBox] : emptyState({
      icon: 'bench', title: 'No consultants on the bench yet',
      text: 'Add your first consultant to see matches, build a hotlist and log submissions.',
      action: ctx.can('edit_records') ? button('Add consultant', { variant: 'primary', onclick: () => addBtn.click() }) : null,
      secondary: sampleDataButton(ctx) || (ctx.can('import') ? h('a', { class: 'btn btn-secondary', href: '#import' }, 'Import from a spreadsheet') : null)
    }));
}
