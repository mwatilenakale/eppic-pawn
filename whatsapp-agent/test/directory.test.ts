import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, generateMediaKey, type User } from '../src/store/index.ts';
import { CustomerDirectory, parseDuplicateReply } from '../src/customers/directory.ts';

let store: Store;
let directory: CustomerDirectory;
let lukas: User;

beforeEach(() => {
  // Records made seconds apart, as they would be in real life — the rule is
  // that the older one survives a merge, so the clock has to move.
  let tick = 0;
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-dedupe-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
    clock: () => new Date(Date.UTC(2026, 0, 15, 9, 0, tick++)),
  });
  directory = new CustomerDirectory(store);
  lukas = store.ensureUser({ name: 'Lukas', phone: '+264812823046', role: 'owner' });
});

afterEach(() => store.close());

describe('spotting a possible duplicate', () => {
  test('the same person on a second phone number is flagged, not merged', () => {
    const first = store.upsertCustomer('+264811111111', 'Johannes Shikongo');
    store.updateCustomerIdentity(first.id, { idNumber: '90010100123' }, lukas.id);

    const second = store.upsertCustomer('+264812222222');
    const result = directory.recordIdentity(second.id, { name: 'J. Shikongo', idNumber: '90 01 01 00123' }, lukas.id);

    assert.equal(result.raised.length, 1);
    assert.equal(result.raised[0]?.score, 1);
    assert.deepEqual(result.raised[0]?.reasons, ['same ID number']);

    // Flagged only — neither record has moved.
    assert.equal(store.customer(first.id)?.merged_into ?? null, null);
    assert.equal(store.customer(second.id)?.merged_into ?? null, null);
    assert.equal(store.pendingDuplicateFlags().length, 1);
  });

  test('the message tells Lukas both records and why they matched', () => {
    const first = store.upsertCustomer('+264811111111', 'Johannes Shikongo');
    store.updateCustomerIdentity(first.id, { idNumber: '90010100123' }, lukas.id);
    const second = store.upsertCustomer('+264812222222');

    const { ownerMessage, raised } = directory.recordIdentity(
      second.id,
      { name: 'Johannes Shikongo', idNumber: '90010100123' },
      lukas.id,
    );

    assert.match(ownerMessage!, /Possible duplicate customer/);
    assert.match(ownerMessage!, /\+264811111111/);
    assert.match(ownerMessage!, /\+264812222222/);
    assert.match(ownerMessage!, /same ID number/);
    assert.match(ownerMessage!, new RegExp(`SAME <ref>`));
    assert.match(ownerMessage!, /Nothing is merged until you say so/);
    assert.match(ownerMessage!, new RegExp(raised[0]!.reference));
  });

  test('two people with different ID numbers are never flagged, however alike the names', () => {
    const first = store.upsertCustomer('+264811111111', 'Johannes Shikongo');
    store.updateCustomerIdentity(first.id, { idNumber: '90010100123' }, lukas.id);

    const second = store.upsertCustomer('+264812222222');
    const result = directory.recordIdentity(second.id, { name: 'Johannes Shikongo', idNumber: '85030200456' }, lukas.id);

    assert.deepEqual(result.raised, []);
    assert.equal(result.ownerMessage, null);
    assert.equal(store.pendingDuplicateFlags().length, 0);
  });

  test('a lone new customer raises nothing', () => {
    const only = store.upsertCustomer('+264813333333');
    const result = directory.recordIdentity(only.id, { name: 'Maria Nangolo', idNumber: '95040500789' }, lukas.id);
    assert.deepEqual(result.raised, []);
    assert.equal(result.ownerMessage, null);
  });

  test('the same pair is only ever raised once', () => {
    const first = store.upsertCustomer('+264811111111', 'Johannes Shikongo');
    store.updateCustomerIdentity(first.id, { idNumber: '90010100123' }, lukas.id);
    const second = store.upsertCustomer('+264812222222');

    directory.recordIdentity(second.id, { name: 'Johannes Shikongo', idNumber: '90010100123' }, lukas.id);
    const again = directory.recordIdentity(second.id, { name: 'Johannes Shikongo', idNumber: '90010100123' }, lukas.id);

    assert.deepEqual(again.raised, []);
    assert.equal(store.pendingDuplicateFlags().length, 1);
  });

  test('flagging is in the audit log', () => {
    const first = store.upsertCustomer('+264811111111', 'Johannes Shikongo');
    store.updateCustomerIdentity(first.id, { idNumber: '90010100123' }, lukas.id);
    const second = store.upsertCustomer('+264812222222');
    directory.recordIdentity(second.id, { name: 'Johannes Shikongo', idNumber: '90010100123' }, lukas.id);

    const trail = store.auditTrail('customer', [first.id, second.id].sort()[0]!).map((row) => row.action);
    assert.ok(trail.includes('duplicate.flagged'));
  });
});

describe('Lukas rules on a pair', () => {
  function flaggedPair() {
    const first = store.upsertCustomer('+264811111111', 'Johannes Shikongo');
    store.updateCustomerIdentity(first.id, { idNumber: '90010100123' }, lukas.id);
    const second = store.upsertCustomer('+264812222222');
    const { raised } = directory.recordIdentity(second.id, { name: 'J Shikongo', idNumber: '90010100123' }, lukas.id);
    return { first, second, reference: raised[0]!.reference };
  }

  test('"same" links the newer record to the older one, keeping both', () => {
    const { first, second, reference } = flaggedPair();
    const result = directory.resolve(reference, 'same', lukas);

    assert.equal(result.survivorId, first.id, 'the older record carries the loan history');
    assert.equal(store.customer(second.id)?.merged_into, first.id);
    assert.ok(store.customer(second.id), 'the duplicate row is kept, not deleted');
    assert.equal(store.survivingCustomer(second.id)?.id, first.id);
    assert.match(result.ownerMessage, /Both records are kept/);
    assert.deepEqual(directory.linkedTo(first.id).map((record) => record.id), [second.id]);
  });

  test('"different" leaves both records alone and stops asking', () => {
    const { first, second, reference } = flaggedPair();
    const result = directory.resolve(reference, 'different', lukas);

    assert.equal(store.customer(second.id)?.merged_into ?? null, null);
    assert.equal(store.customer(first.id)?.merged_into ?? null, null);
    assert.match(result.ownerMessage, /different people/);
    assert.equal(store.pendingDuplicateFlags().length, 0);
  });

  test('a pair cannot be ruled on twice, and an unknown reference changes nothing', () => {
    const { reference } = flaggedPair();
    directory.resolve(reference, 'same', lukas);

    assert.match(directory.resolve(reference, 'different', lukas).ownerMessage, /can't find/i);
    assert.match(directory.resolve('ZZZZ', 'same', lukas).ownerMessage, /can't find/i);
  });

  test('the ruling is recorded against Lukas', () => {
    const { first, reference } = flaggedPair();
    directory.resolve(reference, 'same', lukas);

    const actions = store.auditTrail('customer', first.id).map((row) => row.action);
    assert.ok(actions.includes('duplicate.same'));
    assert.equal(store.auditTrail('customer', first.id).find((row) => row.action === 'duplicate.same')?.actor, lukas.id);
  });

  test('a linked record is not flagged again on the next visit', () => {
    const { first, second, reference } = flaggedPair();
    const resolution = directory.resolve(reference, 'same', lukas);
    assert.equal(resolution.survivorId, first.id, 'the older record survives');

    const third = store.upsertCustomer('+264814444444');
    const result = directory.recordIdentity(third.id, { name: 'Johannes Shikongo', idNumber: '90010100123' }, lukas.id);

    const offered = result.raised.flatMap((entry) => entry.records.map((record) => record.id));
    assert.ok(offered.includes(first.id), 'the surviving record is still compared');
    assert.ok(!offered.includes(second.id), 'the record already linked is not offered again');
  });
});

describe('reading Lukas’s ruling', () => {
  test('understands the forms he would type', () => {
    assert.deepEqual(parseDuplicateReply('SAME A1B2'), { status: 'same', reference: 'A1B2' });
    assert.deepEqual(parseDuplicateReply('same a1b2'), { status: 'same', reference: 'A1B2' });
    assert.deepEqual(parseDuplicateReply('different A1B2'), { status: 'different', reference: 'A1B2' });
    assert.deepEqual(parseDuplicateReply('duplicate A1B2'), { status: 'same', reference: 'A1B2' });
  });

  test('anything else is not a ruling', () => {
    for (const text of ['approve A1B2', 'same', 'maybe A1B2', 'A1B2', '']) {
      assert.equal(parseDuplicateReply(text), null, `"${text}" must not be read as a ruling`);
    }
  });
});
