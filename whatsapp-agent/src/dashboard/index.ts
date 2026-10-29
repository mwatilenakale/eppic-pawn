/**
 * What is actually happening today.
 *
 * Lukas asked for this in plain terms: how many deals are outstanding for the
 * day, what documents are still missing, and who has been through the
 * pre-screen with everything uploaded and is only expected to walk in.
 *
 * Read-only by construction. Every method here runs a SELECT; nothing in this
 * module writes, approves, or decides anything, so the page built on it cannot
 * move an application along by being refreshed.
 *
 * Deliberately not a cached summary table. The ledger is the truth and the
 * numbers are summed from it every time, the same as the WhatsApp *BOOK*
 * command — two places keeping their own running totals is how they end up
 * disagreeing in front of a customer.
 */

import type { Rules } from '../playbook/index.ts';
import type { Store } from '../store/index.ts';
import { Book, type BookSummary, type LoanLine } from '../book/index.ts';
import { outstandingFor } from '../requirements.ts';
import { referenceFor } from '../reference.ts';
import { Collections } from '../book/collections.ts';

/** An application somewhere between "hello" and money changing hands. */
export interface DealLine {
  itemId: string;
  /** The approval reference, when there is one to quote back at him. */
  reference: string | null;
  customerName: string;
  customerPhone: string;
  description: string;
  category: string;
  /** How long it has been sitting, in whole hours. */
  waitingHours: number;
  /**
   * Photos and documents still outstanding — the ID, the police declaration,
   * a photo of the item. These are what Lukas chases, so they are their own
   * list rather than mixed in with the screening questions.
   */
  missingDocuments: string[];
  /** Screening questions with no usable answer yet, counted not listed. */
  unansweredQuestions: number;
  /**
   * Gaps Lukas approved around — playbook section 5, "Waiving a document".
   * Shown so the record is visible, not chased.
   */
  waived: string[];
  photos: string[];
}

export interface WaitingOnAPerson {
  customerName: string;
  customerPhone: string;
  reason: string;
  /** Who has it, or null when it is escalated and nobody has picked it up. */
  heldByName: string | null;
  waitingHours: number;
}

export interface CategoryQuestion {
  reference: string;
  customerName: string;
  description: string;
  waitingHours: number;
}

export interface Today {
  date: string;
  /** New applications started today. */
  started: number;
  /** Applications Lukas decided today, either way. */
  decided: number;
  loansIssued: number;
  /** Pre-screens run on the website today. */
  prechecks: number;
}

export interface Dashboard {
  collectionNotices: { reminders: number; final: number; missedFinal: number; needsReview: number };
  /**
   * Inbound messages taken in and not handled. Dispatch is at-most-once by
   * design, so nothing retries these — this count is how anyone finds out.
   */
  inboundNeedingReview: { failed: number; unfinished: number };
  today: Today;

  /** Applications waiting on Lukas's yes or no. The first thing he wants. */
  awaitingDecision: DealLine[];
  /** "Can we take a smartwatch?" — playbook section 2. */
  awaitingCategoryAnswer: CategoryQuestion[];
  /** Threads the agent has stepped back from (docs/tasks/003). */
  waitingOnAPerson: WaitingOnAPerson[];

  /**
   * Approved, every document in, nothing left to chase. These people are
   * only expected to come to the office — this is the list Lukas asked for
   * by name.
   */
  readyForTheOffice: DealLine[];
  /** Mid-intake with documents still outstanding, longest wait first. */
  missingDocuments: DealLine[];

  /** Inspections to do once an item is physically in the shop. */
  inspections: { waiting: number; inHand: number };

  /** The book, the same figures the WhatsApp *BOOK* command gives. */
  book: BookSummary;
  dueThisWeek: LoanLine[];
  pastGrace: LoanLine[];
  inGrace: LoanLine[];
}

interface ItemRow {
  id: string;
  customer_id: string;
  conversation_id: string | null;
  category_slug: string;
  variant: string | null;
  description: string;
  declared_details: string;
  status: string;
  created_at: string;
  customer_name: string | null;
  customer_phone: string;
}

export class DashboardQuery {
  readonly #store: Store;
  readonly #rules: Rules;
  readonly #book: Book;
  readonly #now: () => Date;

  constructor(store: Store, rules: Rules, options: { clock?: () => Date } = {}) {
    this.#store = store;
    this.#rules = rules;
    this.#now = options.clock ?? (() => new Date());
    this.#book = new Book(store, { clock: this.#now });
  }

  read(): Dashboard {
    const collections = new Collections(this.#store, this.#rules, null, { clock: this.#now });
    return {
      collectionNotices: { reminders: collections.reminders().length, final: collections.finalNotices().length, missedFinal: collections.missedFinalNotices().length, needsReview: this.#store.collectionNoticesNeedingReview() },
      inboundNeedingReview: this.#store.inboundNeedingReview(),
      today: this.#today(),
      awaitingDecision: this.#awaitingDecision(),
      awaitingCategoryAnswer: this.#categoryQuestions(),
      waitingOnAPerson: this.#waitingOnAPerson(),
      readyForTheOffice: this.#readyForTheOffice(),
      missingDocuments: this.#missingDocuments(),
      inspections: this.#inspections(),
      // Staff hold `book.totals` as of 21 October 2026, and this page is only
      // reachable with a staff link, so the unguarded call is correct here.
      book: this.#book.summary(),
      dueThisWeek: this.#book.due(),
      pastGrace: this.#book.overdue(),
      inGrace: this.#book.inGrace(),
    };
  }

  // --- the lists -----------------------------------------------------------

  #today(): Today {
    const date = this.#book.today();
    const since = `${date}T00:00:00`;
    const count = (sql: string): number =>
      Number((this.#store.db.prepare(sql).get(since) as { n: number }).n);

    return {
      date,
      started: count('SELECT COUNT(*) AS n FROM items WHERE created_at >= ?'),
      decided: count("SELECT COUNT(*) AS n FROM approvals WHERE status <> 'pending' AND decided_at >= ?"),
      loansIssued: count('SELECT COUNT(*) AS n FROM loans WHERE created_at >= ?'),
      prechecks: count('SELECT COUNT(*) AS n FROM prechecks WHERE created_at >= ?'),
    };
  }

  #awaitingDecision(): DealLine[] {
    return this.#store
      .pendingApprovals()
      .map((approval) => {
        const item = this.#item(approval.item_id);
        return item ? this.#line(item, referenceFor(approval.id)) : null;
      })
      .filter((line): line is DealLine => line !== null);
  }

  #categoryQuestions(): CategoryQuestion[] {
    return this.#store.pendingCategoryRequests().map((request) => {
      const customer = this.#store.customer(request.customer_id);
      return {
        reference: referenceFor(request.id),
        customerName: customer?.name ?? 'a new customer',
        description: request.description,
        waitingHours: this.#hoursSince(request.created_at ?? null),
      };
    });
  }

  #waitingOnAPerson(): WaitingOnAPerson[] {
    return this.#store.heldConversations().map((row) => ({
      customerName: row.customer_name ?? row.customer_phone,
      customerPhone: row.customer_phone,
      reason: row.held_reason,
      heldByName: row.held_by ? (this.#store.user(row.held_by)?.name ?? null) : null,
      waitingHours: this.#hoursSince(row.taken_at),
    }));
  }

  /**
   * Approved and complete. The point of this list is that there is nothing
   * left for anyone to do but open the door, so an item with a document still
   * outstanding does not belong on it however long ago it was approved.
   */
  #readyForTheOffice(): DealLine[] {
    const approved = this.#store.db
      .prepare(
        "SELECT a.id, a.item_id FROM approvals a WHERE a.status = 'approved'" +
          ' AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.item_id = a.item_id)' +
          ' ORDER BY a.decided_at',
      )
      .all() as unknown as { id: string; item_id: string }[];

    return approved
      .map((row) => {
        const item = this.#item(row.item_id);
        return item ? this.#line(item, referenceFor(row.id)) : null;
      })
      .filter((line): line is DealLine => line !== null && isComplete(line));
  }

  #missingDocuments(): DealLine[] {
    return this.#onTheWay()
      .map((item) => this.#line(item, null))
      .filter((line) => !isComplete(line));
  }

  #inspections(): { waiting: number; inHand: number } {
    const row = this.#store.db
      .prepare(
        "SELECT SUM(status = 'open') AS waiting, SUM(status = 'claimed') AS inHand FROM inspection_jobs",
      )
      .get() as { waiting: number | null; inHand: number | null };
    return { waiting: Number(row.waiting ?? 0), inHand: Number(row.inHand ?? 0) };
  }

  // --- shared shaping ------------------------------------------------------

  /** The item columns plus who it belongs to — every list here needs both. */
  static readonly #SELECT =
    'SELECT i.*, c.name AS customer_name, c.phone AS customer_phone' +
    ' FROM items i JOIN customers c ON c.id = i.customer_id';

  #item(itemId: string): ItemRow | null {
    return (
      (this.#store.db.prepare(`${DashboardQuery.#SELECT} WHERE i.id = ?`).get(itemId) as unknown as ItemRow) ?? null
    );
  }

  /**
   * Every item still on its way to a loan: being taken in, waiting on a
   * decision, or approved and not yet pledged.
   *
   * `approved` belongs here, which is not obvious. An approved item with a
   * document still outstanding appeared on no list at all — off Lukas's
   * because it was decided, off "ready for the office" because it was
   * incomplete, and off this one because it was no longer in intake. A deal
   * nobody can see is a deal that quietly does not happen.
   *
   * `declined` and `pledged` are finished, either way, and stay off.
   */
  #onTheWay(): ItemRow[] {
    return this.#store.db
      .prepare(
        `${DashboardQuery.#SELECT} WHERE i.status IN ('intake', 'awaiting-approval', 'approved')` +
          ' ORDER BY i.created_at',
      )
      .all() as unknown as ItemRow[];
  }

  #line(item: ItemRow, reference: string | null): DealLine {
    const photos = this.#store.photos(item.id).map((photo) => photo.kind);
    const category = this.#rules.categories.find((entry) => entry.slug === item.category_slug);

    return {
      itemId: item.id,
      reference,
      customerName: item.customer_name ?? 'a new customer',
      customerPhone: item.customer_phone,
      description: item.description || '(not described yet)',
      category: category?.label ?? 'Something else',
      waitingHours: this.#hoursSince(item.created_at),
      ...this.#outstanding(item.id),
      photos,
    };
  }

  /**
   * What is still outstanding, from the shared module.
   *
   * Not worked out here: the approval message, the "ready for the office"
   * list and this one have to agree, and when the dashboard computed it for
   * itself the two disagreed within a day. `src/requirements.ts` also knows
   * which gaps Lukas has already approved around, so a waived document is not
   * chased forever (playbook section 5).
   */
  #outstanding(itemId: string): { missingDocuments: string[]; unansweredQuestions: number; waived: string[] } {
    const outstanding = outstandingFor(this.#store, this.#rules, itemId);
    return {
      missingDocuments: outstanding.documents,
      unansweredQuestions: outstanding.questions.length,
      waived: outstanding.waived,
    };
  }

  #hoursSince(timestamp: string | null): number {
    if (!timestamp) return 0;
    const then = Date.parse(timestamp.includes('T') ? timestamp : `${timestamp}T00:00:00Z`);
    if (Number.isNaN(then)) return 0;
    return Math.max(0, Math.floor((this.#now().getTime() - then) / 3_600_000));
  }
}

/**
 * Nothing left for anyone to chase.
 *
 * Both halves count: an item with every photo in but the finance question
 * unanswered is not ready, and telling somebody to come to the office when it
 * is not is a wasted trip across Windhoek.
 */
function isComplete(line: DealLine): boolean {
  return line.missingDocuments.length === 0 && line.unansweredQuestions === 0;
}



