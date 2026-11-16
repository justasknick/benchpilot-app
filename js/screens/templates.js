// Email templates (#templates, under Team; backlog W7, migration 0028). Owners and managers edit the team's pitch, follow-up, hotlist intro
// and check-in templates and the company signature; everyone uses them through "Draft email" and sets their own sender details.
// The placeholders and the filling are the extension's (js/templates.js); the preview below uses sample data only.

import { h, clear } from '../dom.js';
import { pageHeader, card, field, input, select, button, note, empty, chip, toast, plural } from '../ui.js';
import { loadDraftLib } from '../bp-lib.js';
import { TEMPLATE_KINDS, TEMPLATE_MAX, PLACEHOLDERS, LIMITS, defaultTeamTemplates, fillDraft, signatureBlock } from '../templates.js';

const SAMPLE = {
  lead: { recruiterName: 'Dana L.', companyName: 'Brightpath Staffing', requirement: 'Senior Java Developer', location: 'Charlotte, NC', technologies: 'Java, Spring Boot, Kafka' },
  consultant: { name: 'Ravi K.', title: 'Senior Java Developer', skills: 'Java, Spring Boot, Kafka, AWS', visa: 'H1B', rate: '$72/hr', location: 'Charlotte, NC', availability: 'Immediately', experienceYears: 10, resumeUrl: '' }
};

function textarea(value, rows) { return h('textarea', { rows: rows || 10, maxlength: String(LIMITS.body), value: value || '' }); }

export async function render(ctx) {
  let BP;
  try { BP = await loadDraftLib(); } catch (e) {
    return h('div', { class: 'stack' }, pageHeader('Email templates'), note('danger', 'The template code could not load. Reload the page to try again.'));
  }
  const canEdit = ctx.can('edit_templates');
  const [templates, branding, sender] = await Promise.all([
    ctx.store.listTemplates({ defaults: defaultTeamTemplates(BP) }), ctx.store.getBranding(), ctx.store.getSenderProfile()
  ]);
  const formBox = h('div');
  const preview = (tpl) => fillDraft(BP, { template: tpl, lead: SAMPLE.lead, consultant: SAMPLE.consultant, senderName: sender.senderName || 'Your name', branding, sender });

  // ── the company signature (owners and managers) and the member's own sender details ──
  const sigPreview = h('pre', { class: 'draft-preview' }, signatureBlock(branding, sender, { withName: true }) || 'No signature yet.');
  const coName = input({ value: branding.companyName, maxlength: String(LIMITS.companyName), disabled: !canEdit });
  const coSite = input({ inputmode: 'url', value: branding.website, maxlength: String(LIMITS.website), placeholder: 'https://yourcompany.com', disabled: !canEdit });
  const brandMsg = h('div', { 'aria-live': 'polite' });
  const brandCard = card('Company signature', h('div', { class: 'stack' },
    h('p', { class: 'hint' }, 'Plain text under every draft: your title, the company, your phone and the website. No images.'),
    h('div', { class: 'grid' }, field('Company name', coName), field('Website', coSite)),
    brandMsg,
    canEdit ? h('div', { class: 'row-end' }, button('Save the company signature', {
      variant: 'secondary', onclick: async () => {
        clear(brandMsg);
        try {
          const saved = await ctx.store.saveBranding({ companyName: coName.value, website: coSite.value });
          Object.assign(branding, saved); coSite.value = saved.website;
          sigPreview.textContent = signatureBlock(branding, sender, { withName: true }) || 'No signature yet.';
          toast('Company signature saved.');
        } catch (e) { brandMsg.append(note('danger', e.message)); }
      }
    })) : h('p', { class: 'muted' }, 'Only an owner or manager changes the company signature.')));

  const sName = input({ value: sender.senderName, maxlength: String(LIMITS.senderName) });
  const sTitle = input({ value: sender.jobTitle, maxlength: String(LIMITS.jobTitle), placeholder: 'Bench Sales Recruiter' });
  const sPhone = input({ type: 'tel', value: sender.phone, maxlength: String(LIMITS.phone) });
  const senderMsg = h('div', { 'aria-live': 'polite' });
  const senderCard = card('Your sender details', h('div', { class: 'stack' },
    h('p', { class: 'hint' }, 'Only you see these. They sign your drafts: {myName} is the name, the title and phone go in the signature.'),
    h('div', { class: 'grid' }, field('Name as you sign', sName), field('Job title', sTitle), field('Phone', sPhone)),
    senderMsg,
    h('div', { class: 'row-end' }, button('Save my details', {
      variant: 'secondary', onclick: async () => {
        clear(senderMsg);
        try {
          Object.assign(sender, await ctx.store.saveSenderProfile({ senderName: sName.value, jobTitle: sTitle.value, phone: sPhone.value }));
          sigPreview.textContent = signatureBlock(branding, sender, { withName: true }) || 'No signature yet.';
          toast('Your details are saved.');
        } catch (e) { senderMsg.append(note('danger', e.message)); }
      }
    })),
    h('h3', null, 'Your signature'), sigPreview));

  // ── the template form ──
  function openForm(existing) {
    clear(formBox);
    const t = existing || { kind: 'pitch', name: '', subject: '', body: '' };
    const kind = select(TEMPLATE_KINDS, t.kind);
    const name = input({ value: t.name, maxlength: String(LIMITS.name) });
    const subject = input({ value: t.subject, maxlength: String(LIMITS.subject) });
    const body = textarea(t.body, 12);
    const msg = h('div', { 'aria-live': 'polite' });
    const form = h('form', { class: 'card form', novalidate: true },
      h('h2', null, existing && !existing.builtIn ? 'Edit the template' : 'Add a template'),
      h('div', { class: 'grid' }, field('For', kind), field('Name', name), field('Subject', subject, { wide: true }),
        field('Email', body, { wide: true, hint: 'Use the placeholders below, in curly brackets.' })),
      msg,
      h('div', { class: 'row-end' },
        button('Cancel', { variant: 'ghost', onclick: () => clear(formBox) }),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save template')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(msg);
      try {
        await ctx.store.saveTemplate({ ...(existing || {}), kind: kind.value, name: name.value, subject: subject.value, body: body.value });
        toast('Template saved.');
        ctx.refresh();
      } catch (err) { msg.append(note('danger', err.message)); }
    });
    formBox.append(form);
    name.focus();
  }

  // ── the list, by kind ──
  const builtIn = templates.some((t) => t.builtIn);
  const groups = Object.keys(TEMPLATE_KINDS).map((k) => [k, templates.filter((t) => t.kind === k)]);
  const listCard = card('Templates', h('div', { class: 'stack' },
    builtIn ? note('info', canEdit ? 'These are the starting templates. They are saved for the team when you change one.' : 'These are the starting templates. An owner or manager can change them for the team.') : null,
    h('p', { class: 'muted' }, plural(templates.length, 'template') + (canEdit ? ` (a team keeps up to ${TEMPLATE_MAX})` : '')),
    groups.map(([k, rows]) => h('div', { class: 'stack' },
      h('h3', null, TEMPLATE_KINDS[k]),
      rows.length ? h('ul', { class: 'match-list' }, rows.map((t) => {
        const p = preview(t);
        return h('li', { class: 'match-item' },
          h('div', null, h('span', { class: 'strong' }, t.name), t.builtIn ? [' ', chip('Starting template', 'neutral')] : null),
          h('div', { class: 'muted' }, t.subject || '(no subject)'),
          h('details', null, h('summary', null, 'Preview with sample data'), h('pre', { class: 'draft-preview' }, 'Subject: ' + p.subject + '\n\n' + p.body)),
          canEdit ? h('div', { class: 'row-end' },
            button('Edit', { variant: 'secondary', 'aria-label': 'Edit ' + t.name, onclick: () => openForm(t) }),
            t.builtIn ? null : button('Delete', {
              variant: 'ghost', 'aria-label': 'Delete ' + t.name, onclick: async () => {
                if (!confirm(`Delete the template "${t.name}"?`)) return;
                try { await ctx.store.deleteTemplate(t.id); toast('Template deleted.'); ctx.refresh(); } catch (e) { toast(e.message); }
              }
            })) : null);
      })) : empty('None yet.')))));

  const help = card('Placeholders', h('div', { class: 'stack' },
    h('p', { class: 'hint' }, 'The same as in the extension. A placeholder with no value is left out, and a line like "Visa:" with nothing after it is dropped.'),
    h('ul', { class: 'placeholder-list' }, PLACEHOLDERS.map(([k, label]) => h('li', null, h('code', null, '{' + k + '}'), ' ', label)))));

  return h('div', { class: 'stack' },
    pageHeader('Email templates', 'Drafts open in your own Gmail or Outlook. Nothing is sent from BenchPilot.', [
      h('a', { class: 'btn btn-ghost', href: '#team' }, 'Back to Team'),
      canEdit ? button('Add a template', { variant: 'primary', disabled: templates.length >= TEMPLATE_MAX, onclick: () => openForm(null) }) : null]),
    ctx.readOnly ? note('warn', 'This workspace is read-only until the plan is paid. Templates can still be used.') : null,
    formBox,
    h('div', { class: 'cols cols-wide-left' }, h('div', { class: 'stack' }, listCard, help), h('div', { class: 'stack' }, brandCard, senderCard)));
}
