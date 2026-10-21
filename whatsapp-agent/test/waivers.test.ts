/**
 * Waiving a document — playbook section 5.
 *
 * Lukas's rule, 21 October 2026, and the two ends of it are deliberately
 * different. The customer's end never moves: every document is always asked
 * for, always listed, and nobody is ever told they do not need it. His end
 * can: where he knows the person he may approve the file anyway, once, on the
 * record.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { Store, generateMediaKey } from '../src/store/index.ts';
import { AgentRouter } from '../src/router.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { DashboardQuery } from '../src/dashboard/index.ts';
import { outstandingFor } from '../src/requirements.ts';

const rules = loadRules();
const OWNER = '+264811110000';
const CUSTOMER = '+264811000040';

let store: Store;
let transport: MemoryTransport;
let router: AgentRouter;
let dash: DashboardQuery;
let counter = 0;

beforeEach(() => {
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-waive-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  });
  transport = new MemoryTransport();
  router = new AgentRouter({
    store, rules, transport, ownerPhone: OWNER,
    valuator: { async estimate() { return [{ source: 'Marketplace', amountCents: 900_000 }]; } },
  });
  dash = new DashboardQuery(store, rules);
});

afterEach(() => store.close());

const say = (from: string, text?: string, mediaId?: string) =>
  router.handle({ from, messageId: `m${++counter}`, type: mediaId ? 'image' : 'text', text, mediaId });

/** A full intake where the police declaration never arrives. */
async function intakeWithoutTheDeclaration(): Promise<void> {
  await say(CUSTOMER, 'hi');
  await say(CUSTOMER, 'Aina Shipanga');
  await say(CUSTOMER, 'iPhone 15, 128GB, box included, battery health 95%');

  for (let turn = 0; turn < 45; turn += 1) {
    const last = transport.to(CUSTOMER).at(-1) ?? '';
    if (/sent your application to Lukas/i.test(last)) return;
    // No receipt, so the police declaration becomes the fallback (section 5)
    // — and they have not been to the station either. Both gaps reach Lukas.
    if (/proof of ownership/i.test(last)) await say(CUSTOMER, "I don't have a receipt for it");
    else if (/police declaration/i.test(last)) await say(CUSTOMER, 'I have not been to the police station yet');
    else if (/photo/i.test(last)) await say(CUSTOMER, undefined, `md${++counter}`);
    else if (/how much are you hoping/i.test(last)) await say(CUSTOMER, 'not sure');
    else if (/exactly what you have/i.test(last)) await say(CUSTOMER, 'iPhone 15, 128GB, box, battery 95%');
    else await say(CUSTOMER, 'yes');
  }
}

const itemId = () => (store.db.prepare('SELECT id FROM items LIMIT 1').get() as { id: string }).id;

describe('the customer end never moves', () => {
  test('the document is still asked for, and said to be needed', async () => {
    await intakeWithoutTheDeclaration();
    const said = transport.to(CUSTOMER).join('\n');

    assert.match(said, /photo of the police declaration/i, 'it was asked');
    assert.match(said, /still needed/i, 'and never waived to their face');
    assert.doesNotMatch(said, /you don'?t need/i);
    assert.doesNotMatch(said, /not required/i);
  });

  test('and after approval they are still told to bring it', async () => {
    await intakeWithoutTheDeclaration();
    await say(OWNER, 'APPROVE');

    assert.match(transport.to(CUSTOMER).at(-1)!, /Bring your ID, proof of ownership and the police declaration/i);
  });

  test('an honest "I have not been to the police station" is not a theft report', async () => {
    await intakeWithoutTheDeclaration();

    // It used to escalate: the bare word "police" fired the ownership trigger,
    // so a customer doing exactly what the checklist asked was handed to Lukas
    // as a possible thief.
    assert.doesNotMatch(transport.to(OWNER).join('\n'), /Someone needs you/);
    assert.match(transport.to(OWNER).at(-1)!, /New pawn application/);
  });
});

describe('his end', () => {
  test('the gap reaches him before he decides', async () => {
    await intakeWithoutTheDeclaration();
    const sent = transport.to(OWNER).at(-1)!;

    assert.match(sent, /Still missing:/);
    assert.match(sent, /police declaration/i);
    assert.deepEqual(
      outstandingFor(store, rules, itemId()).documents.sort(),
      ['police declaration', 'proof of ownership'],
      'no receipt and no declaration is two gaps, not one',
    );
  });

  test('approving records what he approved around, with his name on it', async () => {
    await intakeWithoutTheDeclaration();
    await say(OWNER, 'APPROVE');

    const waivers = store.waivers(itemId());
    assert.deepEqual(
      waivers.map((waiver) => waiver.label).sort(),
      ['police declaration', 'proof of ownership'],
    );

    const trail = store.auditTrail('item', itemId()).map((entry) => entry.action);
    assert.ok(trail.includes('requirements.waived'), `audited: ${trail.join(', ')}`);
  });

  test('and he is told plainly what he just did', async () => {
    await intakeWithoutTheDeclaration();
    await say(OWNER, 'APPROVE');

    const confirmation = transport.to(OWNER).at(-1)!;
    assert.match(confirmation, /You approved this without/);
    assert.match(confirmation, /police declaration/i);
    assert.match(confirmation, /customer is still being asked/i);
  });

  test('a complete file produces no waiver and no note', async () => {
    await say(CUSTOMER, 'hi');
    await say(CUSTOMER, 'Aina Shipanga');
    await say(CUSTOMER, 'iPhone 15, 128GB, box included, battery 95%');
    for (let turn = 0; turn < 45; turn += 1) {
      const last = transport.to(CUSTOMER).at(-1) ?? '';
      if (/sent your application to Lukas/i.test(last)) break;
      if (/photo/i.test(last)) await say(CUSTOMER, undefined, `md${++counter}`);
      else if (/how much are you hoping/i.test(last)) await say(CUSTOMER, 'not sure');
      else if (/exactly what you have/i.test(last)) await say(CUSTOMER, 'iPhone 15, 128GB, box');
      else await say(CUSTOMER, 'yes');
    }
    await say(OWNER, 'APPROVE');

    assert.deepEqual(store.waivers(itemId()), []);
    assert.doesNotMatch(transport.to(OWNER).at(-1)!, /approved this without/i);
  });

  test('it is about that item, not about that customer', async () => {
    await intakeWithoutTheDeclaration();
    await say(OWNER, 'APPROVE');

    // The same person comes back with something else. The waiver does not
    // follow them — the playbook is explicit that it does not carry.
    const second = store.createItem({
      customerId: store.customerByPhone(CUSTOMER)!.id,
      categorySlug: 'phones',
      variant: 'iphone',
      description: 'iPhone 12',
    });
    assert.deepEqual(store.waivedFor(second.id), [], 'the next loan starts clean');
  });
});

describe('the dashboard stops chasing it', () => {
  test('a waived document moves them to ready for the office', async () => {
    await intakeWithoutTheDeclaration();

    const before = dash.read();
    assert.equal(before.awaitingDecision.length, 1);
    assert.deepEqual(before.awaitingDecision[0]!.missingDocuments.sort(), ['police declaration', 'proof of ownership']);

    await say(OWNER, 'APPROVE');

    const after = dash.read();
    assert.equal(after.missingDocuments.length, 0, 'he decided; it is not a chase any more');
    assert.equal(after.readyForTheOffice.length, 1);
  });

  test('but it is shown, not hidden', async () => {
    await intakeWithoutTheDeclaration();
    await say(OWNER, 'APPROVE');

    const ready = dash.read().readyForTheOffice[0]!;
    assert.deepEqual(
      ready.waived.sort(),
      ['police declaration', 'proof of ownership'],
      'the gaps stay visible with his name on them',
    );
    assert.deepEqual(ready.missingDocuments, []);
  });

  test('declining waives nothing', async () => {
    await intakeWithoutTheDeclaration();
    await say(OWNER, 'DECLINE no paperwork');

    assert.deepEqual(store.waivers(itemId()), []);
  });
});
