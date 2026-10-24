/**
 * The spreadsheet reader, against files built here rather than against
 * Lukas's workbook — the real one is full of customers' names and numbers and
 * has no business in a test suite.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Workbook, XlsxError, excelDate, columnIndex } from '../src/xlsx/index.ts';
import { ZipArchive, ZipError } from '../src/xlsx/zip.ts';
import { buildXlsx } from './support/xlsx-fixture.ts';

const workbook = () =>
  new Workbook(
    buildXlsx([
      { name: 'NOTES', rows: [['ignore me']] },
      {
        name: 'LEDGER',
        rows: [
          ['LoanID', 'Customer Name', 'Date Issued', 'Principal Issued (N$)', 'Paid?', 'Note'],
          ['LN0001', 'Anna & Sons <Pty> Ltd', new Date(Date.UTC(2025, 1, 13)), 3000, true, null],
          ['LN0002', 'Bernhard "BB" Katiti', new Date(Date.UTC(2026, 6, 30)), 1500.5, false, { formula: 'D3*0.3', value: 450.15 }],
          [null, null, null, null, null, null],
          ['LN0003', 'Anna & Sons <Pty> Ltd', null, 250, false, { formula: 'IF(1,"ok","no")', value: 'ok' }],
        ],
      },
    ]),
  );

describe('opening a workbook', () => {
  test('finds its sheets by name, whatever order the parts are in', () => {
    assert.deepEqual(workbook().sheetNames, ['NOTES', 'LEDGER']);
    assert.equal(workbook().has('LEDGER'), true);
    assert.equal(workbook().has('ACTIVE LOANS'), false);
  });

  test('names the sheets it does have when asked for one it does not', () => {
    assert.throws(() => workbook().sheet('ACTIVE LOANS'), (error: Error) => {
      assert.ok(error instanceof XlsxError);
      assert.match(error.message, /has: NOTES, LEDGER/);
      return true;
    });
  });

  test('refuses a file that is not a spreadsheet', () => {
    assert.throws(() => new Workbook(Buffer.from('this is a photo, not a workbook')), ZipError);
  });
});

describe('reading cells', () => {
  test('text, numbers and booleans come back as themselves', () => {
    const rows = workbook().sheet('LEDGER');
    assert.equal(rows[1]![0], 'LN0001');
    assert.equal(rows[1]![3], 3000);
    assert.equal(rows[1]![4], true);
    assert.equal(rows[2]![3], 1500.5);
    assert.equal(rows[2]![4], false);
  });

  test('escaped text is unescaped once, not twice', () => {
    assert.equal(workbook().sheet('LEDGER')[1]![1], 'Anna & Sons <Pty> Ltd');
    assert.equal(workbook().sheet('LEDGER')[2]![1], 'Bernhard "BB" Katiti');
  });

  test('a date is a date, not the number Excel stores', () => {
    const value = workbook().sheet('LEDGER')[1]![2];
    assert.ok(value instanceof Date);
    assert.equal(value.toISOString().slice(0, 10), '2025-02-13');
    assert.equal((workbook().sheet('LEDGER')[2]![2] as Date).toISOString().slice(0, 10), '2026-07-30');
  });

  test('money is left as a number even though its format has letters in it', () => {
    // "N$ "#,##0.00 — the N and the $ are inside quotes and must not read as
    // a date format.
    assert.equal(typeof workbook().sheet('LEDGER')[1]![3], 'number');
  });

  test('a formula gives up the result the spreadsheet last saved', () => {
    assert.equal(workbook().sheet('LEDGER')[2]![5], 450.15);
    assert.equal(workbook().sheet('LEDGER')[4]![5], 'ok');
  });

  test('a blank cell holds its place instead of shifting the row', () => {
    const row = workbook().sheet('LEDGER')[4]!;
    assert.equal(row[0], 'LN0003');
    assert.equal(row[2], null, 'the empty date column stays empty');
    assert.equal(row[3], 250, 'and the principal stays in the principal column');
  });
});

describe('rows as records', () => {
  test('keys come from the header row', () => {
    const records = workbook().records('LEDGER');
    assert.deepEqual(Object.keys(records[0]!), ['LoanID', 'Customer Name', 'Date Issued', 'Principal Issued (N$)', 'Paid?', 'Note']);
    assert.equal(records[0]!.LoanID, 'LN0001');
  });

  test('an entirely blank row is not a record', () => {
    const records = workbook().records('LEDGER');
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((record) => record.LoanID), ['LN0001', 'LN0002', 'LN0003']);
  });
});

describe('the bits underneath', () => {
  test('both stored and deflated entries can be read', () => {
    const archive = new ZipArchive(buildXlsx([{ name: 'S', rows: [['a']] }]));
    // The fixture deflates every other entry, so reading them all covers both.
    for (const name of archive.names()) assert.ok(archive.read(name).length >= 0);
    assert.match(archive.readText('xl/workbook.xml'), /<workbook/);
    assert.throws(() => archive.read('xl/nope.xml'), ZipError);
  });

  test('spreadsheet columns map to positions', () => {
    assert.equal(columnIndex('A1'), 0);
    assert.equal(columnIndex('Z9'), 25);
    assert.equal(columnIndex('AA1'), 26);
    assert.equal(columnIndex('AV500'), 47);
  });

  test('the 1900 epoch, including the day that never existed', () => {
    assert.equal(excelDate(45701).toISOString().slice(0, 10), '2025-02-13');
    assert.equal(excelDate(1).toISOString().slice(0, 10), '1900-01-01');
    assert.equal(excelDate(61).toISOString().slice(0, 10), '1900-03-01');
    assert.equal(excelDate(1, true).toISOString().slice(0, 10), '1904-01-02');
  });
});
