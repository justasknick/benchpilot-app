// webapp/js/consent-ui.js - staffing P5 on the consultant and vendor pages (docs/plans/STAFFING_FIRM_COVERAGE_2026-11-14.md):
//   consentCard(ctx, c, opts)        "Consent and data": the consent record (two clicks: Record consent, Save), the data-notice email draft
//                                    (the extension's own BP.Consent.noticeEmail through bp-lib.js), Export this consultant (JSON, CSV) and,
//                                    for owners and managers, Erase this consultant (the name is typed first).
//   contactLogCard(ctx, o)           "Contact log": notes a person types after a call, chat or meeting. Nothing is read from WhatsApp, the
//                                    phone or any other app, and nothing is sent.
// Both talk only to the store (js/store.js), so the demo and the live workspace behave the same.

import { h, clear } from './dom.js';
import { card, chip, field, input, select, note, empty, button, toast, plural } from './ui.js';
import { fmtLong } from './dates.js';
import { loadConsentLib } from './bp-lib.js';
import {
  CONSENT_SOURCES, CONSENT_SOURCE_LABELS, CONSENT_NOTE_MAX, CONTACT_KINDS, CONTACT_KIND_LABELS, CONTACT_NOTE_MAX, NOT_LEGAL_ADVICE,
  hasConsent, needsConsent, consultantCsv, exportFileName, eraseExplain, nameSnippet, NAME_REMOVED
} from './consent.js';

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch (e) { toast('Could not copy. Select the text and copy it.'); }
}

/** "14 Nov 2026, 3:30 pm" in the browser's own time zone. */
export function fmtWhen(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  try {
    return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  } catch (e) { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); }
}
/** The value of a datetime-local box for a time (local clock), e.g. "2026-11-14T15:30". */
export function localInputValue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A mailto: link with the subject and body (no address: the recruiter adds the consultant's own). */
export function mailtoLink(mail) {
  return 'mailto:?subject=' + encodeURIComponent(mail.subject) + '&body=' + encodeURIComponent(mail.body);
}

// ── Consent and data ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * @param ctx  the screen context
 * @param c    the consultant
 * @param {{submissions?:number, loadLib?:Function, onChanged?:Function, onErased?:Function}} [opts]
 */
export function consentCard(ctx, c, opts) {
  const o = opts || {};
  const loadLib = o.loadLib || loadConsentLib;
  const canEdit = ctx.can('edit_records');
  const body = h('div', { class: 'stack consent' });
  const msg = h('div', { 'aria-live': 'polite' });
  const view = { form: false, notice: false, erase: false };

  async function saveConsent(k) {
    clear(msg);
    try {
      await ctx.store.saveConsultant({ ...c, consentOn: k.consentOn, consentSource: k.consentSource, consentNote: k.consentNote });
      Object.assign(c, k);
      view.form = false;
      toast(k.consentOn ? 'Consent recorded.' : 'Consent record cleared.');
      draw();
      if (o.onChanged) o.onChanged();
    } catch (err) { msg.append(note('danger', err.message)); }
  }

  function consentForm() {
    const el = {
      on: input({ type: 'date', value: c.consentOn || ctx.session.today, required: true, max: ctx.session.today }),
      source: select(Object.fromEntries(CONSENT_SOURCES.map((s) => [s, CONSENT_SOURCE_LABELS[s]])), c.consentSource || 'email_reply'),
      note: input({ value: c.consentNote || '', maxlength: String(CONSENT_NOTE_MAX), placeholder: 'e.g. Replied "I agree" to the notice' })
    };
    const form = h('form', { class: 'form consent-form', novalidate: true },
      h('div', { class: 'grid' },
        field('Consent given on', el.on), field('How', el.source),
        field('Note', el.note, { wide: true, hint: 'Optional, up to ' + CONSENT_NOTE_MAX + ' characters. Keep the reply or the signed form in your own mail or files.' })),
      h('div', { class: 'row-end' },
        button('Cancel', { variant: 'ghost', onclick: () => { view.form = false; draw(); } }),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!el.on.value) { clear(msg); msg.append(note('danger', 'Pick the date the consultant agreed.')); el.on.focus(); return; }
      saveConsent({ consentOn: el.on.value, consentSource: el.source.value, consentNote: el.note.value.trim() });
    });
    return form;
  }

  function status() {
    if (hasConsent(c)) {
      return h('div', { class: 'consent-status' },
        chip('Consent recorded', 'ok'),
        h('span', null, fmtLong(c.consentOn) + (CONSENT_SOURCE_LABELS[c.consentSource] ? ' · ' + CONSENT_SOURCE_LABELS[c.consentSource] : '')),
        c.consentNote ? h('p', { class: 'muted consent-note' }, c.consentNote) : null);
    }
    return h('div', { class: 'consent-status' },
      chip('No consent recorded', needsConsent(c) ? 'warn' : 'neutral'),
      h('span', { class: 'muted' }, needsConsent(c) ? 'Being marketed. Send the data notice and record the reply.' : 'Record it before you market this consultant.'));
  }

  // The data-notice email: the extension's own text (BP.Consent.noticeEmail), filled with this consultant, the firm and the sender.
  function noticePanel() {
    const box = h('div', { class: 'stack-tight consent-notice' });
    const contact = input({ placeholder: 'e.g. Meera N., privacy@yourfirm.com', maxlength: '200' });
    const keep = input({ placeholder: '12 months', maxlength: '80' });
    const subject = input({ readOnly: true, 'aria-label': 'Subject' });
    const text = h('textarea', { rows: '12', readOnly: true, 'aria-label': 'Email text' });
    const mailLink = h('a', { class: 'btn btn-secondary', href: '#', target: '_blank', rel: 'noopener' }, 'Open in email');
    let lib = null, firm = '';
    const fill = () => {
      if (!lib) return;
      const mail = lib.noticeEmail({ consultantName: c.name, firmName: firm, senderName: ctx.session.user && ctx.session.user.name, grievanceContact: contact.value, retention: keep.value });
      subject.value = mail.subject; text.value = mail.body; mailLink.href = mailtoLink(mail);
    };
    contact.addEventListener('input', fill); keep.addEventListener('input', fill);
    box.append(h('p', { class: 'muted' }, 'Loading the notice ...'));
    (async () => {
      try {
        const [L, brand] = await Promise.all([loadLib(), ctx.store.getBranding().catch(() => null)]);
        lib = L;
        firm = (brand && brand.companyName) || (ctx.team && ctx.team.name) || '';
      } catch (e) { clear(box); box.append(note('danger', 'The notice could not load. Reload the page and try again.')); return; }
      clear(box);
      box.append(
        h('div', { class: 'form' }, h('div', { class: 'grid' },
          field('Who handles data requests', contact, { hint: 'A name and email at your firm.' }),
          field('Keep data for', keep, { hint: 'After the last submission or placement.' }))),
        field('Subject', subject), text,
        note('info', NOT_LEGAL_ADVICE),
        h('div', { class: 'row-end' },
          button('Close', { variant: 'ghost', onclick: () => { view.notice = false; draw(); } }),
          mailLink,
          button('Copy email', { variant: 'primary', onclick: () => copy(subject.value + '\n\n' + text.value, 'Copied the notice. Paste it into your email.') })));
      fill();
    })();
    return box;
  }

  async function exportAs(kind) {
    clear(msg);
    try {
      const exp = await ctx.store.exportConsultant(c.id);
      if (kind === 'json') download(exportFileName(c.name, ctx.session.today, 'json'), JSON.stringify(exp, null, 2), 'application/json');
      else download(exportFileName(c.name, ctx.session.today, 'csv'), consultantCsv(exp), 'text/csv;charset=utf-8;');
      toast('Downloaded.');
    } catch (err) { msg.append(note('danger', err.message)); }
  }

  function erasePanel() {
    const ex = eraseExplain(c.name, o.submissions);
    const want = String(c.name || '').trim().toLowerCase();
    const typed = input({ autocomplete: 'off', placeholder: c.name, 'aria-label': ex.confirm });
    const go = h('button', { type: 'submit', class: 'btn btn-danger', disabled: true }, 'Erase for everyone');
    const out = h('div', { 'aria-live': 'polite' });
    typed.addEventListener('input', () => { go.disabled = typed.value.trim().toLowerCase() !== want; });
    // 0053: where else the full name appears (contact notes of vendor contacts and other consultants, vendor notes), each with a ticked
    // box; only the ticked ones get NAME_REMOVED in place of the name. Nothing is matched on a first name alone.
    const found = h('div', { class: 'erase-found', 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'Looking for their name in other notes…'));
    let matches = [];
    const boxes = new Map();
    ctx.store.consultantNameMatches(c.id).then((list) => {
      matches = list;
      clear(found);
      if (!list.length) { found.append(h('p', { class: 'muted' }, 'Their full name does not appear in any other note.')); return; }
      const label = (m) => (m.kind === 'vendor_note' ? 'Vendor notes of ' + (m.entityName || 'a vendor')
        : 'Contact log of ' + (m.entityName || (m.entity === 'consultant' ? 'a consultant' : 'a vendor contact'))) + (m.at ? ', ' + fmtLong(m.at.slice(0, 10)) : '');
      found.append(h('fieldset', { class: 'erase-matches' },
        h('legend', { class: 'strong' }, `Their name also appears in ${plural(list.length, 'other note')}`),
        h('p', { class: 'muted' }, `Ticked notes get "${NAME_REMOVED}" in place of the name when you erase. Untick any you want to keep as it is.`),
        list.map((m) => {
          const box = h('input', { type: 'checkbox', checked: true, 'aria-describedby': 'em-' + m.id });
          boxes.set(m.kind + ':' + m.id, box);
          return h('label', { class: 'erase-match' }, box,
            h('span', null, h('span', { class: 'strong' }, label(m)), h('span', { class: 'muted', id: 'em-' + m.id }, nameSnippet(m.text, c.name, 60))));
        })));
    }).catch((err) => { clear(found); found.append(note('warn', 'Could not look for their name in other notes: ' + err.message + ' The erase itself still works.')); });
    const form = h('form', { class: 'form erase-box', novalidate: true, role: 'alertdialog', 'aria-label': 'Erase ' + c.name },
      h('h3', null, 'Erase ' + c.name + '?'),
      h('p', null, 'Use this when the consultant asks you to delete their data. It cannot be undone. Export a copy first if they asked for one.'),
      h('div', { class: 'erase-cols' },
        h('div', null, h('p', { class: 'strong' }, 'What goes'), h('ul', null, ex.goes.map((t) => h('li', null, t)))),
        h('div', null, h('p', { class: 'strong' }, 'What stays'), h('ul', null, ex.stays.map((t) => h('li', null, t))))),
      found,
      field(ex.confirm, typed), out,
      h('div', { class: 'row-end' }, button('Cancel', { variant: 'ghost', onclick: () => { view.erase = false; draw(); } }), go));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(out);
      if (typed.value.trim().toLowerCase() !== want) return;
      go.disabled = true;
      try {
        const scrub = matches.filter((m) => { const b = boxes.get(m.kind + ':' + m.id); return b && b.checked; }).map((m) => ({ kind: m.kind, id: m.id }));
        const r = await ctx.store.eraseConsultant(c.id, typed.value, scrub);
        toast((r.keptRow ? `Erased. ${plural(r.submissions, 'submission')} kept for the counts, without the name.` : 'Erased. Nothing about them is left.')
          + (r.scrubbed ? ` Their name was taken out of ${plural(r.scrubbed, 'other note')}.` : ''));
        if (o.onErased) o.onErased(r);
      } catch (err) { out.append(note('danger', err.message)); go.disabled = false; }
    });
    setTimeout(() => typed.focus(), 0);
    return form;
  }

  function draw() {
    clear(body);
    const canExport = ctx.can('export');
    const canErase = ctx.can('erase_consultant');
    body.append(
      h('div', { class: 'row-split consent-head' }, status(),
        canEdit && !view.form ? h('div', { class: 'actions' },
          hasConsent(c)
            ? [button('Edit', { variant: 'ghost', onclick: () => { view.form = true; draw(); } }),
              button('Clear', { variant: 'ghost', onclick: () => saveConsent({ consentOn: '', consentSource: '', consentNote: '' }) })]
            : button('Record consent', { variant: 'primary', onclick: () => { view.form = true; draw(); } })) : null),
      view.form ? consentForm() : '',
      msg,
      h('div', { class: 'consent-tools' },
        h('h3', null, 'Data notice and rights'),
        h('p', { class: 'muted' }, 'Draft the notice that tells the consultant what your firm keeps and why. Export or erase their data when they ask.'),
        h('div', { class: 'actions' },
          button(view.notice ? 'Hide notice email' : 'Draft data notice email', { variant: 'secondary', 'aria-expanded': String(view.notice), onclick: () => { view.notice = !view.notice; draw(); } }),
          canExport ? button('Export JSON', { variant: 'secondary', title: 'Everything kept about this consultant', onclick: () => exportAs('json') }) : null,
          canExport ? button('Export CSV', { variant: 'secondary', onclick: () => exportAs('csv') }) : null,
          canErase && !view.erase ? button('Erase this consultant', { variant: 'danger-ghost', onclick: () => { view.erase = true; draw(); } }) : null),
        canExport ? null : h('p', { class: 'hint' }, 'Your workspace owner has turned off exports for your role.')),
      view.notice ? noticePanel() : '',
      view.erase && canErase ? erasePanel() : '');
  }
  draw();
  return card('Consent and data', body, { class: 'consent-card' });
}

// ── Contact log ────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * @param ctx
 * @param {{entity:'consultant'|'vendor_contact', entityId:string, name:string, title?:string, onClose?:Function, now?:()=>number}} o
 */
export function contactLogCard(ctx, o) {
  const now = o.now || (() => Date.now());
  const me = ctx.session.user && ctx.session.user.id;
  const lead = ctx.session.role === 'owner' || ctx.session.role === 'manager';
  const canWrite = ctx.can('edit_records');
  const list = h('div', { class: 'cl-list' });
  const msg = h('div', { 'aria-live': 'polite' });

  async function drawList() {
    let notes = [];
    try { notes = await ctx.store.listContactNotes(o.entity, o.entityId); } catch (err) { clear(list); list.append(note('danger', err.message || 'The contact log could not load.')); return; }
    clear(list);
    if (!notes.length) { list.append(empty('Nothing logged yet.')); return; }
    list.append(h('ol', { class: 'cl-notes', 'aria-label': 'Contact log for ' + o.name }, notes.map((n) => h('li', { class: 'cl-note' },
      h('div', { class: 'cl-meta' },
        chip(CONTACT_KIND_LABELS[n.kind] || 'Note', n.kind === 'call' ? 'accent' : n.kind === 'meeting' ? 'ok' : 'neutral'),
        h('time', { datetime: n.at }, fmtWhen(n.at)),
        h('span', { class: 'muted' }, 'by ' + ctx.lk.memberName(n.createdBy)),
        canWrite && (n.createdBy === me || lead) ? button('Delete', {
          variant: 'ghost', class: 'cl-del', 'aria-label': 'Delete the note from ' + fmtWhen(n.at),
          onclick: async (e) => {
            if (!confirm('Delete this note? It is removed for the whole team.')) return;
            e.currentTarget.disabled = true;
            try { await ctx.store.deleteContactNote(n.id); toast('Note deleted.'); drawList(); } catch (err) { clear(msg); msg.append(note('danger', err.message)); }
          }
        }) : null),
      h('p', { class: 'cl-body' }, n.body)))));
  }

  function form() {
    const el = {
      kind: select(Object.fromEntries(CONTACT_KINDS.map((k) => [k, CONTACT_KIND_LABELS[k]])), 'call'),
      at: input({ type: 'datetime-local', value: localInputValue(now()) }),
      body: h('textarea', { rows: '3', maxlength: String(CONTACT_NOTE_MAX), placeholder: 'What was said, and what happens next' })
    };
    const count = h('span', { class: 'hint cl-count' }, '0 / ' + CONTACT_NOTE_MAX);
    el.body.addEventListener('input', () => { count.textContent = el.body.value.length + ' / ' + CONTACT_NOTE_MAX; });
    const f = h('form', { class: 'form cl-form', novalidate: true },
      h('div', { class: 'grid' }, field('Kind', el.kind), field('When', el.at), field('Note', el.body, { wide: true })),
      h('div', { class: 'row-split' }, count, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save')));
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(msg);
      const t = Date.parse(el.at.value);
      try {
        await ctx.store.addContactNote({ entity: o.entity, entityId: o.entityId, kind: el.kind.value, at: Number.isFinite(t) ? new Date(t).toISOString() : undefined, body: el.body.value });
        el.body.value = ''; count.textContent = '0 / ' + CONTACT_NOTE_MAX; el.at.value = localInputValue(now());
        toast('Logged.');
        drawList();
      } catch (err) { msg.append(note('danger', err.message)); el.body.focus(); }
    });
    return f;
  }

  drawList();
  return card(o.title || 'Contact log', h('div', { class: 'stack-tight cl' },
    h('p', { class: 'hint' }, 'Typed by your team after a call, chat or meeting. Nothing is read from WhatsApp, your phone or any other app, and nothing is sent.'),
    canWrite ? h('details', { class: 'cl-add', open: true }, h('summary', null, 'Log a call'), form()) : null,
    msg, list,
    o.onClose ? h('div', { class: 'row-end' }, button('Close', { variant: 'ghost', onclick: o.onClose })) : null), { class: 'cl-card' });
}
