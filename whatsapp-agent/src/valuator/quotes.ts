/** One estimate engine for both front doors. This never approves a deal. */
import type { Rules } from '../playbook/index.ts';
import type { Store } from '../store/index.ts';
import type { Valuator } from '../router.ts';
import type { PrecheckQuote } from '../web/precheck.ts';
import { suggestValuation, type Valuation } from '../valuation.ts';
import { formatAmount, percentOf, round } from '../money.ts';
import { PriceMemory } from './memory.ts';
import type { EstimateInput } from './prompt.ts';

export interface ItemQuote extends PrecheckQuote { valuation: Valuation }

/** Strip channel scaffolding, preserving every item attribute for research. */
export function describeItem(text: string): string {
  return text.trim()
    .replace(/^hello[,.]?\s*i filled in the pre-check on your website\.\s*i have:\s*/i, '')
    .replace(/\s*I know there is something to sort out first, but I would like to ask about it\.?$/i, '')
    .replace(/^(?:what is|what's)\s+(?:the\s+)?(?:value|price|worth)\s+of\s+(?:my\s+)?/i, '')
    .replace(/^(?:how much is|how much can i get for)\s+(?:my\s+)?/i, '')
    .replace(/\s+worth\??$/i, '')
    .replace(/[?.]+$/, '').trim();
}

/** These recognise item attributes, not business rates or acceptance rules. */
export function missingPhoneDetails(description: string): string[] {
  if (!/\biphone\s*\d+/i.test(description)) return [];
  const missing: string[] = [];
  if (!/\b\d+\s*(gb|tb)\b/i.test(description)) missing.push('storage size (GB or TB)');
  if (!/condition|working|damage|scratch|crack|broken|mint|excellent|good|fair|poor|battery|health/i.test(description)) {
    missing.push('condition, including battery health and any damage');
  }
  return missing;
}

export class QuoteService {
  readonly #store: Store;
  readonly #rules: Rules;
  readonly #valuator: Valuator | null;
  readonly #memory: PriceMemory;

  constructor(store: Store, rules: Rules, valuator: Valuator | null, memory = new PriceMemory(store, rules)) {
    this.#store = store;
    this.#rules = rules;
    this.#valuator = valuator;
    this.#memory = memory;
  }

  async quote(input: EstimateInput): Promise<ItemQuote | null> {
    input = { ...input, description: describeItem(input.description) };
    if (!input.description.trim() || missingPhoneDetails(input.description).length) return null;
    const { divisor, discountFactor, buyNowMarkupPct, minimumLoanCents, formula } = this.#rules.playbook.loanSizing;
    const remembered = this.#memory.recall(input);
    let valuation: Valuation;
    if (remembered) {
      const assessed = remembered.assessedValueCents ?? round(remembered.loanCents * divisor);
      const market = remembered.marketValueCents ?? round(assessed / discountFactor);
      const basis = { source: 'recent owner correction (still an estimate)', amountCents: market };
      valuation = {
        estimates: [basis], basis, assessedValueCents: assessed, suggestedLoanCents: remembered.loanCents,
        buyNowCents: remembered.buyNowCents ?? remembered.loanCents + percentOf(remembered.loanCents, buyNowMarkupPct),
        belowMinimum: remembered.loanCents < minimumLoanCents,
        loanToEstimatePct: remembered.loanCents / market * 100, formula,
        workings: [`Recent owner correction: ${formatAmount(market)} market value`,
          `${formatAmount(remembered.loanCents)} suggested loan — still needs approval`],
      };
    } else {
      if (!this.#valuator) return null;
      // Stored model output is dated evidence, never an owner correction. Do
      // not copy it into price_adjustments or let repeated guesses gain authority.
      const history = this.#store.recentMarketObservations(input.categorySlug, input.variant);
      const estimates = await this.#valuator.estimate({ ...input, history });
      if (estimates.length === 0) return null;
      valuation = suggestValuation(estimates, this.#rules);
      this.#store.recordMarketObservation(input, estimates);
    }
    return {
      marketValueCents: valuation.basis.amountCents, assessedValueCents: valuation.assessedValueCents,
      loanCents: valuation.suggestedLoanCents, buyNowCents: valuation.buyNowCents,
      fromAdjustment: Boolean(remembered), belowMinimum: valuation.belowMinimum, minimumLoanCents, valuation,
    };
  }
}
