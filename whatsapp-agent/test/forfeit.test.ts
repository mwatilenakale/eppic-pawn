/**
 * Sending an item to market — playbook section 8.
 *
 * Grace runs out after four days and from then on the item *may* be sold.
 * Whether it is, is Lukas's decision on that item: the playbook is explicit
 * that nothing is ever sold automatically, so the property worth protecting
 * hardest here is that no amount of time passing forfeits anything.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/playbook/index.ts';
import { Store, type Loan, type User } from '../src/store/index.ts';
import { AgentRouter } from '../src/router.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { Book } from '../src/book/index.ts';
import { Forfeiture, marginFor, parseForfeitCommand } from '../src/book/forfeit.ts';
import { referenceFor } from '../src/reference.ts';

const rules = loadRules();
const OWNER = '+264811110000';
const STAFF = '+264811112222';
const TODAY = '2026-10-21';

let store: Store;
let transport: MemoryTransport;
let router: AgentRouter;
let book: Book;
let lukas: User;
let staff: User;
let counter = 0;

const clock = () => new Date(`${TODAY}T09:00:00Z`);

beforeEach(() => {
  store = new Store(':memory:');
  transport = new MemoryTransport();
  router = new AgentRouter({ store, rules, transport, ownerPhone: OWNER, clock });
  book = new Book(store, { clock });
  lukas = store.owner()!;
  staff = store.ensureUser({ name: 'Petrus Haufiku', phone: STAFF, role: 'inspector' });
});

afterEach(() => store.close());

/**
 * A loan that has gone quiet. `assessedCents` picks which branch of the
 * section 8 margin check applies.
 */
function pawn(opts: { name: string; phone: string; assessedCents: number; startDate: string }): Loan {
  const customer = store.upsertCustomer(opts.phone, opts.name);
  const item = store.createItem({
    customerId: customer.id,
    categorySlug: 'phones',
    variant: 'iphone',
    description: 'iPhone 15, 128GB',
  });
  store.saveValuation({
    itemId: item.id,
    estimates: [{ source: 'Marketplace', amountCents: Math.round(opts.assessedCents / 0.75) }],
    assessedValueCents: opts.assessedCents,
    suggestedLoanCents: 337_500,
    formula: 'lowest x 0.75 / 2',
    workings: [],
  });

  const day = (from: string, days: number) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const due = day(opts.startDate, 30);
  const loan = store.createLoan({
    customerId: customer.id, itemId: item.id, principalCents: 337_500,
    ratePct: 29, rateRule: 'standard', termDays: 30, interestCents: 97_875,
    startDate: opts.startDate, dueDate: due, graceEndsDate: day(due, 4),
    actor: lukas.id, at: `${opts.startDate}T00:00:00.000Z`,
  });
  store.postLedgerEntry({ loanId: loan.id, entryType: 'principal', amountCents: 337_500, actor: lukas.id, at: `${opts.startDate}T00:00:00.000Z` });
  store.postLedgerEntry({ loanId: loan.id, entryType: 'interest', amountCents: 97_875, actor: lukas.id, at: `${opts.startDate}T00:00:01.000Z` });
  store.updateItem(item.id, { status: 'pledged' });
  return loan;
}

/** Margin gone — section 8 says sell. */
const pastGrace = () => pawn({ name: 'Aina Shipanga', phone: '+264811000051', assessedCents: 460_000, startDate: '2026-08-20' });
/** Plenty of margin — section 8 says extend. */
const worthKeeping = () => pawn({ name: 'Petrus Nangolo', phone: '+264811000052', assessedCents: 750_000, startDate: '2026-08-20' });
/** Still inside its term. */
const current = () => pawn({ name: 'Maria Kandjou', phone: '+264811000053', assessedCents: 460_000, startDate: '2026-10-10' });

const say = (from: string, text: string) =>
  router.handle({ from, messageId: `m${++counter}`, type: 'text', text });

describe('nothing is ever sold automatically', () => {
  test('a loan months past grace is still just past grace', () => {
    const loan = pawn({ name: 'Long Gone', phone: '+264811000060', assessedCents: 460_000, startDate: '2026-01-05' });

    // Nine months of silence. The status is unchanged, because no clock in
    // this system forfeits anything.
    assert.equal(store.loan(loan.id)!.status, 'active');
    assert.equal(store.item(store.loan(loan.id)!.item_id)!.status, 'pledged');
    assert.deepEqual(store.forfeitedLoans(), []);
  });

  test('only Lukas can send one to market', () => {
    pastGrace();
    const forfeiture = new Forfeiture(store, rules, book);

    const result = forfeiture.run({ action: 'sell', reference: null, note: '' }, staff);
    assert.match(result.ownerMessage, /Only Lukas/);
    assert.deepEqual(store.forfeitedLoans(), [], 'nothing moved');
  });

  test('a loan inside its term cannot be sold at all', async () => {
    const loan = current();
    await say(OWNER, `SELL ${referenceFor(loan.id)}`);

    assert.match(transport.to(OWNER).at(-1)!, /Nothing is past grace/);
    assert.equal(store.loan(loan.id)!.status, 'active');
  });
});

describe('the margin check (section 8 step 3)', () => {
  test('margin gone says sell', () => {
    const loan = pastGrace();
    const margin = marginFor(store, rules, book.lineFor(store.loan(loan.id)!));

    assert.equal(margin.playbookSays, 'sell');
    assert.ok(margin.marginPct! < margin.thresholdPct);
  });

  test('margin left says extend', () => {
    const loan = worthKeeping();
    const margin = marginFor(store, rules, book.lineFor(store.loan(loan.id)!));

    assert.equal(margin.playbookSays, 'extend');
    assert.ok(margin.marginPct! >= margin.thresholdPct);
  });

  test('the threshold comes from the playbook, not from here', () => {
    const loan = pastGrace();
    const margin = marginFor(store, rules, book.lineFor(store.loan(loan.id)!));
    assert.equal(margin.thresholdPct, rules.playbook.collections.marginThresholdPct);
  });

  test('no valuation says so rather than guessing', () => {
    const customer = store.upsertCustomer('+264811000070', 'No Valuation');
    const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', description: 'iPhone' });
    const loan = store.createLoan({
      customerId: customer.id, itemId: item.id, principalCents: 100_000,
      ratePct: 29, rateRule: 'standard', termDays: 30, interestCents: 29_000,
      startDate: '2026-08-20', dueDate: '2026-09-19', graceEndsDate: '2026-09-23', actor: lukas.id,
    });

    const margin = marginFor(store, rules, book.lineFor(store.loan(loan.id)!));
    assert.equal(margin.playbookSays, 'unknown');
    assert.equal(margin.assessedValueCents, null);
  });
});

describe('SELL', () => {
  test('marks the item for market and tells the customer they can still redeem', async () => {
    const loan = pastGrace();
    await say(OWNER, `SELL ${referenceFor(loan.id)}`);

    assert.equal(store.loan(loan.id)!.status, 'forfeited');
    assert.equal(store.item(loan.item_id)!.status, 'for-sale');

    const told = transport.to('+264811000051').at(-1)!;
    assert.match(told, /past the grace period/i);
    assert.match(told, /still collect it/i, 'the contract says they may redeem until it is sold');
  });

  test('the margin and its limitation are stated to him', async () => {
    const loan = pastGrace();
    await say(OWNER, `SELL ${referenceFor(loan.id)}`);

    const sent = transport.to(OWNER).at(-1)!;
    assert.match(sent, /section 8 says sell/i);
    assert.match(sent, /not a fresh market price/i, 'it must not pretend to know today’s value');
  });

  test('where the playbook disagrees, that leads', async () => {
    const loan = worthKeeping();
    await say(OWNER, `SELL ${referenceFor(loan.id)}`);

    // His call either way — the arithmetic is guidance, not a veto — but he
    // should read the disagreement first, not under a confirmation.
    const sent = transport.to(OWNER).at(-1)!;
    assert.match(sent.split('\n')[0]!, /says extend, not sell/i);
    assert.equal(store.loan(loan.id)!.status, 'forfeited', 'and it still does what he said');
  });

  test('with two past grace it asks which, rather than picking one', async () => {
    pastGrace();
    worthKeeping();
    await say(OWNER, 'SELL');

    assert.match(transport.to(OWNER).at(-1)!, /2 are past grace/);
    assert.deepEqual(store.forfeitedLoans(), [], 'neither was guessed at');
  });

  test('with one past grace, no reference is needed', async () => {
    const loan = pastGrace();
    await say(OWNER, 'SELL');
    assert.equal(store.loan(loan.id)!.status, 'forfeited');
  });

  test('it writes nothing to the ledger — what is owed stays owed', async () => {
    const loan = pastGrace();
    const before = store.ledger(loan.id).length;

    await say(OWNER, `SELL ${referenceFor(loan.id)}`);

    assert.equal(store.ledger(loan.id).length, before, 'the money settles when it actually sells');
  });

  test('and records the margin it was decided against', async () => {
    const loan = pastGrace();
    await say(OWNER, `SELL ${referenceFor(loan.id)}`);

    const trail = store.auditTrail('loan', loan.id);
    const forfeited = trail.find((entry) => entry.action === 'loan.forfeited')!;
    assert.ok(forfeited, 'audited');
    assert.equal(forfeited.actor, lukas.id);
    assert.match(JSON.stringify(forfeited), /marginPct/, 'the reasoning is on the record, not only in his head');
  });
});

describe('KEEP', () => {
  test('puts it back, because marking for market is not selling', async () => {
    const loan = pastGrace();
    await say(OWNER, `SELL ${referenceFor(loan.id)}`);
    await say(OWNER, `KEEP ${referenceFor(loan.id)}`);

    assert.equal(store.loan(loan.id)!.status, 'active');
    assert.equal(store.item(loan.item_id)!.status, 'pledged');
    assert.deepEqual(
      store.auditTrail('loan', loan.id).map((entry) => entry.action),
      ['loan.created', 'loan.forfeited', 'loan.unforfeited'],
      'both decisions stay on the record',
    );
  });

  test('nothing on the market list says so', async () => {
    pastGrace();
    await say(OWNER, 'KEEP');
    assert.match(transport.to(OWNER).at(-1)!, /Nothing is past grace/);
  });
});

describe('the commands', () => {
  test('read the way he would type them', () => {
    assert.deepEqual(parseForfeitCommand('SELL K3P9'), { action: 'sell', reference: 'K3P9', note: '' });
    assert.deepEqual(parseForfeitCommand('sell k3p9 margin gone'), { action: 'sell', reference: 'K3P9', note: 'margin gone' });
    assert.deepEqual(parseForfeitCommand('KEEP K3P9'), { action: 'keep', reference: 'K3P9', note: '' });
    assert.deepEqual(parseForfeitCommand('SELL'), { action: 'sell', reference: null, note: '' });
  });

  test('are not confusable with deciding an application', () => {
    // SELL decides about an item already pawned; APPROVE decides a new
    // application. Crossing those would be the worst bug in this file.
    assert.equal(parseForfeitCommand('APPROVE K3P9'), null);
    assert.equal(parseForfeitCommand('DECLINE K3P9'), null);
    assert.equal(parseForfeitCommand('ACCEPT K3P9'), null);
    assert.equal(parseForfeitCommand('BOOK'), null);
    assert.equal(parseForfeitCommand('OVERDUE'), null);
  });

  test('OVERDUE gives him the references SELL needs', async () => {
    const loan = pastGrace();
    await say(OWNER, 'OVERDUE');

    const sent = transport.to(OWNER).at(-1)!;
    assert.match(sent, new RegExp(referenceFor(loan.id)));
    assert.match(sent, /SELL <ref>/);
  });
});
