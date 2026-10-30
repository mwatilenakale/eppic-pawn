import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerError, MediaStore, Store, generateMediaKey, mediaKeyFromEnv, MediaKeyError } from '../src/store/index.ts';

let store: Store;
let mediaDirectory: string;
const key = Buffer.from(generateMediaKey(), 'hex');

beforeEach(() => {
  mediaDirectory = mkdtempSync(join(tmpdir(), 'eppic-media-'));
  store = new Store(':memory:', { mediaDirectory, mediaKey: key });
});

afterEach(() => {
  store.close();
});

function loanFixture() {
  const customer = store.upsertCustomer('+264811234567', 'Test Customer');
  const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', variant: 'iphone' });
  const loan = store.createLoan({
    customerId: customer.id,
    itemId: item.id,
    principalCents: 375_000,
    ratePct: 29,
    rateRule: 'standard',
    termDays: 30,
    interestCents: 108_750,
    startDate: '2026-01-15',
    dueDate: '2026-02-14',
    graceEndsDate: '2026-02-18',
    actor: 'lukas',
  });
  return { customer, item, loan };
}

describe('schema & migrations', () => {
  test('migrations are idempotent across reopens', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'eppic-db-')), 'eppic.db');
    const first = new Store(file, { mediaDirectory, mediaKey: key });
    first.upsertCustomer('+264810000001', 'Reopen Test');
    first.close();

    const second = new Store(file, { mediaDirectory, mediaKey: key });
    assert.equal(second.customerByPhone('+264810000001')?.name, 'Reopen Test');
    second.close();
  });

  test('only the two real roles exist', () => {
    store.ensureUser({ name: 'Lukas', phone: '+264815550100', role: 'owner' });
    store.ensureUser({ name: 'Inspector', phone: '+264810000002', role: 'inspector' });
    assert.equal(store.owner()?.name, 'Lukas');
    assert.throws(() =>
      store.ensureUser({ name: 'Someone', phone: '+264810000003', role: 'senior-officer' as 'owner' }),
    );
  });
});

describe('customers & conversations', () => {
  test('a customer is keyed on their WhatsApp number', () => {
    const first = store.upsertCustomer('+264811111111');
    const again = store.upsertCustomer('+264811111111', 'Given Later');
    assert.equal(again.id, first.id);
    assert.equal(again.name, 'Given Later');
  });

  test('conversation state survives a round trip', () => {
    const customer = store.upsertCustomer('+264812222222');
    const conversation = store.openConversation(customer.id, { step: 'category' });
    store.saveConversationState(conversation.id, { step: 'checklist', index: 3 });

    const reloaded = store.activeConversation(customer.id);
    assert.deepEqual(JSON.parse(reloaded!.state), { step: 'checklist', index: 3 });
  });

  test('a redelivered WhatsApp message is ignored the second time', () => {
    const customer = store.upsertCustomer('+264813333333');
    const conversation = store.openConversation(customer.id);

    assert.ok(store.recordInbound({ conversationId: conversation.id, providerMessageId: 'wamid.ABC', body: 'hello' }));
    assert.equal(store.recordInbound({ conversationId: conversation.id, providerMessageId: 'wamid.ABC', body: 'hello' }), null);
    assert.equal(store.messages(conversation.id).length, 1);
  });
});

describe('encrypted media', () => {
  test('photos are unreadable on disk and come back intact', () => {
    const customer = store.upsertCustomer('+264814444444');
    const item = store.createItem({ customerId: customer.id, categorySlug: 'phones' });
    const content = Buffer.from('pretend this is a photo of an ID document');

    const photo = store.addPhoto({ itemId: item.id, kind: 'id', content });
    const onDisk = readFileSync(photo.path);
    assert.ok(!onDisk.includes('ID document'), 'plaintext must not be on disk');
    assert.deepEqual(store.media!.get(photo.path), content);
    assert.equal(store.photos(item.id)[0]?.kind, 'id');
  });

  test('a tampered file fails to decrypt rather than returning garbage', () => {
    const media = new MediaStore(mediaDirectory, key);
    const stored = media.put(Buffer.from('sensitive'));
    const blob = readFileSync(stored.path);
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    writeFileSync(stored.path, blob);
    assert.throws(() => media.get(stored.path));
  });

  test('a missing or malformed key is refused, never silently plaintext', () => {
    assert.throws(() => mediaKeyFromEnv({}), MediaKeyError);
    assert.throws(() => mediaKeyFromEnv({ EPPIC_MEDIA_KEY: 'too-short' }), MediaKeyError);
    assert.equal(mediaKeyFromEnv({ EPPIC_MEDIA_KEY: generateMediaKey() }).length, 32);
  });
});

describe('ledger', () => {
  test('fractional, non-finite and unsafe cents never enter the ledger', () => {
    const { loan } = loanFixture();
    for (const amountCents of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => store.postLedgerEntry({ loanId: loan.id, entryType: 'principal', amountCents, actor: 'lukas' }), LedgerError);
    }
    assert.equal(store.balance(loan.id), 0);
    assert.deepEqual(store.ledger(loan.id), []);
  });

  test('entries cannot be edited or deleted, only reversed', () => {
    const { loan } = loanFixture();
    const entry = store.postLedgerEntry({ loanId: loan.id, entryType: 'principal', amountCents: 375_000, actor: 'lukas' });

    assert.throws(
      () => store.db.prepare('UPDATE ledger_entries SET amount_cents = 1 WHERE id = ?').run(entry.id),
      /immutable/,
    );
    assert.throws(() => store.db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(entry.id), /cannot be deleted/);
  });

  test('a correction is a reversing entry — both stay visible', () => {
    const { loan } = loanFixture();
    const wrong = store.postLedgerEntry({ loanId: loan.id, entryType: 'repayment', amountCents: -500_000, memo: 'typo', actor: 'lukas' });
    assert.equal(store.balance(loan.id), -500_000);

    store.reverseLedgerEntry({ entryId: wrong.id, actor: 'lukas', reason: 'captured N$5,000 instead of N$500' });
    store.postLedgerEntry({ loanId: loan.id, entryType: 'repayment', amountCents: -50_000, memo: 'corrected', actor: 'lukas' });

    assert.equal(store.balance(loan.id), -50_000);
    const entries = store.ledger(loan.id);
    assert.equal(entries.length, 3, 'the mistake, its reversal and the correction are all kept');
    assert.equal(entries[1]?.reverses_entry_id, wrong.id);
    assert.equal(entries[1]?.amount_cents, 500_000);
  });

  test('an entry can only be reversed once, and a reversal cannot be reversed', () => {
    const { loan } = loanFixture();
    const entry = store.postLedgerEntry({ loanId: loan.id, entryType: 'fee', amountCents: 5_000, actor: 'lukas' });
    const reversal = store.reverseLedgerEntry({ entryId: entry.id, actor: 'lukas', reason: 'not charged' });

    assert.throws(() => store.reverseLedgerEntry({ entryId: entry.id, actor: 'lukas', reason: 'again' }), LedgerError);
    assert.throws(() => store.reverseLedgerEntry({ entryId: reversal.id, actor: 'lukas', reason: 'undo the undo' }), LedgerError);
  });

  test('every ledger movement is in the audit log with who did it', () => {
    const { loan } = loanFixture();
    const entry = store.postLedgerEntry({ loanId: loan.id, entryType: 'principal', amountCents: 375_000, actor: 'lukas' });
    store.reverseLedgerEntry({ entryId: entry.id, actor: 'lukas', reason: 'wrong loan' });

    const actions = store.auditTrail('ledger_entry', entry.id).map((row) => row.action);
    assert.deepEqual(actions, ['ledger.posted', 'ledger.reversed']);
    assert.equal(store.auditTrail('loan', loan.id)[0]?.actor, 'lukas');
  });
});

describe('approvals', () => {
  test('an approval starts pending and records who decided it', () => {
    const { item } = loanFixture();
    const lukas = store.ensureUser({ name: 'Lukas', phone: '+264815550100', role: 'owner' });
    const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: 375_000 });
    assert.equal(approval.status, 'pending');
    assert.equal(store.pendingApprovals().length, 1);

    const decided = store.decideApproval({
      approvalId: approval.id,
      status: 'approved',
      approvedLoanCents: 350_000,
      decidedBy: lukas.id,
      note: 'screen has a scratch',
    });
    assert.equal(decided.status, 'approved');
    assert.equal(decided.approved_loan_cents, 350_000);
    assert.equal(decided.decided_by, lukas.id);
    assert.equal(store.pendingApprovals().length, 0);
  });

  test('a decision cannot be made twice', () => {
    const { item } = loanFixture();
    const lukas = store.ensureUser({ name: 'Lukas', phone: '+264815550100', role: 'owner' });
    const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: 375_000 });
    store.decideApproval({ approvalId: approval.id, status: 'declined', decidedBy: lukas.id });
    assert.throws(
      () => store.decideApproval({ approvalId: approval.id, status: 'approved', decidedBy: lukas.id }),
      /already declined/,
    );
  });

  test('an override keeps the engine number alongside Lukas’s', () => {
    const { item } = loanFixture();
    const valuation = store.saveValuation({
      itemId: item.id,
      estimates: [{ source: 'Marketplace', amountCents: 1_000_000 }],
      assessedValueCents: 750_000,
      suggestedLoanCents: 375_000,
      formula: 'lowest market estimate x 0.75 / 2',
      workings: [],
    });
    store.recordValuationOverride(valuation.id, 300_000, 'battery health 78%', 'lukas');

    const row = store.db.prepare('SELECT * FROM valuations WHERE id = ?').get(valuation.id) as {
      suggested_loan_cents: number;
      override_cents: number;
    };
    assert.equal(row.suggested_loan_cents, 375_000, 'engine output is not overwritten');
    assert.equal(row.override_cents, 300_000);
  });
});
