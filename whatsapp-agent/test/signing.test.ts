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
import { InspectionQueue } from '../src/inspection/queue.ts';
import { referenceFor } from '../src/reference.ts';

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
  // The customer cannot sign until the item is in the shop, so every fixture
  // that goes on to sign has to put it there first (playbook section 7).
  // `notYetReceived()` below is the one that deliberately does not.
  store.markItemReceived(item.id, lukas.id);
  const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: amountCents });
  return store.decideApproval({
    approvalId: approval.id,
    status: 'approved',
    approvedLoanCents: amountCents,
    decidedBy: lukas.id,
  });
}

/** An approved application whose item has not arrived yet. */
function notYetReceived(amountCents = 375_000): Approval {
  const customer = store.upsertCustomer('+264811999888', 'Not Here Yet');
  const item = store.createItem({
    customerId: customer.id, categorySlug: 'phones', variant: 'iphone', description: 'iPhone 13 Pro, 256GB',
  });
  const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: amountCents });
  return store.decideApproval({
    approvalId: approval.id, status: 'approved', approvedLoanCents: amountCents, decidedBy: lukas.id,
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
    // The TV is in the shop; the customer is at the counter signing. Nothing
    // can be signed before that (playbook section 7).
    httpStore.markItemReceived(item.id, owner.id);
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

/**
 * The agreement comes last.
 *
 * Lukas, 30 October 2026: "The customer cannot have access to the agreement,
 * because the agreement is at the end of their process. If things are
 * outstanding in between, they can't sign. They only sign when the item has
 * been approved — our staff have checked the item, approved, and then only
 * then they sign."
 *
 * This replaces a test that asserted the opposite: that APPROVE put a signing
 * link in the customer's hands. It did, before anybody had seen the item,
 * which is what the whole "subject to the in-person check" sentence was
 * supposed to prevent (docs/tasks/002).
 */
describe('the second gate releases the agreement', () => {
  const start = async () => {
    const transport = new MemoryTransport();
    const router = new AgentRouter({ store, rules, transport, ownerPhone: OWNER, contracts });
    const customer = store.upsertCustomer(CUSTOMER, 'Test Customer');
    const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', variant: 'iphone', description: 'iPhone 13 Pro' });
    const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: 375_000 });
    await router.handle({ from: OWNER, messageId: 'wamid.a', type: 'text', text: 'approve' });
    return { transport, router, item, approval, reference: referenceFor(approval.id) };
  };

  test('approving tells the customer a figure and no more', async () => {
    const { transport, approval } = await start();
    const toCustomer = transport.to(CUSTOMER).join('\n');

    assert.match(toCustomer, /we can offer N\$3,750\.00/, 'the figure still goes out');
    assert.match(toCustomer, /subject to the in-person check/i);
    assert.doesNotMatch(toCustomer, /https:\/\/eppic\.example\/c\//, 'but no signing link');
    assert.equal(store.contractsForApproval(approval.id).length, 0, 'and no agreement exists yet');
  });

  test('release is refused before the item is here, and before it is inspected', async () => {
    const { transport, router, item, approval, reference } = await start();

    await router.handle({ from: OWNER, messageId: 'wamid.b', type: 'text', text: `RELEASE ${reference}` });
    assert.match(transport.to(OWNER).at(-1)!, /not recorded as being here yet/i);

    await router.handle({ from: OWNER, messageId: 'wamid.c', type: 'text', text: `RECEIVED ${reference}` });
    await router.handle({ from: OWNER, messageId: 'wamid.d', type: 'text', text: `RELEASE ${reference}` });
    assert.match(transport.to(OWNER).at(-1)!, /has not been inspected yet/i);

    assert.equal(store.contractsForApproval(approval.id).length, 0, 'still nothing to sign');
    assert.doesNotMatch(transport.to(CUSTOMER).join('\n'), /\/c\//);
    assert.ok(item);
  });

  test('once inspected, release issues the agreement and sends the link', async () => {
    const { transport, router, approval, reference } = await start();
    await router.handle({ from: OWNER, messageId: 'wamid.e', type: 'text', text: `RECEIVED ${reference}` });

    // The hire inspects it and submits the report.
    const hire = store.ensureUser({ name: 'Petrus Haufiku', phone: '+264811112222', role: 'inspector' });
    const queue = new InspectionQueue(store, rules);
    const job = queue.waiting()[0]!;
    queue.claim(job.id, hire);
    queue.submit({
      jobId: job.id,
      user: hire,
      results: queue.worksheet(job.id).map((line) => ({ checkId: line.checkId, text: line.text, answer: 'pass' as const, note: '' })),
      findings: 'Everything checks out.',
    });

    await router.handle({ from: OWNER, messageId: 'wamid.f', type: 'text', text: `RELEASE ${reference}` });

    const toCustomer = transport.to(CUSTOMER).join('\n');
    assert.match(toCustomer, /https:\/\/eppic\.example\/c\//, 'now the link goes out');
    const [contract] = store.contractsForApproval(approval.id);
    assert.equal(contract?.status, 'pending');
    assert.equal(contract?.principal_cents, 375_000);
    assert.ok(toCustomer.includes(contracts.signingUrl(contract!.token)));
  });

  test('a failed check still reaches him, and he is told he released around it', async () => {
    const { transport, router, reference } = await start();
    await router.handle({ from: OWNER, messageId: 'wamid.g', type: 'text', text: `RECEIVED ${reference}` });

    const hire = store.ensureUser({ name: 'Petrus Haufiku', phone: '+264811112222', role: 'inspector' });
    const queue = new InspectionQueue(store, rules);
    const job = queue.waiting()[0]!;
    queue.claim(job.id, hire);
    const lines = queue.worksheet(job.id);
    queue.submit({
      jobId: job.id,
      user: hire,
      results: lines.map((line, index) => ({ checkId: line.checkId, text: line.text, answer: index === 0 ? ('fail' as const) : ('pass' as const), note: '' })),
      findings: 'One check failed.',
    });

    await router.handle({ from: OWNER, messageId: 'wamid.h', type: 'text', text: `RELEASE ${reference}` });
    const told = transport.to(OWNER).join('\n');
    // A failed check does not auto-decline; the point is that he cannot not
    // be told (docs/tasks/002).
    assert.match(told, /released this with 1 failed check/i);
    assert.match(told, new RegExp(lines[0]!.text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  });

  test('hold tells the customer and leaves no agreement behind', async () => {
    const { transport, router, approval, reference } = await start();
    await router.handle({ from: OWNER, messageId: 'wamid.i', type: 'text', text: `RECEIVED ${reference}` });

    await router.handle({ from: OWNER, messageId: 'wamid.j', type: 'text', text: `HOLD ${reference} the back glass is cracked` });

    assert.match(transport.to(OWNER).at(-1)!, /Held [A-Z0-9]{4}/);
    const toCustomer = transport.to(CUSTOMER).join('\n');
    assert.match(toCustomer, /not able to go ahead/i);
    assert.match(toCustomer, /back glass is cracked/);
    assert.doesNotMatch(toCustomer, /\/c\//, 'no link');
    assert.equal(store.contractsForApproval(approval.id).length, 0);
  });

  test('the hire cannot release', async () => {
    const { router, approval, reference } = await start();
    const transport2 = new MemoryTransport();
    const hireRouter = new AgentRouter({ store, rules, transport: transport2, ownerPhone: OWNER, contracts });
    store.ensureUser({ name: 'Petrus Haufiku', phone: '+264811112222', role: 'inspector' });
    await router.handle({ from: OWNER, messageId: 'wamid.k', type: 'text', text: `RECEIVED ${reference}` });

    await hireRouter.handle({ from: '+264811112222', messageId: 'wamid.l', type: 'text', text: `RELEASE ${reference}` });

    assert.match(transport2.to('+264811112222').at(-1)!, /not something this number can do/i);
    assert.equal(store.contractsForApproval(approval.id).length, 0, 'no agreement was issued');
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

/**
 * Nobody signs before the item is in the shop.
 *
 * Lukas, 30 October 2026: "They can't sign until the item has been received,
 * so when they sign it is assumed that the item has been received by our
 * staff and is in the possession of the pawn shop."
 *
 * Codex's website audit, finding A, was that the pages promise the loan
 * starts at handover while signing starts it. His answer resolves it the
 * other way round from the way I expected: starting the loan at signing is
 * correct, and the fault was that nothing stopped a customer signing at home
 * days before travelling in — owing interest on an item still in their own
 * house, and burning days of their month getting to Windhoek.
 */
describe('the item has to be here first', () => {
  test('signing is refused until the item is recorded as received', () => {
    const issued = contracts.issueForApproval(notYetReceived().id, { actor: lukas.id });
    const loans = () => (store.db.prepare('SELECT COUNT(*) AS n FROM loans').get() as { n: number }).n;

    assert.throws(
      () => contracts.sign(issued.contract.token, { ...submission, name: 'Not Here Yet' }),
      /only be signed at the shop/i,
    );
    assert.equal(loans(), 0, 'and no loan, no ledger, no clock started');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n, 0);
  });

  test('once it is received, the same link signs normally', () => {
    const approval = notYetReceived();
    const issued = contracts.issueForApproval(approval.id, { actor: lukas.id });

    store.markItemReceived(issued.contract.item_id, lukas.id);
    const signed = contracts.sign(issued.contract.token, { ...submission, name: 'Not Here Yet' });

    assert.ok(signed.contract.signed_at);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM loans').get() as { n: number }).n, 1);
  });

  test('the link opened early explains itself rather than looking broken', () => {
    // The agreement is genuinely ready; it is the signing that waits. A
    // customer who taps the link from home should learn that in one sentence.
    const issued = contracts.issueForApproval(notYetReceived().id, { actor: lukas.id });
    const contract = contracts.openForSigning(issued.contract.token);
    assert.equal(contract.status, 'pending', 'the link itself stays valid, it is signing that waits');
    assert.notEqual(contract.status, 'void');
  });

  test('receipt is recorded once, by whoever was at the counter', () => {
    const issued = contracts.issueForApproval(notYetReceived().id, { actor: lukas.id });
    const hire = store.ensureUser({ name: 'Petrus Haufiku', phone: '+264811112222', role: 'inspector' });

    const first = store.markItemReceived(issued.contract.item_id, hire.id)!;
    assert.ok(first.received_at, 'the hire can take an item in — it is not an approval');
    assert.equal(first.received_by, hire.id);

    // Saying it again does not rewrite who took it in.
    const again = store.markItemReceived(issued.contract.item_id, lukas.id)!;
    assert.equal(again.received_by, hire.id, 'the first person to say so is the record');
    assert.equal(again.received_at, first.received_at);
  });
});
