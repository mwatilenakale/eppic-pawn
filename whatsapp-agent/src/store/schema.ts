/**
 * Schema for step 1, trimmed to the MVP tables in architecture section 3.
 * The fuller list (commissions, storage_locations, buyers, disputes) is
 * deliberately not here until it is a felt gap.
 *
 * Migrations are append-only and tracked with `PRAGMA user_version`.
 */

export const MIGRATIONS: string[] = [
  // 1 — customers, conversations and the intake record
  `
  CREATE TABLE users (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    phone        TEXT NOT NULL UNIQUE,
    -- Lukas decides; the hire inspects and reports. No other tiers exist.
    role         TEXT NOT NULL CHECK (role IN ('owner', 'inspector')),
    created_at   TEXT NOT NULL
  );

  CREATE TABLE customers (
    id           TEXT PRIMARY KEY,
    phone        TEXT NOT NULL UNIQUE,
    name         TEXT,
    id_number    TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE conversations (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL REFERENCES customers(id),
    status       TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    -- Serialised intake state machine position.
    state        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX conversations_customer ON conversations(customer_id, status);

  CREATE TABLE messages (
    id                   TEXT PRIMARY KEY,
    conversation_id      TEXT NOT NULL REFERENCES conversations(id),
    direction            TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    -- WhatsApp's own id, used to drop duplicate webhook deliveries.
    provider_message_id  TEXT UNIQUE,
    body                 TEXT NOT NULL DEFAULT '',
    media_id             TEXT,
    created_at           TEXT NOT NULL
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, created_at);

  CREATE TABLE items (
    id                TEXT PRIMARY KEY,
    customer_id       TEXT NOT NULL REFERENCES customers(id),
    conversation_id   TEXT REFERENCES conversations(id),
    category_slug     TEXT NOT NULL,
    variant           TEXT,
    description       TEXT NOT NULL DEFAULT '',
    -- Answers to the screening questions, as {checklistItemId: answer}.
    declared_details  TEXT NOT NULL DEFAULT '{}',
    status            TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE item_photos (
    id            TEXT PRIMARY KEY,
    item_id       TEXT NOT NULL REFERENCES items(id),
    kind          TEXT NOT NULL,
    -- Encrypted blob on disk; identity documents never sit in plaintext.
    media_path    TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX item_photos_item ON item_photos(item_id);

  CREATE TABLE inspections (
    id          TEXT PRIMARY KEY,
    item_id     TEXT NOT NULL REFERENCES items(id),
    -- 'remote' = customer's own answers; 'in-person' = the hire's check.
    stage       TEXT NOT NULL CHECK (stage IN ('remote', 'in-person')),
    results     TEXT NOT NULL,
    outstanding TEXT NOT NULL DEFAULT '[]',
    complete    INTEGER NOT NULL DEFAULT 0,
    recorded_by TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX inspections_item ON inspections(item_id);

  CREATE TABLE valuations (
    id                    TEXT PRIMARY KEY,
    item_id               TEXT NOT NULL REFERENCES items(id),
    estimates             TEXT NOT NULL,
    assessed_value_cents  INTEGER NOT NULL,
    suggested_loan_cents  INTEGER NOT NULL,
    formula               TEXT NOT NULL,
    workings              TEXT NOT NULL DEFAULT '[]',
    -- Engine output and Lukas's override are both kept (architecture 2.2).
    override_cents        INTEGER,
    override_note         TEXT,
    created_at            TEXT NOT NULL
  );
  CREATE INDEX valuations_item ON valuations(item_id);

  CREATE TABLE approvals (
    id                    TEXT PRIMARY KEY,
    item_id               TEXT NOT NULL REFERENCES items(id),
    valuation_id          TEXT REFERENCES valuations(id),
    conversation_id       TEXT REFERENCES conversations(id),
    status                TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
    -- Null when no market estimate exists yet and Lukas sets the amount himself.
    suggested_loan_cents  INTEGER,
    approved_loan_cents   INTEGER,
    decided_by            TEXT REFERENCES users(id),
    decided_at            TEXT,
    note                  TEXT,
    created_at            TEXT NOT NULL
  );
  CREATE INDEX approvals_status ON approvals(status, created_at);

  CREATE TABLE loans (
    id                TEXT PRIMARY KEY,
    customer_id       TEXT NOT NULL REFERENCES customers(id),
    item_id           TEXT NOT NULL REFERENCES items(id),
    approval_id       TEXT REFERENCES approvals(id),
    principal_cents   INTEGER NOT NULL,
    rate_pct          REAL NOT NULL,
    rate_rule         TEXT NOT NULL,
    term_days         INTEGER NOT NULL,
    interest_cents    INTEGER NOT NULL,
    start_date        TEXT NOT NULL,
    due_date          TEXT NOT NULL,
    grace_ends_date   TEXT NOT NULL,
    status            TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE ledger_entries (
    id                 TEXT PRIMARY KEY,
    loan_id            TEXT NOT NULL REFERENCES loans(id),
    entry_type         TEXT NOT NULL,
    amount_cents       INTEGER NOT NULL,
    memo               TEXT NOT NULL DEFAULT '',
    actor              TEXT NOT NULL,
    -- Corrections are new reversing entries; the original always stays.
    reverses_entry_id  TEXT REFERENCES ledger_entries(id),
    created_at         TEXT NOT NULL
  );
  CREATE INDEX ledger_entries_loan ON ledger_entries(loan_id, created_at);
  CREATE UNIQUE INDEX ledger_entries_one_reversal ON ledger_entries(reverses_entry_id)
    WHERE reverses_entry_id IS NOT NULL;

  -- The ledger is append-only at the database level, not merely by convention.
  CREATE TRIGGER ledger_entries_immutable_update BEFORE UPDATE ON ledger_entries
  BEGIN
    SELECT RAISE(ABORT, 'ledger entries are immutable — post a reversing entry instead');
  END;

  CREATE TRIGGER ledger_entries_immutable_delete BEFORE DELETE ON ledger_entries
  BEGIN
    SELECT RAISE(ABORT, 'ledger entries cannot be deleted — post a reversing entry instead');
  END;

  CREATE TABLE audit_log (
    id          TEXT PRIMARY KEY,
    at          TEXT NOT NULL,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    entity      TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    details     TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX audit_log_entity ON audit_log(entity, entity_id, at);
  `,

  // 2 — contracts, generated from an approved application and signed before handover
  `
  CREATE TABLE contracts (
    id                TEXT PRIMARY KEY,
    approval_id       TEXT NOT NULL REFERENCES approvals(id),
    customer_id       TEXT NOT NULL REFERENCES customers(id),
    item_id           TEXT NOT NULL REFERENCES items(id),
    -- Set when the customer signs: the loan starts at handover, not at approval.
    loan_id           TEXT REFERENCES loans(id),
    -- Human reference, e.g. EPP-2026-0007.
    number            TEXT NOT NULL UNIQUE,
    -- Secret in the signing link. Not guessable, not reused.
    token             TEXT NOT NULL UNIQUE,
    principal_cents   INTEGER NOT NULL,
    rate_pct          REAL NOT NULL,
    rate_rule         TEXT NOT NULL,
    term_days         INTEGER NOT NULL,
    interest_cents    INTEGER NOT NULL,
    total_due_cents   INTEGER NOT NULL,
    start_date        TEXT NOT NULL,
    due_date          TEXT NOT NULL,
    grace_ends_date   TEXT NOT NULL,
    -- The exact document put in front of the customer, kept verbatim.
    body_html         TEXT NOT NULL,
    body_sha256       TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('pending', 'signed', 'void')),
    expires_at        TEXT NOT NULL,
    signed_at         TEXT,
    signed_name       TEXT,
    signed_id_number  TEXT,
    -- Encrypted signature image on disk.
    signature_path    TEXT,
    created_at        TEXT NOT NULL
  );
  CREATE INDEX contracts_approval ON contracts(approval_id);
  CREATE INDEX contracts_status ON contracts(status, created_at);

  -- What was signed must stay exactly as it was signed. A wrong contract is
  -- voided and reissued, never edited.
  CREATE TRIGGER contracts_body_immutable BEFORE UPDATE OF body_html, body_sha256 ON contracts
  BEGIN
    SELECT RAISE(ABORT, 'a contract body cannot be edited — void it and issue a new one');
  END;
  `,

  // 3 — possible-duplicate customers (architecture 2.6). Records are never
  // merged automatically: a pair is flagged, Lukas rules on it, and both rows
  // stay with the duplicate pointing at the record that survives.
  `
  ALTER TABLE customers ADD COLUMN merged_into TEXT REFERENCES customers(id);

  CREATE TABLE duplicate_flags (
    id                 TEXT PRIMARY KEY,
    -- Always stored with the older record first, so a pair is only flagged once.
    customer_id        TEXT NOT NULL REFERENCES customers(id),
    other_customer_id  TEXT NOT NULL REFERENCES customers(id),
    score              REAL NOT NULL,
    reasons            TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('pending', 'same', 'different')),
    decided_by         TEXT REFERENCES users(id),
    decided_at         TEXT,
    created_at         TEXT NOT NULL
  );
  CREATE UNIQUE INDEX duplicate_flags_pair ON duplicate_flags(customer_id, other_customer_id);
  CREATE INDEX duplicate_flags_status ON duplicate_flags(status, created_at);
  `,

  // 4 — website pre-checks. No name, no number, no photos: the website asks for
  // nothing that identifies anyone, so this is a record of demand, not of people.
  `
  CREATE TABLE prechecks (
    id             TEXT PRIMARY KEY,
    category_slug  TEXT NOT NULL,
    variant        TEXT,
    description    TEXT NOT NULL DEFAULT '',
    answers        TEXT NOT NULL DEFAULT '{}',
    status         TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX prechecks_category ON prechecks(category_slug, created_at);
  `,
];
