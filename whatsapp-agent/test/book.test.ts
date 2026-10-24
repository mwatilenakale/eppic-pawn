/**
 * Lukas's book, over WhatsApp — the thing the workbook's DASHBOARD and ACTIVE
 * LOANS tabs were doing for him, so he can stop keeping both.
 *
 * The property that matters most is the one asserted hardest: these commands
 * read, and only read.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { Store, generateMediaKey, type Loan } from '../src/store/index.ts';
import { AgentRouter } from '../src/router.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { Book, parseBookCommand } from '../src/book/index.ts';
import { addDays } from '../src/valuation.ts';

const rules = loadRules();
// Lukas's own phone. Deliberately not the shop's number in the playbook:
// the number registered with Meta cannot also be the one he replies from.
const OWNER = '+264811110000';
const TODAY = '2026-08-06';

let store: Store;
let transport: MemoryTransport;
let router: AgentRouter;
let book: Book;
let lukas: string;

beforeEach(() => {
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-book-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  });
  transport = new MemoryTransport();
  router = new AgentRouter({ store, rules, transport, ownerPhone: OWNER, clock: () => new Date(`${TODAY}T09:00:00Z`) });
  book = new Book(store, { clock: () => new Date(`${TODAY}T09:00:00Z`) });
  lukas = store.owner()!.id;
});

afterEach(() => store.close());

interface LoanSpec {
  name: string;
  phone: string;
  principalCents: number;
  ratePct?: number;
  /** Days from today; negative is in the past. */
  startsIn: number;
  paid?: boolean;
}

/** Opens a loan the way the contract signing does: principal and interest posted. */
function openLoan(spec: LoanSpec): Loan {
  const customer = store.upsertCustomer(spec.phone, spec.name);
  const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', description: `${spec.name}'s phone` });
  const start = addDays(TODAY, spec.startsIn);
  const ratePct = spec.ratePct ?? 30;
  const interestCents = Math.round((spec.principalCents * ratePct) / 100);

  const loan = store.createLoan({
    customerId: customer.id,
    itemId: item.id,
    principalCents: spec.principalCents,
    ratePct,
    rateRule: 'standard',
    termDays: 30,
    interestCents,
    startDate: start,
    dueDate: addDays(start, 30),
    graceEndsDate: addDays(start, 34),
    status: spec.paid ? 'paid' : 'active',
    actor: lukas,
    at: `${start}T00:00:00.000Z`,
  });

  store.postLedgerEntry({ loanId: loan.id, entryType: 'principal', amountCents: spec.principalCents, actor: lukas, at: `${start}T00:00:00.000Z` });
  store.postLedgerEntry({ loanId: loan.id, entryType: 'interest', amountCents: interestCents, actor: lukas, at: `${start}T00:00:01.000Z` });

  if (spec.paid) {
    const settled = addDays(start, 30);
    store.postLedgerEntry({ loanId: loan.id, entryType: 'repayment.interest', amountCents: -interestCents, actor: lukas, at: `${settled}T00:00:00.000Z` });
    store.postLedgerEntry({ loanId: loan.id, entryType: 'repayment.principal', amountCents: -spec.principalCents, actor: lukas, at: `${settled}T00:00:01.000Z` });
  }
  return loan;
}

/** A book with one of everything: settled, due soon, in grace, past grace. */
function seed(): void {
  openLoan({ name: 'Aina Shipanga', phone: '+264811110001', principalCents: 300_000, startsIn: -200, paid: true });
  openLoan({ name: 'Bernhard Katiti', phone: '+264811110002', principalCents: 150_000, startsIn: -27 }); // due in 3 days
  openLoan({ name: 'Chrizelle Nangolo', phone: '+264811110003', principalCents: 100_000, startsIn: -32 }); // in grace
  openLoan({ name: 'Daniel Amukoto', phone: '+264811110004', principalCents: 500_000, startsIn: -90 }); // long past grace
}

const fromLukas = (text: string) => ({ from: OWNER, messageId: `wamid.${Math.random()}`, type: 'text' as const, text });

describe('the figures', () => {
  test('what is out is summed from the ledger, not from a stored total', () => {
    seed();
    const summary = book.summary();

    // 1,500 + 450 interest, 1,000 + 300, 5,000 + 1,500.
    assert.equal(summary.outOnLoanCents, 195_000 + 130_000 + 650_000);
    assert.equal(summary.activeLoans, 3);
    assert.equal(summary.activeCustomers, 3);
  });

  test('a reversed entry stops counting immediately', () => {
    const loan = openLoan({ name: 'Aina', phone: '+264811110001', principalCents: 300_000, startsIn: -10 });
    const before = book.summary().outOnLoanCents;

    const interest = store.ledger(loan.id).find((entry) => entry.entry_type === 'interest')!;
    store.reverseLedgerEntry({ entryId: interest.id, actor: lukas, reason: 'wrong rate' });

    assert.equal(before, 390_000);
    assert.equal(book.summary().outOnLoanCents, 300_000, 'the reversal is part of the sum, not a footnote');
  });

  test('interest collected counts repayments, not what was charged', () => {
    seed();
    const summary = book.summary();

    // Only the settled loan has been repaid: 3,000 at 30%.
    assert.equal(summary.interestAllTimeCents, 90_000);
    assert.equal(summary.interestThisMonthCents, 0, 'it was collected months ago');
  });

  test('this month means this month', () => {
    openLoan({ name: 'Recent', phone: '+264811110009', principalCents: 100_000, startsIn: -31, paid: true });
    assert.equal(book.summary().interestThisMonthCents, 30_000);
  });
});

describe('what needs chasing', () => {
  test('due looks a week ahead, soonest first', () => {
    seed();
    const due = book.due();

    assert.equal(due.length, 1);
    assert.equal(due[0]!.customer!.name, 'Bernhard Katiti');
    assert.equal(due[0]!.loan.due_date, addDays(TODAY, 3));
  });

  test('past grace is separated from still in grace', () => {
    seed();

    assert.deepEqual(book.overdue().map((line) => line.customer!.name), ['Daniel Amukoto']);
    assert.deepEqual(book.inGrace().map((line) => line.customer!.name), ['Chrizelle Nangolo']);
    assert.equal(book.overdue()[0]!.daysPastGrace, 56);
  });

  test('the reply prompts the margin check rather than pretending to have done it', async () => {
    seed();
    await router.handle(fromLukas('OVERDUE'));

    const reply = transport.to(OWNER).at(-1)!;
    assert.match(reply, /Past grace — 1/);
    assert.match(reply, /In grace — 1/);
    // The check needs the item's assessed value against today's market value —
    // figures the imported book never held.
    assert.match(reply, /run the margin check/i);
    assert.match(reply, /section 8/i);
  });

  test('a quiet book says so instead of showing an empty list', async () => {
    await router.handle(fromLukas('DUE'));
    assert.match(transport.to(OWNER).at(-1)!, /Nothing falls due/);

    await router.handle(fromLukas('OVERDUE'));
    assert.match(transport.to(OWNER).at(-1)!, /Nothing is past its due date/);
  });
});

describe('one customer', () => {
  test('their history comes back when the match is unambiguous', async () => {
    seed();
    openLoan({ name: 'Daniel Amukoto', phone: '+264811110004', principalCents: 200_000, startsIn: -400, paid: true });

    await router.handle(fromLukas('CUSTOMER Daniel'));
    const reply = transport.to(OWNER).at(-1)!;

    assert.match(reply, /Daniel Amukoto/);
    assert.match(reply, /Times borrowed: 2/);
    assert.match(reply, /Ever issued: N\$7,000\.00/);
    assert.match(reply, /past grace right now/);
  });

  test('a phone number finds them too', async () => {
    seed();
    await router.handle(fromLukas('CUSTOMER 081 111 0002'));
    assert.match(transport.to(OWNER).at(-1)!, /Bernhard Katiti/);
  });

  test('several matches are listed rather than guessed between', async () => {
    openLoan({ name: 'Maria Shikongo', phone: '+264811110005', principalCents: 100_000, startsIn: -5 });
    openLoan({ name: 'Maria Nangolo', phone: '+264811110006', principalCents: 100_000, startsIn: -5 });

    await router.handle(fromLukas('CUSTOMER Maria'));
    const reply = transport.to(OWNER).at(-1)!;

    assert.match(reply, /2 people match/);
    assert.match(reply, /Maria Shikongo/);
    assert.match(reply, /Maria Nangolo/);
    assert.doesNotMatch(reply, /Times borrowed/, 'no history is shown until he says which one');
  });

  test('someone imported without a number is not shown a fake one', async () => {
    const customer = store.upsertCustomer('workbook:CUST0068', 'Landuleni');
    const item = store.createItem({ customerId: customer.id, categorySlug: 'unrecorded' });
    store.createLoan({
      customerId: customer.id, itemId: item.id, principalCents: 300_000, ratePct: 30, rateRule: 'workbook:LN0001',
      termDays: 30, interestCents: 90_000, startDate: '2025-02-13', dueDate: '2025-03-15', graceEndsDate: '2025-03-19',
      status: 'paid', actor: lukas,
    });

    await router.handle(fromLukas('CUSTOMER Landuleni'));
    const reply = transport.to(OWNER).at(-1)!;

    assert.match(reply, /No phone number — imported from the workbook/);
    assert.doesNotMatch(reply, /\+264/);
  });

  test('nobody matching says so', async () => {
    seed();
    await router.handle(fromLukas('CUSTOMER Zebedee'));
    assert.match(transport.to(OWNER).at(-1)!, /Nobody matching "Zebedee"/);
  });
});

describe('reading the book cannot change it', () => {
  test('no command moves money, decides anything, or writes a row', async () => {
    seed();
    const item = store.createItem({ customerId: store.customers()[0]!.id, categorySlug: 'phones', description: 'pending item' });
    store.createApproval({ itemId: item.id, valuationId: null, conversationId: null, suggestedLoanCents: 100_000 });

    const snapshot = () => ({
      entries: store.db.prepare('SELECT COUNT(*) n FROM ledger_entries').get()!['n'],
      balance: store.db.prepare('SELECT COALESCE(SUM(amount_cents), 0) t FROM ledger_entries').get()!['t'],
      loans: store.db.prepare('SELECT COUNT(*) n, SUM(principal_cents) p FROM loans').get()!['p'],
      approvals: store.db.prepare("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").get()!['n'],
      customers: store.db.prepare('SELECT COUNT(*) n FROM customers').get()!['n'],
      items: store.db.prepare('SELECT COUNT(*) n FROM items').get()!['n'],
    });

    const before = snapshot();
    for (const command of ['BOOK', 'DUE', 'OVERDUE', 'CUSTOMER Daniel', 'CUSTOMER Maria', 'book', 'summary', 'late']) {
      await router.handle(fromLukas(command));
    }

    assert.deepEqual(snapshot(), before, 'looking at the book left it exactly as it was');
    assert.equal(store.pendingApprovals().length, 1, 'the pending application is still pending');
  });
});

describe('telling a query apart from a decision', () => {
  test('the book words are recognised, and nothing else is', () => {
    assert.deepEqual(parseBookCommand('BOOK'), { kind: 'summary' });
    assert.deepEqual(parseBookCommand('  due  '), { kind: 'due' });
    assert.deepEqual(parseBookCommand('Overdue!'), { kind: 'overdue' });
    assert.deepEqual(parseBookCommand('customer 0811110002'), { kind: 'customer', query: '0811110002' });

    assert.equal(parseBookCommand('APPROVE A1B2 3000'), null);
    assert.equal(parseBookCommand('DECLINE A1B2 too worn'), null);
    assert.equal(parseBookCommand('SAME'), null);
    assert.equal(parseBookCommand('3000'), null, 'a bare amount is never a query');
    assert.equal(parseBookCommand('booking a viewing'), null, 'it has to be the whole message');
  });

  test('an approval still approves, with the book commands in the way', async () => {
    const item = store.createItem({ customerId: store.upsertCustomer('+264811119999', 'Test').id, categorySlug: 'phones' });
    const approval = store.createApproval({ itemId: item.id, valuationId: null, conversationId: null, suggestedLoanCents: 100_000 });
    const { referenceFor } = await import('../src/approval/index.ts');

    await router.handle(fromLukas(`APPROVE ${referenceFor(approval.id)} 1200`));

    assert.equal(store.approval(approval.id)!.status, 'approved');
    assert.equal(store.approval(approval.id)!.approved_loan_cents, 120_000);
  });

  test('a customer sending BOOK gets the intake, never the book', async () => {
    seed();
    await router.handle({ from: '+264819998888', messageId: 'wamid.x', type: 'text', text: 'BOOK' });

    const reply = transport.to('+264819998888').at(-1)!;
    assert.doesNotMatch(reply, /Out on loan/, 'a customer can never see the book');
    assert.doesNotMatch(reply, /N\$/, 'and is never shown a figure');
    assert.equal(transport.to(OWNER).length, 0);
  });
});

describe('the summary message itself', () => {
  test('reads as a dashboard and points at the other commands', async () => {
    seed();
    await router.handle(fromLukas('BOOK'));
    const reply = transport.to(OWNER).at(-1)!;

    assert.match(reply, /Out on loan: \*N\$9,750\.00\*/);
    assert.match(reply, /Active loans: 3 \(3 customers\)/);
    assert.match(reply, /Past grace: 1/);
    assert.match(reply, /Interest collected all time: N\$900\.00/);
    assert.match(reply, /Send \*DUE\*, \*OVERDUE\*, or \*CUSTOMER/);
  });

  test('help lists the book commands alongside the decisions', async () => {
    await router.handle(fromLukas('what can you do'));
    const reply = transport.to(OWNER).at(-1)!;

    assert.match(reply, /APPROVE <ref>/);
    assert.match(reply, /\*BOOK\*/);
    assert.match(reply, /\*CUSTOMER <name or number>\*/);
  });
});

/**
 * Lukas lifted the staff restriction on the totals on 21 October 2026. The
 * capability was only half the story: before this, a member of staff texting
 * *BOOK* fell through to the customer intake flow and the agent started
 * taking a pawn application from the hire.
 */
describe('the hire reading the book', () => {
  const STAFF = '+264811112222';
  const fromStaff = (text: string) => ({ from: STAFF, messageId: `wamid.${Math.random()}`, type: 'text' as const, text });

  beforeEach(() => {
    store.ensureUser({ name: 'Petrus Haufiku', phone: STAFF, role: 'inspector' });
  });

  test('is not mistaken for a customer', async () => {
    await router.handle(fromStaff('BOOK'));
    const reply = transport.to(STAFF).at(-1)!;

    assert.doesNotMatch(reply, /Which one do you have/i, 'the agent started an application from the hire');
    assert.match(reply, /The book/);
  });

  test('sees the same totals Lukas sees', async () => {
    seed();
    await router.handle(fromStaff('BOOK'));
    await router.handle(fromLukas('BOOK'));

    assert.equal(transport.to(STAFF).at(-1), transport.to(OWNER).at(-1));
    assert.match(transport.to(STAFF).at(-1)!, /Out on loan: \*N\$9,750\.00\*/);
  });

  test('sees who is overdue, and what they owe', async () => {
    seed();
    await router.handle(fromStaff('OVERDUE'));
    const reply = transport.to(STAFF).at(-1)!;

    assert.match(reply, /N\$\d/, 'the amounts are not hidden any more');
    assert.match(reply, /grace|Past grace|overdue/i);
  });

  test('can look a customer up', async () => {
    seed();
    await router.handle(fromStaff('CUSTOMER Aina'));
    assert.doesNotMatch(transport.to(STAFF).at(-1)!, /Which one do you have/i);
  });

  test('still cannot approve from their own phone', async () => {
    seed();
    await router.handle(fromStaff('APPROVE'));
    const reply = transport.to(STAFF).at(-1)!;

    assert.match(reply, /Pricing and approvals are Lukas/i);
    assert.doesNotMatch(reply, /approved/i);
  });

  test('an unrecognised message gets the list of what they can ask', async () => {
    await router.handle(fromStaff('morning'));
    const reply = transport.to(STAFF).at(-1)!;

    assert.match(reply, /Petrus/, 'greeted by name, not asked who they are');
    assert.match(reply, /\*BOOK\*/);
    assert.match(reply, /\*OVERDUE\*/);
  });

  test('a customer is still a customer', async () => {
    await router.handle({ from: '+264811234567', messageId: 'wamid.c1', type: 'text', text: 'hi' });
    assert.match(transport.to('+264811234567').at(-1)!, /what is your name/i);
  });
});
