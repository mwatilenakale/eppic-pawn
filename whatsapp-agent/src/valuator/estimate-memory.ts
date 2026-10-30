/** AI observations remain separate from owner corrections and actual transactions. */
import type { Store } from '../store/index.ts';
import type { Rules } from '../playbook/index.ts';
import type { EstimateInput } from './prompt.ts';
import type { MarketEstimate } from '../valuation.ts';
import { fingerprint } from './memory.ts';
import { priceCutoffs } from './refresh.ts';

export function recallEstimate(store: Store, rules: Rules, input: EstimateInput, now = new Date()): MarketEstimate[] | null {
  const cutoff = priceCutoffs(store, fingerprint(input)).observations;
  const earliest = new Date(now.getTime() - rules.playbook.adjustmentMemoryDays * 86_400_000).toISOString();
  // Exact wording is intentionally conservative: never reuse across a missing
  // "not", different storage, battery health, accessories or condition.
  const rows = store.db.prepare(`SELECT description, estimates FROM market_observations
    WHERE category_slug = ? AND variant IS ? AND rowid > ? AND observed_at > ? AND observed_at <= ?
    ORDER BY observed_at DESC, rowid DESC`).all(input.categorySlug, input.variant, cutoff, earliest, now.toISOString()) as
      { description: string; estimates: string }[];
  const normalise = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const row of rows) {
    if (normalise(row.description) !== normalise(input.description)) continue;
    const estimates = JSON.parse(row.estimates) as MarketEstimate[];
    if (estimates.length && estimates.every((entry) => Number.isSafeInteger(entry.amountCents) && entry.amountCents > 0)) {
      return estimates;
    }
  }
  return null;
}
