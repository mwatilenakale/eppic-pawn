import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { Store, generateMediaKey } from '../src/store/index.ts';
import { IntakeAgent, type IntakeSubmission } from '../src/intake/agent.ts';
import { buildQuestionPlan, readConfirmation } from '../src/intake/questions.ts';

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
function runFullIntake(opts: { category?: string; variant?: string } = {}): {
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
    const outcome = /send (me )?a (clear )?photo|photo of/i.test(last)
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
  test('opens by offering exactly the categories the playbook accepts', () => {
    agent.handle(CUSTOMER, { text: 'hello' });
    const { replies } = introduce();
    for (const category of rules.categories) {
      assert.match(replies.join('\n'), new RegExp(category.label.replace(/[()]/g, '\\$&')));
    }
  });

  test('turns away a category the playbook does not take', () => {
    agent.handle(CUSTOMER, { text: 'hello' });
    introduce();
    const { replies } = agent.handle(CUSTOMER, { text: 'a double bed' });
    assert.match(replies[0]!, /don't take/i);
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
    assert.match(agentSaid, /Lukas/);
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
    const { replies } = agent.handle(CUSTOMER, { text: 'I will bring it in' });
    assert.match(replies[0]!, /still need that as a photo/i);
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
    assert.match(replies[0]!, /with Lukas/i);
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
    assert.match(replies.join('\n'), /exactly what you have/i);
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
