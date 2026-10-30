import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadRules, RATE_LARGE_LOAN, RATE_STANDARD } from '../src/playbook/index.ts';
import { ContractError, Store, generateMediaKey, type Approval, type User } from '../src/store/index.ts';
import { ContractService, buildContract } from '../src/contract/index.ts';
import { formatAmount } from '../src/money.ts';

const rules = loadRules();
const BASE_URL = 'https://eppic.example';

let store: Store;
let contracts: ContractService;
let lukas: User;

beforeEach(() => {
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-contract-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
    clock: () => new Date('2026-01-15T09:00:00Z'),
  });
  contracts = new ContractService(store, rules, { baseUrl: BASE_URL, clock: () => new Date('2026-01-15T09:00:00Z') });
  lukas = store.ensureUser({ name: 'Lukas', phone: '+264815550100', role: 'owner' });
});

afterEach(() => store.close());

/** An approved application ready for a contract. */
function approvedApplication(amountCents = 375_000, category = 'phones'): Approval {
  const customer = store.upsertCustomer('+264811234567', 'Test Customer');
  const item = store.createItem({
    customerId: customer.id,
    categorySlug: category,
    variant: category === 'phones' ? 'iphone' : null,
    description: 'iPhone 13 Pro, 256GB, good condition',
  });
  const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: amountCents });
  return store.decideApproval({
    approvalId: approval.id,
    status: 'approved',
    approvedLoanCents: amountCents,
    decidedBy: lukas.id,
  });
}

describe('the contract document', () => {
  test('carries the playbook figures, not figures written here', () => {
    const approval = approvedApplication();
    const { document } = contracts.issueForApproval(approval.id, { actor: lukas.id });

    const standard = rules.rate(RATE_STANDARD)!;
    assert.equal(document.terms.ratePct, standard.ratePct);
    assert.equal(document.terms.termDays, standard.termDays);
    assert.equal(document.terms.graceDays, rules.playbook.grace.defaultDays);

    assert.match(document.text, new RegExp(formatAmount(375_000).replace(/\$/g, '\\$')));
    assert.match(document.text, new RegExp(`${standard.ratePct}%`));
    assert.match(document.text, /Due date: 2026-02-14/);
    assert.match(document.text, /Grace period: 4 days — until 2026-02-18/);
  });

  test('a larger loan gets the playbook’s 40%/60-day terms automatically', () => {
    const approval = approvedApplication(2_000_000);
    const { document } = contracts.issueForApproval(approval.id, { actor: lukas.id });

    const large = rules.rate(RATE_LARGE_LOAN)!;
    assert.equal(document.terms.rule.id, RATE_LARGE_LOAN);
    assert.match(document.text, new RegExp(`${large.ratePct}%`));
    assert.match(document.text, /Term: 60 days/);
  });

  test('lists what the customer must bring, from playbook section 5', () => {
    const approval = approvedApplication();
    const { document } = contracts.issueForApproval(approval.id, { actor: lukas.id });
    assert.deepEqual(document.requirements, rules.playbook.requirements);
    assert.match(document.text, /Police declaration/i);
  });

  test('states the default and partial-payment rules the playbook actually has', () => {
    const approval = approvedApplication();
    const { document } = contracts.issueForApproval(approval.id, { actor: lukas.id });

    assert.match(document.text, /added to the amount lent/i, 'section 4 compounding');
    assert.match(document.text, new RegExp(`${rules.playbook.collections.marginThresholdPct}%`), 'section 8 margin');
    assert.match(document.text, /priced to sell quickly/i);
    assert.match(document.text, /redeem the item at any point before it is sold/i);
  });

  test('asks a car owner to declare the things the playbook cares about', () => {
    const carApproval = approvedApplication(2_000_000, 'cars');
    const { document } = contracts.issueForApproval(carApproval.id, { actor: lukas.id });
    const declarations = document.declarations.join(' | ');

    assert.match(declarations, /registered in my own name/i);
    assert.match(declarations, /outstanding finance/i);
    assert.match(declarations, /not stolen/i);
  });

  test('escapes anything the customer typed into the item description', () => {
    const customer = store.upsertCustomer('+264819999999', 'Xss Tester');
    const item = store.createItem({
      customerId: customer.id,
      categorySlug: 'laptops',
      description: '<script>alert("x")</script> Dell XPS',
    });
    const document = buildContract(
      { number: 'EPP-2026-0001', customer, item, principalCents: 200_000, startDate: '2026-01-15' },
      rules,
    );

    assert.doesNotMatch(document.html, /<script>/);
    assert.match(document.html, /&lt;script&gt;/);
  });
});

describe('issuing', () => {
  test('an approved application gets one contract, one link, and a numbered reference', () => {
    const approval = approvedApplication();
    const issued = contracts.issueForApproval(approval.id, { actor: lukas.id });

    assert.equal(issued.contract.number, 'EPP-2026-0001');
    assert.equal(issued.contract.status, 'pending');
    assert.match(issued.signingUrl, new RegExp(`^${BASE_URL}/c/[A-Za-z0-9_-]{20,}$`));
    assert.equal(issued.contract.loan_id, null, 'the loan starts at signing, not at approval');

    assert.match(issued.customerMessage, /contract EPP-2026-0001/);
    assert.match(issued.customerMessage, /N\$3,750\.00/);
    assert.match(issued.customerMessage, new RegExp(issued.signingUrl.replace(/[/.]/g, '\\$&')));

    // No "bring with you" list and no "before you come in" any more. The
    // agreement is released after the physical check (playbook section 7), so
    // this message reaches somebody standing at the counter who has already
    // handed the item over — telling them what to bring is nonsense by then.
    // The documents are asked for during intake and again in the approval
    // message, which is where the customer can still act on them.
    assert.doesNotMatch(issued.customerMessage, /bring with you/i);
    assert.doesNotMatch(issued.customerMessage, /before you come in/i);
    assert.match(issued.customerMessage, /Read it and sign here/i);
    assert.match(issued.ownerMessage, /item is already with you and the check is done/i);
  });

  test('numbers run in sequence within the year', () => {
    const first = contracts.issueForApproval(approvedApplication().id, { actor: lukas.id });
    const second = contracts.issueForApproval(approvedApplication().id, { actor: lukas.id });
    assert.equal(first.contract.number, 'EPP-2026-0001');
    assert.equal(second.contract.number, 'EPP-2026-0002');
  });

  test('the exact document shown is stored, with its digest', () => {
    const issued = contracts.issueForApproval(approvedApplication().id, { actor: lukas.id });
    const stored = store.contract(issued.contract.id)!;

    assert.equal(stored.body_html, issued.document.html);
    assert.equal(stored.body_sha256, createHash('sha256').update(issued.document.html).digest('hex'));
  });

  test('a contract body cannot be edited after the fact', () => {
    const issued = contracts.issueForApproval(approvedApplication().id, { actor: lukas.id });
    assert.throws(
      () => store.db.prepare('UPDATE contracts SET body_html = ? WHERE id = ?').run('tampered', issued.contract.id),
      /cannot be edited/,
    );
  });

  test('no contract without an approval decision', () => {
    const customer = store.upsertCustomer('+264812222222');
    const item = store.createItem({ customerId: customer.id, categorySlug: 'tvs', description: 'Samsung 55"' });
    const pending = store.createApproval({ itemId: item.id, suggestedLoanCents: 200_000 });

    assert.throws(() => contracts.issueForApproval(pending.id, { actor: lukas.id }), ContractError);

    const declined = store.decideApproval({ approvalId: pending.id, status: 'declined', decidedBy: lukas.id });
    assert.throws(() => contracts.issueForApproval(declined.id, { actor: lukas.id }), ContractError);
  });

  test('re-issuing voids the previous link instead of leaving two live', () => {
    const approval = approvedApplication();
    const first = contracts.issueForApproval(approval.id, { actor: lukas.id });
    const second = contracts.issueForApproval(approval.id, { actor: lukas.id });

    assert.equal(store.contract(first.contract.id)?.status, 'void');
    assert.equal(store.contract(second.contract.id)?.status, 'pending');
    assert.throws(() => contracts.openForSigning(first.contract.token), /cancelled/i);
  });

  test('issuing is recorded in the audit log with the digest of what was issued', () => {
    const issued = contracts.issueForApproval(approvedApplication().id, { actor: lukas.id });
    const trail = store.auditTrail('contract', issued.contract.id);

    assert.deepEqual(trail.map((row) => row.action), ['contract.issued']);
    assert.equal(trail[0]?.actor, lukas.id);
    assert.match(trail[0]!.details, new RegExp(issued.contract.body_sha256));
  });
});

describe('the signing link', () => {
  test('opens for a valid token', () => {
    const issued = contracts.issueForApproval(approvedApplication().id, { actor: lukas.id });
    assert.equal(contracts.openForSigning(issued.contract.token).id, issued.contract.id);
  });

  test('a wrong or expired token does not open a contract', () => {
    const issued = contracts.issueForApproval(approvedApplication().id, { actor: lukas.id });
    assert.throws(() => contracts.openForSigning('not-a-real-token'), /No contract matches/);

    const later = new ContractService(store, rules, { baseUrl: BASE_URL, clock: () => new Date('2026-03-01T09:00:00Z') });
    assert.throws(() => later.openForSigning(issued.contract.token), /expired/i);
  });
});

describe('the finance warranty (the Spectra case)', () => {
  test('every agreement says the item is not under finance', () => {
    for (const slug of ['phones', 'laptops', 'tvs', 'consoles', 'cars']) {
      const issued = contracts.issueForApproval(approvedApplication(375_000, slug).id, { actor: lukas.id });
      const declarations = issued.contract.body_html;

      assert.match(declarations, /not subject to any instalment, credit or financing agreement/i, slug);
      assert.match(declarations, /remain liable for the full amount/i, `${slug} does not keep them liable`);
      store.voidContract(issued.contract.id, 'test cleanup', lukas.id);
    }
  });

  test('it reaches the signed document, not just the data', () => {
    const issued = contracts.issueForApproval(approvedApplication().id, { actor: lukas.id });
    assert.match(issued.contract.body_html, /not subject to any instalment, credit or financing/i);
    assert.match(issued.contract.body_html, /blocked, locked or disabled remotely/i);
  });
});
