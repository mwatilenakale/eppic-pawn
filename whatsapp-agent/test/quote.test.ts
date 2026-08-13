/**
 * The quote screen — step 4 of the design.
 *
 * The customer now sees an estimate, which is a change of policy Lukas made
 * deliberately. What has not changed is that it is an estimate: it is labelled
 * as one, it carries the verification banner, and nothing on this page is an
 * offer. The tests here exist mostly to keep that true.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { Store, generateMediaKey } from '../src/store/index.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { buildServer } from '../src/server.ts';
import { PriceMemory } from '../src/valuator/memory.ts';
import { formatAmount } from '../src/money.ts';
import type { Valuator } from '../src/router.ts';

const rules = loadRules();

/** Fixed estimates, so the figures on screen are predictable. */
const valuator: Valuator = {
  async estimate() {
    return [
      { source: 'Marketplace, Windhoek', amountCents: 1_200_000 },
      { source: 'Local dealer', amountCents: 1_044_000 },
    ];
  },
};

const config = {
  port: 0,
  whatsapp: { token: 't', phoneNumberId: 'p', appSecret: 's', verifyToken: 'v' },
  ownerPhone: '+264811110000',
  ownerName: 'Lukas',
  publicBaseUrl: 'http://127.0.0.1',
  dbPath: ':memory:',
  mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-quote-')),
  mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  anthropicApiKey: null,
  openaiApiKey: null,
  valuatorProvider: null,
};

let store: Store;
let base: string;
let built: ReturnType<typeof buildServer>;
let lukas: string;

before(async () => {
  store = new Store(':memory:', { mediaDirectory: config.mediaDirectory, mediaKey: config.mediaKey });
  built = buildServer(config, { transport: new MemoryTransport(), store, valuator });
  lukas = store.owner()!.id;
  await new Promise<void>((resolve) => built.server.listen(0, resolve));
  const { port } = built.server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  built.server.close();
  store.close();
});

const apply = async (fields: Record<string, string>) => {
  const response = await fetch(`${base}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, html: await response.text() };
};

describe('the estimate the customer sees', () => {
  test('shows the playbook\'s own arithmetic, from the lowest estimate', async () => {
    const { status, html } = await apply({ category: 'phones', variant: 'iphone', description: 'iPhone 13 Pro' });

    assert.equal(status, 200);
    // lowest 10,440 -> x0.75 = 7,830 assessed -> /2 = 3,915 loan -> +25% = 4,893.75
    assert.match(html, new RegExp(escapeRegExp(formatAmount(1_044_000))), 'market value');
    assert.match(html, new RegExp(escapeRegExp(formatAmount(783_000))), 'assessed value');
    assert.match(html, new RegExp(escapeRegExp(formatAmount(391_500))), 'pawn loan');
    assert.match(html, new RegExp(escapeRegExp(formatAmount(489_375))), 'buy outright');
  });

  test('buying outright is the bigger number, and says why', async () => {
    const { html } = await apply({ category: 'phones', variant: 'iphone', description: 'iPhone 13 Pro' });

    const loan = html.indexOf(formatAmount(391_500));
    const buy = html.indexOf(formatAmount(489_375));
    assert.ok(loan > 0 && buy > 0);
    assert.match(html, /We buy it outright/);
    assert.match(html, /the item is ours/, 'the trade-off is spelled out, not just the number');
  });

  test('it is never called an offer, and always carries the warning', async () => {
    const { html } = await apply({ category: 'phones', variant: 'iphone', description: 'iPhone 13 Pro' });

    assert.match(html, /This is an estimate, not an offer/);
    assert.match(html, /role="alert"/, 'the banner is announced to screen readers');
    assert.match(html, /Lukas confirms the final\s+amount himself/);
    assert.doesNotMatch(html, /\bwe will lend you\b|\byou will get\b|guaranteed/i, 'nothing reads as a promise');
  });

  test('an item with no description gets no invented figure', async () => {
    const { html } = await apply({ category: 'phones', variant: 'iphone' });

    assert.doesNotMatch(html, /N\$\s?\d/, 'nothing to price on, so nothing is priced');
    assert.match(html, /Lukas will work out your figure/);
  });
});

describe('when Lukas has already corrected this kind of item', () => {
  test('his number is used instead of a fresh estimate', async () => {
    new PriceMemory(store, rules).remember({
      key: { categorySlug: 'laptops', variant: null, description: 'Dell XPS 13' },
      loanCents: 250_000,
      buyNowCents: 312_500,
      assessedValueCents: 500_000,
      suggestedLoanCents: 391_500,
      adjustedBy: lukas,
    });

    const { html } = await apply({ category: 'laptops', description: 'Dell XPS 13' });

    assert.match(html, new RegExp(escapeRegExp(formatAmount(250_000))), 'his figure, not the estimate');
    assert.doesNotMatch(html, new RegExp(escapeRegExp(formatAmount(391_500))), 'the engine figure is not shown');
  });

  test('an adjustment for one model does not leak onto another', async () => {
    const { html } = await apply({ category: 'laptops', description: 'Lenovo ThinkPad X1' });
    assert.doesNotMatch(html, new RegExp(escapeRegExp(formatAmount(250_000))));
  });

  test('a model year is part of what the item is', async () => {
    // Deliberate: a 2015 XPS and a 2021 XPS are not the same money, so the
    // year keeps them apart even though colour and storage do not.
    const { html } = await apply({ category: 'laptops', description: 'Dell XPS 13, 2021' });
    assert.doesNotMatch(html, new RegExp(escapeRegExp(formatAmount(250_000))));
  });
});

describe('the design system is actually applied', () => {
  test('the four steps are shown, with the right one active', async () => {
    const { html } = await apply({ category: 'phones', variant: 'iphone', description: 'iPhone 13 Pro' });

    for (const label of ['Item', 'Details', 'Research', 'Quote']) assert.match(html, new RegExp(label));
    assert.match(html, /step-number active">4</, 'the quote step is the active one');
    assert.match(html, /step-number completed/, 'the earlier ones are done');
  });

  test('colours come from tokens, not from hex in the markup', async () => {
    const { html } = await apply({ category: 'phones', variant: 'iphone', description: 'iPhone 13 Pro' });

    const body = html.slice(html.indexOf('</style>'));
    assert.doesNotMatch(body, /#[0-9a-f]{6}/i, 'no raw hex below the token block');
    assert.match(html, /--accent-gold: #f5a623/, 'the token itself is defined once');
  });

  test('prices use tabular figures so columns line up', async () => {
    const { html } = await apply({ category: 'phones', variant: 'iphone', description: 'iPhone 13 Pro' });
    assert.match(html, /font-variant-numeric: tabular-nums/);
  });

  test('still loads nothing from anywhere else', async () => {
    const { html } = await apply({ category: 'phones', variant: 'iphone', description: 'iPhone 13 Pro' });

    assert.doesNotMatch(html, /<script/i, 'no scripts at all');
    assert.doesNotMatch(html, /https?:\/\/(?!wa\.me)/i, 'no fonts, no CDNs, no trackers');
  });

  test('motion is dropped for anyone who asked for that', async () => {
    const { html } = await apply({ category: 'phones', variant: 'iphone', description: 'iPhone 13 Pro' });
    assert.match(html, /prefers-reduced-motion: reduce/);
  });

  test('the page can still be zoomed', async () => {
    const { html } = await apply({ category: 'phones', variant: 'iphone', description: 'iPhone 13 Pro' });
    assert.doesNotMatch(html, /user-scalable=no|maximum-scale/, 'pinch-zoom is never disabled');
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('adjusting the figures', () => {
  test('a correction to the market value carries down the playbook chain', async () => {
    const { applyAdjustment } = await import('../src/valuator/adjust.ts');
    const before = { marketValueCents: 1_044_000, assessedValueCents: 783_000, loanCents: 391_500, buyNowCents: 489_375 };

    // He says the market has it at N$8,000, not N$10,440. Everything below
    // that follows from the playbook rather than needing to be retyped.
    const after = applyAdjustment(before, { market: 800_000 }, rules);

    assert.equal(after.marketValueCents, 800_000);
    assert.equal(after.assessedValueCents, 600_000, 'x 0.75');
    assert.equal(after.loanCents, 300_000, '/ 2');
    assert.equal(after.buyNowCents, 375_000, '+ 25%');
  });

  test('setting the loan directly overrides the formula and stays put', async () => {
    const { applyAdjustment } = await import('../src/valuator/adjust.ts');
    const before = { marketValueCents: 1_044_000, assessedValueCents: 783_000, loanCents: 391_500, buyNowCents: 489_375 };

    const after = applyAdjustment(before, { loan: 500_000 }, rules);

    assert.equal(after.loanCents, 500_000);
    assert.equal(after.marketValueCents, 1_044_000, 'the market value he did not touch is left alone');
    assert.equal(after.assessedValueCents, 783_000);
    assert.equal(after.buyNowCents, 625_000, 'but buy-now follows the loan');
  });

  test('what he types explicitly always beats what would be derived', async () => {
    const { applyAdjustment } = await import('../src/valuator/adjust.ts');
    const before = { marketValueCents: 1_044_000, assessedValueCents: 783_000, loanCents: 391_500, buyNowCents: 489_375 };

    const after = applyAdjustment(before, { market: 800_000, buy: 999_900 }, rules);

    assert.equal(after.loanCents, 300_000, 'derived from the new market value');
    assert.equal(after.buyNowCents, 999_900, 'except the one he set himself');
  });
});
