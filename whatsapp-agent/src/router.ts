/**
 * Routes an inbound WhatsApp message to the right half of the system: the
 * intake conversation for customers, the approval workflow for Lukas.
 *
 * The two are kept strictly apart. A customer's message can never be read as a
 * decision, and Lukas's decision is the only thing that produces a figure for
 * a customer.
 */

import type { Rules } from './playbook/index.ts';
import type { Store, User } from './store/index.ts';
import { IntakeAgent, type IntakeSubmission } from './intake/agent.ts';
import { ApprovalWorkflow } from './approval/index.ts';
import type { MarketEstimate } from './valuation.ts';
import type { ContractService, SignedContract } from './contract/index.ts';
import { parseDuplicateReply, type CustomerDirectory } from './customers/directory.ts';
import {
  Book,
  parseBookCommand,
  renderSummary,
  renderDue,
  renderOverdue,
  renderHistory,
  renderCustomerChoices,
  type BookCommand,
} from './book/index.ts';
import { samePhone, type InboundEvent } from './whatsapp/webhook.ts';
import type { WhatsAppTransport } from './whatsapp/transport.ts';

/**
 * Supplies market estimates for the valuation engine. Optional: with none
 * configured, Lukas is asked for the amount instead of the system inventing
 * one.
 */
export interface Valuator {
  estimate(input: { description: string; categorySlug: string; variant: string | null }): Promise<MarketEstimate[]>;
}

export interface RouterOptions {
  store: Store;
  rules: Rules;
  transport: WhatsAppTransport;
  ownerPhone: string;
  ownerName?: string;
  valuator?: Valuator;
  /** Issues the agreement once Lukas approves. Omit to skip contracts. */
  contracts?: ContractService;
  /** Checks a newly identified customer against everyone already known. */
  directory?: CustomerDirectory;
  /** Called with anything that goes wrong while handling one message. */
  onError?: (error: unknown, event: InboundEvent) => void;
}

export class AgentRouter {
  readonly #store: Store;
  readonly #transport: WhatsAppTransport;
  readonly #intake: IntakeAgent;
  readonly #approvals: ApprovalWorkflow;
  readonly #ownerPhone: string;
  readonly #owner: User;
  readonly #valuator: Valuator | null;
  readonly #contracts: ContractService | null;
  readonly #directory: CustomerDirectory | null;
  readonly #book: Book;
  readonly #onError: (error: unknown, event: InboundEvent) => void;

  constructor(options: RouterOptions) {
    this.#store = options.store;
    this.#transport = options.transport;
    this.#intake = new IntakeAgent(options.store, options.rules);
    this.#approvals = new ApprovalWorkflow(options.store, options.rules);
    this.#ownerPhone = options.ownerPhone;
    this.#owner = options.store.ensureUser({
      name: options.ownerName ?? 'Lukas',
      phone: options.ownerPhone,
      role: 'owner',
    });
    this.#valuator = options.valuator ?? null;
    this.#contracts = options.contracts ?? null;
    this.#directory = options.directory ?? null;
    // Two different numbers, and it has to be two. The shop's number is the one
    // registered on the Cloud API and published to customers; OWNER_PHONE is
    // the phone in Lukas's pocket that approvals arrive on. If they are the
    // same, the agent is trying to message itself: Meta will not deliver it, no
    // approval ever arrives, and every customer message looks like it came from
    // the owner. Better to refuse to start than to run looking fine.
    if (samePhone(options.ownerPhone, options.rules.playbook.whatsapp)) {
      throw new Error(
        `OWNER_PHONE (${options.ownerPhone}) is the same number as the shop's WhatsApp in ${options.rules.playbook.path}. ` +
          "The shop's number is the one registered with Meta; OWNER_PHONE must be your own separate phone.",
      );
    }

    this.#book = new Book(options.store);
    this.#onError = options.onError ?? ((error) => console.error('[agent]', error));
  }

  async handle(event: InboundEvent): Promise<void> {
    try {
      if (samePhone(event.from, this.#ownerPhone)) {
        await this.#handleOwner(event);
      } else {
        await this.#handleCustomer(event);
      }
    } catch (error) {
      this.#onError(error, event);
      await this.#safeSend(event.from, 'Sorry — something went wrong on our side. Please send that again in a moment.');
    }
  }

  async #handleCustomer(event: InboundEvent): Promise<void> {
    const media = event.mediaId ? await this.#transport.downloadMedia(event.mediaId) : undefined;

    const outcome = this.#intake.handle(event.from, {
      text: event.text,
      providerMessageId: event.messageId,
      media: media ? { content: media.content, extension: media.extension } : undefined,
    });

    if (event.profileName) this.#store.upsertCustomer(event.from, event.profileName);
    for (const reply of outcome.replies) await this.#transport.sendText({ to: event.from, body: reply });
    if (outcome.submission) await this.#requestApproval(outcome.submission);
  }

  async #requestApproval(submission: IntakeSubmission): Promise<void> {
    const estimates = this.#valuator
      ? await this.#valuator
          .estimate({
            description: submission.item.description,
            categorySlug: submission.item.category_slug,
            variant: submission.item.variant,
          })
          .catch((error) => {
            this.#onError(error, { from: submission.customer.phone, messageId: '', type: 'text' });
            return [] as MarketEstimate[];
          })
      : [];

    const request = this.#approvals.request(submission, estimates);
    await this.#transport.sendText({ to: this.#ownerPhone, body: request.ownerMessage });
  }

  async #handleOwner(event: InboundEvent): Promise<void> {
    // Asking to see the book is not a decision. Checked first, and answered
    // without touching anything — these commands have no write path.
    const query = parseBookCommand(event.text ?? '');
    if (query) {
      await this.#transport.sendText({ to: this.#ownerPhone, body: this.#answer(query) });
      return;
    }

    // A ruling on a possible-duplicate pair is not an approval, and must never
    // be read as one.
    const ruling = parseDuplicateReply(event.text ?? '');
    if (ruling && this.#directory) {
      const resolution = this.#directory.resolve(ruling.reference, ruling.status, this.#owner);
      await this.#transport.sendText({ to: this.#ownerPhone, body: resolution.ownerMessage });
      return;
    }

    const result = this.#approvals.handleOwnerReply(event.text ?? '', this.#owner);
    await this.#transport.sendText({ to: this.#ownerPhone, body: result.ownerMessage });

    if (result.customerMessage && result.customerPhone) {
      await this.#transport.sendText({ to: result.customerPhone, body: result.customerMessage });

      // Keep the customer's own transcript complete, and close the thread:
      // the application is decided, so the next message starts a new one.
      const conversationId = result.approval?.conversation_id;
      if (conversationId) {
        this.#store.recordOutbound({ conversationId, body: result.customerMessage });
      }

      if (result.approval?.status === 'approved' && this.#contracts) {
        await this.#sendContract(result.approval.id, result.customerPhone, conversationId);
      }

      // The application is decided, so the next customer message starts a new one.
      if (conversationId) this.#store.closeConversation(conversationId);
    }
  }

  /**
   * Answers a book query. Every branch reads; none of them writes, which is
   * what makes it safe for Lukas to poke at his book from his phone without
   * any chance of moving an application along by accident.
   */
  #answer(query: BookCommand): string {
    const today = new Date().toISOString().slice(0, 10);

    if (query.kind === 'summary') return renderSummary(this.#book.summary(), today);
    if (query.kind === 'due') return renderDue(this.#book.due(), today);
    if (query.kind === 'overdue') return renderOverdue(this.#book.overdue(), this.#book.inGrace());

    if (!query.query) return 'Send *CUSTOMER* with part of a name or a phone number, e.g. CUSTOMER 081 555 0101.';

    const matches = this.#book.findCustomers(query.query);
    if (matches.length !== 1) return renderCustomerChoices(matches, query.query);

    const history = this.#book.history(matches[0]!.id);
    return history ? renderHistory(history) : renderCustomerChoices([], query.query);
  }

  /** Generates the agreement and sends the customer their signing link. */
  async #sendContract(approvalId: string, customerPhone: string, conversationId: string | null | undefined): Promise<void> {
    try {
      const issued = this.#contracts!.issueForApproval(approvalId, { actor: this.#owner.id });
      await this.#transport.sendText({ to: customerPhone, body: issued.customerMessage });
      await this.#transport.sendText({ to: this.#ownerPhone, body: issued.ownerMessage });
      if (conversationId) this.#store.recordOutbound({ conversationId, body: issued.customerMessage });
    } catch (error) {
      this.#onError(error, { from: customerPhone, messageId: '', type: 'text' });
      await this.#safeSend(
        this.#ownerPhone,
        'The offer went out, but the contract could not be generated. Check the agent logs before handover.',
      );
    }
  }

  /** Called by the web server once a customer has signed. */
  async announceSignature(signed: SignedContract): Promise<void> {
    await this.#safeSend(this.#ownerPhone, signed.ownerMessage);
    await this.#safeSend(signed.customerPhone, signed.customerMessage);

    // Signing is where a real name and ID number are captured, so it is the
    // point at which a second record for the same person becomes visible.
    if (!this.#directory) return;
    try {
      const identity = this.#directory.recordIdentity(
        signed.contract.customer_id,
        { name: signed.contract.signed_name ?? undefined, idNumber: signed.contract.signed_id_number ?? undefined },
        this.#owner.id,
      );
      if (identity.ownerMessage) await this.#safeSend(this.#ownerPhone, identity.ownerMessage);
    } catch (error) {
      this.#onError(error, { from: signed.customerPhone, messageId: '', type: 'text' });
    }
  }

  async #safeSend(to: string, body: string): Promise<void> {
    try {
      await this.#transport.sendText({ to, body });
    } catch (error) {
      this.#onError(error, { from: to, messageId: '', type: 'text' });
    }
  }
}
