/**
 * `npm run link` — a dashboard link for Lukas, or for whoever he hires.
 *
 * Built on 1 November 2026 because a live test could not get past the
 * inspection. The staff dashboard and the inspection worksheet are reached by
 * a signed link, `Store.issueStaffToken` mints one, and nothing called it from
 * outside a test — so there was no way to open either page on a real database.
 * With no inspection possible, *RELEASE* always answers "has not been
 * inspected yet" and the whole second gate is unreachable.
 *
 * The token is shown once, here, and only its SHA-256 is stored. Losing it
 * means issuing another; there is no way to read it back, which is the point.
 */

import { argv, exit, env } from 'node:process';
import { resolve } from 'node:path';
import { Store, mediaKeyFromEnv, MediaKeyError } from '../store/index.ts';
import { normalizePhone } from '../whatsapp/webhook.ts';

const USAGE = `
Usage: npm run link [-- options]

  With no options: a link for the owner, read from OWNER_PHONE and OWNER_NAME.

  --inspector "<name>" <phone>   Create (or find) a member of staff who
                                 inspects items, and print their link.
  --base <url>                   Link prefix (default: PUBLIC_BASE_URL).
  --db <path>                    Database file (default: EPPIC_DB_PATH, or
                                 data/eppic.db).
  --list                         Show links already issued, without the tokens.
  --revoke <id>                  Revoke one, by the id shown in --list.

Examples:
  npm run link
  npm run link -- --inspector "Petrus Haufiku" "081 555 0101"
  npm run link -- --list
`;

interface Options {
  help: boolean;
  list: boolean;
  revoke: string | null;
  inspector: { name: string; phone: string } | null;
  base: string;
  db: string;
}

export function parse(args: string[], environment: NodeJS.ProcessEnv = env): Options {
  const options: Options = {
    help: false,
    list: false,
    revoke: null,
    inspector: null,
    base: (environment['PUBLIC_BASE_URL'] ?? 'http://localhost:8080').replace(/\/$/, ''),
    db: resolve(environment['EPPIC_DB_PATH'] ?? 'data/eppic.db'),
  };

  for (let at = 0; at < args.length; at += 1) {
    const argument = args[at]!;
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--list') options.list = true;
    else if (argument === '--revoke') options.revoke = args[++at] ?? null;
    else if (argument === '--base') options.base = (args[++at] ?? options.base).replace(/\/$/, '');
    else if (argument === '--db') options.db = resolve(args[++at] ?? options.db);
    else if (argument === '--inspector') {
      const name = args[++at];
      const phone = args[++at];
      if (!name || !phone) throw new Error('--inspector needs a name and a phone number');
      options.inspector = { name, phone };
    } else throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

export async function main(args: string[] = argv.slice(2)): Promise<number> {
  let options: Options;
  try {
    options = parse(args);
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE.trim()}`);
    return 1;
  }
  if (options.help) {
    console.log(USAGE.trim());
    return 0;
  }

  let mediaKey: Buffer | undefined;
  try {
    mediaKey = mediaKeyFromEnv(env);
  } catch (error) {
    // A link does not touch media, so a missing key is not fatal here — but
    // say so, because it *is* fatal for `npm start`.
    if (!(error instanceof MediaKeyError)) throw error;
    console.error('Note: EPPIC_MEDIA_KEY is not set. Fine for this, not for npm start.\n');
  }

  const store = new Store(options.db, { mediaKey });
  try {
    if (options.list) {
      const tokens = store.staffTokens();
      if (tokens.length === 0) {
        console.log('No links issued yet.');
        return 0;
      }
      for (const token of tokens) {
        const user = store.user(token.user_id);
        const state = token.revoked_at ? 'REVOKED' : token.last_used_at ? `last used ${token.last_used_at.slice(0, 10)}` : 'never used';
        console.log(`${token.id}  ${user?.name ?? 'unknown'} (${user?.role ?? '?'})  ${token.label}  ${state}`);
      }
      console.log('\nThe tokens themselves are not stored, only their hashes, so they cannot be shown again.');
      return 0;
    }

    if (options.revoke) {
      const owner = store.owner();
      if (!owner) {
        console.error('No owner on this database yet. Run npm start once so the owner is created.');
        return 1;
      }
      store.revokeStaffToken(options.revoke, owner.id);
      console.log(`Revoked ${options.revoke}. That link stops working immediately.`);
      return 0;
    }

    const user = options.inspector
      ? store.ensureUser({
          name: options.inspector.name,
          phone: normalizePhone(options.inspector.phone),
          role: 'inspector',
        })
      : store.ensureUser({
          name: env['OWNER_NAME'] ?? 'Lukas',
          phone: normalizePhone(env['OWNER_PHONE'] ?? ''),
          role: 'owner',
        });

    if (!user.phone || user.phone === '+') {
      console.error('Set OWNER_PHONE in .env first, or pass --inspector with a phone number.');
      return 1;
    }

    const { token, id } = store.issueStaffToken(user.id, options.inspector ? 'inspection' : 'owner dashboard');
    console.log(`${user.name} (${user.role}) — ${user.phone}`);
    console.log('');
    console.log(`  Dashboard:   ${options.base}/staff/${token}`);
    console.log(`  Inspections: ${options.base}/staff/${token}/inspections`);
    console.log('');
    console.log(`Link id ${id}, for npm run link -- --revoke ${id}.`);
    console.log('Shown once. Only its hash is stored, so copy it now.');
    console.log('Anyone holding this link is this person — send it the way you would send a password.');
    return 0;
  } finally {
    store.close();
  }
}

if (import.meta.filename === argv[1]) {
  exit(await main());
}
