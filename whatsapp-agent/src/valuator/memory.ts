/**
 * What Lukas's corrections taught the system (playbook section 3).
 *
 * The estimate is a guess; his adjustment is a fact about what this shop will
 * actually pay for that kind of item. So when he overrides a figure, the next
 * customer with the same item gets his number rather than a fresh guess.
 *
 * It expires, on the playbook's schedule. Second-hand prices move, and a
 * month-old correction is worse than a new estimate — the point is to reuse a
 * recent decision, not to freeze a price list.
 *
 * This is memory, not authority. A remembered figure is still only a
 * suggestion, and still goes to Lukas for approval like every other one.
 */

import { randomUUID } from 'node:crypto';
import type { Store } from '../store/index.ts';
import type { Rules } from '../playbook/index.ts';

export interface AdjustmentKey {
  categorySlug: string;
  variant?: string | null;
  description?: string;
}

export interface RememberedPrice {
  id: string;
  fingerprint: string;
  marketValueCents: number | null;
  loanCents: number;
  buyNowCents: number | null;
  assessedValueCents: number | null;
  suggestedLoanCents: number | null;
  note: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * What makes two items "the same kind".
 *
 * Storage sizes and colours are dropped, model numbers kept: an iPhone 13 Pro
 * in black and one in silver fetch the same money, and treating them as
 * different items would mean his correction never gets reused. Deliberately
 * blunt — a fingerprint that is too precise remembers nothing.
 */
export function fingerprint(key: AdjustmentKey): string {
  const words = (key.description ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // Capacity, colour and condition are noise for pricing this coarsely.
    .filter((word) => !/^\d+(gb|tb|mb)$/.test(word))
    .filter((word) => !STOP_WORDS.has(word))
    .sort();

  return [key.categorySlug, key.variant ?? '', [...new Set(words)].join(' ')].join('|');
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'with', 'in', 'good', 'excellent', 'fair', 'poor', 'condition',
  'used', 'second', 'hand', 'like', 'new', 'black', 'white', 'silver', 'gold', 'blue', 'red',
  'green', 'grey', 'gray', 'space', 'pink', 'purple', 'my', 'is', 'it', 'for', 'of',
]);

export class PriceMemory {
  readonly #store: Store;
  readonly #rules: Rules;
  readonly #now: () => Date;

  constructor(store: Store, rules: Rules, options: { clock?: () => Date } = {}) {
    this.#store = store;
    this.#rules = rules;
    this.#now = options.clock ?? (() => new Date());
  }

  /** The most recent unexpired adjustment for this kind of item, if any. */
  recall(key: AdjustmentKey): RememberedPrice | null {
    const row = this.#store.db
      .prepare(
        'SELECT * FROM price_adjustments WHERE fingerprint = ? AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(fingerprint(key), this.#now().toISOString()) as Record<string, unknown> | undefined;

    return row ? toRemembered(row) : null;
  }

  /**
   * Records an adjustment. Never updates an existing row — a later correction
   * supersedes an earlier one, and both stay readable.
   */
  remember(adjustment: {
    key: AdjustmentKey;
    loanCents: number;
    buyNowCents?: number | null;
    assessedValueCents?: number | null;
    marketValueCents?: number | null;
    suggestedLoanCents?: number | null;
    itemId?: string | null;
    valuationId?: string | null;
    note?: string;
    adjustedBy: string;
  }): RememberedPrice {
    const createdAt = this.#now();
    const expiresAt = new Date(createdAt.getTime() + this.#rules.playbook.adjustmentMemoryDays * 86400000);
    const id = randomUUID();

    this.#store.db
      .prepare(
        `INSERT INTO price_adjustments
           (id, fingerprint, category_slug, variant, description, item_id, valuation_id,
            suggested_loan_cents, loan_cents, buy_now_cents, assessed_value_cents,
            market_value_cents, note, adjusted_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fingerprint(adjustment.key),
        adjustment.key.categorySlug,
        adjustment.key.variant ?? null,
        adjustment.key.description ?? '',
        adjustment.itemId ?? null,
        adjustment.valuationId ?? null,
        adjustment.suggestedLoanCents ?? null,
        adjustment.loanCents,
        adjustment.buyNowCents ?? null,
        adjustment.assessedValueCents ?? null,
        adjustment.marketValueCents ?? null,
        adjustment.note ?? '',
        adjustment.adjustedBy,
        createdAt.toISOString(),
        expiresAt.toISOString(),
      );

    this.#store.audit({
      actor: adjustment.adjustedBy,
      action: 'price.adjusted',
      entity: 'price_adjustment',
      entityId: id,
      details: {
        fingerprint: fingerprint(adjustment.key),
        suggestedLoanCents: adjustment.suggestedLoanCents ?? null,
        loanCents: adjustment.loanCents,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return this.recall(adjustment.key)!;
  }

  /** Everything still in date — what the system currently believes it knows. */
  live(): RememberedPrice[] {
    return (
      this.#store.db
        .prepare('SELECT * FROM price_adjustments WHERE expires_at > ? ORDER BY created_at DESC')
        .all(this.#now().toISOString()) as Record<string, unknown>[]
    ).map(toRemembered);
  }
}

function toRemembered(row: Record<string, unknown>): RememberedPrice {
  return {
    id: String(row['id']),
    fingerprint: String(row['fingerprint']),
    marketValueCents: row['market_value_cents'] === null ? null : Number(row['market_value_cents']),
    loanCents: Number(row['loan_cents']),
    buyNowCents: row['buy_now_cents'] === null ? null : Number(row['buy_now_cents']),
    assessedValueCents: row['assessed_value_cents'] === null ? null : Number(row['assessed_value_cents']),
    suggestedLoanCents: row['suggested_loan_cents'] === null ? null : Number(row['suggested_loan_cents']),
    note: String(row['note'] ?? ''),
    createdAt: String(row['created_at']),
    expiresAt: String(row['expires_at']),
  };
}
