// Vendor book: companies with tiers, linking to contacts. Search by name, domain or email.
// A recruiter can add and edit vendors but cannot set a tier or mark Avoid (spec section 3).
// Team, Agency and the pilot also see heat (Hot / Active / Cold, the extension's own BP.VendorBook logic via bp-lib) and response stats
// (docs/specs/TEAM_P2_SPEC.md); Starter sees an upgrade note. Both are computed in the browser and never stored.
// Smart lists (backlog W5, same plans as heat): the extension's four built-in lists plus the team's saved lists (migration 0027; owners and
// managers save and delete, everyone sees), each counted and filtered by the extension's own BP.VendorBook.evaluateList (vendor-lists.js).
// Email check (backlog W6) under "Add a contact": the extension's typo check (BP.EmailCheck) as you type, then the server's mail-server
// (MX) check when you leave the box. Both are warnings only; the contact saves as typed.
// Agreements (staffing P6, migration 0050): MSA and NDA status with signed and end dates, net payment terms and a payment note per company,
// in an "Agreements" card (owners and managers edit, recruiters read), an Agreement column and filter (No signed MSA / Ends within 30 days /
// Agreement ended). The rules are the extension's own BP.Agreements (lib/vendor-agreements.js). Status and dates only, never files.

import { h, clear, append } from '../dom.js';
import { pageHeader, card, table, chip, field, input, select, note, empty, button, toast, TIER_LABELS, TIER_KIND, SOURCE_LABELS, plural, lockNote, emptyState, sampleDataButton } from '../ui.js';
import { fmtShort, todayISO } from '../dates.js';
import { hasFeature, FEATURE_FROM } from '../plan-gate.js';
import { loadHeatLib, loadEmailCheckLib } from '../bp-lib.js';
import { agreementsOrNull } from '../agreements.js';
import { vendorHeat, responseStats } from '../team-p2.js';
import { BUILT_IN_LISTS, listState, evaluate, rulesFromForm } from '../vendor-lists.js';
import { deleteButton } from '../delete-ui.js';
import { contactLogCard } from '../consent-ui.js';

const HEAT_KIND = { hot: 'danger', active: 'ok', cold: 'neutral' };
const rate = (n) => (n == null ? '-' : n + '%');

/** Heat per company and response stats over 30 and 90 days, or { allowed:false } / { error } . Never throws. */
export async function heatData(ctx) {
  if (!hasFeature(ctx.team && ctx.team.billing, 'vendorHeat')) return { allowed: false };
  try {
    const [VB, requirements, submissions] = await Promise.all([loadHeatLib(), ctx.store.listRequirements(), ctx.store.listSubmissions({})]);
    const now = Date.now();
    return {
      allowed: true, VB, now,
      heat: vendorHeat(VB, { vendors: ctx.lk.vendors, requirements, submissions }, now),
      lists: listState({ vendors: ctx.lk.vendors, contacts: ctx.lk.contacts, requirements, submissions }),
      s30: responseStats(submissions, ctx.session.today, 30), s90: responseStats(submissions, ctx.session.today, 90)
    };
  } catch (e) { return { allowed: true, error: e.message || 'Could not work out the vendor heat.' }; }
}

function heatChip(hd, id) {
  const v = hd.heat && hd.heat.get(id);
  return v && v.heat ? chip(hd.VB.HEAT_LABELS[v.heat], HEAT_KIND[v.heat]) : h('span', { class: 'muted' }, '-');
}

function upgradeNote(ctx) {
  return lockNote(ctx, { plan: true, badge: FEATURE_FROM.vendorHeat,
    text: `Vendor heat, smart lists and response stats come with ${FEATURE_FROM.vendorHeat} and ${FEATURE_FROM.desks}.` });
}

// ── Email check (W6): a warning under the email box, never a block ──
const MX_WORDS = {
  no_mx: 'lists no mail server, so email to it may bounce. Check the address with the recruiter.',
  no_mail: 'says it does not take email. Check the address with the recruiter.',
  no_domain: 'does not exist. Check the spelling.'
};
/** The words for an email-check answer, or '' when there is nothing to say (ok, unknown, the demo). */
export function mxWarning(res) {
  const r = res || {};
  return MX_WORDS[r.status] ? `${r.domain || 'This domain'} ${MX_WORDS[r.status]}` : '';
}

/** Wires the email check to an email input; the warning shows in `box`. Typos as you type; the mail server once you leave the box. */
export function wireEmailCheck(ctx, emailInput, box) {
  let lastAsked = '';
  const show = (text) => { clear(box); if (text) box.append(note('warn', text)); };
  const typo = async () => {
    const EC = await loadEmailCheckLib();
    const res = EC ? EC.check(emailInput.value) : { warnings: [] };
    show(res.warnings.map((w) => w.text).join(' '));
    return res;
  };
  emailInput.addEventListener('input', () => { typo(); });
  emailInput.addEventListener('blur', async () => {
    const res = await typo();
    const email = emailInput.value.trim().toLowerCase();
    if (!email || res.warnings.length || !res.domain || res.domain === lastAsked) return;
    lastAsked = res.domain;
    try {
      const mx = await ctx.store.checkEmailDomain(email);
      if (emailInput.value.trim().toLowerCase() === email) show(mxWarning(mx));
    } catch (e) { /* a failed check says nothing: it is only a warning */ }
  });
}

// ── Smart lists (W5) ──
const HEAT_CHOICES = { '': 'Any heat', hot: 'Hot', active: 'Active', cold: 'Cold' };
const REPLIED_CHOICES = { '': 'Any time', r30: 'In 30 days', r90: 'In 90 days' };
const NOT_SEEN_CHOICES = { '': 'Any time', n30: '30+ days', n60: '60+ days', n90: '90+ days' };
const PHONE_CHOICES = { '': 'Any', has: 'Has a phone', missing: 'No phone' };

function listForm(ctx, hd, saved, onDone) {
  const fams = (globalThis.BP && globalThis.BP.ROLE_FAMILIES) || [];
  const families = { '': 'Any role', ...Object.fromEntries(fams.map((x) => [x, x])) };
  const el = {
    name: input({ maxlength: 40, placeholder: 'e.g. Java vendors who replied' }),
    heat: select(HEAT_CHOICES, ''), family: select(families, ''), replied: select(REPLIED_CHOICES, ''),
    notSeen: select(NOT_SEEN_CHOICES, ''), phone: select(PHONE_CHOICES, '')
  };
  const msg = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'card form', novalidate: true },
    h('h2', null, 'Save a list for the team'),
    h('p', { class: 'hint' }, 'A list is a rule, not a fixed set of companies: it stays up to date by itself. Everyone in the team sees it.'),
    h('div', { class: 'grid' },
      field('List name', el.name), field('Heat', el.heat), field('Hires', el.family, { hint: 'From their requirements in the last 90 days' }),
      field('Replied', el.replied), field('No requirement for', el.notSeen), field('Phone', el.phone, { hint: 'Any contact at the company' })),
    msg,
    h('div', { class: 'row-end' },
      button('Cancel', { variant: 'ghost', onclick: () => onDone(null) }),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save list')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    const rules = rulesFromForm(hd.VB, {
      heat: el.heat.value, family: el.family.value, replied: el.replied.value.slice(1), notSeen: el.notSeen.value.slice(1), phone: el.phone.value
    });
    if (!Object.keys(rules).length) { msg.append(note('warn', 'Choose at least one rule for the list.')); return; }
    try {
      const list = await ctx.store.saveSmartList({ name: el.name.value, rules });
      toast('List saved.');
      onDone(list);
    } catch (err) { msg.append(note('danger', err.message)); el.name.focus(); }
  });
  return form;
}

/** The rule in words, from the extension's own rule (BP.VendorBook.heatRuleText: Hot is relative since the UX audit A8). */
export function heatRule(VB) {
  return VB.heatRuleText() + ' Rates use each submission\'s current stage.';
}

function heatCard(hd, v) {
  if (!hd.allowed) return card('Heat and response', upgradeNote());
  if (hd.error) return card('Heat and response', note('warn', hd.error));
  const st = hd.heat.get(v.id) || {};
  const rows = [['Last 30 days', hd.s30.get(v.id)], ['Last 90 days', hd.s90.get(v.id)]].map(([label, x]) => ({ label, ...(x || { sent: 0 }) }));
  const tags = hd.VB.tagsText(st.tags, st.more);
  return card('Heat and response', h('div', { class: 'stack' },
    h('p', null, heatChip(hd, v.id), ' ',
      h('span', { class: 'muted' }, `${st.posts30 || 0} requirement${st.posts30 === 1 ? '' : 's'} in 30 days, ${st.posts60 || 0} in 60 days`),
      tags ? [h('br'), h('span', { class: 'muted' }, 'Roles: ' + tags)] : null),
    table([
      { label: 'Window', cell: (r) => r.label },
      { label: 'Submissions', class: 'num', cell: (r) => String(r.sent) },
      { label: 'Replied', class: 'num', cell: (r) => rate(r.replyRate) },
      { label: 'Interview', class: 'num', cell: (r) => rate(r.interviewRate) },
      { label: 'Placed', class: 'num', cell: (r) => rate(r.placementRate) }
    ], rows, { caption: 'Submissions through ' + v.name }),
    h('p', { class: 'hint' }, heatRule(hd.VB))));
}

// ── Agreements (P6) ──

/** The agreement cell / chip: the summary, as a warning when an MSA or NDA ends within 30 days or has ended. */
export function agreementChip(A, v, today) {
  if (!A || !A.has(v)) return h('span', { class: 'muted' }, '-');
  const due = A.reminders([v], today).length > 0;
  return h('span', { class: due ? 'agree-cell agree-due' : 'agree-cell' }, A.summary(v, today));
}

function agreementView(A, v, today) {
  const a = A.clean(v);
  const row = (kind, K) => {
    const st = A.docState(a, kind, today);
    const kindOf = st.status === 'signed' ? (st.soon ? 'warn' : 'ok') : st.status === 'expired' ? 'danger' : st.status === 'sent' ? 'accent' : 'neutral';
    return h('div', { class: 'agree-row' },
      h('span', { class: 'agree-k' }, K), chip(st.label, kindOf),
      h('span', { class: 'muted' }, [st.signedOn ? 'Signed ' + A.fmtDate(st.signedOn) : '', st.until ? (st.ended || st.status === 'expired' ? 'ended ' : 'ends ') + A.fmtDate(st.until) : (st.status === 'signed' ? 'no end date' : '')].filter(Boolean).join(', ')));
  };
  const due = A.reminders([{ ...a, id: v.id, name: v.name }], today);
  return h('div', { class: 'stack agree-view' },
    row('msa', 'MSA'), row('nda', 'NDA'),
    h('div', { class: 'agree-row' }, h('span', { class: 'agree-k' }, 'Payment'), a.netTerms ? chip(A.termsLabel(a.netTerms), 'neutral') : h('span', { class: 'muted' }, 'Terms not set'),
      a.paymentNote ? h('span', { class: 'muted' }, a.paymentNote) : null),
    due.length ? note('warn', due.map((r) => A.reminderText(r)).join('. ') + '.') : null);
}

function agreementForm(ctx, A, v, onSaved) {
  const a = A.clean(v);
  const statuses = Object.fromEntries(A.STATUSES.map((k) => [k, A.STATUS_LABELS[k]]));
  const el = {
    msaStatus: select(statuses, a.msaStatus), msaSignedOn: input({ type: 'date', value: a.msaSignedOn }), msaUntil: input({ type: 'date', value: a.msaUntil }),
    ndaStatus: select(statuses, a.ndaStatus), ndaSignedOn: input({ type: 'date', value: a.ndaSignedOn }), ndaUntil: input({ type: 'date', value: a.ndaUntil }),
    netTerms: select({ '': 'Not set', ...Object.fromEntries(A.NET_TERMS.map((n) => [String(n), 'Net ' + n])) }, a.netTerms ? String(a.netTerms) : ''),
    paymentNote: input({ value: a.paymentNote, maxlength: A.NOTE_MAX, placeholder: 'e.g. Invoice by the 5th, pays by bank transfer' })
  };
  const msg = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'form agree-form', novalidate: true },
    h('div', { class: 'grid agree-grid' },
      field('MSA', el.msaStatus), field('MSA signed on', el.msaSignedOn), field('MSA ends on', el.msaUntil, { hint: 'Empty = no end date' }),
      field('NDA', el.ndaStatus), field('NDA signed on', el.ndaSignedOn), field('NDA ends on', el.ndaUntil),
      field('Payment terms', el.netTerms), field('Payment note', el.paymentNote, { wide: true })),
    msg,
    h('div', { class: 'row-end' }, h('button', { type: 'submit', class: 'btn btn-secondary' }, 'Save agreements')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    try {
      const out = Object.fromEntries(Object.entries(el).map(([k, c]) => [k, c.value]));
      await ctx.store.saveVendorAgreement(v.id, out);
      toast('Agreements saved.');
      onSaved();
    } catch (err) { msg.append(note('danger', err.message)); }
  });
  return form;
}

function agreementCard(ctx, A, v) {
  if (!A) return card('Agreements', note('warn', 'The agreement details could not be loaded. Reload the page to try again.'));
  const today = todayISO();
  const canEdit = ctx.can('edit_agreements');
  const box = h('div', { class: 'stack' });
  const draw = (editing) => {
    clear(box);
    box.append(agreementView(A, v, today));
    if (editing) box.append(agreementForm(ctx, A, v, () => ctx.refresh()));
    else if (canEdit) box.append(h('div', { class: 'row-end' }, button('Edit agreements', { variant: 'ghost', onclick: () => { draw(true); box.querySelector('select').focus(); } })));
    else box.append(h('p', { class: 'hint' }, 'Only owners and managers change agreements.'));
  };
  draw(false);
  return card('Agreements', h('div', { class: 'stack' }, h('p', { class: 'hint' }, 'Status and dates only. BenchPilot does not keep the agreement files. Not legal advice.'), box));
}

/** The live server allows a vendor with no tier yet; the demo store always has one. */
function tierOptions(ctx) {
  const { unrated, ...rated } = TIER_LABELS;
  return ctx.store.capabilities.unratedTier ? { ...rated, unrated } : rated;
}

function companyForm(ctx, v, handlers) {
  const canTier = ctx.can('set_vendor_tier');
  const el = {
    name: input({ value: v ? v.name : '' }),
    domain: input({ value: v ? v.domain : '', placeholder: 'company.com' }),
    tier: select(tierOptions(ctx), v ? v.tier : (ctx.store.capabilities.unratedTier ? 'unrated' : 'tier2'), { disabled: !canTier }),
    avoidReason: input({ value: v ? v.avoidReason : '' }),
    notes: h('textarea', { rows: 3 }, v ? v.notes : ''),
    dnc: h('input', { type: 'checkbox', checked: v ? v.doNotContact : false, id: 'dnc-' + (v ? v.id : 'new') })
  };
  const msg = h('div', { 'aria-live': 'polite' });
  const avoidField = field('Why avoid', el.avoidReason, { hint: 'Shown to the whole team' });
  const syncAvoid = () => { avoidField.hidden = el.tier.value !== 'avoid'; };
  el.tier.addEventListener('change', syncAvoid);
  syncAvoid();
  const form = h('form', { class: 'card form', novalidate: true },
    h('h2', null, v ? 'Edit company' : 'Add company'),
    h('div', { class: 'grid' },
      field('Company name', el.name), field('Domain', el.domain, { hint: 'Used to merge duplicates' }),
      field('Tier', el.tier, { hint: canTier ? null : 'Only owners and managers set the tier.' }), avoidField,
      field('Notes', el.notes, { wide: true }),
      h('div', { class: 'field check' }, el.dnc, h('label', { for: el.dnc.id }, 'Do not contact'))),
    msg,
    h('div', { class: 'row-end' },
      button('Cancel', { variant: 'ghost', onclick: handlers.onCancel }),
      h('button', { type: 'submit', class: 'btn btn-primary' }, v ? 'Save changes' : 'Add company')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    try {
      const saved = await ctx.store.saveVendor({ ...(v ? { id: v.id } : {}), name: el.name.value, domain: el.domain.value, tier: el.tier.value, avoidReason: el.avoidReason.value, notes: el.notes.value, doNotContact: el.dnc.checked });
      toast('Saved.');
      handlers.onSaved(saved);
    } catch (err) { msg.append(note('danger', err.message)); el.name.focus(); }
  });
  return form;
}

function contactForm(ctx, company, onSaved) {
  const el = { name: input({}), email: input({ type: 'email' }), phone: input({ type: 'tel' }), title: input({}) };
  const msg = h('div', { 'aria-live': 'polite' });
  const emailWarn = h('div', { 'aria-live': 'polite', class: 'email-check' });
  wireEmailCheck(ctx, el.email, emailWarn);
  const form = h('form', { class: 'form inline-form', novalidate: true },
    h('div', { class: 'grid' }, field('Name', el.name), field('Email', el.email), field('Phone', el.phone), field('Title', el.title)),
    emailWarn, msg, h('div', { class: 'row-end' }, h('button', { type: 'submit', class: 'btn btn-secondary', disabled: !ctx.can('edit_records') }, 'Add contact')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    try {
      await ctx.store.saveContact({ companyId: company.id, name: el.name.value, email: el.email.value, phone: el.phone.value, title: el.title.value, source: 'manual' });
      toast('Contact saved.');
      onSaved();
    } catch (err) { msg.append(note('danger', err.message)); }
  });
  return form;
}

async function detail(ctx, id) {
  const v = await ctx.store.getVendor(id);
  if (!v) return h('div', { class: 'stack' }, pageHeader('Company not found'), h('a', { href: '#vendors' }, 'Back to the vendor book'));
  const contacts = await ctx.store.listContacts({ companyId: id });
  const [hd, A] = await Promise.all([heatData(ctx), agreementsOrNull()]);
  const box = h('div', { class: 'stack' });
  const formBox = h('div');
  // Staffing P5: one contact's typed log opens under the table (Log button; #vendors?company=..&contact=.. opens it directly).
  const logBox = h('div');
  const openLog = (ct, focus) => {
    clear(logBox);
    if (!ct) return;
    logBox.append(contactLogCard(ctx, { entity: 'vendor_contact', entityId: ct.id, name: ct.name, title: 'Contact log: ' + ct.name, onClose: () => clear(logBox) }));
    if (focus) logBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const draw = () => {
    clear(box);
    append(box,
      pageHeader(v.name, v.domain, [h('a', { class: 'btn btn-ghost', href: '#vendors' }, 'Back to vendor book'),
        button('Edit', { variant: 'secondary', disabled: !ctx.can('edit_records'), onclick: () => { clear(formBox); formBox.append(companyForm(ctx, v, { onSaved: () => ctx.refresh(), onCancel: () => clear(formBox) })); formBox.querySelector('input').focus(); } }),
        deleteButton(ctx, { kind: 'vendor', name: v.name, extra: contacts.length, run: () => ctx.store.deleteVendor(v.id), done: () => ctx.go('#vendors') })]),
      formBox,
      h('div', { class: 'chips' }, chip(TIER_LABELS[v.tier], TIER_KIND[v.tier]), v.doNotContact ? chip('Do not contact', 'danger') : null),
      v.tier === 'avoid' ? note('danger', 'Avoid: ' + (v.avoidReason || 'no reason recorded')) : null,
      v.notes ? h('p', null, v.notes) : null,
      agreementCard(ctx, A, v),
      heatCard(hd, v),
      card('Contacts', contacts.length ? table([
        { label: 'Name', cell: (c) => h('span', null, h('span', { class: 'strong' }, c.name), c.doNotContact ? [' ', chip('Do not contact', 'danger')] : null) },
        { label: 'Title', cell: (c) => c.title || '-' },
        { label: 'Email', cell: (c) => c.email },
        { label: 'Phone', cell: (c) => c.phone || '-' },
        { label: 'Source', cell: (c) => SOURCE_LABELS[c.source] || c.source },
        { label: 'Added', cell: (c) => fmtShort(c.createdOn) },
        { label: '', class: 'right', cell: (c) => h('span', { class: 'row-end' },
          button('Log', { variant: 'ghost', 'aria-label': 'Contact log for ' + c.name, onclick: () => openLog(c, true) }),
          deleteButton(ctx, { kind: 'contact', name: c.name || c.email, run: () => ctx.store.deleteContact(c.id), done: () => ctx.refresh() })) }
      ], contacts, { caption: 'Contacts at ' + v.name }) : empty('No contacts yet.')),
      logBox,
      card('Add a contact', contactForm(ctx, v, () => ctx.refresh())));
  };
  draw();
  openLog(contacts.find((c) => c.id === ctx.route.params.contact), false);
  return box;
}

export async function render(ctx) {
  if (ctx.route.params.company) return detail(ctx, ctx.route.params.company);
  const f = { q: '', tier: '', heat: '', sort: '', agree: ctx.route.params.agree || '' };
  const A = await agreementsOrNull();
  const today = todayISO();
  const listBox = h('div', { 'aria-live': 'polite' });
  const addBox = h('div');
  const contactsByCompany = new Map();
  for (const c of ctx.lk.contacts) contactsByCompany.set(c.companyId, [...(contactsByCompany.get(c.companyId) || []), c]);

  const hd = await heatData(ctx);
  const heatOk = hd.allowed && !hd.error;
  // Smart lists: same plans as heat, built on it. A failed read of the saved lists leaves the four built-in ones.
  const listsOn = heatOk && hasFeature(ctx.team && ctx.team.billing, 'smartLists');
  const canManage = ctx.can('manage_smart_lists');
  let saved = [];
  if (listsOn) { try { saved = await ctx.store.listSmartLists(); } catch (e) { saved = []; } }
  f.list = '';
  const allLists = () => [...BUILT_IN_LISTS, ...saved];
  const smartBox = h('div', { class: 'stack' });
  const listFormBox = h('div');
  function drawLists() {
    clear(smartBox);
    if (!listsOn) return;
    const sel = saved.find((l) => l.id === f.list);
    append(smartBox,
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Smart lists' },
        ...allLists().map((l) => {
          const r = evaluate(hd.VB, l, hd.lists, hd.now, hd.heat);
          const on = f.list === l.id;
          return button(`${l.name} (${r.count})`, {
            variant: on ? 'primary' : 'secondary', 'aria-pressed': String(on),
            title: r.stale.length ? 'This list uses words BenchPilot no longer knows: ' + r.stale.join(', ') : hd.VB.rulesText(l.rules),
            onclick: () => { f.list = on ? '' : l.id; drawLists(); drawList(); }
          });
        }),
        canManage ? button('+ Save a list', {
          variant: 'ghost',
          onclick: () => {
            clear(listFormBox);
            listFormBox.append(listForm(ctx, hd, saved, (list) => {
              clear(listFormBox);
              if (list) { saved = [...saved, list]; f.list = list.id; drawLists(); drawList(); }
            }));
            listFormBox.querySelector('input').focus();
          }
        }) : null),
      sel && canManage ? h('div', { class: 'row-end' }, button(`Delete the list "${sel.name}"`, {
        variant: 'ghost',
        onclick: async () => {
          if (!confirm(`Delete the list "${sel.name}" for the whole team? The companies stay in the vendor book.`)) return;
          try { await ctx.store.deleteSmartList(sel.id); saved = saved.filter((l) => l.id !== sel.id); f.list = ''; toast('List deleted.'); drawLists(); drawList(); }
          catch (err) { toast(err.message); }
        }
      })) : null);
  }
  async function drawList() {
    let rows = await ctx.store.listVendors(f);
    if (listsOn && f.list) {
      const l = allLists().find((x) => x.id === f.list);
      const ids = l ? evaluate(hd.VB, l, hd.lists, hd.now, hd.heat).ids : null;
      if (ids) rows = rows.filter((v) => ids.has(v.id));
    }
    if (heatOk && f.heat) rows = rows.filter((v) => (hd.heat.get(v.id) || {}).heat === f.heat);
    if (A && f.agree) rows = rows.filter((v) => A.matches(v, f.agree, today));
    if (heatOk && f.sort === 'heat') rows = [...rows].sort((a, b) => hd.VB.compareHeat(hd.heat.get(a.id) || {}, hd.heat.get(b.id) || {}));
    clear(listBox);
    listBox.append(rows.length ? table([
      { label: 'Company', cell: (v) => h('a', { href: '#vendors?company=' + v.id, class: 'strong' }, v.name) },
      { label: 'Tier', cell: (v) => chip(TIER_LABELS[v.tier], TIER_KIND[v.tier]) },
      ...(heatOk ? [
        { label: 'Heat', cell: (v) => heatChip(hd, v.id) },
        { label: 'Sent, 30 days', class: 'num', cell: (v) => String((hd.s30.get(v.id) || { sent: 0 }).sent) },
        { label: 'Replied, 90 days', class: 'num', cell: (v) => rate((hd.s90.get(v.id) || {}).replyRate) }
      ] : []),
      { label: 'Domain', cell: (v) => v.domain || '-' },
      ...(A ? [{ label: 'Agreement', cell: (v) => agreementChip(A, v, today) }] : []),
      { label: 'Contacts', cell: (v) => (contactsByCompany.get(v.id) || []).slice(0, 2).map((c) => c.name).join(', ') + (v.contactCount > 2 ? ` +${v.contactCount - 2}` : '') || '-' },
      { label: 'Notes', cell: (v) => (v.tier === 'avoid' && v.avoidReason) ? v.avoidReason : (v.notes || '-') }
    ], rows, { caption: 'Vendor companies' }) : empty('No companies match.'));
  }

  const filters = h('div', { class: 'filters' },
    field('Search', input({ type: 'search', placeholder: 'Name, domain or email', oninput: (e) => { f.q = e.target.value; drawList(); } })),
    field('Tier', select({ '': 'All tiers', ...tierOptions(ctx) }, '',{ onchange: (e) => { f.tier = e.target.value; drawList(); } })),
    heatOk ? field('Heat', select({ '': 'Any heat', hot: 'Hot', active: 'Active', cold: 'Cold' }, '', { onchange: (e) => { f.heat = e.target.value; drawList(); } })) : null,
    A ? field('Agreement', select({ '': 'Any agreement', ...Object.fromEntries(A.FILTERS) }, f.agree, { onchange: (e) => { f.agree = e.target.value; drawList(); } })) : null,
    heatOk ? field('Sort', select({ '': 'Name', heat: 'Hottest first' }, '', { onchange: (e) => { f.sort = e.target.value; drawList(); } })) : null);

  const all = await ctx.store.listVendors();
  const addBtn = button('Add company', {
    variant: 'primary', disabled: !ctx.can('edit_records'),
    onclick: () => { clear(addBox); addBox.append(companyForm(ctx, null, { onSaved: (v) => ctx.go('#vendors?company=' + v.id), onCancel: () => clear(addBox) })); addBox.querySelector('input').focus(); }
  });
  drawLists();
  await drawList();
  return h('div', { class: 'stack' },
    pageHeader('Vendor book', `${plural(all.length, 'company', 'companies')}, ${plural(ctx.lk.contacts.length, 'contact')}`, addBtn),
    hd.allowed ? (hd.error ? note('warn', hd.error) : null) : upgradeNote(ctx),
    addBox,
    all.length ? [smartBox, listFormBox, filters, listBox] : emptyState({
      icon: 'vendors', title: 'Your vendor book is empty',
      text: 'Companies and recruiter contacts the team captures with the extension appear here. You can also add one by hand or import a spreadsheet.',
      action: ctx.can('edit_records') ? button('Add company', { variant: 'primary', onclick: () => addBtn.click() }) : null,
      secondary: sampleDataButton(ctx) || (ctx.can('import') ? h('a', { class: 'btn btn-secondary', href: '#import' }, 'Import vendor book (CSV)') : null)
    }));
}
