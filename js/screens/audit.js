// Activity log (#audit, reached from Team settings): "who changed what" for owners and managers (perms 'audit_log').
// The log holds ids only; js/audit-lib.js turns each row into a plain line with names from the team book. Export follows the
// workspace export policy (perms 'export'), the same rule as "Export everything".

import { h, clear } from '../dom.js';
import { pageHeader, table, field, input, select, empty, note, button, toast, chip, lockNote } from '../ui.js';
import { AUDIT_KINDS, AUDIT_PAGE, AUDIT_EXPORT_MAX, auditLine, auditCsvRows, fmtWhen } from '../audit-lib.js';
import { toCsv } from '../export-zip.js';
import { deskActorIds } from '../desks.js';
import { deskFilterField } from '../desk-ui.js';

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Names for the lines: ctx.lk plus the requirements and submissions (loaded here; a failure only means fewer names). */
async function lookups(ctx) {
  const [reqs, subs] = await Promise.all([
    ctx.store.listRequirements().catch(() => []), ctx.store.listSubmissions({}).catch(() => [])
  ]);
  return { ...ctx.lk, requirements: new Map(reqs.map((r) => [r.id, r])), submissions: new Map(subs.map((s) => [s.id, s])) };
}

export async function render(ctx) {
  const back = h('a', { href: '#team', class: 'btn btn-ghost' }, 'Back to Team');
  if (!ctx.can('audit_log')) {
    return h('div', { class: 'stack' }, pageHeader('Activity log', 'Who changed what in the workspace', [back]),
      lockNote(ctx, { badge: 'Owners and managers', text: 'Only owners and managers can see the activity log.' }));
  }
  const lk = await lookups(ctx);
  const f = { actorId: '', kind: '', from: '', to: '', actorIds: null };   // actorIds: the people of the chosen desk (Agency desks)
  let offset = 0;
  const listBox = h('div', { 'aria-live': 'polite' });
  const pager = h('div', { class: 'row-end' });

  async function draw() {
    clear(listBox); clear(pager);
    let page;
    try { page = await ctx.store.listAudit({ ...f, limit: AUDIT_PAGE, offset }); }
    catch (err) { listBox.append(note('danger', err.message)); return; }
    const lines = page.rows.map((r) => auditLine(r, lk));
    listBox.append(lines.length ? table([
      { label: 'When', cell: (l) => fmtWhen(l.when) },
      { label: 'Person', cell: (l) => h('span', { class: 'strong' }, l.person) },
      { label: 'What', cell: (l) => l.text },
      { label: 'Type', cell: (l) => chip(l.kindLabel) }
    ], lines, { caption: 'Activity log' }) : empty(offset ? 'No older entries.' : 'Nothing matches these filters.'));
    if (offset > 0) pager.append(button('Newer', { variant: 'secondary', onclick: () => { offset = Math.max(0, offset - AUDIT_PAGE); draw(); } }));
    if (page.more) pager.append(button('Older', { variant: 'secondary', onclick: () => { offset += AUDIT_PAGE; draw(); } }));
  }
  const refilter = (k) => (e) => { f[k] = e.target.value; offset = 0; draw(); };

  const people = { '': 'Everyone' };
  for (const m of ctx.lk.members) people[m.id] = m.name + (m.removedAt ? ' (removed)' : '');
  const kinds = { '': 'Everything', ...Object.fromEntries(Object.entries(AUDIT_KINDS).map(([k, v]) => [k, v.label])) };
  const filters = h('div', { class: 'filters' },
    field('Person', select(people, '', { onchange: refilter('actorId') })),
    deskFilterField(ctx, (v) => { f.actorIds = deskActorIds(v, ctx.lk.deskIdx, ctx.lk.members); offset = 0; draw(); }),
    field('Type', select(kinds, '', { onchange: refilter('kind') })),
    field('From', input({ type: 'date', onchange: refilter('from') })),
    field('To', input({ type: 'date', onchange: refilter('to') })));

  const exportBtn = button('Export this list', {
    variant: 'secondary', disabled: !ctx.can('export'),
    title: ctx.can('export') ? 'Download the filtered log as a CSV file' : 'Your role cannot export. Ask the owner.',
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const all = [];
        for (let off = 0; all.length < AUDIT_EXPORT_MAX; off += 500) {
          const page = await ctx.store.listAudit({ ...f, limit: 500, offset: off });
          all.push(...page.rows);
          if (!page.more) break;
        }
        download('benchpilot-activity-' + ctx.session.today + '.csv', toCsv(auditCsvRows(all.slice(0, AUDIT_EXPORT_MAX).map((r) => auditLine(r, lk)))));
        toast(all.length >= AUDIT_EXPORT_MAX ? 'Exported the newest ' + AUDIT_EXPORT_MAX + ' entries. Narrow the dates for older ones.' : 'Activity log downloaded.');
      } catch (err) { toast(err.message); }
      btn.disabled = false;
    }
  });

  await draw();
  return h('div', { class: 'stack' },
    pageHeader('Activity log', 'Who added, changed or deleted what. Names come from your book; the log itself keeps no emails or phone numbers.', [back, exportBtn]),
    filters, listBox, pager);
}
