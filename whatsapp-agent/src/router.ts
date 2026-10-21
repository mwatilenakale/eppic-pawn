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
import { IntakeAgent, initialState, type IntakeState, type IntakeSubmission } from './intake/agent.ts';
import { CategoryGate, parseCategoryReply, type CategoryDecisionResult } from './intake/unknown.ts';
import { OTHER } from './intake/questions.ts';
import { HandoverDesk, detectHandover, parseHandoverCommand, type Handover } from './intake/handover.ts';
import { Forfeiture, parseForfeitCommand } from './book/forfeit.ts';
import { Extensions, parseExtendCommand } from './book/extend.ts';
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
import { can } from './staff/access.ts';
import type { WhatsAppTransport } from './whatsapp/transport.ts';
import { QuoteService } from './valuator/quotes.ts';
import type { EstimateInput } from './valuator/prompt.ts';

/**
 * Supplies market estimates for the valuation engine. Optional: with none
 * configured, Lukas is asked for the amount instead of the system inventing
 * one.
 */
export interface Valuator {
  estimate(input: EstimateInput): Promise<MarketEstimate[]>;
}

export interface RouterOptions {
  store: Store;
  rules: Rules;
  transport: WhatsAppTransport;
  ownerPhone: string;
  ownerName?: string;
  valuator?: Valuator;
  quotes?: QuoteService;
  /** Issues the agreement once Lukas approves. Omit to skip contracts. */
  contracts?: ContractService;
  /** Checks a newly identified customer against everyone already known. */
  directory?: CustomerDirectory;
  /** Called with anything that goes wrong while handling one message. */
  onError?: (error: unknown, event: InboundEvent) => void;
  /** Overrides "today" for the book queries. Tests only. */
  clock?: () => Date;
}

export class AgentRouter {
  readonly #store: Store;
  readonly #transport: WhatsAppTransport;
  readonly #intake: IntakeAgent;
  readonly #approvals: ApprovalWorkflow;
  readonly #ownerPhone: string;
  readonly #owner: User;
  readonly #valuator: Valuator | null;
  readonly #quotes: QuoteService;
  readonly #customerQueues = new Map<string, Promise<void>>();
  readonly #contracts: ContractService | null;
  readonly #directory: CustomerDirectory | null;
  readonly #book: Book;
  readonly #gate: CategoryGate;
  readonly #desk: HandoverDesk;
  /** What customers call whoever decides — "the manager", from the playbook. */
  readonly #ownerLabel: string;
  readonly #forfeiture: Forfeiture;
  readonly #extensions: Extensions;
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
    this.#quotes = options.quotes ?? new QuoteService(options.store, options.rules, this.#valuator);
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

    this.#book = new Book(options.store, { clock: options.clock });
    this.#gate = new CategoryGate(options.store, options.rules);
    this.#desk = new HandoverDesk(options.store);
    this.#ownerLabel = options.rules.playbook.ownerLabel;
    this.#forfeiture = new Forfeiture(options.store, options.rules, this.#book);
    this.#extensions = new Extensions(options.store, options.rules, this.#book, this.#valuator);
    this.#onError = options.onError ?? ((error) => console.error('[agent]', error));
  }

  async handle(event: InboundEvent): Promise<void> {
    try {
      if (samePhone(event.from, this.#ownerPhone)) {
        await this.#handleOwner(event);
        return;
      }

      // A number in `users` is somebody who works here. Without this branch a
      // member of staff texting *BOOK* was answered with "which one do you
      // have?" — the agent started taking a pawn application from the hire.
      const staff = this.#store.userByPhone(event.from);
      if (staff) {
        await this.#handleStaff(event, staff);
        return;
      }

      const previous = this.#customerQueues.get(event.from) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(() => this.#handleCustomer(event));
      this.#customerQueues.set(event.from, current);
      try { await current; }
      finally { if (this.#customerQueues.get(event.from) === current) this.#customerQueues.delete(event.from); }
    } catch (error) {
      this.#onError(error, event);
      await this.#safeSend(event.from, 'Sorry — something went wrong on our side. Please send that again in a moment.');
    }
  }

  async #handleCustomer(event: InboundEvent): Promise<void> {
    // Do this before handover or any async research. A replay must not escalate
    // or advance a different question after its first delivery has completed.
    if (this.#store.db.prepare('SELECT id FROM messages WHERE provider_message_id = ?').get(event.messageId)) return;
    const media = event.mediaId ? await this.#transport.downloadMedia(event.mediaId) : undefined;

    // Before anything else: is this one of ours to answer at all?
    //
    // The message is recorded either way — a thread a person is handling still
    // needs a complete transcript — but when a human has it, or a trigger
    // fires, the agent says nothing. Deciding a figure, an argument about an
    // existing loan, or a question about the police are not its to answer, and
    // guessing at those costs far more than waiting does.
    if (await this.#handedToAPerson(event)) return;

    const outcome = this.#intake.handle(event.from, {
      text: event.text,
      providerMessageId: event.messageId,
      media: media ? { content: media.content, extension: media.extension } : undefined,
    });

    // A profile nickname must not overwrite a customer's stated or signed name.
    for (const reply of outcome.replies) await this.#transport.sendText({ to: event.from, body: reply });

    // "Can we take a smartwatch?" — a question, not an approval request.
    for (const message of outcome.ownerMessages ?? []) {
      await this.#transport.sendText({ to: this.#ownerPhone, body: message });
    }

    // Asked the same thing three times and getting nowhere. Hand it over
    // rather than ask a fourth time — a conversation that cannot move is
    // worth a person's minute, and until this existed it simply died quietly.
    if (outcome.stuck) await this.#escalateStuck(event.from);

    if (outcome.submission) await this.#requestApproval(outcome.submission);
  }

  async #requestApproval(submission: IntakeSubmission): Promise<void> {
    const quote = await this.#quotes
          .quote({
            description: submission.item.description,
            categorySlug: submission.item.category_slug,
            variant: submission.item.variant,
          })
          .catch((error) => {
            this.#onError(error, { from: submission.customer.phone, messageId: '', type: 'text' });
            return null;
          });

    const request = this.#approvals.request(submission, [], quote?.valuation);
    await this.#transport.sendText({ to: this.#ownerPhone, body: request.ownerMessage });
  }


  /**
   * A member of staff asking about the book.
   *
   * Read-only by construction: the only thing reachable from here is
   * `#answer`, every branch of which reads. Nothing a member of staff can
   * send moves an application along or changes an amount — that stays with
   * Lukas, and it is the one capability staff do not hold.
   *
   * What they do see, since 21 October 2026, is everything he sees: the
   * totals, who is due, who is past grace, and one customer's history.
   */
  async #handleStaff(event: InboundEvent, staff: User): Promise<void> {
    const query = parseBookCommand(event.text ?? '');
    if (query) {
      await this.#transport.sendText({ to: event.from, body: this.#answer(query, staff) });
      return;
    }

    // Staff can take a thread and answer as the shop. They still cannot
    // approve — SAY is a message and nothing else, and a figure typed into it
    // changes no loan, approval or ledger row.
    if (await this.#runHandover(event, staff)) return;

    await this.#transport.sendText({
      to: event.from,
      body:
        `Hello ${staff.name.split(' ')[0]}.\n\n` +
        'Send *BOOK* for the totals, *DUE* for this week, *OVERDUE* for who is late, ' +
        'or *CUSTOMER <name or number>* to look someone up.\n\n' +
        'For a customer thread: *WAITING*, *TAKE <number>*, *SAY <number> <message>*, *BACK <number>*.\n\n' +
        'Pricing and approvals are Lukas\'s — those come from his phone.',
    });
  }

  /**
   * TAKE / SAY / BACK / WAITING, from Lukas or from staff. Returns false when
   * the message was not one of these, so the caller can carry on.
   */
  async #runHandover(event: InboundEvent, user: User): Promise<boolean> {
    const command = parseHandoverCommand(event.text ?? '');
    if (!command) return false;

    const result = this.#desk.run(command, user);
    await this.#transport.sendText({ to: event.from, body: result.ownerMessage });

    if (result.customerMessage && result.customerPhone) {
      await this.#transport.sendText({ to: result.customerPhone, body: result.customerMessage });
    }
    return true;
  }

  /** The intake has stalled on one question. Put a person on it. */
  async #escalateStuck(phone: string): Promise<void> {
    const customer = this.#store.customerByPhone(phone);
    const conversation = customer ? this.#store.activeConversation(customer.id) : null;
    if (!conversation) return;

    const handover = { reason: 'lost' as const, why: "Two messages in a row I couldn't make sense of" };
    const message = this.#desk.escalate(conversation, handover, customer!.name, phone);
    if (!message) return;

    await this.#transport.sendText({ to: this.#ownerPhone, body: message });

    const line =
      `I'm not following you properly, sorry — rather than keep guessing I've asked ${this.#ownerLabel} to take this over. ` +
      'Someone will reply here on this number.';
    await this.#transport.sendText({ to: phone, body: line });
    this.#store.recordOutbound({ conversationId: conversation.id, body: line });
  }

  /**
   * True when the agent must stay quiet: a person is already holding this
   * thread, or this message is one it should not answer.
   *
   * Returns true without replying in both cases. The customer gets one line
   * when the agent steps back, so they are not left staring at silence, and
   * nothing more until a human types BACK.
   */
  async #handedToAPerson(event: InboundEvent): Promise<boolean> {
    let customer = this.#store.customerByPhone(event.from);
    let conversation = customer ? this.#store.activeConversation(customer.id) : null;
    const handover = detectHandover(event.text ?? '');
    if (!conversation) {
      if (!handover) return false;
      // Escalation must not depend on a preceding hello. Create the transcript
      // before processing this very first message, then let the normal desk
      // hold it. No approval, loan or owner-only decision is made here.
      customer ??= this.#store.upsertCustomer(event.from);
      conversation = this.#store.openConversation(customer.id, initialState(customer.name));
    }

    // A person has it, or is being waited on. Record what the customer said
    // and say nothing.
    if (conversation.held_reason) {
      this.#store.recordInbound({
        conversationId: conversation.id,
        providerMessageId: event.messageId,
        body: event.text ?? (event.mediaId ? '[photo]' : ''),
      });
      return true;
    }

    if (!handover) return false;

    this.#store.recordInbound({
      conversationId: conversation.id,
      providerMessageId: event.messageId,
      body: event.text ?? '',
    });

    const message = this.#desk.escalate(conversation, handover, customer!.name, event.from);
    if (message) await this.#transport.sendText({ to: this.#ownerPhone, body: message });

    const holding = holdingLine(handover, this.#ownerLabel);
    await this.#transport.sendText({ to: event.from, body: holding });
    this.#store.recordOutbound({ conversationId: conversation.id, body: holding });
    return true;
  }

  /**
   * Puts the customer's conversation back where it belongs once Lukas has
   * answered. Accepted means the details are taken next, so the conversation
   * goes to the item-description step; refused closes it, and their next
   * message starts fresh rather than landing back in the wait.
   */
  async #resumeAfterCategoryDecision(decision: CategoryDecisionResult): Promise<void> {
    const conversationId = decision.request?.conversation_id;
    if (!conversationId) return;

    this.#store.recordOutbound({ conversationId, body: decision.customerMessage! });

    if (decision.request!.status === 'refused') {
      this.#store.closeConversation(conversationId);
      return;
    }

    // Accepted: the description is the next thing we need, and there is no
    // category checklist for an item the shop has not taken before — the
    // playbook sends it to the general checks and Lukas's own inspection.
    const conversation = this.#store.conversationById(conversationId);
    if (!conversation) return;
    const state = JSON.parse(conversation.state) as IntakeState;
    state.step = 'questions';
    state.unclearAttempts = 0;
    state.categorySlug = OTHER;
    state.variant = null;
    this.#store.saveConversationState(conversationId, state);
  }

  async #handleOwner(event: InboundEvent): Promise<void> {
    // Asking to see the book is not a decision. Checked first, and answered
    // without touching anything — these commands have no write path.
    const query = parseBookCommand(event.text ?? '');
    if (query) {
      await this.#transport.sendText({ to: this.#ownerPhone, body: this.#answer(query, this.#owner) });
      return;
    }

    // TAKE / SAY / BACK / WAITING — talking to a customer by hand. Before the
    // approval parser: "BACK" must not be read as anything about money.
    if (await this.#runHandover(event, this.#owner)) return;

    // EXTEND gives a customer another month, if section 8's 70% line allows
    // it. Before SELL, so "extend" is never read as anything else.
    const extend = parseExtendCommand(event.text ?? '');
    if (extend) {
      const result = await this.#extensions.run(extend, this.#owner);
      await this.#transport.sendText({ to: this.#ownerPhone, body: result.ownerMessage });
      if (result.customerMessage && result.customerPhone) {
        await this.#safeSend(result.customerPhone, result.customerMessage);
      }
      return;
    }

    // SELL / KEEP sends a past-grace item to market, or takes it back off the
    // list (playbook section 8). Before the approval parser, and separate
    // words again: this decides about an *item already pawned*, not about an
    // application, and the two must never be confusable.
    const forfeit = parseForfeitCommand(event.text ?? '');
    if (forfeit) {
      const result = this.#forfeiture.run(forfeit, this.#owner);
      await this.#transport.sendText({ to: this.#ownerPhone, body: result.ownerMessage });

      if (result.customerMessage && result.customerPhone) {
        await this.#safeSend(result.customerPhone, result.customerMessage);
      }
      return;
    }

    // ACCEPT / REFUSE answers "can we take this at all?" about an item outside
    // the five categories. Checked before the approval parser and kept to
    // different words on purpose: replying APPROVE to a question about a
    // smartwatch must never approve a loan on somebody's car.
    const categoryReply = parseCategoryReply(event.text ?? '');
    if (categoryReply && this.#store.pendingCategoryRequests().length > 0) {
      const decision = this.#gate.decide(categoryReply, this.#owner);
      await this.#transport.sendText({ to: this.#ownerPhone, body: decision.ownerMessage });

      if (decision.customerMessage && decision.customerPhone) {
        await this.#transport.sendText({ to: decision.customerPhone, body: decision.customerMessage });
        await this.#resumeAfterCategoryDecision(decision);
      }
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
  #answer(query: BookCommand, viewer: User): string {
    // From the book's own clock, not a second one — two clocks in one reply is
    // how "3 days past grace" and "due tomorrow" end up disagreeing.
    const today = this.#book.today();

    if (query.kind === 'summary') {
      // Staff hold this capability too since 21 October 2026; the check stays
      // so the restriction is one line in access.ts away if it comes back.
      if (!can(viewer, 'book.totals')) {
        return 'You can still use *DUE*, *OVERDUE* and *CUSTOMER <name or number>*.';
      }
      return renderSummary(this.#book.summary(), today);
    }
    if (query.kind === 'due') return renderDue(this.#book.due(), today);
    if (query.kind === 'overdue') return renderOverdue(this.#book.overdue(), this.#book.inGrace());

    if (!query.query) return 'Send *CUSTOMER* with part of a name or a phone number, e.g. CUSTOMER 081 555 0101.';

    const matches = this.#book.findCustomers(query.query);
    if (matches.length !== 1) return renderCustomerChoices(matches, query.query);

    // Audited with a name against it. Looking up one customer is ordinary
    // work; looking up a hundred should be visible afterwards.
    this.#store.audit({
      actor: viewer.id,
      action: 'customer.viewed',
      entity: 'customer',
      entityId: matches[0]!.id,
      details: { query: query.query },
    });

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

/**
 * The one line the customer gets as the agent steps back.
 *
 * Said plainly, because the alternative is silence and a customer who thinks
 * they have been ignored. It promises a person, not a timeframe — Lukas has a
 * day job and an over-promise here is worse than none.
 */
function holdingLine(handover: Handover, owner: string): string {
  if (handover.reason === 'negotiating') {
    return `That's ${owner}'s to decide, not mine — I've passed it across and you'll hear back directly.`;
  }
  if (handover.reason === 'existing-loan') {
    return `That's about a loan you already have, so I'd rather ${owner} answered it. I've sent it across now.`;
  }
  if (handover.reason === 'ownership') {
    return `I'm not going to answer that one myself — I've passed it straight to ${owner} and someone will be in touch.`;
  }
  return `Of course — I've asked ${owner} to pick this up with you directly. You'll get a reply here on this number.`;
}
