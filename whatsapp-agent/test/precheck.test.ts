import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/playbook/index.ts';
import { buildQuestionPlan } from '../src/intake/questions.ts';
import { evaluatePrecheck, precheckQuestions, whatsappLink } from '../src/web/precheck.ts';

const rules = loadRules();

/** Answers every question on the form the same way. */
function answerAll(categorySlug: string, variant: string | null, value: string): Record<string, string> {
  return Object.fromEntries(precheckQuestions(rules, categorySlug, variant).map((question) => [question.id, value]));
}

describe('the website asks what WhatsApp asks', () => {
  test('its questions come from the same plan the intake uses', () => {
    const web = precheckQuestions(rules, 'phones', 'iphone').map((question) => question.id);
    const whatsapp = buildQuestionPlan(rules, 'phones', 'iphone')
      .questions.filter((question) => question.kind === 'confirm')
      .map((question) => question.id);

    assert.ok(web.length > 0);
    assert.deepEqual(web, whatsapp.slice(0, web.length), 'the two front doors ask the same things');
  });

  test('the form stays short enough to finish', () => {
    for (const category of rules.categories) {
      assert.ok(precheckQuestions(rules, category.slug).length <= 8, `${category.slug} form is too long`);
    }
  });

  test('photos and documents are left to the WhatsApp step', () => {
    const kinds = new Set(precheckQuestions(rules, 'phones', 'iphone').map((question) => question.kind));
    assert.deepEqual([...kinds], ['confirm']);
  });
});

describe('a clean pre-check', () => {
  test('says nothing stops an application, and never quotes a figure', () => {
    const outcome = evaluatePrecheck(rules, {
      category: 'phone',
      variant: 'iphone',
      description: 'iPhone 13 Pro, 256GB',
      answers: answerAll('phones', 'iphone', 'yes'),
    });

    assert.equal(outcome.status, 'ready');
    assert.match(outcome.headline, /Nothing here stops an application/);
    assert.deepEqual(outcome.notes, []);
    assert.doesNotMatch(JSON.stringify(outcome), /N\$\s?\d/, 'the website never puts a number in front of anyone');
  });

  test('tells the customer what to bring, from the playbook', () => {
    const outcome = evaluatePrecheck(rules, { category: 'TV', answers: answerAll('tvs', null, 'yes') });
    assert.deepEqual(outcome.bring, rules.playbook.requirements);
    assert.match(outcome.bring.join(' '), /Police declaration/i);
  });

  test('says what still gets checked with the item in hand', () => {
    const outcome = evaluatePrecheck(rules, { category: 'car', answers: answerAll('cars', null, 'yes') });
    assert.match(outcome.verifiedInPerson.join(' | '), /mechanic/i);
  });

  test('hands off to WhatsApp with the item named', () => {
    const outcome = evaluatePrecheck(rules, {
      category: 'laptop',
      description: 'Dell XPS 13, 2021',
      answers: answerAll('laptops', null, 'yes'),
    });

    assert.match(outcome.whatsappText, /Dell XPS 13/);
    // wa.me only accepts a full international number, so the playbook's local
    // form has to be normalised — 0815550100 would open a chat with nobody.
    assert.match(whatsappLink('081-555-0100', outcome.whatsappText), /^https:\/\/wa\.me\/264815550100\?text=/);
    assert.equal(whatsappLink('+264 81 555 0100', 'hi'), whatsappLink('081-555-0100', 'hi'));
  });
});

describe('a pre-check with a problem', () => {
  test('a playbook must-have answered "no" is explained, not rejected', () => {
    const questions = precheckQuestions(rules, 'tvs', null);
    const smartTv = questions.find((question) => /smart tv/i.test(question.ask));
    assert.ok(smartTv, 'the Smart TV condition is asked');

    const outcome = evaluatePrecheck(rules, {
      category: 'TV',
      answers: { ...answerAll('tvs', null, 'yes'), [smartTv.id]: 'no' },
    });

    assert.equal(outcome.status, 'needs-attention');
    assert.match(outcome.headline, /you can still ask the manager/i);
    assert.match(outcome.notes.join(' '), /condition of taking the item in/i);
    assert.doesNotMatch(JSON.stringify(outcome), /rejected|declined|refused/i, 'the website never rejects anyone');
    assert.ok(outcome.whatsappText.length > 0, 'the conversation is still offered');
  });

  test('a point they could not answer is carried, with where to look', () => {
    const questions = precheckQuestions(rules, 'phones', 'iphone');
    const optional = questions.find((question) => !/signed out|must be/i.test(question.ask))!;

    const outcome = evaluatePrecheck(rules, {
      category: 'phone',
      variant: 'iphone',
      answers: { ...answerAll('phones', 'iphone', 'yes'), [optional.id]: 'not sure' },
    });

    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.weWillCheck.length, 1);
    assert.ok(outcome.weWillCheck[0]!.question.length > 0);
  });

  test('"not sure" on a must-have no longer blocks, but "no" still does', () => {
    // Lukas, 30 October 2026: "If they are not sure, most of this can be
    // verified, or they can be guided how to check. If they still can't, then
    // we can just give an estimated value, and then we'll say we'll give a
    // solid amount when you come, after we've checked that particular thing."
    //
    // Before this both answers blocked, so a customer who simply did not know
    // whether Activation Lock was off was told "there is something to sort out
    // first" and shown no estimate at all.
    const questions = precheckQuestions(rules, 'phones', 'iphone');
    const mustHave = questions.find((question) => /signed out/i.test(question.ask))!;
    const base = { category: 'phone', variant: 'iphone' };

    const unsure = evaluatePrecheck(rules, {
      ...base,
      answers: { ...answerAll('phones', 'iphone', 'yes'), [mustHave.id]: 'not sure' },
    });
    assert.equal(unsure.status, 'ready', 'not knowing is not an obstacle');
    assert.ok(unsure.weWillCheck.some((entry) => /signed out/i.test(entry.question)));
    // And it says where to look, from the playbook's own hint list.
    assert.match(
      unsure.weWillCheck.find((entry) => /signed out/i.test(entry.question))!.howToCheck ?? '',
      /settings/i,
    );

    const said_no = evaluatePrecheck(rules, {
      ...base,
      answers: { ...answerAll('phones', 'iphone', 'yes'), [mustHave.id]: 'no' },
    });
    assert.equal(said_no.status, 'needs-attention', 'a "no" is something real to work through');
    assert.match(said_no.notes.join(' '), /condition of taking the item in/i);
  });

  test('an unanswered form is still never read as yes', () => {
    // The status is no longer "needs-attention" — under the rule above an
    // unanswered point is checked in person rather than held against anyone —
    // but silence must still not become confirmation, and every question has
    // to show up as something the shop will check.
    const outcome = evaluatePrecheck(rules, { category: 'phone', variant: 'iphone', answers: {} });
    assert.ok(outcome.answers.every((answer) => answer.answer === 'unsure'));
    assert.ok(!outcome.answers.some((answer) => answer.answer === 'yes'), 'silence is not confirmation');
    assert.equal(outcome.weWillCheck.length, outcome.answers.length, 'all of it is carried, none of it assumed');
  });
});

describe('a category the playbook does not take', () => {
  test('says so plainly and lists what is taken', () => {
    const outcome = evaluatePrecheck(rules, { category: 'a double bed', answers: {} });

    assert.equal(outcome.status, 'not-accepted');
    assert.match(outcome.headline, /don't take a double bed/i);
    for (const category of rules.categories) {
      assert.match(outcome.notes.join(' '), new RegExp(category.label.replace(/[()]/g, '\\$&')));
    }
    assert.deepEqual(outcome.bring, [], 'no point listing documents for an item we cannot take');
  });
});
