import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/index.ts';
import { loadRules } from '../src/playbook/index.ts';
import { QuoteService } from '../src/valuator/quotes.ts';
import { PriceMemory, fingerprint } from '../src/valuator/memory.ts';
import { recallEstimate } from '../src/valuator/estimate-memory.ts';
import { invalidatePrice } from '../src/valuator/refresh.ts';

const rules = loadRules();
const input = { categorySlug: 'phones', variant: 'iphone',
  description: 'iPhone 15 128GB good condition battery 95% with box' };

test('repeated estimates reuse AI evidence without creating approvals or extending its expiry', async () => {
  const store = new Store(':memory:');
  try {
    let calls = 0;
    const quotes = new QuoteService(store, rules, { async estimate() {
      calls++; return [{ source: 'unverified model estimate', amountCents: 1_000_000 }];
    } });
    const [first, concurrent] = await Promise.all([quotes.quote(input), quotes.quote(input)]);
    assert.deepEqual(concurrent, first);
    assert.deepEqual(await quotes.quote(input), first);
    assert.equal(calls, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM market_observations').get()!.n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM price_adjustments').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM approvals').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM loans').get()!.n, 0);
    assert.equal(recallEstimate(store, rules, { ...input, description: input.description.replace('128GB', '256GB') }), null);
    assert.equal(recallEstimate(store, rules, { ...input, description: input.description.replace('with box', 'without box') }), null);
    const observed = store.db.prepare('SELECT observed_at FROM market_observations').get()!.observed_at as string;
    const expiry = new Date(Date.parse(observed) + rules.playbook.adjustmentMemoryDays * 86_400_000);
    assert.equal(recallEstimate(store, rules, input, expiry), null);
  } finally { store.close(); }
});

test('owner corrections outrank AI, and an audited owner reset permits fresh research without deleting either history', async () => {
  const store = new Store(':memory:');
  try {
    const owner = store.ensureUser({ name: 'Lukas', phone: '+264811110000', role: 'owner' });
    const staff = store.ensureUser({ name: 'Helen', phone: '+264811110001', role: 'inspector' });
    let calls = 0;
    const quotes = new QuoteService(store, rules, { async estimate() {
      calls++; return [{ source: 'unverified model estimate', amountCents: 1_000_000 }];
    } });
    await quotes.quote(input);
    new PriceMemory(store, rules).remember({ key: input, loanCents: 400_000, adjustedBy: owner.id });
    assert.equal((await quotes.quote(input))!.fromAdjustment, true);
    assert.equal(calls, 1);
    assert.throws(() => invalidatePrice(store, fingerprint(input), staff.id, 'new model released'), /Only the owner/);
    assert.throws(() => invalidatePrice(store, fingerprint(input), owner.id, ' '), /reason/);
    invalidatePrice(store, fingerprint(input), owner.id, 'New model released; reassess this item');
    assert.equal((await quotes.quote(input))!.fromAdjustment, false);
    assert.equal(calls, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM price_adjustments').get()!.n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM market_observations').get()!.n, 2);
    assert.equal(store.auditTrail('price_key', fingerprint(input)).length, 1);
  } finally { store.close(); }
});
