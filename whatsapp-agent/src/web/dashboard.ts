/**
 * The dashboard, rendered.
 *
 * Lukas asked for three things by name: how many deals are outstanding for the
 * day, what documents are still missing, and who has been through the
 * pre-screen with everything uploaded and is now only expected to walk in.
 * Those are the first three lists on the page, in that order.
 *
 * Every figure on it comes from `DashboardQuery`, which only reads. This file
 * does no arithmetic beyond formatting — a page that computes a total is a
 * second source of truth waiting to disagree with the ledger.
 */

import { escapeHtml } from '../html.ts';
import { formatAmount } from '../money.ts';
import { BUSINESS } from '../contract/document.ts';
import { DASHBOARD_CSS, THEME } from './theme.ts';
import type { CategoryQuestion, Dashboard, DealLine, WaitingOnAPerson } from '../dashboard/index.ts';
import type { LoanLine } from '../book/index.ts';

export function dashboardPage(dashboard: Dashboard, staffName: string, canSeeTotals: boolean): string {
  const needsLukas =
    dashboard.awaitingDecision.length +
    dashboard.awaitingCategoryAnswer.length +
    dashboard.waitingOnAPerson.length;

  return shell(
    'Today — Eppic Pawn Shop',
    `
<div class="dash-head">
  <h1>Today</h1>
  <span class="muted">${escapeHtml(dashboard.today.date)} · ${escapeHtml(staffName.split(' ')[0] ?? staffName)}</span>
</div>

<div class="tiles">
  ${tile(needsLukas, 'waiting on Lukas', needsLukas > 0)}
  ${tile(dashboard.readyForTheOffice.length, 'ready to come in', false)}
  ${tile(dashboard.missingDocuments.length, 'missing documents', false)}
  ${tile(dashboard.today.started, 'started today', false)}
</div>

${section(
  'Waiting on Lukas',
  dashboard.awaitingDecision.length,
  dashboard.awaitingDecision.map((deal) => dealRow(deal, 'row-urgent')),
  'Nothing is waiting on a decision.',
  dashboard.awaitingDecision.length > 0,
)}

${section(
  'Can we take this?',
  dashboard.awaitingCategoryAnswer.length,
  dashboard.awaitingCategoryAnswer.map(categoryRow),
  'No out-of-category items are waiting on an answer.',
  dashboard.awaitingCategoryAnswer.length > 0,
)}

${section(
  'Waiting on a person',
  dashboard.waitingOnAPerson.length,
  dashboard.waitingOnAPerson.map(personRow),
  'The agent is handling every conversation.',
  dashboard.waitingOnAPerson.length > 0,
)}

${section(
  'Ready for the office',
  dashboard.readyForTheOffice.length,
  dashboard.readyForTheOffice.map((deal) => dealRow(deal, 'row-good')),
  'Nobody is approved and waiting to come in.',
  false,
)}

${section(
  'Still missing documents',
  dashboard.missingDocuments.length,
  dashboard.missingDocuments.map((deal) => dealRow(deal, '')),
  'Every open application has everything it needs.',
  false,
)}

<div class="section">
  <h2>In the shop</h2>
  <div class="rows">
    <div class="row">
      <div class="row-top"><span class="row-who">Inspections to do</span><span class="row-when">${dashboard.inspections.waiting}</span></div>
      <div class="row-what">Being worked on now: ${dashboard.inspections.inHand}</div>
    </div>
  </div>
</div>

${canSeeTotals ? book(dashboard) : ''}
`,
  );
}

// --- the pieces ------------------------------------------------------------

function tile(value: number, label: string, urgent: boolean): string {
  return `<div class="tile">
    <div class="tile-value"${urgent ? ' style="color: var(--accent-gold)"' : ''}>${value}</div>
    <div class="tile-label">${escapeHtml(label)}</div>
  </div>`;
}

function section(heading: string, count: number, rows: string[], empty: string, urgent: boolean): string {
  const badge = count > 0 ? `<span class="count${urgent ? ' count-urgent' : ''}">${count}</span>` : '';
  return `<div class="section">
  <h2>${escapeHtml(heading)}${badge}</h2>
  ${rows.length > 0 ? `<div class="rows">${rows.join('')}</div>` : `<div class="empty">${escapeHtml(empty)}</div>`}
</div>`;
}

function dealRow(deal: DealLine, modifier: string): string {
  const reference = deal.reference ? `<span class="ref">${escapeHtml(deal.reference)}</span> · ` : '';
  const have = deal.photos.map((kind) => `<span class="chip chip-have">${escapeHtml(kind)}</span>`).join('');
  const missing = deal.missingDocuments
    .map((what: string) => `<span class="chip chip-missing">${escapeHtml(what)}</span>`)
    .join('');
  // Counted, not listed: thirteen screening questions as chips made the row
  // longer than the screen and buried the documents, which are the part
  // somebody actually has to chase.
  const questions =
    deal.unansweredQuestions > 0
      ? `<span class="chip chip-missing">${deal.unansweredQuestions} question${deal.unansweredQuestions === 1 ? '' : 's'} unanswered</span>`
      : '';

  return `<div class="row ${modifier}">
    <div class="row-top">
      <span class="row-who">${escapeHtml(deal.customerName)}</span>
      <span class="row-when">${escapeHtml(waited(deal.waitingHours))}</span>
    </div>
    <div class="row-what">${escapeHtml(deal.description)}</div>
    <div class="row-meta">${reference}${escapeHtml(deal.category)} · ${escapeHtml(deal.customerPhone)}</div>
    ${have || missing || questions ? `<div class="chips">${missing}${questions}${have}</div>` : ''}
  </div>`;
}

function categoryRow(question: CategoryQuestion): string {
  return `<div class="row row-urgent">
    <div class="row-top">
      <span class="row-who">${escapeHtml(question.customerName)}</span>
      <span class="row-when">${escapeHtml(waited(question.waitingHours))}</span>
    </div>
    <div class="row-what">${escapeHtml(question.description)}</div>
    <div class="row-meta">Reply <span class="ref">ACCEPT ${escapeHtml(question.reference)}</span>
      or <span class="ref">REFUSE ${escapeHtml(question.reference)}</span> on WhatsApp</div>
  </div>`;
}

function personRow(waiting: WaitingOnAPerson): string {
  return `<div class="row row-urgent">
    <div class="row-top">
      <span class="row-who">${escapeHtml(waiting.customerName)}</span>
      <span class="row-when">${escapeHtml(waited(waiting.waitingHours))}</span>
    </div>
    <div class="row-what">${escapeHtml(waiting.reason)}</div>
    <div class="row-meta">${waiting.heldByName ? `With ${escapeHtml(waiting.heldByName)}` : 'Nobody has picked this up yet'}
      · ${escapeHtml(waiting.customerPhone)}</div>
  </div>`;
}

/**
 * The book. Shown because staff hold `book.totals` as of 21 October 2026; the
 * flag is still threaded through so putting the restriction back is a change
 * in one place rather than a hunt through the templates.
 */
function book(dashboard: Dashboard): string {
  const lines = (loans: LoanLine[], modifier: string) =>
    loans
      .map(
        (line) => `<div class="row ${modifier}">
      <div class="row-top">
        <span class="row-who">${escapeHtml(line.customer?.name ?? 'Unknown')}</span>
        <span class="row-when">${escapeHtml(formatAmount(line.owedCents))}</span>
      </div>
      <div class="row-meta">due ${escapeHtml(line.loan.due_date)}${
        line.daysPastGrace > 0 ? ` · ${line.daysPastGrace} days past grace` : ''
      }</div>
    </div>`,
      )
      .join('');

  return `<div class="section">
  <h2>The book</h2>
  <div class="tiles">
    <div class="tile"><div class="tile-value" style="font-size: 20px">${escapeHtml(formatAmount(dashboard.book.outOnLoanCents))}</div><div class="tile-label">out on loan</div></div>
    <div class="tile"><div class="tile-value">${dashboard.book.activeLoans}</div><div class="tile-label">active loans</div></div>
    <div class="tile"><div class="tile-value">${dashboard.dueThisWeek.length}</div><div class="tile-label">due this week</div></div>
    <div class="tile"><div class="tile-value"${dashboard.pastGrace.length > 0 ? ' style="color: var(--danger)"' : ''}>${dashboard.pastGrace.length}</div><div class="tile-label">past grace</div></div>
  </div>
  <p class="muted">Interest collected this month ${escapeHtml(formatAmount(dashboard.book.interestThisMonthCents))}
    · all time ${escapeHtml(formatAmount(dashboard.book.interestAllTimeCents))}</p>
</div>

${section('Past grace', dashboard.pastGrace.length, [lines(dashboard.pastGrace, 'row-bad')].filter(Boolean), 'Nobody is past grace.', dashboard.pastGrace.length > 0)}
${section('In grace', dashboard.inGrace.length, [lines(dashboard.inGrace, '')].filter(Boolean), 'Nobody is in grace.', false)}
${section('Due this week', dashboard.dueThisWeek.length, [lines(dashboard.dueThisWeek, '')].filter(Boolean), 'Nothing falls due this week.', false)}`;
}

/** "3h" / "2 days" — a wait is easier to judge than a timestamp. */
function waited(hours: number): string {
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<style>${THEME}${DASHBOARD_CSS}</style>
</head>
<body><div class="container">
${body}
<footer>${escapeHtml(BUSINESS.tradingAs)} · staff only<br>
Approvals and prices are Lukas's, and are made over WhatsApp.</footer>
</div></body>
</html>`;
}
