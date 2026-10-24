/**
 * Meta's 24-hour window — the prerequisite for task 004.
 *
 * WhatsApp only delivers a free-form message within 24 hours of the *user's*
 * last message to the business. Outside it, only a pre-approved template
 * arrives — and a free-form send does not fail loudly, it simply never
 * reaches anybody.
 *
 * Both defects here were found by Codex asking before widening its scope, on
 * task 004. It was right twice, and my earlier answer to it — "no migration,
 * join the message history" — was wrong.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/playbook/index.ts';
import { Store } from '../src/store/index.ts';
import { AgentRouter } from '../src/router.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { metaTimestampToIso } from '../src/whatsapp/webhook.ts';

const rules = loadRules();
const OWNER = '+264811110000';
const STAFF = '+264811112222';
const CUSTOMER = '+264811000400';

let store: Store;
let router: AgentRouter;
let counter = 0;

beforeEach(() => {
  store = new Store(':memory:');
  router = new AgentRouter({ store, rules, transport: new MemoryTransport(), ownerPhone: OWNER });
  store.ensureUser({ name: 'Petrus Haufiku', phone: STAFF, role: 'inspector' });
});

afterEach(() => store.close());

const secondsAgo = (ms: number) => String(Math.floor((Date.now() - ms) / 1000));
const send = (from: string, text: string, timestamp?: string) =>
  router.handle({ from, messageId: `m${++counter}`, type: 'text', text, timestamp });

describe('unknown means shut, never open', () => {
  test('a number we have never heard from has no window', () => {
    // The direction of the guess matters: assuming "open" costs a message
    // nobody receives, assuming "shut" costs the price of a template.
    assert.equal(store.lastInboundAt(CUSTOMER), null);
    assert.equal(store.lastInboundAt(OWNER), null);
  });

  test('a nonsense timestamp is discarded rather than trusted', () => {
    assert.equal(metaTimestampToIso(undefined), null);
    assert.equal(metaTimestampToIso(''), null);
    assert.equal(metaTimestampToIso('not-a-number'), null);
    assert.equal(metaTimestampToIso('12'), null, 'too short to be seconds');
  });

  test('and a real one converts', () => {
    assert.equal(metaTimestampToIso('1761000000'), new Date(1_761_000_000_000).toISOString());
  });
});

describe('every number, not just customers', () => {
  test('a customer opens their own window', async () => {
    await send(CUSTOMER, 'hi');
    assert.ok(store.lastInboundAt(CUSTOMER), 'the customer is known');
  });

  /**
   * The one that mattered. Owner and staff messages were recorded nowhere, so
   * the system could not tell whether the approval request would be delivered
   * — and that is the message every decision in this project depends on. At
   * launch his window would have been shut and nobody would have known.
   */
  test('so does the owner, whose window nothing used to track', async () => {
    await send(OWNER, 'BOOK');
    assert.ok(store.lastInboundAt(OWNER), 'the approval request has somewhere to go');
  });

  test('and the hire', async () => {
    await send(STAFF, 'BOOK');
    assert.ok(store.lastInboundAt(STAFF));
  });

  test('one number does not open another number’s window', async () => {
    await send(CUSTOMER, 'hi');
    assert.equal(store.lastInboundAt(OWNER), null);
    assert.equal(store.lastInboundAt(STAFF), null);
  });

  test('the same number in two formats is one window', async () => {
    await send(CUSTOMER, 'hi');
    const spaced = '081 100 0400';

    assert.ok(store.lastInboundAt(spaced), 'matched on the last nine digits');
    assert.equal(store.lastInboundAt(spaced)!.at, store.lastInboundAt(CUSTOMER)!.at);
  });
});

describe('Meta’s time, not ours', () => {
  test('a webhook delivered late does not look fresh', async () => {
    // Three days old at Meta, arriving now after an outage. Using our receipt
    // time would reopen a window that closed two days ago, and the free-form
    // message sent on the strength of it would never arrive.
    await send(CUSTOMER, 'hi', secondsAgo(3 * 86_400_000));

    const window = store.lastInboundAt(CUSTOMER)!;
    const ageHours = (Date.now() - Date.parse(window.at)) / 3_600_000;

    assert.ok(ageHours > 24, `recorded as ${ageHours.toFixed(1)}h old, so the window reads shut`);
    assert.equal(window.source, 'meta');
  });

  test('without a timestamp it says so, rather than pretending', async () => {
    await send(CUSTOMER, 'hi');
    assert.equal(store.lastInboundAt(CUSTOMER)!.source, 'received', 'a caller is entitled to know which');
  });

  test('the message row carries Meta’s time too', async () => {
    const when = secondsAgo(3 * 86_400_000);
    await send(CUSTOMER, 'hi', when);

    const customer = store.customerByPhone(CUSTOMER)!;
    const conversation = store.activeConversation(customer.id)!;
    assert.equal(store.messages(conversation.id)[0]!.created_at, metaTimestampToIso(when));
  });
});

describe('it only ever moves forward', () => {
  test('a redelivery out of order does not wind it back', async () => {
    await send(CUSTOMER, 'hi', secondsAgo(86_400_000));
    const after = store.lastInboundAt(CUSTOMER)!.at;

    store.noteInbound(CUSTOMER, new Date(Date.now() - 10 * 86_400_000).toISOString());

    assert.equal(store.lastInboundAt(CUSTOMER)!.at, after, 'the window must not shrink');
  });

  test('a newer message moves it on', async () => {
    await send(CUSTOMER, 'hi', secondsAgo(3 * 86_400_000));
    const old = store.lastInboundAt(CUSTOMER)!.at;

    await send(CUSTOMER, 'still there?');

    assert.ok(store.lastInboundAt(CUSTOMER)!.at > old);
  });

  test('a number too short to be a number is ignored, not stored', () => {
    store.noteInbound('123');
    assert.equal(store.lastInboundAt('123'), null);
  });
});
