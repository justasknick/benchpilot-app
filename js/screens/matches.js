// Matches (docs/specs/TEAM_P2_SPEC.md section 3): every open requirement in the team book against the whole bench, and every consultant
// against the open requirements. Scores come from the extension's own BP.scoreMatch (loaded by bp-lib loadMatchLib), 60 % and up.
// The team guard (guard.js, the same rule as the server) marks a pair already submitted by anyone in 90 days: "Already submitted by <name>".
// Nothing is stored or sent; "New submission" opens the normal form, where the server guard runs again.
// The same role posted by several vendors is one entry, "Same role from N vendors" (backlog W2, BP.SameRole). Consultants in interview are
// held out until "Show held" is on (backlog W4).

import { h, clear } from '../dom.js';
import { pageHeader, card, chip, note, empty, plural, button } from '../ui.js';
import { fmtShort } from '../dates.js';
import { loadMatchLib } from '../bp-lib.js';
import { teamMatches, MATCHES_SHOWN } from '../team-p2.js';
import { draftButton } from '../draft.js';
import { filterByDesk } from '../desks.js';
import { deskFilterField } from '../desk-ui.js';

function guardLine(ctx, g) {
  return chip(`Already submitted by ${ctx.lk.memberName(g.recruiterId)} on ${fmtShort(g.submittedOn)}`, 'warn');
}

function sameRoleChip(sr) {
  return sr ? chip(sr.count > 1 ? `Same role from ${sr.count} vendors` : `Same role posted ${sr.others.length + 1} times`, 'accent') : null;
}

function matchItem(ctx, m, label, showRole) {
  const newHref = '#submissions?new=' + encodeURIComponent(m.consultant.id) + '&req=' + encodeURIComponent(m.requirement.id);
  return h('li', { class: 'match-item' },
    h('div', null,
      chip(m.percent + '%', m.percent >= 75 ? 'ok' : 'accent'), ' ', label,
      m.needsLook ? [' ', chip('Needs a look', 'neutral')] : null,
      m.held ? [' ', chip('In interview, held', 'warn')] : null,
      showRole && m.sameRole ? [' ', sameRoleChip(m.sameRole)] : null),
    h('div', { class: 'muted' }, m.reasons.slice(0, 4).join(' · ') + (m.missing.length ? ' · Missing: ' + m.missing.slice(0, 2).join(', ') : '')),
    m.guard ? h('div', null, guardLine(ctx, m.guard))
      : h('div', { class: 'row-end' },
        ctx.can('edit_records') ? h('a', { class: 'btn btn-secondary', href: newHref }, 'New submission') : null,
        ctx.draftBox ? draftButton(ctx, ctx.draftBox, { kind: 'pitch', requirement: m.requirement, consultantId: m.consultant.id, contactId: m.requirement.vendorContactId, vendorId: m.requirement.vendorCompanyId },
          'Draft email', `Draft an email pitching ${m.consultant.name} for ${m.requirement.title}`) : null));
}

function byRequirement(ctx, list) {
  if (!list.length) return empty('No open requirement matches anyone on the bench at 60% or more.');
  return h('div', { class: 'stack' }, list.map((x) => card(
    x.requirement.title + (x.requirement.endClient ? ' - ' + x.requirement.endClient : ''),
    h('div', null,
      h('p', { class: 'muted' }, [ctx.lk.vendorName(x.requirement.vendorCompanyId), x.requirement.location, x.requirement.rateText, plural(x.total, 'match', 'matches')].filter(Boolean).join(' · ')),
      x.sameRole ? h('p', null, sameRoleChip(x.sameRole), ' ', h('span', { class: 'muted' },
        'Also from ' + x.sameRole.others.map((o) => [ctx.lk.vendorName(o.vendorCompanyId) || 'a vendor not named', o.rateText].filter(Boolean).join(', ')).join('; '))) : null,
      h('ul', { class: 'match-list' }, x.matches.map((m) => matchItem(ctx, m, h('a', { href: '#consultant-' + m.consultant.id, class: 'strong' }, m.consultant.name))))))));
}

function byConsultant(ctx, list) {
  if (!list.length) return empty('No one on the bench matches an open requirement at 60% or more.');
  return h('div', { class: 'stack' }, list.map((x) => card(
    x.consultant.name + (x.consultant.title ? ' - ' + x.consultant.title : ''),
    h('div', null,
      h('p', { class: 'muted' }, [ctx.lk.memberName(x.consultant.ownerRecruiterId), plural(x.total, 'matching requirement')].join(' · ')),
      h('ul', { class: 'match-list' }, x.matches.map((m) => matchItem(ctx, m, h('span', { class: 'strong' }, m.requirement.title + (m.requirement.endClient ? ' - ' + m.requirement.endClient : '')), true)))))));
}

/** What the matcher left out on purpose (staffing P1): work authorisation not taken, and consultants free only later. '' when nothing. */
export function notShownCard(ctx, res) {
  const hidden = res.hidden || [];
  const later = res.notYet || [];
  if (!hidden.length && !later.length) return '';
  const SHOWN = 20;
  return card('Not shown', h('div', { class: 'stack' },
    hidden.length ? h('div', null,
      h('p', { class: 'muted' }, `${plural(hidden.length, 'pair')} hidden because the requirement does not take the consultant's work authorisation:`),
      h('ul', { class: 'match-list' }, hidden.slice(0, SHOWN).map((x) => h('li', null,
        h('a', { href: '#consultant-' + x.consultant.id, class: 'strong' }, x.consultant.name), ' for ', x.requirement.title,
        x.requirement.endClient ? ' - ' + x.requirement.endClient : '', ': ', h('span', { class: 'muted' }, x.reason)))),
      hidden.length > SHOWN ? h('p', { class: 'muted' }, `and ${hidden.length - SHOWN} more`) : null) : null,
    later.length ? h('p', { class: 'muted' }, `Available only later, so not pitched yet: `,
      later.map((c, i) => [i ? ', ' : '', h('a', { href: '#consultant-' + c.id }, c.name), ` (from ${fmtShort(c.availableOn)})`])) : null));
}

export async function render(ctx) {
  let BP;
  try { BP = await loadMatchLib(); } catch (e) {
    return h('div', { class: 'stack' }, pageHeader('Matches'), note('danger', 'The matching code could not load. Reload the page to try again.'));
  }
  const [requirements, submissions] = await Promise.all([ctx.store.listRequirements({ status: 'open' }), ctx.store.listSubmissions({})]);
  const view = { tab: ctx.route.params.by === 'consultant' ? 'consultant' : 'requirement', showHeld: false, deskId: '' };
  // The desk filter (Agency, backlog W10) keeps the consultants of one desk; every open requirement stays in play.
  const run = () => teamMatches(BP, { requirements, consultants: filterByDesk('consultant', ctx.lk.consultants, view.deskId, ctx.lk.deskIdx), submissions },
    { today: ctx.session.today, nowMs: Date.now(), showHeld: view.showHeld });
  let res = run();
  const sub = h('p', { class: 'sub' });
  const body = h('div', { 'aria-live': 'polite' });
  ctx.draftBox = h('div');        // the "Draft email" panel opens here
  const tabs = h('div', { class: 'row-end', role: 'group', 'aria-label': 'Show matches' });
  function draw() {
    clear(tabs); clear(body); clear(sub);
    sub.append(`${plural(res.requirements.length, 'open role')} with a match, ${plural(res.consultants.length, 'consultant')} with a match. The best ${MATCHES_SHOWN} each, not yet submitted first.`);
    const heldN = res.held.length;
    tabs.append(
      button('By requirement', { variant: view.tab === 'requirement' ? 'primary' : 'secondary', 'aria-pressed': String(view.tab === 'requirement'), onclick: () => { view.tab = 'requirement'; draw(); } }),
      button('By consultant', { variant: view.tab === 'consultant' ? 'primary' : 'secondary', 'aria-pressed': String(view.tab === 'consultant'), onclick: () => { view.tab = 'consultant'; draw(); } }),
      button(view.showHeld ? `Hide held (${heldN} in interview)` : `Show held (${heldN} in interview)`, {
        variant: 'ghost', 'aria-pressed': String(view.showHeld), disabled: !heldN, onclick: () => { view.showHeld = !view.showHeld; res = run(); draw(); }
      }));
    body.append(view.tab === 'requirement' ? byRequirement(ctx, res.requirements) : byConsultant(ctx, res.consultants), notShownCard(ctx, res));
  }
  draw();
  const deskField = deskFilterField(ctx, (v) => { view.deskId = v; res = run(); draw(); });
  return h('div', { class: 'stack' },
    pageHeader('Matches'), sub,
    h('p', { class: 'hint' }, 'The same score as the extension: skills, title, location, visa, terms, rate and how new the requirement is. Consultants being marketed and available within 30 days; consultants in interview are held out until you show them, and a requirement hides consultants whose work authorisation it does not take (listed under Not shown). Requirements open and under 30 days old; the same role from several vendors is shown once.'),
    deskField ? h('div', { class: 'filters' }, deskField) : null, tabs, ctx.draftBox, body);
}
