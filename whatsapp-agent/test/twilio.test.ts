import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../src/config.ts';
import { TwilioTransport, verifiedTwilioForm, expectedTwilioSignature, dispatchTwilio, type TwilioOptions } from '../src/whatsapp/twilio.ts';
import { WindowAwareTransport, MemoryTransport } from '../src/whatsapp/transport.ts';
import { Store } from '../src/store/index.ts';
import { buildServer } from '../src/server.ts';
import { DashboardQuery } from '../src/dashboard/index.ts';
import { dashboardPage } from '../src/web/dashboard.ts';
import { loadRules } from '../src/playbook/index.ts';

// Generated fixtures, never real account credentials or encryption keys.
const options: TwilioOptions = { accountSid: `AC${'1'.repeat(32)}`, authToken: randomBytes(24).toString('hex'),
  from: 'whatsapp:+15550000001', contentSids: { fixture: `HX${'2'.repeat(32)}` } };
const sid = `SM${'3'.repeat(32)}`;
const form = { AccountSid: options.accountSid, MessageSid: sid, From: 'whatsapp:+264811110001', To: options.from,
  Body: 'Hello, what is my iPhone 15 worth?', NumMedia: '0', ProfileName: 'Fixture' };
const publicUrl = 'https://fixture.example/webhooks/twilio';
const sign = (params = form, url = publicUrl) => expectedTwilioSignature(options.authToken, url, params);
const record = (overrides: Record<string, unknown> = {}) => ({ sid, account_sid: options.accountSid,
  from: form.From, to: form.To, direction: 'inbound', date_sent: new Date(Date.now() - 1000).toUTCString(), ...overrides });
const mockFetch = (fn: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  (async (input, init) => fn(String(input), init)) as typeof fetch;
const configEnv = () => ({ MESSAGING_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: options.accountSid,
  TWILIO_AUTH_TOKEN: options.authToken, TWILIO_WHATSAPP_FROM: options.from, OWNER_PHONE: '+264811110000',
  PUBLIC_BASE_URL: 'https://fixture.example', EPPIC_MEDIA_KEY: randomBytes(32).toString('hex') });

test('Twilio mode starts without Meta credentials and preserves Meta as default', () => {
  const config = loadConfig(configEnv());
  assert.equal(config.messagingProvider, 'twilio'); assert.equal(config.whatsapp.token, '');
  assert.throws(() => loadConfig({ EPPIC_MEDIA_KEY: randomBytes(32).toString('hex') }), /WHATSAPP_TOKEN/);
});
test('cloud configuration refuses an unknown provider, unsafe origin, bad SID and self-messaging owner', () => {
  for (const patch of [{ MESSAGING_PROVIDER: 'sms' }, { PUBLIC_BASE_URL: 'http://fixture.example' },
    { PUBLIC_BASE_URL: 'https://fixture.example/path' }, { TWILIO_ACCOUNT_SID: 'bad' },
    { TWILIO_WHATSAPP_FROM: '+15550000001' }, { OWNER_PHONE: '+15550000001' },
    { TWILIO_AUTH_TOKEN: '' }, { TWILIO_CONTENT_SIDS: '[]' }, { TWILIO_CONTENT_SIDS: '{"fixture":"bad"}' }]) {
    assert.throws(() => loadConfig({ ...configEnv(), ...patch }));
  }
});
test('signed form validates every field including future Twilio fields', () => {
  const params = { ...form, FutureField: 'value' };
  assert.deepEqual({ ...verifiedTwilioForm(new URLSearchParams(params).toString(), sign(params), publicUrl, options.authToken) }, params);
});
test('unsigned, tampered, wrong-URL and duplicate-field webhooks cannot impersonate the owner', () => {
  const raw = new URLSearchParams(form).toString();
  assert.equal(verifiedTwilioForm(raw, undefined, publicUrl, options.authToken), null);
  assert.equal(verifiedTwilioForm(raw.replace('Hello', 'APPROVE'), sign(), publicUrl, options.authToken), null);
  assert.equal(verifiedTwilioForm(raw, sign(), `${publicUrl}?changed=yes`, options.authToken), null);
  assert.equal(verifiedTwilioForm(`${raw}&Body=APPROVE`, sign(), publicUrl, options.authToken), null);
});
test('text send uses authenticated Twilio form encoding and returns a provider SID', async () => {
  const transport = new TwilioTransport(options, mockFetch((url, init) => {
    assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${options.accountSid}/Messages.json`);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`);
    const sent = new URLSearchParams(String(init?.body));
    assert.equal(sent.get('To'), form.From); assert.equal(sent.get('From'), options.from); assert.equal(sent.get('Body'), 'Hello & welcome');
    return Response.json({ sid });
  }));
  assert.equal(await transport.sendText({ to: '+264811110001', body: 'Hello & welcome' }), sid);
});
test('approved template sends Content SID and ordered variables, not a forbidden free-form fallback', async () => {
  const transport = new TwilioTransport(options, mockFetch((_url, init) => {
    const sent = new URLSearchParams(String(init?.body));
    assert.equal(sent.get('ContentSid'), options.contentSids.fixture);
    assert.equal(sent.get('ContentVariables'), '{"1":"A","2":"B"}'); assert.equal(sent.has('Body'), false);
    return Response.json({ sid });
  }));
  await transport.sendTemplate({ to: '+264811110001', name: 'fixture', language: 'en', parameters: ['A', 'B'], body: 'never sent' });
  assert.throws(() => transport.sendTemplate({ to: '+264811110001', name: 'missing', language: 'en', parameters: [], body: 'no' }), /No approved/);
});
test('failed or ambiguous sends are not automatically retried and never leak provider response bodies', async () => {
  let calls = 0;
  const transport = new TwilioTransport(options, mockFetch(() => { calls++; return new Response('private provider data', { status: 503 }); }));
  await assert.rejects(transport.sendText({ to: '+264811110001', body: 'Hello' }), (error: Error) => !error.message.includes('private'));
  assert.equal(calls, 1);
  await assert.rejects(new TwilioTransport(options, mockFetch(() => Response.json({}))).sendText({ to: '+264811110001', body: 'Hello' }), /unconfirmed/);
});
test('a delayed inbound keeps the original platform timestamp and cannot reopen the reply window', async () => {
  const date = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const transport = new TwilioTransport(options, mockFetch(() => Response.json(record({ date_sent: date.toUTCString() }))));
  const event = await transport.inbound(form);
  assert.equal(event.timestamp, String(Math.floor(date.getTime() / 1000)));
  const memory = new MemoryTransport();
  await new WindowAwareTransport(memory, { lastInboundAt: () => ({ at: new Date(Number(event.timestamp) * 1000).toISOString(), source: 'meta' }) })
    .sendText({ to: event.from, body: 'Hello' });
  assert.equal(memory.templates.length, 1);
});
test('wrong account, sender or message direction is rejected before routing', async () => {
  const transport = new TwilioTransport(options, mockFetch(() => Response.json(record())));
  for (const patch of [{ AccountSid: 'other' }, { To: 'whatsapp:+15550000002' }, { From: 'sms:+264811110001' }, { MessageSid: '../../secrets' }]) {
    await assert.rejects(transport.inbound({ ...form, ...patch }), /identity/);
  }
  for (const patch of [{ direction: 'outbound-api' }, { from: 'whatsapp:+15550000002' }, { sid: 'wrong' },
    { date_sent: 'invalid' }, { date_sent: new Date(Date.now() + 86_400_000).toUTCString() }]) {
    await assert.rejects(new TwilioTransport(options, mockFetch(() => Response.json(record(patch)))).inbound(form));
  }
});
test('single attachments map into the existing image/document intake and multiple attachments fail visibly', async () => {
  const transport = new TwilioTransport(options, mockFetch(() => Response.json(record())));
  for (const [mime, type] of [['image/jpeg', 'image'], ['application/pdf', 'document'], ['audio/ogg', 'audio'], ['video/mp4', 'video'], ['unknown', 'unsupported']]) {
    const event = await transport.inbound({ ...form, NumMedia: '1', MediaContentType0: mime!, MediaUrl0: 'http://127.0.0.1/private' });
    assert.equal(event.type, type); assert.equal(event.mediaId, sid);
  }
  await assert.rejects(transport.inbound({ ...form, NumMedia: '2' }), /media count/);
});
test('Twilio MMS-style message identifiers and date-created fallback are supported', async () => {
  const mm = `MM${'5'.repeat(32)}`;
  const at = new Date(Date.now() - 1000).toUTCString();
  const transport = new TwilioTransport(options, mockFetch(() => Response.json(record({ sid: mm, date_sent: null, date_created: at }))));
  const event = await transport.inbound({ ...form, MessageSid: mm });
  assert.equal(event.messageId, mm); assert.equal(Number(event.timestamp), Date.parse(at) / 1000);
});
test('media is resolved under the account rather than fetching arbitrary webhook URLs', async () => {
  const me = `ME${'4'.repeat(32)}`; const urls: string[] = [];
  const transport = new TwilioTransport(options, mockFetch((url) => {
    urls.push(url);
    return url.endsWith('/Media.json') ? Response.json({ media_list: [{ sid: me, content_type: 'image/jpeg' }] }) : new Response('fixture image');
  }));
  const downloaded = await transport.downloadMedia(sid);
  assert.equal(downloaded.extension, 'jpg'); assert.equal(downloaded.content.toString(), 'fixture image');
  assert.ok(urls.every((url) => url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${options.accountSid}/Messages/${sid}/Media`)));
  await assert.rejects(transport.downloadMedia('http://localhost/private'), /Invalid/);
});
test('owner command retries remain deduplicated after a database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eppic-twilio-'));
  const dbPath = join(directory, 'test.db'); const mediaKey = randomBytes(32);
  const open = () => new Store(dbPath, { mediaDirectory: join(directory, 'media'), mediaKey });
  let store = open(); let calls = 0;
  const event = { from: '+264811110000', messageId: sid, type: 'text' as const, text: 'BOOK' };
  try {
    await Promise.all([dispatchTwilio(store.db, event, async () => { calls++; }), dispatchTwilio(store.db, event, async () => { calls++; })]);
    store.close(); store = open();
    await dispatchTwilio(store.db, event, async () => { calls++; });
    assert.equal(calls, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('failed processing is visible and cannot automatically replay a possibly completed financial action', async () => {
  const store = new Store(':memory:', { mediaDirectory: tmpdir(), mediaKey: randomBytes(32) }); let calls = 0;
  const event = { from: '+264811110000', messageId: sid, type: 'text' as const };
  try {
    await assert.rejects(dispatchTwilio(store.db, event, async () => { calls++; throw new Error('private'); }), /operator review/);
    await dispatchTwilio(store.db, event, async () => { calls++; });
    assert.equal(calls, 1); assert.equal((store.db.prepare('SELECT state FROM twilio_receipts').get() as { state: string }).state, 'failed');
  } finally { store.close(); }
});
test('cloud webhook rejects forgery, routes a signed enquiry, ignores retry and disables the Meta endpoint', async () => {
  const store = new Store(':memory:', { mediaDirectory: tmpdir(), mediaKey: randomBytes(32) });
  const memory = new MemoryTransport();
  const built = buildServer(loadConfig(configEnv()), { store, transport: memory, valuator: null,
    twilioFetch: mockFetch(() => Response.json(record())) });
  let calls = 0;
  const original = built.router.handle.bind(built.router);
  built.router.handle = async (event) => { calls++; await original(event); };
  built.server.listen(0, '127.0.0.1'); await once(built.server, 'listening');
  const address = built.server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const request = (signature: string, path = '/webhooks/twilio') => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature,
      'x-forwarded-host': 'attacker.example' }, body: new URLSearchParams(form) });
  try {
    assert.equal((await request('fake')).status, 401); assert.equal(calls, 0);
    const response = await request(sign()); assert.equal(response.status, 200); assert.equal(await response.text(), '<Response/>');
    assert.equal((await request(sign())).status, 200); assert.equal(calls, 1);
    assert.equal((await fetch(`${base}/webhook`)).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.ok(memory.sent.length > 0);
  } finally { await new Promise<void>((resolve, reject) => built.server.close((error) => error ? reject(error) : resolve())); store.close(); }
});
test('cloud-selected Twilio transport replies to an owner query and drains acknowledged work on shutdown', async () => {
  const store = new Store(':memory:', { mediaDirectory: tmpdir(), mediaKey: randomBytes(32) });
  const ownerForm = { ...form, From: '+264811110000'.replace('+', 'whatsapp:+'), Body: 'BOOK' };
  let sent: URLSearchParams | undefined;
  const built = buildServer(loadConfig(configEnv()), { store, valuator: null,
    twilioFetch: mockFetch((_url, init) => {
      if (init?.method === 'POST') { sent = new URLSearchParams(String(init.body)); return Response.json({ sid }); }
      return Response.json(record({ from: ownerForm.From }));
    }) });
  built.server.listen(0, '127.0.0.1'); await once(built.server, 'listening');
  const address = built.server.address() as { port: number };
  try {
    const result = await fetch(`http://127.0.0.1:${address.port}/webhooks/twilio`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sign(ownerForm) },
      body: new URLSearchParams(ownerForm) });
    assert.equal(result.status, 200); await result.text();
    await built.shutdown();
    assert.equal(sent?.get('To'), ownerForm.From); assert.ok(sent?.get('Body')); assert.equal(sent?.has('ContentSid'), false);
  } catch (error) { if (built.server.listening) await built.shutdown(); throw error; }
});

/**
 * The signature algorithm, pinned.
 *
 * These vectors were generated by the official `twilio` package's own
 * `getExpectedTwilioSignature` before that dependency was removed, so they
 * are the package's answers, not this implementation's. Before removing it,
 * the hand-written validator was run against it on every case below plus
 * query-string and trailing-slash URLs, and agreed on all of them — accepting
 * each valid signature and refusing each tampered one.
 *
 * They cover what a hand-written version would plausibly get wrong: field
 * ordering, a field name that is a prefix of another, an empty value, an
 * empty form, unicode above the BMP, CRLF, and characters with meaning in a
 * form body. Keep them if this is ever rewritten; they are the only thing
 * standing between a subtle signing bug and a forged approval.
 */
describe('Twilio request signatures match the official implementation', () => {
  const TOKEN = 'a'.repeat(32);
  const URL_ = 'https://agent.example.test/webhooks/twilio';
  const vectors: { name: string; params: Record<string, string>; signature: string }[] = [
    { name: 'a plain message', params: { MessageSid: `SM${'a'.repeat(32)}`, Body: 'hello' }, signature: 'tUS2dqBKyHKZ5A+R6hYC08DXu4Y=' },
    { name: 'no fields at all', params: {}, signature: 'fD+XbE3av4VgaeiFwKnVxG2O03A=' },
    { name: 'fields out of order', params: { zebra: '1', apple: '2', Middle: '3' }, signature: 'tmticBXBnq+5dJoe5skJVTljATc=' },
    { name: 'unicode beyond the BMP', params: { Body: 'Hállo wörld 😀 — dash' }, signature: '1Jmqjga4ZG3YIkM7s25Aqc0n/CA=' },
    { name: 'spaces and percent-encoding in the body', params: { Body: 'a b+c%20d' }, signature: 'JoyKTdY4P+dNnrWdKIsTD1i3g80=' },
    { name: 'ampersands and equals signs', params: { Body: 'a&b=c', Other: '=&' }, signature: 'ZEJ43jO8FscV378XtDbZIU7bNKU=' },
    { name: 'an empty value', params: { Body: '', MessageSid: `SM${'b'.repeat(32)}` }, signature: 'VUTy99yGcI9zHY4ECrOuIr6aKH8=' },
    { name: 'newlines', params: { Body: 'line1\nline2\r\n' }, signature: 'u/aTtQMrIKn1tFLYA/lnOJ3Ot3s=' },
    { name: 'a field name that is a prefix of another', params: { Body: 'x', BodyMore: 'y' }, signature: 'VIJ/o6iQ6W65Ez8pNOxyWKXIsQQ=' },
    { name: 'numeric field names, which do not sort numerically', params: { '1': 'a', '2': 'b', '10': 'c' }, signature: 'HH7NzdmSM8+n2Ipbf2JMAImvXlQ=' },
  ];

  for (const vector of vectors) {
    test(`${vector.name} signs exactly as the official package did`, () => {
      assert.equal(expectedTwilioSignature(TOKEN, URL_, vector.params), vector.signature);
      const body = new URLSearchParams(Object.entries(vector.params)).toString();
      const accepted = verifiedTwilioForm(body, vector.signature, URL_, TOKEN);
      assert.ok(accepted, 'a correctly signed form is accepted');
      // Compared as entries: the returned object has a null prototype on
      // purpose, so that a field called `__proto__` or `constructor` in a
      // webhook body cannot reach Object.prototype through the lookups in
      // `inbound()`. deepStrictEqual compares prototypes and would fail on
      // that difference alone.
      assert.equal(Object.getPrototypeOf(accepted), null, 'and is not a plain object');
      assert.deepEqual(Object.entries(accepted).sort(), Object.entries(vector.params).sort());
      // And the same body with one bit of the signature changed is refused.
      const tampered = vector.signature.startsWith('A')
        ? `B${vector.signature.slice(1)}`
        : `A${vector.signature.slice(1)}`;
      assert.equal(verifiedTwilioForm(body, tampered, URL_, TOKEN), null);
    });
  }

  test('a signature for a different URL spelling of the same endpoint is refused', () => {
    // The official package accepts this: it tries six spellings of the URL,
    // including with the default port, for back ends of unknown shape. We pin
    // one exact origin in loadConfig, so one comparison is the tighter check.
    const params = { Body: 'q' };
    const withPort = expectedTwilioSignature(TOKEN, 'https://agent.example.test:443/webhooks/twilio', params);
    const body = new URLSearchParams(Object.entries(params)).toString();
    assert.equal(verifiedTwilioForm(body, withPort, URL_, TOKEN), null);
    assert.notEqual(withPort, expectedTwilioSignature(TOKEN, URL_, params), 'the two spellings really do sign differently');
  });

  test('a signature from another account token is refused', () => {
    const params = { Body: 'q' };
    const body = new URLSearchParams(Object.entries(params)).toString();
    const other = expectedTwilioSignature('b'.repeat(32), URL_, params);
    assert.equal(verifiedTwilioForm(body, other, URL_, TOKEN), null);
  });
});

/**
 * "Visible" has to mean visible to a person.
 *
 * The receipt table already recorded a failed dispatch, and the deployment
 * notes told an operator to run
 * `SELECT ... FROM twilio_receipts WHERE state != 'handled'` by hand. Nothing
 * else read the state, so a message that came in and was dropped existed only
 * in stderr and in that query.
 *
 * The case that makes it matter is Lukas's own. He sends *APPROVE A1B2*,
 * handling throws, the row is marked failed, nothing retries it — correctly,
 * since replaying a command could repeat a payment — and nobody tells him. He
 * goes on believing a customer was approved who was not.
 */
describe('a message that did not go through reaches the dashboard', () => {
  const freshStore = () => new Store(':memory:', { mediaDirectory: tmpdir(), mediaKey: randomBytes(32) });

  test("a failed owner command is counted and named on the page", async () => {
    const store = freshStore();
    try {
      const event = { from: '+264811110000', messageId: sid, type: 'text' as const, text: 'APPROVE A1B2' };
      await assert.rejects(dispatchTwilio(store.db, event, async () => { throw new Error('ledger write failed'); }));
      assert.deepEqual(store.inboundNeedingReview(), { failed: 1, unfinished: 0 });

      const page = dashboardPage(new DashboardQuery(store, loadRules()).read(), 'Lukas', true);
      assert.match(page, /Messages that did not go through/);
      assert.match(page, /1 failed/);
      // Says what it means for him, not just that a row exists.
      assert.match(page, /it did not take effect/);
      assert.match(page, /Nothing is retried automatically/);
    } finally { store.close(); }
  });

  test('an interrupted dispatch counts as unknown, not as still running', () => {
    const store = freshStore();
    try {
      // What a restart leaves behind: reserved, never resolved either way.
      store.db.prepare("INSERT INTO twilio_receipts(message_id, state, created_at) VALUES (?, 'processing', ?)")
        .run(sid, new Date().toISOString());
      assert.deepEqual(store.inboundNeedingReview(), { failed: 0, unfinished: 1 });
      assert.match(dashboardPage(new DashboardQuery(store, loadRules()).read(), 'Lukas', true), /outcome unknown/);
    } finally { store.close(); }
  });

  test('the section stays off the page when every message was handled', async () => {
    const store = freshStore();
    try {
      await dispatchTwilio(store.db, { from: '+264811110000', messageId: sid, type: 'text' as const }, async () => {});
      assert.deepEqual(store.inboundNeedingReview(), { failed: 0, unfinished: 0 });
      // A permanent zero is a line people stop reading.
      assert.doesNotMatch(dashboardPage(new DashboardQuery(store, loadRules()).read(), 'Lukas', true), /did not go through/);
    } finally { store.close(); }
  });
});
