/**
 * Another month — playbook section 8 step 3, the 75% line.
 *
 * Lukas's rule, 21 October 2026: add the next month's interest to everything
 * owed and compare against the item's *current* market value. At or below 75%
 * the extension may be granted; above it, the item goes to market.
 *
 * The arithmetic is checked here independently of the implementation, because
 * this is the one rule in the project that decides whether the shop keeps
 * lending against something it can no longer recover from a quick sale.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/playbook/index.ts';
import { Store, type Loan, type User } from '../src/store/index.ts';
import { AgentRouter } from '../src/router.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { Book } from '../src/book/index.ts';
import { Extensions, extensionTest, parseExtendCommand } from '../src/book/extend.ts';
import { referenceFor } from '../src/reference.ts';

const rules = loadRules();
const OWNER = '+264811110000';
const STAFF = '+264811112222';
const CUSTOMER = '+264811000051';
const TODAY = '2026-10-21';

let store: Store;
let transport: MemoryTransport;
let router: AgentRouter;
let book: Book;
let lukas: User;
let staff: User;
let marketValue = 2_000_000;
let counter = 0;

const clock = () => new Date(`${TODAY}T09:00:00Z`);

beforeEach(() => {
  store = new Store(':memory:');
  transport = new MemoryTransport();
  marketValue = 2_000_000;
  router = new AgentRouter({
    store, rules, transport, ownerPhone: OWNER, clock,
    valuator: { async estimate() { return [{ source: 'Marketplace', amountCents: marketValue }]; } },
  });
  book = new Book(store, { clock });
  lukas = store.owner()!;
  staff = store.ensureUser({ name: 'Petrus Haufiku', phone: STAFF, role: 'inspector' });
});

afterEach(() => store.close());

const day = (from: string, days: number) =>
  new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The playbook's own worked example: N$3,750 loan at 29%, one month missed. */
function pawn(startDate = '2026-09-10'): Loan {
  const customer = store.upsertCustomer(CUSTOMER, 'Aina Shipanga');
  const item = store.createItem({
    customerId: customer.id, categorySlug: 'phones', variant: 'iphone', description: 'iPhone 15, 128GB',
  });
  store.saveValuation({
    itemId: item.id,
    estimates: [{ source: 'Marketplace', amountCents: 1_000_000 }],
    assessedValueCents: 750_000, suggestedLoanCents: 375_000,
    formula: 'lowest x 0.75 / 2', workings: [],
  });

  const interest = 108_750; // 29% of 375,000
  const due = day(startDate, 30);
  const loan = store.createLoan({
    customerId: customer.id, itemId: item.id, principalCents: 375_000,
    ratePct: 29, rateRule: 'standard', termDays: 30, interestCents: interest,
    startDate, dueDate: due, graceEndsDate: day(due, 4), actor: lukas.id, at: `${startDate}T00:00:00.000Z`,
  });
  store.postLedgerEntry({ loanId: loan.id, entryType: 'principal', amountCents: 375_000, actor: lukas.id, at: `${startDate}T00:00:00.000Z` });
  store.postLedgerEntry({ loanId: loan.id, entryType: 'interest', amountCents: interest, actor: lukas.id, at: `${startDate}T00:00:01.000Z` });
  store.updateItem(item.id, { status: 'pledged' });
  return loan;
}

const say = (from: string, text: string) =>
  router.handle({ from, messageId: `m${++counter}`, type: 'text', text });

describe('the 75% line', () => {
  test('the threshold comes from the playbook', () => {
    // Corrected from 70 by Lukas on 30 October 2026. 75% of market value is
    // also the assessed value, since section 3 assesses at market x 0.75.
    assert.equal(rules.playbook.collections.extensionCeilingPct, 75);
  });

  test('the arithmetic, checked independently', () => {
    const loan = pawn();
    const line = book.lineFor(store.loan(loan.id)!);

    // Owed is principal plus one month: 375,000 + 108,750 = 483,750.
    // Another month adds 108,750, so 592,500 on a 1,000,000 item = 59.25%.
    const result = extensionTest(rules, line, 1_000_000);

    assert.equal(result.owedCents, 483_750);
    assert.equal(result.nextInterestCents, 108_750);
    assert.equal(result.wouldOweCents, 592_500);
    assert.equal(result.ceilingCents, 750_000, '75% of a million');
    assert.equal(result.allowed, true, '59% is inside the line');
  });

  test('a fallen market value pushes the same loan past the line', () => {
    const loan = pawn();
    const line = book.lineFor(store.loan(loan.id)!);

    // The same N$5,925 owed against an item now worth N$7,500 is 79%. Under
    // the old 70% line an N$8,000 item already failed; at 75% it does not,
    // which is the whole point of the correction.
    assert.equal(extensionTest(rules, line, 800_000).allowed, true, '74% is now inside');
    const result = extensionTest(rules, line, 750_000);
    assert.equal(result.allowed, false);
    assert.equal(result.ceilingCents, 562_500);
  });

  test('exactly on the line is allowed — "at or below"', () => {
    const loan = pawn();
    const line = book.lineFor(store.loan(loan.id)!);

    // 592,500 is exactly 75% of 790,000 — no rounding needed this time.
    const result = extensionTest(rules, line, 790_000);
    assert.equal(result.ceilingCents, 592_500);
    assert.equal(result.allowed, true, 'the document says "at or below"');
  });

  test('each further month walks it towards the line', () => {
    // The point of the rule: extensions are not indefinite. Measured on the
    // playbook's own figures, the third one is where it stops.
    const loan = pawn();
    const owedAfter = (months: number) => 375_000 + 108_750 * months;
    const ceiling = 750_000;

    assert.ok(owedAfter(2) <= ceiling, 'two months fits');
    // At 70% the third month failed by N$12.50 — 701,250 against 700,000.
    // That is what the correction to 75% bought: one more month.
    assert.ok(owedAfter(3) <= ceiling, 'and so does three, since the correction');
    assert.ok(owedAfter(4) > ceiling, 'the fourth is where it stops');
  });

  test('no market value means the test cannot run, and says so', () => {
    const loan = pawn();
    const result = extensionTest(rules, book.lineFor(store.loan(loan.id)!), null);

    assert.equal(result.allowed, null);
    assert.equal(result.ceilingCents, null);
    assert.equal(result.wouldOweCents, 592_500, 'what is owed is still known');
  });
});

describe('EXTEND', () => {
  test('inside the line, it extends and posts the interest as a new entry', async () => {
    const loan = pawn();
    marketValue = 1_000_000;
    const before = store.ledger(loan.id);

    await say(OWNER, `EXTEND ${referenceFor(loan.id)}`);

    const after = store.ledger(loan.id);
    assert.equal(after.length, before.length + 1, 'a second interest entry, not an edit');
    assert.deepEqual(
      after.slice(0, before.length).map((entry) => entry.amount_cents),
      before.map((entry) => entry.amount_cents),
      'the original entries are untouched — the ledger is append-only',
    );
    assert.equal(after.at(-1)!.entry_type, 'interest.extension');
    assert.equal(after.at(-1)!.amount_cents, 108_750);
  });

  test('the new dates come from the playbook, not from a constant', async () => {
    const loan = pawn();
    const originalDue = store.loan(loan.id)!.due_date;
    await say(OWNER, `EXTEND ${referenceFor(loan.id)}`);

    const extended = store.loan(loan.id)!;
    const termDays = rules.rate('standard')!.termDays!;
    assert.equal(extended.due_date, day(originalDue, termDays));
    assert.equal(extended.grace_ends_date, day(extended.due_date, rules.playbook.grace.defaultDays));
  });

  test('what the customer owes afterwards matches the arithmetic', async () => {
    const loan = pawn();
    await say(OWNER, `EXTEND ${referenceFor(loan.id)}`);

    assert.equal(book.lineFor(store.loan(loan.id)!).owedCents, 592_500);
    assert.match(transport.to(CUSTOMER).at(-1)!, /N\$5,925\.00/);
  });

  test('the customer is told the new date and the new total', async () => {
    const loan = pawn();
    await say(OWNER, `EXTEND ${referenceFor(loan.id)}`);

    const told = transport.to(CUSTOMER).at(-1)!;
    assert.match(told, /another month/i);
    assert.match(told, /N\$1,087\.50/, 'what was added');
    assert.match(told, new RegExp(store.loan(loan.id)!.due_date));
  });

  test('he is shown the test, and told the market value is an estimate', async () => {
    const loan = pawn();
    await say(OWNER, `EXTEND ${referenceFor(loan.id)}`);

    const sent = transport.to(OWNER).at(-1)!;
    assert.match(sent, /75% line/);
    assert.match(sent, /estimate made just now, not a sale price/i);
  });

  test('past the line it refuses, and points at SELL', async () => {
    const loan = pawn();
    marketValue = 600_000; // 592,500 owed would be 98% of this

    await say(OWNER, `EXTEND ${referenceFor(loan.id)}`);

    const sent = transport.to(OWNER).at(-1)!;
    assert.match(sent, /does not allow another month/i);
    assert.match(sent, new RegExp(`SELL ${referenceFor(loan.id)}`));
    assert.match(sent, /change to section 8.*edit the document/is, 'not an override on his phone');

    assert.equal(store.loan(loan.id)!.due_date, day('2026-09-10', 30), 'nothing moved');
    assert.equal(store.ledger(loan.id).length, 2, 'and no interest was added');

    // Lukas, 30 October 2026: "If we can't extend, we tell them we can't
    // extend and that we have to sell the item to recover our money."
    // Previously only he was told, so a customer who asked for another month
    // heard nothing at all.
    const told = transport.to(CUSTOMER).at(-1)!;
    assert.match(told, /can't extend/i);
    assert.match(told, /sold for the shop to recover/i);
    assert.match(told, /collect it at any time before it is sold/i, 'redemption stays open, and it is the useful part');
    assert.match(told, /manager/i);
    assert.doesNotMatch(told, /Lukas/, 'customers are told "the manager"');

    // Promises nothing he has not decided: sending an item to market is still
    // *SELL <ref>*, so no date and no claim that it has happened.
    assert.doesNotMatch(told, /\d{4}-\d{2}-\d{2}/, 'no sale date is invented');
    assert.doesNotMatch(told, /has been sold|is being sold|will be sold on/i);
  });

  test('and says so when it cannot tell', async () => {
    const loan = pawn();
    const extensions = new Extensions(store, rules, book, null);

    const result = await extensions.run({ reference: referenceFor(loan.id), note: '' }, lukas);
    assert.match(result.ownerMessage, /can't run the section 8 extension test/i);
    assert.equal(store.ledger(loan.id).length, 2, 'nothing was changed');
  });
});

describe('who may extend, and when', () => {
  test('only Lukas', async () => {
    const loan = pawn();
    const extensions = new Extensions(store, rules, book, {
      async estimate() { return [{ source: 'Marketplace', amountCents: 1_000_000 }]; },
    });

    const result = await extensions.run({ reference: referenceFor(loan.id), note: '' }, staff);
    assert.match(result.ownerMessage, /Only Lukas/);
    assert.equal(store.ledger(loan.id).length, 2, 'nothing moved');
  });

  test('nothing extends without the command', () => {
    const loan = pawn('2026-01-05');

    // Nine months of silence. No clock extends anything, any more than one
    // sells anything.
    assert.equal(store.loan(loan.id)!.due_date, day('2026-01-05', 30));
    assert.equal(store.ledger(loan.id).length, 2);
  });

  test('a loan still inside its term is not up for extension', async () => {
    const loan = pawn(TODAY);
    await say(OWNER, `EXTEND ${referenceFor(loan.id)}`);

    assert.match(transport.to(OWNER).at(-1)!, /No loan is due or past due|Nothing due under reference/);
  });

  test('an extended loan leaves the past-grace list and comes back later', async () => {
    const loan = pawn('2026-08-20');
    assert.equal(book.overdue().length, 1, 'past grace to begin with');

    await say(OWNER, `EXTEND ${referenceFor(loan.id)}`);

    assert.equal(book.overdue().length, 0, 'the new date has not passed yet');
    assert.equal(store.loan(loan.id)!.status, 'active');
  });

  test('with two in question it asks which', async () => {
    pawn('2026-09-10');
    const other = store.upsertCustomer('+264811000052', 'Petrus Nangolo');
    const item = store.createItem({ customerId: other.id, categorySlug: 'phones', description: 'iPhone 14' });
    const due = day('2026-09-10', 30);
    const loan = store.createLoan({
      customerId: other.id, itemId: item.id, principalCents: 200_000,
      ratePct: 29, rateRule: 'standard', termDays: 30, interestCents: 58_000,
      startDate: '2026-09-10', dueDate: due, graceEndsDate: day(due, 4), actor: lukas.id,
    });
    store.postLedgerEntry({ loanId: loan.id, entryType: 'principal', amountCents: 200_000, actor: lukas.id });

    await say(OWNER, 'EXTEND');
    assert.match(transport.to(OWNER).at(-1)!, /could be extended — say which/);
  });
});

describe('the command', () => {
  test('reads the way he would type it', () => {
    assert.deepEqual(parseExtendCommand('EXTEND K3P9'), { reference: 'K3P9', note: '' });
    assert.deepEqual(parseExtendCommand('extend k3p9 she called me'), { reference: 'K3P9', note: 'she called me' });
    assert.deepEqual(parseExtendCommand('another month K3P9'), { reference: 'K3P9', note: '' });
    assert.deepEqual(parseExtendCommand('EXTEND'), { reference: null, note: '' });
  });

  test('is not confusable with the others', () => {
    for (const other of ['APPROVE K3P9', 'SELL K3P9', 'KEEP K3P9', 'ACCEPT K3P9', 'BOOK', 'OVERDUE']) {
      assert.equal(parseExtendCommand(other), null, other);
    }
  });
});
