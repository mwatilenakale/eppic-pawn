/**
 * Extending a loan by a month — playbook section 8 step 3, the 70% line.
 *
 * A customer who has not settled and asks for another month. The test Lukas
 * stated: add the next month's interest to everything already owed, and
 * compare that total against the item's **current market value**. At or below
 * 70% the extension may be granted; above it, the item goes to market instead.
 *
 * The reasoning behind the line is step 5 of the same section — a forfeited
 * item is priced to sell in a day or two, not for the best price. At 70% there
 * is room to recover what is owed from a quick sale. Past it, every further
 * month makes the position worse rather than better, which is the opposite of
 * what an extension is for.
 *
 * Passing the test permits an extension. It does not grant one: that is
 * Lukas's reply, like everything else here.
 */

import type { Rules } from '../playbook/index.ts';
import type { Loan, Store, User } from '../store/index.ts';
import type { MarketEstimate } from '../valuation.ts';
import { can } from '../staff/access.ts';
import { formatAmount, percentOf } from '../money.ts';
import { referenceFor } from '../reference.ts';
import { addDays, loanTerms } from '../valuation.ts';
import { marginFor, marginLine } from './forfeit.ts';
import type { Book, LoanLine } from './index.ts';

/** `EXTEND K3P9`, `EXTEND` when only one loan is in question. */
export interface ExtendCommand {
  reference: string | null;
  note: string;
}

const EXTEND = /^\s*(extend|extension|another month|roll ?over)\b/i;

export function parseExtendCommand(text: string): ExtendCommand | null {
  const trimmed = text.trim();
  if (!EXTEND.test(trimmed)) return null;

  const rest = trimmed.replace(EXTEND, '').trim();
  const reference = /^([A-Z][A-Z0-9]{3})\b/.exec(rest.toUpperCase());

  return {
    reference: reference ? reference[1]! : null,
    note: (reference ? rest.slice(reference[1]!.length) : rest).replace(/^[\s,:—-]+/, '').trim(),
  };
}

export interface ExtensionTest {
  /** Everything owed now: principal plus every month of interest so far. */
  owedCents: number;
  /** What another month would add. */
  nextInterestCents: number;
  /** Owed plus that — the figure the test is on. */
  wouldOweCents: number;
  /** Current market value, as estimated now. Null when nobody could say. */
  marketValueCents: number | null;
  /** 70% of it, from the playbook. */
  ceilingCents: number | null;
  ceilingPct: number;
  /** True when the extension is allowed at all. Null when unknown. */
  allowed: boolean | null;
}

/**
 * The test, for one loan.
 *
 * `marketValueCents` is whatever the caller could find out — a fresh estimate
 * at the moment of asking, not the value from intake. The playbook says
 * *current* market value and it means it: an extension is a new lending
 * decision on a months-old item, and the figure from when it came in is the
 * one number guaranteed to be wrong by now.
 */
export function extensionTest(
  rules: Rules,
  line: LoanLine,
  marketValueCents: number | null,
): ExtensionTest {
  const ceilingPct = rules.playbook.collections.extensionCeilingPct;
  const nextInterestCents = percentOf(line.loan.principal_cents, line.loan.rate_pct);
  const wouldOweCents = line.owedCents + nextInterestCents;

  if (marketValueCents === null || marketValueCents <= 0) {
    return {
      owedCents: line.owedCents,
      nextInterestCents,
      wouldOweCents,
      marketValueCents: null,
      ceilingCents: null,
      ceilingPct,
      allowed: null,
    };
  }

  const ceilingCents = percentOf(marketValueCents, ceilingPct);
  return {
    owedCents: line.owedCents,
    nextInterestCents,
    wouldOweCents,
    marketValueCents,
    ceilingCents,
    ceilingPct,
    allowed: wouldOweCents <= ceilingCents,
  };
}

export interface ExtendResult {
  ownerMessage: string;
  customerMessage?: string;
  customerPhone?: string;
}

/** Supplies a current market value. The router's valuator, or nothing. */
export interface MarketValuer {
  estimate(input: { description: string; categorySlug: string; variant: string | null }): Promise<MarketEstimate[]>;
}

export class Extensions {
  readonly #store: Store;
  readonly #rules: Rules;
  readonly #book: Book;
  readonly #valuer: MarketValuer | null;

  constructor(store: Store, rules: Rules, book: Book, valuer: MarketValuer | null) {
    this.#store = store;
    this.#rules = rules;
    this.#book = book;
    this.#valuer = valuer;
  }

  /** Loans that could be extended: due or past due, not yet forfeited. */
  extendable(): LoanLine[] {
    return [...this.#book.due(), ...this.#book.inGrace(), ...this.#book.overdue()].filter(
      (line) => line.loan.status === 'active' && line.daysPastDue >= 0,
    );
  }

  async run(command: ExtendCommand, owner: User): Promise<ExtendResult> {
    if (!can(owner, 'approvals.decide')) {
      return { ownerMessage: 'Only Lukas can extend a loan.' };
    }

    const candidates = this.extendable();
    if (candidates.length === 0) return { ownerMessage: 'No loan is due or past due right now.' };

    const line = command.reference
      ? candidates.find((entry) => referenceFor(entry.loan.id) === command.reference)
      : candidates.length === 1
        ? candidates[0]
        : undefined;

    if (!line) {
      if (!command.reference) {
        return {
          ownerMessage:
            `${candidates.length} could be extended — say which:\n` +
            candidates
              .map((entry) => `• ${referenceFor(entry.loan.id)} — ${nameOf(entry)}, ${formatAmount(entry.owedCents)}`)
              .join('\n'),
        };
      }
      return { ownerMessage: `Nothing due under reference ${command.reference}.` };
    }

    const test = extensionTest(this.#rules, line, await this.#currentMarketValue(line));

    // Above the line, the playbook does not permit it. Said as the document's
    // answer, not the agent's: it is a rule, and Lukas changes it by editing
    // the document rather than by overriding it on his phone.
    if (test.allowed === false) {
      return {
        ownerMessage: refusedMessage(this.#store, this.#rules, line, test),
        customerPhone: line.customer?.phone,
        customerMessage: line.customer ? refusedCustomerMessage(this.#rules, line) : undefined,
      };
    }
    if (test.allowed === null) {
      return { ownerMessage: cannotTellMessage(line, test) };
    }

    return this.#extend(line, test, command.note, owner);
  }

  /**
   * A fresh market value, because the playbook asks for the current one.
   *
   * Asking the valuer what a months-old item is worth today is an estimate and
   * nothing more — the message that comes back says so. Better than silently
   * reusing the intake figure, which is the one number certain to be stale.
   */
  async #currentMarketValue(line: LoanLine): Promise<number | null> {
    const item = this.#store.item(line.loan.item_id);
    if (!this.#valuer || !item?.description.trim()) return null;

    try {
      const estimates = await this.#valuer.estimate({
        description: item.description,
        categorySlug: item.category_slug,
        variant: item.variant,
      });
      const amounts = estimates.map((estimate) => estimate.amountCents).filter((amount) => amount > 0);
      // The lowest, as everywhere else in this playbook — section 3 step 2.
      return amounts.length > 0 ? Math.min(...amounts) : null;
    } catch {
      return null;
    }
  }

  #extend(line: LoanLine, test: ExtensionTest, note: string, owner: User): ExtendResult {
    const terms = loanTerms({ principalCents: line.loan.principal_cents }, this.#rules);
    const from = line.loan.due_date;
    const dueDate = addDays(from, terms.termDays);
    const graceEndsDate = addDays(dueDate, terms.graceDays);

    const extended = this.#store.extendLoan({
      loanId: line.loan.id,
      dueDate,
      graceEndsDate,
      interestCents: test.nextInterestCents,
      actor: owner.id,
      note,
      marketValueCents: test.marketValueCents,
    });

    const item = this.#store.item(line.loan.item_id);
    const nowOwed = line.owedCents + test.nextInterestCents;

    return {
      ownerMessage:
        `Extended ${referenceFor(line.loan.id)} — ${nameOf(line)}, ${item?.description || 'item'}.\n\n` +
        `Was ${formatAmount(line.owedCents)}, now ${formatAmount(nowOwed)} ` +
        `(a further ${formatAmount(test.nextInterestCents)} at ${line.loan.rate_pct}%).\n` +
        `Due ${extended.due_date}, grace to ${extended.grace_ends_date}.\n\n` +
        `${testLine(test)}`,
      customerPhone: line.customer?.phone,
      customerMessage: line.customer
        ? `${capitalise(this.#rules.playbook.ownerLabel)} has agreed to another month on your ${item?.description || 'item'}.\n\n` +
          `A further ${formatAmount(test.nextInterestCents)} interest has been added, so ` +
          `${formatAmount(nowOwed)} is now needed to collect it.\n\n` +
          `The new date is ${extended.due_date}, with the usual ${terms.graceDays}-day grace after that.`
        : undefined,
    };
  }
}

// --- what he is told -------------------------------------------------------

/** The test as a sentence, with the estimate flagged as an estimate. */
export function testLine(test: ExtensionTest): string {
  if (test.marketValueCents === null) {
    return 'No current market value available, so the section 8 extension test could not be run.';
  }

  const pct = Math.round((test.wouldOweCents / test.marketValueCents) * 100);
  return (
    `Section 8: ${formatAmount(test.wouldOweCents)} owed after this month against ` +
    `${formatAmount(test.marketValueCents)} market value — about ${pct}%, ` +
    `${test.allowed ? 'inside' : 'past'} the ${test.ceilingPct}% line.\n` +
    '_That market value is an estimate made just now, not a sale price. Sanity-check it against what the thing would actually fetch._'
  );
}

function refusedMessage(store: Store, rules: Rules, line: LoanLine, test: ExtensionTest): string {
  const margin = marginFor(store, rules, line);
  return (
    `*Section 8 does not allow another month on ${referenceFor(line.loan.id)}.*\n\n` +
    `${nameOf(line)} would owe ${formatAmount(test.wouldOweCents)} against a market value of ` +
    `${formatAmount(test.marketValueCents!)} — past the ${test.ceilingPct}% line ` +
    `(${formatAmount(test.ceilingCents!)}).\n\n` +
    `${marginLine(margin)}\n\n` +
    `The playbook sends it to market instead: *SELL ${referenceFor(line.loan.id)}*. ` +
    'If you want to extend it anyway, that is a change to section 8, not an override here — edit the document.'
  );
}

/**
 * What the borrower is told when the extension cannot be granted.
 *
 * Lukas, 30 October 2026: *"If we can't extend, we tell them we can't extend
 * and that we have to sell the item to recover our money."* Before this only
 * he was told — the customer asked for another month and heard nothing back,
 * which is the worst of both: no extension and no answer.
 *
 * This does not skip his decision, and it is not the agent deciding anything.
 * The refusal is section 8's arithmetic, and it is the direct answer to a
 * *EXTEND* command he typed himself, so he is in the loop by construction —
 * the same shape as the final notice he approved on 25 October.
 *
 * What it deliberately does not say: when the item will be sold, or that it
 * has been. Sending something to market stays his decision on that item
 * (*SELL <ref>*), so promising a date here would commit him to something he
 * has not done. It does say they can still collect it by paying, because that
 * stays true right up until it is sold and it is the one useful thing left to
 * tell them.
 */
function refusedCustomerMessage(rules: Rules, line: LoanLine): string {
  const owed = formatAmount(line.owedCents);
  return (
    `We can't extend your loan for another month, I'm sorry.\n\n` +
    `What is owed has reached the point where ${rules.playbook.ownerLabel} can no longer lend against the item, ` +
    'so it now has to be sold for the shop to recover its money.\n\n' +
    `You can still collect it at any time before it is sold, by paying the ${owed} owed. ` +
    `If you can do that, message here and ${rules.playbook.ownerLabel} will arrange it with you.`
  );
}

function cannotTellMessage(line: LoanLine, test: ExtensionTest): string {
  return (
    `I can't run the section 8 extension test on ${referenceFor(line.loan.id)} — no current market value.\n\n` +
    `${nameOf(line)} owes ${formatAmount(test.owedCents)} and another month would add ` +
    `${formatAmount(test.nextInterestCents)}, so ${formatAmount(test.wouldOweCents)}.\n` +
    `That has to come in at or below ${test.ceilingPct}% of what the item is worth today. ` +
    'Check a price and decide; nothing has been changed.'
  );
}

/** "the manager" → "The manager", for the start of a sentence. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function nameOf(line: LoanLine): string {
  return line.customer?.name ?? line.customer?.phone ?? 'Unknown';
}
