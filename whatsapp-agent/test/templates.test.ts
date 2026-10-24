import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/index.ts';
import { loadRules } from '../src/playbook/index.ts';
import { CloudApiTransport, MemoryTransport, WindowAwareTransport, META_CUSTOMER_SERVICE_WINDOW_MS } from '../src/whatsapp/transport.ts';
import { templateFor, TEMPLATES, updateTemplate, type TemplateMessage } from '../src/whatsapp/templates.ts';
import { Collections } from '../src/book/collections.ts';
import { DashboardQuery } from '../src/dashboard/index.ts';
import { dashboardPage } from '../src/web/dashboard.ts';
import { AgentRouter } from '../src/router.ts';
import { addDays, loanTerms, schedule } from '../src/valuation.ts';
import { referenceFor } from '../src/reference.ts';

const rules = loadRules(), PHONE = '+264811000444', OWNER = '+264811110000';
const NOW = new Date('2026-10-25T12:00:00Z'), clock = () => NOW;
let store: Store;
beforeEach(() => { store = new Store(':memory:', { clock }); });
afterEach(() => store.close());

function delivery(raw = new MemoryTransport(), onFailure?: (message: { to: string; body: string }, error: Error) => void) {
  return new WindowAwareTransport(raw, { lastInboundAt: (phone) => store.lastInboundAt(phone), clock, onFailure });
}

test('recent Meta inbound uses free-form; exactly 24 hours uses a template', async () => {
  const raw = new MemoryTransport(), transport = delivery(raw);
  store.noteInbound(PHONE, new Date(NOW.getTime() - META_CUSTOMER_SERVICE_WINDOW_MS).toISOString());
  await transport.sendText({ to: PHONE, body: 'Boundary' });
  assert.equal(raw.templates.length, 1);
  store.noteInbound(PHONE, new Date(NOW.getTime() - META_CUSTOMER_SERVICE_WINDOW_MS + 1).toISOString());
  await transport.sendText({ to: PHONE, body: 'Inside' });
  assert.equal(raw.templates.length, 1); assert.equal(raw.sent.length, 2);
});

test('unknown, receipt-only, invalid and future timestamps never prove an open window', async () => {
  for (const inbound of [null, { at: NOW.toISOString(), source: 'received' as const }, { at: 'invalid', source: 'meta' as const }, { at: new Date(NOW.getTime() + 1000).toISOString(), source: 'meta' as const }]) {
    const raw = new MemoryTransport();
    await new WindowAwareTransport(raw, { lastInboundAt: () => inbound, clock }).sendText({ to: PHONE, body: 'Update' });
    assert.equal(raw.templates.length, 1);
  }
});

test('outbound messages and new conversations never reopen the inbound window', async () => {
  store.noteInbound(PHONE, '2026-10-21T12:00:00Z');
  const customer = store.upsertCustomer(PHONE, 'Fixture');
  const first = store.openConversation(customer.id); store.closeConversation(first.id);
  const second = store.openConversation(customer.id);
  store.recordOutbound({ conversationId: second.id, body: 'Just sent' });
  const raw = new MemoryTransport(); await delivery(raw).sendText({ to: PHONE, body: 'Late reply' });
  assert.equal(raw.templates.length, 1);
});

test('the template payload carries exact name, language and positional body parameters', async () => {
  let payload: Record<string, unknown> = {};
  const raw = new CloudApiTransport({ token: 'synthetic-token', phoneNumberId: 'fixture', fetch: async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ messages: [{ id: 'provider.fixture' }] }), { status: 200 });
  } });
  const template = templateFor('reminder', PHONE, 'Readable reminder', ['A1B2', 'N$1,000.00', '2026-10-28', '3']);
  assert.equal(await raw.sendTemplate(template), 'provider.fixture');
  assert.deepEqual(payload, { messaging_product: 'whatsapp', recipient_type: 'individual', to: PHONE, type: 'template', template: {
    name: TEMPLATES.reminder.name, language: { code: 'en' }, components: [{ type: 'body', parameters: ['A1B2', 'N$1,000.00', '2026-10-28', '3'].map((text) => ({ type: 'text', text })) }],
  } });
  assert.equal('body' in payload, false);
});

test('missing or rejected template is a visible failure, not a free-form fallback', async () => {
  for (const status of [400, 404]) {
    let attempts = 0, reported = 0;
    const raw = new CloudApiTransport({ token: 'fixture', phoneNumberId: 'fixture', fetch: async () => {
      attempts++; return new Response(JSON.stringify({ error: { code: 132001, message: 'Template does not exist or is not approved' } }), { status });
    } });
    const transport = new WindowAwareTransport(raw, { lastInboundAt: () => null, clock, onFailure: (_message, error) => { reported++; assert.match(error.message, /approved/); } });
    await assert.rejects(transport.sendText({ to: PHONE, body: 'Outcome' }), /eppic_outcome_v1/);
    assert.equal(attempts, 1); assert.equal(reported, 1);
  }
});

test('an empty provider response or incapable transport cannot pretend it sent a message', async () => {
  const raw = new CloudApiTransport({ token: 'fixture', phoneNumberId: 'fixture', fetch: async () => new Response('{}', { status: 200 }) });
  await assert.rejects(raw.sendTemplate(updateTemplate(PHONE, 'Outcome')), /message ID/);
  const incapable = { sendText: async () => 'wrong-path', downloadMedia: async () => ({ content: Buffer.alloc(0), mimeType: '', extension: '' }) };
  await assert.rejects(new WindowAwareTransport(incapable, { lastInboundAt: () => null, onFailure: () => {} }).sendText({ to: PHONE, body: 'Outcome' }), /template-capable/);
});

test('template parameters are positional, non-empty and free of line breaks', () => {
  assert.throws(() => templateFor('reminder', PHONE, 'body', ['missing']), /parameters/);
  assert.throws(() => updateTemplate(PHONE, ' '), /parameters/);
  assert.deepEqual(updateTemplate(PHONE, 'Loan:\nN$1,000.00\tapproved').parameters, ['Loan: N$1,000.00 approved']);
});

test('a possibly accepted template POST is never retried after a lost response', async () => {
  let calls = 0;
  const raw = new CloudApiTransport({ token: 'fixture', phoneNumberId: 'fixture', fetch: async () => { calls++; throw new Error('Response lost'); } });
  await assert.rejects(raw.sendTemplate(updateTemplate(PHONE, 'Update')), /Response lost/);
  assert.equal(calls, 1);
});

test('single-attempt free-form collection messages cannot duplicate on network failure', async () => {
  let calls = 0;
  const raw = new CloudApiTransport({ token: 'fixture', phoneNumberId: 'fixture', fetch: async () => { calls++; throw new Error('Response lost'); } });
  await assert.rejects(raw.sendText({ to: PHONE, body: 'Reminder', singleAttempt: true }), /Response lost/);
  assert.equal(calls, 1);
});

test('a template cannot redirect an outside-window message to a different recipient', async () => {
  const raw = new MemoryTransport();
  await assert.rejects(delivery(raw, () => {}).sendText({ to: PHONE, body: 'Private update', template: updateTemplate(OWNER, 'Private update') }), /recipient/);
  assert.equal(raw.sent.length, 0);
});

test('router reports a failed customer template to the owner without changing a deal', async () => {
  class RejectCustomer extends MemoryTransport {
    override async sendTemplate(message: TemplateMessage): Promise<string> {
      if (message.to === PHONE) throw new Error('Template eppic_outcome_v1 not approved');
      return super.sendTemplate(message);
    }
  }
  const raw = new RejectCustomer(), errors: unknown[] = [];
  const router = new AgentRouter({ store, rules, transport: raw, ownerPhone: OWNER, clock, onError: (error) => errors.push(error) });
  await router.handle({ from: PHONE, messageId: 'failed-intake', type: 'text', text: 'hello', timestamp: String(NOW.getTime() / 1000 - 3 * 86400) });
  assert.ok(raw.to(OWNER).some((text) => /not confirmed.*not approved/s.test(text)));
  assert.ok(errors.length > 0); assert.equal(store.pendingApprovals().length, 0);
});

test('an overnight owner approval uses a customer template while replying free-form to the owner', async () => {
  const raw = new MemoryTransport();
  const router = new AgentRouter({ store, rules, transport: raw, ownerPhone: OWNER, clock });
  const customer = store.upsertCustomer(PHONE, 'Overnight Fixture');
  const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', description: 'Synthetic phone' });
  const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: rules.playbook.loanSizing.minimumLoanCents * 2 });
  store.noteInbound(PHONE, '2026-10-21T12:00:00Z');
  await router.handle({ from: OWNER, messageId: 'overnight-approval', type: 'text', text: `APPROVE ${referenceFor(approval.id)}`, timestamp: String(NOW.getTime() / 1000) });
  assert.equal(store.approval(approval.id)!.status, 'approved');
  assert.equal(raw.templates.filter((message) => message.to === PHONE).length, 1);
  assert.equal(raw.templates.filter((message) => message.to === OWNER).length, 0);
  assert.doesNotMatch(raw.to(PHONE).join('\n'), /Lukas/);
});

test('when the owner’s alert template also fails the failure is logged without recursion', async () => {
  class RejectAll extends MemoryTransport { attempts = 0; override async sendTemplate(): Promise<string> { this.attempts++; throw new Error('No approved template'); } }
  const raw = new RejectAll(), errors: unknown[] = [];
  const router = new AgentRouter({ store, rules, transport: raw, ownerPhone: OWNER, clock, onError: (error) => errors.push(error) });
  await router.handle({ from: OWNER, messageId: 'owner-failure', type: 'text', text: 'BOOK', timestamp: String(NOW.getTime() / 1000 - 3 * 86400) });
  assert.ok(raw.attempts <= 2); assert.ok(errors.length > 0);
});

function loan(dueDate: string, target = store) {
  target.ensureUser({ name: 'Fixture Owner', phone: OWNER, role: 'owner' });
  const customer = target.upsertCustomer(PHONE, 'Collections Fixture');
  const item = target.createItem({ customerId: customer.id, categorySlug: 'phones', description: 'Synthetic phone' });
  const principalCents = rules.playbook.loanSizing.minimumLoanCents * 2, terms = loanTerms({ principalCents }, rules);
  const dates = schedule(addDays(dueDate, -terms.termDays), terms, rules);
  const row = target.createLoan({ customerId: customer.id, itemId: item.id, principalCents, ratePct: terms.ratePct, rateRule: terms.rule.id, termDays: terms.termDays, interestCents: terms.interestCents, ...dates, actor: target.owner()!.id });
  target.postLedgerEntry({ loanId: row.id, entryType: 'principal', amountCents: principalCents, actor: target.owner()!.id });
  target.postLedgerEntry({ loanId: row.id, entryType: 'interest', amountCents: terms.interestCents, actor: target.owner()!.id });
  return row;
}

test('collections reads the playbook lead time and dashboard exposes waiting counts without sending', () => {
  loan(addDays('2026-10-25', rules.playbook.collections.reminderDaysBeforeDue));
  const other = loan(addDays('2026-10-25', rules.playbook.collections.reminderDaysBeforeDue + 1));
  const raw = new MemoryTransport(), service = new Collections(store, rules, raw, { clock });
  assert.equal(service.due().length, 1); assert.ok(service.due()[0]!.loanId !== other.id);
  const dashboard = new DashboardQuery(store, rules, { clock }).read();
  assert.equal(dashboard.collectionNotices.reminders, 1);
  assert.match(dashboardPage(dashboard, 'Inspector', true), /1 reminders waiting to go/);
  assert.equal(raw.sent.length, 0);
});

test('sending a due reminder chooses a typed template, sums the ledger and records acceptance', async () => {
  const row = loan(addDays('2026-10-25', rules.playbook.collections.reminderDaysBeforeDue));
  const before = store.ledger(row.id), raw = new MemoryTransport(), service = new Collections(store, rules, raw, { clock });
  const notice = service.due()[0]!;
  assert.equal(notice.amountCents, store.balance(row.id));
  assert.deepEqual(await service.send(notice), { state: 'accepted' });
  assert.equal(raw.templates[0]!.name, TEMPLATES.reminder.name);
  assert.equal(store.collectionNotice(row.id, 'reminder')!.state, 'accepted');
  assert.deepEqual(store.ledger(row.id), before); assert.equal(service.due().length, 0);
});

test('an open window prefers free-form even for a scheduled reminder', async () => {
  loan(addDays('2026-10-25', rules.playbook.collections.reminderDaysBeforeDue));
  store.noteInbound(PHONE, NOW.toISOString());
  const raw = new MemoryTransport(), service = new Collections(store, rules, raw, { clock });
  await service.send(service.due()[0]!);
  assert.equal(raw.sent.length, 1); assert.equal(raw.templates.length, 0);
});

test('one last-day final notice survives restart and simultaneous callers without changing collateral', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eppic-notices-')), path = join(dir, 'fixture.db');
  let disk = new Store(path, { clock });
  const row = loan(addDays('2026-10-25', -rules.playbook.grace.defaultDays), disk), raw = new MemoryTransport();
  const service = new Collections(disk, rules, raw, { clock }), second = new Collections(disk, rules, raw, { clock });
  const notice = service.finalNotices()[0]!;
  await Promise.all([service.send(notice), second.send(notice)]);
  assert.equal(raw.sent.length, 1); assert.equal(disk.loan(row.id)!.status, 'active');
  disk.close(); disk = new Store(path, { clock });
  assert.equal(new Collections(disk, rules, raw, { clock }).finalNotices().length, 0);
  assert.equal(disk.collectionNotice(row.id, 'final')!.state, 'accepted');
  disk.close();
});

test('paid loans and stale candidates cannot be chased', async () => {
  const row = loan(addDays('2026-10-25', -rules.playbook.grace.defaultDays)), raw = new MemoryTransport(), service = new Collections(store, rules, raw, { clock });
  const notice = service.finalNotices()[0]!;
  store.updateLoanStatus(row.id, 'paid', store.owner()!.id);
  assert.deepEqual(await service.send(notice), { state: 'skipped' }); assert.equal(raw.sent.length, 0);
});

test('failed and interrupted sends remain visible and are not automatically retried', async () => {
  class Reject extends MemoryTransport { override async sendTemplate(): Promise<string> { throw new Error('Template missing'); } }
  const row = loan(addDays('2026-10-25', -rules.playbook.grace.defaultDays)), service = new Collections(store, rules, new Reject(), { clock, onFailure: () => {} });
  const notice = service.finalNotices()[0]!;
  assert.equal((await service.send(notice)).state, 'failed');
  assert.equal(store.collectionNotice(row.id, 'final')!.state, 'failed');
  assert.equal(service.finalNotices().length, 0);
  const interrupted = loan(addDays('2026-10-25', -rules.playbook.grace.defaultDays)); store.reserveCollectionNotice(interrupted.id, 'final');
  assert.equal(service.finalNotices().length, 0);
  assert.equal(store.collectionNoticesNeedingReview(), 2);
});

test('final warning is sent only on the last grace day and missed dates are visible, never chased', async () => {
  const today = '2026-10-25', raw = new MemoryTransport();
  const row = loan(addDays(today, -rules.playbook.grace.defaultDays));
  const service = new Collections(store, rules, raw, { clock });
  assert.equal(service.finalNotices().length, 1);
  await service.send(service.finalNotices()[0]!);
  assert.match(raw.to(PHONE)[0]!, /Pay today, or from tomorrow the item is up for sale/);
  assert.equal(raw.templates[0]!.name, TEMPLATES.final.name);
  assert.equal(store.loan(row.id)!.status, 'active', 'notice does not forfeit automatically');
  const missed = loan(addDays(today, -rules.playbook.grace.defaultDays - 1));
  assert.equal(service.finalNotices().length, 0);
  assert.equal(service.missedFinalNotices().length, 1);
  assert.equal((await service.send({ loanId: missed.id, kind: 'final' })).state, 'skipped');
  const dashboard = new DashboardQuery(store, rules, { clock }).read();
  assert.equal(dashboard.collectionNotices.missedFinal, 1);
  assert.match(dashboardPage(dashboard, 'Inspector', true), /1 final-notice dates missed/);
  assert.equal(raw.sent.length, 1);
});
