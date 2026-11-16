// Today: the owner's numbers (managers see the same), or a recruiter's own list of what to do.
// Both get the 24/48-hour follow-ups (docs/specs/TEAM_P2_SPEC.md section 4), worked out here in the browser: nothing is sent.
// The same role from several vendors is one follow-up (backlog W2). Consultants in interview are held out of the "no submission this week"
// lists, with a "Show held" toggle (backlog W4).
// Owners and managers also get "Vendor agreements" (staffing P6) when an MSA or NDA ends within 30 days or has ended (BP.Agreements).
// Staffing P3: "Interviews today and tomorrow" at the top (the team's, or a recruiter's own), in the person's own zone, with the .ics file.
// Staffing P4: progress against the week target (the team's for owners and managers, a recruiter's own) and the leaderboard (or, when the
// owner hides it from recruiters, "Your numbers"). Team plans only; Starter sees the upgrade note in the target card.
// 0055: "Timesheets and invoices": timesheet weeks missing (a recruiter's own placements) and, for owners and managers, invoices overdue.

import { h, clear } from '../dom.js';
import { pageHeader, card, table, empty, plural, chip, button, note } from '../ui.js';
import { fmtShort } from '../dates.js';
import { loadBP, loadDraftLib } from '../bp-lib.js';
import { reminders, REMIND } from '../team-p2.js';
import { draftButton, followUpDraft } from '../draft.js';
import { agreementReminders } from '../agreements.js';
import { WORK_AUTH_STEPS } from '../consultant-profile.js';
import { needsConsent } from '../consent.js';
import { interviewsCard } from '../p3-ui.js';
import { loadReportData, buildReport, targetCard, leaderboardCard, targetsOn } from '../p4-ui.js';
import { billingTodayCard } from '../invoicing-ui.js';

const REMIND_TEXT = {
  vendor: 'No reply from the vendor', client: 'No update from the client', requirement: 'No submission yet'
};
const ago = (hours) => (hours < 48 ? plural(hours, 'hour') : plural(Math.floor(hours / 24), 'day'));

/** The follow-ups card: the recruiter's own, or everyone's with the recruiter's name (owners and managers). Never throws. */
export async function followUps(ctx, mineOnly) {
  let list, openReqs = [];
  try {
    const [submissions, requirements, BP] = await Promise.all([ctx.store.listSubmissions({}), ctx.store.listRequirements({ status: 'open' }), loadBP()]);
    openReqs = requirements;
    list = reminders({ submissions, requirements }, Date.now(), { sameRole: BP && BP.SameRole });
  } catch (e) { return card('Follow-ups', h('p', { class: 'muted' }, 'The follow-ups could not be loaded.')); }
  const me = ctx.session.user.id;
  if (mineOnly) list = list.filter((r) => r.recruiterId === me);
  const shown = list.slice(0, REMIND.shown);
  const draftBox = h('div');                                         // the "Draft email" panel opens here
  const dctx = { ...ctx, lk: { ...ctx.lk, requirements: openReqs } };  // a follow-up names its requirement when it is open
  const what = (r) => r.kind === 'requirement'
    ? h('span', null, h('a', { href: '#requirements' }, r.requirement.title), r.requirement.endClient ? ' - ' + r.requirement.endClient : '',
      r.sameRole && r.sameRole.count > 1 ? [' ', chip(`Same role from ${r.sameRole.count} vendors`, 'accent')] : null)
    : h('span', null, h('a', { href: '#consultant-' + r.submission.consultantId }, ctx.lk.consultantName(r.submission.consultantId)),
      r.submission.endClient ? ' - ' + r.submission.endClient : '', ctx.lk.vendorName(r.submission.vendorCompanyId) ? ' (' + ctx.lk.vendorName(r.submission.vendorCompanyId) + ')' : '');
  return card('Follow-ups', h('div', { class: 'stack' },
    h('p', { class: 'hint' }, `Submissions with no update after ${REMIND.vendorHours} hours (vendor) or ${REMIND.clientHours} hours (client), and requirements with no submission after ${REMIND.requirementHours} hours. Nothing is sent: follow up yourself, then update the stage.`),
    shown.length ? table([
      { label: 'Follow up', cell: (r) => chip(REMIND_TEXT[r.kind], r.kind === 'requirement' ? 'accent' : 'warn') },
      { label: 'What', cell: what },
      ...(mineOnly ? [] : [{ label: 'Recruiter', cell: (r) => (r.recruiterId ? ctx.lk.memberName(r.recruiterId) : '-') }]),
      { label: 'Waiting', class: 'num', cell: (r) => ago(r.hours) },
      { label: '', class: 'right', cell: (r) => r.kind === 'requirement'
        ? h('div', { class: 'row-end' }, h('a', { class: 'btn btn-secondary', href: '#matches' }, 'See matches'),
          draftButton(dctx, draftBox, { kind: 'pitch', requirement: r.requirement, contactId: r.requirement.vendorContactId, vendorId: r.requirement.vendorCompanyId }, 'Draft email', 'Draft an email about ' + r.requirement.title))
        : h('div', { class: 'row-end' }, h('a', { class: 'btn btn-secondary', href: '#submissions' }, 'Update stage'),
          draftButton(dctx, draftBox, followUpDraft(dctx, r.submission), 'Draft follow-up', 'Draft a follow-up for ' + ctx.lk.consultantName(r.submission.consultantId))) }
    ], shown, { caption: 'Follow-ups' + (mineOnly ? ' for you' : ' for the team') }) : empty('Nothing to follow up. Every submission and requirement has moved.'),
    draftBox,
    list.length > shown.length ? h('p', { class: 'muted' }, `and ${list.length - shown.length} more`) : null));
}

/**
 * Work authorisations ending (staffing P1): bench consultants whose end date is 120 days away or closer, or has passed. Reminders step at
 * 120, 90, 60, 30 and 7 days and on the day. Only the type and the date are shown; no document is stored anywhere.
 * @param {object[]} list  stats.workAuth rows (already only the caller's own consultants for a recruiter)
 */
export function workAuthCard(ctx, list, mineOnly) {
  const steps = WORK_AUTH_STEPS.filter((s) => s > 0).join(', ');
  return card('Work authorisation ending', h('div', { class: 'stack' },
    h('p', { class: 'hint' }, `Reminders at ${steps} days before the end date and on the day. Check the renewal with the consultant, then update the date on their profile.`),
    list.length ? table([
      { label: 'Consultant', cell: (c) => h('a', { href: '#consultant-' + c.id }, c.name) },
      { label: 'Type', cell: (c) => c.visaType || '-' },
      ...(mineOnly ? [] : [{ label: 'Recruiter', cell: (c) => ctx.lk.memberName(c.ownerRecruiterId) }]),
      { label: 'Ends', class: 'nowrap', cell: (c) => fmtShort(c.until) },
      { label: 'When', cell: (c) => chip(c.label, c.days <= 30 ? 'danger' : 'warn') }
    ], list, { caption: 'Work authorisations ending' + (mineOnly ? ' for your consultants' : '') })
      : empty('No work authorisation ends in the next 120 days.')));
}

/**
 * Staffing P5: a soft nudge, a count only, when consultants are being marketed (Marketing, In interview, On hold) with no consent recorded.
 * '' when there are none (Element.append adds nothing). Never blocks anything.
 */
export function consentNudge(consultants, recruiterId) {
  const n = (consultants || []).filter((c) => needsConsent(c) && (!recruiterId || c.ownerRecruiterId === recruiterId)).length;
  if (!n) return '';
  return note('warn', h('span', { class: 'consent-nudge' },
    h('span', null, (n === 1 ? '1 consultant is' : n + ' consultants are') + ' being marketed with no consent recorded.'),
    h('a', { href: '#bench' }, 'Open the bench')));
}

/** Staffing P4: the week target and the leaderboard side by side. Never throws (the Today numbers never depend on it). */
export async function targetsRow(ctx, mineOnly) {
  try {
    if (!targetsOn(ctx)) return mineOnly ? '' : h('div', { class: 'cols' }, targetCard(ctx, null, {}));
    const BP = await loadDraftLib();
    const rep = buildReport(ctx, BP, await loadReportData(ctx, null), { rangeKey: 'week', period: 'week' });
    const mine = rep.rows.find((r) => r.key === ctx.session.user.id) || null;
    return h('div', { class: 'cols p4-cols' },
      mineOnly ? targetCard(ctx, mine, { mine: true }) : targetCard(ctx, { target: rep.total.target, progress: rep.total.progress }, {}),
      leaderboardCard(ctx, rep, { rangeText: 'last 7 days' }));
  } catch (e) { return ''; }
}

function tile(value, label, href, hint) {
  const body = [h('span', { class: 'tile-num' }, String(value)), h('span', { class: 'tile-label' }, label), hint ? h('span', { class: 'tile-hint' }, hint) : null];
  return href ? h('a', { class: 'tile', href }, body) : h('div', { class: 'tile' }, body);
}

/**
 * P2 (0046): the average margin over the last 30 days' submissions with both a bill and a pay rate, and the monthly gross margin from offers
 * and placements (lib/submissions.js marginSummary, the rate calculator's formula). Only for people who may see pay; nothing when no
 * submission has both rates or the rules cannot load.
 */
async function marginTile(ctx) {
  if (!ctx.can('see_pay')) return null;
  try {
    const [BP, subs] = await Promise.all([loadDraftLib(), ctx.store.listSubmissions({ sinceDays: 30 })]);
    const m = BP.Submissions.marginSummary(subs);
    if (!m.counted) return null;
    return tile(m.avgMarginPct + '%', 'Average margin, last 30 days', '#submissions',
      `$${m.avgMargin}/h on ${plural(m.counted, 'submission')}` + (m.placedCounted ? ` · $${m.monthlyPlaced.toLocaleString('en-US')} a month from offers and placements` : ''));
  } catch (e) { return null; }
}

/** "N new in the inbox", linking to the Inbox screen (only when there are new emails). */
export function inboxLine(info) {
  const n = info && info.domain ? Number(info.newCount) || 0 : 0;
  return n > 0 ? h('p', { class: 'inbox-line' }, h('a', { href: '#inbox' }, n + ' new in the inbox')) : '';     // '' so Element.append adds nothing
}

/** Vendor agreements that need a look (owners and managers), or '' when there are none. Never throws. */
export async function agreementsCard(ctx) {
  const { A, list } = await agreementReminders(ctx);
  if (!A || !list.length) return '';
  const ended = list.some((r) => r.ended);
  return card('Vendor agreements', h('div', { class: 'stack' },
    table([
      { label: 'Vendor', cell: (r) => h('a', { href: '#vendors?company=' + r.id, class: 'strong' }, r.name) },
      { label: 'Agreement', cell: (r) => chip(r.kind, r.ended ? 'danger' : 'warn') },
      { label: 'When', cell: (r) => A.reminderWhen(r) }
    ], list.slice(0, 8), { caption: 'Vendor agreements that end within 30 days or have ended' }),
    h('div', { class: 'row-end' },
      list.length > 8 ? h('span', { class: 'muted' }, `and ${list.length - 8} more`) : null,
      h('a', { class: 'btn btn-secondary', href: '#vendors?agree=' + (ended ? 'ended' : 'expiring') }, 'Open in the vendor book'))));
}

function consultantLink(ctx, c) { return h('a', { href: '#consultant-' + c.id }, c.name); }

/**
 * A "no submission this week" card whose consultants in interview are held out (backlog W4), with a toggle that shows them.
 * @param {object[]} pitch  consultants to pitch; @param {object[]} held  consultants in interview with no submission this week
 */
function heldCard(title, pitch, held, columns, emptyText) {
  const view = { showHeld: false };
  const box = h('div');
  const draw = () => {
    clear(box);
    const rows = view.showHeld ? [...pitch, ...held] : pitch;
    box.append(rows.length ? table(columns, rows, { caption: title }) : empty(emptyText));
    if (held.length) {
      box.append(h('div', { class: 'row-end' },
        h('span', { class: 'muted' }, `${plural(held.length, 'consultant')} in interview, held out of this list`),
        button(view.showHeld ? 'Hide held' : 'Show held', { variant: 'ghost', 'aria-pressed': String(view.showHeld), onclick: () => { view.showHeld = !view.showHeld; draw(); } })));
    }
  };
  draw();
  return card(title, box);
}
const heldChip = (c) => (c.held ? [' ', chip('In interview, held', 'warn')] : null);

export async function render(ctx) {
  const stats = await ctx.store.todayStats();
  const mine = ctx.session.user.id;
  const isRecruiter = ctx.session.role === 'recruiter';
  const wrap = h('div', { class: 'stack' });

  if (isRecruiter) {
    const me = stats.byRecruiter.find((r) => r.recruiterId === mine) || { yesterday: 0, week: 0 };
    const todo = stats.zeroThisWeek.filter((c) => c.ownerRecruiterId === mine);
    const heldMine = (stats.heldThisWeek || []).filter((c) => c.ownerRecruiterId === mine);
    wrap.append(
      pageHeader('Today', `Your list for ${fmtShort(stats.date)}, ${ctx.session.user.name}`),
      inboxLine(ctx.inbox),
      consentNudge(ctx.lk.consultants, mine),
      h('div', { class: 'tiles' },
        tile(me.yesterday, 'Your submissions yesterday', '#submissions'),
        tile(me.week, 'Your submissions, last 7 days', '#submissions'),
        tile(stats.openRequirements, 'Open requirements', '#requirements')),
      await targetsRow(ctx, true),
      heldCard('Your consultants with no submission this week', todo, heldMine, [
        { label: 'Consultant', cell: (c) => [consultantLink(ctx, c), heldChip(c)] },
        { label: 'On the bench', cell: (c) => plural(c.benchDays, 'day') },
        { label: '', class: 'right', cell: (c) => h('a', { class: 'btn btn-secondary', href: '#submissions?new=' + c.id }, 'New submission') }
      ], 'Every consultant of yours has a submission this week.'),
      await interviewsCard(ctx, true),
      await billingTodayCard(ctx, true),
      await followUps(ctx, true));
    const myAuth = (stats.workAuth || []).filter((c) => c.ownerRecruiterId === mine);
    if (myAuth.length) wrap.append(workAuthCard(ctx, myAuth, true));
    return wrap;
  }

  let lastRun = null;
  try { lastRun = await ctx.store.lastReportRun(); } catch (e) { lastRun = null; }   // the Today numbers never depend on it
  const mTile = await marginTile(ctx);   // P2: the 30-day margin, for people who may see pay
  const RUN_LABELS = { sent: 'sent', failed: 'failed', sending: 'sending', skipped: 'skipped' };
  wrap.append(
    pageHeader('Today', `The desk on ${fmtShort(stats.date)}`),
    // One quiet status row under the title (it was two loose paragraphs with a 40px gap between them).
    h('div', { class: 'today-meta', hidden: !(inboxLine(ctx.inbox) || (lastRun && lastRun.runOn)) },
      inboxLine(ctx.inbox),
      lastRun && lastRun.runOn ? h('p', { class: 'muted' }, `Last morning report: ${fmtShort(lastRun.runOn)}, ${RUN_LABELS[lastRun.status] || lastRun.status}`) : null),
    consentNudge(ctx.lk.consultants),
    await interviewsCard(ctx, false),
    await targetsRow(ctx, false),
    h('div', { class: mTile ? 'tiles tiles--4' : 'tiles' },
      tile(stats.submissionsYesterday, 'Submissions yesterday', '#submissions'),
      tile(stats.submissionsWeek, 'Submissions, last 7 days', '#submissions'),
      tile(stats.interviews, 'In client interview', '#submissions'),
      tile(stats.zeroThisWeek.length, 'Consultants with 0 submissions this week', '#bench'),
      tile(stats.avgBenchDays, 'Average bench days', '#bench', plural(stats.benchCount, 'consultant') + ' on the bench'),
      tile(stats.newVendors.companies + stats.newVendors.contacts, 'New vendors this week', '#vendors',
        `${plural(stats.newVendors.companies, 'company', 'companies')}, ${plural(stats.newVendors.contacts, 'contact')}`),
      mTile),
    h('div', { class: 'cols' },
      card('Submissions by recruiter', table([
        { label: 'Recruiter', cell: (r) => r.name },
        { label: 'Yesterday', class: 'num', cell: (r) => String(r.yesterday) },
        { label: 'Last 7 days', class: 'num', cell: (r) => String(r.week) }
      ], stats.byRecruiter, { caption: 'Submissions by recruiter' })),
      heldCard('Consultants with 0 submissions this week', stats.zeroThisWeek, stats.heldThisWeek || [], [
        { label: 'Consultant', cell: (c) => [consultantLink(ctx, c), heldChip(c)] },
        { label: 'Recruiter', cell: (c) => ctx.lk.memberName(c.ownerRecruiterId) },
        { label: 'Bench days', class: 'num', cell: (c) => String(c.benchDays) }
      ], 'Everyone on the bench has been submitted this week.')),
    h('div', { class: 'cols' },
      card('On the bench over 30 days', stats.benchOver30.length
        ? table([
          { label: 'Consultant', cell: (c) => consultantLink(ctx, c) },
          { label: 'Recruiter', cell: (c) => ctx.lk.memberName(c.ownerRecruiterId) },
          { label: 'Bench days', class: 'num', cell: (c) => chip(String(c.benchDays), c.benchDays > 45 ? 'warn' : 'neutral') }
        ], stats.benchOver30, { caption: 'Consultants on the bench for more than 30 days' })
        : empty('No one has been on the bench for more than 30 days.')),
      card('Double-submission check', h('p', null,
        stats.guardOverrides
          ? `${plural(stats.guardOverrides, 'time')} in the last 7 days someone continued past an "already submitted" warning, with a reason. `
          : 'No one has continued past an "already submitted" warning in the last 7 days. ',
        h('a', { href: '#submissions' }, 'Open the submission log')))),
    workAuthCard(ctx, stats.workAuth || [], false),
    await agreementsCard(ctx),
    await billingTodayCard(ctx, false),
    await followUps(ctx, false));
  return wrap;
}
