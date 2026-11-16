// webapp/js/draft.js - the "Draft email" panel (backlog W7): pick a team template, check the text, open it as a draft in the user's own
// Gmail or Outlook. Nothing is sent from BenchPilot. The text is filled by the extension's code (js/templates.js, bp-lib loadDraftLib), and
// a vendor contact or company marked Do not contact in the team book blocks the draft with a message.

import { h, clear, nextId } from './dom.js';
import { field, input, select, button, note } from './ui.js';
import { loadDraftLib } from './bp-lib.js';
import { TEMPLATE_KINDS, defaultTeamTemplates, leadFor, consultantFor, fillDraft, draftGate, composeUrl, orderForKind } from './templates.js';

/**
 * Open the panel in `host` (emptied first).
 * @param {object} ctx  the screen context (store, lk, session, toast)
 * @param {HTMLElement} host
 * @param {{kind:string, requirement?:object, consultantId?:string, contactId?:string, vendorId?:string, heading?:string}} o
 */
export async function openDraft(ctx, host, o) {
  clear(host);
  const box = h('section', { class: 'card form draft-panel', 'aria-label': 'Draft email' }, h('p', { class: 'muted' }, 'Loading the templates...'));
  host.append(box);
  let BP, templates, branding, sender;
  try {
    BP = await loadDraftLib();
    [templates, branding, sender] = await Promise.all([
      ctx.store.listTemplates({ defaults: defaultTeamTemplates(BP) }), ctx.store.getBranding(), ctx.store.getSenderProfile()
    ]);
  } catch (e) {
    clear(box).append(h('h2', null, 'Draft email'), note('danger', e && e.message ? e.message : 'The templates could not load. Reload the page to try again.'),
      h('div', { class: 'row-end' }, button('Close', { variant: 'ghost', onclick: () => clear(host) })));
    return;
  }
  const close = () => clear(host);
  const contacts = ctx.lk.contacts || [];
  const vendors = ctx.lk.vendors || [];
  const contact = contacts.find((c) => c.id === o.contactId) || null;
  const vendor = vendors.find((v) => v.id === (o.vendorId || (contact && contact.companyId))) || null;
  const list = orderForKind(templates, o.kind);

  const tplOptions = {};
  for (const t of list) tplOptions[t.id] = `${TEMPLATE_KINDS[t.kind] || t.kind}: ${t.name}`;
  const tplSel = select(tplOptions, list[0] ? list[0].id : '');
  const consOptions = { '': 'No consultant' };
  for (const c of (ctx.lk.consultants || []).filter((x) => (x.status !== 'inactive' && x.status !== 'placed') || x.id === o.consultantId)) consOptions[c.id] = c.name + (c.title ? ' - ' + c.title : '');
  const consSel = select(consOptions, o.consultantId || '');
  const to = input({ type: 'email', value: contact ? contact.email : '', autocomplete: 'off', placeholder: 'name@vendor.com' });
  const sigId = nextId('sig');
  const sig = h('input', { type: 'checkbox', id: sigId, checked: true });
  const profId = nextId('prof');
  const prof = h('input', { type: 'checkbox', id: profId, checked: false });
  const subject = input({ maxlength: '300' });
  const body = h('textarea', { rows: 12 });
  const msg = h('div', { 'aria-live': 'polite' });

  function fill() {
    const tpl = list.find((t) => t.id === tplSel.value);
    if (!tpl) { subject.value = ''; body.value = ''; return; }
    const cons = (ctx.lk.consultants || []).find((c) => c.id === consSel.value) || null;
    const out = fillDraft(BP, {
      template: tpl, lead: leadFor({ requirement: o.requirement, contact, vendor }), consultant: consultantFor(cons, ctx.session.today),
      senderName: sender.senderName, branding, sender, signature: sig.checked,
      // the masked profile summary (no contact details), when ticked and a consultant is chosen
      extra: prof.checked && cons ? BP.Hotlist.profile(BP.Hotlist.fromTeam(cons, ctx.session.today)).text : ''
    });
    subject.value = out.subject;
    body.value = out.body;
  }
  function gate(quiet) {
    const g = draftGate({ to: to.value, contacts, vendors, contactId: contact && String(contact.email).toLowerCase() === to.value.trim().toLowerCase() ? contact.id : '' });
    clear(msg);
    if (!g.ok && !(quiet && g.why === 'to')) msg.append(note(g.why === 'to' ? 'warn' : 'danger', g.message));
    return g;
  }
  function open(client) {
    if (!gate().ok) { to.focus(); return; }
    const url = composeUrl(BP, client, to.value, subject.value, body.value);
    window.open(url, '_blank', 'noopener,noreferrer');
    ctx.toast(`Draft opened in ${client === 'outlook' ? 'Outlook' : 'Gmail'}. Nothing is sent until you press Send there.`);
  }
  tplSel.addEventListener('change', fill);
  consSel.addEventListener('change', fill);
  sig.addEventListener('change', fill);
  prof.addEventListener('change', fill);
  to.addEventListener('change', () => gate(false));
  fill();

  clear(box).append(
    h('h2', null, o.heading || 'Draft email'),
    h('p', { class: 'hint' }, 'Opens a draft in your own Gmail or Outlook. Nothing is sent from BenchPilot: check the text and send it yourself.'),
    h('div', { class: 'grid' },
      field('Template', tplSel), field('Consultant', consSel),
      field('To', to, { hint: contact ? contact.name + (vendor ? ', ' + vendor.name : '') : 'The vendor contact\'s email' }),
      h('div', { class: 'field check' }, sig, h('label', { for: sigId }, 'Add the company signature')),
      h('div', { class: 'field check' }, prof, h('label', { for: profId }, 'Add the consultant\'s profile summary (no contact details)')),
      field('Subject', subject, { wide: true }), field('Email', body, { wide: true })),
    msg,
    h('div', { class: 'row-end' },
      button('Close', { variant: 'ghost', onclick: close }),
      button('Open in Outlook', { variant: 'secondary', onclick: () => open('outlook') }),
      button('Open in Gmail', { variant: 'primary', onclick: () => open('gmail') })));
  gate(true);         // a Do not contact contact shows at once; an empty address only when a button is pressed
  if (!list.length) msg.append(note('warn', 'Your team has no templates yet. Ask an owner or manager to add one under Team, Email templates.'));
  tplSel.focus();
}

/** A "Draft email" button that opens the panel in `host` and brings it into view. Drafting writes nothing, so it works read-only too. */
export function draftButton(ctx, host, o, label, ariaLabel) {
  return button(label || 'Draft email', {
    variant: 'secondary', 'aria-label': ariaLabel || null,
    onclick: async () => { await openDraft(ctx, host, o); if (host.scrollIntoView) host.scrollIntoView({ block: 'nearest' }); }
  });
}

/** What a submission's follow-up draft is about: its consultant, vendor contact and (when linked) requirement. */
export function followUpDraft(ctx, s) {
  const req = (ctx.lk.requirements || []).find((r) => r.id === s.requirementId) || { title: s.jobRef ? 'Ref ' + s.jobRef : '', location: '', skills: [] };
  return { kind: 'follow_up', requirement: req, consultantId: s.consultantId, contactId: s.vendorContactId, vendorId: s.vendorCompanyId, heading: 'Draft a follow-up' };
}
