/opt/homebrew/Library/Homebrew/cmd/shellenv.sh: line 18: /bin/ps: Operation not permitted
/** Callable only. Task 008 supplies scheduling; construction/read methods send nothing. */
import type { Rules } from '../playbook/index.ts';
import type { Loan, Store } from '../store/index.ts';
import { addDays } from '../valuation.ts';
import { formatAmount } from '../money.ts';
import { referenceFor } from '../reference.ts';
import { templateFor } from '../whatsapp/templates.ts';
import { WindowAwareTransport, type WhatsAppTransport } from '../whatsapp/transport.ts';

export interface CollectionNotice {
  loanId: string;
  kind: 'reminder' | 'final';
  phone: string;
  amountCents: number;
  dueDate: string;
  graceEndsDate: string;
}

export class Collections {
  readonly #store: Store;
  readonly #rules: Rules;
  readonly #clock: () => Date;
  readonly #transport: WhatsAppTransport | null;

  constructor(store: Store, rules: Rules, transport: WhatsAppTransport | null = null, options: {
    clock?: () => Date;
    onFailure?: (message: { to: string; body: string }, error: Error) => void | Promise<void>;
  } = {}) {
    this.#store = store; this.#rules = rules; this.#clock = options.clock ?? (() => new Date());
    this.#transport = transport ? new WindowAwareTransport(transport, { lastInboundAt: (phone) => store.lastInboundAt(phone), clock: this.#clock, onFailure: options.onFailure }) : null;
  }

  reminders(): CollectionNotice[] { return this.#waiting('reminder'); }
  due(): CollectionNotice[] { return this.reminders(); }
  finalNotices(): CollectionNotice[] { return this.#waiting('final'); }
  /** Missed means manual review only. Never turn a missed deadline into a late warning. */
  missedFinalNotices(): CollectionNotice[] { return this.#waiting('final', true); }

  #waiting(kind: CollectionNotice['kind'], missed = false): CollectionNotice[] {
    // A changed chase policy needs a new implementation, not an invented cadence.
    if (this.#rules.playbook.collections.chaseAfterGrace) throw new Error('Repeated chasing is not implemented; review the playbook');
    if (!this.#rules.playbook.collections.finalNoticeOnLastGraceDay) throw new Error('A different final-notice date needs review; no substitute cadence is implemented');
    const today = this.#clock().toISOString().slice(0, 10);
    const dueOn = addDays(today, this.#rules.playbook.collections.reminderDaysBeforeDue);
    const loans = this.#store.db.prepare("SELECT * FROM loans WHERE status = 'active' ORDER BY due_date, id").all() as unknown as Loan[];
    return loans.filter((loan) => kind === 'reminder' ? loan.due_date === dueOn : missed ? loan.grace_ends_date < today : loan.grace_ends_date === today)
      .filter((loan) => !this.#store.collectionNotice(loan.id, kind) && this.#store.balance(loan.id) > 0)
      .filter((loan) => !['sold', 'redeemed'].includes(this.#store.item(loan.item_id)?.status ?? ''))
      .map((loan) => ({ loanId: loan.id, kind, phone: this.#store.customer(loan.customer_id)?.phone ?? '', amountCents: this.#store.balance(loan.id), dueDate: loan.due_date, graceEndsDate: loan.grace_ends_date }));
  }

  /** Accept only a currently eligible candidate; never trust a stale balance from a caller. */
  async send(notice: Pick<CollectionNotice, 'loanId' | 'kind'>): Promise<{ state: 'accepted' | 'failed' | 'skipped'; error?: string }> {
    if (!this.#transport) throw new Error('Collections has no delivery transport');
    const fresh = this.#waiting(notice.kind).find((row) => row.loanId === notice.loanId);
    if (!fresh || !this.#store.reserveCollectionNotice(fresh.loanId, fresh.kind)) return { state: 'skipped' };
    const ref = referenceFor(fresh.loanId), amount = formatAmount(fresh.amountCents);
    const days = this.#rules.playbook.collections.reminderDaysBeforeDue;
    const body = fresh.kind === 'reminder'
      ? `Eppic Pawn Shop reminder for ${ref}: ${amount} is due on ${fresh.dueDate}, in ${days} days. Reply here if you need to speak to ${this.#rules.playbook.ownerLabel}.`
      : `Eppic Pawn Shop final notice for ${ref}: ${amount} remains owed. Today (${fresh.graceEndsDate}) is the last day of grace. Pay today, or from tomorrow the item is up for sale.`;
    try {
      if (!/^\+\d{8,15}$/.test(fresh.phone)) throw new Error('No usable WhatsApp number; notice not sent');
      const template = fresh.kind === 'reminder'
        ? templateFor('reminder', fresh.phone, body, [ref, amount, fresh.dueDate, String(days)])
        : templateFor('final', fresh.phone, body, [ref, amount, fresh.graceEndsDate]);
      const id = await this.#transport.sendText({ to: fresh.phone, body, template, singleAttempt: true });
      this.#store.finishCollectionNotice(fresh.loanId, fresh.kind, { providerMessageId: id });
      return { state: 'accepted' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#store.finishCollectionNotice(fresh.loanId, fresh.kind, { error: message });
      console.error(`[collections] ${ref} ${fresh.kind} not confirmed: ${message}`);
      return { state: 'failed', error: message };
    }
  }
}
