/**
 * Market-estimate lookup for the valuation engine (architecture 2.2, phase 1).
 *
 * Claude is asked for *market estimates only* — never for a loan amount. The
 * playbook's formula (lowest estimate x 0.75 / 2) is applied in code, from the
 * document, so the number Lukas sees is arithmetic he can check rather than a
 * figure a model invented.
 *
 * Everything here is best-effort: with no API key, an unparseable answer, or an
 * estimate that fails a sanity check, it returns nothing and the approval
 * message asks Lukas for the amount instead. It never guesses to fill a gap.
 *
 * Phase 2 (architecture 2.2) replaces this with a model calibrated against the
 * Ledger's own outcomes — 372 loans of real assessed values and resale results.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Rules } from '../playbook/index.ts';
import type { PriceMemory } from './memory.ts';
import type { Valuator } from '../router.ts';
import type { MarketEstimate } from '../valuation.ts';
import { CENTS, round } from '../money.ts';

const MODEL = process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-5';
const MAX_ESTIMATES = 5;

/** Anything outside this range is a mistake, not a valuation. */
const MIN_PLAUSIBLE_NAD = 50;
const MAX_PLAUSIBLE_NAD = 5_000_000;

/** The shape Claude must answer in — enforced by the API, not by parsing prose. */
const ESTIMATE_SCHEMA = {
  type: 'object',
  properties: {
    estimates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Where this price comes from, e.g. "Facebook Marketplace, Windhoek, used"' },
          amount_nad: { type: 'number', description: 'Price in Namibian dollars' },
          condition: { type: 'string', description: 'Condition the price assumes, e.g. "used, good"' },
        },
        required: ['source', 'amount_nad', 'condition'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    note: { type: 'string', description: 'Anything Lukas should know, e.g. an unclear model number' },
  },
  required: ['estimates', 'confidence', 'note'],
  additionalProperties: false,
} as const;

interface EstimateResponse {
  estimates: { source: string; amount_nad: number; condition: string }[];
  confidence: 'low' | 'medium' | 'high';
  note: string;
}

/** The subset of the SDK this module uses, so tests can pass a stub. */
export interface MessagesClient {
  messages: {
    create(params: Record<string, unknown>): Promise<{ content: { type: string; text?: string }[] }>;
  };
}

export interface ClaudeValuatorOptions {
  model?: string;
  maxTokens?: number;
  onError?: (error: unknown) => void;
  /** Recent owner corrections, given to the model as local evidence. */
  memory?: PriceMemory | null;
}

export class ClaudeValuator implements Valuator {
  readonly #client: MessagesClient;
  readonly #rules: Rules;
  readonly #options: {
    model: string;
    maxTokens: number;
    onError: (error: unknown) => void;
    memory: PriceMemory | null;
  };

  constructor(client: MessagesClient, rules: Rules, options: ClaudeValuatorOptions = {}) {
    this.#client = client;
    this.#rules = rules;
    this.#options = {
      model: options.model ?? MODEL,
      maxTokens: options.maxTokens ?? 2048,
      onError: options.onError ?? ((error) => console.error('[valuator]', error)),
      memory: options.memory ?? null,
    };
  }

  async estimate(input: { description: string; categorySlug: string; variant: string | null }): Promise<MarketEstimate[]> {
    if (!input.description.trim()) return [];

    try {
      const response = await this.#client.messages.create({
        model: this.#options.model,
        max_tokens: this.#options.maxTokens,
        system: this.#systemPrompt(),
        output_config: { format: { type: 'json_schema', schema: ESTIMATE_SCHEMA } },
        messages: [{ role: 'user', content: this.#userPrompt(input) }],
      });

      const text = response.content.find((block) => block.type === 'text')?.text;
      if (!text) return [];

      return this.#readEstimates(JSON.parse(text) as EstimateResponse);
    } catch (error) {
      this.#options.onError(error);
      return [];
    }
  }

  #systemPrompt(): string {
    const categories = this.#rules.categories.map((category) => category.label).join(', ');
    return [
      'You price second-hand goods for a pawn shop in Windhoek, Namibia. Amounts are Namibian dollars (N$).',
      `The shop takes: ${categories}.`,
      '',
      'Give 2 to 4 realistic prices the item would actually sell for second-hand in Namibia — what a private',
      'seller gets on Facebook Marketplace or a local dealer pays, not new retail and not an international price.',
      '',
      'Be conservative. The lowest of your estimates is what the loan is sized from, so an optimistic number',
      "costs the shop real money. Prefer under-estimating to over-estimating.",
      '',
      'If the description is too vague to price honestly — no model, no storage size, no condition — return an',
      'empty estimates list and say what is missing in the note. An empty list is a correct answer; a guess is not.',
      '',
      'Never suggest a loan amount, an interest rate, or whether to accept the item. Those are the owner\'s decisions',
      'and are calculated separately from his own written rules.',
    ].join('\n');
  }

  #userPrompt(input: { description: string; categorySlug: string; variant: string | null }): string {
    const category = this.#rules.categories.find((entry) => entry.slug === input.categorySlug);
    return [
      `Category: ${category?.label ?? input.categorySlug}${input.variant ? ` (${input.variant})` : ''}`,
      `Customer's description: ${input.description}`,
      this.#recentCorrections(input.categorySlug),
      '',
      'What would this sell for second-hand in Namibia?',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * What the owner has actually paid recently, for this category.
   *
   * An exact match is used ahead of the model entirely — that lookup happens
   * before this class is reached. What is passed here is the near misses: real
   * prices from this shop, in this town, in the last fortnight, which are far
   * better evidence than anything the model knows about Namibian resale.
   *
   * It is context, not instruction. The model still has to price the item in
   * front of it, and an owner correction on a different phone does not settle
   * what this one is worth.
   */
  #recentCorrections(categorySlug: string): string {
    if (!this.#options.memory) return '';

    const recent = this.#options.memory
      .live()
      .filter((price) => price.fingerprint.startsWith(`${categorySlug}|`))
      .slice(0, 8);

    if (recent.length === 0) return '';

    const lines = recent.map((price) => {
      const market = price.marketValueCents ?? (price.assessedValueCents !== null ? price.assessedValueCents / 0.75 : null);
      const described = price.fingerprint.split('|')[2] || 'similar item';
      return market !== null
        ? `- ${described}: the owner valued at N$${Math.round(market / 100).toLocaleString('en-US')}`
        : `- ${described}: the owner lent N$${Math.round(price.loanCents / 100).toLocaleString('en-US')}`;
    });

    return [
      '',
      'Recent prices this shop actually set for items in this category (owner corrections, last few weeks).',
      'These are real local figures — weigh them heavily, but price the item described above, not these:',
      ...lines,
    ].join('\n');
  }

  /** Drops anything implausible rather than passing a bad number to the formula. */
  #readEstimates(payload: EstimateResponse): MarketEstimate[] {
    if (!Array.isArray(payload?.estimates)) return [];

    const label = payload.confidence === 'high' ? 'AI estimate' : `AI estimate, ${payload.confidence} confidence`;

    return payload.estimates
      .filter((estimate) => Number.isFinite(estimate?.amount_nad))
      .filter((estimate) => estimate.amount_nad >= MIN_PLAUSIBLE_NAD && estimate.amount_nad <= MAX_PLAUSIBLE_NAD)
      .slice(0, MAX_ESTIMATES)
      .map((estimate) => ({
        source: `${label}: ${estimate.source}${estimate.condition ? ` (${estimate.condition})` : ''}`,
        amountCents: round(estimate.amount_nad * CENTS),
      }));
  }
}

/**
 * Builds the valuator when an API key is configured. Returns null otherwise —
 * the agent runs fine without one, it just asks Lukas for the figure.
 */
export function createValuator(apiKey: string | null, rules: Rules, memory?: PriceMemory): Valuator | null {
  if (!apiKey) return null;
  return new ClaudeValuator(new Anthropic({ apiKey }) as unknown as MessagesClient, rules, { memory });
}
