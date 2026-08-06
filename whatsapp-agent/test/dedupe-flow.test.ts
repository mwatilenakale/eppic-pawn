/**
 * The de-duplication path as it actually happens: two records for one person,
 * spotted when the second one signs a contract, ruled on by Lukas over
 * WhatsApp.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { Store, generateMediaKey, type User } from '../src/store/index.ts';
import { ContractService } from '../src/contract/index.ts';
import { CustomerDirectory } from '../src/customers/directory.ts';
import { AgentRouter } from '../src/router.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';

const rules = loadRules();
// Lukas's own phone. Deliberately not the shop's number in the playbook:
// the number registered with Meta cannot also be the one he replies from.
const OWNER = '+264811110000';
const SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let store: Store;
let contracts: ContractService;
let directory: CustomerDirectory;
let transport: MemoryTransport;
let router: AgentRouter;
let lukas: User;

beforeEach(() => {
  let tick = 0;
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-dedupe-flow-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
    clock: () => new Date(Date.UTC(2026, 0, 15, 9, 0, tick++)),
  });
  contracts = new ContractService(store, rules, { baseUrl: 'https://eppic.example' });
  directory = new CustomerDirectory(store);
  transport = new MemoryTransport();
  router = new AgentRouter({ store, rules, transport, ownerPhone: OWNER, contracts, directory });
  lukas = store.owner()!;
});

afterEach(() => store.close());

/** Takes one customer all the way to a signed contract. */
function signedLoanFor(phone: string, name: string, idNumber: string) {
  const customer = store.upsertCustomer(phone, name);
  const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', description: 'iPhone 13 Pro' });
  const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: 375_000 });
  store.decideApproval({ approvalId: approval.id, status: 'approved', approvedLoanCents: 375_000, decidedBy: lukas.id });

  const issued = contracts.issueForApproval(approval.id, { actor: lukas.id });
  return contracts.sign(issued.contract.token, { name, idNumber, signatureDataUrl: SIGNATURE });
}

describe('one person, two phone numbers', () => {
  test('the second signature raises the flag, and Lukas is asked — not told', async () => {
    const first = signedLoanFor('+264811111111', 'Johannes Shikongo', '90010100123');
    await router.announceSignature(first);
    assert.equal(store.pendingDuplicateFlags().length, 0, 'the first customer is nobody’s duplicate');

    const second = signedLoanFor('+264812222222', 'J. Shikongo', '90 01 01 00123');
    await router.announceSignature(second);

    const toLukas = transport.to(OWNER).join('\n');
    assert.match(toLukas, /Possible duplicate customer/);
    assert.match(toLukas, /same ID number/);
    assert.match(toLukas, /Reply \*SAME <ref>\*/);

    // Flagged only. Both customers, both loans, still stand on their own.
    const [flag] = store.pendingDuplicateFlags();
    assert.ok(flag);
    assert.equal(store.customers().filter((customer) => customer.merged_into).length, 0);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM loans').get() as { n: number }).n, 2);
  });

  test('Lukas replying SAME over WhatsApp links the records, keeping both', async () => {
    await router.announceSignature(signedLoanFor('+264811111111', 'Johannes Shikongo', '90010100123'));
    await router.announceSignature(signedLoanFor('+264812222222', 'J. Shikongo', '90010100123'));

    const reference = directory.pending()[0]!.reference;
    await router.handle({ from: OWNER, messageId: 'wamid.same', type: 'text', text: `SAME ${reference}` });

    assert.match(transport.to(OWNER).at(-1)!, /Linked —/);
    assert.equal(store.pendingDuplicateFlags().length, 0);

    const older = store.customerByPhone('+264811111111')!;
    const newer = store.customerByPhone('+264812222222')!;
    assert.equal(newer.merged_into, older.id, 'the newer record points at the older');
    assert.equal(store.survivingCustomer(newer.id)?.id, older.id);
    assert.ok(store.customer(newer.id), 'nothing is deleted');
  });

  test('Lukas replying DIFFERENT leaves both records untouched', async () => {
    await router.announceSignature(signedLoanFor('+264811111111', 'Johannes Shikongo', '90010100123'));
    await router.announceSignature(signedLoanFor('+264812222222', 'J. Shikongo', '90010100123'));

    const reference = directory.pending()[0]!.reference;
    await router.handle({ from: OWNER, messageId: 'wamid.diff', type: 'text', text: `DIFFERENT ${reference}` });

    assert.match(transport.to(OWNER).at(-1)!, /different people/);
    assert.equal(store.customers().filter((customer) => customer.merged_into).length, 0);
    assert.equal(store.pendingDuplicateFlags().length, 0);
  });

  test('a duplicate ruling is never mistaken for an approval', async () => {
    // An application is waiting for a decision at the same time as a flag.
    await router.announceSignature(signedLoanFor('+264811111111', 'Johannes Shikongo', '90010100123'));
    await router.announceSignature(signedLoanFor('+264812222222', 'J. Shikongo', '90010100123'));

    const waiting = store.upsertCustomer('+264813333333', 'Maria Nangolo');
    const item = store.createItem({ customerId: waiting.id, categorySlug: 'tvs', description: 'Samsung 55"' });
    const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: 200_000 });

    const reference = directory.pending()[0]!.reference;
    await router.handle({ from: OWNER, messageId: 'wamid.x', type: 'text', text: `SAME ${reference}` });

    assert.equal(store.approval(approval.id)?.status, 'pending', 'the waiting application was not touched');
    assert.deepEqual(transport.to('+264813333333'), [], 'and that customer heard nothing');
  });

  test('two namesakes with different ID numbers are never flagged', async () => {
    await router.announceSignature(signedLoanFor('+264811111111', 'Johannes Shikongo', '90010100123'));
    await router.announceSignature(signedLoanFor('+264812222222', 'Johannes Shikongo', '85030200456'));

    assert.equal(store.pendingDuplicateFlags().length, 0);
    assert.doesNotMatch(transport.to(OWNER).join('\n'), /Possible duplicate/);
  });

  test('a signature still succeeds if the duplicate check goes wrong', async () => {
    const errors: unknown[] = [];
    const broken = new AgentRouter({
      store,
      rules,
      transport,
      ownerPhone: OWNER,
      contracts,
      directory: {
        recordIdentity() {
          throw new Error('directory unavailable');
        },
      } as unknown as CustomerDirectory,
      onError: (error) => errors.push(error),
    });

    const signed = signedLoanFor('+264814444444', 'Petrus Amutenya', '88070700321');
    await broken.announceSignature(signed);

    assert.equal(errors.length, 1, 'the failure is reported');
    assert.match(transport.to('+264814444444').join('\n'), /is signed/, 'the customer was still told');
    assert.equal(store.contract(signed.contract.id)?.status, 'signed');
  });
});
