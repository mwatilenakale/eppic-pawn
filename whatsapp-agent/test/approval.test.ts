import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { Store, generateMediaKey, type User } from '../src/store/index.ts';
import { IntakeAgent, type IntakeSubmission } from '../src/intake/agent.ts';
import { ApprovalWorkflow, parseOwnerReply, referenceFor } from '../src/approval/index.ts';
import { PriceMemory } from '../src/valuator/memory.ts';

const rules = loadRules();
const CUSTOMER = '+264811234567';
const ESTIMATES = [
  { source: 'Marketplace, used', amountCents: 1_200_000 },
  { source: 'Local retailer, used', amountCents: 1_000_000 },
];

let store: Store;
let agent: IntakeAgent;
let approvals: ApprovalWorkflow;
let lukas: User;

beforeEach(() => {
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-approval-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  });
  agent = new IntakeAgent(store, rules);
  approvals = new ApprovalWorkflow(store, rules);
  lukas = store.ensureUser({ name: 'Lukas', phone: '+264812823046', role: 'owner' });
});

afterEach(() => store.close());

function completeIntake(phone = CUSTOMER, answer: (ask: string) => string | 'photo' = () => 'yes'): IntakeSubmission {
  agent.handle(phone, { text: 'hi' });
  agent.handle(phone, { text: 'phone' });
  agent.handle(phone, { text: 'iPhone' });

  let submission: IntakeSubmission | undefined;
  let last = 'Tell me exactly what you have';
  for (let turn = 0; turn < 40 && !submission; turn += 1) {
    const reply = /photo of/i.test(last)
      ? 'photo'
      : /how much are you hoping/i.test(last)
        ? '3000'
        : /Reply \*yes\*/.test(last)
          ? answer(last)
          : 'iPhone 13 Pro, 256GB, good condition';
    const outcome =
      reply === 'photo'
        ? agent.handle(phone, { media: { content: Buffer.from('photo') } })
        : agent.handle(phone, { text: reply });
    submission = outcome.submission;
    last = outcome.replies.at(-1) ?? last;
  }
  assert.ok(submission);
  return submission;
}

describe('approval message to Lukas', () => {
  test('carries the item, the flags, the verification list and a suggestion that is labelled as one', () => {
    const submission = completeIntake();
    const { ownerMessage, reference, valuation } = approvals.request(submission, ESTIMATES);

    assert.match(ownerMessage, /New pawn application — [A-Z0-9]{4}/);
    assert.match(ownerMessage, /iPhone 13 Pro/);
    assert.match(ownerMessage, new RegExp(CUSTOMER.replace('+', '\\+')));
    assert.match(ownerMessage, /Suggested loan \(your formula, not an offer\)/);
    assert.match(ownerMessage, /N\$3,750\.00 suggested loan/, "the playbook's own arithmetic");
    assert.match(ownerMessage, /29% over 30 days/);
    assert.match(ownerMessage, /To verify in person/);
    assert.match(ownerMessage, /mechanic|Activation Lock|hardware test|fraud patterns/i);
    assert.match(ownerMessage, new RegExp(`APPROVE ${reference}`));
    assert.equal(valuation?.suggestedLoanCents, 375_000);
  });

  test('asks Lukas for the amount when there is no market estimate', () => {
    const submission = completeIntake();
    const { ownerMessage, approval } = approvals.request(submission);

    assert.match(ownerMessage, /No market estimate yet/);
    assert.equal(approval.suggested_loan_cents, null);
  });

  test('lists what the customer would not confirm', () => {
    const submission = completeIntake(CUSTOMER, (ask) => (/iCloud/i.test(ask) ? 'no' : 'yes'));
    const { ownerMessage } = approvals.request(submission, ESTIMATES);

    assert.match(ownerMessage, /Flagged — not confirmed/);
    assert.match(ownerMessage, /iCloud/i);
  });

  test('the application sits pending until Lukas replies', () => {
    const submission = completeIntake();
    const { approval } = approvals.request(submission, ESTIMATES);

    assert.equal(approval.status, 'pending');
    assert.equal(store.item(submission.item.id)?.status, 'awaiting-approval');
    assert.equal(store.pendingApprovals().length, 1);
  });
});

describe('reading Lukas’s reply', () => {
  test('understands the forms he would actually type', () => {
    assert.deepEqual(parseOwnerReply('APPROVE A1B2'), { action: 'approve', reference: 'A1B2', amountCents: null, note: null, edits: {} });
    assert.deepEqual(parseOwnerReply('approve a1b2 3000'), { action: 'approve', reference: 'A1B2', amountCents: 300_000, note: null, edits: {} });
    assert.deepEqual(parseOwnerReply('approve N$3,500.50'), { action: 'approve', reference: null, amountCents: 350_050, note: null, edits: {} });
    assert.deepEqual(parseOwnerReply('decline A1B2 no proof of ownership'), {
      action: 'decline',
      reference: 'A1B2',
      amountCents: null,
      note: 'no proof of ownership',
      edits: {},
    });
  });

  test('an adjustment names whichever figures he wants to move', () => {
    assert.deepEqual(parseOwnerReply('ADJUST A1B2 3500').edits, { loan: 350_000 }, 'a bare amount is the loan');
    assert.deepEqual(parseOwnerReply('adjust A1B2 market 8000 buy 4500').edits, { market: 800_000, buy: 450_000 });
    assert.deepEqual(parseOwnerReply('adjust A1B2 assessed N$6,000 loan 3000').edits, { assessed: 600_000, loan: 300_000 });
    assert.equal(parseOwnerReply('adjust A1B2 3500').action, 'adjust');
    assert.equal(parseOwnerReply('change A1B2 outright 5000').edits.buy, 500_000, 'his own words for it work too');
  });

  test('anything it cannot read decides nothing', () => {
    for (const text of ['maybe', 'hmm let me think', 'call him', '👍', '']) {
      assert.equal(parseOwnerReply(text).action, 'help', `"${text}" must not be read as a decision`);
    }
  });
});

describe('decisions', () => {
  test('approving at the suggested amount tells the customer the figure — for the first time', () => {
    const submission = completeIntake();
    const { reference } = approvals.request(submission, ESTIMATES);

    const beforeDecision = store
      .messages(submission.conversationId)
      .filter((message) => message.direction === 'out')
      .map((message) => message.body)
      .join('\n');
    assert.doesNotMatch(beforeDecision, /N\$\s?\d/, 'no figure reached the customer during intake');

    const result = approvals.handleOwnerReply(`APPROVE ${reference}`, lukas);
    assert.equal(result.approval?.status, 'approved');
    assert.equal(result.approval?.approved_loan_cents, 375_000);
    assert.match(result.customerMessage!, /N\$3,750\.00/);
    assert.match(result.customerMessage!, /29% over 30 days/);
    assert.match(result.customerMessage!, /subject to the in-person check/i);
    assert.equal(result.customerPhone, CUSTOMER);
  });

  test('approving at his own amount keeps the engine’s number alongside his', () => {
    const submission = completeIntake();
    const { reference, approval } = approvals.request(submission, ESTIMATES);

    const result = approvals.handleOwnerReply(`approve ${reference} 3000 screen is scratched`, lukas);
    assert.equal(result.approval?.approved_loan_cents, 300_000);

    const valuation = store.db
      .prepare('SELECT suggested_loan_cents, override_cents, override_note FROM valuations WHERE id = ?')
      .get(approval.valuation_id!) as { suggested_loan_cents: number; override_cents: number; override_note: string };
    assert.equal(valuation.suggested_loan_cents, 375_000);
    assert.equal(valuation.override_cents, 300_000);
    assert.match(valuation.override_note, /scratched/);
  });

  test('a large approval switches to the playbook’s 40%/60-day row', () => {
    const submission = completeIntake();
    const { reference } = approvals.request(submission, ESTIMATES);

    const result = approvals.handleOwnerReply(`approve ${reference} 20000`, lukas);
    assert.match(result.customerMessage!, /40% over 60 days/);
    assert.match(result.customerMessage!, /N\$28,000\.00/);
  });

  test('declining tells the customer without a figure and records the reason', () => {
    const submission = completeIntake();
    const { reference } = approvals.request(submission, ESTIMATES);

    const result = approvals.handleOwnerReply(`DECLINE ${reference} no police declaration`, lukas);
    assert.equal(result.approval?.status, 'declined');
    assert.equal(result.approval?.note, 'no police declaration');
    assert.doesNotMatch(result.customerMessage!, /N\$\s?\d/);
    assert.equal(store.item(submission.item.id)?.status, 'declined');
  });

  test('an unreadable reply changes nothing at all', () => {
    const submission = completeIntake();
    approvals.request(submission, ESTIMATES);

    const result = approvals.handleOwnerReply('hmm, maybe 3000?', lukas);
    assert.equal(result.approval, undefined);
    assert.equal(result.customerMessage, undefined);
    assert.match(result.ownerMessage, /APPROVE/);
    assert.equal(store.pendingApprovals().length, 1, 'still waiting for a real decision');
  });

  test('with two applications waiting, a bare "approve" is refused until he names one', () => {
    const first = completeIntake('+264811111111');
    const second = completeIntake('+264812222222');
    approvals.request(first, ESTIMATES);
    const { reference } = approvals.request(second, ESTIMATES);

    const ambiguous = approvals.handleOwnerReply('approve', lukas);
    assert.equal(ambiguous.approval, undefined);
    assert.match(ambiguous.ownerMessage, /2 applications are waiting/);
    assert.equal(store.pendingApprovals().length, 2);

    const decided = approvals.handleOwnerReply(`approve ${reference}`, lukas);
    assert.equal(decided.approval?.item_id, second.item.id);
    assert.equal(store.pendingApprovals().length, 1);
  });

  test('a decision is recorded against Lukas in the audit log', () => {
    const submission = completeIntake();
    const { reference, approval } = approvals.request(submission, ESTIMATES);
    approvals.handleOwnerReply(`approve ${reference}`, lukas);

    const trail = store.auditTrail('approval', approval.id);
    assert.deepEqual(trail.map((row) => row.action), ['approval.requested', 'approval.approved']);
    assert.equal(trail[1]?.actor, lukas.id);
  });

  test('the same application cannot be decided twice', () => {
    const submission = completeIntake();
    const { reference } = approvals.request(submission, ESTIMATES);
    approvals.handleOwnerReply(`approve ${reference}`, lukas);

    const second = approvals.handleOwnerReply(`decline ${reference}`, lukas);
    assert.equal(second.approval, undefined);
    assert.match(second.ownerMessage, /Nothing is waiting|can't find/i);
  });

  test('references are stable and short enough to type', () => {
    const submission = completeIntake();
    const { approval, reference } = approvals.request(submission, ESTIMATES);
    assert.equal(reference, referenceFor(approval.id));
    assert.match(reference, /^[A-Z0-9]{4}$/);
  });
});

describe('adjusting an application', () => {
  test('changes the figures without deciding anything', () => {
    const submission = completeIntake();
    const { reference } = approvals.request(submission, ESTIMATES);

    const result = approvals.handleOwnerReply(`ADJUST ${reference} market 8000`, lukas);

    assert.match(result.ownerMessage, /Market value: N\$8,000\.00/);
    assert.match(result.ownerMessage, /Pawn loan: \*N\$3,000\.00\*/, 'carried down the playbook chain');
    assert.match(result.ownerMessage, /Buy outright: \*N\$3,750\.00\*/);
    assert.equal(result.customerMessage, undefined, 'the customer is told nothing — this is not a decision');
    assert.equal(store.pendingApprovals().length, 1, 'and it is still waiting on him');
  });

  test('a second adjustment builds on the first instead of reverting it', () => {
    const submission = completeIntake();
    const { reference } = approvals.request(submission, ESTIMATES);

    approvals.handleOwnerReply(`ADJUST ${reference} market 8000`, lukas);
    const second = approvals.handleOwnerReply(`ADJUST ${reference} buy 4200`, lukas);

    assert.match(second.ownerMessage, /Market value: N\$8,000\.00/, 'his earlier correction still stands');
    assert.match(second.ownerMessage, /Buy outright: \*N\$4,200\.00\*/);
  });

  test('the adjustment is remembered for the next item like it', () => {
    const submission = completeIntake();
    const { reference } = approvals.request(submission, ESTIMATES);
    approvals.handleOwnerReply(`ADJUST ${reference} 2500`, lukas);

    const remembered = new PriceMemory(store, rules).recall({
      categorySlug: submission.item.category_slug,
      variant: submission.item.variant,
      description: submission.item.description,
    });

    assert.equal(remembered?.loanCents, 250_000);
    assert.equal(remembered?.suggestedLoanCents, 375_000, 'what the engine had said is kept beside his number');
  });

  test('approving after adjusting uses the adjusted figure', () => {
    const submission = completeIntake();
    const { reference } = approvals.request(submission, ESTIMATES);
    approvals.handleOwnerReply(`ADJUST ${reference} 2500`, lukas);

    const approved = approvals.handleOwnerReply(`APPROVE ${reference}`, lukas);
    assert.equal(approved.approval?.approved_loan_cents, 250_000);
    assert.match(approved.customerMessage!, /N\$2,500\.00/);
  });

  test('an adjustment with no figure in it asks rather than guessing', () => {
    const submission = completeIntake();
    const { reference } = approvals.request(submission, ESTIMATES);

    const result = approvals.handleOwnerReply(`ADJUST ${reference}`, lukas);
    assert.match(result.ownerMessage, /Tell me what to change/);
    assert.equal(store.pendingApprovals()[0]!.suggested_loan_cents, 375_000, 'nothing moved');
  });
});
