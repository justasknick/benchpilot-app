// Inbox: requirement emails the team forwards to its BenchPilot address (docs/specs/TEAM_INBOX_SPEC.md sections 2, 5 and 6).
// Newest arrival first, in pages of INBOX_PAGE ("Load more"), with the fields the requirement parser reads from the subject and the
// preview; Add to requirements, Ignore, Open the email (fetches the full text); "Add all that look like requirements" (the new emails
// loaded on screen); the Gmail forwarding confirmation pinned at the top while it is new. A job-board alert (Dice, Indeed ...; backlog E16)
// shows "N jobs from Dice" with Add / Ignore per job (kept per job on the server, 0037) and "Add all" (boardBox, also used by My book > Inbox).
// Email content is third-party text: it is only ever added as text nodes (dom.js h()), never as HTML.

import { h, clear } from '../dom.js';
import { pageHeader, card, chip, note, empty, button, toast, plural, WORK_MODES } from '../ui.js';
import { fmtLong } from '../dates.js';
import { loadBP } from '../bp-lib.js';
import { INBOX_PAGE, INBOX_MARK_MAX } from '../live-map.js';
import {
  inboxAddress, requirementFields, looksLikeRequirement, addToRequirements, addAllCandidates, addAll, confirmationCode, findConfirmLink, INBOX_TAKEN,
  boardSource, boardJobs, addBoardJobs, itemStates, jobCounts
} from '../inbox-lib.js';

const FILTERS = { new: 'New', added: 'Added', ignored: 'Ignored' };

function sender(m) {
  const name = String(m.fromName || '').trim();
  return name && m.fromEmail ? name + ' <' + m.fromEmail + '>' : (name || m.fromEmail || 'Unknown sender');
}

/** The full email as text (a <pre> holding one text node). Exported for the escaping test. */
export function mailView(m) {
  return h('div', { class: 'mail-view' },
    h('p', { class: 'muted' }, 'From ', sender(m), m.receivedOn ? ', ' + fmtLong(m.receivedOn) : ''),
    h('pre', { class: 'mail-text' }, String(m.bodyText || '')),
    m.truncated ? h('p', { class: 'hint' }, 'This email was longer than 20 KB, so only the start was kept.') : null);
}

/** The Gmail forwarding confirmation card. Exported for the link test. */
export function confirmationCard(m, opts) {
  const o = opts || {};
  const code = confirmationCode(m);
  const link = findConfirmLink(m.bodyText);
  const openBtn = link
    ? h('a', { class: 'btn btn-primary', href: link, target: '_blank', rel: 'noopener noreferrer', 'aria-disabled': o.demo ? 'true' : null,
      onclick: o.demo ? (e) => { e.preventDefault(); toast('Demo: this sample link does not open.'); } : null }, 'Open the confirm link')
    : null;
  return h('section', { class: 'card card-pinned', 'aria-label': 'Gmail forwarding confirmation' },
    h('h2', null, 'Confirm forwarding in Gmail'),
    h('p', null, 'Gmail sent a code to your BenchPilot address. Open the link, or type the code in Gmail (Settings, Forwarding and POP/IMAP), to finish the setup.'),
    code ? h('p', null, 'Confirmation code: ', h('span', { class: 'code-text' }, code)) : null,
    link ? h('p', { class: 'muted link-text' }, 'Link: ', h('span', { class: 'code-text' }, link)) : h('p', { class: 'muted' }, 'No Google confirm link was found in this email. Use the code in Gmail.'),
    h('p', { class: 'hint' }, 'Check it is from Google: the sender is ', h('span', { class: 'code-text' }, sender(m)),
      ' and the request names the Gmail address you are setting up. If you did not just ask Gmail to forward, choose Done and ignore it.'),
    h('div', { class: 'row-end' },
      o.onDone ? button('Done', { variant: 'ghost', disabled: o.disabled, onclick: o.onDone }) : null,
      openBtn));
}

/** A job's link as an http(s) URL for the "Open the job" link, else '' (the parser only takes the boards' own job links). */
export function safeJobLink(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return ''; }
  return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.href : '';
}

/**
 * The jobs of a job-board alert on its email card: "N jobs from Dice", "N added, M ignored, K left", per job Add / Ignore and "Open the job",
 * "Add all" (at most 100). Each job's state is kept on the server per job (0037: job index + status): loadItems() reads it with the full
 * text, markItems() stores Ignore and "Move back". Ignored jobs are folded away ("Show N ignored"). Reads the full text first (the list has
 * the preview only).
 * @param o { m, source, BP, today, loadFull(): Promise<message>, loadItems(): Promise<[{index, status}]>,
 *            markItems(indexes, status): Promise<{items}>, add(items, claimed): Promise<{outcomes, claimed, error}>,
 *            canEdit, addLabel, blocked(item): '' | reason the job cannot be added, onTaken(), toast(text), demo }
 */
export function boardBox(o) {
  const box = h('div', { class: 'stack board-jobs', 'aria-live': 'polite' }, h('p', { class: 'hint' }, 'Reading the jobs in this ' + o.source.label + ' email...'));
  const msg = h('div', { 'aria-live': 'polite' });
  const state = new Map();   // job index -> 'added' | 'exists' | 'ignored' (no entry: still to do)
  let jobs = null;
  let claimed = o.m.status === 'added';
  let showIgnored = false;
  const blocked = (it) => (o.blocked ? o.blocked(it) : '');
  const open = () => jobs.items.filter((it) => !state.has(it.index) && !blocked(it));
  const counts = () => jobCounts(jobs.items.length, new Map([...state].map(([i, s]) => [i, s === 'ignored' ? 'ignored' : 'added'])));

  function fail(err, btn) {
    if (err && (err.code === 'inbox_taken' || err.code === 'taken')) { o.onTaken(); return; }
    msg.append(note('danger', (err && err.message) || 'Something went wrong. Please try again.'));
    if (btn) btn.disabled = false;
  }

  async function run(btn, list) {
    clear(msg);
    if (btn) btn.disabled = true;
    try {
      const r = await o.add(list, claimed);
      if (r.claimed) { claimed = true; o.m.status = 'added'; }
      r.outcomes.forEach((x, k) => { if (x === 'added' || x === 'exists') state.set(list[k].index, x); });
      const added = r.outcomes.filter((x) => x === 'added').length;
      const had = r.outcomes.filter((x) => x === 'exists').length;
      draw();
      o.toast((added ? 'Added ' + plural(added, 'job') + '.' : 'Nothing new to add.') + (had ? ' ' + plural(had, 'job was', 'jobs were') + ' already there.' : ''));
      if (r.error) msg.append(note('danger', r.error.message));
    } catch (err) { fail(err, btn); }
  }

  // Ignore / Move back: stored per job when the card can store it (markItems), else on this screen only.
  async function setIgnored(btn, it, on) {
    clear(msg);
    if (btn) btn.disabled = true;
    try {
      if (o.markItems) await o.markItems([it.index], on ? 'ignored' : 'new');
      if (on) state.set(it.index, 'ignored'); else state.delete(it.index);
      draw();
    } catch (err) { fail(err, btn); }
  }

  function jobRow(it) {
    const link = safeJobLink(it.url);
    const why = blocked(it);
    const done = state.get(it.index);
    const meta = [it.company, it.postedText ? 'Posted ' + it.postedText.replace(/^posted\s*/i, '') : ''].filter(Boolean).join(' · ');
    const actions = done === 'ignored'
      ? [button('Move back', { variant: 'ghost', disabled: !o.canEdit, onclick: (e) => setIgnored(e.currentTarget, it, false) })]
      : done ? [] : [
        button(o.addLabel || 'Add', { variant: 'primary', disabled: !o.canEdit || Boolean(why), onclick: (e) => run(e.currentTarget, [it]) }),
        button('Ignore', { variant: 'ghost', disabled: !o.canEdit, onclick: (e) => setIgnored(e.currentTarget, it, true) })];
    return h('div', { class: 'board-job', role: 'group', 'aria-label': it.title },
      h('div', { class: 'inbox-card-head' }, h('h3', { class: 'inbox-subject' }, it.title),
        done ? chip(done === 'ignored' ? 'Ignored' : done === 'added' ? 'Added' : 'Already added', done === 'ignored' ? 'neutral' : 'ok') : null),
      meta ? h('p', { class: 'muted' }, meta) : null,
      done === 'ignored' ? null : fieldChips(it.fields),
      why && !done ? h('p', { class: 'hint' }, why) : null,
      h('div', { class: 'row-end' }, ...actions,
        link ? h('a', { class: 'btn btn-ghost', href: link, target: '_blank', rel: 'noopener noreferrer',
          onclick: o.demo ? (e) => { e.preventDefault(); o.toast('Demo: this sample link does not open.'); } : null }, 'Open the job') : null));
  }

  function draw() {
    clear(box);
    if (!jobs) {
      box.append(note('info', 'No jobs could be read from this ' + o.source.label + ' email. Open the email to read it.'));
      return;
    }
    const can = open().slice(0, INBOX_MARK_MAX);
    const c = counts();
    const shown = jobs.items.filter((it) => state.get(it.index) !== 'ignored').map(jobRow);
    const ignored = jobs.items.filter((it) => state.get(it.index) === 'ignored');
    box.append(
      h('div', { class: 'inbox-card-head' },
        h('p', null, h('strong', null, plural(jobs.items.length, 'job') + ' from ' + jobs.source.label), h('br'), h('span', { class: 'muted' }, c.text)),
        button(can.length ? 'Add all (' + can.length + ')' : 'Add all', {
          variant: 'secondary', disabled: !o.canEdit || !can.length,
          onclick: (e) => { if (confirm('Add ' + plural(can.length, 'job') + ' from this ' + jobs.source.label + ' email?')) return run(e.currentTarget, can); }
        })),
      msg, ...(shown.length ? shown : [h('p', { class: 'muted' }, 'Every job in this email is ignored.')]));
    if (ignored.length) {
      box.append(h('div', { class: 'row-end' }, button(showIgnored ? 'Hide ignored jobs' : 'Show ' + plural(ignored.length, 'ignored job'), {
        variant: 'ghost', 'aria-expanded': String(showIgnored), onclick: () => { showIgnored = !showIgnored; draw(); }
      })));
      if (showIgnored) box.append(...ignored.map(jobRow));
    }
  }

  Promise.resolve().then(() => Promise.all([o.loadFull(), o.loadItems ? o.loadItems() : []]))
    .then(([full, items]) => {
      jobs = boardJobs(o.BP, full, o.today);
      for (const [i, st] of itemStates(items)) state.set(i, st);
      draw();
    })
    .catch((err) => { clear(box); box.append(note('danger', (err && err.message) || 'This email could not be read.')); });
  return box;
}

/** "Open the email" and the box it opens (the full text, fetched once). Returns [button, box]. */
export function mailToggle(loadFull) {
  const body = h('div', { hidden: true });
  const btn = button('Open the email', {
    variant: 'ghost', 'aria-expanded': 'false',
    onclick: async (e) => {
      const b = e.currentTarget;
      const open = body.hidden;
      if (open && !body.firstChild) {
        b.disabled = true;
        try { body.append(mailView(await loadFull())); } catch (err) { body.append(note('danger', err.message)); }
        b.disabled = false;
      }
      body.hidden = !open;
      b.setAttribute('aria-expanded', String(open));
      b.textContent = open ? 'Close the email' : 'Open the email';
    }
  });
  return [btn, body];
}

/** The chip texts for an email's requirement fields, without repeats: a location of "Remote" and the work mode "Remote", or a
 *  rate "$65-70/hr C2C" and the terms "C2C", showed the same word twice. A text already said by an earlier chip is dropped. */
export function fieldChipTexts(f) {
  const out = [];
  const said = (t) => out.some((o) => o.toLowerCase() === t.toLowerCase() || new RegExp('(^|[^a-z0-9])' + t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])').test(o.toLowerCase()));
  for (const t of [f.endClient, f.location, f.workMode ? WORK_MODES[f.workMode] : '', f.rateText, f.taxTerms, f.visaText ? 'Visa: ' + f.visaText : '', f.duration, f.jobRef ? 'Ref ' + f.jobRef : '']) {
    const v = String(t || '').trim();
    if (v && !said(v)) out.push(v);
  }
  return out;
}

export function fieldChips(f) {
  const list = fieldChipTexts(f);
  const skills = (f.skills || []).slice(0, 6);
  if (!list.length && !skills.length) return h('p', { class: 'muted' }, 'No requirement fields were found in this email.');
  return h('div', { class: 'chips tag-row' }, list.map((t) => chip(t, 'neutral')), skills.map((t) => chip(t, 'accent')));
}

export async function render(ctx) {
  const BP = await loadBP();
  const info = await ctx.store.getInboxInfo({ fresh: true });
  const owner = ctx.session.role === 'owner';
  const canEdit = ctx.can('edit_records');
  const wrap = h('div', { class: 'stack' });
  const head = (actions) => pageHeader('Inbox', 'Requirement emails your team forwards to BenchPilot, newest first', actions);

  if (!info.domain) {
    wrap.append(head(null), note('info', 'The inbox address is not set up yet.'));
    return wrap;
  }

  // The list carries only each email's preview; the full text is fetched for one email when it is opened or added, and for the
  // pinned Gmail confirmations (at most 5).
  const [addresses, pinnedRows] = await Promise.all([
    ctx.store.listInboxAddresses(),
    ctx.store.listInboxMessages({ status: 'new', kind: 'forwarding_confirmation', limit: 5 })
  ]);
  const pinned = await Promise.all(pinnedRows.map((m) => ctx.store.getInboxMessage(m.id).catch(() => m)));
  const active = addresses.filter((a) => a.active);
  const today = Date.now();
  let filter = (ctx.route.params && FILTERS[ctx.route.params.show]) ? ctx.route.params.show : 'new';
  let book = null;
  const getBook = async () => {
    if (!book) book = { vendors: await ctx.store.listVendors(), contacts: await ctx.store.listContacts() };
    return book;
  };
  // New shows mail only (the confirmation is pinned above); Added and Ignored show both kinds.
  let rows = [];
  let more = false;
  const loadPage = async (before) => {
    const got = await ctx.store.listInboxMessages({ status: filter, kind: filter === 'new' ? 'mail' : '', before, limit: INBOX_PAGE + 1 });
    more = got.length > INBOX_PAGE;
    const seen = new Set(rows.map((m) => m.id));
    rows = rows.concat(got.slice(0, INBOX_PAGE).filter((m) => !seen.has(m.id)));
  };
  await loadPage(null);

  if (!active.length && !rows.length && !pinned.length && (await ctx.store.listInboxMessages({ limit: 1 })).length === 0) {
    wrap.append(head(null), card('No inbox address yet', owner
      ? h('div', null, h('p', null, 'Create an address, then forward requirement emails or C2C group mail to it.'), h('div', { class: 'row-end' }, h('a', { class: 'btn btn-primary', href: '#team' }, 'Create an address')))
      : h('p', { class: 'muted' }, 'Ask the owner to create the team\'s inbox address in Team settings.')));
    return wrap;
  }

  const msg = h('div', { 'aria-live': 'polite' });
  const listBox = h('div', { class: 'stack', 'aria-live': 'polite' });
  const moreBox = h('div', { class: 'row-end' });
  const tabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' });
  const addAllBox = h('div', null);

  async function act(btn, fn, done) {
    clear(msg);
    if (btn) btn.disabled = true;
    try {
      const r = await fn();
      const text = typeof done === 'function' ? done(r) : done;
      if (text) toast(text);
      ctx.refresh();
    } catch (err) {
      if (err && err.code === 'inbox_taken') { toast(INBOX_TAKEN); ctx.refresh(); return; }
      msg.append(note('danger', err.message));
      if (btn) btn.disabled = false;
    }
  }

  // Reading more of the list (a tab, "Load more") redraws in place: no refresh, so the loaded pages stay.
  async function load(btn, fn) {
    clear(msg);
    if (btn) btn.disabled = true;
    try { await fn(); } catch (err) { msg.append(note('danger', err.message)); }
    if (btn) btn.disabled = false;
  }

  function messageCard(m) {
    const board = boardSource(BP, m);
    if (board) return boardCard(m, board);
    const f = requirementFields(BP, m, today);
    const isReq = looksLikeRequirement(BP, m);
    const [openBtn, body] = mailToggle(() => ctx.store.getInboxMessage(m.id));
    const actions = [];
    if (m.status !== 'added' && m.kind === 'mail') {
      actions.push(button('Add to requirements', {
        variant: 'primary', disabled: !canEdit,
        onclick: (e) => act(e.currentTarget, async () => addToRequirements(ctx.store, m, { BP, book: await getBook(), inboxDomain: info.domain, todayMs: today }), 'Added to requirements.')
      }));
    }
    if (m.status === 'new') actions.push(button('Ignore', { variant: 'secondary', disabled: !canEdit, onclick: (e) => act(e.currentTarget, () => ctx.store.markInbox([m.id], 'ignored'), 'Ignored.') }));
    if (m.status === 'ignored') actions.push(button('Move back to New', { variant: 'ghost', disabled: !canEdit, onclick: (e) => act(e.currentTarget, () => ctx.store.markInbox([m.id], 'new'), 'Moved back to New.') }));
    if (m.status === 'added') actions.push(h('a', { class: 'btn btn-ghost', href: '#requirements' }, 'Open requirements'));
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

  // A job-board alert: its jobs, each added as its own requirement (inbox-lib addBoardJobs: same claim, same saveRequirement).
  function boardCard(m, board) {
    const actions = [];
    if (m.status === 'new') actions.push(button('Ignore the email', { variant: 'secondary', disabled: !canEdit, onclick: (e) => act(e.currentTarget, () => ctx.store.markInbox([m.id], 'ignored'), 'Ignored.') }));
    if (m.status === 'ignored') actions.push(button('Move back to New', { variant: 'ghost', disabled: !canEdit, onclick: (e) => act(e.currentTarget, () => ctx.store.markInbox([m.id], 'new'), 'Moved back to New.') }));
    if (m.status === 'added') actions.push(h('a', { class: 'btn btn-ghost', href: '#requirements' }, 'Open requirements'));
    let fullP = null;   // one fetch for the jobs and "Open the email"
    const getFull = () => (fullP = fullP || (m.full ? Promise.resolve(m) : ctx.store.getInboxMessage(m.id)).catch((e) => { fullP = null; throw e; }));
    const [openBtn, body] = mailToggle(getFull);
    actions.push(openBtn);
    const jobs = m.status === 'ignored' ? null : boardBox({
      m, source: board, BP, today, canEdit, demo: !ctx.live, addLabel: 'Add', toast,
      loadFull: getFull,
      loadItems: () => ctx.store.listInboxItems(m.id),
      markItems: (indexes, status) => ctx.store.markInboxItems(m.id, indexes, status),
      add: async (items, claimed) => addBoardJobs(ctx.store, m, items, { BP, book: await getBook(), source: board, claimed }),
      onTaken: () => { toast(INBOX_TAKEN); ctx.refresh(); }
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

  function drawTabs() {
    clear(tabs);
    // New: the server's count of all new email (as the nav badge), less the pinned confirmations shown above.
    const newCount = Math.max(0, info.newCount - pinned.length);
    for (const [key, label] of Object.entries(FILTERS)) {
      tabs.append(button(key === 'new' ? label + ' (' + newCount + ')' : label, {
        variant: key === filter ? 'primary' : 'secondary', 'aria-pressed': String(key === filter),
        onclick: () => load(null, async () => { filter = key; rows = []; await loadPage(null); drawTabs(); drawList(); drawAddAll(); })
      }));
    }
  }

  function drawList() {
    clear(listBox);
    clear(moreBox);
    if (!rows.length) {
      listBox.append(empty(filter === 'new'
        ? (active.length ? 'No new emails. Forward requirement emails to ' + inboxAddress(active[0].token, info.domain) + '.' : 'No new emails.')
        : 'No ' + FILTERS[filter].toLowerCase() + ' emails.'));
      return;
    }
    listBox.append(...rows.map(messageCard));
    if (more) {
      moreBox.append(button('Load more', {
        variant: 'secondary',
        onclick: (e) => {
          const btn = e.currentTarget;
          const last = rows[rows.length - 1];
          return load(btn, async () => { await loadPage({ createdAt: last.createdAt, id: last.id }); drawList(); drawAddAll(); });
        }
      }));
    }
  }

  // "Add all" takes the new emails loaded on screen (the first page and any loaded with "Load more"), never ones not shown.
  function drawAddAll() {
    clear(addAllBox);
    const candidates = filter === 'new' ? addAllCandidates(BP, rows) : [];
    addAllBox.append(button(candidates.length ? 'Add all that look like requirements (' + candidates.length + ')' : 'Add all that look like requirements', {
      variant: 'secondary', disabled: !canEdit || !candidates.length,
      title: !BP ? 'The reader could not load, so add the emails one at a time.' : (more ? 'Adds the emails loaded on this screen. Load more to add the rest.' : null),
      onclick: (e) => {
        if (!confirm('Add ' + plural(candidates.length, 'email') + ' to requirements? Emails the reader is not sure about stay in New.')) return;
        return act(e.currentTarget, async () => addAll(ctx.store, candidates, { BP, book: await getBook(), inboxDomain: info.domain, todayMs: today }),
          (r) => 'Added ' + plural(r.added, 'requirement') + '.' + (r.taken ? ' ' + plural(r.taken, 'email was', 'emails were') + ' already added by a teammate.' : ''));
      }
    }));
  }

  wrap.append(head(addAllBox));
  if (!BP) wrap.append(note('warn', 'The reader could not load, so the fields are not shown. You can still add emails one at a time.'));
  if (!active.length) wrap.append(note('warn', owner ? 'All inbox addresses are turned off, so no new email arrives. Create one in Team settings.' : 'All inbox addresses are turned off, so no new email arrives. Ask the owner.'));
  if (ctx.readOnly) wrap.append(note('warn', 'The workspace is read-only, so new emails are not stored and nothing can be added.'));
  for (const m of pinned) {
    wrap.append(confirmationCard(m, {
      demo: !ctx.live, disabled: !canEdit,
      onDone: (e) => act(e.currentTarget, () => ctx.store.markInbox([m.id], 'ignored'), 'Done.')
    }));
  }
  drawTabs();
  drawList();
  drawAddAll();
  wrap.append(msg, tabs, listBox, moreBox);
  return wrap;
}
