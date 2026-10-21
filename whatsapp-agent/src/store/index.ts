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
import { generateStaffToken, hashStaffToken } from '../staff/access.ts';

export { MediaStore, generateMediaKey, mediaKeyFromEnv, MediaKeyError } from './media.ts';

export type Role = 'owner' | 'inspector';
export type ApprovalStatus = 'pending' | 'approved' | 'declined';

export interface User { id: string; name: string; phone: string; role: Role }
export interface Customer {
  id: string;
  phone: string;
  name: string | null;
  id_number: string | null;
  /** Set when Lukas rules that this record is the same person as another. */
  merged_into?: string | null;
  created_at?: string;
}

export interface DuplicateFlag {
  id: string;
  customer_id: string;
  other_customer_id: string;
  score: number;
  reasons: string;
  status: 'pending' | 'same' | 'different';
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}
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
/**
 * A question to Lukas about an item outside the five categories — playbook
 * section 2, "Something else". Not an approval: this asks whether the shop
 * will look at the thing at all, before any money is discussed.
 */
export interface CategoryRequest {
  id: string;
  customer_id: string;
  conversation_id: string | null;
  description: string;
  status: 'pending' | 'accepted' | 'refused';
  reason: string;
  decided_by: string | null;
  decided_at: string | null;
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

export interface ImportBatch {
  id: string;
  source: string;
  source_sha256: string;
  status: 'complete' | 'reverted';
  summary: string;
  actor: string;
  created_at: string;
  reverted_at: string | null;
  reverted_note: string | null;
}

export interface ImportedRow {
  id: string;
  import_id: string;
  source_sheet: string;
  source_ref: string;
  entity: 'customer' | 'item' | 'loan';
  entity_id: string;
  reverted: number;
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

  /**
   * The member of staff on this number, or null for everybody else.
   *
   * Matched on the last nine digits, the same way customer numbers are, so
   * that 081 812 3456 and +264811823456 are one person. A number that is not
   * in `users` is a customer — there is no third state.
   */
  userByPhone(phone: string): User | null {
    const tail = phone.replace(/\D/g, '').slice(-9);
    if (tail.length < 9) return null;
    return (
      (this.db
        .prepare("SELECT * FROM users WHERE replace(replace(replace(phone, ' ', ''), '+', ''), '-', '') LIKE ?")
        .get(`%${tail}`) as unknown as User | undefined) ?? null
    );
  }

  // --- staff links --------------------------------------------------------

  /**
   * Issues a link for a member of staff. The token is returned once, here,
   * and never again — only its digest is kept.
   */
  issueStaffToken(userId: string, label = ''): { token: string; id: string } {
    const token = generateStaffToken();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO staff_tokens (id, user_id, token_sha256, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, hashStaffToken(token), label, this.#now());
    this.audit({ actor: userId, action: 'staff.token.issued', entity: 'user', entityId: userId, details: { label } });
    return { token, id };
  }

  /** Who is holding this link, or null. Revoked and unknown look the same. */
  staffByToken(token: string): User | null {
    const row = this.db
      .prepare(
        `SELECT u.* FROM staff_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_sha256 = ? AND t.revoked_at IS NULL`,
      )
      .get(hashStaffToken(token)) as unknown as User | undefined;
    if (!row) return null;

    this.db.prepare('UPDATE staff_tokens SET last_used_at = ? WHERE token_sha256 = ?').run(this.#now(), hashStaffToken(token));
    return row;
  }

  /** Revoking is a timestamp: who had access and when stays on the record. */
  revokeStaffToken(tokenId: string, revokedBy: string): void {
    this.db.prepare('UPDATE staff_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL')
      .run(this.#now(), revokedBy, tokenId);
    this.audit({ actor: revokedBy, action: 'staff.token.revoked', entity: 'staff_token', entityId: tokenId });
  }

  staffTokens(): { id: string; user_id: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null }[] {
    return this.db
      .prepare('SELECT id, user_id, label, created_at, last_used_at, revoked_at FROM staff_tokens ORDER BY created_at')
      .all() as unknown as { id: string; user_id: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null }[];
  }

  owner(): User | null {
    return (this.db.prepare("SELECT * FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as unknown as User) ?? null;
  }

  // --- customers ---------------------------------------------------------

  customerByPhone(phone: string): Customer | null {
    return (this.db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone) as unknown as Customer) ?? null;
  }

  /**
   * `since` back-dates the record to when the relationship actually began —
   * used when importing history, so an old customer does not look new.
   */
  upsertCustomer(phone: string, name?: string, since?: string): Customer {
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
    const at = since ?? this.#now();
    this.db
      .prepare('INSERT INTO customers (id, phone, name, id_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(customer.id, customer.phone, customer.name, null, at, at);
    this.audit({ actor: 'agent', action: 'customer.created', entity: 'customer', entityId: customer.id, details: { phone } });
    return customer;
  }

  customer(customerId: string): Customer | null {
    return (this.db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as unknown as Customer) ?? null;
  }

  customers(): Customer[] {
    return this.db.prepare('SELECT * FROM customers ORDER BY created_at').all() as unknown as Customer[];
  }

  /** Records the name and ID number a customer gave, e.g. when signing. */
  updateCustomerIdentity(customerId: string, identity: { name?: string; idNumber?: string }, actor: string): Customer {
    const sets: string[] = [];
    const values: string[] = [];
    if (identity.name) { sets.push('name = ?'); values.push(identity.name); }
    if (identity.idNumber) { sets.push('id_number = ?'); values.push(identity.idNumber); }
    if (sets.length === 0) return this.customer(customerId)!;

    sets.push('updated_at = ?');
    values.push(this.#now(), customerId);
    this.db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    this.audit({
      actor,
      action: 'customer.identified',
      entity: 'customer',
      entityId: customerId,
      details: { name: identity.name ?? null, idNumberGiven: Boolean(identity.idNumber) },
    });
    return this.customer(customerId)!;
  }

  // --- possible duplicates (architecture 2.6) ----------------------------

  /** Flags a pair for Lukas. The same pair is never flagged twice. */
  raiseDuplicateFlag(flag: {
    customerId: string;
    otherCustomerId: string;
    score: number;
    reasons: string[];
  }): DuplicateFlag | null {
    // Order the pair so A/B and B/A are the same row.
    const [first, second] = [flag.customerId, flag.otherCustomerId].sort() as [string, string];
    const existing = this.db
      .prepare('SELECT * FROM duplicate_flags WHERE customer_id = ? AND other_customer_id = ?')
      .get(first, second) as unknown as DuplicateFlag | undefined;
    if (existing) return null;

    const row: DuplicateFlag = {
      id: randomUUID(),
      customer_id: first,
      other_customer_id: second,
      score: flag.score,
      reasons: JSON.stringify(flag.reasons),
      status: 'pending',
      decided_by: null,
      decided_at: null,
      created_at: this.#now(),
    };
    this.db
      .prepare("INSERT INTO duplicate_flags (id, customer_id, other_customer_id, score, reasons, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
      .run(row.id, row.customer_id, row.other_customer_id, row.score, row.reasons, row.created_at);
    // Audit both records: whoever looks at either customer should see it.
    for (const [subject, other] of [[first, second], [second, first]] as const) {
      this.audit({
        actor: 'agent',
        action: 'duplicate.flagged',
        entity: 'customer',
        entityId: subject,
        details: { otherCustomerId: other, score: flag.score, reasons: flag.reasons },
      });
    }
    return row;
  }

  duplicateFlag(flagId: string): DuplicateFlag | null {
    return (this.db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId) as unknown as DuplicateFlag) ?? null;
  }

  pendingDuplicateFlags(): DuplicateFlag[] {
    return this.db
      .prepare("SELECT * FROM duplicate_flags WHERE status = 'pending' ORDER BY score DESC, created_at")
      .all() as unknown as DuplicateFlag[];
  }

  duplicateFlagsFor(customerId: string): DuplicateFlag[] {
    return this.db
      .prepare('SELECT * FROM duplicate_flags WHERE customer_id = ? OR other_customer_id = ? ORDER BY created_at')
      .all(customerId, customerId) as unknown as DuplicateFlag[];
  }

  /** Lukas's ruling. `same` links the records; neither row is ever deleted. */
  resolveDuplicateFlag(decision: { flagId: string; status: 'same' | 'different'; decidedBy: string }): DuplicateFlag {
    const flag = this.duplicateFlag(decision.flagId);
    if (!flag) throw new Error(`No such duplicate flag: ${decision.flagId}`);
    if (flag.status !== 'pending') throw new Error(`That pair was already marked ${flag.status}`);

    const at = this.#now();
    this.db
      .prepare('UPDATE duplicate_flags SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
      .run(decision.status, decision.decidedBy, at, decision.flagId);
    for (const [subject, other] of [
      [flag.customer_id, flag.other_customer_id],
      [flag.other_customer_id, flag.customer_id],
    ] as const) {
      this.audit({
        actor: decision.decidedBy,
        action: `duplicate.${decision.status}`,
        entity: 'customer',
        entityId: subject,
        details: { otherCustomerId: other },
      });
    }
    return this.duplicateFlag(decision.flagId)!;
  }

  /** Points one record at another. Both rows stay; nothing is overwritten. */
  mergeCustomer(duplicateId: string, survivorId: string, actor: string): void {
    if (duplicateId === survivorId) return;
    this.db.prepare('UPDATE customers SET merged_into = ?, updated_at = ? WHERE id = ?').run(survivorId, this.#now(), duplicateId);
    this.audit({
      actor,
      action: 'customer.merged',
      entity: 'customer',
      entityId: duplicateId,
      details: { mergedInto: survivorId },
    });
  }

  /** Follows the merge chain to the record that survived. */
  survivingCustomer(customerId: string): Customer | null {
    let current = this.customer(customerId);
    const seen = new Set<string>();
    while (current?.merged_into && !seen.has(current.id)) {
      seen.add(current.id);
      current = this.customer(current.merged_into);
    }
    return current;
  }

  // --- conversations & messages -----------------------------------------

  /** One conversation by id, open or closed. */
  conversationById(conversationId: string): Conversation | null {
    return (
      (this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as unknown as Conversation) ??
      null
    );
  }

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
    /** Back-dates an imported item to when it was actually taken in. */
    at?: string;
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
    const at = item.at ?? this.#now();
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

  valuation(valuationId: string): Valuation | null {
    return (this.db.prepare('SELECT * FROM valuations WHERE id = ?').get(valuationId) as unknown as Valuation) ?? null;
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

  /**
   * Moves the suggested figure without deciding the application. Adjusting a
   * price is not approving a loan — the row stays pending either way.
   */
  updateApprovalSuggestion(approvalId: string, suggestedLoanCents: number, actor: string): Approval {
    const before = this.approval(approvalId);
    this.db.prepare('UPDATE approvals SET suggested_loan_cents = ? WHERE id = ? AND status = ?').run(suggestedLoanCents, approvalId, 'pending');
    this.audit({
      actor,
      action: 'approval.adjusted',
      entity: 'approval',
      entityId: approvalId,
      details: { from: before?.suggested_loan_cents ?? null, to: suggestedLoanCents },
    });
    return this.approval(approvalId)!;
  }

  approval(approvalId: string): Approval | null {
    return (this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as unknown as Approval) ?? null;
  }

  pendingApprovals(): Approval[] {
    return this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all() as unknown as Approval[];
  }

  // --- "can we take this at all?" (playbook section 2) --------------------

  /**
   * Records that Lukas has been asked about an item outside the five
   * categories. One open question per customer; asking him twice about the
   * same person is how he starts ignoring the messages.
   */
  askAboutCategory(request: {
    customerId: string;
    conversationId?: string | null;
    description: string;
  }): CategoryRequest {
    const existing = this.pendingCategoryRequestFor(request.customerId);
    if (existing) return existing;

    const row: CategoryRequest = {
      id: randomUUID(),
      customer_id: request.customerId,
      conversation_id: request.conversationId ?? null,
      description: request.description,
      status: 'pending',
      reason: '',
      decided_by: null,
      decided_at: null,
    };
    this.db
      .prepare(
        'INSERT INTO category_requests (id, customer_id, conversation_id, description, status, reason, created_at)' +
          " VALUES (?, ?, ?, ?, 'pending', '', ?)",
      )
      .run(row.id, row.customer_id, row.conversation_id, row.description, this.#now());
    this.audit({
      actor: 'agent',
      action: 'category.asked',
      entity: 'category_request',
      entityId: row.id,
      details: { description: request.description },
    });
    return row;
  }

  categoryRequest(id: string): CategoryRequest | null {
    return (
      (this.db.prepare('SELECT * FROM category_requests WHERE id = ?').get(id) as unknown as CategoryRequest) ?? null
    );
  }

  pendingCategoryRequests(): CategoryRequest[] {
    return this.db
      .prepare("SELECT * FROM category_requests WHERE status = 'pending' ORDER BY created_at")
      .all() as unknown as CategoryRequest[];
  }

  pendingCategoryRequestFor(customerId: string): CategoryRequest | null {
    return (
      (this.db
        .prepare("SELECT * FROM category_requests WHERE customer_id = ? AND status = 'pending'")
        .get(customerId) as unknown as CategoryRequest) ?? null
    );
  }

  /** Lukas's answer. The agent never writes anything but 'pending' here. */
  decideCategoryRequest(decision: {
    id: string;
    status: 'accepted' | 'refused';
    reason?: string;
    decidedBy: string;
  }): CategoryRequest {
    const current = this.categoryRequest(decision.id);
    if (!current) throw new Error(`No such category request: ${decision.id}`);
    if (current.status !== 'pending') throw new Error(`Already ${current.status}`);

    const at = this.#now();
    this.db
      .prepare('UPDATE category_requests SET status = ?, reason = ?, decided_by = ?, decided_at = ? WHERE id = ?')
      .run(decision.status, decision.reason ?? '', decision.decidedBy, at, decision.id);
    this.audit({
      actor: decision.decidedBy,
      action: `category.${decision.status}`,
      entity: 'category_request',
      entityId: decision.id,
      details: { description: current.description, reason: decision.reason ?? '' },
    });
    return this.categoryRequest(decision.id)!;
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
    status?: string;
    /** Back-dates an imported loan to the day it was actually issued. */
    at?: string;
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
      status: loan.status ?? 'active',
    };
    const at = loan.at ?? this.#now();
    this.db
      .prepare('INSERT INTO loans (id, customer_id, item_id, approval_id, principal_cents, rate_pct, rate_rule, term_days, interest_cents, start_date, due_date, grace_ends_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.customer_id, row.item_id, loan.approvalId ?? null, row.principal_cents, row.rate_pct, row.rate_rule, row.term_days, row.interest_cents, row.start_date, row.due_date, row.grace_ends_date, row.status, at, at);
    this.audit({ actor: loan.actor, action: 'loan.created', entity: 'loan', entityId: row.id, details: { principalCents: row.principal_cents, ratePct: row.rate_pct } });
    return row;
  }

  loan(loanId: string): Loan | null {
    return (this.db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId) as unknown as Loan) ?? null;
  }

  updateLoanStatus(loanId: string, status: string, actor: string): void {
    this.db.prepare('UPDATE loans SET status = ?, updated_at = ? WHERE id = ?').run(status, this.#now(), loanId);
    this.audit({ actor, action: 'loan.status', entity: 'loan', entityId: loanId, details: { status } });
  }

  /**
   * Appends a ledger entry. Entries are never edited afterwards.
   *
   * `at` is the date the money moved, which for imported history is not the
   * date the row was inserted. The audit log still records the real insert
   * time, so back-dating an entry never hides when it was written.
   */
  postLedgerEntry(entry: { loanId: string; entryType: string; amountCents: number; memo?: string; actor: string; at?: string }): LedgerEntry {
    const row: LedgerEntry = {
      id: randomUUID(),
      loan_id: entry.loanId,
      entry_type: entry.entryType,
      amount_cents: entry.amountCents,
      memo: entry.memo ?? '',
      actor: entry.actor,
      reverses_entry_id: null,
      created_at: entry.at ?? this.#now(),
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

  // --- website pre-checks -------------------------------------------------

  /** Records that someone checked an item on the website. Nothing identifies them. */
  recordPrecheck(precheck: {
    categorySlug: string;
    variant?: string | null;
    description?: string;
    answers: unknown;
    status: string;
  }): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO prechecks (id, category_slug, variant, description, answers, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        precheck.categorySlug,
        precheck.variant ?? null,
        (precheck.description ?? '').slice(0, 160),
        JSON.stringify(precheck.answers),
        precheck.status,
        this.#now(),
      );
    return id;
  }

  /** How many pre-checks by category — what the website is actually bringing in. */
  precheckCounts(): { category_slug: string; status: string; count: number }[] {
    return this.db
      .prepare('SELECT category_slug, status, COUNT(*) AS count FROM prechecks GROUP BY category_slug, status ORDER BY count DESC')
      .all() as unknown as { category_slug: string; status: string; count: number }[];
  }

  // --- workbook imports (architecture step 7) -----------------------------

  /**
   * Opens an import batch. Everything the import creates is recorded against
   * it, which is what makes the whole thing undoable — the ledger itself can
   * only ever be added to.
   */
  startImport(batch: { source: string; sourceSha256: string; actor: string }): ImportBatch {
    const row: ImportBatch = {
      id: randomUUID(),
      source: batch.source,
      source_sha256: batch.sourceSha256,
      status: 'complete',
      summary: '{}',
      actor: batch.actor,
      created_at: this.#now(),
      reverted_at: null,
      reverted_note: null,
    };
    this.db
      .prepare('INSERT INTO imports (id, source, source_sha256, status, summary, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.source, row.source_sha256, row.status, row.summary, row.actor, row.created_at);
    this.audit({ actor: batch.actor, action: 'import.started', entity: 'import', entityId: row.id, details: { source: batch.source, sha256: batch.sourceSha256 } });
    return row;
  }

  /** Links a workbook row to the record it produced. */
  recordImportedRow(row: { importId: string; sourceSheet: string; sourceRef: string; entity: 'customer' | 'item' | 'loan'; entityId: string }): void {
    this.db
      .prepare('INSERT INTO imported_rows (id, import_id, source_sheet, source_ref, entity, entity_id, reverted, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(randomUUID(), row.importId, row.sourceSheet, row.sourceRef, row.entity, row.entityId, this.#now());
  }

  /** What a workbook reference became last time, if it has been imported before. */
  importedRow(sourceSheet: string, sourceRef: string, entity: 'customer' | 'item' | 'loan'): ImportedRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM imported_rows WHERE source_sheet = ? AND source_ref = ? AND entity = ? AND reverted = 0')
        .get(sourceSheet, sourceRef, entity) as unknown as ImportedRow) ?? null
    );
  }

  importedRows(importId: string, entity?: 'customer' | 'item' | 'loan'): ImportedRow[] {
    const sql = entity
      ? 'SELECT * FROM imported_rows WHERE import_id = ? AND entity = ? ORDER BY created_at, rowid'
      : 'SELECT * FROM imported_rows WHERE import_id = ? ORDER BY created_at, rowid';
    const parameters = entity ? [importId, entity] : [importId];
    return this.db.prepare(sql).all(...parameters) as unknown as ImportedRow[];
  }

  finishImport(importId: string, summary: unknown): void {
    this.db.prepare('UPDATE imports SET summary = ? WHERE id = ?').run(JSON.stringify(summary), importId);
    this.audit({ actor: 'import', action: 'import.finished', entity: 'import', entityId: importId, details: summary });
  }

  importBatch(importId: string): ImportBatch | null {
    return (this.db.prepare('SELECT * FROM imports WHERE id = ?').get(importId) as unknown as ImportBatch) ?? null;
  }

  imports(): ImportBatch[] {
    return this.db.prepare('SELECT * FROM imports ORDER BY created_at').all() as unknown as ImportBatch[];
  }

  /**
   * Undoes an import the only way an append-only ledger allows: every entry
   * it posted gets a reversing entry, and the rows it created are marked
   * reverted so the workbook can be imported again once it is corrected.
   *
   * Nothing is deleted. Customers created by the import are left in place —
   * they may have had a real conversation since, and a person is not a
   * bookkeeping mistake.
   */
  revertImport(importId: string, actor: string, note: string): { entriesReversed: number; loansReverted: number } {
    const batch = this.importBatch(importId);
    if (!batch) throw new Error(`No such import: ${importId}`);
    if (batch.status === 'reverted') throw new LedgerError('That import has already been reverted');

    const loans = this.importedRows(importId, 'loan');
    let entriesReversed = 0;

    for (const row of loans) {
      for (const entry of this.ledger(row.entity_id)) {
        if (entry.reverses_entry_id) continue;
        const already = this.db.prepare('SELECT id FROM ledger_entries WHERE reverses_entry_id = ?').get(entry.id);
        if (already) continue;
        this.reverseLedgerEntry({ entryId: entry.id, actor, reason: `Import reverted: ${note}` });
        entriesReversed += 1;
      }
      this.updateLoanStatus(row.entity_id, 'import-reverted', actor);
    }

    for (const row of this.importedRows(importId, 'item')) {
      this.updateItem(row.entity_id, { status: 'import-reverted' });
    }

    const at = this.#now();
    this.db.prepare('UPDATE imported_rows SET reverted = 1 WHERE import_id = ?').run(importId);
    this.db.prepare("UPDATE imports SET status = 'reverted', reverted_at = ?, reverted_note = ? WHERE id = ?").run(at, note, importId);
    this.audit({ actor, action: 'import.reverted', entity: 'import', entityId: importId, details: { note, entriesReversed, loansReverted: loans.length } });

    return { entriesReversed, loansReverted: loans.length };
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
