# PostgreSQL migration preparation — review required

Status: PREPARED DESIGN, not an executable migration or a deployed change.
Lukas authorised preparation on 30 October 2026. SQLite remains the runtime
database. No live data has been read, exported or migrated by this work.

## Recommendation

Keep the current application working while Claude scopes a PostgreSQL store
adapter. PostgreSQL is the preferred target for multiple cloud application
instances and concurrent writes. Anonymous visitors alone do not make SQLite
unsuitable; traffic, write contention and the hosting topology decide that.
Do not put the SQLite file on a shared network filesystem to scale replicas.

## Required migration boundaries

- Inventory every migration in whatsapp-agent/src/store/schema.ts, every Store
  method, direct database callers and all constraints before generating DDL.
- Preserve IDs, foreign keys, unique constraints, provider-message deduplication,
  contract tokens, dates, price provenance and audit history.
- Use BIGINT for NAD cents, with safe-integer checks at the TypeScript boundary.
  PostgreSQL drivers may return BIGINT as strings: never silently coerce an
  unsafe value or pass a string into existing money arithmetic.
- Preserve the existing two capabilities and owner-only money decisions.
- Preserve append-only ledger behaviour at the database boundary, including
  UPDATE/DELETE rejection. Revoking app-role TRUNCATE and schema ownership is
  also required. Trigger implementation and permissions need explicit review;
  this preparation does not change the existing triggers.
- Replace SQLite rowid ordering with explicit monotonic ordering where code
  relies on insertion order, notably price invalidations and same-time events.
- Convert synchronous DatabaseSync calls and SQLite placeholders, PRAGMAs,
  INSERT OR IGNORE and last-insert access deliberately. Do not substitute an
  async driver underneath synchronous code.
- Enclose approval, contract signing, repayments, extensions and deduplication
  in transactions with explicit concurrency tests. Duplicate webhooks and two
  owner replies must not duplicate a ledger entry or contract.
- Media remains encrypted, private and linked by stable IDs. Multiple app
  instances need durable shared object storage, not each instance's local disk.
  Keep EPPIC_MEDIA_KEY in the hosting secret manager; do not expose it in exports.

## Review and cutover gates

1. Claude approves hosting, region, retention, backup/restore and connection pool
   limits. Select and approve the PostgreSQL driver as a runtime dependency.
2. Implement the adapter and candidate DDL in a separate task with named files.
   Run the same behavioural tests against SQLite and PostgreSQL.
3. Test repeatable staging import using synthetic data first. Never commit a
   customer export. Validate table counts, media references, per-loan ledger
   sums, reversals, dates and history before accepting an import.
4. Restore a staging backup and exercise repayment, signing, extension,
   inspection, duplicate webhooks, owner/staff boundaries and media access.
5. Approve a maintenance window; take a verified backup, pause writes, import,
   reconcile and switch traffic. Do not introduce unreviewed dual writes.
6. Keep the old database read-only for rollback. If new writes reach PostgreSQL,
   rolling back requires reconciliation; pointing at an old SQLite copy would
   lose those writes. Document that decision before cutover.

## Separate prerequisites for a free public estimate service

Request/body limits, per-client and global paid-model budgets, abuse controls,
timeouts and monitoring are needed regardless of database choice. Two-week
estimate reuse reduces repeated research; it is not a rate limiter.

Google sign-in must remain optional for estimates. Before adding it at the
application/account stage, configure an OAuth client and approved HTTPS callback,
then verify identity server-side. A Google email is not proof of ownership of a
WhatsApp number: require phone verification and consent before joining records.
