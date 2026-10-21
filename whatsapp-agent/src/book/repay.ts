/**
 * Taking the money back — docs/tasks/006.
 *
 * Until this existed a loan could be created, accrue interest, be extended and
 * be sent to market, but never paid. The ordinary, commonest, happiest ending
 * of a pawn loan was the one path missing: every loan stayed on the book as
 * outstanding forever, BOOK overstated what was out on loan from the first
 * repayment onward, and OVERDUE would have chased somebody who settled in full
 * last week.
 *
 * Interest is paid before principal. That is not a detail — it is what makes
 * "interest collected this month" mean anything, and the book already reads
 * `repayment.interest` entries to report it. A payment that came off principal
 * first would make the shop look like it had earned nothing.
 */

import type { Rules } from '../playbook/index.ts';
import type { Loan, Store, User } from '../store/index.ts';
import { can } from '../staff/access.ts';
import { formatAmount, parseAmount } from '../money.ts';
import { referenceFor } from '../reference.ts';
import type { Book, LoanLine } from './index.ts';

/** `PAID K3P9 1500`, `PAID K3P9` for the whole balance. */
export interface RepayCommand {
  reference: string | null;
  /** Null means "all of it" — the common case at the counter. */
  amountCents: number | null;
  note: string;
}

const PAID = /^\s*(paid|payment|repaid|settled|collect(?:ed)?)\b/i;

export function parseRepayCommand(text: string): RepayCommand | null {
  const trimmed = text.trim();
  if (!PAID.test(trimmed)) return null;

  const rest = trimmed.replace(PAID, '').trim();
  const reference = /^([A-Z][A-Z0-9]{3})\b/.exec(rest.toUpperCase());
  const after = (reference ? rest.slice(reference[1]!.length) : rest).replace(/^[\s,:—-]+/, '').trim();

  // The amount is the leading figure, if there is one. Anything after it is a
  // note: "PAID K3P9 1500 rest on Friday".
  const figure = /^([\d\s,.]+)/.exec(after);
  const amountCents = figure ? parseAmount(figure[1]!.trim()) : null;

  return {
    reference: reference ? reference[1]! : null,
    amountCents,
    note: (figure && amountCents !== null ? after.slice(figure[1]!.length) : after).replace(/^[\s,:—-]+/, '').trim(),
  };
}

/** How a payment divides, before anything is written. */
export interface Split {
  /** What is owed in total right now. */
  owedCents: number;
  /** Of that, the part that is interest. */
  interestOwedCents: number;
  principalOwedCents: number;
  /** What this payment takes off each, interest first. */
  toInterestCents: number;
  toPrincipalCents: number;
  /** What is left afterwards. Zero means the loan closes. */
  remainingCents: number;
  settles: boolean;
}

/**
 * Splits a payment across what is owed, interest first.
 *
 * Both halves are summed from the ledger rather than recomputed from a rate:
 * the loan may have been extended, which posts a second interest entry, and a
 * percentage of the principal would silently miss it.
 */
export function splitPayment(store: Store, loanId: string, payingCents: number): Split {
  const entries = store.ledger(loanId);
  const sum = (match: (type: string) => boolean) =>
    entries.filter((entry) => match(entry.entry_type)).reduce((total, entry) => total + entry.amount_cents, 0);

  // Charges are positive, repayments negative, so each side nets out.
  const interestOwedCents = sum((type) => type.startsWith('interest') || type.startsWith('repayment.interest'));
  const principalOwedCents = sum((type) => type.startsWith('principal') || type.startsWith('repayment.principal'));
  const owedCents = interestOwedCents + principalOwedCents;

  const toInterestCents = Math.min(payingCents, Math.max(0, interestOwedCents));
  const toPrincipalCents = Math.min(payingCents - toInterestCents, Math.max(0, principalOwedCents));
  const remainingCents = owedCents - toInterestCents - toPrincipalCents;

  return {
    owedCents,
    interestOwedCents,
    principalOwedCents,
    toInterestCents,
    toPrincipalCents,
    remainingCents,
    settles: remainingCents === 0,
  };
}

export interface RepayResult {
  ownerMessage: string;
  customerMessage?: string;
  customerPhone?: string;
}

export class Repayments {
  readonly #store: Store;
  readonly #rules: Rules;
  readonly #book: Book;

  constructor(store: Store, rules: Rules, book: Book) {
    this.#store = store;
    this.#rules = rules;
    this.#book = book;
  }

  /**
   * Loans a payment could be recorded against.
   *
   * A forfeited loan is included on purpose. The contract says the customer
   * may redeem until the item is actually sold, and `SELL` tells them so in
   * those words — so the one case where redemption matters most must not be
   * the case the command refuses.
   */
  payable(): LoanLine[] {
    return this.#store.db
      .prepare("SELECT * FROM loans WHERE status IN ('active', 'forfeited') ORDER BY due_date")
      .all()
      .map((loan) => this.#book.lineFor(loan as unknown as Loan))
      .filter((line) => line.owedCents > 0);
  }

  run(command: RepayCommand, owner: User): RepayResult {
    if (!can(owner, 'approvals.decide')) {
      return { ownerMessage: 'Only the owner can record a payment.' };
    }

    const candidates = this.payable();
    if (candidates.length === 0) return { ownerMessage: 'Nothing is outstanding right now.' };

    const line = command.reference
      ? candidates.find((entry) => referenceFor(entry.loan.id) === command.reference)
      : candidates.length === 1
        ? candidates[0]
        : undefined;

    if (!line) {
      if (!command.reference) {
        return {
          ownerMessage:
            `${candidates.length} loans are outstanding — say which:\n` +
            candidates
              .map((entry) => `• ${referenceFor(entry.loan.id)} — ${nameOf(entry)}, ${formatAmount(entry.owedCents)}`)
              .join('\n'),
        };
      }
      return { ownerMessage: `Nothing outstanding under reference ${command.reference}.` };
    }

    const paying = command.amountCents ?? line.owedCents;
    if (paying <= 0) {
      return { ownerMessage: `That is not an amount I can record. *PAID ${referenceFor(line.loan.id)} <amount>*.` };
    }

    // Refused rather than absorbed. An overpayment is nearly always a typo —
    // a missed decimal point — and recording it would leave a loan with a
    // negative balance, which is a number nobody can explain later.
    if (paying > line.owedCents) {
      return {
        ownerMessage:
          `${nameOf(line)} owes ${formatAmount(line.owedCents)}, and you have put in ${formatAmount(paying)}.\n\n` +
          'I have not recorded it. Send the exact amount, or *PAID ' +
          `${referenceFor(line.loan.id)}* on its own to settle it in full.`,
      };
    }

    return this.#record(line, paying, command.note, owner);
  }

  #record(line: LoanLine, payingCents: number, note: string, owner: User): RepayResult {
    const split = splitPayment(this.#store, line.loan.id, payingCents);
    const settled = this.#store.recordRepayment({
      loanId: line.loan.id,
      interestCents: split.toInterestCents,
      principalCents: split.toPrincipalCents,
      actor: owner.id,
      note,
      settles: split.settles,
    });

    const item = this.#store.item(line.loan.item_id);
    const what = item?.description || 'item';

    if (split.settles) {
      return {
        ownerMessage:
          `${nameOf(line)} is square — ${formatAmount(payingCents)} received` +
          (split.toInterestCents > 0 ? `, ${formatAmount(split.toInterestCents)} of it interest` : '') +
          '.\n' +
          `${what} is theirs to collect; it is off the book.` +
          (settled.status === 'paid' ? '' : `\n\n(Loan still reads ${settled.status} — that is a bug, tell Claude.)`),
        customerPhone: line.customer?.phone,
        customerMessage: line.customer
          ? `Received, thank you — ${formatAmount(payingCents)}, and your loan is settled in full.\n\n` +
            `Your ${what} is ready to collect. Bring your ID and we will hand it over.`
          : undefined,
      };
    }

    return {
      ownerMessage:
        `${formatAmount(payingCents)} from ${nameOf(line)} — ` +
        (split.toInterestCents > 0 ? `${formatAmount(split.toInterestCents)} interest, ` : '') +
        `${formatAmount(split.toPrincipalCents)} principal.\n` +
        `${formatAmount(split.remainingCents)} still owing${this.#compounds() ? '' : ', and no further interest is added for a part payment'}.\n` +
        `Due ${line.loan.due_date}.`,
      customerPhone: line.customer?.phone,
      customerMessage: line.customer
        ? `Received, thank you — ${formatAmount(payingCents)} off your ${what}.\n\n` +
          `${formatAmount(split.remainingCents)} is still owing, due ${line.loan.due_date}. ` +
          'The item stays with us until it is settled in full.'
        : undefined,
    };
  }

  /** Playbook section 4 decides this, not us. */
  #compounds(): boolean {
    return this.#rules.playbook.partialPaymentCompounds;
  }
}

function nameOf(line: LoanLine): string {
  return line.customer?.name ?? line.customer?.phone ?? 'Unknown';
}
