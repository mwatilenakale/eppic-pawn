/**
 * Bringing the Eppic workbook into the database (architecture step 7).
 *
 * Three things govern how this is written.
 *
 * **The workbook is history, not policy.** Every loan is imported at the rate,
 * term and grace period it actually ran at, taken from the row. It is *not*
 * recalculated from `docs/playbook.md` — a book that ran at 30% does not
 * become a book that ran at 29% because the playbook says so today. Where the
 * two disagree the import says so in its report and leaves the decision with
 * Lukas, which is the only way a rate can ever change round here.
 *
 * **An import must be safe to get wrong.** The ledger cannot be edited or
 * deleted from, so a mistake cannot be cleaned up by tidying rows. Instead
 * every record is tagged with the workbook reference that produced it: a
 * second run skips what it already did, and `Store.revertImport` undoes a bad
 * one by posting reversing entries.
 *
 * **Nothing here approves anything.** This is bookkeeping for loans Lukas
 * already made and already decided on. It creates no approvals and asks for
 * none.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Workbook, type CellValue } from '../xlsx/index.ts';
import { Store } from '../store/index.ts';
import { normalizePhone } from '../whatsapp/webhook.ts';
import { loanTerms, addDays, ValuationError } from '../valuation.ts';
import { formatAmount, round } from '../money.ts';
import type { Rules } from '../playbook/index.ts';

export const LEDGER_SHEET = 'LEDGER';
export const CUSTOMERS_SHEET = 'CUSTOMERS & COLLATERAL';

/**
 * The workbook's Item Description column holds whatever was jotted down at
 * the counter — usually the customer's name, and sometimes the device's PIN.
 * Playbook section 9 already flags that as a problem ("needs a safer place,
 * not the Ledger itself"), so the import takes it out of the description and
 * puts it in the encrypted store instead.
 */
const SECRET_WORD = String.raw`(?:pin|password|passcode|pass\s?code|pattern)`;
/** A whole parenthetical that mentions one: `(laptop password 314159)`. */
const SECRET_IN_BRACKETS = new RegExp(String.raw`\(([^)]*\b${SECRET_WORD}\b[^)]*)\)`, 'gi');
/** Or the bare form: `pin 250893`, `Pin: 1997`. */
const SECRET_INLINE = new RegExp(String.raw`\b${SECRET_WORD}\b\s*[:\-]?\s*([^\s,.;]+)`, 'gi');

/** The workbook has no column for what the item was, so nothing can be assumed. */
export const UNRECORDED_CATEGORY = 'unrecorded';

export class ImportError extends Error {}

export interface ImportOptions {
  /** User id of whoever is running the import — recorded on every entry. */
  actor: string;
  /** Reads and reports without writing anything. */
  dryRun?: boolean;
}

export interface ImportProblem {
  ref: string;
  problem: string;
}

export interface ImportReport {
  source: string;
  sourceSha256: string;
  importId: string | null;
  dryRun: boolean;
  customers: { created: number; alreadyKnown: number; withoutPhone: number };
  items: { created: number; secretsMovedToEncryptedStore: number };
  loans: { imported: number; skipped: number; active: number; paidOff: number };
  ledgerEntries: number;
  totals: {
    principalIssuedCents: number;
    interestChargedCents: number;
    principalRepaidCents: number;
    interestRepaidCents: number;
    outstandingCents: number;
  };
  /** Where the workbook's own arithmetic does not add up. */
  problems: ImportProblem[];
  /** Where the book Lukas ran differs from the playbook as it stands today. */
  divergences: string[];
  notes: string[];
}

interface LedgerRow {
  ref: string;
  status: 'active' | 'paid';
  customerRef: string;
  itemRef: string;
  name: string;
  phone: string | null;
  description: string;
  secrets: string[];
  principalCents: number;
  interestCents: number;
  interestPaidCents: number;
  principalPaidCents: number;
  outstandingCents: number;
  ratePct: number;
  termDays: number;
  graceDays: number;
  startDate: string;
  dueDate: string;
  graceEndsDate: string;
}

export function importWorkbook(path: string, store: Store, rules: Rules, options: ImportOptions): ImportReport {
  const workbook = Workbook.fromFile(path);
  const source = basename(path);
  const sourceSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');

  if (!workbook.has(LEDGER_SHEET)) {
    throw new ImportError(`${source} has no "${LEDGER_SHEET}" sheet — it has: ${workbook.sheetNames.join(', ')}`);
  }

  const report: ImportReport = {
    source,
    sourceSha256,
    importId: null,
    dryRun: Boolean(options.dryRun),
    customers: { created: 0, alreadyKnown: 0, withoutPhone: 0 },
    items: { created: 0, secretsMovedToEncryptedStore: 0 },
    loans: { imported: 0, skipped: 0, active: 0, paidOff: 0 },
    ledgerEntries: 0,
    totals: {
      principalIssuedCents: 0,
      interestChargedCents: 0,
      principalRepaidCents: 0,
      interestRepaidCents: 0,
      outstandingCents: 0,
    },
    problems: [],
    divergences: [],
    notes: [],
  };

  const directory = readCustomerSheet(workbook);
  const rows: LedgerRow[] = [];

  for (const record of workbook.records(LEDGER_SHEET)) {
    const ref = text(record['LoanID']);
    if (!ref) continue;
    try {
      rows.push(parseLedgerRow(record, directory));
    } catch (error) {
      report.problems.push({ ref, problem: (error as Error).message });
    }
  }

  if (rows.length === 0) throw new ImportError(`${source} has no loan rows to import`);

  checkArithmetic(rows, report);
  compareWithPlaybook(rows, rules, report);
  describeWhatTheWorkbookCannotSay(rows, report);

  if (options.dryRun) {
    project(rows, report);
    return report;
  }

  const batch = store.startImport({ source, sourceSha256, actor: options.actor });
  report.importId = batch.id;

  for (const row of rows) {
    if (store.importedRow(LEDGER_SHEET, row.ref, 'loan')) {
      report.loans.skipped += 1;
      continue;
    }
    writeLoan(row, store, batch.id, options.actor, report);
  }

  store.finishImport(batch.id, report);
  return report;
}

/**
 * What a real run would produce. A dry run that reported zeroes would be
 * worse than useless — the totals are the thing to check against the
 * workbook's own DASHBOARD before letting anything near the ledger.
 */
function project(rows: LedgerRow[], report: ImportReport): void {
  const customers = new Set<string>();
  const customersWithoutPhone = new Set<string>();
  const items = new Set<string>();

  for (const row of rows) {
    customers.add(row.customerRef);
    if (!row.phone) customersWithoutPhone.add(row.customerRef);
    items.add(row.itemRef);

    report.loans.imported += 1;
    if (row.status === 'paid') report.loans.paidOff += 1;
    else report.loans.active += 1;

    report.items.secretsMovedToEncryptedStore += row.secrets.length;
    report.ledgerEntries += 2 + (row.interestPaidCents > 0 ? 1 : 0) + (row.principalPaidCents > 0 ? 1 : 0);

    report.totals.principalIssuedCents += row.principalCents;
    report.totals.interestChargedCents += row.interestCents;
    report.totals.interestRepaidCents += row.interestPaidCents;
    report.totals.principalRepaidCents += row.principalPaidCents;
    report.totals.outstandingCents += row.outstandingCents;
  }

  report.customers.created = customers.size;
  report.customers.withoutPhone = customersWithoutPhone.size;
  report.items.created = items.size;
}

// --- reading the sheets ----------------------------------------------------

interface DirectoryEntry {
  name: string;
  phone: string | null;
}

/**
 * The CUSTOMERS & COLLATERAL sheet holds one row per customer, which is a
 * better source for a name than the ledger row — ledger rows carry whatever
 * was typed that day ("Mulijani , paying 2400 at month end").
 */
function readCustomerSheet(workbook: Workbook): Map<string, DirectoryEntry> {
  const directory = new Map<string, DirectoryEntry>();
  if (!workbook.has(CUSTOMERS_SHEET)) return directory;

  for (const record of workbook.records(CUSTOMERS_SHEET)) {
    const ref = text(record['CustomerID']);
    if (!ref) continue;
    directory.set(ref, {
      name: cleanName(text(record['Customer Name'])),
      phone: readPhone(record['Customer Phone']),
    });
  }
  return directory;
}

function parseLedgerRow(record: Record<string, CellValue>, directory: Map<string, DirectoryEntry>): LedgerRow {
  const ref = text(record['LoanID']);
  const customerRef = text(record['CustomerID']) || `${ref}-customer`;
  const known = directory.get(customerRef);

  const principalCents = cents(record['Principal Issued (N$)'], 'Principal Issued');
  if (principalCents <= 0) throw new ImportError('Principal Issued is not a positive amount');

  const startDate = isoDate(record['Date Issued'], 'Date Issued');
  const termDays = whole(record['Term (Days)']) ?? 30;
  const graceDays = whole(record['Grace (Days)']) ?? 0;

  const rawStatus = text(record['Status']).toLowerCase();
  const status = rawStatus.startsWith('paid') ? 'paid' : 'active';

  const { description, secrets } = separateSecrets(text(record['Item Description']));

  return {
    ref,
    status,
    customerRef,
    itemRef: text(record['ItemID']) || `${ref}-item`,
    name: known?.name || cleanName(text(record['Customer Name'])),
    phone: known?.phone ?? readPhone(record['Customer Phone']),
    description,
    secrets,
    principalCents,
    interestCents: cents(record['Interest for Period (N$)'], 'Interest for Period'),
    interestPaidCents: cents(record['Interest Paid To Date (N$)'], 'Interest Paid To Date'),
    principalPaidCents: cents(record['Principal Paid To Date (N$)'], 'Principal Paid To Date'),
    outstandingCents: cents(record['Outstanding Principal (N$)'], 'Outstanding Principal'),
    // The sheet stores 0.3; the rest of this system says 30.
    ratePct: round((number(record['Monthly Interest Rate']) ?? 0) * 10000) / 100,
    termDays,
    graceDays,
    startDate,
    dueDate: optionalIsoDate(record['Next Due Date']) ?? addDays(startDate, termDays),
    graceEndsDate:
      optionalIsoDate(record['Grace Expiry']) ?? addDays(optionalIsoDate(record['Next Due Date']) ?? addDays(startDate, termDays), graceDays),
  };
}

/**
 * Pulls a device PIN out of a description and hands it back separately, so it
 * can be encrypted rather than left sitting in a plain-text column.
 */
export function separateSecrets(description: string): { description: string; secrets: string[] } {
  const secrets: string[] = [];

  const take = (pattern: RegExp) => (match: string, inside: string) => {
    if (!inside.trim()) return match;
    secrets.push(pattern === SECRET_IN_BRACKETS ? inside.trim() : match.trim());
    return ' ';
  };

  const cleaned = description
    .replace(SECRET_IN_BRACKETS, take(SECRET_IN_BRACKETS))
    .replace(SECRET_INLINE, take(SECRET_INLINE))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/[\s,.;]+$/, '')
    .trim();

  return { description: cleaned, secrets };
}

// --- writing --------------------------------------------------------------

function writeLoan(row: LedgerRow, store: Store, importId: string, actor: string, report: ImportReport): void {
  const customerId = ensureCustomer(row, store, importId, report);
  const itemId = ensureItem(row, customerId, store, importId, report);

  const loan = store.createLoan({
    customerId,
    itemId,
    principalCents: row.principalCents,
    ratePct: row.ratePct,
    // Not a playbook rule id: this rate is what the row records, and saying so
    // keeps it from being read as a rule the playbook still endorses.
    rateRule: `workbook:${row.ref}`,
    termDays: row.termDays,
    interestCents: row.interestCents,
    startDate: row.startDate,
    dueDate: row.dueDate,
    graceEndsDate: row.graceEndsDate,
    status: row.status,
    actor,
    at: `${row.startDate}T00:00:00.000Z`,
  });
  store.recordImportedRow({ importId, sourceSheet: LEDGER_SHEET, sourceRef: row.ref, entity: 'loan', entityId: loan.id });

  post(store, report, {
    loanId: loan.id,
    entryType: 'principal',
    amountCents: row.principalCents,
    memo: `${row.ref} — principal issued (imported from the workbook)`,
    actor,
    at: `${row.startDate}T00:00:00.000Z`,
  });
  post(store, report, {
    loanId: loan.id,
    entryType: 'interest',
    amountCents: row.interestCents,
    memo: `${row.ref} — ${row.ratePct}% over ${row.termDays} days, as recorded in the workbook`,
    actor,
    at: `${row.startDate}T00:00:01.000Z`,
  });

  // The workbook records that a loan was repaid but never when — the payment
  // date column is empty on every row. Repayments are therefore dated to the
  // due date and say so, rather than quietly claiming a date nobody wrote down.
  const paidAt = `${row.dueDate}T00:00:00.000Z`;
  if (row.interestPaidCents > 0) {
    post(store, report, {
      loanId: loan.id,
      entryType: 'repayment.interest',
      amountCents: -row.interestPaidCents,
      memo: `${row.ref} — interest repaid (workbook total; the exact date was not recorded)`,
      actor,
      at: paidAt,
    });
  }
  if (row.principalPaidCents > 0) {
    post(store, report, {
      loanId: loan.id,
      entryType: 'repayment.principal',
      amountCents: -row.principalPaidCents,
      memo: `${row.ref} — principal repaid (workbook total; the exact date was not recorded)`,
      actor,
      at: `${row.dueDate}T00:00:01.000Z`,
    });
  }

  report.loans.imported += 1;
  if (row.status === 'paid') report.loans.paidOff += 1;
  else report.loans.active += 1;

  report.totals.principalIssuedCents += row.principalCents;
  report.totals.interestChargedCents += row.interestCents;
  report.totals.interestRepaidCents += row.interestPaidCents;
  report.totals.principalRepaidCents += row.principalPaidCents;
  report.totals.outstandingCents += row.outstandingCents;
}

function post(store: Store, report: ImportReport, entry: Parameters<Store['postLedgerEntry']>[0]): void {
  store.postLedgerEntry(entry);
  report.ledgerEntries += 1;
}

/**
 * A customer with no phone number in the workbook still needs a record, and
 * `customers.phone` is unique and required. The workbook's own reference
 * stands in — it can never collide with a real WhatsApp number, so an
 * imported customer with no number stays separate until someone messages in
 * and the duplicate check (architecture 2.6) puts the two in front of Lukas.
 */
function ensureCustomer(row: LedgerRow, store: Store, importId: string, report: ImportReport): string {
  const existing = store.importedRow(CUSTOMERS_SHEET, row.customerRef, 'customer');
  if (existing) return existing.entity_id;

  const phone = row.phone ?? `workbook:${row.customerRef}`;
  if (!row.phone) report.customers.withoutPhone += 1;

  const before = store.customerByPhone(phone);
  const customer = store.upsertCustomer(phone, row.name || undefined, `${row.startDate}T00:00:00.000Z`);
  if (before) report.customers.alreadyKnown += 1;
  else report.customers.created += 1;

  store.recordImportedRow({
    importId,
    sourceSheet: CUSTOMERS_SHEET,
    sourceRef: row.customerRef,
    entity: 'customer',
    entityId: customer.id,
  });
  return customer.id;
}

function ensureItem(row: LedgerRow, customerId: string, store: Store, importId: string, report: ImportReport): string {
  const existing = store.importedRow(LEDGER_SHEET, row.itemRef, 'item');
  if (existing) return existing.entity_id;

  const item = store.createItem({
    customerId,
    categorySlug: UNRECORDED_CATEGORY,
    description: row.description,
    status: row.status === 'paid' ? 'redeemed' : 'pledged',
    at: `${row.startDate}T00:00:00.000Z`,
  });
  report.items.created += 1;

  for (const secret of row.secrets) {
    if (!store.media) {
      report.problems.push({ ref: row.ref, problem: 'A device PIN was in the description but there is no encrypted store to move it to' });
      break;
    }
    store.addPhoto({ itemId: item.id, kind: 'device-secret', content: Buffer.from(secret, 'utf8'), extension: 'txt' });
    report.items.secretsMovedToEncryptedStore += 1;
  }

  store.recordImportedRow({ importId, sourceSheet: LEDGER_SHEET, sourceRef: row.itemRef, entity: 'item', entityId: item.id });
  return item.id;
}

// --- what the import has to tell Lukas ------------------------------------

/** Rows whose own numbers do not agree with each other. */
function checkArithmetic(rows: LedgerRow[], report: ImportReport): void {
  for (const row of rows) {
    const expectedInterest = round((row.principalCents * row.ratePct) / 100);
    if (Math.abs(expectedInterest - row.interestCents) > 1) {
      report.problems.push({
        ref: row.ref,
        problem: `interest for the period is ${formatAmount(row.interestCents)} but ${row.ratePct}% of ${formatAmount(row.principalCents)} is ${formatAmount(expectedInterest)}`,
      });
    }
    if (row.principalCents - row.principalPaidCents !== row.outstandingCents) {
      report.problems.push({
        ref: row.ref,
        problem: `outstanding principal is ${formatAmount(row.outstandingCents)} but issued minus repaid is ${formatAmount(row.principalCents - row.principalPaidCents)}`,
      });
    }
    if (row.status === 'paid' && row.outstandingCents !== 0) {
      report.problems.push({ ref: row.ref, problem: `marked paid off but still shows ${formatAmount(row.outstandingCents)} outstanding` });
    }
  }
}

/**
 * The playbook is the rule for what happens next; it is not retrospective.
 * This reports the gaps so Lukas can decide whether the playbook or the book
 * is out of date — a decision no import is entitled to make on its own.
 */
function compareWithPlaybook(rows: LedgerRow[], rules: Rules, report: ImportReport): void {
  const rateMismatches = new Map<string, number>();
  let termMismatches = 0;
  let graceMismatches = 0;

  for (const row of rows) {
    let expected;
    try {
      expected = loanTerms({ principalCents: row.principalCents }, rules);
    } catch (error) {
      if (error instanceof ValuationError) continue;
      throw error;
    }

    if (Math.abs(expected.ratePct - row.ratePct) > 0.001) {
      const key = `${row.ratePct}% where the playbook's "${expected.rule.scenario}" row says ${expected.ratePct}%`;
      rateMismatches.set(key, (rateMismatches.get(key) ?? 0) + 1);
    }
    if (expected.termDays !== row.termDays) termMismatches += 1;
    if (expected.graceDays !== row.graceDays) graceMismatches += 1;
  }

  for (const [description, count] of [...rateMismatches].sort((left, right) => right[1] - left[1])) {
    report.divergences.push(`${count} loan${count === 1 ? '' : 's'} ran at ${description}.`);
  }
  if (termMismatches > 0) {
    report.divergences.push(`${termMismatches} loans ran on a different term from the one the playbook's rate table gives for that amount.`);
  }
  if (graceMismatches > 0) {
    report.divergences.push(
      `${graceMismatches} loans used a grace period other than the playbook's ${rules.playbook.grace.defaultDays} days.`,
    );
  }
  if (report.divergences.length > 0) {
    report.divergences.push(
      'Imported loans keep the terms they actually ran at. If the playbook is what is out of date, edit docs/playbook.md — nothing in the code decides this.',
    );
  }
}

/** Honest about the columns the workbook simply does not have. */
function describeWhatTheWorkbookCannotSay(rows: LedgerRow[], report: ImportReport): void {
  report.notes.push(
    `The workbook has no column for what the collateral was, so all ${rows.length} items are imported as "${UNRECORDED_CATEGORY}" with the description as written.`,
  );
  report.notes.push('It records that a loan was repaid but not when, so repayments are dated to the due date.');
  report.notes.push('No screening answers, photos or signed agreements exist for these loans — they predate the system.');

  const withoutPhone = new Set(rows.filter((row) => !row.phone).map((row) => row.customerRef)).size;
  if (withoutPhone > 0) {
    report.notes.push(
      `${withoutPhone} customers have no phone number in the workbook. They are kept under their workbook reference, so when one messages in they arrive as a new record and the duplicate check puts the pair in front of Lukas.`,
    );
  }
}

// --- cell coercion --------------------------------------------------------

function text(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function number(value: CellValue | undefined): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''));
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function cents(value: CellValue | undefined, label: string): number {
  const amount = number(value);
  if (amount === null) {
    if (value === null || value === '') return 0;
    throw new ImportError(`${label} is not a number: ${String(value)}`);
  }
  return round(amount * 100);
}

function whole(value: CellValue | undefined): number | null {
  const amount = number(value);
  return amount === null ? null : Math.round(amount);
}

function isoDate(value: CellValue | undefined, label: string): string {
  const date = optionalIsoDate(value);
  if (!date) throw new ImportError(`${label} is missing or unreadable`);
  return date;
}

function optionalIsoDate(value: CellValue | undefined): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value.trim())) return value.trim().slice(0, 10);
  return null;
}

function readPhone(value: CellValue | undefined): string | null {
  const raw = text(value);
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  // Fewer than seven digits is a note, not a number.
  if (digits.replace(/\D/g, '').length < 7) return null;
  return normalizePhone(digits);
}

/**
 * Strips the phone number and the running commentary people write into a name
 * cell, leaving the part that is actually a name.
 */
export function cleanName(value: string): string {
  return value
    // Non-breaking spaces and direction marks ride along with pasted numbers.
    .replace(/[\u00a0\u2000-\u200f\u202a-\u202e]/g, ' ')
    .replace(/\+?\d[\d\s-]{5,}\d/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.-]+|[\s,.-]+$/g, '')
    .trim();
}

