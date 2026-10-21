/**
 * The website as a visitor meets it: landing page, pre-check form, and the
 * handoff to WhatsApp.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { Store, generateMediaKey } from '../src/store/index.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { normalizePhone } from '../src/whatsapp/webhook.ts';
import { buildServer } from '../src/server.ts';
import { precheckQuestions } from '../src/web/precheck.ts';

const rules = loadRules();

const config = {
  port: 0,
  whatsapp: { token: 't', phoneNumberId: 'p', appSecret: 's', verifyToken: 'v' },
  ownerPhone: '+264811110000',
  ownerName: 'Lukas',
  publicBaseUrl: 'http://127.0.0.1',
  dbPath: ':memory:',
  mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-web-')),
  mediaKey: Buffer.from(generateMediaKey(), 'hex'),
  anthropicApiKey: null,
  openaiApiKey: null,
  valuatorProvider: null,
};

let store: Store;
let base: string;
let built: ReturnType<typeof buildServer>;

before(async () => {
  store = new Store(':memory:', { mediaDirectory: config.mediaDirectory, mediaKey: config.mediaKey });
  built = buildServer(config, { transport: new MemoryTransport(), store, valuator: null });
  await new Promise<void>((resolve) => built.server.listen(0, resolve));
  const { port } = built.server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  built.server.close();
  store.close();
});

const get = async (path: string) => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, html: await response.text() };
};

const post = async (path: string, fields: Record<string, string>) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, html: await response.text() };
};

describe('the landing page', () => {
  test('lists exactly the categories the playbook accepts', async () => {
    const { status, html } = await get('/');
    assert.equal(status, 200);

    // Cards show the short label — "Phones", not "Phones (iPhone and Android)" —
    // so the grid fits on a phone. The variant is asked on the next step.
    for (const category of rules.categories) {
      assert.match(html, new RegExp(category.label.replace(/\s*\(.*\)$/, '')));
      assert.match(html, new RegExp(`/apply\\?category=${category.slug}`));
    }
    assert.doesNotMatch(html, /furniture|bed|fridge/i);
  });

  test('says what to bring, and quotes nothing before an item is described', async () => {
    const { html } = await get('/');
    assert.match(html, /Police declaration/i);
    assert.doesNotMatch(html, /N\$\s?\d/, 'no figure before there is an item to price');
  });

  test('loads nothing from anywhere else', async () => {
    const { html } = await get('/');
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /https?:\/\/(?!wa\.me)/i, 'no third-party assets');
  });
});

describe('the pre-check form', () => {
  test('phones ask which kind before the questions', async () => {
    const { html } = await get('/apply?category=phones');
    assert.match(html, /Which one is it\?/);
    assert.match(html, /iPhone/);
    assert.match(html, /Android/);
  });

  test('asks the same questions the WhatsApp intake would', async () => {
    const { html } = await get('/apply?category=phones&variant=iphone');
    for (const question of precheckQuestions(rules, 'phones', 'iphone')) {
      const text = question.ask.split('\n')[0]!.replace(/^Can you confirm:\s*/i, '').replace(/\?$/, '');
      assert.ok(html.includes(escapeForHtml(text)), `the form is missing: ${text}`);
    }
  });

  /**
   * Playbook section 2, "Something else", from 21 October 2026. The page used
   * to answer "We don't take fridge" on its own authority. Whether the shop
   * takes something is Lukas's decision, and the site has no way to ask him —
   * so it says what it honestly can and points at the number where he does
   * get asked.
   */
  test('a category the playbook does not take is not refused outright', async () => {
    const { status, html } = await get('/apply?category=fridge');
    assert.equal(status, 404, 'still not a page we can price');

    assert.match(html, /don(&#39;|')t normally take fridge/);
    assert.match(html, /isn(&#39;|')t an automatic no/);
    assert.match(html, /ask Lukas/);
    assert.match(html, /wa\.me/, 'with a way to actually ask him');
    assert.match(html, /Consoles/, 'and the five it can price now');
  });
});

describe('submitting the pre-check', () => {
  test('a clean answer set points the customer at WhatsApp', async () => {
    const answers = Object.fromEntries(precheckQuestions(rules, 'tvs', null).map((question) => [question.id, 'yes']));
    const { status, html } = await post('/apply', {
      category: 'tvs',
      description: 'Samsung 55" Smart TV',
      ...answers,
    });

    assert.equal(status, 200);
    assert.match(html, /Nothing here stops an application/);
    // Derived from the playbook, not pinned here — a literal would go stale
    // the next time the shop changes number, which is what just happened.
    const shopNumber = normalizePhone(rules.playbook.whatsapp).replace('+', '');
    assert.match(html, new RegExp(`https://wa\\.me/${shopNumber}\\?text=`));
    assert.match(html, /Samsung/);
    assert.match(html, /Police declaration/i);
    assert.doesNotMatch(html, /N\$\s?\d/);
  });

  test('a playbook condition answered "no" explains the rule, without rejecting anyone', async () => {
    const questions = precheckQuestions(rules, 'tvs', null);
    const smartTv = questions.find((question) => /smart tv/i.test(question.ask))!;
    const answers = Object.fromEntries(questions.map((question) => [question.id, 'yes']));

    const { html } = await post('/apply', { category: 'tvs', ...answers, [smartTv.id]: 'no' });

    assert.match(html, /something to sort out first/i);
    assert.match(html, /condition of taking the item in/i);
    assert.match(html, /wa\.me/, 'the conversation is still offered');
    assert.doesNotMatch(html, /rejected|refused|declined/i);
  });

  test('what the visitor typed cannot become markup', async () => {
    const { html } = await post('/apply', {
      category: 'laptops',
      description: '<script>alert("x")</script>',
    });
    assert.doesNotMatch(html, /<script>alert/, 'never rendered as markup');
    assert.match(html, /%3Cscript%3E/, 'it rides in the WhatsApp link, URL-encoded');
  });

  test('the pre-check is recorded as demand, with nothing that identifies anyone', async () => {
    const before = store.precheckCounts().reduce((total, row) => total + row.count, 0);
    await post('/apply', { category: 'consoles', description: 'PS5 disc edition' });

    const counts = store.precheckCounts();
    assert.equal(counts.reduce((total, row) => total + row.count, 0), before + 1);
    assert.ok(counts.some((row) => row.category_slug === 'consoles'));

    const row = store.db.prepare("SELECT * FROM prechecks WHERE category_slug = 'consoles'").get() as Record<string, unknown>;
    assert.deepEqual(Object.keys(row).sort(), ['answers', 'category_slug', 'created_at', 'description', 'id', 'status', 'variant']);
    assert.doesNotMatch(JSON.stringify(row), /\+264|@|phone|name/i, 'no personal data is stored');
  });

  test('a category the playbook does not take is handled on submit too', async () => {
    const { html } = await post('/apply', { category: 'a double bed' });
    assert.match(html, /don&#39;t take a double bed|don't take a double bed/i);
    assert.doesNotMatch(html, /wa\.me\/\d+\?text=Hello%2C%20I%20filled/, 'no handoff for an item we cannot take');
  });
});

function escapeForHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The staff dashboard route. An unknown token and a revoked one must be
 * indistinguishable from outside, so the page cannot be found by guessing.
 */
describe('the staff link', () => {
  test('a valid token gets the dashboard', async () => {
    const user = store.ensureUser({ name: 'Petrus Haufiku', phone: '+264811112222', role: 'inspector' });
    const { token } = store.issueStaffToken(user.id, 'counter phone');

    const response = await fetch(`${base}/staff/${token}`);
    assert.equal(response.status, 200);

    const html = await response.text();
    assert.match(html, /Waiting on Lukas/);
    assert.match(html, /Petrus/, 'greeted by name');
  });

  test('an unknown token, a revoked one and nonsense all look the same', async () => {
    const user = store.ensureUser({ name: 'Gone', phone: '+264811113333', role: 'inspector' });
    const { token, id } = store.issueStaffToken(user.id, 'lost phone');
    store.revokeStaffToken(id, store.owner()!.id);

    const statuses = await Promise.all(
      [token, 'x'.repeat(43), 'not-a-real-token-but-long-enough-here'].map(async (candidate) =>
        (await fetch(`${base}/staff/${candidate}`)).status,
      ),
    );
    assert.deepEqual(statuses, [404, 404, 404]);
  });

  test('the dashboard is not reachable without a token at all', async () => {
    for (const path of ['/staff', '/staff/', '/staff/short']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, `${path} should not resolve`);
    }
  });
});
