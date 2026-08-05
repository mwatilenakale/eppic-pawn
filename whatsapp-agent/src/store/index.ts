/**
 * Storage for step 1. SQLite via `node:sqlite` — a real database from the
 * start, per the component brief's third open question, but a single file
 * with no server to run.
 *
 * Two properties matter more than the rest and are enforced here rather than
 * left to callers: the ledger can only be corrected by reversal, and every
 * money or decision event lands in the audit log.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.ts';
import { MediaStore } from './media.ts';

export { MediaStore, generateMediaKey, mediaKeyFromEnv, MediaKeyError } from './media.ts';

export type Role = 'owner' | 'inspector';
export type ApprovalStatus = 'pending' | 'approved' | 'declined';

export interface User { id: string; name: string; phone: string; role: Role }
export interface Customer { id: string; phone: string; name: string | null; id_number: string | null }
export interface Conversation { id: string; customer_id: string; status: 'active' | 'closed'; state: string }
export interface Item {
  id: string;
  customer_id: string;
  conversation_id: string | null;
  category_slug: string;
  variant: string | null;
  description: string;
  declared_details: string;
  status: string;
}
export interface Valuation {
  id: string;
  item_id: string;
  assessed_value_cents: number;
  suggested_loan_cents: number;
  formula: string;
  workings: string;
  override_cents: number | null;
  override_note: string | null;
}
export interface Approval {
  id: string;
  item_id: string;
  valuation_id: string | null;
  conversation_id: string | null;
  status: ApprovalStatus;
  suggested_loan_cents: number | null;
  approved_loan_cents: number | null;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  created_at: string;
}
export interface Loan {
  id: string;
  customer_id: string;
  item_id: string;
  principal_cents: number;
  rate_pct: number;
  rate_rule: string;
  term_days: number;
  interest_cents: number;
  start_date: string;
  due_date: string;
  grace_ends_date: string;
  status: string;
}
export interface LedgerEntry {
  id: string;
  loan_id: string;
  entry_type: string;
  amount_cents: number;
  memo: string;
  actor: string;
  reverses_entry_id: string | null;
  created_at: string;
}
export interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entity_id: string;
  details: string;
}

export interface Contract {
  id: string;
  approval_id: string;
  customer_id: string;
  item_id: string;
  loan_id: string | null;
  number: string;
  token: string;
  principal_cents: number;
  rate_pct: number;
  rate_rule: string;
  term_days: number;
  interest_cents: number;
  total_due_cents: number;
  start_date: string;
  due_date: string;
  grace_ends_date: string;
  body_html: string;
  body_sha256: string;
  status: 'pending' | 'signed' | 'void';
  expires_at: string;
  signed_at: string | null;
  signed_name: string | null;
  signed_id_number: string | null;
  signature_path: string | null;
  created_at: string;
}

export class LedgerError extends Error {}
export class ContractError extends Error {}

export interface StoreOptions {
  /** Directory for encrypted media; omit to disable photo storage. */
  mediaDirectory?: string;
  mediaKey?: Buffer;
  clock?: () => Date;
}

export class Store {
  readonly db: DatabaseSync;
  readonly media: MediaStore | null;
  readonly #now: () => string;

  constructor(path: string, options: StoreOptions = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    migrate(this.db);

    this.media = options.mediaDirectory ? new MediaStore(options.mediaDirectory, options.mediaKey) : null;
    const clock = options.clock ?? (() => new Date());
    this.#now = () => clock().toISOString();
  }

  close(): void {
    this.db.close();
  }

  // --- users -------------------------------------------------------------

  ensureUser(user: { name: string; phone: string; role: Role }): User {
    const existing = this.db.prepare('SELECT * FROM users WHERE phone = ?').get(user.phone) as unknown as User | undefined;
    if (existing) return existing;

    const row: User = { id: randomUUID(), ...user };
    this.db
      .prepare('INSERT INTO users (id, name, phone, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.name, row.phone, row.role, this.#now());
    return row;
  }

  owner(): User | null {
    return (this.db.prepare("SELECT * FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as unknown as User) ?? null;
  }

  // --- customers ---------------------------------------------------------

  customerByPhone(phone: string): Customer | null {
    return (this.db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone) as unknown as Customer) ?? null;
  }

  upsertCustomer(phone: string, name?: string): Customer {
    const existing = this.customerByPhone(phone);
    if (existing) {
      if (name && name !== existing.name) {
        this.db.prepare('UPDATE customers SET name = ?, updated_at = ? WHERE id = ?').run(name, this.#now(), existing.id);
        this.audit({ actor: 'agent', action: 'customer.renamed', entity: 'customer', entityId: existing.id, details: { name } });
        return { ...existing, name };
      }
      return existing;
    }

    const customer: Customer = { id: randomUUID(), phone, name: name ?? null, id_number: null };
    const at = this.#now();
    this.db
      .prepare('INSERT INTO customers (id, phone, name, id_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(customer.id, customer.phone, customer.name, null, at, at);
    this.audit({ actor: 'agent', action: 'customer.created', entity: 'customer', entityId: customer.id, details: { phone } });
    return customer;
  }

  // --- conversations & messages -----------------------------------------

  activeConversation(customerId: string): Conversation | null {
    return (
      (this.db
        .prepare("SELECT * FROM conversations WHERE customer_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
        .get(customerId) as unknown as Conversation) ?? null
    );
  }

  openConversation(customerId: string, state: unknown = {}): Conversation {
    const conversation: Conversation = {
      id: randomUUID(),
      customer_id: customerId,
      status: 'active',
      state: JSON.stringify(state),
    };
    const at = this.#now();
    this.db
      .prepare("INSERT INTO conversations (id, customer_id, status, state, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)")
      .run(conversation.id, customerId, conversation.state, at, at);
    return conversation;
  }

  saveConversationState(conversationId: string, state: unknown): void {
    this.db
      .prepare('UPDATE conversations SET state = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), this.#now(), conversationId);
  }

  closeConversation(conversationId: string): void {
    this.db.prepare("UPDATE conversations SET status = 'closed', updated_at = ? WHERE id = ?").run(this.#now(), conversationId);
  }

  /**
   * Records an inbound message. Returns null when WhatsApp redelivers a
   * message we already handled, so retries never double-run the intake step.
   */
  recordInbound(message: { conversationId: string; providerMessageId?: string | null; body?: string; mediaId?: string | null }): string | null {
    if (message.providerMessageId) {
      const seen = this.db
        .prepare('SELECT id FROM messages WHERE provider_message_id = ?')
        .get(message.providerMessageId);
      if (seen) return null;
    }

    const id = randomUUID();
    this.db
      .prepare("INSERT INTO messages (id, conversation_id, direction, provider_message_id, body, media_id, created_at) VALUES (?, ?, 'in', ?, ?, ?, ?)")
      .run(id, message.conversationId, message.providerMessageId ?? null, message.body ?? '', message.mediaId ?? null, this.#now());
    return id;
  }

  recordOutbound(message: { conversationId: string; body: string; providerMessageId?: string | null }): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO messages (id, conversation_id, direction, provider_message_id, body, media_id, created_at) VALUES (?, ?, 'out', ?, ?, NULL, ?)")
      .run(id, message.conversationId, message.providerMessageId ?? null, message.body, this.#now());
    return id;
  }

  messages(conversationId: string): { direction: 'in' | 'out'; body: string; created_at: string }[] {
    return this.db
      .prepare('SELECT direction, body, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid')
      .all(conversationId) as { direction: 'in' | 'out'; body: string; created_at: string }[];
  }

  // --- items, photos, inspections ---------------------------------------

  createItem(item: {
    customerId: string;
    conversationId?: string | null;
    categorySlug: string;
    variant?: string | null;
    description?: string;
    status?: string;
  }): Item {
    const row: Item = {
      id: randomUUID(),
      customer_id: item.customerId,
      conversation_id: item.conversationId ?? null,
      category_slug: item.categorySlug,
      variant: item.variant ?? null,
      description: item.description ?? '',
      declared_details: '{}',
      status: item.status ?? 'intake',
    };
    const at = this.#now();
    this.db
      .prepare('INSERT INTO items (id, customer_id, conversation_id, category_slug, variant, description, declared_details, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.customer_id, row.conversation_id, row.category_slug, row.variant, row.description, row.declared_details, row.status, at, at);
    this.audit({ actor: 'agent', action: 'item.created', entity: 'item', entityId: row.id, details: { category: row.category_slug } });
    return row;
  }

  updateItem(itemId: string, changes: { description?: string; declaredDetails?: unknown; status?: string; variant?: string | null }): void {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (changes.description !== undefined) { sets.push('description = ?'); values.push(changes.description); }
    if (changes.declaredDetails !== undefined) { sets.push('declared_details = ?'); values.push(JSON.stringify(changes.declaredDetails)); }
    if (changes.status !== undefined) { sets.push('status = ?'); values.push(changes.status); }
    if (changes.variant !== undefined) { sets.push('variant = ?'); values.push(changes.variant); }
    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    values.push(this.#now(), itemId);
    this.db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    if (changes.status !== undefined) {
      this.audit({ actor: 'agent', action: 'item.status', entity: 'item', entityId: itemId, details: { status: changes.status } });
    }
  }

  item(itemId: string): Item | null {
    return (this.db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as unknown as Item) ?? null;
  }

  /** Stores a photo encrypted on disk and links it to the item. */
  addPhoto(photo: { itemId: string; kind: string; content: Buffer; extension?: string }): { id: string; path: string } {
    if (!this.media) throw new Error('Store was created without a media directory — cannot store photos');
    const stored = this.media.put(photo.content, photo.extension ?? 'jpg');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO item_photos (id, item_id, kind, media_path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, photo.itemId, photo.kind, stored.path, stored.sha256, this.#now());
    return { id, path: stored.path };
  }

  photos(itemId: string): { id: string; kind: string; media_path: string; sha256: string }[] {
    return this.db
      .prepare('SELECT id, kind, media_path, sha256 FROM item_photos WHERE item_id = ? ORDER BY created_at')
      .all(itemId) as { id: string; kind: string; media_path: string; sha256: string }[];
  }

  saveInspection(inspection: {
    itemId: string;
    stage: 'remote' | 'in-person';
    results: unknown;
    outstanding?: unknown;
    complete?: boolean;
    recordedBy?: string | null;
  }): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO inspections (id, item_id, stage, results, outstanding, complete, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        inspection.itemId,
        inspection.stage,
        JSON.stringify(inspection.results),
        JSON.stringify(inspection.outstanding ?? []),
        inspection.complete ? 1 : 0,
        inspection.recordedBy ?? null,
        this.#now(),
      );
    return id;
  }

  // --- valuations --------------------------------------------------------

  saveValuation(valuation: {
    itemId: string;
    estimates: unknown;
    assessedValueCents: number;
    suggestedLoanCents: number;
    formula: string;
    workings: unknown;
  }): Valuation {
    const row: Valuation = {
      id: randomUUID(),
      item_id: valuation.itemId,
      assessed_value_cents: valuation.assessedValueCents,
      suggested_loan_cents: valuation.suggestedLoanCents,
      formula: valuation.formula,
      workings: JSON.stringify(valuation.workings),
      override_cents: null,
      override_note: null,
    };
    this.db
      .prepare('INSERT INTO valuations (id, item_id, estimates, assessed_value_cents, suggested_loan_cents, formula, workings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.item_id, JSON.stringify(valuation.estimates), row.assessed_value_cents, row.suggested_loan_cents, row.formula, row.workings, this.#now());
    return row;
  }

  /** Keeps the engine's number and records Lukas's alongside it. */
  recordValuationOverride(valuationId: string, overrideCents: number, note: string, actor: string): void {
    this.db.prepare('UPDATE valuations SET override_cents = ?, override_note = ? WHERE id = ?').run(overrideCents, note, valuationId);
    this.audit({ actor, action: 'valuation.override', entity: 'valuation', entityId: valuationId, details: { overrideCents, note } });
  }

  // --- approvals ---------------------------------------------------------

  createApproval(approval: {
    itemId: string;
    valuationId?: string | null;
    conversationId?: string | null;
    suggestedLoanCents: number | null;
  }): Approval {
    const row: Approval = {
      id: randomUUID(),
      item_id: approval.itemId,
      valuation_id: approval.valuationId ?? null,
      conversation_id: approval.conversationId ?? null,
      status: 'pending',
      suggested_loan_cents: approval.suggestedLoanCents ?? null,
      approved_loan_cents: null,
      decided_by: null,
      decided_at: null,
      note: null,
      created_at: this.#now(),
    };
    this.db
      .prepare("INSERT INTO approvals (id, item_id, valuation_id, conversation_id, status, suggested_loan_cents, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(row.id, row.item_id, row.valuation_id, row.conversation_id, row.suggested_loan_cents, row.created_at);
    this.audit({ actor: 'agent', action: 'approval.requested', entity: 'approval', entityId: row.id, details: { suggestedLoanCents: row.suggested_loan_cents } });
    return row;
  }

  approval(approvalId: string): Approval | null {
    return (this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as unknown as Approval) ?? null;
  }

  pendingApprovals(): Approval[] {
    return this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all() as unknown as Approval[];
  }

  /** The decision is always a person's; the agent only records it. */
  decideApproval(decision: {
    approvalId: string;
    status: Exclude<ApprovalStatus, 'pending'>;
    approvedLoanCents?: number | null;
    decidedBy: string;
    note?: string;
  }): Approval {
    const current = this.approval(decision.approvalId);
    if (!current) throw new Error(`No such approval: ${decision.approvalId}`);
    if (current.status !== 'pending') throw new Error(`Approval ${decision.approvalId} was already ${current.status}`);

    const at = this.#now();
    this.db
      .prepare('UPDATE approvals SET status = ?, approved_loan_cents = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?')
      .run(decision.status, decision.approvedLoanCents ?? null, decision.decidedBy, at, decision.note ?? null, decision.approvalId);
    this.audit({
      actor: decision.decidedBy,
      action: `approval.${decision.status}`,
      entity: 'approval',
      entityId: decision.approvalId,
      details: { approvedLoanCents: decision.approvedLoanCents ?? null, note: decision.note ?? null },
    });
    return this.approval(decision.approvalId)!;
  }

  // --- loans & ledger ----------------------------------------------------

  createLoan(loan: {
    customerId: string;
    itemId: string;
    approvalId?: string | null;
    principalCents: number;
    ratePct: number;
    rateRule: string;
    termDays: number;
    interestCents: number;
    startDate: string;
    dueDate: string;
    graceEndsDate: string;
    actor: string;
  }): Loan {
    const row: Loan = {
      id: randomUUID(),
      customer_id: loan.customerId,
      item_id: loan.itemId,
      principal_cents: loan.principalCents,
      rate_pct: loan.ratePct,
      rate_rule: loan.rateRule,
      term_days: loan.termDays,
      interest_cents: loan.interestCents,
      start_date: loan.startDate,
      due_date: loan.dueDate,
      grace_ends_date: loan.graceEndsDate,
      status: 'active',
    };
    const at = this.#now();
    this.db
      .prepare('INSERT INTO loans (id, customer_id, item_id, approval_id, principal_cents, rate_pct, rate_rule, term_days, interest_cents, start_date, due_date, grace_ends_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.customer_id, row.item_id, loan.approvalId ?? null, row.principal_cents, row.rate_pct, row.rate_rule, row.term_days, row.interest_cents, row.start_date, row.due_date, row.grace_ends_date, row.status, at, at);
    this.audit({ actor: loan.actor, action: 'loan.created', entity: 'loan', entityId: row.id, details: { principalCents: row.principal_cents, ratePct: row.rate_pct } });
    return row;
  }

  loan(loanId: string): Loan | null {
    return (this.db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId) as unknown as Loan) ?? null;
  }

  /** Appends a ledger entry. Entries are never edited afterwards. */
  postLedgerEntry(entry: { loanId: string; entryType: string; amountCents: number; memo?: string; actor: string }): LedgerEntry {
    const row: LedgerEntry = {
      id: randomUUID(),
      loan_id: entry.loanId,
      entry_type: entry.entryType,
      amount_cents: entry.amountCents,
      memo: entry.memo ?? '',
      actor: entry.actor,
      reverses_entry_id: null,
      created_at: this.#now(),
    };
    this.db
      .prepare('INSERT INTO ledger_entries (id, loan_id, entry_type, amount_cents, memo, actor, reverses_entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(row.id, row.loan_id, row.entry_type, row.amount_cents, row.memo, row.actor, row.created_at);
    this.audit({ actor: entry.actor, action: 'ledger.posted', entity: 'ledger_entry', entityId: row.id, details: { loanId: row.loan_id, amountCents: row.amount_cents, entryType: row.entry_type } });
    return row;
  }

  /**
   * Corrects a mistake the only way this system allows: a new entry that
   * reverses the old one, with both kept and both visible (architecture 2.7).
   */
  reverseLedgerEntry(reversal: { entryId: string; actor: string; reason: string }): LedgerEntry {
    const original = this.ledgerEntry(reversal.entryId);
    if (!original) throw new LedgerError(`No such ledger entry: ${reversal.entryId}`);
    if (original.reverses_entry_id) throw new LedgerError('A reversal cannot itself be reversed — post a fresh entry instead');

    const already = this.db.prepare('SELECT id FROM ledger_entries WHERE reverses_entry_id = ?').get(reversal.entryId);
    if (already) throw new LedgerError(`Entry ${reversal.entryId} has already been reversed`);

    const row: LedgerEntry = {
      id: randomUUID(),
      loan_id: original.loan_id,
      entry_type: `${original.entry_type}.reversal`,
      amount_cents: -original.amount_cents,
      memo: reversal.reason,
      actor: reversal.actor,
      reverses_entry_id: original.id,
      created_at: this.#now(),
    };
    this.db
      .prepare('INSERT INTO ledger_entries (id, loan_id, entry_type, amount_cents, memo, actor, reverses_entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.loan_id, row.entry_type, row.amount_cents, row.memo, row.actor, row.reverses_entry_id, row.created_at);
    this.audit({ actor: reversal.actor, action: 'ledger.reversed', entity: 'ledger_entry', entityId: original.id, details: { reversalId: row.id, reason: reversal.reason } });
    return row;
  }

  ledgerEntry(entryId: string): LedgerEntry | null {
    return (this.db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(entryId) as unknown as LedgerEntry) ?? null;
  }

  ledger(loanId: string): LedgerEntry[] {
    return this.db
      .prepare('SELECT * FROM ledger_entries WHERE loan_id = ? ORDER BY created_at, rowid')
      .all(loanId) as unknown as LedgerEntry[];
  }

  /** Outstanding balance: every entry, reversals included, summed. */
  balance(loanId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger_entries WHERE loan_id = ?')
      .get(loanId) as { total: number };
    return Number(row.total);
  }

  // --- contracts ---------------------------------------------------------

  /** `EPP-2026-0007` — sequential within the year the contract is issued. */
  nextContractNumber(year: number): string {
    const row = this.db
      .prepare("SELECT COUNT(*) AS used FROM contracts WHERE number LIKE ?")
      .get(`EPP-${year}-%`) as { used: number };
    return `EPP-${year}-${String(Number(row.used) + 1).padStart(4, '0')}`;
  }

  createContract(contract: {
    approvalId: string;
    customerId: string;
    itemId: string;
    number: string;
    token: string;
    principalCents: number;
    ratePct: number;
    rateRule: string;
    termDays: number;
    interestCents: number;
    totalDueCents: number;
    startDate: string;
    dueDate: string;
    graceEndsDate: string;
    bodyHtml: string;
    expiresAt: string;
    actor: string;
  }): Contract {
    const row: Contract = {
      id: randomUUID(),
      approval_id: contract.approvalId,
      customer_id: contract.customerId,
      item_id: contract.itemId,
      loan_id: null,
      number: contract.number,
      token: contract.token,
      principal_cents: contract.principalCents,
      rate_pct: contract.ratePct,
      rate_rule: contract.rateRule,
      term_days: contract.termDays,
      interest_cents: contract.interestCents,
      total_due_cents: contract.totalDueCents,
      start_date: contract.startDate,
      due_date: contract.dueDate,
      grace_ends_date: contract.graceEndsDate,
      body_html: contract.bodyHtml,
      body_sha256: createHash('sha256').update(contract.bodyHtml).digest('hex'),
      status: 'pending',
      expires_at: contract.expiresAt,
      signed_at: null,
      signed_name: null,
      signed_id_number: null,
      signature_path: null,
      created_at: this.#now(),
    };

    this.db
      .prepare(
        'INSERT INTO contracts (id, approval_id, customer_id, item_id, loan_id, number, token, principal_cents, rate_pct, rate_rule, term_days, interest_cents, total_due_cents, start_date, due_date, grace_ends_date, body_html, body_sha256, status, expires_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id, row.approval_id, row.customer_id, row.item_id, row.number, row.token, row.principal_cents,
        row.rate_pct, row.rate_rule, row.term_days, row.interest_cents, row.total_due_cents, row.start_date,
        row.due_date, row.grace_ends_date, row.body_html, row.body_sha256, row.status, row.expires_at, row.created_at,
      );

    this.audit({
      actor: contract.actor,
      action: 'contract.issued',
      entity: 'contract',
      entityId: row.id,
      details: { number: row.number, principalCents: row.principal_cents, bodySha256: row.body_sha256 },
    });
    return row;
  }

  contract(contractId: string): Contract | null {
    return (this.db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId) as unknown as Contract) ?? null;
  }

  contractByToken(token: string): Contract | null {
    return (this.db.prepare('SELECT * FROM contracts WHERE token = ?').get(token) as unknown as Contract) ?? null;
  }

  contractsForApproval(approvalId: string): Contract[] {
    return this.db
      .prepare('SELECT * FROM contracts WHERE approval_id = ? ORDER BY created_at')
      .all(approvalId) as unknown as Contract[];
  }

  /** Records the signature and links the loan the signature started. */
  signContract(signature: {
    contractId: string;
    name: string;
    idNumber: string;
    image?: Buffer;
    loanId: string;
    actor: string;
  }): Contract {
    const current = this.contract(signature.contractId);
    if (!current) throw new Error(`No such contract: ${signature.contractId}`);
    if (current.status !== 'pending') throw new ContractError(`Contract ${current.number} is already ${current.status}`);

    const stored = signature.image && this.media ? this.media.put(signature.image, 'png') : null;
    const at = this.#now();

    this.db
      .prepare(
        "UPDATE contracts SET status = 'signed', signed_at = ?, signed_name = ?, signed_id_number = ?, signature_path = ?, loan_id = ? WHERE id = ?",
      )
      .run(at, signature.name, signature.idNumber, stored?.path ?? null, signature.loanId, signature.contractId);

    this.audit({
      actor: signature.actor,
      action: 'contract.signed',
      entity: 'contract',
      entityId: current.id,
      details: { number: current.number, loanId: signature.loanId, name: signature.name },
    });
    return this.contract(signature.contractId)!;
  }

  voidContract(contractId: string, reason: string, actor: string): Contract {
    const current = this.contract(contractId);
    if (!current) throw new Error(`No such contract: ${contractId}`);
    if (current.status === 'signed') throw new ContractError('A signed contract cannot be voided');

    this.db.prepare("UPDATE contracts SET status = 'void' WHERE id = ?").run(contractId);
    this.audit({ actor, action: 'contract.voided', entity: 'contract', entityId: contractId, details: { reason } });
    return this.contract(contractId)!;
  }

  // --- audit -------------------------------------------------------------

  audit(entry: { actor: string; action: string; entity: string; entityId: string; details?: unknown }): void {
    this.db
      .prepare('INSERT INTO audit_log (id, at, actor, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), this.#now(), entry.actor, entry.action, entry.entity, entry.entityId, JSON.stringify(entry.details ?? {}));
  }

  auditTrail(entity: string, entityId: string): AuditRow[] {
    return this.db
      .prepare('SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY at, rowid')
      .all(entity, entityId) as unknown as unknown as AuditRow[];
  }
}

function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let index = version; index < MIGRATIONS.length; index += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[index]!);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
