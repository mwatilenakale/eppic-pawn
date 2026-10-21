/**
 * Knowing when to stop talking — docs/tasks/003.
 *
 * Every trigger here comes from a scenario run where the agent answered
 * something it had no business answering: it carried cheerfully on asking for
 * photos after "honestly I took it from my cousin", and it kept trying to run
 * an intake on somebody who had asked three times for a person.
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
import { detectHandover, parseHandoverCommand } from '../src/intake/handover.ts';

const rules = loadRules();
const OWNER = '+264811110000';
const STAFF = '+264811112222';
const CUSTOMER = '+264811000009';

let store: Store;
let transport: MemoryTransport;
let router: AgentRouter;
let staff: User;

beforeEach(() => {
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-handover-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  });
  transport = new MemoryTransport();
  router = new AgentRouter({
    store, rules, transport, ownerPhone: OWNER,
    valuator: { async estimate() { return [{ source: 'Marketplace', amountCents: 900_000 }]; } },
  });
  staff = store.ensureUser({ name: 'Petrus Haufiku', phone: STAFF, role: 'inspector' });
});

afterEach(() => store.close());

let counter = 0;
const from = (phone: string, text: string) => ({ from: phone, messageId: `wamid.${++counter}`, type: 'text' as const, text });

/** Mid-intake, so escalation has a transcript and a state to come back to. */
async function midIntake(): Promise<void> {
  await router.handle(from(CUSTOMER, 'hi'));
  await router.handle(from(CUSTOMER, 'Selma Gowases'));
  await router.handle(from(CUSTOMER, 'Samsung Galaxy S24, 256GB, good condition'));
}

describe('what the agent will not answer', () => {
  test('each trigger is recognised', () => {
    assert.equal(detectHandover('can you do 6000?')?.reason, 'negotiating');
    assert.equal(detectHandover("I can't pay my loan this month")?.reason, 'existing-loan');
    assert.equal(detectHandover('let me talk to a real person')?.reason, 'asked-for-a-person');
    assert.equal(detectHandover('this bot is useless')?.reason, 'asked-for-a-person');
    assert.equal(detectHandover('honestly I took it from my cousin')?.reason, 'ownership');
    assert.equal(detectHandover('the police have a case open')?.reason, 'ownership');
  });

  test('ordinary intake messages are left alone', () => {
    for (const ordinary of [
      'iPhone 15, 128GB, box included, battery health 95%',
      'Aina Shipanga',
      'yes',
      'not sure',
      'Samsung 55 inch QLED with the remote',
      'no box',
      // The checklist asks for this document by name.
      'yes I have the police declaration of ownership',
      'I still need to get the police declaration',
    ]) {
      assert.equal(detectHandover(ordinary), null, `"${ordinary}" should not escalate`);
    }
  });

  test('ownership beats a price question in the same message', () => {
    // Checked in order of seriousness, not of appearance.
    assert.equal(detectHandover('can you do 5000 for it, it was stolen anyway')?.reason, 'ownership');
  });
});

describe('stepping back', () => {
  test('a theft admission stops the intake dead', async () => {
    await midIntake();
    await router.handle(from(CUSTOMER, 'honestly I took it from my cousin, he does not know'));

    assert.match(transport.to(OWNER).at(-1)!, /ownership or the police/i);
    // It used to reply "Please send a clear photo of the item itself."
    assert.doesNotMatch(transport.to(CUSTOMER).at(-1)!, /photo/i);
  });

  test('the customer gets one line, not silence', async () => {
    await midIntake();
    await router.handle(from(CUSTOMER, 'can you do 6000?'));

    assert.match(transport.to(CUSTOMER).at(-1)!, /Lukas's to decide/i);
    assert.doesNotMatch(transport.to(CUSTOMER).join('\n'), /N\$\s?\d/, 'and still no figure');
  });

  test('Lukas gets the reason and the last few messages', async () => {
    await midIntake();
    await router.handle(from(CUSTOMER, 'let me talk to a real person'));
    const sent = transport.to(OWNER).at(-1)!;

    assert.match(sent, /Selma Gowases/);
    assert.match(sent, /asked to speak to a person/i);
    assert.match(sent, /Samsung Galaxy S24/, 'the transcript came with it');
    assert.match(sent, /SAY \+264811000009/);
  });

  test('then it says nothing at all until handed back', async () => {
    await midIntake();
    await router.handle(from(CUSTOMER, 'let me talk to a real person'));
    const quietFrom = transport.to(CUSTOMER).length;

    await router.handle(from(CUSTOMER, 'hello?'));
    await router.handle(from(CUSTOMER, 'are you there'));
    await router.handle(from(CUSTOMER, 'iPhone 13'));

    assert.equal(transport.to(CUSTOMER).length, quietFrom, 'the agent kept talking over a person');
  });

  test('but the transcript stays complete', async () => {
    await midIntake();
    await router.handle(from(CUSTOMER, 'let me talk to a real person'));
    await router.handle(from(CUSTOMER, 'this is urgent'));

    const customer = store.customerByPhone(CUSTOMER)!;
    const conversation = store.activeConversation(customer.id)!;
    const bodies = store.messages(conversation.id).map((message) => message.body).join('\n');
    assert.match(bodies, /this is urgent/, 'what they said while waiting is on the record');
  });

  test('escalating twice does not message him twice', async () => {
    await midIntake();
    await router.handle(from(CUSTOMER, 'let me talk to a real person'));
    const asked = transport.to(OWNER).length;

    await router.handle(from(CUSTOMER, 'can you do 6000?'));
    assert.equal(transport.to(OWNER).length, asked);
  });
});

describe('a person taking over', () => {
  test('SAY reaches the customer from the shop number, and lands in the transcript', async () => {
    await midIntake();
    await router.handle(from(CUSTOMER, 'let me talk to a real person'));
    await router.handle(from(OWNER, 'SAY +264811000009 Lukas here, I can do 5500 if you bring the box.'));

    assert.match(transport.to(CUSTOMER).at(-1)!, /Lukas here, I can do 5500/);
    const conversation = store.activeConversation(store.customerByPhone(CUSTOMER)!.id)!;
    assert.match(store.messages(conversation.id).map((m) => m.body).join('\n'), /bring the box/);
  });

  test('a figure typed into SAY changes no loan, approval or ledger row', async () => {
    await midIntake();
    await router.handle(from(CUSTOMER, 'can you do 6000?'));
    await router.handle(from(OWNER, 'SAY +264811000009 I can do 6000, yes.'));

    assert.deepEqual(store.db.prepare('SELECT * FROM loans').all(), []);
    assert.deepEqual(store.db.prepare('SELECT * FROM ledger_entries').all(), []);
    assert.deepEqual(
      store.db.prepare("SELECT * FROM approvals WHERE status <> 'pending'").all(),
      [],
      'SAY is a message and nothing more',
    );
  });

  test('BACK resumes mid-flow without losing the intake state', async () => {
    await midIntake();
    // A Samsung Galaxy is an Android by the playbook's variant hints, so the
    // pending question is already the description.
    assert.match(transport.to(CUSTOMER).at(-1)!, /exactly what you have/i);

    await router.handle(from(CUSTOMER, 'let me talk to a real person'));
    await router.handle(from(OWNER, 'BACK +264811000009'));

    // Answering the question it was on moves the intake forward, rather than
    // starting the customer over from "what is your name?".
    await router.handle(from(CUSTOMER, 'Samsung Galaxy S24, 256GB, tiny chip on the corner'));
    assert.match(transport.to(CUSTOMER).at(-1)!, /photo of the item/i, 'picked up where it left off');
  });

  test('TAKE claims a quiet thread, and somebody else cannot steal it', async () => {
    await midIntake();
    await router.handle(from(STAFF, 'TAKE +264811000009'));
    assert.match(transport.to(STAFF).at(-1)!, /You have Selma/);

    await router.handle(from(OWNER, 'TAKE +264811000009'));
    assert.match(transport.to(OWNER).at(-1)!, /Petrus Haufiku already has/);
  });

  test('WAITING lists who is waiting, and whether anybody has them', async () => {
    await midIntake();
    await router.handle(from(CUSTOMER, 'let me talk to a real person'));

    await router.handle(from(OWNER, 'WAITING'));
    assert.match(transport.to(OWNER).at(-1)!, /Selma Gowases/);
    assert.match(transport.to(OWNER).at(-1)!, /nobody yet/, 'escalated but unclaimed');

    await router.handle(from(STAFF, 'TAKE +264811000009'));
    await router.handle(from(OWNER, 'WAITING'));
    assert.match(transport.to(OWNER).at(-1)!, /with Petrus/);
  });

  test('staff can take and reply, and still cannot approve', async () => {
    await midIntake();
    await router.handle(from(STAFF, 'SAY +264811000009 Petrus here, bring it in tomorrow.'));
    assert.match(transport.to(CUSTOMER).at(-1)!, /Petrus here/);

    await router.handle(from(STAFF, 'APPROVE'));
    assert.match(transport.to(STAFF).at(-1)!, /Pricing and approvals are Lukas/i);
  });

  test('the commands read the way people type them', () => {
    assert.deepEqual(parseHandoverCommand('TAKE 081 555 0101'), { action: 'take', phone: '0815550101', message: '' });
    assert.deepEqual(parseHandoverCommand('back +264 81 555 0101'), { action: 'back', phone: '+264815550101', message: '' });
    assert.deepEqual(parseHandoverCommand('WAITING'), { action: 'waiting', phone: null, message: '' });
    assert.equal(parseHandoverCommand('BOOK'), null);
    assert.equal(parseHandoverCommand('APPROVE K3P9'), null);
    assert.equal(parseHandoverCommand('take'), null, 'no number, no command');
  });

  test('an unknown number is said so, not silently swallowed', async () => {
    await router.handle(from(OWNER, 'SAY 0810000000 hello?'));
    assert.match(transport.to(OWNER).at(-1)!, /No open conversation/);
  });
});

/**
 * The loop that used to swallow conversations whole.
 *
 * A customer who answered "Is it iPhone or Android?" with anything matching
 * neither was asked it again, and again, with no limit. Nothing reached Lukas
 * and nobody knew the conversation had died.
 */
describe('getting nowhere', () => {
  test('three identical asks hand the thread to a person', async () => {
    await router.handle(from(CUSTOMER, 'hi'));
    await router.handle(from(CUSTOMER, 'Thomas Shilongo'));
    await router.handle(from(CUSTOMER, 'a cellphone, 128GB, good condition'));

    const asked = transport.to(CUSTOMER).at(-1)!;
    assert.match(asked, /iPhone or Android/i);

    await router.handle(from(CUSTOMER, 'the blue one'));
    await router.handle(from(CUSTOMER, 'the blue one'));

    assert.match(transport.to(CUSTOMER).at(-1)!, /not following you properly/i);
    assert.match(transport.to(OWNER).at(-1)!, /Someone needs you/);
    assert.match(transport.to(OWNER).at(-1)!, /Thomas Shilongo/);
  });

  test('and then it stays quiet instead of asking a fourth time', async () => {
    await router.handle(from(CUSTOMER, 'hi'));
    await router.handle(from(CUSTOMER, 'Thomas Shilongo'));
    await router.handle(from(CUSTOMER, 'a cellphone, 128GB, good condition'));
    await router.handle(from(CUSTOMER, 'the blue one'));
    await router.handle(from(CUSTOMER, 'the blue one'));

    const quietFrom = transport.to(CUSTOMER).length;
    await router.handle(from(CUSTOMER, 'the blue one'));
    assert.equal(transport.to(CUSTOMER).length, quietFrom);
  });

  test('a conversation that is moving is never escalated', async () => {
    await router.handle(from(CUSTOMER, 'hi'));
    await router.handle(from(CUSTOMER, 'Thomas Shilongo'));
    await router.handle(from(CUSTOMER, 'a cellphone, 128GB, good condition'));
    await router.handle(from(CUSTOMER, 'Android'));
    await router.handle(from(CUSTOMER, 'a cellphone, 128GB, good condition'));

    assert.equal(transport.to(OWNER).length, 0, 'answering the questions must not look like being stuck');
  });
});

/**
 * The oldest constraint in the project, asserted end to end.
 *
 * Root CLAUDE.md: the website shows an estimate because Lukas decided that
 * about the website in August 2026. WhatsApp quotes nothing until he has
 * replied. This test exists because that constraint was once relaxed in a
 * branch — along with the three documents that state it — and the relaxation
 * looked like perfectly ordinary code.
 */
describe('no figure reaches a customer on WhatsApp before Lukas replies', () => {
  test('however hard they fish for one', async () => {
    for (const probe of [
      'How much can I get for an iPhone 15?',
      'Aina Shipanga',
      'What is the value of my iPhone 15, 128GB, 95% battery health, with box?',
      'just give me a price',
      'what would you pay me',
      'iPhone 15, 128GB, box included, battery health 95%',
    ]) {
      await router.handle(from(CUSTOMER, probe));
    }

    const said = transport.to(CUSTOMER).join('\n');
    assert.doesNotMatch(said, /N\$\s?\d/, 'the agent quoted a figure');
    assert.match(said, /can't give you a figure/i, 'but it does say honestly why not');
  });

  test('and not once the whole application is in', async () => {
    await router.handle(from(CUSTOMER, 'hi'));
    await router.handle(from(CUSTOMER, 'Aina Shipanga'));
    await router.handle(from(CUSTOMER, 'iPhone 15, 128GB, box included, battery health 95%'));

    for (let turn = 0; turn < 45; turn += 1) {
      const last = transport.to(CUSTOMER).at(-1) ?? '';
      if (/sent your application to Lukas/i.test(last)) break;
      if (/photo/i.test(last)) {
        await router.handle({ from: CUSTOMER, messageId: `wamid.p${++counter}`, type: 'image', mediaId: `md${counter}` });
      } else if (/how much are you hoping/i.test(last)) {
        await router.handle(from(CUSTOMER, '3000'));
      } else if (/exactly what you have/i.test(last)) {
        await router.handle(from(CUSTOMER, 'iPhone 15, 128GB, box, battery 95%'));
      } else {
        await router.handle(from(CUSTOMER, 'yes'));
      }
    }

    assert.match(transport.to(CUSTOMER).at(-1)!, /sent your application to Lukas/i, 'intake completed');
    assert.doesNotMatch(transport.to(CUSTOMER).join('\n'), /N\$\s?\d/, 'and still no figure');

    // Lukas is the one who gets the numbers.
    assert.match(transport.to(OWNER).join('\n'), /N\$\s?\d/);
  });

  test('his reply is the only thing that puts a figure in front of them', async () => {
    await router.handle(from(CUSTOMER, 'hi'));
    await router.handle(from(CUSTOMER, 'Aina Shipanga'));
    await router.handle(from(CUSTOMER, 'iPhone 15, 128GB, box included, battery health 95%'));
    for (let turn = 0; turn < 45; turn += 1) {
      const last = transport.to(CUSTOMER).at(-1) ?? '';
      if (/sent your application to Lukas/i.test(last)) break;
      if (/photo/i.test(last)) {
        await router.handle({ from: CUSTOMER, messageId: `wamid.q${++counter}`, type: 'image', mediaId: `md${counter}` });
      } else if (/how much are you hoping/i.test(last)) await router.handle(from(CUSTOMER, '3000'));
      else if (/exactly what you have/i.test(last)) await router.handle(from(CUSTOMER, 'iPhone 15, 128GB, box, battery 95%'));
      else await router.handle(from(CUSTOMER, 'yes'));
    }

    const beforeHisReply = transport.to(CUSTOMER).length;
    await router.handle(from(OWNER, 'APPROVE'));

    const after = transport.to(CUSTOMER).slice(beforeHisReply);
    assert.equal(after.filter((message) => /N\$\s?\d/.test(message)).length, 1, 'exactly one, and it is his');
    assert.match(after.join('\n'), /Lukas has reviewed your application/i);
  });
});
