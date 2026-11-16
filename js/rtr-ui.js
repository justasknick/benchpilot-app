// webapp/js/rtr-ui.js - P2 (docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md, migration 0046): the "RTR and rate" section of a team
// submission, its chip and rate cell in the log, and the "Request RTR" email draft. Every rule (RTR state, margin, the rate warnings,
// the RTR email) is the extension's lib/submissions.js through loadDraftLib(), so the web app and the extension say the same thing.
// The pay rate is shown and sent only to people who may see pay (perms 'see_pay'; RLS on submission_pay keeps the same rule).

import { h, clear, nextId } from './dom.js';
import { field, input, select, button, note, chip } from './ui.js';
import { loadDraftLib } from './bp-lib.js';
import { fillRtrDraft, composeUrl } from './templates.js';

const TERMS = { '': 'Not set', C2C: 'C2C', W2: 'W2', 1099: '1099' };
const numText = (v) => (v === null || v === undefined || v === '' ? '' : String(v));

/** "Given 10 Nov · 26d left" / "Ended 2 Nov" / "Asked" / "No RTR", with a chip kind. */
export function rtrSummary(BP, s, today) {
  const S = BP.Submissions;
  const r = S.rtrOf(s, today);
  const yr = String(today || '').slice(0, 4);
  const lbl = (d) => (yr && String(d).slice(0, 4) === yr ? S.dayLabel(d).replace(/ \d{4}$/, '') : S.dayLabel(d));   // no year when it is this year
  if (r.state === 'expired') return { text: 'Ended ' + lbl(r.until), kind: 'warn', state: r.state };
  if (r.state === 'signed') {
    const left = r.daysLeft === null ? '' : r.daysLeft === 0 ? ' · ends today' : ` · ${r.daysLeft}d left`;
    return { text: 'Given ' + lbl(r.on) + left, kind: 'ok', state: r.state };
  }
  if (r.state === 'requested') return { text: 'Asked' + (r.requestedOn ? ' ' + lbl(r.requestedOn) : ''), kind: 'neutral', state: r.state };
  return { text: 'No RTR', kind: 'neutral', state: r.state };
}

/** The RTR cell of the log: the state chip, and a second chip when the rate no longer matches the RTR. */
export function rtrCell(BP, s, today) {
  const sum = rtrSummary(BP, s, today);
  const w = BP.Submissions.rateChecks({ ...s, today }).find((x) => x.code === 'rtr_rate');
  return h('div', { class: 'rtr-cell' }, chip(sum.text, sum.kind), w ? chip('Rate differs from RTR', 'warn') : null);
}

/** "$70/hr · 14% margin" (the margin only for people who may see pay), or the old free-text rate. */
export function rateCell(BP, s) {
  const S = BP.Submissions;
  const rate = S.rateText(s.billRate, s.rateUnit) || s.rate || '-';
  const m = s.payHidden ? { valid: false } : S.submissionMargin(s);
  return h('div', { class: 'rate-line' }, h('span', { class: 'mono' }, rate), m.valid ? h('span', { class: m.loss ? 'margin-loss' : 'muted' }, ` · ${m.marginPct}% margin`) : null);
}

/**
 * The form section. start: the submission (or {} for a new one) plus defaults (taxTerms from the consultant). canPay: show the pay rate.
 * Returns { el, read(), problem() } where read() gives the camelCase fields for store.saveSubmission and problem() the blocking error ('' = ok).
 */
export function ratesSection(BP, start, opts) {
  const S = BP.Submissions;
  const o = opts || {};
  const s = start || {};
  const today = o.today;
  const r = S.rtrOf(s, today);
  const yr = String(today || '').slice(0, 4);
  const lbl = (d) => (yr && String(d).slice(0, 4) === yr ? S.dayLabel(d).replace(/ \d{4}$/, '') : S.dayLabel(d));   // no year when it is this year
  const el = {
    rtrOn: input({ type: 'date', value: r.on, max: today || null }),
    rtrUntil: input({ type: 'date', value: r.until }),
    rtrRate: input({ inputmode: 'decimal', value: numText(r.rate), placeholder: 'Same as bill rate', class: 'rate-in' }),
    billRate: input({ inputmode: 'decimal', value: numText(s.billRate), placeholder: '65', class: 'rate-in' }),
    payRate: o.canPay ? input({ inputmode: 'decimal', value: numText(s.payRate), placeholder: '55', class: 'rate-in' }) : null,
    taxTerms: select(TERMS, s.taxTerms || ''),
    chain: input({ value: (Array.isArray(s.chain) ? s.chain : []).join(', '), placeholder: 'e.g. Apex Prime Vendor, Infosys', maxlength: '400' })
  };
  const marginEl = h('p', { class: 'rates-margin', 'aria-live': 'polite' });
  const warnEl = h('div', { 'aria-live': 'polite' });
  const name = o.consultantName || '';

  function read() {
    const v = (k) => (el[k] ? el[k].value.trim() : undefined);
    const out = {
      rtrOn: v('rtrOn'), rtrUntil: v('rtrUntil'), rtrRate: v('rtrRate') || (v('rtrOn') ? v('billRate') : ''), billRate: v('billRate'), rateUnit: 'hr',
      taxTerms: v('taxTerms'), chain: S.cleanChain(v('chain'))
    };
    if (el.payRate) out.payRate = v('payRate');
    return out;
  }
  function problem() {
    const p = read();
    for (const k of ['rtrRate', 'billRate', 'payRate']) if (p[k] && S.cleanRate(p[k]) === null) return 'Enter rates as numbers, for example 65.';
    return S.rateFieldsError(p);
  }
  function paint() {
    const p = read();
    clear(marginEl); clear(warnEl);
    if (el.payRate) {
      const m = S.submissionMargin(p);
      marginEl.className = 'rates-margin' + (m.valid && m.loss ? ' is-loss' : '');
      marginEl.textContent = m.valid
        ? (m.loss ? `You would lose $${Math.abs(m.margin)}/h.` : `Margin $${m.margin}/h (${m.marginPct}%)${m.monthly !== null ? `, $${m.monthly.toLocaleString('en-US')} a month at 160 hours` : ''}.`)
          + (p.taxTerms === 'W2' ? ' W2 includes the rate calculator\'s employer cost.' : '')
        : 'Add the bill and pay rate to see the margin.';
    } else marginEl.textContent = 'Pay rates and margin are visible to owners and managers.';
    for (const w of S.rateChecks({ ...p, name, today })) warnEl.append(note('warn', w.text));
    const bad = problem();
    if (bad) warnEl.append(note('danger', bad));
  }
  for (const c of Object.values(el)) if (c) { c.addEventListener('input', paint); c.addEventListener('change', paint); }
  const section = h('fieldset', { class: 'fieldset rates-section' },
    h('legend', null, 'RTR and rate'),
    h('div', { class: 'grid' },
      field('RTR given on', el.rtrOn, { hint: 'The day the consultant replied "I confirm".' }), field('RTR valid until', el.rtrUntil),
      field('RTR rate ($/hr)', el.rtrRate), field('Tax terms', el.taxTerms),
      field('Bill rate to the vendor ($/hr)', el.billRate), el.payRate ? field('Pay rate to the consultant ($/hr)', el.payRate) : null,
      field('Vendor chain', el.chain, { wide: true, hint: `Between the vendor and the end client, nearest first. Up to ${S.MAX_CHAIN}, separated by commas.` })),
    marginEl, warnEl);
  paint();
  return { el: section, read, problem, paint };
}

/**
 * The "Request RTR" panel in `host`: the RTR email (BP.Submissions.fillRtrEmail with the team signature), editable, opened as a Gmail or
 * Outlook draft addressed to the consultant. Nothing is sent from BenchPilot. onOpened() runs after a draft opens (the screen marks the
 * submission "RTR requested" when it has no RTR yet).
 */
export async function openRtrDraft(ctx, host, s, onOpened) {
  clear(host);
  const box = h('section', { class: 'card form draft-panel', 'aria-label': 'Request RTR' }, h('p', { class: 'muted' }, 'Loading...'));
  host.append(box);
  let BP, branding, sender;
  try { BP = await loadDraftLib(); [branding, sender] = await Promise.all([ctx.store.getBranding(), ctx.store.getSenderProfile()]); }
  catch (e) { clear(box).append(note('danger', 'The email could not load. Reload the page to try again.')); return; }
  const c = (ctx.lk.consultants || []).find((x) => x.id === s.consultantId) || {};
  const out = fillRtrDraft(BP, {
    consultant: { name: c.name || ctx.lk.consultantName(s.consultantId) }, role: titleOf(ctx, s), endClient: s.endClient, vendor: ctx.lk.vendorName(s.vendorCompanyId) || '',
    chain: s.chain, rate: s.billRate || s.rtrRate || s.rate, rateUnit: s.rateUnit, taxTerms: s.taxTerms, validUntil: s.rtrUntil, senderName: sender.senderName, branding, sender
  });
  const to = input({ type: 'email', value: c.email || '', autocomplete: 'off', placeholder: 'consultant@example.com' });
  const subject = input({ value: out.subject, maxlength: '300' });
  const body = h('textarea', { rows: 12 }, out.body);
  const msg = h('div', { 'aria-live': 'polite' });
  const toId = nextId('rtr-to');
  to.id = toId;
  function open(client) {
    window.open(composeUrl(BP, client, to.value, subject.value, body.value), '_blank', 'noopener,noreferrer');
    ctx.toast(`RTR request opened in ${client === 'outlook' ? 'Outlook' : 'Gmail'}. Nothing is sent until you press Send there.`);
    if (onOpened) onOpened();
  }
  clear(box).append(
    h('h2', null, 'Request RTR from ' + (c.name || 'the consultant')),
    h('p', { class: 'muted' }, 'A plain email asking the consultant to reply "I confirm". When they do, enter the day under RTR and rate.'),
    h('div', { class: 'grid' }, field('To', to, { wide: true, hint: c.email ? '' : 'Team consultants have no saved email: type it here.' }), field('Subject', subject, { wide: true }), field('Message', body, { wide: true })),
    note('info', BP.Submissions.NOT_LEGAL_ADVICE), msg,
    h('div', { class: 'row-end' },
      button('Close', { variant: 'ghost', onclick: () => clear(host) }),
      button('Open in Outlook', { variant: 'secondary', onclick: () => open('outlook') }),
      button('Open in Gmail', { variant: 'primary', onclick: () => open('gmail') })));
  to.focus();
}

function titleOf(ctx, s) {
  const r = (ctx.lk.requirements || []).find((x) => x.id === s.requirementId);
  return r ? r.title : (s.jobRef ? 'Ref ' + s.jobRef : 'the role');
}
