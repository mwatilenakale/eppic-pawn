/**
 * The N$5,000 proof-of-purchase line — playbook section 5.
 *
 * Found by Codex's twenty-scenario audit, scenario 13. The threshold was
 * parsed out of the document in three places and consumed by nothing at all:
 * a N$10,000 phone was asked for exactly the same documents as a N$800 one.
 * The rule written after losing money on a financed S25 Ultra did nothing.
 *
 * There is deliberately no automatic check. A photo of a receipt and a photo
 * of a handwritten declaration are both `ownership` and nothing here can read
 * either, so the rule tells the people who can look: the website visitor
 * before they travel in, and the owner with the valuation in front of him.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/playbook/index.ts';
import { Store } from '../src/store/index.ts';
import { evaluatePrecheck } from '../src/web/precheck.ts';
import { proofOfPurchaseFor, proofOfPurchaseForItem } from '../src/requirements.ts';

const rules = loadRules();
const THRESHOLD = rules.playbook.proofOfPurchaseAboveCents;

let store: Store;

beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => store.close());

describe('where the line falls', () => {
  test('the threshold comes from the playbook, not from here', () => {
    assert.equal(THRESHOLD, 500_000, 'N$5,000, as section 5 states it');
  });

  test('below it, a declaration is still enough', () => {
    const proof = proofOfPurchaseFor(rules, THRESHOLD - 100);
    assert.equal(proof.required, false);
    assert.equal(proof.instruction, null, 'and the customer is told nothing extra');
  });

  test('exactly on it is not above it', () => {
    // The document says "above N$5,000". An item worth exactly the threshold
    // is not above it, and the friction is not worth it at that value.
    assert.equal(proofOfPurchaseFor(rules, THRESHOLD).required, false);
  });

  test('a cent above it, the receipt is required', () => {
    const proof = proofOfPurchaseFor(rules, THRESHOLD + 100);
    assert.equal(proof.required, true);
    assert.match(proof.instruction!, /original receipt/i);
    assert.match(proof.instruction!, /settlement letter/i);
  });

  test('and the box explicitly does not count', () => {
    // "A box with a matching serial is evidence of possession, not of a debt
    // being settled — which is the whole Spectra lesson."
    const proof = proofOfPurchaseFor(rules, 1_045_000);
    assert.match(proof.instruction!, /box/i);
    assert.match(proof.instruction!, /possession/i);
    assert.match(proof.instruction!, /written declaration is not enough/i);
  });

  test('an unpriced item does not trigger it', () => {
    // Nobody has valued it yet, so the rule cannot bite. It must not default
    // to demanding a receipt from everybody.
    const proof = proofOfPurchaseFor(rules, null);
    assert.equal(proof.required, false);
    assert.equal(proof.marketValueCents, null);
  });
});

describe('the website says so before they travel in', () => {
  const quoteAt = (marketValueCents: number) => ({
    marketValueCents,
    assessedValueCents: Math.round(marketValueCents * 0.75),
    loanCents: Math.round((marketValueCents * 0.75) / 2),
    buyNowCents: Math.round((marketValueCents * 0.75) / 2 * 1.25),
    belowMinimum: false,
    minimumLoanCents: rules.playbook.loanSizing.minimumLoanCents,
    fromAdjustment: false,
  });

  const outcomeFor = (marketValueCents: number | null) =>
    evaluatePrecheck(rules, {
      category: 'phones', variant: 'iphone',
      description: 'iPhone 15, 128GB, box included, battery health 95%',
      answers: {},
      quote: marketValueCents === null ? null : quoteAt(marketValueCents),
    });

  test('an expensive item is told to bring the receipt', () => {
    const outcome = outcomeFor(1_045_000);

    assert.equal(outcome.proofOfPurchase.required, true);
    assert.match(outcome.notes.join('\n'), /original receipt/i);
    assert.match(outcome.notes.join('\n'), /settlement letter/i);
  });

  test('and the bring list says it on the right line', () => {
    const bring = outcomeFor(1_045_000).bring;
    const ownership = bring.find((entry) => /^proof of ownership/i.test(entry))!;
    const police = bring.find((entry) => /^police declaration/i.test(entry))!;

    assert.match(ownership, /original receipt or a settlement letter/i);
    // The police line contains the words "proof of ownership" too; an
    // unanchored match appended the suffix to it as well, which read as
    // nonsense: "...only if there is no proof of ownership — at this value,
    // the original receipt...".
    assert.doesNotMatch(police, /original receipt/i);
  });

  test('a cheap item is told nothing extra', () => {
    const outcome = outcomeFor(80_000);

    assert.equal(outcome.proofOfPurchase.required, false);
    assert.doesNotMatch(JSON.stringify(outcome), /original receipt/i);
    assert.deepEqual(outcome.bring, rules.playbook.requirements, 'the list is untouched');
  });

  test('an item nobody could price is told nothing extra', () => {
    assert.equal(outcomeFor(null).proofOfPurchase.required, false);
  });
});

describe('and the owner is told, with the valuation in front of him', () => {
  test('the rule reads off the item’s own valuation', () => {
    const customer = store.upsertCustomer('+264811000300', 'Aina Shipanga');
    const item = store.createItem({
      customerId: customer.id, categorySlug: 'phones', variant: 'iphone', description: 'iPhone 15, 128GB',
    });
    store.saveValuation({
      itemId: item.id,
      // Two estimates: the lowest decides, as section 3 does everywhere.
      estimates: [{ source: 'Marketplace', amountCents: 1_200_000 }, { source: 'Dealer', amountCents: 1_045_000 }],
      assessedValueCents: 783_750, suggestedLoanCents: 391_875,
      formula: 'lowest x 0.75 / 2', workings: [],
    });

    const proof = proofOfPurchaseForItem(store, rules, item.id);
    assert.equal(proof.required, true);
    assert.equal(proof.marketValueCents, 1_045_000, 'the lowest estimate, not the highest');
  });

  test('an item with no valuation does not trigger it', () => {
    const customer = store.upsertCustomer('+264811000301', 'Petrus Nangolo');
    const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', description: 'iPhone' });

    assert.equal(proofOfPurchaseForItem(store, rules, item.id).required, false);
  });

  test('a cheap item with a valuation does not either', () => {
    const customer = store.upsertCustomer('+264811000302', 'Lucia Mbango');
    const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', description: 'Nokia 3310' });
    store.saveValuation({
      itemId: item.id,
      estimates: [{ source: 'Marketplace', amountCents: 80_000 }],
      assessedValueCents: 60_000, suggestedLoanCents: 30_000,
      formula: 'lowest x 0.75 / 2', workings: [],
    });

    assert.equal(proofOfPurchaseForItem(store, rules, item.id).required, false);
  });
});

describe('it reaches his phone', () => {
  test('an expensive application carries the warning', async () => {
    const { AgentRouter } = await import('../src/router.ts');
    const { MemoryTransport } = await import('../src/whatsapp/transport.ts');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { generateMediaKey } = await import('../src/store/index.ts');

    const OWNER = '+264811110000';
    const CUSTOMER = '+264811000310';
    const media = {
      mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-proof-')),
      mediaKey: Buffer.from(generateMediaKey(), 'hex'),
    };
    const local = new Store(':memory:', media);
    const transport = new MemoryTransport();
    let counter = 0;
    const router = new AgentRouter({
      store: local, rules, transport, ownerPhone: OWNER,
      valuator: { async estimate() { return [{ source: 'Marketplace', amountCents: 1_045_000 }]; } },
    });
    const say = (text?: string, mediaId?: string) =>
      router.handle({ from: CUSTOMER, messageId: `m${++counter}`, type: mediaId ? 'image' : 'text', text, mediaId });

    try {
      await say('hi');
      await say('Aina Shipanga');
      await say('iPhone 15, 128GB, box included, battery health 95%');
      for (let turn = 0; turn < 45; turn += 1) {
        const last = transport.to(CUSTOMER).at(-1) ?? '';
        if (/sent your application/i.test(last)) break;
        if (/photo/i.test(last)) await say(undefined, `md${++counter}`);
        else if (/how much are you hoping/i.test(last)) await say('not sure');
        else if (/exactly what you have/i.test(last)) await say('iPhone 15, 128GB, box, battery 95%');
        else await say('yes');
      }

      const sent = transport.to(OWNER).at(-1)!;
      assert.match(sent, /Check the paperwork yourself/i);
      assert.match(sent, /original receipt/i);
      assert.match(sent, /settlement letter/i);

      // And the customer is told nothing about it — this is his verification,
      // not a new demand made of somebody mid-conversation.
      assert.doesNotMatch(transport.to(CUSTOMER).join('\n'), /settlement letter/i);
    } finally {
      local.close();
    }
  });
});
