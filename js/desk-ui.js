// webapp/js/desk-ui.js - the Agency desks pieces the screens share (backlog W10, migration 0036; the rules are in js/desks.js):
//   desksOn(ctx)                    the plan has desks (plan-gate 'desks') and the team has at least one
//   deskFilterField(ctx, onChange)  the "Desk" filter on Bench, Requirements, Submissions, Matches and the activity log (null when off)
//   deskPicker(ctx, value)          the "Desk" select of the consultant form (null when off)
//   desksCard(ctx)                  the Team screen card: owners and managers add, rename and delete desks and seat people;
//                                   others see the desks; Starter and Team see an upgrade note

import { h, clear } from './dom.js';
import { card, table, field, input, select, note, empty, button, toast, plural, lockNote } from './ui.js';
import { hasFeature, FEATURE_FROM } from './plan-gate.js';
import { deskIndex, deskOptions, deskLabel, DESK_NAME_MAX, DESK_OFFICE_MAX } from './desks.js';

export function desksAllowed(ctx) { return hasFeature(ctx.team && ctx.team.billing, 'desks'); }
export function desksOn(ctx) { return desksAllowed(ctx) && Boolean(ctx.lk && ctx.lk.desks && ctx.lk.desks.length); }

/** The desk filter: '' all, a desk id, or NO_DESK. `onChange(deskId)`. */
export function deskFilterField(ctx, onChange) {
  if (!desksOn(ctx)) return null;
  return field('Desk', select(deskOptions(ctx.lk.desks), '', { onchange: (e) => onChange(e.target.value) }));
}

/** The consultant form's desk select ('' = their recruiter's desk). Owners and managers only; others never send a desk. */
export function deskPicker(ctx, value) {
  if (!desksOn(ctx) || !ctx.can('manage_desks')) return null;
  const opts = { '': "The recruiter's desk" };
  for (const d of ctx.lk.desks) opts[d.id] = deskLabel(d);
  return select(opts, value || '', {});
}

export function desksCard(ctx) {
  const title = 'Desks';
  if (!desksAllowed(ctx)) {
    return card(title, lockNote(ctx, { plan: true, badge: FEATURE_FROM.desks,
      text: `Desks and offices come with ${FEATURE_FROM.desks}: group recruiters and consultants by desk, filter every list by desk, and get the morning report per desk.` }));
  }
  const canEdit = ctx.can('manage_desks');
  const lk = ctx.lk || {};
  const desks = lk.desks || [];
  const idx = lk.deskIdx || deskIndex(desks);
  const members = (lk.members || []).filter((m) => !m.removedAt);
  const msg = h('div', { 'aria-live': 'polite' });
  const run = async (fn, done) => {
    clear(msg);
    try { await fn(); toast(done); ctx.refresh(); } catch (err) { msg.append(note('danger', err.message)); }
  };

  const deskRows = desks.length ? table([
    { label: 'Desk', cell: (d) => h('span', { class: 'strong' }, d.name) },
    { label: 'Office', cell: (d) => d.office || '-' },
    { label: 'People', class: 'num', cell: (d) => String(d.memberIds.filter((u) => members.some((m) => m.id === u)).length) },
    {
      label: 'Actions', cell: (d) => canEdit ? h('div', { class: 'row-end' },
        button('Rename', { variant: 'ghost', 'aria-label': 'Rename ' + d.name, onclick: () => { clear(formBox); formBox.append(deskForm(d)); } }),
        button('Delete', {
          variant: 'ghost', 'aria-label': 'Delete ' + d.name,
          onclick: () => { if (confirm(`Delete the desk "${d.name}"? Its people and consultants stay; they are just on no desk.`)) run(() => ctx.store.deleteDesk(d.id), 'Desk deleted.'); }
        })) : ''
    }
  ], desks, { caption: 'Desks' }) : empty('No desks yet. Until you add one, the morning report has a line per recruiter.');

  const formBox = h('div');
  function deskForm(d) {
    const name = input({ maxlength: String(DESK_NAME_MAX), value: d ? d.name : '', required: true, placeholder: 'Java desk' });
    const office = input({ maxlength: String(DESK_OFFICE_MAX), value: d ? d.office : '', placeholder: 'Hyderabad' });
    return h('form', {
      class: 'form', novalidate: true, onsubmit: (e) => {
        e.preventDefault();
        run(() => ctx.store.saveDesk({ id: d ? d.id : undefined, name: name.value, office: office.value }), d ? 'Desk renamed.' : 'Desk added.');
      }
    }, h('div', { class: 'grid' }, field('Desk name', name), field('Office or location', office, { hint: 'Optional' })),
    h('div', { class: 'row-end' }, button(d ? 'Save desk' : 'Add desk', { type: 'submit', variant: 'primary' }),
      d ? button('Cancel', { variant: 'ghost', onclick: () => clear(formBox) }) : null));
  }
  if (canEdit) formBox.append(deskForm(null));

  const seatOpts = { '': 'No desk' };
  for (const d of desks) seatOpts[d.id] = deskLabel(d);
  const seats = desks.length ? table([
    { label: 'Person', cell: (m) => m.name },
    {
      label: 'Desk', cell: (m) => canEdit
        ? select(seatOpts, idx.userDesk(m.id), { 'aria-label': 'Desk of ' + m.name, onchange: (e) => run(() => ctx.store.setMemberDesk(m.id, e.target.value), 'Desk changed.') })
        : (idx.name(idx.userDesk(m.id)) || 'No desk')
    }
  ], members, { caption: 'Who sits where' }) : null;

  return card(title, h('div', { class: 'stack', id: 'desks' },
    h('p', { class: 'muted' }, `${plural(desks.length, 'desk')}. Each person sits on one desk; a consultant counts on their recruiter's desk unless you pick another one on the consultant. Bench, Requirements, Submissions, Matches and the activity log filter by desk, and the morning report has a line per desk.`),
    deskRows, seats, canEdit ? formBox : h('p', { class: 'muted' }, 'Only owners and managers change desks.'), msg));
}
