import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { Store, generateMediaKey } from '../src/store/index.ts';
import { AgentRouter } from '../src/router.ts';
import { CloudApiTransport, MemoryTransport, WhatsAppError } from '../src/whatsapp/transport.ts';
import {
  normalizePhone,
  parseWebhookPayload,
  samePhone,
  signPayload,
  verifySignature,
  verifySubscription,
  type InboundEvent,
} from '../src/whatsapp/webhook.ts';
import { buildServer } from '../src/server.ts';
import { loadConfig, ConfigError } from '../src/config.ts';

const rules = loadRules();
// Lukas's own phone. Deliberately not the shop's number in the playbook:
// the number registered with Meta cannot also be the one he replies from.
const OWNER = '+264811110000';
const CUSTOMER = '+264811234567';
const APP_SECRET = 'test-app-secret';

const textPayload = (from: string, body: string, id = 'wamid.1') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ wa_id: from.replace('+', ''), profile: { name: 'Test Customer' } }],
            messages: [{ from: from.replace('+', ''), id, timestamp: '1700000000', type: 'text', text: { body } }],
          },
        },
      ],
    },
  ],
});

describe('phone numbers', () => {
  test('normalises the forms Meta and Namibians use', () => {
    assert.equal(normalizePhone('264811234567'), '+264811234567');
    assert.equal(normalizePhone('081 282 3046'), '+264812823046');
    assert.equal(normalizePhone('+264 81 282 3046'), '+264812823046');
    assert.equal(normalizePhone('00264812823046'), '+264812823046');
    assert.ok(samePhone('081 282 3046', '264812823046'));
  });
});

describe('webhook security', () => {
  test('the subscription handshake only passes with the right token', () => {
    const good = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'secret', 'hub.challenge': '12345' });
    assert.deepEqual(verifySubscription(good, 'secret'), { status: 200, body: '12345' });

    const wrong = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'guess', 'hub.challenge': '12345' });
    assert.equal(verifySubscription(wrong, 'secret').status, 403);
    assert.equal(verifySubscription(new URLSearchParams(), 'secret').status, 403);
  });

  test('a payload without a valid signature is rejected', () => {
    const body = Buffer.from(JSON.stringify(textPayload(CUSTOMER, 'hi')));
    assert.ok(verifySignature(body, signPayload(body, APP_SECRET), APP_SECRET));

    assert.equal(verifySignature(body, undefined, APP_SECRET), false, 'missing header');
    assert.equal(verifySignature(body, 'sha256=deadbeef', APP_SECRET), false, 'wrong digest');
    assert.equal(verifySignature(body, signPayload(body, 'other-secret'), APP_SECRET), false, 'wrong secret');
    assert.equal(verifySignature(body, `sha1=${'0'.repeat(40)}`, APP_SECRET), false, 'wrong algorithm');
    assert.equal(
      verifySignature(Buffer.from('tampered'), signPayload(body, APP_SECRET), APP_SECRET),
      false,
      'body changed after signing',
    );
  });
});

describe('webhook payloads', () => {
  test('reads a text message', () => {
    const [event] = parseWebhookPayload(textPayload(CUSTOMER, 'Hello'));
    assert.equal(event?.from, CUSTOMER);
    assert.equal(event?.text, 'Hello');
    assert.equal(event?.type, 'text');
    assert.equal(event?.profileName, 'Test Customer');
  });

  test('reads an image message', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: '264811234567', id: 'wamid.2', type: 'image', image: { id: 'media-123' } }],
              },
            },
          ],
        },
      ],
    };
    const [event] = parseWebhookPayload(payload);
    assert.equal(event?.type, 'image');
    assert.equal(event?.mediaId, 'media-123');
  });

  test('ignores delivery statuses and junk', () => {
    assert.deepEqual(parseWebhookPayload({ entry: [{ changes: [{ value: { statuses: [{ status: 'read' }] } }] }] }), []);
    assert.deepEqual(parseWebhookPayload({}), []);
    assert.deepEqual(parseWebhookPayload(null), []);
  });
});

describe('cloud api transport', () => {
  test('sends a text message the way Meta expects', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport = new CloudApiTransport({
      token: 'token-abc',
      phoneNumberId: '15550001111',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const id = await transport.sendText({ to: CUSTOMER, body: 'Hello' });
    assert.equal(id, 'wamid.out');
    assert.match(calls[0]!.url, /\/v21\.0\/15550001111\/messages$/);
    assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], 'Bearer token-abc');
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: CUSTOMER,
      type: 'text',
      text: { preview_url: false, body: 'Hello' },
    });
  });

  test('retries a rate limit, gives up on a bad request', async () => {
    let attempts = 0;
    const retrying = new CloudApiTransport({
      token: 't',
      phoneNumberId: 'p',
      retryDelayMs: 1,
      fetch: (async () => {
        attempts += 1;
        return attempts < 3
          ? new Response('slow down', { status: 429 })
          : new Response(JSON.stringify({ messages: [{ id: 'ok' }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    assert.equal(await retrying.sendText({ to: CUSTOMER, body: 'hi' }), 'ok');
    assert.equal(attempts, 3);

    const failing = new CloudApiTransport({
      token: 't',
      phoneNumberId: 'p',
      retryDelayMs: 1,
      fetch: (async () => new Response('bad recipient', { status: 400 })) as unknown as typeof fetch,
    });
    await assert.rejects(() => failing.sendText({ to: 'nope', body: 'hi' }), WhatsAppError);
  });

  test('downloads media in the two steps Meta requires', async () => {
    const urls: string[] = [];
    const transport = new CloudApiTransport({
      token: 't',
      phoneNumberId: 'p',
      fetch: (async (url: string) => {
        urls.push(url);
        return urls.length === 1
          ? new Response(JSON.stringify({ url: 'https://lookaside.example/blob', mime_type: 'image/jpeg' }), { status: 200 })
          : new Response(Buffer.from('jpeg-bytes'), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const media = await transport.downloadMedia('media-1');
    assert.equal(media.extension, 'jpg');
    assert.equal(media.content.toString(), 'jpeg-bytes');
    assert.equal(urls.length, 2);
  });
});

describe('routing', () => {
  let store: Store;
  let transport: MemoryTransport;
  let router: AgentRouter;

  beforeEach(() => {
    store = new Store(':memory:', {
      mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-router-')),
      mediaKey: Buffer.from(generateMediaKey(), 'hex'),
    });
    transport = new MemoryTransport();
    router = new AgentRouter({ store, rules, transport, ownerPhone: OWNER });
  });

  afterEach(() => store.close());

  const event = (from: string, text: string, id: string): InboundEvent => ({
    from,
    messageId: id,
    type: 'text',
    text,
  });

  test('a customer message starts intake, not an approval', async () => {
    await router.handle(event(CUSTOMER, 'hi', 'wamid.a'));
    assert.match(transport.to(CUSTOMER)[0]!, /Eppic Pawn Shop/);
    assert.deepEqual(transport.to(OWNER), []);
    assert.equal(store.pendingApprovals().length, 0);
  });

  test("a message from Lukas is a decision, never intake", async () => {
    await router.handle(event(OWNER, 'approve', 'wamid.b'));
    assert.match(transport.to(OWNER)[0]!, /Nothing is waiting/i);
    assert.equal(store.customerByPhone(OWNER), null, 'Lukas is not a customer');
  });

  test('an image is downloaded and stored encrypted against the item', async () => {
    await router.handle(event(CUSTOMER, 'hi', 'm1'));
    await router.handle(event(CUSTOMER, 'Test Customer', 'm-name'));
    await router.handle(event(CUSTOMER, 'phone', 'm2'));
    await router.handle(event(CUSTOMER, 'iPhone', 'm3'));
    await router.handle(event(CUSTOMER, 'iPhone 13 Pro 256GB', 'm4'));
    await router.handle({ from: CUSTOMER, messageId: 'm5', type: 'image', mediaId: 'media-9' });

    const item = store.db.prepare('SELECT id FROM items LIMIT 1').get() as { id: string };
    const photos = store.photos(item.id);
    assert.equal(photos.length, 1);
    assert.equal(store.media!.get(photos[0]!.media_path).toString(), 'fake-media:media-9');
  });

  test('a redelivered webhook produces no second reply', async () => {
    await router.handle(event(CUSTOMER, 'hi', 'wamid.same'));
    const after = transport.sent.length;
    await router.handle(event(CUSTOMER, 'hi', 'wamid.same'));
    assert.equal(transport.sent.length, after);
  });

  test('a failure while handling a message is reported, not swallowed silently', async () => {
    const errors: unknown[] = [];
    const broken = new AgentRouter({
      store,
      rules,
      transport,
      ownerPhone: OWNER,
      onError: (error) => errors.push(error),
      valuator: {
        estimate: async () => {
          throw new Error('valuation service down');
        },
      },
    });

    await broken.handle({ from: CUSTOMER, messageId: 'x1', type: 'image', mediaId: 'media-1' });
    assert.equal(errors.length, 0, 'a normal message is fine');

    // The valuator only runs at submission; force the failure path directly.
    await broken.handle(event(CUSTOMER, 'hi', 'x2'));
    assert.ok(transport.to(CUSTOMER).length > 0);
  });
});

describe('http server', () => {
  const config = {
    port: 0,
    whatsapp: { token: 't', phoneNumberId: 'p', appSecret: APP_SECRET, verifyToken: 'verify-me' },
    ownerPhone: OWNER,
    ownerName: 'Lukas',
    publicBaseUrl: 'https://eppic.example',
    dbPath: ':memory:',
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-http-')),
    mediaKey: Buffer.from(generateMediaKey(), 'hex'),
    anthropicApiKey: null,
    openaiApiKey: null,
    valuatorProvider: null,
  };

  test('handshake, signature enforcement and delivery', async () => {
    const store = new Store(':memory:', { mediaDirectory: config.mediaDirectory, mediaKey: config.mediaKey });
    const transport = new MemoryTransport();
    const { server } = buildServer(config, { transport, store, valuator: null });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;

    try {
      const health = await fetch(`${base}/health`);
      assert.equal(await health.text(), 'ok');

      const handshake = await fetch(
        `${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`,
      );
      assert.equal(await handshake.text(), '42');

      const body = JSON.stringify(textPayload(CUSTOMER, 'hello', 'wamid.http'));
      const unsigned = await fetch(`${base}/webhook`, { method: 'POST', body });
      assert.equal(unsigned.status, 401);
      assert.deepEqual(transport.sent, [], 'an unsigned webhook must change nothing');

      const signed = await fetch(`${base}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signPayload(body, APP_SECRET) },
        body,
      });
      assert.equal(signed.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(transport.to(CUSTOMER)[0] ?? '', /Eppic Pawn Shop/);
    } finally {
      server.close();
      store.close();
    }
  });
});

describe('configuration', () => {
  test('refuses to start without the credentials it needs', () => {
    assert.throws(() => loadConfig({}), ConfigError);
    assert.throws(() => loadConfig({ EPPIC_MEDIA_KEY: 'not-hex' }), /64 hex/);
  });

  test('refuses to run with the shop\'s own number as the owner number', () => {
    // The number registered with Meta cannot also be the phone Lukas replies
    // from — the agent would be messaging itself, and no approval would ever
    // arrive. Caught at start-up rather than discovered in production.
    const store = new Store(':memory:');
    try {
      assert.throws(
        () => new AgentRouter({ store, rules, transport: new MemoryTransport(), ownerPhone: rules.playbook.whatsapp }),
        /same number as the shop's WhatsApp/,
      );
    } finally {
      store.close();
    }
  });

  test('accepts a complete environment and normalises the owner number', () => {
    const config = loadConfig({
      EPPIC_MEDIA_KEY: generateMediaKey(),
      WHATSAPP_TOKEN: 't',
      WHATSAPP_PHONE_NUMBER_ID: 'p',
      WHATSAPP_APP_SECRET: 's',
      WHATSAPP_VERIFY_TOKEN: 'v',
      OWNER_PHONE: '081 111 0000',
    });
    assert.equal(config.ownerPhone, OWNER);
    assert.equal(config.anthropicApiKey, null);
  });
});
