import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/index.ts';
import { loadRules } from '../src/playbook/index.ts';
import { InspectionQueue } from '../src/inspection/queue.ts';
import { buildServer } from '../src/server.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';

const rules = loadRules();
let store: Store;
let queue: InspectionQueue;
let built: ReturnType<typeof buildServer>;
let base: string;
let token: string;
let tokenId: string;
let staff: ReturnType<Store['ensureUser']>;
let jobId: string;
const root = () => `/staff/${token}/inspections`;

beforeEach(async () => {
  store = new Store(':memory:');
  staff = store.ensureUser({ name: 'Inspector Fixture', phone: '+264811112222', role: 'inspector' });
  const issued = store.issueStaffToken(staff.id);
  token = issued.token; tokenId = issued.id;
  const customer = store.upsertCustomer('+264811234567', 'Fixture Customer');
  const item = store.createItem({ customerId: customer.id, categorySlug: 'cars', description: 'Polo, target N$90,000 <script>alert(1)</script>' });
  queue = new InspectionQueue(store, rules);
  jobId = queue.open({ itemId: item.id, actor: staff.id }).id;
  built = buildServer({ port: 0, whatsapp: { token: 'fixture', phoneNumberId: 'fixture', appSecret: 'fixture', verifyToken: 'fixture' }, ownerPhone: '+264811110000', ownerName: 'Lukas', publicBaseUrl: 'http://127.0.0.1', dbPath: ':memory:', mediaDirectory: '.', mediaKey: Buffer.alloc(32), anthropicApiKey: null, openaiApiKey: null, valuatorProvider: null }, { store, transport: new MemoryTransport(), valuator: null });
  await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(built.server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => built.server.close(() => resolve()));
  store.close();
});

async function get(path: string) {
  const response = await fetch(base + path);
  return { response, html: await response.text() };
}
async function post(path: string, fields: Record<string, string>, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(base + path, { method: 'POST', body: new URLSearchParams({ csrf: token, ...fields }), redirect: 'manual', headers: extraHeaders });
  return { response, html: await response.text() };
}
function complete() {
  return Object.fromEntries(queue.worksheet(jobId).flatMap((line) => [[`answer:${line.checkId}`, 'pass'], [`note:${line.checkId}`, 'Checked in person']]));
}
function blind(html: string) {
  assert.doesNotMatch(html, /N\$\s*\d|90,000|NAD\s*\d/i);
  assert.doesNotMatch(html, /<script|<iframe|https?:\/\/|@import/i);
  assert.match(html, /--accent-gold/);
}

test('staff can find the queue from the existing dashboard without replacing it', async () => {
  const { html } = await get(`/staff/${token}`);
  assert.match(html, /Today/);
  assert.ok(html.includes(root()));
});

test('staff claim, save partial work, finish and read an immutable submitted report', async () => {
  let page = await get(root());
  assert.equal(page.response.status, 200); blind(page.html);
  assert.match(page.html, /Unclaimed/);
  assert.equal((await post(`${root()}/claim`, { jobId })).response.status, 303);
  page = await get(`${root()}/job/${jobId}`); blind(page.html);
  assert.match(page.html, /required/);
  const first = queue.worksheet(jobId)[0]!;
  await post(`${root()}/job/${jobId}`, { action: 'save', [`answer:${first.checkId}`]: 'fail', [`note:${first.checkId}`]: 'N$999 suspect fee', findings: 'Draft findings' });
  page = await get(`${root()}/job/${jobId}`);
  assert.match(page.html, /value="fail" checked/); assert.match(page.html, /Draft findings/); blind(page.html);
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get();
  assert.equal((await post(`${root()}/job/${jobId}`, { ...complete(), action: 'submit', findings: 'Everything inspected, no acceptance decision.' })).response.status, 303);
  page = await get(`${root()}/job/${jobId}`); blind(page.html);
  assert.match(page.html, /Submitted/); assert.match(page.html, /Inspector Fixture/);
  assert.doesNotMatch(page.html, /<form|type="radio"|<textarea/);
  assert.deepEqual(store.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get(), before);
  assert.equal(store.pendingApprovals().length, 0);
  assert.equal((await post(`${root()}/job/${jobId}`, { ...complete(), action: 'submit', findings: 'Overwrite' })).response.status, 400);
  assert.notEqual(queue.job(jobId)!.findings, 'Overwrite');
});

test('missing checks and missing findings are refused with readable errors', async () => {
  queue.claim(jobId, staff);
  let result = await post(`${root()}/job/${jobId}`, { action: 'submit', findings: 'Not complete' });
  assert.equal(result.response.status, 400);
  assert.match(result.html, /still unanswered/); blind(result.html);
  result = await post(`${root()}/job/${jobId}`, { ...complete(), action: 'submit', findings: '' });
  assert.equal(result.response.status, 400); assert.match(result.html, /Say what you found/);
  assert.equal(queue.job(jobId)!.status, 'claimed');
});

test('a refused submission retains the inspector’s answers and findings without submitting', async () => {
  queue.claim(jobId, staff);
  const first = queue.worksheet(jobId)[0]!;
  const { html, response } = await post(`${root()}/job/${jobId}`, { action: 'submit', findings: 'Still checking engine', [`answer:${first.checkId}`]: 'fail', [`note:${first.checkId}`]: 'Needs mechanic' });
  assert.equal(response.status, 400);
  assert.match(html, /value="fail" checked/);
  assert.match(html, /Still checking engine/);
  assert.match(html, /Needs mechanic/);
  assert.equal(queue.job(jobId)!.status, 'claimed');
});

test('redacting the display does not rewrite stored evidence on an unchanged save', async () => {
  queue.claim(jobId, staff);
  const lines = queue.worksheet(jobId);
  queue.record(jobId, staff, lines.map((line) => ({ checkId: line.checkId, text: line.text, answer: 'pass', note: 'Quoted N$50 fee' })), 'Quoted N$50 fee');
  const fields = Object.fromEntries(lines.flatMap((line) => [[`answer:${line.checkId}`, 'pass'], [`note:${line.checkId}`, 'Quoted [amount withheld] fee']]));
  await post(`${root()}/job/${jobId}`, { ...fields, action: 'save', findings: 'Quoted [amount withheld] fee' });
  assert.equal(queue.worksheet(jobId)[0]!.note, 'Quoted N$50 fee');
  assert.equal(queue.job(jobId)!.findings, 'Quoted N$50 fee');
  blind((await get(`${root()}/job/${jobId}`)).html);
});

test('every category renders document checks in order without leaking prices or fetching assets', async () => {
  for (const category of rules.categories) {
    for (const variant of category.slug === 'phones' ? ['iphone', 'android'] : [null]) {
      const customer = store.upsertCustomer('+264811234568', 'Category fixture');
      const item = store.createItem({ customerId: customer.id, categorySlug: category.slug, variant, description: `${category.label} NAD 9000` });
      const job = queue.open({ itemId: item.id, actor: staff.id });
      queue.claim(job.id, staff);
      const { html } = await get(`${root()}/job/${job.id}`);
      blind(html);
      let last = -1;
      for (const line of queue.worksheet(job.id)) {
        const position = html.indexOf(`name="answer:${line.checkId}"`);
        assert.ok(position > last, `${category.slug}: check order`);
        last = position;
      }
    }
  }
});

test('a held job cannot be taken or edited by another inspector', async () => {
  const other = store.ensureUser({ name: 'Other inspector', phone: '+264811113333', role: 'inspector' });
  queue.claim(jobId, other);
  let result = await post(`${root()}/claim`, { jobId });
  assert.equal(result.response.status, 409); assert.match(result.html, /already working/); blind(result.html);
  const page = await get(`${root()}/job/${jobId}`);
  assert.doesNotMatch(page.html, /<form/);
  result = await post(`${root()}/job/${jobId}`, { ...complete(), action: 'submit', findings: 'Stolen claim' });
  assert.equal(result.response.status, 400);
  assert.equal(queue.job(jobId)!.claimedBy, other.id);
});

test('unknown and revoked links have identical responses on reads and mutations', async () => {
  store.revokeStaffToken(tokenId, staff.id);
  for (const suffix of ['', '/claim', `/job/${jobId}`]) {
    const revoked = await get(root() + suffix);
    const unknown = await get(`/staff/${'x'.repeat(32)}/inspections${suffix}`);
    assert.equal(revoked.response.status, 404); assert.equal(unknown.response.status, 404);
    assert.equal(revoked.html, unknown.html);
    assert.equal((await post(root() + suffix, { jobId, action: 'submit' })).response.status, 404);
  }
  assert.equal(queue.job(jobId)!.status, 'open');
});

test('blind cross-site posts and missing form credentials cannot claim jobs', async () => {
  assert.equal((await post(`${root()}/claim`, { csrf: '', jobId })).response.status, 403);
  assert.equal((await post(`${root()}/claim`, { jobId }, { origin: 'https://attacker.invalid' })).response.status, 403);
  assert.equal(queue.job(jobId)!.status, 'open');
});

test('forged answers cannot pass inspection and releasing returns the job to the queue', async () => {
  queue.claim(jobId, staff);
  const fields = complete();
  fields[`answer:${queue.worksheet(jobId)[0]!.checkId}`] = 'approved';
  assert.equal((await post(`${root()}/job/${jobId}`, { ...fields, action: 'submit', findings: 'Forged' })).response.status, 400);
  assert.equal(queue.job(jobId)!.status, 'claimed');
  assert.equal((await post(`${root()}/job/${jobId}`, { action: 'release' })).response.status, 303);
  assert.equal(queue.job(jobId)!.status, 'open');
});

test('inspection pages escape customer markup and prevent caching, framing and referrer leakage', async () => {
  const { html, response } = await get(root());
  assert.match(html, /&lt;script&gt;/); blind(html);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});
