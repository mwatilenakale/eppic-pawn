/**
 * Customers are never told the owner's name — playbook header, 21 October 2026.
 *
 * "It mustn't say Lukas, it must say management or something." He is named
 * freely in messages to him, on the staff screens and in the records; the
 * people on the other side of the counter read the role.
 *
 * This is the guard rather than a one-time sweep, because the name is the kind
 * of thing that creeps back into one new message at a time.
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
import { ContractService } from '../src/contract/index.ts';

const rules = loadRules();
const OWNER_PHONE = '+264811110000';
const CUSTOMER = '+264811000120';
const OWNER_NAME = 'Lukas';

let store: Store;
let transport: MemoryTransport;
let router: AgentRouter;
let counter = 0;

beforeEach(() => {
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-label-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  });
  transport = new MemoryTransport();
  router = new AgentRouter({
    store, rules, transport, ownerPhone: OWNER_PHONE,
    valuator: { async estimate() { return [{ source: 'Marketplace', amountCents: 900_000 }]; } },
    contracts: new ContractService(store, rules, { baseUrl: 'https://eppic.na' }),
  });
});

afterEach(() => store.close());

const say = (from: string, text?: string, mediaId?: string) =>
  router.handle({ from, messageId: `m${++counter}`, type: mediaId ? 'image' : 'text', text, mediaId });

/** Everything the shop has said to this customer. */
const saidToCustomer = (phone = CUSTOMER) => transport.to(phone).join('\n---\n');

function assertUnnamed(text: string, what: string): void {
  assert.doesNotMatch(text, new RegExp(OWNER_NAME, 'i'), `${what} names the owner to a customer`);
}

describe('the label comes from the playbook', () => {
  test('and is a role, not a name', () => {
    assert.equal(rules.playbook.ownerLabel, 'the manager');
    assert.doesNotMatch(rules.playbook.ownerLabel, /lukas/i);
  });
});

describe('across a whole application', () => {
  /** Everything a customer could trigger, start to finish. */
  async function fullFlow(): Promise<void> {
    await say(CUSTOMER, 'How much can I get for an iPhone 15?');
    await say(CUSTOMER, 'Aina Shipanga');
    await say(CUSTOMER, 'iPhone 15, 128GB, box included, battery health 95%');

    for (let turn = 0; turn < 45; turn += 1) {
      const last = transport.to(CUSTOMER).at(-1) ?? '';
      if (/sent your application/i.test(last)) break;
      if (/photo/i.test(last)) await say(CUSTOMER, undefined, `md${++counter}`);
      else if (/how much are you hoping/i.test(last)) await say(CUSTOMER, 'not sure');
      else if (/exactly what you have/i.test(last)) await say(CUSTOMER, 'iPhone 15, 128GB, box, battery 95%');
      else await say(CUSTOMER, 'yes');
    }
  }

  test('intake says the role, never the name', async () => {
    await fullFlow();
    const said = saidToCustomer();

    assertUnnamed(said, 'intake');
    assert.match(said, /the manager/i, 'and it does say who decides');
  });

  test('the approval message too', async () => {
    await fullFlow();
    await say(OWNER_PHONE, 'APPROVE');
    assertUnnamed(saidToCustomer(), 'the approval message');
  });

  test('and a decline', async () => {
    await fullFlow();
    await say(OWNER_PHONE, 'DECLINE too old');
    assertUnnamed(saidToCustomer(), 'the decline message');
  });

  test('a price question at any point', async () => {
    await say(CUSTOMER, 'hi');
    await say(CUSTOMER, 'Aina Shipanga');
    await say(CUSTOMER, 'iPhone 15, 128GB, battery 95%');
    await say(CUSTOMER, 'so how much will you give me?');
    assertUnnamed(saidToCustomer(), 'the price deflection');
  });

  test('a description too thin to price', async () => {
    await say(CUSTOMER, 'hi');
    await say(CUSTOMER, 'Aina Shipanga');
    await say(CUSTOMER, 'phone');
    await say(CUSTOMER, 'iPhone');
    await say(CUSTOMER, 'yes');
    assertUnnamed(saidToCustomer(), 'the ask-again message');
  });
});

describe('the other things a customer can set off', () => {
  test('an item outside the five categories', async () => {
    await say(CUSTOMER, 'hello');
    await say(CUSTOMER, 'Johannes Amutenya');
    await say(CUSTOMER, 'an Apple Watch Series 9, boxed');
    await say(CUSTOMER, 'an Apple Watch Series 9, boxed');
    await say(CUSTOMER, 'any news?');
    assertUnnamed(saidToCustomer(), 'the out-of-category wait');

    await say(OWNER_PHONE, 'REFUSE too hard to sell');
    assertUnnamed(saidToCustomer(), 'the refusal');
  });

  test('a one Lukas accepted', async () => {
    await say(CUSTOMER, 'hello');
    await say(CUSTOMER, 'Johannes Amutenya');
    await say(CUSTOMER, 'a Honda generator, 3kVA');
    await say(CUSTOMER, 'a Honda generator, 3kVA');
    await say(OWNER_PHONE, 'ACCEPT');
    assertUnnamed(saidToCustomer(), 'the acceptance');
  });

  test('being handed to a person', async () => {
    await say(CUSTOMER, 'hi');
    await say(CUSTOMER, 'Aina Shipanga');
    await say(CUSTOMER, 'iPhone 15, 128GB, battery 95%');
    await say(CUSTOMER, 'can you do 6000?');
    assertUnnamed(saidToCustomer(), 'the handover line');
  });

  test('every holding line, whatever the trigger', async () => {
    for (const [index, trigger] of [
      'let me talk to a real person',
      "I can't pay my loan this month",
      'honestly I took it from my cousin',
    ].entries()) {
      const phone = `+2648110001${30 + index}`;
      await say(phone, 'hi');
      await say(phone, 'Test Customer');
      await say(phone, trigger);
      assertUnnamed(saidToCustomer(phone), `the holding line for "${trigger}"`);
    }
  });

  test('getting nowhere', async () => {
    await say(CUSTOMER, 'hi');
    await say(CUSTOMER, 'Aina Shipanga');
    await say(CUSTOMER, 'a cellphone, 128GB');
    await say(CUSTOMER, 'the blue one');
    await say(CUSTOMER, 'the blue one');
    assertUnnamed(saidToCustomer(), 'the stuck-conversation line');
  });
});

describe('the website and the contract', () => {
  test('no page a customer loads carries the name', async () => {
    const { landingPage, chooseCategoryPage, questionsPage, outcomePage } = await import('../src/web/pages.ts');
    const { precheckQuestions, evaluatePrecheck } = await import('../src/web/precheck.ts');

    const phones = rules.category('phones')!;
    const pages = [
      landingPage(rules),
      chooseCategoryPage(rules),
      chooseCategoryPage(rules, "We don't normally take a fridge, but it isn't an automatic no."),
      questionsPage(rules, phones, 'iphone', precheckQuestions(rules, 'phones', 'iphone')),
    ];

    // Every outcome the pre-check can reach, including the awkward ones.
    const answerSets: Record<string, string>[] = [{}, { 'phones-1': 'no' }, { 'phones-1': 'not sure' }];
    for (const answers of answerSets) {
      const outcome = evaluatePrecheck(rules, {
        category: 'phones', variant: 'iphone',
        description: 'iPhone 15, 128GB, good condition', answers,
        quote: null,
      });
      pages.push(outcomePage(outcome, rules.playbook.whatsapp, rules.playbook.ownerLabel));
    }

    for (const [index, page] of pages.entries()) assertUnnamed(page, `website page ${index}`);
    assert.match(pages.join('\n'), /the manager/i, 'and the role does appear');

    // A role still called "he" is not anonymised. On a one-man shop the
    // pronoun tells a customer exactly as much as the name did — and the
    // no-quote card said "he will come back to you himself" for three days
    // after I claimed the pronouns had gone with the name.
    for (const [index, page] of pages.entries()) {
      const prose = page.replace(/<[^>]+>/g, ' ');
      assert.doesNotMatch(prose, /\bhe will\b|\bhe has\b|\bhe checks\b|\bhimself\b/i, `website page ${index} says "he"`);
    }
  });

  test('nor the contract pages a customer is sent to', async () => {
    const { contractErrorPage } = await import('../src/contract/page.ts');

    // The expired-link message used to read "ask Lukas for a new one"; it is
    // the one contract string a customer reads unprompted. Taken from the
    // source rather than retyped, so a reworded message is still checked.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/contract/index.ts', import.meta.url), 'utf8'),
    );
    const expired = /has expired[^`']*/.exec(source)![0];

    assertUnnamed(expired, 'the expired-link message');
    assertUnnamed(contractErrorPage(`The signing link ${expired}`, rules.playbook.whatsapp), 'the expired-link page');
  });
});

describe('he is still named where he should be', () => {
  test('in the messages to him', async () => {
    await say(CUSTOMER, 'hi');
    await say(CUSTOMER, 'Aina Shipanga');
    await say(CUSTOMER, 'can you do 6000?');

    // Not a privacy matter on his own phone, and "the manager needs you" would
    // be absurd.
    assert.ok(transport.to(OWNER_PHONE).length > 0, 'he was messaged');
  });

  test('and in the records', () => {
    assert.equal(store.owner()?.name, 'Lukas', 'the audit trail names people');
  });
});
