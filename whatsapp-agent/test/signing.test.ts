import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { ContractError, Store, generateMediaKey, type Approval, type User } from '../src/store/index.ts';
import { ContractService } from '../src/contract/index.ts';
import { blankDataUrl, pngDataUrl, signatureDataUrl } from './support/png-fixture.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { buildServer } from '../src/server.ts';
import { AgentRouter } from '../src/router.ts';

const rules = loadRules();
// Lukas's own phone. Deliberately not the shop's number in the playbook:
// the number registered with Meta cannot also be the one he replies from.
const OWNER = '+264811110000';
const CUSTOMER = '+264811234567';

/** A 1x1 PNG — what the signature pad produces, in miniature. */
const SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let store: Store;
let contracts: ContractService;
let lukas: User;

beforeEach(() => {
  store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-sign-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  });
  contracts = new ContractService(store, rules, { baseUrl: 'https://eppic.example' });
  lukas = store.ensureUser({ name: 'Lukas', phone: OWNER, role: 'owner' });
});

afterEach(() => store.close());

function approvedApplication(amountCents = 375_000): Approval {
  const customer = store.upsertCustomer(CUSTOMER, 'Test Customer');
  const item = store.createItem({
    customerId: customer.id,
    categorySlug: 'phones',
    variant: 'iphone',
    description: 'iPhone 13 Pro, 256GB',
  });
  const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: amountCents });
  return store.decideApproval({
    approvalId: approval.id,
    status: 'approved',
    approvedLoanCents: amountCents,
    decidedBy: lukas.id,
  });
}

const issue = () => contracts.issueForApproval(approvedApplication().id, { actor: lukas.id });
const submission = { name: 'Test Customer', idNumber: '90010100123', signatureDataUrl: SIGNATURE };

describe('signing starts the loan', () => {
  test('a database failure after recording the signature rolls back the complete loan', () => {
    const issued = issue();
    store.db.exec("CREATE TRIGGER fail_pledge BEFORE UPDATE ON items BEGIN SELECT RAISE(ABORT, 'item write failed'); END");
    assert.throws(() => contracts.sign(issued.contract.token, submission), /item write failed/);
    assert.equal(store.contract(issued.contract.id)?.status, 'pending');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM loans').get() as { n: number }).n, 0);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n, 0);
    assert.deepEqual(store.auditTrail('contract', issued.contract.id).map((row) => row.action), ['contract.issued']);
  });

  test('a signature storage failure leaves no debt and signing can be retried', () => {
    const issued = issue();
    const originalPut = store.media!.put;
    store.media!.put = () => { throw new Error('disk unavailable'); };

    assert.throws(() => contracts.sign(issued.contract.token, submission), /disk unavailable/);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM loans').get() as { n: number }).n, 0);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n, 0);
    assert.equal(store.contract(issued.contract.id)?.status, 'pending');
    assert.equal(store.auditTrail('contract', issued.contract.id).length, 1);

    store.media!.put = originalPut;
    const signed = contracts.sign(issued.contract.token, submission);
    assert.equal(store.balance(signed.loanId), issued.contract.total_due_cents);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM loans').get() as { n: number }).n, 1);
  });

  test('a signature opens the loan and the ledger, with the contract’s own figures', () => {
    const issued = issue();
    const signed = contracts.sign(issued.contract.token, submission);

    const loan = store.loan(signed.loanId)!;
    assert.equal(loan.principal_cents, issued.contract.principal_cents);
    assert.equal(loan.rate_pct, issued.contract.rate_pct);
    assert.equal(loan.term_days, issued.contract.term_days);
    assert.equal(loan.due_date, issued.contract.due_date);

    // The balance is exactly what the customer was told they owe.
    assert.equal(store.balance(loan.id), issued.contract.total_due_cents);
    assert.deepEqual(store.ledger(loan.id).map((entry) => entry.entry_type), ['principal', 'interest']);

    assert.equal(signed.contract.status, 'signed');
    assert.equal(signed.contract.loan_id, loan.id);
    assert.equal(store.item(issued.contract.item_id)?.status, 'pledged');
  });

  test('the signature image is stored encrypted, and the name and ID are kept', () => {
    const issued = issue();
    const signed = contracts.sign(issued.contract.token, submission);

    assert.equal(signed.contract.signed_name, 'Test Customer');
    assert.equal(signed.contract.signed_id_number, '90010100123');
    assert.ok(signed.contract.signed_at);
    assert.match(signed.contract.signature_path!, /\.enc$/);
    assert.ok(store.media!.get(signed.contract.signature_path!).length > 0);
  });

  test('the same contract cannot be signed twice, so no second loan appears', () => {
    const issued = issue();
    contracts.sign(issued.contract.token, submission);

    assert.throws(() => contracts.sign(issued.contract.token, submission), /already signed/i);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM loans').get() as { n: number }).n, 1);
  });

  test('a rejected submission leaves no loan behind', () => {
    const issued = issue();
    const attempts = [
      { ...submission, name: 'X' },
      { ...submission, idNumber: '1' },
      { ...submission, signatureDataUrl: '' },
      { ...submission, signatureDataUrl: 'data:image/png;base64,bm90LWEtcG5n' },
      { ...submission, signatureDataUrl: 'data:text/html;base64,PHNjcmlwdD4=' },
    ];

    for (const attempt of attempts) {
      assert.throws(() => contracts.sign(issued.contract.token, attempt), ContractError);
    }
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM loans').get() as { n: number }).n, 0);
    assert.equal(store.contract(issued.contract.id)?.status, 'pending');
  });

  test('the signature is in the audit trail with the loan it started', () => {
    const issued = issue();
    const signed = contracts.sign(issued.contract.token, submission);

    const actions = store.auditTrail('contract', issued.contract.id).map((row) => row.action);
    assert.deepEqual(actions, ['contract.issued', 'contract.signed']);
    assert.deepEqual(
      store.auditTrail('loan', signed.loanId).map((row) => row.action),
      ['loan.created'],
    );
  });

  test('both parties are told, and Lukas is reminded to check before paying out', () => {
    const issued = issue();
    const signed = contracts.sign(issued.contract.token, submission);

    assert.equal(signed.customerPhone, CUSTOMER);
    assert.match(signed.customerMessage, /signed/i);
    assert.match(signed.customerMessage, /N\$3,750\.00/);
    assert.match(signed.ownerMessage, /Test Customer signed contract EPP-/);
    assert.match(signed.ownerMessage, /Verify the in-person checks before handing over the money/i);
  });
});

describe('the signing page over HTTP', () => {
  const config = {
    port: 0,
    whatsapp: { token: 't', phoneNumberId: 'p', appSecret: 's', verifyToken: 'v' },
    ownerPhone: OWNER,
    ownerName: 'Lukas',
    publicBaseUrl: 'http://127.0.0.1',
    dbPath: ':memory:',
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-sign-http-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
    anthropicApiKey: null,
  openaiApiKey: null,
  valuatorProvider: null,
  };

  test('a customer can open the contract, sign it, and see it confirmed', async () => {
    const httpStore = new Store(':memory:', { mediaDirectory: config.mediaDirectory, mediaKey: config.mediaKey });
    const transport = new MemoryTransport();
    const built = buildServer(config, { transport, store: httpStore, valuator: null });

    // An approved application in this server's own store.
    const owner = httpStore.ensureUser({ name: 'Lukas', phone: OWNER, role: 'owner' });
    const customer = httpStore.upsertCustomer(CUSTOMER, 'Test Customer');
    const item = httpStore.createItem({ customerId: customer.id, categorySlug: 'tvs', description: 'Samsung 55" Smart TV' });
    const approval = httpStore.createApproval({ itemId: item.id, suggestedLoanCents: 200_000 });
    httpStore.decideApproval({ approvalId: approval.id, status: 'approved', approvedLoanCents: 200_000, decidedBy: owner.id });
    const issued = built.contracts.issueForApproval(approval.id, { actor: owner.id });

    await new Promise<void>((resolve) => built.server.listen(0, resolve));
    const { port } = built.server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/c/${issued.contract.token}`;

    try {
      const page = await fetch(url);
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.equal(page.headers.get('x-frame-options'), 'DENY');
      assert.match(html, /Sign your pawn agreement/);
      assert.match(html, /Samsung 55/);
      assert.match(html, /N\$2,000\.00/);

      // A missing signature is refused, with the form shown again.
      const empty = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: 'Test Customer', idNumber: '90010100123', signature: '' }).toString(),
      });
      assert.equal(empty.status, 400);
      assert.match(await empty.text(), /Please sign in the box/);
      assert.equal((httpStore.db.prepare('SELECT COUNT(*) AS n FROM loans').get() as { n: number }).n, 0);

      // A real submission signs it.
      const signed = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: 'Test Customer', idNumber: '90010100123', signature: SIGNATURE }).toString(),
      });
      assert.equal(signed.status, 200);
      assert.match(await signed.text(), /Signed — thank you/);

      const contract = httpStore.contractByToken(issued.contract.token)!;
      assert.equal(contract.status, 'signed');
      assert.ok(contract.loan_id);
      assert.equal(httpStore.balance(contract.loan_id!), contract.total_due_cents);

      // Revisiting the link shows the signed copy, not the form.
      assert.match(await (await fetch(url)).text(), /Signed — thank you/);

      // Both parties heard about it over WhatsApp.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(transport.to(OWNER).join('\n'), /signed contract EPP-/);
      assert.match(transport.to(CUSTOMER).join('\n'), /is signed/);
    } finally {
      built.server.close();
      httpStore.close();
    }
  });

  test('a bad token gets an explanation, not a contract', async () => {
    const httpStore = new Store(':memory:', { mediaDirectory: config.mediaDirectory, mediaKey: config.mediaKey });
    const built = buildServer(config, { transport: new MemoryTransport(), store: httpStore, valuator: null });

    await new Promise<void>((resolve) => built.server.listen(0, resolve));
    const { port } = built.server.address() as { port: number };

    try {
      const response = await fetch(`http://127.0.0.1:${port}/c/definitely-not-a-token`);
      assert.equal(response.status, 404);
      assert.match(await response.text(), /This link cannot be used/);
    } finally {
      built.server.close();
      httpStore.close();
    }
  });
});

describe('approval sends the signing link', () => {
  test('Lukas approving over WhatsApp puts a contract link in the customer’s hands', async () => {
    const transport = new MemoryTransport();
    const router = new AgentRouter({ store, rules, transport, ownerPhone: OWNER, contracts });

    const customer = store.upsertCustomer(CUSTOMER, 'Test Customer');
    const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', description: 'iPhone 13 Pro' });
    const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: 375_000 });

    await router.handle({ from: OWNER, messageId: 'wamid.1', type: 'text', text: 'approve' });

    const toCustomer = transport.to(CUSTOMER).join('\n');
    assert.match(toCustomer, /https:\/\/eppic\.example\/c\//, 'the signing link went out');
    assert.match(toCustomer, /Police declaration/i, 'and what to bring');
    assert.match(transport.to(OWNER).join('\n'), /Contract EPP-\d{4}-\d{4} is ready/);

    const [contract] = store.contractsForApproval(approval.id);
    assert.equal(contract?.status, 'pending');
    assert.equal(contract?.principal_cents, 375_000);
    assert.ok(toCustomer.includes(contracts.signingUrl(contract!.token)));
  });

  test('a declined application produces no contract at all', async () => {
    const transport = new MemoryTransport();
    const router = new AgentRouter({ store, rules, transport, ownerPhone: OWNER, contracts });

    const customer = store.upsertCustomer('+264813333333', 'Declined Customer');
    const item = store.createItem({ customerId: customer.id, categorySlug: 'laptops', description: 'Dell XPS' });
    const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: 200_000 });

    await router.handle({ from: OWNER, messageId: 'wamid.2', type: 'text', text: 'decline no papers' });

    assert.deepEqual(store.contractsForApproval(approval.id), []);
    assert.doesNotMatch(transport.to('+264813333333').join('\n'), /\/c\//);
  });
});

/**
 * A signed agreement has to have a signature on it.
 *
 * Codex's website audit, 30 October 2026, finding B. The checks on the posted
 * image were checks on its *format* — a data URL, under a megabyte, starting
 * with the PNG magic number — so a fully transparent PNG satisfied all three,
 * created the loan and posted the principal and interest. The shop would have
 * held a signed agreement with nothing drawn on it.
 *
 * It needed no crafted request. The pad's resize handler assigns
 * `canvas.width`, which clears the canvas by specification, and did not reset
 * the form's signed flag — so a customer who rotated their phone after signing
 * submitted a blank image and got a thank-you page. The pad keeps its strokes
 * and redraws them now, but the check belongs here as well: the browser is
 * untrusted, and this is the one artefact a customer is later held to.
 */
describe('a blank signature is not a signature', () => {
  const sign = (signatureDataUrl: string) =>
    contracts.sign(issue().contract.token, { name: 'Test Customer', idNumber: '90010100123', signatureDataUrl });

  test('an empty pad is refused, and leaves no loan behind', () => {
    const loans = () => (store.db.prepare('SELECT COUNT(*) AS n FROM loans').get() as { n: number }).n;
    const before = loans();
    assert.throws(() => sign(blankDataUrl()), /sign in the box/i);
    assert.equal(loans(), before, 'no loan, no ledger entry, nothing half-written');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n, 0);
  });

  test('a stroke across the pad is accepted', () => {
    const signed = sign(signatureDataUrl());
    assert.ok(signed.contract.signed_at, 'a real signature still goes through');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM loans').get() as { n: number }).n, 1);
  });

  test('every row filter is handled, drawn and blank alike', () => {
    // A decoder that forgets to reverse PNG filtering reads a blank image as
    // marked, which would quietly undo the whole check.
    for (const filter of [0, 1, 2, 3, 4] as const) {
      assert.throws(() => sign(blankDataUrl({ filter })), /sign in the box/i, `blank, filter ${filter}`);
      assert.ok(sign(signatureDataUrl({ filter })).contract.signed_at, `drawn, filter ${filter}`);
    }
  });

  test('a pad with no alpha channel is judged on white, not on transparency', () => {
    // RGB has no alpha, so "nothing drawn" arrives as white paper rather than
    // as transparent pixels.
    assert.throws(() => sign(blankDataUrl({ channels: 3 })), /sign in the box/i);
    assert.ok(sign(signatureDataUrl({ channels: 3 })).contract.signed_at);
  });

  test('an image this code cannot read is refused rather than guessed at', () => {
    // Interlacing is outside what a canvas produces, and the second is not a
    // PNG at all. Refusing beats vouching for bytes we did not decode.
    assert.throws(() => sign(pngDataUrl({ width: 8, height: 8, interlaced: true })), /sign in the box/i);
    assert.throws(() => sign('data:image/png;base64,aGVsbG8='), /sign in the box/i);
  });
});
