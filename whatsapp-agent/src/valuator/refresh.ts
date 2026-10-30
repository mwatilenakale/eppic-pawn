/** Explicit market-change invalidation. Append an audit event; never erase history. */
import type { Store } from '../store/index.ts';
import { require as requireCapability } from '../staff/access.ts';

export function priceCutoffs(store: Store, key: string): { observations: number; adjustments: number } {
  const row = store.db.prepare(`SELECT details FROM audit_log
    WHERE action = 'price.invalidated' AND entity = 'price_key' AND entity_id = ?
    ORDER BY rowid DESC LIMIT 1`).get(key) as { details: string } | undefined;
  return row ? JSON.parse(row.details) : { observations: 0, adjustments: 0 };
}

/** Claude: wire this helper only behind an authenticated owner action. */
export function invalidatePrice(store: Store, key: string, actorId: string, reason: string): void {
  requireCapability(store.user(actorId), 'approvals.decide', 'Only the owner may request a market-price reset.');
  if (!reason.trim()) throw new Error('Record the market change or product-release reason');
  const observations = store.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM market_observations').get() as { n: number };
  const adjustments = store.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM price_adjustments').get() as { n: number };
  store.audit({ actor: actorId, action: 'price.invalidated', entity: 'price_key', entityId: key,
    details: { observations: observations.n, adjustments: adjustments.n, reason: reason.trim() } });
}
