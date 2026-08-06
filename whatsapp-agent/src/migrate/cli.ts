/**
 * `npm run import -- <workbook.xlsx>` — brings the Eppic workbook into the
 * database, or reports what it would do.
 *
 * Defaults to a dry run. An import that posts to the ledger is not something
 * to trigger by getting an argument wrong, and reading the report first is
 * the point: it is where the workbook's own arithmetic problems and its
 * disagreements with the playbook show up.
 */

import { argv, exit, env } from 'node:process';
import { loadRules } from '../playbook/index.ts';
import { Store, mediaKeyFromEnv, MediaKeyError } from '../store/index.ts';
import { formatAmount } from '../money.ts';
import { importWorkbook, ImportError, type ImportReport } from './workbook.ts';

const USAGE = `
Usage: npm run import -- <workbook.xlsx> [options]

  --write            Actually import. Without this it is a dry run.
  --db <path>        Database file (default: data/eppic.db, or EPPIC_DB_PATH).
  --media <path>     Encrypted media directory (default: data/media).
  --revert <id>      Undo an earlier import by posting reversing entries.
  --list             Show imports already run against this database.
`;

export async function main(args: string[] = argv.slice(2)): Promise<number> {
  const options = parse(args);
  if (options.help) {
    console.log(USAGE.trim());
    return 0;
  }

  // Only an import writes anything encrypted; listing and reverting do not,
  // and should not send someone hunting for a key they do not need.
  const store = openStore(options.db, options.media, Boolean(options.file));
  try {
    if (options.list) {
      for (const batch of store.imports()) {
        const rows = store.importedRows(batch.id, 'loan').length;
        console.log(`${batch.created_at}  ${batch.id}  ${batch.status.padEnd(8)}  ${rows} loans  ${batch.source}`);
      }
      return 0;
    }

    if (options.revert) {
      const result = store.revertImport(options.revert, actor(store), 'reverted from the command line');
      console.log(`Reversed ${result.entriesReversed} ledger entries across ${result.loansReverted} loans.`);
      console.log('Nothing was deleted — the reversing entries sit alongside the originals.');
      return 0;
    }

    if (!options.file) {
      console.error(USAGE.trim());
      return 1;
    }

    const report = importWorkbook(options.file, store, loadRules(), { actor: actor(store), dryRun: !options.write });
    console.log(render(report));
    return 0;
  } catch (error) {
    if (error instanceof ImportError || error instanceof MediaKeyError) {
      console.error(`\n${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    store.close();
  }
}

function openStore(dbPath: string, mediaDirectory: string, needsMedia: boolean): Store {
  if (!needsMedia) return new Store(dbPath);
  // Without a key the PINs sitting in the workbook's description column have
  // nowhere safe to go, so the import refuses rather than storing them plainly.
  return new Store(dbPath, { mediaDirectory, mediaKey: mediaKeyFromEnv(env) });
}

/** The import is Lukas's action, recorded against him. */
function actor(store: Store): string {
  const owner = store.owner();
  if (owner) return owner.id;
  const name = env['EPPIC_OWNER_NAME'] ?? 'Lukas';
  const phone = env['EPPIC_OWNER_PHONE'];
  if (!phone) throw new ImportError('Set EPPIC_OWNER_PHONE (and optionally EPPIC_OWNER_NAME) so the import is recorded against someone');
  return store.ensureUser({ name, phone, role: 'owner' }).id;
}

export function render(report: ImportReport): string {
  const lines: string[] = [];
  const heading = report.dryRun ? 'DRY RUN — nothing was written' : `Imported (batch ${report.importId})`;
  lines.push('', `${heading}`, `Source: ${report.source}`, `Digest: ${report.sourceSha256.slice(0, 16)}…`, '');

  lines.push('What came across');
  lines.push(`  Loans           ${report.loans.imported} imported, ${report.loans.skipped} already there`);
  lines.push(`                  ${report.loans.active} active, ${report.loans.paidOff} paid off`);
  lines.push(`  Customers       ${report.customers.created} new, ${report.customers.alreadyKnown} already known, ${report.customers.withoutPhone} with no phone number`);
  lines.push(`  Items           ${report.items.created}`);
  lines.push(`  Ledger entries  ${report.ledgerEntries}`);
  if (report.items.secretsMovedToEncryptedStore > 0) {
    lines.push(`  Device PINs     ${report.items.secretsMovedToEncryptedStore} moved out of the name and description columns into encrypted storage`);
  }
  if (report.customers.possibleDuplicates > 0) {
    lines.push(`  Possible dupes  ${report.customers.possibleDuplicates} pairs flagged for you to rule on — nothing merged`);
  }

  lines.push('', 'Money');
  lines.push(`  Principal issued        ${formatAmount(report.totals.principalIssuedCents)}`);
  lines.push(`  Interest charged        ${formatAmount(report.totals.interestChargedCents)}`);
  lines.push(`  Principal repaid        ${formatAmount(report.totals.principalRepaidCents)}`);
  lines.push(`  Interest repaid         ${formatAmount(report.totals.interestRepaidCents)}`);
  lines.push(`  Principal still out     ${formatAmount(report.totals.outstandingCents)}`);
  lines.push('  Check these against the workbook\'s own DASHBOARD before writing.');

  if (report.divergences.length > 0) {
    lines.push('', 'The book and the playbook disagree');
    for (const divergence of report.divergences) lines.push(`  · ${divergence}`);
  }

  if (report.problems.length > 0) {
    lines.push('', `Rows that do not add up (${report.problems.length})`);
    for (const problem of report.problems.slice(0, 20)) lines.push(`  · ${problem.ref}: ${problem.problem}`);
    if (report.problems.length > 20) lines.push(`  · …and ${report.problems.length - 20} more`);
  }

  if (report.notes.length > 0) {
    lines.push('', 'Worth knowing');
    for (const note of report.notes) lines.push(`  · ${note}`);
  }

  if (report.dryRun) lines.push('', 'Run again with --write to import.');
  else lines.push('', `To undo: npm run import -- --revert ${report.importId}`);

  return lines.join('\n');
}

interface Options {
  file: string | null;
  db: string;
  media: string;
  write: boolean;
  list: boolean;
  revert: string | null;
  help: boolean;
}

function parse(args: string[]): Options {
  const options: Options = {
    file: null,
    db: env['EPPIC_DB_PATH'] ?? 'data/eppic.db',
    media: env['EPPIC_MEDIA_DIR'] ?? 'data/media',
    write: false,
    list: false,
    revert: null,
    help: args.length === 0,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--write') options.write = true;
    else if (argument === '--list') options.list = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--db') options.db = args[++index] ?? options.db;
    else if (argument === '--media') options.media = args[++index] ?? options.media;
    else if (argument === '--revert') options.revert = args[++index] ?? null;
    else options.file = argument;
  }
  return options;
}

if (import.meta.url === `file://${argv[1]}`) {
  exit(await main());
}
