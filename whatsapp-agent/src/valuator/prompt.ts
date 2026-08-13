/**
 * What we ask a model for, and what we accept back.
 *
 * Shared by every provider, because the interesting part of this component is
 * not which company answers the question — it is that the question is only
 * ever "what is this worth second-hand", never "what should we lend". The
 * playbook's formula runs in code afterwards, so the figure Lukas sees is
 * arithmetic he can check rather than something a model decided.
 *
 * Keeping this in one place means swapping providers cannot quietly change the
 * instructions, the sanity checks, or the shape of the answer.
 */

import type { Rules } from '../playbook/index.ts';
import type { MarketEstimate } from '../valuation.ts';
import type { PriceMemory } from './memory.ts';
import { CENTS, round } from '../money.ts';

const MAX_ESTIMATES = 5;

/** Anything outside this range is a mistake, not a valuation. */
const MIN_PLAUSIBLE_NAD = 50;
const MAX_PLAUSIBLE_NAD = 5_000_000;

/**
 * The shape the answer must take, enforced by the API rather than by parsing
 * prose. Every object closes `additionalProperties` and lists every key in
 * `required`, which both Anthropic and OpenAI's strict modes insist on.
 */
export const ESTIMATE_SCHEMA = {
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

export interface EstimateResponse {
  estimates: { source: string; amount_nad: number; condition: string }[];
  confidence: 'low' | 'medium' | 'high';
  note: string;
}

export interface EstimateInput {
  description: string;
  categorySlug: string;
  variant: string | null;
}

export function systemPrompt(rules: Rules): string {
  const categories = rules.categories.map((category) => category.label).join(', ');
  return [
    'You price second-hand goods for a pawn shop in Windhoek, Namibia. Amounts are Namibian dollars (N$).',
    `The shop takes: ${categories}.`,
    '',
    'Give 2 to 4 realistic prices the item would actually sell for second-hand in Namibia — what a private',
    'seller gets on Facebook Marketplace or a local dealer pays, not new retail and not an international price.',
    '',
    'Be conservative. The lowest of your estimates is what the loan is sized from, so an optimistic number',
    'costs the shop real money. Prefer under-estimating to over-estimating.',
    '',
    'If the description is too vague to price honestly — no model, no storage size, no condition — return an',
    'empty estimates list and say what is missing in the note. An empty list is a correct answer; a guess is not.',
    '',
    "Never suggest a loan amount, an interest rate, or whether to accept the item. Those are the owner's decisions",
    'and are calculated separately from his own written rules.',
  ].join('\n');
}

export function userPrompt(rules: Rules, input: EstimateInput, memory: PriceMemory | null): string {
  const category = rules.categories.find((entry) => entry.slug === input.categorySlug);
  return [
    `Category: ${category?.label ?? input.categorySlug}${input.variant ? ` (${input.variant})` : ''}`,
    `Customer's description: ${input.description}`,
    recentCorrections(input.categorySlug, memory),
    '',
    'What would this sell for second-hand in Namibia?',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * What the owner has actually paid recently, for this category.
 *
 * An exact match short-circuits the model entirely — that lookup happens
 * before any provider is reached. What is passed here is the near misses: real
 * prices, from this shop, in this town, in the last fortnight, which are far
 * better evidence than anything a model knows about Namibian resale.
 *
 * Context, not instruction. A correction on a different phone does not settle
 * what this one is worth.
 */
function recentCorrections(categorySlug: string, memory: PriceMemory | null): string {
  if (!memory) return '';

  const recent = memory
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
export function readEstimates(payload: EstimateResponse): MarketEstimate[] {
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
