/**
 * Taking the money back — docs/tasks/006, playbook section 4.
 *
 * This path did not exist. A loan could be created, accrue interest, be
 * extended and be sent to market, but never paid — so every loan stayed on the
 * book as outstanding forever, BOOK overstated what was out on loan from the
 * first repayment onward, and OVERDUE would have chased somebody who settled
 * in full last week.
 *
 * Every figure here is worked out independently in the test. The whole point
 * of a ledger is that two people can arrive at the same number separately.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/playbook/index.ts';
import { Store, type Loan, type User } from '../src/store/index.ts';
import { AgentRouter } from '../src/router.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { Book } from '../src/book/index.ts';
import { Repayments, parseRepayCommand, splitPayment } from '../src/book/repay.ts';
import { referenceFor } from '../src/reference.ts';

const rules = loadRules();
const OWNER = '+264811110000';
const STAFF = '+264811112222';
const CUSTOMER = '+264811000200';
const TODAY = '2026-10-21';

// N$3,750 at 29% over 30 days. N$1,087.50 interest, N$4,837.50 owed.
const PRINCIPAL = 375_000;
const INTEREST = 108_750;
const OWED = PRINCIPAL + INTEREST;

let store: Store;
let transport: MemoryTransport;
let router: AgentRouter;
let book: Book;
let lukas: User;
let staff: User;
let loan: Loan;
let counter = 0;

const clock = () => new Date(`${TODAY}T09:00:00Z`);

beforeEach(() => {
  store = new Store(':memory:');
  transport = new MemoryTransport();
  router = new AgentRouter({ store, rules, transport, ownerPhone: OWNER, clock });
  book = new Book(store, { clock });
  lukas = store.owner()!;
  staff = store.ensureUser({ name: 'Petrus Haufiku', phone: STAFF, role: 'inspector' });
  loan = pawn();
});

afterEach(() => store.close());

function pawn(startDate = '2026-10-01'): Loan {
  const customer = store.upsertCustomer(CUSTOMER, 'Aina Shipanga');
  const item = store.createItem({
    customerId: customer.id, categorySlug: 'phones', variant: 'iphone', description: 'iPhone 15, 128GB',
  });
  const day = (from: string, days: number) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const due = day(startDate, 30);
  const created = store.createLoan({
    customerId: customer.id, itemId: item.id, principalCents: PRINCIPAL,
    ratePct: 29, rateRule: 'standard', termDays: 30, interestCents: INTEREST,
    startDate, dueDate: due, graceEndsDate: day(due, 4), actor: lukas.id, at: `${startDate}T00:00:00.000Z`,
  });
  store.postLedgerEntry({ loanId: created.id, entryType: 'principal', amountCents: PRINCIPAL, actor: lukas.id, at: `${startDate}T00:00:00.000Z` });
  store.postLedgerEntry({ loanId: created.id, entryType: 'interest', amountCents: INTEREST, actor: lukas.id, at: `${startDate}T00:00:01.000Z` });
  store.updateItem(item.id, { status: 'pledged' });
  return created;
}

const ref = () => referenceFor(loan.id);
const say = (from: string, text: string) =>
  router.handle({ from, messageId: `m${++counter}`, type: 'text', text });

describe('settling in full', () => {
  test('closes the loan and gives the item back', async () => {
    await say(OWNER, `PAID ${ref()}`);

    assert.equal(store.balance(loan.id), 0);
    assert.equal(store.loan(loan.id)!.status, 'paid');
    assert.equal(store.item(loan.item_id)!.status, 'redeemed');
  });

  test('and takes it off the book', async () => {
    assert.equal(book.summary().outOnLoanCents, OWED, 'on the book to begin with');

    await say(OWNER, `PAID ${ref()}`);

    assert.equal(book.summary().outOnLoanCents, 0);
    assert.equal(book.summary().activeLoans, 0);
    assert.deepEqual(book.due(), []);
    assert.deepEqual(book.overdue(), []);
  });

  test('the interest shows as collected, which nothing has ever exercised', async () => {
    assert.equal(book.summary().interestAllTimeCents, 0);

    await say(OWNER, `PAID ${ref()}`);

    assert.equal(book.summary().interestAllTimeCents, INTEREST);
    assert.equal(book.summary().interestThisMonthCents, INTEREST);
  });

  test('the customer is told, and told to bring ID', async () => {
    await say(OWNER, `PAID ${ref()}`);
    const told = transport.to(CUSTOMER).at(-1)!;

    assert.match(told, /settled in full/i);
    assert.match(told, /ready to collect/i);
    assert.match(told, /bring your ID/i);
    assert.doesNotMatch(told, /Lukas/i, 'customers read the role, never the name');
  });
});

describe('a part payment', () => {
  test('splits interest first, and leaves exactly the right balance', async () => {
    await say(OWNER, `PAID ${ref()} 1500`);

    // N$1,500 pays all N$1,087.50 of interest, then N$412.50 of principal.
    // Worked out here rather than read back from the code.
    const paid = 150_000;
    assert.equal(store.balance(loan.id), OWED - paid);
    assert.equal(book.summary().interestAllTimeCents, INTEREST, 'the interest was cleared first');

    const entries = store.ledger(loan.id);
    assert.equal(entries.find((e) => e.entry_type === 'repayment.interest')!.amount_cents, -INTEREST);
    assert.equal(entries.find((e) => e.entry_type === 'repayment.principal')!.amount_cents, -(paid - INTEREST));
  });

  test('leaves the loan active and the item with us', async () => {
    await say(OWNER, `PAID ${ref()} 1500`);

    assert.equal(store.loan(loan.id)!.status, 'active');
    assert.equal(store.item(loan.item_id)!.status, 'pledged');
    assert.match(transport.to(CUSTOMER).at(-1)!, /still owing/i);
    assert.match(transport.to(CUSTOMER).at(-1)!, /stays with us/i);
  });

  test('a second payment clears it', async () => {
    await say(OWNER, `PAID ${ref()} 1500`);
    await say(OWNER, `PAID ${ref()}`);

    assert.equal(store.balance(loan.id), 0);
    assert.equal(store.loan(loan.id)!.status, 'paid');
    assert.equal(book.summary().interestAllTimeCents, INTEREST, 'counted once, not twice');
  });

  test('smaller than the interest owed touches no principal', async () => {
    await say(OWNER, `PAID ${ref()} 500`);

    const entries = store.ledger(loan.id);
    assert.equal(entries.filter((e) => e.entry_type === 'repayment.principal').length, 0);
    assert.equal(book.summary().interestAllTimeCents, 50_000);
  });

  test('the split is arithmetic, not a percentage of the principal', () => {
    // An extension posts a second interest charge (interest.extension).
    // Recomputing interest from the rate would miss it entirely, so the split
    // sums the ledger instead.
    store.postLedgerEntry({
      loanId: loan.id, entryType: 'interest.extension', amountCents: INTEREST, actor: lukas.id,
    });

    const owedNow = store.balance(loan.id);
    assert.equal(owedNow, OWED + INTEREST);

    const split = splitPayment(store, loan.id, owedNow);
    assert.equal(split.interestOwedCents, INTEREST * 2, 'both months of interest');
    assert.equal(split.toInterestCents, INTEREST * 2);
    assert.equal(split.toPrincipalCents, PRINCIPAL);
    assert.ok(split.settles);
  });

  test('and a part payment on an extended loan clears both months first', async () => {
    store.postLedgerEntry({
      loanId: loan.id, entryType: 'interest.extension', amountCents: INTEREST, actor: lukas.id,
    });

    await say(OWNER, `PAID ${ref()} 2500`);

    // N$2,500 covers N$2,175 of interest, then N$325 of principal.
    assert.equal(book.summary().interestAllTimeCents, INTEREST * 2);
    assert.equal(store.balance(loan.id), OWED + INTEREST - 250_000);
  });
});

describe('what it refuses', () => {
  test('an overpayment is not absorbed', async () => {
    await say(OWNER, `PAID ${ref()} 10000`);

    assert.match(transport.to(OWNER).at(-1)!, /you have put in N\$10,000\.00/);
    assert.equal(store.balance(loan.id), OWED, 'nothing was recorded');
    assert.ok(store.balance(loan.id) > 0, 'and no negative balance exists');
    assert.deepEqual(transport.to(CUSTOMER), [], 'the customer was promised nothing');
  });

  test('a settled loan cannot be paid twice', async () => {
    await say(OWNER, `PAID ${ref()}`);
    const entries = store.ledger(loan.id).length;

    await say(OWNER, `PAID ${ref()} 500`);
    assert.match(transport.to(OWNER).at(-1)!, /Nothing is outstanding/);
    assert.equal(store.ledger(loan.id).length, entries);
  });

  test('staff cannot record a payment', () => {
    const repayments = new Repayments(store, rules, book);
    const result = repayments.run({ reference: ref(), amountCents: null, note: '' }, staff);

    assert.match(result.ownerMessage, /Only the owner/);
    assert.equal(store.balance(loan.id), OWED, 'nothing moved');
  });

  test('two outstanding loans make him say which', async () => {
    const other = store.upsertCustomer('+264811000201', 'Petrus Nangolo');
    const item = store.createItem({ customerId: other.id, categorySlug: 'phones', description: 'iPhone 14' });
    const second = store.createLoan({
      customerId: other.id, itemId: item.id, principalCents: 200_000,
      ratePct: 29, rateRule: 'standard', termDays: 30, interestCents: 58_000,
      startDate: '2026-10-01', dueDate: '2026-10-31', graceEndsDate: '2026-11-04', actor: lukas.id,
    });
    store.postLedgerEntry({ loanId: second.id, entryType: 'principal', amountCents: 200_000, actor: lukas.id });

    await say(OWNER, 'PAID');
    assert.match(transport.to(OWNER).at(-1)!, /2 loans are outstanding/);
    assert.equal(store.balance(loan.id), OWED, 'neither was guessed at');
  });
});

describe('the ledger stays append-only', () => {
  test('the charges are untouched and the payment is new rows', async () => {
    const before = store.ledger(loan.id).map((entry) => ({ type: entry.entry_type, amount: entry.amount_cents }));

    await say(OWNER, `PAID ${ref()}`);

    const after = store.ledger(loan.id);
    assert.deepEqual(
      after.slice(0, before.length).map((entry) => ({ type: entry.entry_type, amount: entry.amount_cents })),
      before,
      'what was owed at each stage is still readable',
    );
    assert.equal(after.length, before.length + 2, 'interest and principal, posted separately');
  });

  test('a payment against the wrong loan is corrected by reversal', async () => {
    await say(OWNER, `PAID ${ref()} 1500`);
    const payment = store.ledger(loan.id).find((entry) => entry.entry_type === 'repayment.interest')!;

    store.reverseLedgerEntry({ entryId: payment.id, actor: lukas.id, reason: 'recorded against the wrong loan' });

    assert.equal(store.balance(loan.id), OWED - 150_000 + INTEREST);
    const entries = store.ledger(loan.id);
    assert.ok(entries.some((entry) => entry.reverses_entry_id === payment.id), 'the reversal is its own row');
    assert.ok(entries.some((entry) => entry.id === payment.id), 'and the mistake is still visible');
  });

  test('every payment is audited to a person', async () => {
    await say(OWNER, `PAID ${ref()} 1500`);
    await say(OWNER, `PAID ${ref()}`);

    const trail = store.auditTrail('loan', loan.id);
    assert.deepEqual(trail.map((entry) => entry.action), ['loan.created', 'loan.part-paid', 'loan.settled']);
    assert.ok(trail.every((entry) => entry.actor === lukas.id));
  });
});

describe('redeeming something already sent to market', () => {
  /**
   * The contract says the customer may redeem until the item is actually sold,
   * and SELL tells them so in those words. So the one case where redemption
   * matters most must not be the case the command refuses.
   */
  test('a forfeited loan can still be settled', async () => {
    const past = pawn('2026-08-20');
    await say(OWNER, `SELL ${referenceFor(past.id)}`);
    assert.equal(store.loan(past.id)!.status, 'forfeited');

    await say(OWNER, `PAID ${referenceFor(past.id)}`);

    assert.equal(store.balance(past.id), 0);
    assert.equal(store.loan(past.id)!.status, 'paid');
    assert.equal(store.item(past.item_id)!.status, 'redeemed', 'they got it back');
  });
});

describe('the command', () => {
  test('reads the way he would type it at a counter', () => {
    assert.deepEqual(parseRepayCommand('PAID K3P9'), { reference: 'K3P9', amountCents: null, note: '' });
    assert.deepEqual(parseRepayCommand('PAID K3P9 1500'), { reference: 'K3P9', amountCents: 150_000, note: '' });
    assert.deepEqual(parseRepayCommand('paid k3p9 1,500.50'), { reference: 'K3P9', amountCents: 150_050, note: '' });
    assert.deepEqual(parseRepayCommand('PAID K3P9 1500 rest on Friday'), {
      reference: 'K3P9', amountCents: 150_000, note: 'rest on Friday',
    });
    assert.deepEqual(parseRepayCommand('collected K3P9'), { reference: 'K3P9', amountCents: null, note: '' });
  });

  test('is not confusable with the others', () => {
    for (const other of ['APPROVE K3P9', 'SELL K3P9', 'EXTEND K3P9', 'KEEP K3P9', 'ACCEPT K3P9', 'BOOK', 'OVERDUE', 'DUE']) {
      assert.equal(parseRepayCommand(other), null, other);
    }
  });
});
