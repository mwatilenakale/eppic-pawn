/**
 * Valuation engine, phase 1 (architecture section 2.2).
 *
 * The formula and every rate come from the playbook — this module only applies
 * them. The result is always a *suggestion*: it is put in front of Lukas in the
 * approval message and never quoted to the customer by the agent (root
 * CLAUDE.md, "AI never gives final approval on money").
 */

import { formatAmount, percentOf, round } from './money.ts';
import {
  RATE_LARGE_LOAN,
  RATE_REFERRAL,
  RATE_STANDARD,
  type RateRule,
  type Rules,
} from './playbook/index.ts';

export interface MarketEstimate {
  /** Where the number came from, e.g. `Facebook Marketplace, used, N$4,200`. */
  source: string;
  amountCents: number;
}

export interface Valuation {
  estimates: MarketEstimate[];
  /** The estimate the playbook says to start from (the lowest one). */
  basis: MarketEstimate;
  /** Basis after the playbook's discount factor — the assessed value. */
  assessedValueCents: number;
  suggestedLoanCents: number;
  /** Share of the basis estimate the suggested loan represents. */
  loanToEstimatePct: number;
  /** Step-by-step working, shown in the approval message. */
  workings: string[];
  /** Formula text as read from the playbook, e.g. `lowest market estimate x 0.75 / 2`. */
  formula: string;
}

export class ValuationError extends Error {}

/** Applies playbook section 3 to a set of market estimates. */
export function suggestValuation(estimates: MarketEstimate[], rules: Rules): Valuation {
  if (estimates.length === 0) throw new ValuationError('At least one market estimate is required');
  if (estimates.some((estimate) => estimate.amountCents <= 0)) {
    throw new ValuationError('Market estimates must be positive amounts');
  }

  const { basis: basisRule, discountFactor, divisor, formula } = rules.playbook.loanSizing;
  const sorted = [...estimates].sort((a, b) => a.amountCents - b.amountCents);
  const basis =
    basisRule === 'highest' ? sorted[sorted.length - 1]! : basisRule === 'lowest' ? sorted[0]! : averageOf(sorted);

  const assessedValueCents = round(basis.amountCents * discountFactor);
  const suggestedLoanCents = round(assessedValueCents / divisor);

  return {
    estimates,
    basis,
    assessedValueCents,
    suggestedLoanCents,
    loanToEstimatePct: (suggestedLoanCents / basis.amountCents) * 100,
    formula,
    workings: [
      `${basisRule} market estimate: ${formatAmount(basis.amountCents)} (${basis.source})`,
      `x ${discountFactor} = ${formatAmount(assessedValueCents)} assessed value`,
      `/ ${divisor} = ${formatAmount(suggestedLoanCents)} suggested loan`,
    ],
  };
}

function averageOf(estimates: MarketEstimate[]): MarketEstimate {
  const total = estimates.reduce((sum, estimate) => sum + estimate.amountCents, 0);
  return { source: 'average of estimates', amountCents: round(total / estimates.length) };
}

export interface LoanTermsInput {
  principalCents: number;
  /** Set when someone brought the customer in — playbook section 4, referral row. */
  referral?: boolean;
}

export interface LoanTerms {
  principalCents: number;
  rule: RateRule;
  ratePct: number;
  termDays: number;
  interestCents: number;
  totalDueCents: number;
  graceDays: number;
  /** Referral row only: what the referrer earns and what stays with the owner. */
  referrerShareCents: number | null;
  ownerShareCents: number | null;
}

/**
 * Picks the rate row that applies and works out what is owed at the end of the
 * term. Rate selection order follows playbook section 4: the large-loan row
 * wins on amount, the referral row applies below that threshold.
 */
export function loanTerms({ principalCents, referral = false }: LoanTermsInput, rules: Rules): LoanTerms {
  if (principalCents <= 0) throw new ValuationError('Principal must be a positive amount');

  const large = rules.rate(RATE_LARGE_LOAN);
  const standard = rules.rate(RATE_STANDARD);
  const referralRule = rules.rate(RATE_REFERRAL);

  const qualifiesAsLarge =
    large?.minAmountCents !== null && large?.minAmountCents !== undefined && principalCents >= large.minAmountCents;

  const rule = qualifiesAsLarge ? large! : referral && referralRule ? referralRule : standard!;
  if (!rule || rule.ratePct === null || rule.termDays === null) {
    throw new ValuationError(
      `The playbook's "${rule?.scenario ?? 'selected'}" row has no fixed rate — this loan is negotiated and needs Lukas to set the terms`,
    );
  }

  const interestCents = percentOf(principalCents, rule.ratePct);
  const isReferral = rule.id === RATE_REFERRAL;

  return {
    principalCents,
    rule,
    ratePct: rule.ratePct,
    termDays: rule.termDays,
    interestCents,
    totalDueCents: principalCents + interestCents,
    graceDays: rules.playbook.grace.defaultDays,
    referrerShareCents: isReferral && rule.referrerSharePct !== null ? percentOf(principalCents, rule.referrerSharePct) : null,
    ownerShareCents: isReferral && rule.ownerSharePct !== null ? percentOf(principalCents, rule.ownerSharePct) : null,
  };
}

export interface Schedule {
  startDate: string;
  dueDate: string;
  /** Last day a payment is on time under playbook section 4's grace period. */
  graceEndsDate: string;
  /** Grace stretched to the playbook's flexible maximum, on request. */
  extendedGraceEndsDate: string;
}

export function schedule(startDate: string, terms: LoanTerms, rules: Rules): Schedule {
  const dueDate = addDays(startDate, terms.termDays);
  return {
    startDate,
    dueDate,
    graceEndsDate: addDays(dueDate, rules.playbook.grace.defaultDays),
    extendedGraceEndsDate: addDays(dueDate, rules.playbook.grace.flexibleUpToDays),
  };
}

/** ISO date arithmetic in UTC — no timezone surprises on a date-only value. */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new ValuationError(`Invalid date: ${isoDate}`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface PartialPaymentResult {
  paymentCents: number;
  interestSettledCents: number;
  /** Interest shortfall folded into principal (playbook section 4). */
  foldedIntoPrincipalCents: number;
  principalReducedCents: number;
  newPrincipalCents: number;
  note: string;
}

/**
 * Playbook section 4: an interest shortfall is not written off — it folds into
 * principal and compounds, and the loan is re-sized off the new base.
 */
export function applyPartialPayment(
  { principalCents, interestDueCents, paymentCents }: { principalCents: number; interestDueCents: number; paymentCents: number },
  rules: Rules,
): PartialPaymentResult {
  if (paymentCents < 0) throw new ValuationError('Payment cannot be negative');

  const interestSettledCents = Math.min(paymentCents, interestDueCents);
  const shortfallCents = interestDueCents - interestSettledCents;
  const principalReducedCents = Math.min(paymentCents - interestSettledCents, principalCents);

  if (shortfallCents > 0 && !rules.playbook.partialPaymentCompounds) {
    return {
      paymentCents,
      interestSettledCents,
      foldedIntoPrincipalCents: 0,
      principalReducedCents,
      newPrincipalCents: principalCents - principalReducedCents,
      note: 'Interest shortfall written off — the playbook no longer compounds it',
    };
  }

  const newPrincipalCents = principalCents - principalReducedCents + shortfallCents;
  return {
    paymentCents,
    interestSettledCents,
    foldedIntoPrincipalCents: shortfallCents,
    principalReducedCents,
    newPrincipalCents,
    note:
      shortfallCents > 0
        ? `${formatAmount(shortfallCents)} unpaid interest folds into principal — new base ${formatAmount(newPrincipalCents)}`
        : `Interest settled; principal now ${formatAmount(newPrincipalCents)}`,
  };
}

export interface MarginCheck {
  owedCents: number;
  expectedSaleCents: number;
  marginCents: number;
  marginPct: number;
  thresholdPct: number;
  decision: 'extend' | 'sell';
  explanation: string;
}

/**
 * Playbook section 8 step 3: compare what is owed against what the item will
 * actually fetch. Roughly 10%+ margin left means extending another month is
 * still safe; margin gone means sell.
 */
export function marginCheck(
  { owedCents, expectedSaleCents }: { owedCents: number; expectedSaleCents: number },
  rules: Rules,
): MarginCheck {
  if (expectedSaleCents <= 0) throw new ValuationError('Expected sale value must be positive');

  const marginCents = expectedSaleCents - owedCents;
  const marginPct = (marginCents / expectedSaleCents) * 100;
  const thresholdPct = rules.playbook.collections.marginThresholdPct;
  const decision = marginPct >= thresholdPct ? 'extend' : 'sell';

  return {
    owedCents,
    expectedSaleCents,
    marginCents,
    marginPct,
    thresholdPct,
    decision,
    explanation:
      decision === 'extend'
        ? `${formatAmount(owedCents)} owed against ${formatAmount(expectedSaleCents)} sale value — ${marginPct.toFixed(1)}% margin left, at or above the ${thresholdPct}% threshold, so extending a month is still safe`
        : `${formatAmount(owedCents)} owed against ${formatAmount(expectedSaleCents)} sale value — ${marginPct.toFixed(1)}% margin left, under the ${thresholdPct}% threshold, so sell`,
  };
}

/** What is owed after `months` missed months, per the section 8 worked example. */
export function owedAfterMissedMonths(terms: LoanTerms, months: number): number {
  return terms.principalCents + terms.interestCents * months;
}
