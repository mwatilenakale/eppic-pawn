import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { Store, generateMediaKey } from '../src/store/index.ts';
import { IntakeAgent, type IntakeSubmission } from '../src/intake/agent.ts';
import { buildQuestionPlan, readConfirmation } from '../src/intake/questions.ts';

test('mechanic context is one check rather than dependent sentence fragments', () => {
  const plan = buildQuestionPlan(loadRules(), 'cars');
  const mechanic = plan.inPersonChecks.filter((check) => /mechanic/i.test(check.text));
  assert.equal(mechanic.length, 1);
  assert.match(mechanic[0]!.text, /customer covers.*but he keeps.*to avoid.*he bears/s);
  assert.ok(!plan.inPersonChecks.some((check) => /^(but|to avoid|he bears)/i.test(check.text)));
});

test('fraud examples and load-test observations remain attached to their check', () => {
  const rules = loadRules();
  const phone = buildQuestionPlan(rules, 'phones', 'iphone');
  assert.equal(phone.inPersonChecks.filter((check) => /fraud patterns|cloned box|blacklisted post-loan/i.test(check.text)).length, 1);
  const consolePlan = buildQuestionPlan(rules, 'consoles');
  assert.ok(!consolePlan.inPersonChecks.some((check) => /^watching for/i.test(check.text)));
  assert.ok(consolePlan.inPersonChecks.some((check) => /stress test.*watching for.*disc-read/s.test(check.text)));
});

const rules = loadRules();
const CUSTOMER = '+264811234567';
const photo = () => Buffer.from('fake-jpeg-bytes');

let store: Store;
let agent: IntakeAgent;

beforeEach(() => {
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-intake-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  });
  agent = new IntakeAgent(store, rules);
});

afterEach(() => store.close());

/** Drives the conversation to completion, answering everything positively. */
function runFullIntake(opts: { category?: string; variant?: string; withoutDocument?: boolean } = {}): {
  transcript: { from: 'customer' | 'agent'; text: string }[];
  submission: IntakeSubmission;
} {
  const transcript: { from: 'customer' | 'agent'; text: string }[] = [];
  const say = (text?: string, media?: Buffer) => {
    transcript.push({ from: 'customer', text: text ?? '[photo]' });
    const outcome = agent.handle(CUSTOMER, { text, media: media ? { content: media } : undefined });
    for (const reply of outcome.replies) transcript.push({ from: 'agent', text: reply });
    return outcome;
  };

  say('hi');
  say('Aina Shipanga');
  say(opts.category ?? 'phone');
  if (opts.variant) say(opts.variant);

  let submission: IntakeSubmission | undefined;
  for (let turn = 0; turn < 40 && !submission; turn += 1) {
    const last = transcript.filter((line) => line.from === 'agent').at(-1)!.text;
    const outcome = /police declaration/i.test(last) && opts.withoutDocument
      ? say("I haven't been to the police station yet")
      : /send (me )?a (clear )?photo|photo of/i.test(last)
      ? say(undefined, photo())
      : /how much are you hoping/i.test(last)
        ? say('3000')
        : /Reply \*yes\*/.test(last)
          ? say('yes')
          : say('iPhone 13 Pro, 256GB, good condition, small scratch on the back');
    submission = outcome.submission;
  }

  assert.ok(submission, 'intake did not complete');
  return { transcript, submission };
}

/**
 * Answers the name question, which every conversation from an unknown number
 * now starts with. Returns the reply so a test can assert on what follows it.
 */
function introduce(name = 'Aina Shipanga') {
  return agent.handle(CUSTOMER, { text: name });
}

describe('question plan', () => {
  test('asks the customer only what can be answered remotely', () => {
    const plan = buildQuestionPlan(rules, 'phones', 'iphone');
    const asked = plan.questions.map((question) => question.ask).join(' | ');

    assert.match(asked, /iCloud/i, 'the playbook screening question is asked');
    assert.match(asked, /Activation Lock/i, 'the architecture fraud check is asked');
    assert.doesNotMatch(asked, /watch for/i, 'a "watch for" pattern is a staff check, not a question');
  });

  test('defers in-person-only checks to the verification list', () => {
    const cars = buildQuestionPlan(rules, 'cars');
    const deferred = cars.inPersonChecks.map((check) => check.text).join(' | ');
    assert.match(deferred, /mechanic/i);
    assert.match(deferred, /test drive/i);

    const consoles = buildQuestionPlan(rules, 'consoles');
    assert.match(consoles.inPersonChecks.map((check) => check.text).join(' | '), /20-30 minute/i);
  });

  test('asks for every document the playbook requires, except the signed agreement', () => {
    const plan = buildQuestionPlan(rules, 'phones', 'iphone');
    const photoKinds = plan.questions.filter((q) => q.kind === 'photo').map((q) => q.photoKind);
    assert.ok(photoKinds.includes('id'));
    assert.ok(photoKinds.includes('ownership'));
    assert.ok(photoKinds.includes('police-declaration'));
    assert.doesNotMatch(plan.questions.map((q) => q.ask).join(' '), /signed agreement/i);
  });

  test('reads answers the way customers type them', () => {
    assert.equal(readConfirmation('Yes'), 'yes');
    assert.equal(readConfirmation('ja'), 'yes');
    assert.equal(readConfirmation('nope'), 'no');
    assert.equal(readConfirmation('not sure'), 'unsure');
    assert.equal(readConfirmation('no box'), 'unsure');
    assert.equal(readConfirmation('it is a samsung'), null);
  });
});

describe('intake conversation', () => {
  test('a failed photo can be retried with the same WhatsApp message ID', () => {
    agent.handle(CUSTOMER, { text: 'phone' });
    agent.handle(CUSTOMER, { text: 'iphone' });
    agent.handle(CUSTOMER, { text: 'iPhone 13 Pro' });
    const conversation = store.activeConversation(store.customerByPhone(CUSTOMER)!.id)!;
    const before = store.messages(conversation.id).length;
    const put = store.media!.put;
    store.media!.put = () => { throw new Error('disk unavailable'); };
    const incoming = { providerMessageId: 'wamid.retry-photo', media: { content: photo() } };

    assert.throws(() => agent.handle(CUSTOMER, incoming), /disk unavailable/);
    assert.equal(store.messages(conversation.id).length, before);
    store.media!.put = put;
    assert.ok(agent.handle(CUSTOMER, incoming).replies.length > 0);
    const state = JSON.parse(store.activeConversation(store.customerByPhone(CUSTOMER)!.id)!.state) as { itemId: string };
    assert.equal(store.photos(state.itemId).length, 1);
    assert.deepEqual(agent.handle(CUSTOMER, incoming).replies, [], 'a successful retry is still deduplicated');
  });

  test('opens by offering exactly the categories the playbook accepts', () => {
    agent.handle(CUSTOMER, { text: 'hello' });
    const { replies } = introduce();
    for (const category of rules.categories) {
      assert.match(replies.join('\n'), new RegExp(category.label.replace(/[()]/g, '\\$&')));
    }
  });

  /**
   * Playbook section 2, "Something else", from 21 October 2026. The agent used
   * to answer "we don't take a double bed" on its own authority. It no longer
   * refuses anything: it asks once more in case it misheard, then puts the
   * question to Lukas. Deciding what the shop will take is his.
   */
  test('does not turn anything away on its own authority', () => {
    agent.handle(CUSTOMER, { text: 'hello' });
    introduce();

    const first = agent.handle(CUSTOMER, { text: 'a double bed' });
    assert.doesNotMatch(first.replies.join('\n'), /we don't take/i);
    assert.match(first.replies.join('\n'), /not quite sure what that is/i);

    const second = agent.handle(CUSTOMER, { text: 'a double bed' });
    assert.match(second.replies.join('\n'), /ask the manager|gone across/i);
    assert.equal(store.item(''), null);
  });

  test('asks iPhone or Android before the phone checklist', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    introduce();
    const { replies } = agent.handle(CUSTOMER, { text: 'phone' });
    assert.match(replies[0]!, /iPhone or Android/i);
  });

  test('runs a full iPhone intake end to end', () => {
    const { submission, transcript } = runFullIntake({ category: 'phone', variant: 'iPhone' });

    assert.equal(submission.item.category_slug, 'phones');
    assert.equal(submission.item.variant, 'iphone');
    assert.match(submission.item.description, /iPhone 13 Pro/);
    assert.equal(submission.missing.length, 0);
    assert.equal(submission.requestedAmountCents, 300_000);
    assert.ok(submission.photoKinds.includes('id'), 'ID photo collected');
    assert.ok(submission.photoKinds.includes('item'), 'item photo collected');
    assert.ok(submission.plan.inPersonChecks.length > 0, 'staff checks passed on to Lukas');
    assert.ok(transcript.length > 10);
  });

  test('never quotes a number to the customer', () => {
    const { transcript } = runFullIntake({ category: 'phone', variant: 'iPhone' });
    const agentSaid = transcript.filter((line) => line.from === 'agent').map((line) => line.text).join('\n');
    assert.doesNotMatch(agentSaid, /N\$\s?\d/, 'the agent must never put a figure in front of a customer');
    assert.match(agentSaid, /the manager/i, 'the role, never the name');
  });

  test('deflects "how much can I get" without ever giving a figure', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    agent.handle(CUSTOMER, { text: 'phone' });
    agent.handle(CUSTOMER, { text: 'iPhone' });
    agent.handle(CUSTOMER, { text: 'iPhone 13 Pro 256GB' });
    const { replies } = agent.handle(CUSTOMER, { text: 'how much can I get for it?' });

    assert.match(replies.join('\n'), /can't give you an amount/i);
    assert.doesNotMatch(replies.join('\n'), /N\$\s?\d/);
  });

  test('records a "no" answer as a flag for Lukas rather than failing the item', () => {
    const transcriptAnswers = ['iPhone 13 Pro 256GB'];
    agent.handle(CUSTOMER, { text: 'hi' });
    agent.handle(CUSTOMER, { text: 'phone' });
    agent.handle(CUSTOMER, { text: 'iPhone' });

    let submission: IntakeSubmission | undefined;
    for (let turn = 0; turn < 40 && !submission; turn += 1) {
      const conversation = store.activeConversation(store.customerByPhone(CUSTOMER)!.id)!;
      const last = store.messages(conversation.id).filter((m) => m.direction === 'out').at(-1)!.body;
      const outcome = /photo/i.test(last)
        ? agent.handle(CUSTOMER, { media: { content: photo() } })
        : /how much are you hoping/i.test(last)
          ? agent.handle(CUSTOMER, { text: 'not sure' })
          : /Reply \*yes\*/.test(last)
            ? agent.handle(CUSTOMER, { text: /iCloud/i.test(last) ? 'no' : 'yes' })
            : agent.handle(CUSTOMER, { text: transcriptAnswers.shift() ?? 'yes' });
      submission = outcome.submission;
    }

    const flagged = submission!.flagged.map((answer) => answer.question).join(' | ');
    assert.match(flagged, /iCloud/i, 'the unanswered-safely check is flagged');
    assert.equal(submission!.requestedAmountCents, null);
    assert.equal(submission!.item.status, 'awaiting-approval');
  });

  test('asks again when a photo request gets a text answer', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    introduce();
    agent.handle(CUSTOMER, { text: 'laptop' });
    agent.handle(CUSTOMER, { text: 'Dell XPS 13, 2021, 16GB RAM' });
    const { replies } = agent.handle(CUSTOMER, { text: 'here it is' });
    assert.match(replies[0]!, /still need that as a photo/i);
  });

  /**
   * Playbook section 5, "Waiving a document".
   *
   * A required document used to block intake outright, which meant no
   * application could ever reach Lukas with one missing — and so his waiver
   * could never happen at all. He decides these one by one and cannot decide
   * about a file he never sees.
   */
  test('a document they genuinely do not have is carried to Lukas, not blocked', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    introduce();
    agent.handle(CUSTOMER, { text: 'laptop' });
    agent.handle(CUSTOMER, { text: 'Dell XPS 13, 2021, 16GB RAM' });

    const { replies } = agent.handle(CUSTOMER, { text: "I don't have it yet" });

    assert.match(replies.join('\n'), /bring it with you/i);
    assert.match(replies.join('\n'), /still needed/i, 'the requirement does not move');
    assert.doesNotMatch(replies.join('\n'), /still need that as a photo/i, 'it moved on');
  });

  test('but it asks twice before accepting that', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    introduce();
    agent.handle(CUSTOMER, { text: 'laptop' });
    agent.handle(CUSTOMER, { text: 'Dell XPS 13, 2021, 16GB RAM' });

    const first = agent.handle(CUSTOMER, { text: 'here it is' });
    assert.match(first.replies[0]!, /still need that as a photo/i);

    const second = agent.handle(CUSTOMER, { text: 'here it is' });
    assert.match(second.replies.join('\n'), /bring it with you/i, 'asking a fifth time produces nothing');
  });

  test('the gap reaches Lukas as outstanding', () => {
    const { submission } = runFullIntake({ category: 'phone', variant: 'iPhone', withoutDocument: true });

    assert.match(
      submission.missing.map((question) => question.photoKind ?? '').join(' '),
      /police-declaration/,
      'he is told which document is missing, so he can decide about it',
    );
  });

  test('a redelivered webhook message changes nothing', () => {
    agent.handle(CUSTOMER, { text: 'hi', providerMessageId: 'wamid.1' });
    const first = agent.handle(CUSTOMER, { text: 'phone', providerMessageId: 'wamid.2' });
    const replay = agent.handle(CUSTOMER, { text: 'phone', providerMessageId: 'wamid.2' });

    assert.ok(first.replies.length > 0);
    assert.deepEqual(replay.replies, []);
  });

  test('"restart" wipes the application and starts from the categories again', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    agent.handle(CUSTOMER, { text: 'phone' });
    const { replies } = agent.handle(CUSTOMER, { text: 'restart' });
    assert.match(replies.join('\n'), /starting again/i);

    const next = agent.handle(CUSTOMER, { text: 'TV' });
    assert.doesNotMatch(next.replies[0]!, /iPhone or Android/i);
  });

  test('after submitting, the customer is told it is with Lukas — not approved', () => {
    runFullIntake({ category: 'phone', variant: 'iPhone' });
    const { replies } = agent.handle(CUSTOMER, { text: 'any news?' });
    assert.match(replies[0]!, /with the manager/i);
    assert.doesNotMatch(replies[0]!, /approved/i);
  });

  test('the remote inspection record keeps the answers and what is still outstanding', () => {
    const { submission } = runFullIntake({ category: 'phone', variant: 'iPhone' });
    const inspection = store.db
      .prepare('SELECT * FROM inspections WHERE item_id = ?')
      .get(submission.item.id) as { stage: string; results: string; outstanding: string; complete: number };

    assert.equal(inspection.stage, 'remote');
    assert.ok(JSON.parse(inspection.results).length > 0);
    assert.match(JSON.parse(inspection.outstanding).join(' | '), /IMEI|Activation Lock|fraud/i);
  });
});

/**
 * Knowing who you are talking to.
 *
 * All four of these were found by reading a real transcript rather than from a
 * failing assertion, which is why they are written down now.
 */
describe('who this is', () => {
  test('a new number is asked for a name, and it is kept', () => {
    const first = agent.handle(CUSTOMER, { text: 'hi' });
    assert.match(first.replies[0]!, /what is your name/i);

    introduce('aina shipanga');
    assert.equal(store.customerByPhone(CUSTOMER)!.name, 'Aina Shipanga');
  });

  test('the greeting is said once, not twice', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    const { replies } = introduce();

    const hellos = replies.join('\n').match(/this is Eppic Pawn Shop/g) ?? [];
    assert.equal(hellos.length, 0, 'they were greeted one message ago');
  });

  test('a returning number is greeted by name and never asked again', () => {
    runFullIntake({ category: 'phone', variant: 'iPhone' });
    const customer = store.customerByPhone(CUSTOMER)!;
    store.closeConversation(store.activeConversation(customer.id)!.id);

    const { replies } = agent.handle(CUSTOMER, { text: 'hi' });
    assert.match(replies[0]!, /Aina/);
    assert.doesNotMatch(replies.join('\n'), /what is your name/i);
  });

  test('"phone" is an item, not a person', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    const { replies } = agent.handle(CUSTOMER, { text: 'phone' });

    assert.match(replies[0]!, /your own name/i);
    assert.equal(store.customerByPhone(CUSTOMER)!.name, null, 'no customer called Phone');
  });

  test('it stops asking after two tries rather than blocking the conversation', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    agent.handle(CUSTOMER, { text: 'phone' });
    const { replies } = agent.handle(CUSTOMER, { text: '???' });

    // Two tries is enough: a nameless record is a small problem, an agent that
    // will not move on until it gets one is a much bigger one. And it kept the
    // phone they led with, so the item is not asked for a third time.
    assert.doesNotMatch(replies.join('\n'), /your own name/i);
    assert.match(replies.join('\n'), /iPhone or Android/i);
  });

  test('a second item replaces the first, rather than the first winning', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    agent.handle(CUSTOMER, { text: 'phone' });
    const { replies } = agent.handle(CUSTOMER, { text: 'laptop' });

    assert.match(replies.join('\n'), /Laptops/);
  });

  test('a name and an item in one message gives up both', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    const { replies } = agent.handle(CUSTOMER, { text: 'my name is Aina, I want to pawn my iPhone' });

    assert.equal(store.customerByPhone(CUSTOMER)!.name, 'Aina');
    // iPhone was named, so "iPhone or Android?" has already been answered.
    assert.doesNotMatch(replies.join('\n'), /iPhone or Android/i);
    assert.match(replies.join('\n'), /exactly what you have/i);
  });

  test('starting over does not make them a stranger again', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    introduce();
    agent.handle(CUSTOMER, { text: 'phone' });

    const { replies } = agent.handle(CUSTOMER, { text: 'restart' });
    assert.doesNotMatch(replies.join('\n'), /what is your name/i);
    assert.match(replies.join('\n'), /Which one do you have/i);
  });
});

describe('"how much can I get?"', () => {
  test('the opening question is answered, not talked over', () => {
    const { replies } = agent.handle(CUSTOMER, { text: 'Hi, how much can I get for an iPhone 15?' });

    assert.match(replies.join('\n'), /can't give you a figure/i);
    assert.match(replies.join('\n'), /what is your name/i);
    assert.doesNotMatch(replies.join('\n'), /N\$\s?\d/);
  });

  test('and answered once, not again on the next message', () => {
    agent.handle(CUSTOMER, { text: 'Hi, how much can I get for an iPhone 15?' });
    const { replies } = introduce();

    assert.doesNotMatch(replies.join('\n'), /can't give you a figure/i, 'already answered');
    // The iPhone from the opening message is still known.
    assert.match(replies.join('\n'), /storage|condition/i);
  });

  test('an unknown item plus a price question is not a rejection', () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    introduce();
    const { replies } = agent.handle(CUSTOMER, { text: 'how much for a fridge?' });

    assert.doesNotMatch(replies.join('\n'), /don't take/i);
    assert.match(replies.join('\n'), /Which one do you have/i);
  });
});

describe('the finance check (the Spectra case)', () => {
  test('every customer is asked whether the item is on an account', () => {
    for (const category of rules.categories) {
      const asks = buildQuestionPlan(rules, category.slug).questions.map((question) => question.ask).join('\n');
      assert.match(asks, /bought outright, not on an account/i, `${category.slug} never asks about finance`);
    }
  });

  test('it is asked before any document is collected', () => {
    const questions = buildQuestionPlan(rules, 'phones', 'android').questions;
    const finance = questions.findIndex((question) => /bought outright/i.test(question.ask));
    const firstDocument = questions.findIndex((question) => question.source === 'documents' && question.kind === 'photo');

    assert.ok(finance >= 0 && firstDocument >= 0);
    assert.ok(
      finance < firstDocument,
      'a "no, it is still on an account" must end the conversation before anyone photographs their ID',
    );
  });

  test('a requirement that is not a document is still asked, not dropped', () => {
    // The loader used to silently skip any section 5 line that matched no
    // photo pattern, which is how this check went missing in the first place.
    const asks = buildQuestionPlan(rules, 'laptops').questions.map((question) => question.ask).join('\n');
    assert.match(asks, /bought outright/i);
  });

  test('a policy line is not turned into a question', () => {
    const asks = buildQuestionPlan(rules, 'phones', 'iphone').questions.map((question) => question.ask).join('\n');
    assert.doesNotMatch(asks, /required above|^policy/im, 'a threshold is a rule, not something to confirm');
  });

  test('Android is asked about financing locks specifically', () => {
    const asks = buildQuestionPlan(rules, 'phones', 'android').questions.map((question) => question.ask).join('\n');

    assert.match(asks, /knox guard/i);
    assert.match(asks, /device administrator/i);
    assert.match(asks, /managed by your organisation/i);
  });

  test('an explanatory clause does not become its own question', () => {
    // "…, since an enrolled handset only asks for the financier's credentials"
    // is a reason, not a check. Splitting on it produced a nonsense question.
    const asks = buildQuestionPlan(rules, 'phones', 'android').questions.map((question) => question.ask).join('\n');
    assert.doesNotMatch(asks, /Can you confirm: (since|because)\b/i);
  });
});

/**
 * The description is what gets valued.
 *
 * Found by driving a car scenario where every prompt was answered "yes": Lukas
 * received an application reading "*Item:* yes" with a suggested loan of
 * N$1,612.50 against it, arrived at by asking the valuer what the word "yes"
 * is worth.
 */
describe('a description worth pricing', () => {
  const start = () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    introduce();
    agent.handle(CUSTOMER, { text: 'car' });
  };

  test('a bare confirmation is not an item', () => {
    start();
    const { replies } = agent.handle(CUSTOMER, { text: 'yes' });

    assert.match(replies.join('\n'), /need a bit more than that/i);
    assert.deepEqual(store.db.prepare('SELECT * FROM items').all(), [], 'nothing was created to value');
  });

  test('nor is a sentence about something else', () => {
    start();
    agent.handle(CUSTOMER, { text: 'yes' });
    const { replies } = agent.handle(CUSTOMER, { text: 'I just need cash today' });
    assert.match(replies.join('\n'), /still not quite enough/i);
  });

  test('the second ask is worded differently from the first', () => {
    start();
    const first = agent.handle(CUSTOMER, { text: 'yes' }).replies.join('\n');
    const second = agent.handle(CUSTOMER, { text: 'sure' }).replies.join('\n');
    assert.notEqual(first, second, 'repeating a question verbatim reads as broken');
  });

  test('a real description gets through', () => {
    start();
    agent.handle(CUSTOMER, { text: 'Toyota Hilux 2016, 180000km, runs well' });

    const items = store.db.prepare('SELECT description FROM items').all() as { description: string }[];
    assert.equal(items.length, 1);
    assert.match(items[0]!.description, /Hilux/);
  });

  test('short is fine when it names a model', () => {
    // The bar is low on purpose: "ps5 1tb" is plenty to go and price.
    agent.handle(CUSTOMER, { text: 'hi' });
    introduce();
    agent.handle(CUSTOMER, { text: 'console' });
    agent.handle(CUSTOMER, { text: 'ps5 1tb' });

    const items = store.db.prepare('SELECT description FROM items').all() as { description: string }[];
    assert.equal(items.length, 1, '"ps5 1tb" is a real answer and must not be rejected');
  });

  test('it gives up after three tries rather than trapping them', () => {
    start();
    agent.handle(CUSTOMER, { text: 'yes' });
    agent.handle(CUSTOMER, { text: 'sure' });
    const { replies } = agent.handle(CUSTOMER, { text: 'yes please' });

    assert.match(replies.join('\n'), /photo/i, 'the conversation moves on');
  });

  /**
   * Giving up must not turn the junk into the description. It used to: Lukas
   * received "*Item:* yes" with a suggested loan against it, because the
   * valuer had been asked what the word "yes" is worth.
   */
  test('what it gave up on is reported outstanding, not filed as an answer', () => {
    start();
    for (const junk of ['yes', 'sure', 'yes please']) agent.handle(CUSTOMER, { text: junk });

    // Photos still get collected, which creates the item with no description.
    let submission: IntakeSubmission | undefined;
    for (let turn = 0; turn < 40 && !submission; turn += 1) {
      const conversation = store.activeConversation(store.customerByPhone(CUSTOMER)!.id)!;
      const last = store.messages(conversation.id).filter((m) => m.direction === 'out').at(-1)!.body;
      submission = (/photo/i.test(last)
        ? agent.handle(CUSTOMER, { media: { content: photo() } })
        : /how much are you hoping/i.test(last)
          ? agent.handle(CUSTOMER, { text: 'not sure' })
          : agent.handle(CUSTOMER, { text: 'yes' })
      ).submission;
    }

    assert.ok(submission, 'intake still completes');
    assert.equal(submission.item.description, '', 'nothing was invented to price');
    assert.match(
      submission.missing.map((question) => question.id).join(' '),
      /item-description/,
      'Lukas is told the description is still outstanding',
    );
  });
});

/**
 * The police declaration is a fallback — playbook section 5, 21 October 2026.
 *
 * It is only asked for where the customer cannot prove they own the item.
 * Sending somebody holding the original receipt to a police station is
 * friction for nothing, and it was being asked of everybody.
 */
describe('proof of ownership, and the declaration behind it', () => {
  const upToDocuments = () => {
    agent.handle(CUSTOMER, { text: 'hi' });
    introduce();
    agent.handle(CUSTOMER, { text: 'phone' });
    agent.handle(CUSTOMER, { text: 'iPhone' });

    // Everything up to the proof-of-ownership request.
    for (let turn = 0; turn < 40; turn += 1) {
      const conversation = store.activeConversation(store.customerByPhone(CUSTOMER)!.id)!;
      const last = store.messages(conversation.id).filter((m) => m.direction === 'out').at(-1)!.body;
      if (/proof of ownership/i.test(last)) return;
      if (/photo/i.test(last)) agent.handle(CUSTOMER, { media: { content: photo() } });
      else if (/exactly what you have/i.test(last)) agent.handle(CUSTOMER, { text: 'iPhone 15, 128GB, good condition' });
      else agent.handle(CUSTOMER, { text: 'yes' });
    }
    assert.fail('never reached the proof-of-ownership request');
  };

  const everythingSaid = () => {
    const conversation = store.activeConversation(store.customerByPhone(CUSTOMER)!.id)!;
    return store.messages(conversation.id).filter((m) => m.direction === 'out').map((m) => m.body).join('\n');
  };

  test('a receipt means the declaration is never asked for', () => {
    upToDocuments();
    agent.handle(CUSTOMER, { media: { content: photo() } });

    // The ownership question itself mentions the declaration as the fallback,
    // so this asserts on the request rather than the word.
    assert.doesNotMatch(
      everythingSaid(),
      /Please send a photo of the police declaration/i,
      'somebody with the receipt was sent to a police station',
    );
  });

  test('no receipt means the declaration is the fallback', () => {
    upToDocuments();
    agent.handle(CUSTOMER, { text: "I don't have a receipt for it" });

    assert.match(everythingSaid(), /Please send a photo of the police declaration/i);
  });

  test('it is asked second, not first', () => {
    upToDocuments();
    const said = everythingSaid();
    const ownership = said.search(/photo of your proof of ownership/i);
    const declaration = said.search(/Please send a photo of the police declaration/i);

    assert.ok(ownership >= 0, 'proof of ownership is asked');
    assert.ok(declaration === -1 || declaration > ownership, 'the fallback never comes first');
  });

  test('the question says what counts, and what to do without it', () => {
    upToDocuments();
    const asked = everythingSaid()
      .split('\n')
      .filter((line) => /proof of ownership|if you do not have any of those/i.test(line))
      .join('\n');

    assert.match(asked, /receipt/i);
    assert.match(asked, /proof of payment/i);
    assert.match(asked, /if you do not have any of those/i);
  });

  test('a complete application needs only one of the two', () => {
    upToDocuments();
    agent.handle(CUSTOMER, { media: { content: photo() } });

    let submission: IntakeSubmission | undefined;
    for (let turn = 0; turn < 20 && !submission; turn += 1) {
      const conversation = store.activeConversation(store.customerByPhone(CUSTOMER)!.id)!;
      const last = store.messages(conversation.id).filter((m) => m.direction === 'out').at(-1)!.body;
      submission = (/photo/i.test(last)
        ? agent.handle(CUSTOMER, { media: { content: photo() } })
        : /how much are you hoping/i.test(last)
          ? agent.handle(CUSTOMER, { text: 'not sure' })
          : agent.handle(CUSTOMER, { text: 'yes' })
      ).submission;
    }

    assert.ok(submission, 'intake completes without a police declaration');
    assert.deepEqual(submission.missing, [], 'and nothing is reported outstanding');
    assert.ok(submission.photoKinds.includes('ownership'));
    assert.ok(!submission.photoKinds.includes('police-declaration'));
  });
});

/**
 * My own prose, asked of a customer.
 *
 * Writing an explanation into section 5 as bullets put two of its lines in
 * front of real customers as "Can you confirm: Lukas's end: he can approve
 * around it, once, on the record?". A `###` subsection is commentary.
 */
describe('commentary in the playbook is not a rule', () => {
  test('nothing from a subsection reaches the customer', () => {
    const asked = buildQuestionPlan(rules, 'phones', 'iphone').questions.map((question) => question.ask).join(' | ');

    assert.doesNotMatch(asked, /requirement stands/i);
    assert.doesNotMatch(asked, /approve around it/i);
    assert.doesNotMatch(asked, /\[decide\]/i);
    assert.doesNotMatch(asked, /Spectra lesson/i);
  });

  test('the real rules still come through', () => {
    assert.ok(rules.playbook.requirements.some((entry) => /copy of id/i.test(entry)));
    assert.ok(rules.playbook.requirements.some((entry) => /proof of ownership/i.test(entry)));
    assert.ok(rules.playbook.declarations.some((entry) => /bought outright/i.test(entry)));
    assert.equal(rules.playbook.declarations.length, 1, 'one confirmation, not three paragraphs of prose');
  });
});


/**
 * Which side of the counter a check belongs on.
 *
 * Found by printing every category's worksheet and reading it as the person
 * who has to sign it, which is what task 001 asked for. Two faults, opposite
 * directions, same root: the split was decided by whether a phrase happened
 * to appear in `IN_PERSON_ONLY`.
 *
 * The customer was asked, mandatorily, "Can you confirm: BIOS serial?",
 * "battery health?", "drive health?", "restart + battery-only test?" — none
 * of which a person can answer about their own laptop, and a "yes" to which
 * means nothing. Meanwhile the laptop worksheet had a single line on it, so
 * the bench checks were in the chat and not in the shop.
 */
describe('a check belongs to whoever can actually answer it', () => {
  const sheet = (slug: string, variant: string | null = null) =>
    buildQuestionPlan(rules, slug, variant).inPersonChecks.map((check) => check.text);
  const asked = (slug: string, variant: string | null = null) =>
    buildQuestionPlan(rules, slug, variant).questions.map((question) => question.ask).join('\n');

  test('a measurement is never put to the customer', () => {
    const laptops = asked('laptops');
    for (const nonsense of [/bios serial/i, /battery health/i, /drive health/i, /battery-only test/i, /exact model/i]) {
      assert.doesNotMatch(laptops, nonsense, 'the customer cannot answer this about their own machine');
    }
    assert.doesNotMatch(asked('consoles'), /serial and model verified against the box/i);
    assert.doesNotMatch(asked('phones', 'android'), /verified inside settings/i);
  });

  test('the measurements are on the worksheet instead, where somebody holds the thing', () => {
    const laptops = sheet('laptops');
    for (const bench of [/bios serial/i, /bitlocker/i, /battery health/i, /drive health/i, /battery-only test/i]) {
      assert.ok(laptops.some((line) => bench.test(line)), `missing from the laptop worksheet: ${bench}`);
    }
    // It had exactly one line before this change.
    assert.ok(laptops.length >= 8, `a laptop inspection is more than ${laptops.length} lines`);
  });

  test('a lock is asked early and checked again in the shop', () => {
    // Both halves matter. Asked remotely, a "no" ends it before the customer
    // has photographed their ID; checked in person, because the Spectra
    // handset was lost to an answer that was collected and believed.
    for (const [slug, variant, lock] of [
      ['laptops', null, /bios-locked laptops unlocked/i],
      ['tvs', null, /account\/login removed/i],
      ['phones', 'iphone', /activation lock/i],
      ['phones', 'android', /factory reset protection/i],
      ['phones', 'android', /knox guard/i],
    ] as [string, string | null, RegExp][]) {
      assert.match(asked(slug, variant), lock, `not asked: ${lock}`);
      assert.ok(sheet(slug, variant).some((line) => lock.test(line)), `not re-checked in person: ${lock}`);
    }
  });

  test('no check appears twice on one worksheet', () => {
    // The documents cross-reference each other — "20-30 minute load test
    // (already in the playbook)", "Smart TV only (per playbook)" — and a form
    // that asks the same thing twice teaches the person not to read it.
    for (const [slug, variant] of [['cars', null], ['phones', 'iphone'], ['phones', 'android'], ['laptops', null], ['tvs', null], ['consoles', null]] as [string, string | null][]) {
      const lines = sheet(slug, variant);
      assert.equal(new Set(lines).size, lines.length, `${slug} repeats a line verbatim`);
      assert.doesNotMatch(lines.join('\n'), /already in the playbook|per playbook/i, `${slug} keeps a cross-reference as its own line`);
    }
    const loadTests = sheet('consoles').filter((line) => /20-30 minute|demanding game/i.test(line));
    assert.equal(loadTests.length, 1, 'the console load test is one line, not two');
    const tvAccount = sheet('tvs').filter((line) => /account/i.test(line));
    assert.equal(tvAccount.length, 1, 'removing the TV account is one line, not two');
  });

  test('an unsettled rule carries its flag, not its raw marker', () => {
    const consoles = buildQuestionPlan(rules, 'consoles').inPersonChecks;
    const loadTest = consoles.find((check) => /demanding game/i.test(check.text))!;
    assert.doesNotMatch(loadTest.text, /\[decide/i, 'the page shows "(proposed rule)" from the flag instead');
    assert.ok(loadTest.text.startsWith('run a demanding game'), loadTest.text);
    assert.equal(loadTest.provisional, true, 'and the flag is still set, so the caveat is not lost');
  });

  test('a worksheet line is an instruction, not a question', () => {
    for (const [slug, variant] of [['cars', null], ['laptops', null], ['consoles', null]] as [string, string | null][]) {
      for (const line of sheet(slug, variant)) {
        assert.doesNotMatch(line, /^Can you confirm:/i, line);
      }
    }
  });
});
