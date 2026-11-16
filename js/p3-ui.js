// webapp/js/p3-ui.js - staffing P3 (docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md, migration 0051) in the team workspace: a submission's
// interviews (round, time in a zone, mode, panel, feedback, outcome) with the .ics calendar file, its placement form (start and end date,
// bill and pay rate, terms, PO, status), and Today's "Interviews today and tomorrow" card. Every rule (time zones, the .ics text, the
// placement status, the margin) is the extension's lib/placements.js (BP.Placements, through loadDraftLib), so both say the same thing.
// No calendar API: the .ics is a file the person opens in Google Calendar, Outlook or Apple Calendar.

import { h, clear, append } from './dom.js';
import { field, input, select, button, note, chip, card, empty, toast } from './ui.js';
import { canDeleteRecords } from './record-delete.js';

const numText = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
const money = (n) => '$' + Number(n).toLocaleString('en-US', Number.isInteger(Number(n)) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });   // $2,400 or $2.50
export const OUTCOME_KIND = { pending: 'neutral', passed: 'ok', failed: 'danger', no_show: 'warn' };
export const PLACEMENT_KIND = { upcoming: 'accent', active: 'ok', ended: 'neutral', fell_through: 'danger' };

/** The person's own zone (the browser's) and the zone list for the select: the desk's zones first, the person's own added when missing. */
export function zoneOptions(P) {
  const mine = P.viewerZone();
  const out = {};
  if (!P.ZONES.some(([z]) => z === mine)) out[mine] = mine.replace(/_/g, ' ') + ' (your zone)';
  for (const [z, label] of P.ZONES) out[z] = label;
  return out;
}

/** "Today, 21:00 IST" in the viewer's zone, plus "(10:30 EST for the panel)" when the interview was booked in another zone. */
export function interviewWhen(P, iv, today) {
  const mine = P.viewerZone();
  const when = P.interviewTimeText(iv.at, mine, { today });
  if (!iv.tz || iv.tz === mine) return when;
  const theirs = P.interviewTimeText(iv.at, iv.tz).replace(/^.*, /, '');
  return `${when} (${theirs} for the panel)`;
}

/** Download the interview as an .ics file (a Blob in the browser; nothing leaves the computer). */
export function downloadIcs(BP, iv, names) {
  const f = BP.Placements.interviewIcs({ interview: iv, ...names });
  if (!f) { toast('Could not build the calendar file.'); return false; }
  const url = URL.createObjectURL(new Blob([f.text], { type: 'text/calendar;charset=utf-8' }));
  const a = h('a', { href: url, download: f.filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Calendar file downloaded. Open it to add the interview to your calendar.');
  return true;
}

/** The calendar actions for one interview: the .ics file, and "Add to Google Calendar" / "Add to Outlook" template links that open the
 *  person's own calendar with the event filled in (BP.Placements.calendarLinks; no calendar API, no OAuth scope). */
export function calendarActions(BP, iv, names, label) {
  const l = BP.Placements.calendarLinks({ interview: iv, ...names });
  const link = (href, text, aria) => h('a', { class: 'btn btn-ghost', href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': aria }, text);
  return [
    button('Calendar (.ics)', { variant: 'secondary', 'aria-label': `Add ${label} to my calendar (.ics file)`, onclick: () => downloadIcs(BP, iv, names) }),
    l ? link(l.google, 'Google', `Add ${label} to Google Calendar (opens Google Calendar)`) : null,
    l ? link(l.outlook, 'Outlook', `Add ${label} to Outlook (opens Outlook on the web)`) : null
  ];
}

/** The names an .ics needs for a submission. */
function icsNames(ctx, s) {
  return { consultantName: ctx.lk.consultantName(s.consultantId), endClient: s.endClient, vendorName: ctx.lk.vendorName(s.vendorCompanyId),
    role: ((ctx.lk.requirements || []).find((r) => r.id === s.requirementId) || {}).title || '' };
}

/** The add / edit form of one interview. onSaved(): repaint. */
function interviewForm(ctx, BP, s, iv, list, onSaved, onCancel) {
  const P = BP.Placements;
  const x = iv || {};
  const tz = x.tz || P.viewerZone();
  const el = {
    round: input({ type: 'number', min: '1', max: String(P.MAX_ROUND), value: String(x.round || P.nextRound(list)), class: 'rate-in' }),
    at: input({ type: 'datetime-local', value: x.at ? P.utcToZoned(Date.parse(x.at), tz) : '' }),
    tz: select(zoneOptions(P), tz),
    mode: select(Object.fromEntries(P.MODES.map((m) => [m, P.MODE_LABELS[m]])), x.mode || 'video'),
    withWhom: input({ value: x.withWhom || '', maxlength: String(P.WITH_MAX), placeholder: 'e.g. Hiring manager and a tech lead' }),
    outcome: select(Object.fromEntries(P.OUTCOMES.map((o) => [o, P.OUTCOME_LABELS[o]])), x.outcome || 'pending'),
    feedback: h('textarea', { rows: 2, maxlength: String(P.FEEDBACK_MAX), placeholder: 'What the panel asked, how it went' }, x.feedback || '')
  };
  const mineLine = h('p', { class: 'hint', 'aria-live': 'polite' });
  const paintMine = () => {
    const ms = P.zonedToUtc(el.at.value, el.tz.value);
    mineLine.textContent = Number.isFinite(ms) && el.tz.value !== P.viewerZone() ? `That is ${P.interviewTimeText(ms, P.viewerZone(), { today: ctx.session.today })} for you.` : '';
  };
  el.at.addEventListener('input', paintMine); el.tz.addEventListener('change', paintMine);
  const msg = h('div', { 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, iv ? 'Save interview' : 'Add interview');
  const form = h('form', { class: 'p3-form', novalidate: true, 'aria-label': iv ? 'Edit interview' : 'New interview' },
    h('div', { class: 'grid' }, field('Round', el.round), field('Mode', el.mode), field('Date and time', el.at), field('Time zone', el.tz),
      field('Panel', el.withWhom, { wide: true }), field('Outcome', el.outcome), field('Notes and feedback', el.feedback, { wide: true })),
    mineLine, msg,
    h('div', { class: 'row-end' }, button('Cancel', { variant: 'ghost', onclick: onCancel }), save));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(msg);
    const r = P.cleanInterview({ id: x.id, round: el.round.value, local: el.at.value, tz: el.tz.value, mode: el.mode.value, withWhom: el.withWhom.value,
      feedback: el.feedback.value, outcome: el.outcome.value }, { list, existing: iv || null });
    if (!r.ok) { msg.append(note('danger', r.error)); return; }
    save.disabled = true;
    try {
      await ctx.store.saveInterview({ ...r.interview, id: iv ? iv.id : undefined, submissionId: s.id });
      toast(iv ? 'Interview saved.' : 'Interview added.'); onSaved();
    } catch (err) { msg.append(note('danger', err.message)); save.disabled = false; }
  });
  paintMine();
  return form;
}

/** The placement form (also the "Placed" prompt). start: the placement, or null for a new one (the rates start from the submission). */
export function placementForm(ctx, BP, s, placement, opts) {
  const P = BP.Placements;
  const o = opts || {};
  const p = placement || { billRate: s.billRate, payRate: s.payRate, taxTerms: s.taxTerms };
  const canPay = ctx.can('see_pay');
  const el = {
    startOn: input({ type: 'date', value: p.startOn || '', required: true }),
    endOn: input({ type: 'date', value: p.endOn || '' }),
    billRate: input({ inputmode: 'decimal', value: numText(p.billRate), placeholder: '70', class: 'rate-in' }),
    payRate: canPay ? input({ inputmode: 'decimal', value: numText(p.payRate), placeholder: '55', class: 'rate-in' }) : null,
    taxTerms: select({ '': 'Not set', C2C: 'C2C', W2: 'W2', 1099: '1099' }, p.taxTerms || ''),
    poRef: input({ value: p.poRef || '', maxlength: String(P.PO_MAX), placeholder: 'Optional' }),
    status: placement ? select({ active: 'Follow the dates (starting soon, active, ended)', ended: 'Ended early', fell_through: 'Fell through before the start' },
      ['ended', 'fell_through'].includes(placement.status) ? placement.status : 'active') : null
  };
  const marginEl = h('p', { class: 'rates-margin', 'aria-live': 'polite' });
  const read = () => {
    const out = { startOn: el.startOn.value, endOn: el.endOn.value, billRate: el.billRate.value.trim(), taxTerms: el.taxTerms.value, poRef: el.poRef.value, rateUnit: 'hr' };
    if (el.payRate) out.payRate = el.payRate.value.trim();
    if (el.status) out.status = el.status.value;
    return out;
  };
  const paint = () => {
    const r = read();
    const m = P.placementMargin({ ...r, payRate: el.payRate ? r.payRate : null });
    marginEl.className = 'rates-margin' + (m.valid && m.loss ? ' margin-loss' : '');
    marginEl.textContent = !canPay ? '' : m.valid ? (m.loss ? `You would lose ${money(Math.abs(m.margin))}/h.` : `Margin ${money(m.margin)}/h (${m.marginPct}%)${m.monthly !== null ? `, about ${money(m.monthly)} a month at 160 hours` : ''}.`) : 'Add the bill and pay rate to see the margin.';
  };
  const msg = h('div', { 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, placement ? 'Save placement' : 'Save placement');
  const heading = o.title || ((placement ? 'Placement: ' : 'Placed: ') + ctx.lk.consultantName(s.consultantId) + (s.endClient ? ', ' + s.endClient : ''));
  // o.heading === false: the host already shows a "Placement" heading (the interviews panel), so the form names itself for
  // screen readers instead of printing a second heading under the first.
  const form = h('form', { class: 'card form p3-form', novalidate: true, 'aria-label': o.heading === false ? heading : null },
    o.heading === false ? null : h('h2', null, heading),
    o.intro ? h('p', { class: 'muted' }, o.intro) : null,
    h('div', { class: 'grid' }, field('Start date', el.startOn), field('End date', el.endOn, { hint: 'Leave empty when open-ended.' }),
      field('Bill rate ($/hr)', el.billRate), el.payRate ? field('Pay rate ($/hr)', el.payRate) : null,
      field('Tax terms', el.taxTerms), field('PO or work order', el.poRef), el.status ? field('Status', el.status, { wide: true }) : null),
    marginEl, msg,
    h('div', { class: 'row-end' }, button(o.cancelText || 'Cancel', { variant: 'ghost', onclick: o.onCancel }),
      placement && canDeleteRecords(ctx.session.role, !ctx.readOnly) ? button('Remove placement', { variant: 'danger-ghost', onclick: async () => {
        if (!confirm('Remove this placement? The start date, rates and PO are removed. The submission stays.')) return;
        try { await ctx.store.deletePlacement(placement.id); toast('Placement removed.'); if (o.onDone) o.onDone(); } catch (err) { msg.append(note('danger', err.message)); }
      } }) : null, save));
  form.addEventListener('input', paint);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(msg);
    const r = P.cleanPlacement({ ...read(), payRate: el.payRate ? read().payRate : null }, { today: ctx.session.today });
    if (!r.ok) { msg.append(note('danger', r.error)); return; }
    const row = { ...r.placement, id: placement ? placement.id : undefined, submissionId: s.id, status: el.status ? el.status.value : 'active' };
    if (!el.payRate) delete row.payRate;
    save.disabled = true;
    try { await ctx.store.savePlacement(row); toast('Placement saved.'); if (o.onDone) o.onDone(); }
    catch (err) { msg.append(note('danger', err.message)); save.disabled = false; }
  });
  paint();
  return form;
}

/** The "Interviews and placement" panel of one submission (Submissions → a row's "Interviews"). */
export async function submissionPanel(ctx, BP, s, onChange, onClose) {
  const P = BP.Placements;
  const box = h('section', { class: 'card p3-panel', 'aria-label': 'Interviews and placement' });
  async function paint() {
    const [interviews, placements] = await Promise.all([ctx.store.listInterviews({ submissionId: s.id }), ctx.store.listPlacements()]);
    const placement = placements.find((p) => p.submissionId === s.id) || null;
    const formBox = h('div');
    const canDel = canDeleteRecords(ctx.session.role, !ctx.readOnly);
    const canEdit = ctx.can('edit_records');
    const rows = interviews.map((iv) => h('li', { class: 'p3-iv' },
      h('div', { class: 'p3-iv-main' },
        h('strong', null, `Round ${iv.round} · ${interviewWhen(P, iv, ctx.session.today)}`),
        h('span', { class: 'muted' }, [P.MODE_LABELS[iv.mode], iv.withWhom ? 'with ' + iv.withWhom : ''].filter(Boolean).join(' · ')),
        iv.feedback ? h('span', { class: 'p3-feedback' }, iv.feedback) : null),
      chip(P.OUTCOME_LABELS[iv.outcome] || 'Pending', OUTCOME_KIND[iv.outcome]),
      h('div', { class: 'row-end p3-iv-acts' },
        ...calendarActions(BP, iv, icsNames(ctx, s), `round ${iv.round}`),
        canEdit ? button('Edit', { variant: 'ghost', 'aria-label': `Edit round ${iv.round}`, onclick: () => { clear(formBox); formBox.append(interviewForm(ctx, BP, s, iv, interviews, done, () => clear(formBox))); } }) : null,
        canDel ? button('Remove', { variant: 'danger-ghost', 'aria-label': `Remove round ${iv.round}`, onclick: async () => {
          if (!confirm('Remove this interview? Its time, panel and notes are removed.')) return;
          try { await ctx.store.deleteInterview(iv.id); toast('Interview removed.'); done(); } catch (err) { toast(err.message); }
        } }) : null)));
    const st = placement ? P.placementStatus(placement, ctx.session.today) : '';
    clear(box);
    append(box,
      h('div', { class: 'p3-head' }, h('h2', null, 'Interviews and placement: ' + ctx.lk.consultantName(s.consultantId) + (s.endClient ? ', ' + s.endClient : '')),
        button('Close', { variant: 'ghost', onclick: onClose })),
      h('h3', null, 'Interviews'),
      rows.length ? h('ul', { class: 'p3-iv-list' }, rows) : empty('No interview booked yet.'),
      formBox,
      canEdit ? button('Add interview', { variant: 'secondary', onclick: () => { clear(formBox); formBox.append(interviewForm(ctx, BP, s, null, interviews, done, () => clear(formBox))); } }) : null,
      h('p', { class: 'hint' }, 'Calendar downloads an .ics file for Google Calendar, Outlook or Apple Calendar. Google and Outlook open your own calendar with the interview filled in, for you to save. BenchPilot does not connect to your calendar.'),
      h('h3', null, 'Placement ', placement ? chip(P.STATUS_LABELS[st], PLACEMENT_KIND[st]) : null),
      canEdit ? placementForm(ctx, BP, s, placement, { title: placement ? 'Edit the placement' : 'Add the placement', heading: false, intro: placement ? '' : 'Offer accepted? Add the start date and the rates. The consultant then counts as placed.', onDone: done, onCancel: onClose })
        : (placement ? h('p', null, `${P.STATUS_LABELS[st]} · starts ${BP.Submissions.dayLabel(placement.startOn)}`) : empty('No placement yet.')));
  }
  async function done() { await paint(); if (onChange) onChange(); }
  await paint();
  return box;
}

/** Today: interviews today and tomorrow, in the person's own zone ("Interview at 21:00 IST with ..."). mineOnly: a recruiter's own. */
export async function interviewsCard(ctx, mineOnly) {
  let BP, rows, subs;
  try {
    [BP, rows, subs] = await Promise.all([import('./bp-lib.js').then((m) => m.loadDraftLib()), ctx.store.listInterviews({}), ctx.store.listSubmissions({})]);
  } catch (e) { return ''; }
  const P = BP.Placements;
  const byId = new Map(subs.map((s) => [s.id, s]));
  const items = rows.map((iv) => ({ interview: iv, sub: byId.get(iv.submissionId) })).filter((x) => x.sub && (!mineOnly || x.sub.recruiterId === ctx.session.user.id));
  const up = P.upcomingInterviews(items, { tz: P.viewerZone(), days: 2 });
  if (!up.length) return '';   // '', not null: Element.append prints null as the word "null"
  const today = P.utcToZoned(Date.now(), P.viewerZone()).slice(0, 10);
  return card('Interviews today and tomorrow', h('ul', { class: 'p3-today' }, up.map((x) => h('li', null,
    h('div', { class: 'p3-iv-main' },
      h('strong', null, `Interview ${x.isToday ? '' : 'tomorrow '}at ${P.interviewTimeText(x.ms, P.viewerZone(), { today }).replace(/^(Today|Tomorrow), /, '')} with `,
        h('a', { href: '#consultant-' + x.sub.consultantId }, ctx.lk.consultantName(x.sub.consultantId))),
      h('span', { class: 'muted' }, [`Round ${x.interview.round}`, P.MODE_LABELS[x.interview.mode], x.sub.endClient, x.interview.withWhom ? 'panel: ' + x.interview.withWhom : '',
        mineOnly ? '' : ctx.lk.memberName(x.sub.recruiterId)].filter(Boolean).join(' · '))),
    h('div', { class: 'row-end p3-iv-acts' }, ...calendarActions(BP, x.interview, icsNames(ctx, x.sub), 'this interview'))))),
  { class: 'p3-today-card' });
}
