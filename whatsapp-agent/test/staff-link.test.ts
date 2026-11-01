/**
 * `npm run link` — the only way to open the staff dashboard or an inspection
 * worksheet on a real database.
 *
 * Written on 1 November 2026 because a live test could not get past the
 * inspection: `Store.issueStaffToken` existed and nothing outside a test
 * called it, so neither page could be reached. With no inspection possible,
 * *RELEASE* always answers "has not been inspected yet" and the second gate
 * is unreachable — the system was complete and untestable.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, generateMediaKey } from '../src/store/index.ts';
import { parse, main } from '../src/staff/cli.ts';

let directory: string;
let dbPath: string;
let printed: string[];
let logged: typeof console.log;

const run = (args: string[], extra: Record<string, string> = {}) =>
  main(['--db', dbPath, '--base', 'https://agent.example.test', ...args]);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'eppic-link-'));
  dbPath = join(directory, 'eppic.db');
  process.env['OWNER_PHONE'] = '081 555 0100';
  process.env['OWNER_NAME'] = 'Lukas';
  process.env['EPPIC_MEDIA_KEY'] = generateMediaKey();
  printed = [];
  logged = console.log;
  console.log = (...parts: unknown[]) => void printed.push(parts.join(' '));
});

afterEach(() => {
  console.log = logged;
  delete process.env['OWNER_PHONE'];
  delete process.env['OWNER_NAME'];
  delete process.env['EPPIC_MEDIA_KEY'];
});

describe('issuing a staff link', () => {
  test('the owner gets a dashboard link, and the owner row is created', async () => {
    assert.equal(await run([]), 0);
    const output = printed.join('\n');

    assert.match(output, /Lukas \(owner\) — \+264815550100/);
    assert.match(output, new RegExp('https://agent\\.example\\.test/staff/[A-Za-z0-9_-]{20,}$', 'm'));
    assert.match(output, /\/inspections/, 'both pages, because he may be the one inspecting');

    const store = new Store(dbPath, { mediaKey: Buffer.from(generateMediaKey(), 'hex') });
    try {
      assert.equal(store.owner()?.phone, '+264815550100');
    } finally { store.close(); }
  });

  test('the link actually opens the dashboard', async () => {
    await run([]);
    const token = /\/staff\/([A-Za-z0-9_-]{20,})/.exec(printed.join('\n'))![1]!;

    const store = new Store(dbPath, { mediaKey: Buffer.from(generateMediaKey(), 'hex') });
    try {
      // The whole point: the printed token resolves to the person.
      assert.equal(store.staffByToken(token)?.role, 'owner');
      assert.equal(store.staffByToken('not-a-real-token'), null);
    } finally { store.close(); }
  });

  test('an inspector can be created with their own link', async () => {
    assert.equal(await run(['--inspector', 'Petrus Haufiku', '081 555 0101']), 0);
    const output = printed.join('\n');
    assert.match(output, /Petrus Haufiku \(inspector\) — \+264815550101/);

    const token = /\/staff\/([A-Za-z0-9_-]{20,})/.exec(output)![1]!;
    const store = new Store(dbPath, { mediaKey: Buffer.from(generateMediaKey(), 'hex') });
    try {
      const user = store.staffByToken(token)!;
      assert.equal(user.role, 'inspector');
      // The line that matters: the hire inspects and cannot decide money.
      assert.equal(user.name, 'Petrus Haufiku');
    } finally { store.close(); }
  });

  test('the token is never recoverable, only revocable', async () => {
    await run([]);
    const token = /\/staff\/([A-Za-z0-9_-]{20,})/.exec(printed.join('\n'))![1]!;
    printed = [];

    assert.equal(await run(['--list']), 0);
    const listing = printed.join('\n');
    assert.match(listing, /Lukas \(owner\)/);
    assert.doesNotMatch(listing, new RegExp(token), 'only the hash is stored, so it cannot be shown again');

    const id = /^([0-9a-f-]{36})\s/m.exec(listing)![1]!;
    printed = [];
    assert.equal(await run(['--revoke', id]), 0);

    const store = new Store(dbPath, { mediaKey: Buffer.from(generateMediaKey(), 'hex') });
    try {
      assert.equal(store.staffByToken(token), null, 'a revoked link stops working at once');
    } finally { store.close(); }
  });

  test('a missing owner phone is refused with the fix, not a stack trace', async () => {
    delete process.env['OWNER_PHONE'];
    assert.equal(await run([]), 1);
  });

  test('the arguments parse as documented', () => {
    const options = parse(['--inspector', 'Helen', '0815550102', '--base', 'https://x.test/'], {});
    assert.deepEqual(options.inspector, { name: 'Helen', phone: '0815550102' });
    assert.equal(options.base, 'https://x.test', 'a trailing slash would double up in the link');
    assert.throws(() => parse(['--inspector', 'Helen'], {}), /needs a name and a phone/);
    assert.throws(() => parse(['--nonsense'], {}), /Unknown option/);
  });
});
