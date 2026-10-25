/**
 * The inspection queue.
 *
 * Two properties carry the weight, and both are asserted hard because the
 * screen built on top of this will be written by someone else: the module
 * cannot return a figure, and a half-filled worksheet cannot be submitted.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/playbook/index.ts';
import { Store, type User } from '../src/store/index.ts';
import { InspectionQueue, InspectionError, type CheckAnswer, type CheckResult } from '../src/inspection/queue.ts';

const rules = loadRules();

let store: Store;
let queue: InspectionQueue;
let lukas: User;
let staff: User;
let itemId: string;

beforeEach(() => {
  store = new Store(':memory:');
  queue = new InspectionQueue(store, rules);
  lukas = store.ensureUser({ name: 'Lukas', phone: '+264811110000', role: 'owner' });
  staff = store.ensureUser({ name: 'Petrus Haufiku', phone: '+264811112222', role: 'inspector' });

  const customer = store.upsertCustomer('+264811234567', 'Aina Shipanga');
  itemId = store.createItem({
    customerId: customer.id,
    categorySlug: 'phones',
    variant: 'iphone',
    description: 'iPhone 13 Pro, 256GB',
  }).id;
});

afterEach(() => store.close());

/** Answers every line on the sheet the same way. */
function answerAll(jobId: string, answer: 'pass' | 'fail' | 'na' = 'pass'): CheckResult[] {
  return queue.worksheet(jobId).map((line) => ({ checkId: line.checkId, text: line.text, answer, note: '' }));
}

describe('a job appears and someone takes it', () => {
  test('opening twice for the same item gives the same job', () => {
    const first = queue.open({ itemId, actor: lukas.id });
    const second = queue.open({ itemId, actor: lukas.id });

    assert.equal(first.id, second.id, 'two worksheets for one phone is how a check gets skipped by both');
    assert.equal(queue.waiting().length, 1);
  });

  test('it waits unclaimed until somebody takes it', () => {
    const job = queue.open({ itemId, actor: lukas.id });

    assert.equal(job.status, 'open');
    assert.equal(job.claimedBy, null);
    assert.deepEqual(queue.mine(staff.id), []);

    queue.claim(job.id, staff);

    assert.equal(queue.waiting().length, 0);
    assert.equal(queue.mine(staff.id).length, 1);
    assert.equal(queue.job(job.id)!.claimedByName, 'Petrus Haufiku');
  });

  test('a job somebody else is holding cannot be taken', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    // Including by Lukas — "I'll just do this one" while the hire is halfway
    // through it is exactly the collision claiming exists to prevent.
    assert.throws(() => queue.claim(job.id, lukas), /Petrus Haufiku is already working on that one/);
  });

  test('claiming the one you already hold is not an error', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);
    assert.equal(queue.claim(job.id, staff).status, 'claimed');
  });

  test('it can be put back', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    assert.equal(queue.release(job.id, staff).status, 'open');
    assert.equal(queue.waiting().length, 1);
  });

  test('somebody else cannot put back a job they are not holding', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    const other = store.ensureUser({ name: 'Other', phone: '+264811113333', role: 'inspector' });
    assert.throws(() => queue.release(job.id, other), /Only the person holding a job/);
    // The owner can, for when somebody has gone home still holding one.
    assert.equal(queue.release(job.id, lukas).status, 'open');
  });
});

describe('the worksheet', () => {
  test('is the checks for that exact item, from the documents', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    const sheet = queue.worksheet(job.id);

    // A document bullet can split into several checks, so the worksheet id is
    // the document id plus a clause number: phones-1 becomes phones-1.3.
    const fromDocuments = rules.checklistFor('phones', 'iphone').map((check) => check.id);
    assert.ok(sheet.length > 0);
    for (const line of sheet) {
      const root = line.checkId.split('.')[0]!;
      assert.ok(fromDocuments.includes(root), `${line.checkId} is not in the documents`);
    }
    assert.match(sheet.map((line) => line.text).join(' | '), /reset in front of staff/i);
  });

  test('a different category gets different checks', () => {
    const tv = store.createItem({
      customerId: store.customers()[0]!.id,
      categorySlug: 'tvs',
      description: 'Samsung 55"',
    }).id;
    const job = queue.open({ itemId: tv, actor: lukas.id });

    assert.match(queue.worksheet(job.id).map((line) => line.text).join(' '), /dead pixels|burn-in/i);
  });

  test('progress is kept without finishing', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    const partial = answerAll(job.id).slice(0, 2);
    queue.record(job.id, staff, partial);

    const sheet = queue.worksheet(job.id);
    assert.equal(sheet[0]!.answer, 'pass', 'a long inspection survives a dropped phone');
    assert.equal(sheet.at(-1)!.answer, null);
    assert.equal(queue.job(job.id)!.status, 'claimed', 'still in hand, not submitted');
  });

  test('only the person holding the job can work it', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    assert.throws(() => queue.record(job.id, staff, []), /Claim the job first/);
  });
});

describe('submitting', () => {
  test('a half-filled sheet is refused, and says what is missing', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    const partial = answerAll(job.id).slice(0, -1);
    assert.throws(
      () => queue.submit({ jobId: job.id, user: staff, results: partial, findings: 'looks fine' }),
      (error: Error) => {
        assert.ok(error instanceof InspectionError);
        assert.match(error.message, /checks? (?:is|are) still unanswered/);
        return true;
      },
    );
    assert.equal(queue.job(job.id)!.status, 'claimed', 'nothing reached Lukas');
  });

  test('findings in their own words are required', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    assert.throws(
      () => queue.submit({ jobId: job.id, user: staff, results: answerAll(job.id), findings: '   ' }),
      /in your own words/,
    );
  });

  test('a complete sheet passes, and lands on the item too', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    const done = queue.submit({
      jobId: job.id,
      user: staff,
      results: answerAll(job.id),
      findings: 'Phone is clean. Reset in front of me, came back to the setup screen. Speakers and Face ID fine.',
    });

    assert.equal(done.status, 'submitted');
    assert.equal(done.outcome, 'pass');
    assert.match(done.findings, /came back to the setup screen/);

    const recorded = store.db.prepare("SELECT * FROM inspections WHERE item_id = ? AND stage = 'in-person'").get(itemId);
    assert.ok(recorded, 'the item history has it as well as the job');
  });

  test('one failed check fails the inspection', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    const results = answerAll(job.id);
    results[1]!.answer = 'fail';
    results[1]!.note = 'Activation Lock still on';

    const done = queue.submit({ jobId: job.id, user: staff, results, findings: 'Would not reset.' });

    assert.equal(done.outcome, 'fail');
    // Lukas may still choose to take it; what he cannot do is not be told.
    assert.equal(done.status, 'submitted');
  });

  test('"not applicable" is an answer, not a gap', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    const done = queue.submit({
      jobId: job.id,
      user: staff,
      results: answerAll(job.id, 'na'),
      findings: 'No box, so nothing to cross-check against it.',
    });
    assert.equal(done.outcome, 'pass');
  });

  test('a submitted job cannot be submitted again', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);
    queue.submit({ jobId: job.id, user: staff, results: answerAll(job.id), findings: 'fine' });

    assert.throws(() => queue.submit({ jobId: job.id, user: staff, results: answerAll(job.id), findings: 'fine' }), /already been submitted/);
  });

  test('every step is audited to a person', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);
    queue.submit({ jobId: job.id, user: staff, results: answerAll(job.id), findings: 'fine' });

    const trail = store.auditTrail('inspection_job', job.id);
    assert.deepEqual(trail.map((entry) => entry.action), [
      'inspection.opened',
      'inspection.claimed',
      'inspection.submitted',
    ]);
    assert.equal(trail[2]!.actor, staff.id, 'with the inspector’s name on the submission');
  });
});

describe('the inspector is never shown the money', () => {
  test('nothing the queue returns carries a figure', () => {
    // The whole reason this module exists separately: an inspector who knows
    // the target has a reason to wave something through. The playbook already
    // worries about this with car mechanics.
    store.saveValuation({
      itemId,
      estimates: [{ source: 'Marketplace', amountCents: 1_044_000 }],
      assessedValueCents: 783_000,
      suggestedLoanCents: 391_500,
      formula: 'lowest x 0.75 / 2',
      workings: ['N$10,440.00'],
    });

    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    const everything = JSON.stringify({
      waiting: queue.waiting(),
      mine: queue.mine(staff.id),
      outstanding: queue.outstanding(),
      job: queue.job(job.id),
      worksheet: queue.worksheet(job.id),
    });

    assert.doesNotMatch(everything, /391500|783000|1044000/, 'a figure reached the inspector');
    assert.doesNotMatch(everything, /N\$/, 'nor a formatted amount');

    // Checked by shape as well as content: a check legitimately mentions a
    // "post-loan" IMEI blacklist, so the words alone prove nothing.
    const fields = Object.keys(queue.job(job.id)!);
    assert.deepEqual(
      fields.filter((field) => /value|loan|amount|cents|price|principal|balance/i.test(field)),
      [],
      'the Job type carries no money field at all',
    );
  });

  test('nor the customer’s number or surname', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    const everything = JSON.stringify(queue.job(job.id));

    assert.match(everything, /Aina/, 'enough to greet the person at the counter');
    assert.doesNotMatch(everything, /Shipanga/, 'but not their full identity');
    assert.doesNotMatch(everything, /\+264811234567/);
  });
});

/**
 * Answers that are not answers.
 *
 * Codex's twenty-scenario audit, scenario 18. `CheckAnswer` is
 * `'pass' | 'fail' | 'na'`, and the type was the only thing enforcing it —
 * which is worth nothing, because these values arrive from an HTML form at
 * runtime. The audit submitted every check as `approved-by-client` and got
 * `status=submitted; outcome=pass`: the completeness check asked only whether
 * the field was truthy, and the outcome was "fail if any answer is exactly
 * fail", so an invalid answer satisfied both.
 */
describe('an invalid answer is not a pass', () => {
  const bogus = (jobId: string, answer: string): CheckResult[] =>
    queue.worksheet(jobId).map((line) => ({
      checkId: line.checkId,
      text: line.text,
      answer: answer as CheckAnswer,
      note: '',
    }));

  test('the exact exploit from the audit is refused', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    assert.throws(
      () => queue.submit({ jobId: job.id, user: staff, results: bogus(job.id, 'approved-by-client'), findings: 'fine' }),
      /not an answer/i,
    );

    const after = queue.job(job.id)!;
    assert.equal(after.status, 'claimed', 'nothing was submitted');
    assert.equal(after.outcome, null, 'and nothing was marked as passed');
  });

  test('nor any other truthy string', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    for (const answer of ['passed', 'PASS', 'ok', 'yes', 'true', '1', ' pass', 'n/a']) {
      assert.throws(
        () => queue.submit({ jobId: job.id, user: staff, results: bogus(job.id, answer), findings: 'fine' }),
        /not an answer/i,
        `"${answer}" was accepted`,
      );
    }
  });

  test('saving progress is guarded too, not just submitting', () => {
    // The domain layer is the guard, so a second caller cannot get past it by
    // not knowing the rule — including the worksheet page still to be built.
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    assert.throws(() => queue.record(job.id, staff, bogus(job.id, 'approved-by-client')), /not an answer/i);
    assert.equal(queue.worksheet(job.id)[0]!.answer, null, 'nothing was written');
  });

  test('a check that is not on the worksheet is refused', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    assert.throws(
      () => queue.submit({
        jobId: job.id, user: staff, findings: 'fine',
        results: [...answerAll(job.id), { checkId: 'invented-1', text: 'Something I made up', answer: 'pass', note: '' }],
      }),
      /no check "invented-1"/i,
    );
  });

  test('answering the same check twice is refused', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    const results = answerAll(job.id);
    assert.throws(
      () => queue.submit({ jobId: job.id, user: staff, results: [...results, results[0]!], findings: 'fine' }),
      /answered twice/i,
    );
  });

  test('the recorded text comes from the worksheet, not from the caller', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    // A report Lukas reads must say what was actually checked, whatever the
    // caller claims it checked.
    const lied = answerAll(job.id).map((result) => ({ ...result, text: 'Everything was fine, honestly' }));
    queue.submit({ jobId: job.id, user: staff, results: lied, findings: 'All good.' });

    const sheet = queue.worksheet(job.id);
    assert.doesNotMatch(sheet.map((line) => line.text).join(' '), /honestly/);
    assert.match(sheet.map((line) => line.text).join(' | '), /reset in front of staff/i);
  });

  test('a valid sheet still goes through', () => {
    const job = queue.open({ itemId, actor: lukas.id });
    queue.claim(job.id, staff);

    const done = queue.submit({
      jobId: job.id, user: staff, results: answerAll(job.id, 'na'), findings: 'No box to cross-check against.',
    });
    assert.equal(done.status, 'submitted');
    assert.equal(done.outcome, 'pass');
  });
});
