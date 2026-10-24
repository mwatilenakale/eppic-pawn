/**
 * Lukas's book, over WhatsApp.
 *
 * The workbook did one thing the database did not: it let him *look* at his
 * loans — DASHBOARD, ACTIVE LOANS. Without that he keeps the spreadsheet open
 * alongside the system, and within a week there are two books that disagree.
 * This closes it, so the database can be the only one.
 *
 * Read-only, deliberately and structurally: there is no method here that
 * writes. Nothing in this module can approve an application, move money, or
 * change a loan — those need his reply to an application message, which is a
 * different path entirely (root CLAUDE.md).
 *
 * Every figure is summed from the ledger with reversals included, rather than
 * read from a stored total. A total that can drift from its entries is exactly
 * what the append-only ledger exists to prevent (architecture 2.7).
 */

import type { Store, Loan, Customer, User } from '../store/index.ts';
import { require as requireCapability } from '../staff/access.ts';
import { formatAmount } from '../money.ts';
import { addDays } from '../valuation.ts';
import { normalizePhone } from '../whatsapp/webhook.ts';
import { referenceFor } from '../reference.ts';

/** How far ahead *DUE* looks. A week is what fits in a WhatsApp message. */
const DUE_WINDOW_DAYS = 7;

/** Longest list any single reply will show before it summarises the rest. */
const MAX_ROWS = 12;

export interface LoanLine {
  loan: Loan;
  customer: Customer | null;
  /** What is still owed on it: principal plus interest, less anything repaid. */
  owedCents: number;
  /** Negative until the due date, positive after it. */
  daysPastDue: number;
  daysPastGrace: number;
}

export interface BookSummary {
  outOnLoanCents: number;
  activeLoans: number;
  activeCustomers: number;
  interestThisMonthCents: number;
  interestAllTimeCents: number;
  overdue: number;
  dueThisWeek: number;
}

export interface CustomerHistory {
  customer: Customer;
  timesBorrowed: number;
  everIssuedCents: number;
  interestPaidCents: number;
  outstandingCents: number;
  activeLoans: LoanLine[];
  everPastGrace: number;
  firstBorrowed: string | null;
}

export class Book {
  readonly #store: Store;
  readonly #today: () => string;

  constructor(store: Store, options: { clock?: () => Date } = {}) {
    this.#store = store;
    const clock = options.clock ?? (() => new Date());
    this.#today = () => clock().toISOString().slice(0, 10);
  }

  /** The date every "days past grace" is measured from. */
  today(): string {
    return this.#today();
  }

  // --- the figures ---------------------------------------------------------

  /**
   * The book-wide position.
   *
   * Staff may see this too as of 21 October 2026 — the check stays, because
   * the grant is what changed, not the shape of the guard. Guarded here rather
   * than in the template so that if the restriction ever comes back, the
   * figure is not computed on a staff code path at all and so cannot escape
   * through a layout change or a debug panel.
   */
  summary(viewer?: Pick<User, 'role'>): BookSummary {
    if (viewer !== undefined) requireCapability(viewer, 'book.totals', 'You cannot see the book total.');
    return this.#summary();
  }

  #summary(): BookSummary {
    const today = this.#today();
    const active = this.#activeLines();
    const month = today.slice(0, 7);

    return {
      outOnLoanCents: active.reduce((total, line) => total + line.owedCents, 0),
      activeLoans: active.length,
      activeCustomers: new Set(active.map((line) => line.loan.customer_id)).size,
      interestThisMonthCents: this.#interestCollected(month),
      interestAllTimeCents: this.#interestCollected(null),
      overdue: active.filter((line) => line.daysPastGrace > 0).length,
      dueThisWeek: active.filter((line) => line.loan.due_date >= today && line.loan.due_date <= addDays(today, DUE_WINDOW_DAYS)).length,
    };
  }

  /** Active loans falling due within the week, soonest first. */
  due(): LoanLine[] {
    const today = this.#today();
    const horizon = addDays(today, DUE_WINDOW_DAYS);
    return this.#activeLines()
      .filter((line) => line.loan.due_date >= today && line.loan.due_date <= horizon)
      .sort((left, right) => left.loan.due_date.localeCompare(right.loan.due_date));
  }

  /** Active loans past the grace period, longest overdue first. */
  overdue(): LoanLine[] {
    return this.#activeLines()
      .filter((line) => line.daysPastGrace > 0)
      .sort((left, right) => right.daysPastGrace - left.daysPastGrace);
  }

  /** In grace: past the due date but not yet past the grace period. */
  inGrace(): LoanLine[] {
    return this.#activeLines()
      .filter((line) => line.daysPastDue > 0 && line.daysPastGrace <= 0)
      .sort((left, right) => right.daysPastDue - left.daysPastDue);
  }

  /**
   * Everyone whose name or number matches. Returns the matches rather than
   * picking one: two customers can share a first name, and guessing which is
   * meant is how the wrong person's history ends up on screen.
   */
  findCustomers(query: string): Customer[] {
    const wanted = query.trim().toLowerCase();
    if (!wanted) return [];

    const digits = wanted.replace(/\D/g, '');
    // Lukas types the local form (081 111 0002); numbers are stored
    // international (+264811110002), so a substring match alone never hits.
    const international = digits.length >= 7 ? normalizePhone(wanted).replace(/\D/g, '') : null;

    return this.#store
      .customers()
      .filter((customer) => customer.merged_into == null)
      .filter((customer) => {
        if ((customer.name ?? '').toLowerCase().includes(wanted)) return true;
        if (digits.length < 4) return false;
        const theirs = customer.phone.replace(/\D/g, '');
        return theirs.includes(digits) || (international !== null && theirs === international);
      });
  }

  history(customerId: string): CustomerHistory | null {
    const customer = this.#store.customer(customerId);
    if (!customer) return null;

    const loans = this.#loansFor(customerId);
    const lines = loans.filter((loan) => loan.status === 'active').map((loan) => this.#line(loan));

    let everIssued = 0;
    let interestPaid = 0;
    let everPastGrace = 0;
    const today = this.#today();

    for (const loan of loans) {
      everIssued += loan.principal_cents;
      for (const entry of this.#store.ledger(loan.id)) {
        if (entry.entry_type.startsWith('repayment.interest')) interestPaid -= entry.amount_cents;
      }
      // A settled loan counts as late only if it was still owing after grace;
      // the imported book records no payment dates, so this reads the terms.
      if (loan.status === 'active' && loan.grace_ends_date < today) everPastGrace += 1;
    }

    return {
      customer,
      timesBorrowed: loans.length,
      everIssuedCents: everIssued,
      interestPaidCents: interestPaid,
      outstandingCents: lines.reduce((total, line) => total + line.owedCents, 0),
      activeLoans: lines,
      everPastGrace,
      firstBorrowed: loans.length > 0 ? loans.map((loan) => loan.start_date).sort()[0]! : null,
    };
  }

  // --- internals -----------------------------------------------------------

  #activeLines(): LoanLine[] {
    return (this.#store.db.prepare("SELECT * FROM loans WHERE status = 'active' ORDER BY due_date").all() as unknown as Loan[]).map(
      (loan) => this.#line(loan),
    );
  }

  #loansFor(customerId: string): Loan[] {
    return this.#store
      .db.prepare('SELECT * FROM loans WHERE customer_id = ? ORDER BY start_date')
      .all(customerId) as unknown as Loan[];
  }

  /**
   * One loan as a line, for callers working from a loan rather than a list —
   * the forfeiture flow starts from a reference, not from the book.
   */
  lineFor(loan: Loan): LoanLine {
    return this.#line(loan);
  }

  #line(loan: Loan): LoanLine {
    const today = this.#today();
    return {
      loan,
      customer: this.#store.customer(loan.customer_id),
      owedCents: this.#store.balance(loan.id),
      daysPastDue: daysBetween(loan.due_date, today),
      daysPastGrace: daysBetween(loan.grace_ends_date, today),
    };
  }

  /** Interest actually collected, from the entries — `null` for all time. */
  #interestCollected(month: string | null): number {
    const sql = month
      ? "SELECT COALESCE(SUM(amount_cents), 0) t FROM ledger_entries WHERE entry_type LIKE 'repayment.interest%' AND created_at LIKE ?"
      : "SELECT COALESCE(SUM(amount_cents), 0) t FROM ledger_entries WHERE entry_type LIKE 'repayment.interest%'";
    const row = (month ? this.#store.db.prepare(sql).get(`${month}%`) : this.#store.db.prepare(sql).get()) as { t: number };
    const collected = Number(row.t);
    // Repayments are stored negative; flipping the sign of zero gives -0.
    return collected === 0 ? 0 : -collected;
  }
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// --- what Lukas actually reads on his phone --------------------------------

export function renderSummary(summary: BookSummary, today: string): string {
  return [
    `*The book — ${today}*`,
    '',
    `Out on loan: *${formatAmount(summary.outOnLoanCents)}*`,
    `Active loans: ${summary.activeLoans} (${summary.activeCustomers} customer${summary.activeCustomers === 1 ? '' : 's'})`,
    `Due this week: ${summary.dueThisWeek}`,
    `Past grace: ${summary.overdue}`,
    '',
    `Interest collected this month: ${formatAmount(summary.interestThisMonthCents)}`,
    `Interest collected all time: ${formatAmount(summary.interestAllTimeCents)}`,
    '',
    '_Out on loan is principal plus interest still owed, summed from the ledger._',
    'Send *DUE*, *OVERDUE*, or *CUSTOMER <name or number>*.',
  ].join('\n');
}

export function renderDue(lines: LoanLine[], today: string): string {
  if (lines.length === 0) return `Nothing falls due in the next ${DUE_WINDOW_DAYS} days.`;

  const rows = lines.slice(0, MAX_ROWS).map((line) => {
    const days = daysBetween(today, line.loan.due_date);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    return `• ${nameOf(line)} — ${formatAmount(line.owedCents)}, due ${when} (${line.loan.due_date})`;
  });

  return [`*Due in the next ${DUE_WINDOW_DAYS} days — ${lines.length}*`, '', ...rows, ...more(lines)].join('\n');
}

export function renderOverdue(lines: LoanLine[], inGrace: LoanLine[]): string {
  if (lines.length === 0 && inGrace.length === 0) return 'Nothing is past its due date.';

  const parts: string[] = [];

  if (inGrace.length > 0) {
    parts.push(`*In grace — ${inGrace.length}*`, '');
    for (const line of inGrace.slice(0, MAX_ROWS)) {
      parts.push(`• ${nameOf(line)} — ${formatAmount(line.owedCents)}, grace ends ${line.loan.grace_ends_date}`);
    }
    parts.push(...more(inGrace), '');
  }

  if (lines.length > 0) {
    const total = lines.reduce((sum, line) => sum + line.owedCents, 0);
    parts.push(`*Past grace — ${lines.length}, ${formatAmount(total)} owed*`, '');
    for (const line of lines.slice(0, MAX_ROWS)) {
      // With a reference, because the only thing he can do from here is
      // decide about one of them, and SELL needs something to name.
      parts.push(
        `• ${referenceFor(line.loan.id)} — ${nameOf(line)}, ${formatAmount(line.owedCents)}, ` +
          `${line.daysPastGrace} days past grace`,
      );
    }
    parts.push(...more(lines));
    parts.push(
      '',
      // Playbook section 8: outreach first, then the margin check decides
      // between extending a month and selling. The check needs the item's
      // assessed value against its market value today — figures the workbook
      // never held, so this prompts the step rather than pretending to do it.
      '_Playbook section 8: reach out first. Before selling anything, run the margin check — assessed value plus interest owed against what it would fetch today._',
      '',
      'Send *SELL <ref>* to put one on the market — it tells you the margin and the customer can still redeem until it goes.',
    );
  }

  return parts.join('\n');
}

export function renderHistory(history: CustomerHistory): string {
  const { customer } = history;
  const lines = [
    `*${customer.name ?? 'Name not recorded'}*`,
    customer.phone.startsWith('workbook:') ? '_No phone number — imported from the workbook._' : customer.phone,
    '',
    `Times borrowed: ${history.timesBorrowed}${history.firstBorrowed ? ` since ${history.firstBorrowed}` : ''}`,
    `Ever issued: ${formatAmount(history.everIssuedCents)}`,
    `Interest paid: ${formatAmount(history.interestPaidCents)}`,
  ];

  if (history.activeLoans.length === 0) {
    lines.push('', 'Nothing outstanding.');
  } else {
    lines.push('', `*Outstanding: ${formatAmount(history.outstandingCents)}*`);
    for (const line of history.activeLoans.slice(0, MAX_ROWS)) {
      const state = line.daysPastGrace > 0 ? `${line.daysPastGrace} days past grace` : `due ${line.loan.due_date}`;
      lines.push(`• ${formatAmount(line.owedCents)} — ${state}`);
    }
  }

  if (history.everPastGrace > 0) {
    lines.push('', `⚠️ ${history.everPastGrace} of their loans ${history.everPastGrace === 1 ? 'is' : 'are'} past grace right now.`);
  }

  return lines.join('\n');
}

/**
 * Several people match. Deliberately stateless: it asks him to send the phone
 * number rather than "reply 2", because a bare number arriving from his phone
 * has to stay unambiguous — an approval amount must never be read as a menu
 * choice, or the other way round.
 */
export function renderCustomerChoices(matches: Customer[], query: string): string {
  if (matches.length === 0) return `Nobody matching "${query}". Try part of a name, or the phone number.`;
  return [
    `${matches.length} people match "${query}" — send *CUSTOMER* with the number:`,
    '',
    ...matches.slice(0, MAX_ROWS).map((customer) => `• ${customer.name ?? 'name not recorded'} — ${customer.phone}`),
    ...(matches.length > MAX_ROWS ? ['', `_…and ${matches.length - MAX_ROWS} more._`] : []),
  ].join('\n');
}

export type BookCommand =
  | { kind: 'summary' }
  | { kind: 'due' }
  | { kind: 'overdue' }
  | { kind: 'customer'; query: string };

/**
 * Reads one of the book commands, or nothing.
 *
 * Narrow on purpose, and checked before the approval parser: these are the
 * only words it answers to, so an ordinary reply can never be swallowed as a
 * query, and a query can never be mistaken for a decision.
 */
export function parseBookCommand(text: string): BookCommand | null {
  const trimmed = text.trim();

  if (/^(book|summary|dashboard)\b\W*$/i.test(trimmed)) return { kind: 'summary' };
  if (/^due\b\W*$/i.test(trimmed)) return { kind: 'due' };
  if (/^(overdue|late|arrears)\b\W*$/i.test(trimmed)) return { kind: 'overdue' };

  const customer = /^(?:customer|who)\b\s*(.*)$/i.exec(trimmed);
  if (customer) return { kind: 'customer', query: customer[1]!.trim() };

  return null;
}

function nameOf(line: LoanLine): string {
  return line.customer?.name ?? line.customer?.phone ?? 'unknown customer';
}

function more(lines: LoanLine[]): string[] {
  return lines.length > MAX_ROWS ? ['', `_…and ${lines.length - MAX_ROWS} more._`] : [];
}
