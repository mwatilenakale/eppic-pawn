import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/index.ts';
import { getRules } from '../src/playbook/index.ts';
import { AgentRouter } from '../src/router.ts';
import { IntakeAgent, initialState } from '../src/intake/agent.ts';
import { buildQuestionPlan } from '../src/intake/questions.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { evidenceFormat, validateDownloadedEvidence } from '../src/whatsapp/media.ts';
import { png } from './support/png-fixture.ts';

const OWNER = '+264811110000', CUSTOMER = '+264811110009';
const rules = getRules();
const image = png({ width: 2, height: 2, paint: () => ({ r: 20, g: 40, b: 80, a: 255 }) });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'eppic-media-boundary-'));
  const store = new Store(':memory:', { mediaDirectory: directory, mediaKey: randomBytes(32) });
  const customer = store.upsertCustomer(CUSTOMER, 'Fictional Media Customer');
  const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', variant: 'iphone', description: 'iPhone 15 128GB box 95% battery' });
  const state = { ...initialState(customer.name), step: 'questions' as const, greeted: true, categorySlug: 'phones', variant: 'iphone', itemId: item.id };
  const plan = buildQuestionPlan(rules, 'phones', 'iphone');
  const photo = plan.questions.find(q => q.kind === 'photo')!;
  for (const q of plan.questions) {
    if (q.id === photo.id) break;
    state.answers[q.id] = { questionId: q.id, question: q.ask, kind: q.kind, source: q.source, response: 'yes', confirmed: true };
  }
  const conversation = store.openConversation(customer.id, state);
  const transport = new MemoryTransport();
  const router = new AgentRouter({ store, rules, transport, ownerPhone: OWNER });
  const cleanup = () => { store.close(); rmSync(directory, { recursive: true, force: true }); };
  return { store, customer, item, conversation, transport, router, photo, cleanup };
}

test('real supported image headers are identified without trusting a filename', () => {
  assert.deepEqual(evidenceFormat(image), { mimeType: 'image/png', extension: 'png', type: 'image' });
  assert.equal(evidenceFormat(Buffer.from('OggS fictional audio')), null);
  assert.equal(evidenceFormat(Buffer.from('not a photo')), null);
  assert.equal(evidenceFormat(Buffer.alloc(0)), null);
});
test('declared MIME and event type must agree with the downloaded evidence bytes', () => {
  const event = { from: CUSTOMER, messageId: 'fixture', type: 'image' as const };
  assert.equal(validateDownloadedEvidence(event, { content: image, mimeType: 'image/png', extension: '../../bad' }).extension, 'png');
  assert.throws(() => validateDownloadedEvidence(event, { content: image, mimeType: 'audio/ogg', extension: 'png' }));
  assert.throws(() => validateDownloadedEvidence({ ...event, type: 'audio' }, { content: image, mimeType: 'image/png', extension: 'png' }));
  assert.throws(() => validateDownloadedEvidence(event, { content: Buffer.from('OggS fake audio'), mimeType: 'image/jpeg', extension: 'jpg' }));
});
test('a voice note cannot satisfy the pending item-photo question and asks for text once', async () => {
  const f = fixture();
  try {
    const before = f.store.conversationById(f.conversation.id)!.state;
    const event = { from: CUSTOMER, messageId: 'voice.fixture', type: 'audio' as const, mediaId: 'audio.fixture' };
    await f.router.handle(event); await f.router.handle(event);
    assert.equal(f.store.photos(f.item.id).length, 0);
    assert.equal(f.store.conversationById(f.conversation.id)!.state, before);
    assert.equal(f.transport.sent.length, 1); assert.match(f.transport.sent[0]!.body, /text message/);
    assert.equal(f.store.pendingApprovals().length, 0);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM loans').get() as { n: number }).n, 0);
  } finally { f.cleanup(); }
});
test('audio bytes disguised as an image do not advance intake or become stored photographs', async () => {
  const f = fixture();
  try {
    f.transport.media.set('bad', { content: Buffer.from('OggS fictional recording'), mimeType: 'image/jpeg', extension: 'jpg' });
    await f.router.handle({ from: CUSTOMER, messageId: 'bad.fixture', type: 'image', mediaId: 'bad' });
    assert.equal(f.store.photos(f.item.id).length, 0); assert.match(f.transport.sent[0]!.body, /could not accept/);
  } finally { f.cleanup(); }
});
test('a supported image still satisfies the requested photo and is encrypted', async () => {
  const f = fixture();
  try {
    f.transport.media.set('good', { content: image, mimeType: 'image/png', extension: 'png' });
    await f.router.handle({ from: CUSTOMER, messageId: 'good.fixture', type: 'image', mediaId: 'good' });
    const photos = f.store.photos(f.item.id);
    assert.equal(photos.length, 1); assert.equal(photos[0]!.kind, f.photo.photoKind); assert.match(photos[0]!.media_path, /\.enc$/);
    assert.deepEqual(f.store.media!.get(photos[0]!.media_path), image);
  } finally { f.cleanup(); }
});
test('a PDF does not stand in for an item photograph', async () => {
  const f = fixture();
  try {
    f.transport.media.set('pdf', { content: Buffer.from('%PDF-1.7\nfixture'), mimeType: 'application/pdf', extension: 'pdf' });
    await f.router.handle({ from: CUSTOMER, messageId: 'pdf.fixture', type: 'document', mediaId: 'pdf' });
    assert.equal(f.store.photos(f.item.id).length, 0); assert.match(f.transport.sent[0]!.body, /not a PDF/);
  } finally { f.cleanup(); }
});
test('internal intake callers cannot count explicit audio as a requested document', () => {
  const f = fixture();
  try {
    const result = new IntakeAgent(f.store, rules).handle(CUSTOMER, { providerMessageId: 'direct.fixture',
      media: { content: Buffer.from('OggS fixture'), extension: 'ogg', mimeType: 'audio/ogg' } });
    assert.equal(f.store.photos(f.item.id).length, 0); assert.match(result.replies[0]!, /text/);
  } finally { f.cleanup(); }
});
test('unsupported media does not interrupt a conversation held by a human', async () => {
  const f = fixture();
  try {
    f.store.db.prepare("UPDATE conversations SET held_reason = 'person is handling this' WHERE id = ?").run(f.conversation.id);
    await f.router.handle({ from: CUSTOMER, messageId: 'held.fixture', type: 'audio', mediaId: 'voice' });
    assert.equal(f.transport.sent.length, 0); assert.equal(f.store.photos(f.item.id).length, 0);
  } finally { f.cleanup(); }
});
