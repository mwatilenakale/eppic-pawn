/**
 * Items outside the five categories — playbook section 2, "Something else".
 *
 * The agent refuses nothing on its own authority. It asks Lukas and waits.
 * Every test here exists because a scenario run produced the wrong answer
 * first: a smartwatch was taken in as a phone, and a Samsung Galaxy was told
 * "we don't take that".
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
import { CategoryGate, parseCategoryReply } from '../src/intake/unknown.ts';
import { buildQuestionPlan, OTHER } from '../src/intake/questions.ts';
import { IntakeAgent } from '../src/intake/agent.ts';

const rules = loadRules();
const OWNER = '+264811110000';
const CUSTOMER = '+264811000002';
const WATCH = 'I have an Apple Watch Series 9, 45mm, like new with the box';

let store: Store;
let transport: MemoryTransport;
let router: AgentRouter;

beforeEach(() => {
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-unknown-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  });
  transport = new MemoryTransport();
  router = new AgentRouter({
    store, rules, transport, ownerPhone: OWNER,
    valuator: { async estimate() { return [{ source: 'Marketplace', amountCents: 350_000 }]; } },
  });
});

afterEach(() => store.close());

let counter = 0;
const from = (phone: string, text: string) => ({ from: phone, messageId: `wamid.${++counter}`, type: 'text' as const, text });

/** Gets a customer to the point where Lukas has been asked about a watch. */
async function askAboutTheWatch(): Promise<void> {
  await router.handle(from(CUSTOMER, 'hello'));
  await router.handle(from(CUSTOMER, 'Johannes Amutenya'));
  await router.handle(from(CUSTOMER, WATCH));
  await router.handle(from(CUSTOMER, WATCH));
}

describe('the matcher, which used to be the whole problem', () => {
  test('recognises what customers actually type', () => {
    const expected: [string, string][] = [
      ['Samsung Galaxy S25 Ultra, 512GB, perfect condition', 'phones'],
      ['Nokia 3310, old but works', 'phones'],
      ['PlayStation 5 with 2 controllers and FIFA', 'consoles'],
      ['Xbox Series X', 'consoles'],
      ['Dell XPS 15 laptop, 16GB RAM, and the box', 'laptops'],
      ['MacBook Pro 2021 M1', 'laptops'],
      ['Samsung 55 inch QLED 2022, with remote and stand', 'tvs'],
      ['my Toyota Hilux 2016 double cab', 'cars'],
    ];
    for (const [text, slug] of expected) {
      assert.equal(rules.category(text)?.slug, slug, `"${text}" should be ${slug}`);
    }
  });

  /**
   * The matcher used to test whether any word of 2+ letters appeared as a
   * SUBSTRING of the category name, so "an" (inside "iPhone and Android") made
   * anything a phone and "to" (inside "laptops") made anything a laptop.
   */
  test('does not match on noise words', () => {
    assert.equal(rules.category(WATCH), null, '"an" must not make an Apple Watch a phone');
    assert.equal(rules.category('let me talk to a real person'), null, '"to" must not make this a laptop');
    assert.equal(rules.category('this bot is useless'), null);
    assert.equal(rules.category('are you hiring?'), null);
    assert.equal(rules.category('yes'), null);
  });

  test('a brand that makes everything is not a guess', () => {
    // Apple and bare Samsung are deliberately absent from the playbook lists.
    assert.equal(rules.category('my Samsung'), null);
    assert.equal(rules.category('something Apple'), null);
  });

  test('the most specific term wins', () => {
    assert.equal(rules.category('Samsung TV 55 inch')?.slug, 'tvs');
    assert.equal(rules.category('Samsung Galaxy')?.slug, 'phones');
  });
});

describe('asking Lukas', () => {
  test('the customer is asked once more before he is bothered', async () => {
    await router.handle(from(CUSTOMER, 'hello'));
    await router.handle(from(CUSTOMER, 'Johannes Amutenya'));
    await router.handle(from(CUSTOMER, WATCH));

    assert.match(transport.to(CUSTOMER).at(-1)!, /not quite sure what that is/i);
    assert.equal(transport.to(OWNER).length, 0, 'he is not messaged on the first unclear line');
  });

  test('then he is asked, and the customer is told so', async () => {
    await askAboutTheWatch();

    assert.match(transport.to(CUSTOMER).at(-1)!, /ask Lukas/i);
    assert.match(transport.to(OWNER).at(-1)!, /Can we take this\?/);
    assert.match(transport.to(OWNER).at(-1)!, /Apple Watch/);
    assert.match(transport.to(OWNER).at(-1)!, /ACCEPT|REFUSE/);
  });

  test('the agent never refuses it itself', async () => {
    await askAboutTheWatch();
    const said = transport.to(CUSTOMER).join('\n');

    assert.doesNotMatch(said, /we don't take/i);
    assert.doesNotMatch(said, /we can't take/i);
  });

  test('and never quotes a figure while it waits', async () => {
    await askAboutTheWatch();
    assert.doesNotMatch(transport.to(CUSTOMER).join('\n'), /N\$\s?\d/);
  });

  test('messaging again while he has it does not ask him twice', async () => {
    await askAboutTheWatch();
    const asked = transport.to(OWNER).length;

    await router.handle(from(CUSTOMER, 'any news?'));
    await router.handle(from(CUSTOMER, 'hello?'));

    assert.equal(transport.to(OWNER).length, asked, 'he is asked once, not once per nudge');
    assert.match(transport.to(CUSTOMER).at(-1)!, /still waiting on Lukas/i);
    assert.equal(store.pendingCategoryRequests().length, 1);
  });

  test('they can offer something we do take while they wait', async () => {
    await askAboutTheWatch();
    await router.handle(from(CUSTOMER, 'actually I also have an iPhone 14'));

    assert.match(transport.to(CUSTOMER).at(-1)!, /exactly what you have/i);
  });
});

describe('his answer', () => {
  test('ACCEPT puts the conversation back on the rails', async () => {
    await askAboutTheWatch();
    await router.handle(from(OWNER, 'ACCEPT'));

    assert.match(transport.to(CUSTOMER).at(-1)!, /Lukas says we can take a look/i);
    assert.equal(store.pendingCategoryRequests().length, 0);

    await router.handle(from(CUSTOMER, 'Apple Watch Series 9, 45mm, steel, box and charger'));
    assert.match(transport.to(CUSTOMER).at(-1)!, /photo of the item/i);
  });

  test('REFUSE tells the customer, with his reason', async () => {
    await askAboutTheWatch();
    await router.handle(from(OWNER, 'REFUSE too hard to sell here'));

    const said = transport.to(CUSTOMER).at(-1)!;
    assert.match(said, /can't take that one/i);
    assert.match(said, /too hard to sell here/);
    assert.match(said, /phone, laptop, TV, console or a car/i, 'the door is left open');
  });

  test('his reason is kept and reused on the next one', async () => {
    await askAboutTheWatch();
    await router.handle(from(OWNER, 'REFUSE too hard to sell here'));

    const second = '+264811000099';
    await router.handle(from(second, 'hi'));
    await router.handle(from(second, 'Maria Kandjou'));
    await router.handle(from(second, 'Apple Watch Series 7'));
    await router.handle(from(second, 'Apple Watch Series 7'));

    assert.match(transport.to(second).at(-1)!, /don't take them/i);
    assert.match(transport.to(second).at(-1)!, /too hard to sell here/);
    assert.equal(store.pendingCategoryRequests().length, 0, 'he is not asked the same question twice');
  });

  test('ACCEPT and APPROVE are different words on purpose', () => {
    // Replying APPROVE to a smartwatch question must never approve a loan.
    assert.equal(parseCategoryReply('APPROVE K3P9'), null);
    assert.equal(parseCategoryReply('DECLINE K3P9 no thanks'), null);
    assert.deepEqual(parseCategoryReply('ACCEPT K3P9'), { action: 'accept', reference: 'K3P9', reason: '' });
    assert.deepEqual(parseCategoryReply('REFUSE K3P9 too hard'), { action: 'refuse', reference: 'K3P9', reason: 'too hard' });
  });

  test('staff cannot answer it either', () => {
    const staff: User = store.ensureUser({ name: 'Petrus', phone: '+264811112222', role: 'inspector' });
    const customer = store.upsertCustomer(CUSTOMER, 'Johannes');
    store.askAboutCategory({ customerId: customer.id, description: WATCH });

    const result = new CategoryGate(store, rules).decide({ action: 'accept', reference: null, reason: '' }, staff);
    assert.match(result.ownerMessage, /Only Lukas/);
    assert.equal(store.pendingCategoryRequests().length, 1, 'nothing moved');
  });

  test('two waiting questions make him say which', async () => {
    await askAboutTheWatch();
    const second = '+264811000098';
    await router.handle(from(second, 'hi'));
    await router.handle(from(second, 'Frans Uushona'));
    await router.handle(from(second, 'a Honda generator, 3kVA'));
    await router.handle(from(second, 'a Honda generator, 3kVA'));

    await router.handle(from(OWNER, 'ACCEPT'));
    assert.match(transport.to(OWNER).at(-1)!, /2 items are waiting/);
    assert.equal(store.pendingCategoryRequests().length, 2, 'neither was guessed at');
  });
});

describe('a one-off that was accepted', () => {
  test('is screened on the documents every loan needs, not a made-up checklist', () => {
    const plan = buildQuestionPlan(rules, OTHER);
    const asked = plan.questions.map((question) => question.ask).join(' | ');

    assert.match(asked, /exactly what you have/i);
    assert.match(asked, /photo of your ID/i);
    assert.match(asked, /police declaration/i);
    assert.equal(plan.categorySlug, OTHER);
  });

  test('an unknown slug that is not the one-off marker is still a bug', () => {
    assert.throws(() => buildQuestionPlan(rules, 'jewellery'), /Not an accepted category/);
  });
});

/**
 * Which kind of phone, when the brand already says — playbook section 2.
 *
 * Asking the owner of a Nokia 3310 whether it is an iPhone is the kind of
 * question that makes a customer decide nobody is reading. It was also what
 * tripped the stuck-conversation escalation on the commonest path there is:
 * most phones that come into the shop are Androids.
 */
describe('not asking what we already know', () => {
  test('an Android brand settles it', () => {
    for (const text of [
      'Samsung Galaxy S25 Ultra, 512GB',
      'Nokia 3310, old but works',
      'Huawei P30 lite',
      'my Redmi Note 12',
      'Google Pixel 7',
    ]) {
      assert.equal(rules.variantFrom('phones', text), 'android', text);
    }
  });

  test('and so does an iPhone', () => {
    assert.equal(rules.variantFrom('phones', 'iPhone 15, 128GB'), 'iphone');
  });

  test('a phone that names no brand is still asked', () => {
    assert.equal(rules.variantFrom('phones', 'a cellphone, 128GB, good condition'), null);
    assert.equal(rules.variantFrom('phones', 'my phone'), null);
  });

  test('a category with no variants is never guessed at', () => {
    assert.equal(rules.variantFrom('cars', 'Toyota Hilux 2016'), null);
    assert.equal(rules.variantFrom('laptops', 'Samsung laptop'), null);
  });

  test('the conversation skips the question entirely', () => {
    const store = new Store(':memory:');
    const agent = new IntakeAgent(store, rules);
    const phone = '+264811000077';

    agent.handle(phone, { text: 'hi' });
    agent.handle(phone, { text: 'Thomas Shilongo' });
    const { replies } = agent.handle(phone, { text: 'Samsung Galaxy S25 Ultra, 512GB, perfect condition' });

    assert.doesNotMatch(replies.join('\n'), /iPhone or Android/i);
    assert.match(replies.join('\n'), /exactly what you have/i);
    store.close();
  });
});
