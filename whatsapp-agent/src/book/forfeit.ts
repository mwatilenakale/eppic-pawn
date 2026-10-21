/**
 * Sending an item to market — playbook section 8.
 *
 * Grace runs out after four days. From then on the item *may* be sold, and
 * whether it is, is Lukas's decision on that item. The playbook is explicit
 * that nothing is ever sold automatically: a loan going quiet does not
 * forfeit on a timer, and this module has no clock-driven path at all.
 *
 * What it does provide is the margin check from section 8 step 3, so the
 * decision is made against the arithmetic rather than a feeling, and a record
 * of who decided and when.
 *
 * Marking an item for market is not selling it. The customer may still redeem
 * until it is actually gone — the contract says so — so this is reversible
 * with KEEP while the item is still in the shop.
 */

import type { Rules } from '../playbook/index.ts';
import type { Loan, Store, User } from '../store/index.ts';
import { can } from '../staff/access.ts';
import { formatAmount } from '../money.ts';
import { referenceFor } from '../reference.ts';
import type { Book, LoanLine } from './index.ts';

/** `SELL K3P9`, `KEEP K3P9`, `SELL K3P9 margin gone`. */
export interface ForfeitCommand {
  action: 'sell' | 'keep';
  reference: string | null;
  note: string;
}

const SELL = /^\s*(sell|market|forfeit)\b/i;
const KEEP = /^\s*(keep|unsell|hold)\b/i;

export function parseForfeitCommand(text: string): ForfeitCommand | null {
  const trimmed = text.trim();
  const sell = SELL.test(trimmed);
  const keep = KEEP.test(trimmed);
  if (!sell && !keep) return null;

  const rest = trimmed.replace(sell ? SELL : KEEP, '').trim();
  const reference = /^([A-Z][A-Z0-9]{3})\b/.exec(rest.toUpperCase());

  return {
    action: sell ? 'sell' : 'keep',
    reference: reference ? reference[1]! : null,
    note: (reference ? rest.slice(reference[1]!.length) : rest).replace(/^[\s,:—-]+/, '').trim(),
  };
}

/**
 * Section 8 step 3, for one loan.
 *
 * Honest about what it is: the comparison the playbook describes uses the
 * *current* market value, and nobody here has one — there is no live price
 * feed and asking an LLM what a two-year-old phone is worth today is not a
 * market check. This uses the assessed value from intake, which is what the
 * shop actually has on record, and says so.
 */
export interface MarginCheck {
  owedCents: number;
  assessedValueCents: number | null;
  /** How much of the assessed value is left after what is owed, as a percent. */
  marginPct: number | null;
  /** What the playbook says to do at that margin. */
  playbookSays: 'extend' | 'sell' | 'unknown';
  thresholdPct: number;
}

export function marginFor(store: Store, rules: Rules, line: LoanLine): MarginCheck {
  const threshold = rules.playbook.collections.marginThresholdPct;
  const valuation = store.db
    .prepare('SELECT assessed_value_cents FROM valuations WHERE item_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(line.loan.item_id) as { assessed_value_cents: number } | undefined;

  if (!valuation) {
    return {
      owedCents: line.owedCents,
      assessedValueCents: null,
      marginPct: null,
      playbookSays: 'unknown',
      thresholdPct: threshold,
    };
  }

  const assessed = valuation.assessed_value_cents;
  const marginPct = assessed > 0 ? ((assessed - line.owedCents) / assessed) * 100 : 0;

  return {
    owedCents: line.owedCents,
    assessedValueCents: assessed,
    marginPct,
    playbookSays: marginPct >= threshold ? 'extend' : 'sell',
    thresholdPct: threshold,
  };
}

export interface ForfeitResult {
  ownerMessage: string;
  customerMessage?: string;
  customerPhone?: string;
}

export class Forfeiture {
  readonly #store: Store;
  readonly #rules: Rules;
  readonly #book: Book;

  constructor(store: Store, rules: Rules, book: Book) {
    this.#store = store;
    this.#rules = rules;
    this.#book = book;
  }

  /** Loans past grace, which are the only ones that may be sent to market. */
  sellable(): LoanLine[] {
    return this.#book.overdue();
  }

  run(command: ForfeitCommand, owner: User): ForfeitResult {
    // Same gate as every other decision about money. Staff can see the past
    // grace list; they cannot act on it.
    if (!can(owner, 'approvals.decide')) {
      return { ownerMessage: 'Only Lukas can send an item to market.' };
    }

    return command.action === 'sell' ? this.#sell(command, owner) : this.#keep(command, owner);
  }

  #sell(command: ForfeitCommand, owner: User): ForfeitResult {
    const candidates = this.sellable();
    const line = this.#pick(candidates, command.reference);
    if (typeof line === 'string') return { ownerMessage: line };

    const margin = marginFor(this.#store, this.#rules, line);
    this.#store.forfeitLoan({
      loanId: line.loan.id,
      actor: owner.id,
      note: command.note,
      marginPct: margin.marginPct,
    });

    const item = this.#store.item(line.loan.item_id);
    const customer = line.customer;

    // Where the playbook disagrees with what he just did, that leads. His
    // call either way — the arithmetic is guidance, not a veto — but it should
    // be the first thing he reads, not buried under a confirmation.
    const disagrees =
      margin.playbookSays === 'extend'
        ? `⚠️ *Section 8 says extend, not sell* — about ${Math.round(margin.marginPct!)}% of the assessed value is still clear.\n\n`
        : '';

    return {
      ownerMessage:
        disagrees +
        `${nameOf(line)}'s ${item?.description || 'item'} is marked for market.\n` +
        `${formatAmount(line.owedCents)} owed, ${line.daysPastGrace} days past grace.\n` +
        `${marginLine(margin)}\n\n` +
        "They've been told, and they can still redeem it until it's actually sold. " +
        `Changed your mind? *KEEP ${referenceFor(line.loan.id)}*.`,
      customerPhone: customer?.phone,
      customerMessage: customer
        ? `Your loan with Eppic Pawn Shop is now ${line.daysPastGrace} days past the grace period, and ` +
          `${formatAmount(line.owedCents)} is owed.\n\n` +
          `Your ${item?.description || 'item'} is being prepared for sale. You can still collect it by paying ` +
          `${formatAmount(line.owedCents)} in full, up until it is actually sold — please come in or reply here ` +
          'if you want to arrange that.'
        : undefined,
    };
  }

  #keep(command: ForfeitCommand, owner: User): ForfeitResult {
    const forfeited = this.#store.forfeitedLoans();
    const line = this.#pick(forfeited.map((loan) => this.#book.lineFor(loan)), command.reference);
    if (typeof line === 'string') return { ownerMessage: line };

    this.#store.unforfeitLoan(line.loan.id, owner.id);
    const item = this.#store.item(line.loan.item_id);

    return {
      ownerMessage: `${nameOf(line)}'s ${item?.description || 'item'} is off the market list and back on the book.`,
    };
  }

  /** One loan by reference, or the message explaining why not. */
  #pick(lines: LoanLine[], reference: string | null): LoanLine | string {
    if (lines.length === 0) return 'Nothing is past grace right now.';

    if (!reference) {
      if (lines.length === 1) return lines[0]!;
      return (
        `${lines.length} are past grace — say which:\n` +
        lines
          .map((line) => `• ${referenceFor(line.loan.id)} — ${nameOf(line)}, ${formatAmount(line.owedCents)}`)
          .join('\n')
      );
    }

    const found = lines.find((line) => referenceFor(line.loan.id) === reference);
    return found ?? `Nothing past grace under reference ${reference}.`;
  }
}

/** The margin check as a sentence, with its limitation stated. */
export function marginLine(margin: MarginCheck): string {
  if (margin.assessedValueCents === null) {
    return 'No valuation on record for this one, so the playbook margin check cannot be run — check a current price yourself before selling.';
  }

  const left = Math.round(margin.marginPct!);
  const verdict =
    margin.playbookSays === 'extend'
      ? `about ${left}% of the assessed value is still clear, so section 8 says extend a month rather than sell`
      : `only about ${left}% is clear, under the ${margin.thresholdPct}% line, so section 8 says sell`;

  return (
    `Assessed at ${formatAmount(margin.assessedValueCents)} when it came in — ${verdict}. ` +
    'That is against the intake valuation, not a fresh market price: check what it would actually fetch today.'
  );
}

function nameOf(line: LoanLine): string {
  return line.customer?.name ?? line.customer?.phone ?? 'Unknown';
}
