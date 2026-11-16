// My book > Inbox (Solo personal inbox, docs/specs/SOLO_INBOX_SPEC.md sections 2 and 7). The address card (create / copy / turn off /
// replace), the decrypted list (New / Added / Ignored, newest arrival first, "Load more"), the Gmail confirmation pinned while new, and per
// email: Add to my book, Ignore, Open the email. A job-board alert (backlog E16) lists its jobs (inbox.js boardBox): each job that names a
// recruiter goes in as that recruiter. All crypto and server calls are in js/personal-inbox.js and js/vault.js.
// Email content is third-party text: it is only ever added as text nodes (dom.js h()), never as HTML. Email content never goes into the URL.

import { h, clear } from '../dom.js';
import { pageHeader, card, chip, note, empty, button, plural } from '../ui.js';
import { fmtLong } from '../dates.js';
import { loadBP } from '../bp-lib.js';
import { requirementFields, looksLikeRequirement, boardSource, personFromEmail } from '../inbox-lib.js';
import { mailToggle, confirmationCard, fieldChips, boardBox } from './inbox.js';
import { addToMyBook, addAllCandidates, addBoardJobsToMyBook, keyState, INBOX_MESSAGES } from '../personal-inbox.js';

const FILTERS = { new: 'New', added: 'Added', ignored: 'Ignored' };
let filter = 'new';   // memory only

function sender(m) {
  const name = String(m.fromName || '').trim();
  return name && m.fromEmail ? name + ' <' + m.fromEmail + '>' : (name || m.fromEmail || 'Unknown sender');
}

/** The address card (settings). Exported for the escaping test. */
export function addressCard(ctx, info, act) {
  const inbox = ctx.inbox;
  const addr = inbox.address();
  const a = info && info.address;
  if (!info || !info.domain) return card('Your inbox address', note('info', INBOX_MESSAGES.not_set_up));
  const state = keyState(info, ctx.vault.currentKeyId());
  const lines = [];
  // An old tab after "Replace my keys" elsewhere: the tab is the stale side, so it asks for the passphrase again (not a new address).
  if (state === 'tab_stale') lines.push(note('warn', ctx.vault.MESSAGES.inbox_tab_stale));
  if (inbox.keyBad && inbox.keyBad()) lines.push(note('danger', ctx.vault.MESSAGES.inbox_key_mismatch));
  if (addr) {
    lines.push(h('p', null, 'Forward requirement emails, or add this address to a C2C Google Group. Each email is encrypted as it arrives; only you can read it.'));
    lines.push(h('p', null, h('span', { class: 'code-text' }, addr)));
    if (a.last_message_at) lines.push(h('p', { class: 'hint' }, 'Last email ' + fmtLong(String(a.last_message_at).slice(0, 10)) + '. ' + plural(a.message_count, 'email') + ' received.'));
    if (a.dropped_count) lines.push(h('p', { class: 'hint' }, plural(a.dropped_count, 'email was', 'emails were') + ' not stored (plan, daily limit or storage full).'));
    if (state === 'server_stale') lines.push(note('warn', ctx.vault.MESSAGES.inbox_stale));
    lines.push(h('div', { class: 'row-end' },
      button('Copy', { variant: 'secondary', onclick: async (e) => { try { await navigator.clipboard.writeText(addr); e.currentTarget.textContent = 'Copied'; } catch (_) { /* nothing */ } } }),
      button('Replace', { variant: 'ghost', onclick: (e) => { if (confirm('Replace your inbox address? The old one stops working at once; your emails stay.')) act(e.currentTarget, () => inbox.create({ replace: true }), 'Your new inbox address is ready.'); } }),
      button('Turn off', { variant: 'ghost', onclick: (e) => { if (confirm('Turn off your inbox address? Emails sent to it are no longer stored. Your emails stay.')) act(e.currentTarget, () => inbox.disable(), 'Your inbox address is turned off.'); } })));
  } else {
    lines.push(h('p', null, 'Get your own BenchPilot address. Forward requirement emails to it; they are encrypted as they arrive and only you can read them here.'));
    lines.push(h('div', { class: 'row-end' }, button('Create my inbox address', { variant: 'primary', onclick: (e) => act(e.currentTarget, () => inbox.create({ replace: Boolean(a) }), 'Your inbox address is ready.') })));
  }
  return card('Your inbox address', lines);
}

/** One email card. Exported for the escaping test. */
export function messageCard(ctx, BP, m, act) {
  if (m.unreadable) {
    return h('article', { class: 'card inbox-card' }, h('p', { class: 'muted' }, INBOX_MESSAGES.unreadable),
      h('div', { class: 'row-end' }, button('Ignore', { variant: 'secondary', onclick: (e) => act(e.currentTarget, () => ctx.inbox.mark([m.id], 'ignored'), 'Ignored.') })));
  }
  const board = boardSource(BP, m);
  if (board) return boardMessageCard(ctx, BP, m, board, act);
  const f = requirementFields(BP, m, Date.now());
  const isReq = looksLikeRequirement(BP, m);
  const [openBtn, body] = mailToggle(() => ctx.inbox.full(m));
  const actions = [];
  if (m.status !== 'added' && m.kind === 'mail') {
    actions.push(button('Add to my book', {
      variant: 'primary',
      onclick: (e) => act(e.currentTarget, () => addToMyBook({ ...ctx, BP }, m),
        (r) => (r.existed ? INBOX_MESSAGES.exists : 'Added to your book. Your other computers get it on their next sync.'))
    }));
  }
  if (m.status === 'new') actions.push(button('Ignore', { variant: 'secondary', onclick: (e) => act(e.currentTarget, () => ctx.inbox.mark([m.id], 'ignored'), 'Ignored.') }));
  if (m.status === 'ignored') actions.push(button('Move back to New', { variant: 'ghost', onclick: (e) => act(e.currentTarget, () => ctx.inbox.mark([m.id], 'new'), 'Moved back to New.') }));
  if (m.status === 'added') actions.push(h('a', { class: 'btn btn-ghost', href: '#book-leads' }, 'Open recruiters'));
  actions.push(openBtn);
  return h('article', { class: 'card inbox-card', 'aria-label': m.subject || 'Email' },
    h('div', { class: 'inbox-card-head' },
      h('h2', { class: 'inbox-subject' }, f.title || m.subject || '(no subject)'),
      m.status === 'new' ? chip(isReq ? 'Looks like a requirement' : 'Not sure', isReq ? 'ok' : 'neutral') : chip(FILTERS[m.status], m.status === 'added' ? 'ok' : 'neutral')),
    h('p', { class: 'muted' }, sender(m), m.receivedOn ? ' - ' + fmtLong(m.receivedOn) : ''),
    m.subject && f.title !== m.subject ? h('p', { class: 'hint' }, 'Subject: ', m.subject) : null,
    m.kind === 'forwarding_confirmation' ? h('p', { class: 'hint' }, 'Gmail forwarding confirmation') : fieldChips(f),
    h('div', { class: 'row-end' }, actions),
    body);
}

/** A job-board alert's card: its jobs; each job that names a recruiter's email can go into the book. Exported for the flow test. */
export function boardMessageCard(ctx, BP, m, board, act) {
  let fullP = null;   // one decrypt for the jobs and "Open the email"
  const getFull = () => (fullP = fullP || ctx.inbox.full(m).catch((e) => { fullP = null; throw e; }));
  const [openBtn, body] = mailToggle(getFull);
  const actions = [];
  if (m.status === 'new') actions.push(button('Ignore the email', { variant: 'secondary', onclick: (e) => act(e.currentTarget, () => ctx.inbox.mark([m.id], 'ignored'), 'Ignored.') }));
  if (m.status === 'ignored') actions.push(button('Move back to New', { variant: 'ghost', onclick: (e) => act(e.currentTarget, () => ctx.inbox.mark([m.id], 'new'), 'Moved back to New.') }));
  if (m.status === 'added') actions.push(h('a', { class: 'btn btn-ghost', href: '#book-leads' }, 'Open recruiters'));
  actions.push(openBtn);
  const jobs = m.status === 'ignored' ? null : boardBox({
    m, source: board, BP, today: Date.now(), canEdit: true, addLabel: 'Add to my book', toast: ctx.toast,
    blocked: (it) => (it.contact && personFromEmail(BP, it.contact.email) ? '' : INBOX_MESSAGES.job_no_contact),
    loadFull: getFull,
    loadItems: () => ctx.inbox.items(m),
    markItems: (indexes, status) => ctx.inbox.markItems(m, indexes, status),
    add: (items, claimed) => addBoardJobsToMyBook({ ...ctx, BP }, m, items, { source: board, claimed }),
    onTaken: () => { ctx.toast(INBOX_MESSAGES.taken); ctx.refresh(); }
  });
  return h('article', { class: 'card inbox-card', 'aria-label': m.subject || 'Email' },
    h('div', { class: 'inbox-card-head' },
      h('h2', { class: 'inbox-subject' }, m.subject || board.label + ' job alert'),
      chip(m.status === 'new' ? board.label + ' job alert' : FILTERS[m.status], m.status === 'added' ? 'ok' : 'neutral')),
    h('p', { class: 'muted' }, sender(m), m.receivedOn ? ' - ' + fmtLong(m.receivedOn) : ''),
    jobs,
    h('div', { class: 'row-end' }, actions),
    body);
}

/**
 * @param ctx { vault, model, inbox (personal-inbox.js), refresh(), toast(text) }. The vault is open.
 * Returns the element at once and fills it when the list has been read and decrypted.
 */
export function render(ctx) {
  const wrap = h('div', { class: 'stack' }, pageHeader('Inbox', 'Requirement emails sent to your own address, decrypted in this tab only'), h('p', { class: 'hint' }, 'Opening your inbox...'));
  fill(ctx, wrap).catch((err) => {
    clear(wrap);
    wrap.append(pageHeader('Inbox'), note('danger', (err && err.message) || 'Something went wrong. Please try again.'));
    if (!ctx.vault.isOpen()) ctx.refresh();
  });
  return wrap;
}

async function fill(ctx, wrap) {
  const BP = await loadBP();
  const info = await ctx.inbox.load();
  const msg = h('div', { 'aria-live': 'polite' });
  async function act(btn, fn, done) {
    clear(msg);
    if (btn) btn.disabled = true;
    try {
      const r = await fn();
      const text = typeof done === 'function' ? done(r) : done;
      if (text) ctx.toast(text);
      ctx.refresh();
    } catch (err) {
      if (!ctx.vault.isOpen()) { ctx.refresh(); return; }
      if (err && err.code === 'taken') { ctx.toast(INBOX_MESSAGES.taken); ctx.refresh(); return; }
      msg.append(note('danger', err.message));
      if (btn) btn.disabled = false;
    }
  }
  let usable = keyState(info, ctx.vault.currentKeyId()) === 'ok';
  if (usable) {
    // Opens the inbox key and checks it against the server's public key first: a key that is not the user's own shows no mail at all.
    try { await ctx.inbox.checkKey(); } catch (err) { if (!err || err.code !== 'inbox_key_mismatch') throw err; usable = false; }
  }
  const settings = addressCard(ctx, info, act);
  clear(wrap);
  wrap.append(pageHeader('Inbox', 'Requirement emails sent to your own address, decrypted in this tab only'), msg);
  if (!usable) { wrap.append(settings); return; }

  let rows = [];
  let cursor = null;
  const loadPage = async () => {
    const got = await ctx.inbox.list(filter, cursor);
    const seen = new Set(rows.map((m) => m.id));
    rows = rows.concat(got.messages.filter((m) => !seen.has(m.id)));
    cursor = got.cursor;
  };
  await loadPage();
  // The Gmail confirmation is pinned on New (with its full text, for the code and the link).
  const pinnedRows = filter === 'new' ? rows.filter((m) => m.kind === 'forwarding_confirmation').slice(0, 5) : [];
  const pinned = await Promise.all(pinnedRows.map((m) => ctx.inbox.full(m).catch(() => m)));
  const listed = () => (filter === 'new' ? rows.filter((m) => m.kind !== 'forwarding_confirmation') : rows);

  const tabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' });
  for (const [key, label] of Object.entries(FILTERS)) {
    tabs.append(button(key === 'new' ? label + ' (' + (Number(info.new_count) || 0) + ')' : label, {
      variant: key === filter ? 'primary' : 'secondary', 'aria-pressed': String(key === filter),
      onclick: () => { filter = key; ctx.refresh(); }
    }));
  }
  const listBox = h('div', { class: 'stack' });
  const moreBox = h('div', { class: 'row-end' });
  const addAllBox = h('div', null);
  const draw = () => {
    clear(listBox); clear(moreBox); clear(addAllBox);
    const shown = listed();
    if (!shown.length) listBox.append(empty(filter === 'new' ? (ctx.inbox.address() ? 'No new emails. Forward requirement emails to ' + ctx.inbox.address() + '.' : 'No new emails.') : 'No ' + FILTERS[filter].toLowerCase() + ' emails.'));
    else listBox.append(...shown.map((m) => messageCard(ctx, BP, m, act)));
    if (cursor) {
      moreBox.append(button('Load more', {
        variant: 'secondary',
        onclick: async (e) => { e.currentTarget.disabled = true; try { await loadPage(); } catch (err) { msg.append(note('danger', err.message)); } draw(); }
      }));
    }
    const candidates = filter === 'new' ? addAllCandidates(BP, rows) : [];
    if (candidates.length) {
      addAllBox.append(button('Add all that look like requirements (' + candidates.length + ')', {
        variant: 'secondary',
        onclick: (e) => {
          if (!confirm('Add ' + plural(candidates.length, 'email') + ' to your book? Emails the reader is not sure about stay in New.')) return;
          return act(e.currentTarget, async () => {
            let added = 0, skipped = 0;
            for (const m of candidates) {
              try { const r = await addToMyBook({ ...ctx, BP }, m); if (r.existed) skipped += 1; else added += 1; }
              catch (err) { if (err && (err.code === 'taken' || err.code === 'no_contact')) skipped += 1; else throw err; }
            }
            return { added, skipped };
          }, (r) => 'Added ' + plural(r.added, 'recruiter') + '.' + (r.skipped ? ' ' + plural(r.skipped, 'email was', 'emails were') + ' skipped.' : ''));
        }
      }));
    }
  };
  draw();
  if (!BP) wrap.append(note('warn', 'The reader could not load, so the fields are not shown. You can still add emails one at a time.'));
  for (const m of pinned) wrap.append(confirmationCard(m, { onDone: (e) => act(e.currentTarget, () => ctx.inbox.mark([m.id], 'ignored'), 'Done.') }));
  wrap.append(tabs, addAllBox, listBox, moreBox, settings);
}
