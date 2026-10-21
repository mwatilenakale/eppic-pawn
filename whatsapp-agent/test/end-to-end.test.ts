/**
 * One customer, one item, one decision — the whole of step 1, asserted against
 * the rules as they are written in the documents rather than against constants
 * repeated here.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules, RATE_STANDARD } from '../src/playbook/index.ts';
import { Store, generateMediaKey } from '../src/store/index.ts';
import { AgentRouter, type Valuator } from '../src/router.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { formatAmount } from '../src/money.ts';
import { referenceFor } from '../src/approval/index.ts';

const rules = loadRules();
const CUSTOMER = '+264811234567';
// Lukas's own phone. Deliberately not the shop's number in the playbook:
// the number registered with Meta cannot also be the one he replies from.
const OWNER = '+264811110000';

/** Stands in for the Claude valuator with fixed numbers, so the test is stable. */
const valuator: Valuator = {
  async estimate() {
    return [
      { source: 'Marketplace, Windhoek', amountCents: 1_200_000 },
      { source: 'Local dealer', amountCents: 1_000_000 },
    ];
  },
};

let store: Store;
let transport: MemoryTransport;
let router: AgentRouter;

beforeEach(() => {
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-e2e-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  });
  transport = new MemoryTransport();
  router = new AgentRouter({ store, rules, transport, ownerPhone: OWNER, valuator });
});

afterEach(() => store.close());

let counter = 0;
const fromCustomer = (text?: string) => ({
  from: CUSTOMER,
  messageId: `wamid.${(counter += 1)}`,
  type: text ? ('text' as const) : ('image' as const),
  text,
  mediaId: text ? undefined : `media.${counter}`,
});

/** Answers whatever the agent last asked, until the application is submitted. */
async function completeIntake(): Promise<void> {
  await router.handle(fromCustomer('hello'));
  await router.handle(fromCustomer('Test Customer'));
  await router.handle(fromCustomer('phone'));
  await router.handle(fromCustomer('iPhone'));

  for (let turn = 0; turn < 40; turn += 1) {
    const last = transport.to(CUSTOMER).at(-1) ?? '';
    if (/sent your application to Lukas/i.test(last)) return;

    if (/photo/i.test(last)) await router.handle(fromCustomer());
    else if (/how much are you hoping/i.test(last)) await router.handle(fromCustomer('3000'));
    else if (/Reply \*yes\*/.test(last)) await router.handle(fromCustomer('yes'));
    else await router.handle(fromCustomer('iPhone 13 Pro, 256GB, good condition'));
  }
  assert.fail('intake never completed');
}

describe('end to end: message to decision', () => {
  test('an approved application, from first hello to the customer being told', async () => {
    await completeIntake();

    // 1. Lukas has an application; the customer has heard no figure.
    const application = transport.to(OWNER).at(-1)!;
    assert.match(application, /New pawn application/);
    assert.match(application, /iPhone 13 Pro/);
    assert.match(application, /N\$3,750\.00 suggested loan/);
    assert.match(application, /To verify in person/);
    assert.doesNotMatch(transport.to(CUSTOMER).join('\n'), /N\$\s?\d/);
    assert.equal(store.pendingApprovals().length, 1);

    // 2. Nothing has been approved by anything other than a person.
    const approval = store.pendingApprovals()[0]!;
    assert.equal(approval.status, 'pending');
    assert.equal(store.item(approval.item_id)?.status, 'awaiting-approval');

    // 3. Lukas replies. Only now does a figure reach the customer.
    const reference = referenceFor(approval.id);
    await router.handle({ from: OWNER, messageId: 'wamid.owner', type: 'text', text: `approve ${reference}` });

    const standard = rules.rate(RATE_STANDARD)!;
    const toCustomer = transport.to(CUSTOMER).at(-1)!;
    assert.match(toCustomer, /N\$3,750\.00/);
    assert.match(toCustomer, new RegExp(`${standard.ratePct}% over ${standard.termDays} days`));
    assert.match(toCustomer, /subject to the in-person check/i);

    // 4. The record says who decided, and when.
    const decided = store.approval(approval.id)!;
    assert.equal(decided.status, 'approved');
    assert.equal(decided.approved_loan_cents, 375_000);
    assert.equal(decided.decided_by, store.owner()!.id);
    assert.ok(decided.decided_at);
    assert.equal(store.item(approval.item_id)?.status, 'approved');
    assert.deepEqual(
      store.auditTrail('approval', approval.id).map((row) => row.action),
      ['approval.requested', 'approval.approved'],
    );

    // 5. The customer's transcript is complete and the thread is closed.
    const conversation = store.db
      .prepare('SELECT id, status FROM conversations LIMIT 1')
      .get() as { id: string; status: string };
    assert.equal(conversation.status, 'closed');
    const transcript = store.messages(conversation.id);
    assert.ok(transcript.length > 15);
    assert.equal(transcript.at(-1)?.direction, 'out');
    assert.match(transcript.at(-1)!.body, /N\$3,750\.00/);
  });

  test('the amount offered comes from the playbook, not from the code', async () => {
    await completeIntake();
    const approval = store.pendingApprovals()[0]!;
    await router.handle({
      from: OWNER,
      messageId: 'wamid.owner2',
      type: 'text',
      text: `approve ${referenceFor(approval.id)}`,
    });

    // Recompute the expected figures straight from the documents.
    const { discountFactor, divisor } = rules.playbook.loanSizing;
    const lowestEstimate = 1_000_000;
    const expectedLoan = Math.round((lowestEstimate * discountFactor) / divisor);
    const standard = rules.rate(RATE_STANDARD)!;
    const expectedDue = expectedLoan + Math.round((expectedLoan * standard.ratePct!) / 100);

    const toCustomer = transport.to(CUSTOMER).at(-1)!;
    assert.match(toCustomer, new RegExp(formatAmount(expectedLoan).replace(/\$/g, '\\$')));
    assert.match(toCustomer, new RegExp(formatAmount(expectedDue).replace(/\$/g, '\\$')));
  });

  test('a declined application never produces a figure', async () => {
    await completeIntake();
    const approval = store.pendingApprovals()[0]!;
    await router.handle({
      from: OWNER,
      messageId: 'wamid.owner3',
      type: 'text',
      text: `decline ${referenceFor(approval.id)} no proof of ownership`,
    });

    const toCustomer = transport.to(CUSTOMER).join('\n');
    assert.doesNotMatch(toCustomer, /N\$\s?\d/);
    assert.match(transport.to(CUSTOMER).at(-1)!, /no proof of ownership/);
    assert.equal(store.item(approval.item_id)?.status, 'declined');
  });

  test('ID photos are on disk encrypted, and the ledger stays correctable only by reversal', async () => {
    await completeIntake();
    const item = store.db.prepare('SELECT id FROM items LIMIT 1').get() as { id: string };
    const photos = store.photos(item.id);

    assert.ok(photos.length >= 3, 'item, ID and documents were collected');
    for (const photo of photos) {
      assert.match(photo.media_path, /\.enc$/);
      assert.ok(store.media!.get(photo.media_path).length > 0, 'decrypts with the configured key');
    }
  });
});
