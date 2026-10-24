/**
 * The dashboard — the three lists Lukas asked for by name: what is
 * outstanding today, what documents are still missing, and who has been
 * through the pre-screen with everything uploaded and is now only expected to
 * walk into the office.
 *
 * The hard property is the last one. "Ready for the office" sends somebody
 * across Windhoek, so a row on it must mean there is genuinely nothing left
 * to chase.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { Store, generateMediaKey, type User } from '../src/store/index.ts';
import { AgentRouter } from '../src/router.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { ContractService } from '../src/contract/index.ts';
import { DashboardQuery } from '../src/dashboard/index.ts';
import { dashboardPage } from '../src/web/dashboard.ts';
import { InspectionQueue } from '../src/inspection/queue.ts';

const rules = loadRules();
const OWNER = '+264811110000';

let store: Store;
let transport: MemoryTransport;
let router: AgentRouter;
let dash: DashboardQuery;
let lukas: User;
let staff: User;
let counter = 0;

beforeEach(() => {
  const media = {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-dash-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  };
  store = new Store(':memory:', media);
  transport = new MemoryTransport();
  router = new AgentRouter({
    store, rules, transport, ownerPhone: OWNER,
    valuator: { async estimate() { return [{ source: 'Marketplace', amountCents: 900_000 }]; } },
    contracts: new ContractService(store, rules, { baseUrl: 'https://eppic.na' }),
  });
  dash = new DashboardQuery(store, rules);
  lukas = store.owner()!;
  staff = store.ensureUser({ name: 'Petrus Haufiku', phone: '+264811112222', role: 'inspector' });
});

afterEach(() => store.close());

const say = (from: string, text?: string, mediaId?: string) =>
  router.handle({ from, messageId: `m${++counter}`, type: mediaId ? 'image' : 'text', text, mediaId });

/** A customer who answers everything properly, through to submission. */
async function completeIntake(phone: string, name: string, item: string): Promise<void> {
  await say(phone, 'hi');
  await say(phone, name);
  await say(phone, item);
  for (let turn = 0; turn < 45; turn += 1) {
    const last = transport.to(phone).at(-1) ?? '';
    if (/sent your application/i.test(last)) return;
    if (/photo/i.test(last)) await say(phone, undefined, `md${++counter}`);
    else if (/how much are you hoping/i.test(last)) await say(phone, 'not sure');
    else if (/exactly what you have/i.test(last)) await say(phone, item);
    else await say(phone, 'yes');
  }
}

/** Gives the item and the description, then stops. Documents outstanding. */
async function startedButStalled(phone: string, name: string, item: string): Promise<void> {
  await say(phone, 'hi');
  await say(phone, name);
  await say(phone, item);
  await say(phone, item);
}

describe('what is outstanding today', () => {
  test('an empty day reads as empty, not as broken', () => {
    const today = dash.read();

    assert.deepEqual(today.awaitingDecision, []);
    assert.deepEqual(today.readyForTheOffice, []);
    assert.deepEqual(today.missingDocuments, []);
    assert.equal(today.today.started, 0);
    assert.equal(today.book.activeLoans, 0);
  });

  test('a submitted application is waiting on Lukas, with its reference', async () => {
    await completeIntake('+264811000031', 'Aina Shipanga', 'iPhone 15, 128GB, boxed, battery 95%');
    const today = dash.read();

    assert.equal(today.awaitingDecision.length, 1);
    assert.equal(today.awaitingDecision[0]!.customerName, 'Aina Shipanga');
    assert.match(today.awaitingDecision[0]!.description, /iPhone 15/);
    assert.match(today.awaitingDecision[0]!.reference!, /^[A-Z][A-Z0-9]{3}$/, 'quotable back at him');
    assert.equal(today.today.started, 1);
  });

  test('a smartwatch waiting on his yes or no shows separately', async () => {
    await say('+264811000035', 'hello');
    await say('+264811000035', 'Johannes Amutenya');
    await say('+264811000035', 'an Apple Watch Series 9, boxed');
    await say('+264811000035', 'an Apple Watch Series 9, boxed');

    const today = dash.read();
    assert.equal(today.awaitingCategoryAnswer.length, 1);
    assert.match(today.awaitingCategoryAnswer[0]!.description, /Apple Watch/);
    assert.equal(today.awaitingCategoryAnswer[0]!.customerName, 'Johannes Amutenya');
  });

  test('a thread the agent stepped back from shows who has it', async () => {
    await say('+264811000036', 'hi');
    await say('+264811000036', 'Frans Uushona');
    await say('+264811000036', "I can't pay my loan this month, can I extend?");

    let today = dash.read();
    assert.equal(today.waitingOnAPerson.length, 1);
    assert.equal(today.waitingOnAPerson[0]!.heldByName, null, 'escalated, nobody on it yet');

    await say(OWNER, 'TAKE +264811000036');
    today = dash.read();
    assert.equal(today.waitingOnAPerson[0]!.heldByName, 'Lukas');
  });

  test('inspections waiting in the shop are counted', async () => {
    await completeIntake('+264811000031', 'Aina Shipanga', 'iPhone 15, 128GB, boxed');
    const itemId = (store.db.prepare('SELECT id FROM items LIMIT 1').get() as { id: string }).id;
    new InspectionQueue(store, rules).open({ itemId, actor: lukas.id });

    assert.deepEqual(dash.read().inspections, { waiting: 1, inHand: 0 });
  });
});

describe('ready for the office', () => {
  test('approved with everything in means exactly that', async () => {
    await completeIntake('+264811000031', 'Aina Shipanga', 'iPhone 15, 128GB, boxed, battery 95%');
    await say(OWNER, 'APPROVE');

    const today = dash.read();
    assert.equal(today.readyForTheOffice.length, 1);
    assert.equal(today.readyForTheOffice[0]!.customerName, 'Aina Shipanga');
    assert.deepEqual(today.readyForTheOffice[0]!.missingDocuments, []);
    assert.equal(today.readyForTheOffice[0]!.unansweredQuestions, 0);
    assert.equal(today.awaitingDecision.length, 0, 'it moved off his list');
  });

  test('not yet approved is not ready, however complete', async () => {
    await completeIntake('+264811000031', 'Aina Shipanga', 'iPhone 15, 128GB, boxed');
    assert.deepEqual(dash.read().readyForTheOffice, [], 'nothing is ready before he says so');
  });

  test('declined never appears', async () => {
    await completeIntake('+264811000031', 'Aina Shipanga', 'iPhone 15, 128GB, boxed');
    await say(OWNER, 'DECLINE too old');

    const today = dash.read();
    assert.deepEqual(today.readyForTheOffice, []);
    assert.deepEqual(today.awaitingDecision, []);
    assert.equal(today.today.decided, 1);
  });

  /**
   * The whole point of the list. Telling somebody to come in when a document
   * is still outstanding is a wasted trip across Windhoek.
   */
  test('an approved item with a document outstanding is NOT ready', async () => {
    await completeIntake('+264811000031', 'Aina Shipanga', 'iPhone 15, 128GB, boxed');
    await say(OWNER, 'APPROVE');

    const itemId = (store.db.prepare('SELECT id FROM items LIMIT 1').get() as { id: string }).id;
    store.db.prepare("DELETE FROM item_photos WHERE item_id = ? AND kind = 'id'").run(itemId);

    const today = dash.read();
    assert.deepEqual(today.readyForTheOffice, [], 'a missing ID keeps them at home');
    assert.equal(today.missingDocuments.length, 1);
    assert.match(today.missingDocuments[0]!.missingDocuments.join(' '), /copy of ID/);
  });
});

describe('still missing documents', () => {
  test('a stalled application lists what is outstanding', async () => {
    await startedButStalled('+264811000033', 'Maria Kandjou', 'MacBook Pro 2021 M1, 512GB');
    const today = dash.read();

    assert.equal(today.missingDocuments.length, 1);
    const line = today.missingDocuments[0]!;
    assert.match(line.missingDocuments.join(' '), /copy of ID/);
    assert.match(line.missingDocuments.join(' '), /police declaration/);
    assert.ok(line.unansweredQuestions > 0);
  });

  /**
   * `items.declared_details` is only written when intake completes, so reading
   * only that column reported every question outstanding for somebody who had
   * answered most of them.
   */
  test('answers given mid-conversation already count', async () => {
    await startedButStalled('+264811000033', 'Maria Kandjou', 'MacBook Pro 2021 M1, 512GB');
    const before = dash.read().missingDocuments[0]!.unansweredQuestions;

    await say('+264811000033', undefined, `md${++counter}`); // the item photo
    await say('+264811000033', 'yes');
    await say('+264811000033', 'yes');

    const after = dash.read().missingDocuments[0]!;
    assert.ok(after.unansweredQuestions < before, `${after.unansweredQuestions} should be fewer than ${before}`);
    assert.doesNotMatch(after.missingDocuments.join(' '), /photo of the item/, 'the photo arrived');
  });

  test('a description the agent gave up on is outstanding, not an answer', async () => {
    await say('+264811000037', 'hi');
    await say('+264811000037', 'Lucia Mbango');
    await say('+264811000037', 'laptop');
    for (const junk of ['yes', 'sure', 'yes please']) await say('+264811000037', junk);
    await say('+264811000037', undefined, `md${++counter}`);

    const line = dash.read().missingDocuments.find((deal) => deal.customerName === 'Lucia Mbango');
    assert.ok(line, 'somebody stuck on the description must still be visible');
    assert.match(line.missingDocuments.join(' '), /a description/);
    assert.equal(line.description, '(not described yet)', 'nothing was invented to price');
  });
});

describe('the page itself', () => {
  test('renders the lists, and nothing third-party', async () => {
    await completeIntake('+264811000031', 'Aina Shipanga', 'iPhone 15, 128GB, boxed, battery 95%');
    const html = dashboardPage(dash.read(), staff.name, true);

    assert.match(html, /Waiting on Lukas/);
    assert.match(html, /Ready for the office/);
    assert.match(html, /Still missing documents/);
    assert.match(html, /Aina Shipanga/);
    assert.match(html, /iPhone 15/);

    // Same rule as the public site: the page loads nothing from anywhere else.
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/, 'no external asset or font');
    assert.match(html, /noindex/, 'a staff page is not for search engines');
  });

  test('the totals are behind the capability, not the template', async () => {
    await completeIntake('+264811000031', 'Aina Shipanga', 'iPhone 15, 128GB, boxed');

    const withTotals = dashboardPage(dash.read(), staff.name, true);
    const without = dashboardPage(dash.read(), staff.name, false);

    assert.match(withTotals, /out on loan/i);
    assert.doesNotMatch(without, /out on loan/i, 'restoring the restriction is one flag, not a rewrite');
  });

  test('an empty day renders without blowing up', () => {
    const html = dashboardPage(dash.read(), staff.name, true);
    assert.match(html, /Nothing is waiting on a decision/);
  });
});

describe('reading the dashboard cannot change anything', () => {
  test('it writes nothing at all', async () => {
    await completeIntake('+264811000031', 'Aina Shipanga', 'iPhone 15, 128GB, boxed');

    const snapshot = () =>
      ['items', 'approvals', 'loans', 'ledger_entries', 'conversations', 'category_requests', 'audit_log']
        .map((table) => `${table}:${JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all())}`)
        .join('|');

    const before = snapshot();
    dash.read();
    dash.read();
    assert.equal(snapshot(), before, 'a refresh must not move an application along');
  });
});
