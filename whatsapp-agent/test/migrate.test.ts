/**
 * Importing the Eppic workbook (architecture step 7).
 *
 * The workbook used here is invented — same shape as Lukas's, none of his
 * customers. The real one has 372 loans and 190 real people in it and is not
 * something to keep in a repository.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/playbook/index.ts';
import { Store, generateMediaKey } from '../src/store/index.ts';
import {
  importWorkbook,
  separateSecrets,
  cleanName,
  ImportError,
  LEDGER_SHEET,
  CUSTOMERS_SHEET,
  UNRECORDED_CATEGORY,
} from '../src/migrate/workbook.ts';
import { buildXlsx, type FixtureCell } from './support/xlsx-fixture.ts';

const rules = loadRules();

const LEDGER_HEADERS = [
  'LoanID', 'Status', 'Customer Name', 'Customer Phone', 'Date Issued', 'Principal Issued (N$)',
  'Outstanding Principal (N$)', 'Interest Paid To Date (N$)', 'Principal Paid To Date (N$)',
  'Monthly Interest Rate', 'CustomerID', 'Item Description', 'Term (Days)', 'Grace (Days)',
  'Interest for Period (N$)', 'Next Due Date', 'Grace Expiry', 'ItemID',
];

/** A paid-off loan, the shape most of the real workbook is in. */
function paidRow(overrides: Partial<Record<string, FixtureCell>> = {}): FixtureCell[] {
  const row: Record<string, FixtureCell> = {
    LoanID: 'LN0001',
    Status: 'Paid Off',
    'Customer Name': 'Aina Shipanga',
    'Customer Phone': '081 555 0101',
    'Date Issued': new Date(Date.UTC(2025, 4, 12)),
    'Principal Issued (N$)': 3000,
    'Outstanding Principal (N$)': 0,
    'Interest Paid To Date (N$)': 900,
    'Principal Paid To Date (N$)': 3000,
    'Monthly Interest Rate': 0.3,
    CustomerID: 'CUST0001',
    'Item Description': 'Aina Shipanga 081 555 0101',
    'Term (Days)': 30,
    'Grace (Days)': 4,
    'Interest for Period (N$)': 900,
    'Next Due Date': new Date(Date.UTC(2025, 5, 11)),
    'Grace Expiry': new Date(Date.UTC(2025, 5, 15)),
    ItemID: 'ITM0001',
    ...overrides,
  };
  return LEDGER_HEADERS.map((header) => row[header] ?? null);
}

function activeRow(overrides: Partial<Record<string, FixtureCell>> = {}): FixtureCell[] {
  return paidRow({
    LoanID: 'LN0002',
    Status: 'Active',
    'Outstanding Principal (N$)': 3000,
    'Interest Paid To Date (N$)': 0,
    'Principal Paid To Date (N$)': 0,
    ItemID: 'ITM0002',
    ...overrides,
  });
}

interface FixtureOptions {
  loans?: FixtureCell[][];
  customers?: FixtureCell[][];
  omitCustomerSheet?: boolean;
}

function writeWorkbook(directory: string, options: FixtureOptions = {}): string {
  const sheets = [
    { name: 'DASHBOARD', rows: [['EPPIC PAWN — DASHBOARD']] as FixtureCell[][] },
    { name: LEDGER_SHEET, rows: [LEDGER_HEADERS as FixtureCell[], ...(options.loans ?? [paidRow(), activeRow()])] },
  ];

  if (!options.omitCustomerSheet) {
    sheets.push({
      name: CUSTOMERS_SHEET,
      rows: [
        ['CustomerID', 'Customer Name', 'Customer Phone'] as FixtureCell[],
        ...(options.customers ?? [['CUST0001', 'Aina Shipanga', '081 555 0101']]),
      ],
    });
  }

  const path = join(directory, 'workbook.xlsx');
  writeFileSync(path, buildXlsx(sheets));
  return path;
}

let directory: string;
let store: Store;
let lukas: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'eppic-import-'));
  store = new Store(':memory:', { mediaDirectory: join(directory, 'media'), mediaKey: Buffer.from(generateMediaKey(), 'hex') });
  lukas = store.ensureUser({ name: 'Lukas', phone: '+264812823046', role: 'owner' }).id;
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const runImport = (path: string, dryRun = false) => importWorkbook(path, store, rules, { actor: lukas, dryRun });

describe('a dry run', () => {
  test('writes nothing at all', () => {
    const report = runImport(writeWorkbook(directory), true);

    assert.equal(report.dryRun, true);
    assert.equal(report.importId, null);
    assert.equal(store.customers().length, 0);
    assert.equal(store.imports().length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ledger_entries').get()!['n'], 0);
  });

  test('still says what would come across, so the totals can be checked first', () => {
    const report = runImport(writeWorkbook(directory), true);

    assert.equal(report.loans.imported, 2);
    assert.equal(report.loans.active, 1);
    assert.equal(report.loans.paidOff, 1);
    assert.equal(report.totals.principalIssuedCents, 600_000);
    assert.equal(report.totals.interestRepaidCents, 90_000);
    assert.equal(report.totals.outstandingCents, 300_000);
  });
});

describe('importing the book', () => {
  test('a paid-off loan comes out settled', () => {
    runImport(writeWorkbook(directory));

    const row = store.importedRow(LEDGER_SHEET, 'LN0001', 'loan')!;
    const loan = store.loan(row.entity_id)!;

    assert.equal(loan.status, 'paid');
    assert.equal(loan.principal_cents, 300_000);
    assert.equal(loan.interest_cents, 90_000);
    assert.equal(store.balance(loan.id), 0, 'a loan the workbook calls paid off owes nothing');
    assert.deepEqual(store.ledger(loan.id).map((entry) => entry.entry_type), [
      'principal',
      'interest',
      'repayment.interest',
      'repayment.principal',
    ]);
  });

  test('an active loan still owes principal and interest', () => {
    runImport(writeWorkbook(directory));

    const loan = store.loan(store.importedRow(LEDGER_SHEET, 'LN0002', 'loan')!.entity_id)!;
    assert.equal(loan.status, 'active');
    assert.equal(store.balance(loan.id), 390_000);
  });

  test('entries are dated when the money moved, not when the import ran', () => {
    runImport(writeWorkbook(directory));

    const loan = store.loan(store.importedRow(LEDGER_SHEET, 'LN0001', 'loan')!.entity_id)!;
    const entries = store.ledger(loan.id);

    assert.equal(entries[0]!.created_at.slice(0, 10), '2025-05-12', 'the day it was issued');
    assert.equal(entries[3]!.created_at.slice(0, 10), '2025-06-11', 'repayment sits at the due date');
    assert.match(entries[3]!.memo, /the exact date was not recorded/, 'and says why');

    // The audit log is where the truthful insert time lives, so back-dating an
    // entry never hides when it was actually written.
    const audit = store.auditTrail('ledger_entry', entries[0]!.id);
    assert.ok(audit[0]!.at > '2026-01-01', 'the audit entry carries the real insert time');
  });

  test('a loan keeps the rate it actually ran at', () => {
    runImport(writeWorkbook(directory));

    const loan = store.loan(store.importedRow(LEDGER_SHEET, 'LN0001', 'loan')!.entity_id)!;
    // The playbook says 29% today. This loan ran at 30% and stays at 30%.
    assert.equal(loan.rate_pct, 30);
    assert.equal(loan.rate_rule, 'workbook:LN0001');
    assert.notEqual(loan.rate_pct, rules.rate('standard')!.ratePct);
  });

  test('and the disagreement with the playbook is put in front of Lukas', () => {
    const report = runImport(writeWorkbook(directory), true);

    assert.match(report.divergences.join('\n'), /2 loans ran at 30% where the playbook's "Standard \(your capital\)" row says 29%/);
    assert.match(report.divergences.join('\n'), /edit docs\/playbook\.md — nothing in the code decides this/);
  });

  test('nothing is approved by importing it', () => {
    runImport(writeWorkbook(directory));

    assert.equal(store.pendingApprovals().length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM approvals').get()!['n'], 0, 'these loans were decided years ago, not by this');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM contracts').get()!['n'], 0);
  });

  test('items admit the workbook never recorded what the collateral was', () => {
    const report = runImport(writeWorkbook(directory));

    const item = store.item(store.importedRow(LEDGER_SHEET, 'ITM0001', 'item')!.entity_id)!;
    assert.equal(item.category_slug, UNRECORDED_CATEGORY);
    assert.equal(item.status, 'redeemed');
    assert.equal(rules.category(UNRECORDED_CATEGORY), null, 'it is not passed off as a category the playbook takes');
    assert.match(report.notes.join(' '), /no column for what the collateral was/);
  });
});

describe('customers', () => {
  test('the customer sheet is preferred over whatever was typed on the day', () => {
    const path = writeWorkbook(directory, {
      loans: [paidRow({ 'Customer Name': 'Aina , paying 2400 at month end' })],
      customers: [['CUST0001', 'Aina Shipanga', '081 555 0101']],
    });
    runImport(path);

    const customer = store.customer(store.importedRow(CUSTOMERS_SHEET, 'CUST0001', 'customer')!.entity_id)!;
    assert.equal(customer.name, 'Aina Shipanga');
    assert.equal(customer.phone, '+264815550101', 'the local form is normalised');
  });

  test('one customer with several loans stays one customer', () => {
    const path = writeWorkbook(directory, {
      loans: [paidRow(), activeRow(), paidRow({ LoanID: 'LN0003', ItemID: 'ITM0003' })],
    });
    const report = runImport(path);

    assert.equal(report.loans.imported, 3);
    assert.equal(store.customers().length, 1);
  });

  test('someone with no number is kept under their workbook reference, not a made-up one', () => {
    const path = writeWorkbook(directory, {
      loans: [paidRow({ 'Customer Phone': null, CustomerID: 'CUST0099' })],
      customers: [['CUST0099', 'Landuleni', null]],
    });
    const report = runImport(path);

    const customer = store.customers()[0]!;
    assert.equal(customer.phone, 'workbook:CUST0099');
    assert.equal(report.customers.withoutPhone, 1);
    assert.match(report.notes.join(' '), /duplicate check puts the pair in front of Lukas/);
  });

  test('a customer already in the system is reused rather than duplicated', () => {
    store.upsertCustomer('+264815550101', 'Aina S.');
    const report = runImport(writeWorkbook(directory));

    assert.equal(store.customers().length, 1);
    assert.equal(report.customers.alreadyKnown, 1);
    assert.equal(report.customers.created, 0);
  });

  test('an imported customer is dated to when they first borrowed', () => {
    runImport(writeWorkbook(directory));
    assert.equal(store.customers()[0]!.created_at!.slice(0, 10), '2025-05-12');
  });

  test('the same person under two spellings is flagged, never merged', () => {
    const path = writeWorkbook(directory, {
      loans: [
        paidRow({ CustomerID: 'CUST0001' }),
        paidRow({ LoanID: 'LN0009', ItemID: 'ITM0009', CustomerID: 'CUST0002', 'Customer Phone': '081 555 0202' }),
      ],
      customers: [
        ['CUST0001', 'David Strubie', '081 555 0101'],
        ['CUST0002', 'Strubie David', '081 555 0202'],
      ],
    });
    const report = runImport(path);

    assert.equal(report.customers.possibleDuplicates, 1);
    assert.equal(store.customers().length, 2, 'both records are kept');
    assert.equal(store.customers().filter((customer) => customer.merged_into).length, 0, 'nothing is merged by the import');

    const [flag] = store.pendingDuplicateFlags();
    assert.ok(flag, 'it waits for a SAME or DIFFERENT ruling');
    assert.match(report.notes.join(' '), /waiting for a SAME or DIFFERENT ruling/);
  });

  test('two different people are not flagged', () => {
    const path = writeWorkbook(directory, {
      loans: [
        paidRow({ CustomerID: 'CUST0001' }),
        paidRow({ LoanID: 'LN0009', ItemID: 'ITM0009', CustomerID: 'CUST0002', 'Customer Phone': '081 555 0202' }),
      ],
      customers: [
        ['CUST0001', 'Aina Shipanga', '081 555 0101'],
        ['CUST0002', 'Bernhard Katiti', '081 555 0202'],
      ],
    });
    const report = runImport(path);

    assert.equal(report.customers.possibleDuplicates, 0);
    assert.equal(store.pendingDuplicateFlags().length, 0);
  });
});

describe('the PINs sitting in the description column', () => {
  test('come out of the description and go in encrypted', () => {
    const path = writeWorkbook(directory, {
      loans: [paidRow({ 'Item Description': 'Aina Shipanga 081 555 0101 (phone password: 230104)' })],
    });
    const report = runImport(path);

    const item = store.item(store.importedRow(LEDGER_SHEET, 'ITM0001', 'item')!.entity_id)!;
    assert.doesNotMatch(item.description, /230104/, 'the PIN is not left in a plain-text column');
    assert.equal(report.items.secretsMovedToEncryptedStore, 1);

    const [photo] = store.photos(item.id);
    assert.equal(photo!.kind, 'device-secret');
    assert.equal(store.media!.get(photo!.media_path).toString('utf8'), 'phone password: 230104');
    assert.doesNotMatch(readFileSync(photo!.media_path).toString('binary'), /230104/, 'and it is encrypted on disk');
  });

  test('a PIN in the name column is caught as well, and stored once', () => {
    const path = writeWorkbook(directory, {
      loans: [paidRow({ 'Customer Name': 'Richard pawn (pin: Happiness)', 'Item Description': 'Richard pawn (pin: Happiness)' })],
      customers: [['CUST0001', 'Richard pawn (pin: Happiness)', '081 555 0101']],
    });
    const report = runImport(path);

    const customer = store.customers()[0]!;
    assert.equal(customer.name, 'Richard pawn', 'no PIN on the record Lukas reads');
    assert.equal(report.items.secretsMovedToEncryptedStore, 1, 'the same PIN in both columns is stored once');
  });

  test('a name that merely contains "pin" is left alone', () => {
    assert.deepEqual(separateSecrets('Ipinge pawn +264 816978957'), {
      description: 'Ipinge pawn +264 816978957',
      secrets: [],
    });
  });

  test('the forms people actually wrote', () => {
    assert.deepEqual(separateSecrets('Uetu pawn 264 818110026 Pin 1997').secrets, ['Pin 1997']);
    assert.deepEqual(separateSecrets('Richard pawn (pin: Happiness)').secrets, ['pin: Happiness']);
    assert.equal(separateSecrets('Indira pin 199214, paying 6 June').description, 'Indira, paying 6 June');
  });
});

describe('running it twice', () => {
  test('the second run posts nothing', () => {
    const path = writeWorkbook(directory);
    runImport(path);
    const entriesAfterFirst = store.db.prepare('SELECT COUNT(*) n FROM ledger_entries').get()!['n'];

    const second = runImport(path);

    assert.equal(second.loans.imported, 0);
    assert.equal(second.loans.skipped, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ledger_entries').get()!['n'], entriesAfterFirst);
  });
});

describe('undoing an import', () => {
  test('every entry is reversed and none is removed', () => {
    const path = writeWorkbook(directory);
    const report = runImport(path);
    const before = store.db.prepare('SELECT COUNT(*) n FROM ledger_entries').get()!['n'] as number;

    const result = store.revertImport(report.importId!, lukas, 'wrong file');

    assert.equal(result.entriesReversed, before);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ledger_entries').get()!['n'], before * 2, 'reversals are added, originals stay');
    assert.equal(store.db.prepare('SELECT SUM(amount_cents) t FROM ledger_entries').get()!['t'], 0, 'and the book nets to nothing');
    assert.equal(store.importBatch(report.importId!)!.status, 'reverted');
  });

  test('the loans say what happened to them', () => {
    const report = runImport(writeWorkbook(directory));
    store.revertImport(report.importId!, lukas, 'wrong file');

    const loan = store.loan(store.importedRow(LEDGER_SHEET, 'LN0001', 'loan')?.entity_id ?? '');
    assert.equal(loan, null, 'the reverted row no longer claims the workbook reference');

    const statuses = store.db.prepare('SELECT DISTINCT status FROM loans').all().map((row) => row['status']);
    assert.deepEqual(statuses, ['import-reverted']);
  });

  test('the corrected workbook can then be imported again', () => {
    const path = writeWorkbook(directory);
    const first = runImport(path);
    store.revertImport(first.importId!, lukas, 'wrong file');

    const second = runImport(path);

    assert.equal(second.loans.imported, 2);
    assert.equal(second.loans.skipped, 0);
    assert.equal(store.customers().length, 1, 'people are not duplicated by a re-import');
  });

  test('it cannot be undone twice', () => {
    const report = runImport(writeWorkbook(directory));
    store.revertImport(report.importId!, lukas, 'wrong file');
    assert.throws(() => store.revertImport(report.importId!, lukas, 'again'), /already been reverted/);
  });
});

describe('a workbook with something wrong in it', () => {
  test('a row whose arithmetic does not add up is reported', () => {
    const path = writeWorkbook(directory, {
      loans: [paidRow({ 'Interest for Period (N$)': 750, 'Interest Paid To Date (N$)': 750 })],
    });
    const report = runImport(path, true);

    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0]!.problem, /interest for the period is N\$750\.00 but 30% of N\$3,000\.00 is N\$900\.00/);
  });

  test('a loan marked paid off that still owes money is reported', () => {
    const path = writeWorkbook(directory, {
      loans: [paidRow({ 'Outstanding Principal (N$)': 500, 'Principal Paid To Date (N$)': 2500 })],
    });
    const report = runImport(path, true);

    assert.match(report.problems.map((problem) => problem.problem).join(' '), /marked paid off but still shows N\$500\.00 outstanding/);
  });

  test('an unreadable row is set aside instead of stopping the import', () => {
    const path = writeWorkbook(directory, {
      loans: [paidRow(), activeRow({ 'Principal Issued (N$)': 0 })],
    });
    const report = runImport(path);

    assert.equal(report.loans.imported, 1);
    assert.deepEqual(report.problems, [{ ref: 'LN0002', problem: 'Principal Issued is not a positive amount' }]);
  });

  test('a file that is not the Eppic workbook is refused by name', () => {
    const path = join(directory, 'other.xlsx');
    writeFileSync(path, buildXlsx([{ name: 'Sheet1', rows: [['hello']] }]));
    assert.throws(() => runImport(path), (error: Error) => {
      assert.ok(error instanceof ImportError);
      assert.match(error.message, /has no "LEDGER" sheet/);
      return true;
    });
  });

  test('a workbook with no customer sheet still imports, using the ledger names', () => {
    const path = writeWorkbook(directory, { omitCustomerSheet: true, loans: [paidRow()] });
    runImport(path);

    assert.equal(store.customers()[0]!.name, 'Aina Shipanga', 'the phone number is stripped out of the name cell');
  });
});

describe('tidying up what people typed', () => {
  test('a name cell loses the phone number stuck on the end of it', () => {
    assert.equal(cleanName('Tamgi 0818777089'), 'Tamgi');
    assert.equal(cleanName('Sebi +264 814474455'), 'Sebi');
    assert.equal(cleanName('Daniel on behalf of Saimi +264818384069'), 'Daniel on behalf of Saimi');
    // Pasted numbers arrive with non-breaking spaces and direction marks.
    assert.equal(cleanName('Darrel +264 81 477 9547‬'), 'Darrel');
  });

  test('but not the notes people write there, which is why the customer sheet wins', () => {
    assert.equal(cleanName('Mulijani , paying 2400 at month end'), 'Mulijani, paying 2400 at month end');
  });

  test('a PIN written into the name column does not survive either', () => {
    // This one matters more than the description: the name is what gets shown
    // back on Lukas's phone when he asks about a customer.
    assert.equal(cleanName('Richard pawn (pin: Happiness)'), 'Richard pawn');
    assert.equal(cleanName('Indira pin 199214, paying 6 June'), 'Indira, paying 6 June');
  });
});
