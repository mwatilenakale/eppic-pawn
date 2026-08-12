/**
 * The price knowledge base: what Lukas's corrections teach the system, and how
 * long they are allowed to last (playbook section 3).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/playbook/index.ts';
import { Store } from '../src/store/index.ts';
import { PriceMemory, fingerprint } from '../src/valuator/memory.ts';
import { suggestValuation } from '../src/valuation.ts';

const rules = loadRules();

let store: Store;
let lukas: string;
let now: Date;
let memory: PriceMemory;

beforeEach(() => {
  store = new Store(':memory:');
  lukas = store.ensureUser({ name: 'Lukas', phone: '+264811110000', role: 'owner' }).id;
  now = new Date('2026-08-06T09:00:00.000Z');
  memory = new PriceMemory(store, rules, { clock: () => now });
});

afterEach(() => store.close());

const iphone = { categorySlug: 'phones', variant: 'iphone', description: 'iPhone 13 Pro 256GB' };

describe('remembering an adjustment', () => {
  test('the next identical item gets his number, not a fresh guess', () => {
    assert.equal(memory.recall(iphone), null, 'nothing is known to begin with');

    memory.remember({ key: iphone, loanCents: 400_000, buyNowCents: 500_000, suggestedLoanCents: 391_500, adjustedBy: lukas });

    const recalled = memory.recall(iphone)!;
    assert.equal(recalled.loanCents, 400_000);
    assert.equal(recalled.buyNowCents, 500_000);
    assert.equal(recalled.suggestedLoanCents, 391_500, 'what the engine had said is kept beside it');
  });

  test('it expires on the playbook\'s schedule, not on a number in the code', () => {
    memory.remember({ key: iphone, loanCents: 400_000, adjustedBy: lukas });
    const days = rules.playbook.adjustmentMemoryDays;

    now = new Date(`2026-08-06T09:00:00.000Z`);
    now = new Date(now.getTime() + (days - 1) * 86400000);
    assert.ok(memory.recall(iphone), `still remembered the day before ${days} days are up`);

    now = new Date(now.getTime() + 2 * 86400000);
    assert.equal(memory.recall(iphone), null, 'and forgotten after');
  });

  test('a later correction supersedes the earlier one, and neither is deleted', () => {
    memory.remember({ key: iphone, loanCents: 400_000, adjustedBy: lukas });
    now = new Date(now.getTime() + 86400000);
    memory.remember({ key: iphone, loanCents: 350_000, note: 'market softened', adjustedBy: lukas });

    assert.equal(memory.recall(iphone)!.loanCents, 350_000);
    assert.equal(memory.recall(iphone)!.note, 'market softened');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM price_adjustments').get()!['n'], 2, 'the first decision is still on record');
  });

  test('every adjustment is auditable back to who made it', () => {
    const remembered = memory.remember({ key: iphone, loanCents: 400_000, suggestedLoanCents: 391_500, adjustedBy: lukas });
    const [entry] = store.auditTrail('price_adjustment', remembered.id);

    assert.equal(entry!.actor, lukas);
    assert.equal(entry!.action, 'price.adjusted');
    assert.match(entry!.details, /"loanCents":400000/);
  });
});

describe('what counts as the same item', () => {
  test('storage size, colour and condition do not make it a different phone', () => {
    assert.equal(
      fingerprint({ categorySlug: 'phones', variant: 'iphone', description: 'iPhone 13 Pro 256GB' }),
      fingerprint({ categorySlug: 'phones', variant: 'iphone', description: 'iphone 13 pro, 128GB, black, good condition' }),
    );
  });

  test('a different model is a different item', () => {
    assert.notEqual(fingerprint({ ...iphone, description: 'iPhone 13 Pro' }), fingerprint({ ...iphone, description: 'iPhone 15 Pro' }));
  });

  test('and so is the same words under a different category', () => {
    assert.notEqual(fingerprint({ categorySlug: 'phones', description: 'Dell XPS' }), fingerprint({ categorySlug: 'laptops', description: 'Dell XPS' }));
  });

  test('an Android adjustment is not applied to an iPhone', () => {
    memory.remember({ key: { categorySlug: 'phones', variant: 'android', description: 'Galaxy S22' }, loanCents: 200_000, adjustedBy: lukas });
    assert.equal(memory.recall({ categorySlug: 'phones', variant: 'iphone', description: 'Galaxy S22' }), null);
  });
});

describe('the buy-now price', () => {
  test('is higher than the loan, by the playbook\'s markup', () => {
    const valuation = suggestValuation([{ source: 'Marketplace', amountCents: 1_044_000 }], rules);

    assert.equal(valuation.assessedValueCents, 783_000);
    assert.equal(valuation.suggestedLoanCents, 391_500);
    // The pawn loan ties capital up for a month; a purchase can be resold
    // tomorrow, so the customer is paid more for it.
    assert.ok(valuation.buyNowCents > valuation.suggestedLoanCents, 'buying outright pays more than pawning');
    assert.equal(valuation.buyNowCents, 489_375);
  });

  test('the markup comes from the document, not from a constant', () => {
    const valuation = suggestValuation([{ source: 'Marketplace', amountCents: 1_044_000 }], rules);
    const markup = rules.playbook.loanSizing.buyNowMarkupPct;

    assert.equal(valuation.buyNowCents, valuation.suggestedLoanCents + Math.round((valuation.suggestedLoanCents * markup) / 100));
    assert.match(valuation.workings.join('\n'), new RegExp(`\\+ ${markup}% =`));
  });
});
