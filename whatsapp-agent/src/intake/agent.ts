/**
 * The intake conversation: one question at a time, over WhatsApp, until the
 * item is described, screened and photographed well enough to put in front of
 * Lukas.
 *
 * What this module must never do (root CLAUDE.md, whatsapp-agent/CLAUDE.md):
 * quote a number, or tell a customer their item is accepted. It gathers, then
 * hands over. Every reply it can send is written below — none of them contains
 * a valuation.
 */

import type { Rules } from '../playbook/index.ts';
import type { Customer, Item, Store } from '../store/index.ts';
import { parseAmount } from '../money.ts';
import { buildQuestionPlan, readConfirmation, type Question, type QuestionPlan } from './questions.ts';

export interface Incoming {
  text?: string;
  media?: { content: Buffer; extension?: string };
  providerMessageId?: string | null;
}

export interface Answer {
  questionId: string;
  question: string;
  kind: Question['kind'];
  source: Question['source'];
  response: string;
  /** true = confirmed, false = answered no, null = unsure or not answerable. */
  confirmed: boolean | null;
}

export interface IntakeState {
  step: 'category' | 'variant' | 'questions' | 'amount' | 'submitted';
  /** False until the customer has been greeted, so "hi" isn't read as an item. */
  greeted: boolean;
  itemId: string | null;
  categorySlug: string | null;
  variant: string | null;
  answers: Record<string, Answer>;
  requestedAmountCents: number | null;
}

/** Everything the approval step needs once intake is complete. */
export interface IntakeSubmission {
  customer: Customer;
  item: Item;
  conversationId: string;
  plan: QuestionPlan;
  answers: Answer[];
  /** Answered "no" or "not sure" — the things Lukas should look at first. */
  flagged: Answer[];
  /** Required questions with no answer at all. */
  missing: Question[];
  photoKinds: string[];
  requestedAmountCents: number | null;
}

export interface IntakeOutcome {
  replies: string[];
  submission?: IntakeSubmission;
}

const copy = {
  welcome: (categories: string[]) =>
    `Hello, this is Eppic Pawn Shop in Windhoek 👋\n\nI can start a pawn application for you here on WhatsApp. We take:\n${categories
      .map((label) => `• ${label}`)
      .join('\n')}\n\nWhich one do you have?`,
  notAccepted: (input: string, categories: string[]) =>
    `Sorry — we don't take ${input.trim()} at the moment. We only take:\n${categories
      .map((label) => `• ${label}`)
      .join('\n')}\n\nWhich of those do you have?`,
  askVariant: (labels: string[]) => `Is it ${labels.join(' or ')}?`,
  photoExpected: (ask: string) => `I still need that as a photo. ${ask}`,
  confirmExpected: (ask: string) => `Sorry, I didn't catch that. ${ask}`,
  photoReceived: 'Got the photo, thank you.',
  askAmount:
    'Last question: how much are you hoping to borrow? Give me a figure if you have one, or reply *not sure*.\n\n(This is not an offer — Lukas sets the final amount himself.)',
  submitted:
    "Thank you — that's everything I need. I've sent your application to Lukas for review.\n\nNothing is approved or priced yet: he checks it himself and I'll message you as soon as he replies.",
  alreadySubmitted:
    "Your application is with Lukas — he reviews each one personally, so nothing is confirmed until he replies. I'll message you the moment he does.",
  noQuotes:
    "I can't give you an amount myself — Lukas decides every offer after he's seen the item. Let's finish the details and he'll come back to you.",
  restarted: 'No problem, starting again.',
} as const;

/** Customer asking for a price mid-intake — answered without ever quoting. */
const ASKING_FOR_A_PRICE = /how much|what.*(offer|get|give me)|price|worth|quote/i;
const RESTART = /^(restart|start over|start again|cancel)$/i;

export class IntakeAgent {
  readonly #store: Store;
  readonly #rules: Rules;

  constructor(store: Store, rules: Rules) {
    this.#store = store;
    this.#rules = rules;
  }

  /**
   * Handles one inbound WhatsApp message and returns what to send back.
   * Duplicate deliveries (same provider message id) produce no replies.
   */
  handle(fromPhone: string, incoming: Incoming): IntakeOutcome {
    // Persist the deduplication marker only with the state it advances. If a
    // photo write fails, Meta's retry must still be allowed to process it.
    return this.#store.transaction(() => this.#handleIncoming(fromPhone, incoming));
  }

  #handleIncoming(fromPhone: string, incoming: Incoming): IntakeOutcome {
    const customer = this.#store.upsertCustomer(fromPhone);
    const conversation =
      this.#store.activeConversation(customer.id) ?? this.#store.openConversation(customer.id, initialState());

    const recorded = this.#store.recordInbound({
      conversationId: conversation.id,
      providerMessageId: incoming.providerMessageId ?? null,
      body: incoming.text ?? (incoming.media ? '[photo]' : ''),
    });
    if (recorded === null) return { replies: [] };

    const state = JSON.parse(conversation.state) as IntakeState;
    const outcome = this.#advance(customer, conversation.id, state, incoming);

    this.#store.saveConversationState(conversation.id, state);
    for (const reply of outcome.replies) {
      this.#store.recordOutbound({ conversationId: conversation.id, body: reply });
    }
    return outcome;
  }

  #advance(customer: Customer, conversationId: string, state: IntakeState, incoming: Incoming): IntakeOutcome {
    const text = (incoming.text ?? '').trim();

    if (RESTART.test(text)) {
      Object.assign(state, initialState());
      return { replies: [copy.restarted, copy.welcome(this.#categoryLabels())] };
    }

    if (state.step === 'submitted') {
      return { replies: [copy.alreadySubmitted] };
    }

    if (state.step === 'category') return this.#handleCategory(state, text);
    if (state.step === 'variant') return this.#handleVariant(state, text);
    if (state.step === 'amount') return this.#handleAmount(customer, conversationId, state, text);
    return this.#handleQuestion(customer, conversationId, state, incoming, text);
  }

  #categoryLabels(): string[] {
    return this.#rules.categories.map((category) => category.label);
  }

  #handleCategory(state: IntakeState, text: string): IntakeOutcome {
    const category = text ? this.#rules.category(text) : null;

    // An opening "hi" is a greeting, not an item — greet back and ask, rather
    // than telling someone we don't accept "hi".
    if (!state.greeted) {
      state.greeted = true;
      if (!category) return { replies: [copy.welcome(this.#categoryLabels())] };
    }

    if (!category) {
      if (!text) return { replies: [copy.welcome(this.#categoryLabels())] };
      return { replies: [copy.notAccepted(text, this.#categoryLabels())] };
    }

    state.categorySlug = category.slug;
    const variants = this.#rules.variantsFor(category.slug);
    if (variants.length > 1) {
      state.step = 'variant';
      return { replies: [copy.askVariant(variants.map((group) => group.label))] };
    }

    state.step = 'questions';
    return { replies: [this.#nextQuestion(state)!.ask] };
  }

  #handleVariant(state: IntakeState, text: string): IntakeOutcome {
    const variants = this.#rules.variantsFor(state.categorySlug!);
    const chosen = variants.find((group) => new RegExp(`\\b${group.variant}\\b`, 'i').test(text));
    if (!chosen) {
      return { replies: [copy.askVariant(variants.map((group) => group.label))] };
    }

    state.variant = chosen.variant;
    state.step = 'questions';
    return { replies: [this.#nextQuestion(state)!.ask] };
  }

  #handleQuestion(
    customer: Customer,
    conversationId: string,
    state: IntakeState,
    incoming: Incoming,
    text: string,
  ): IntakeOutcome {
    const question = this.#nextQuestion(state);
    if (!question) return this.#askForAmount(state);

    // "How much can I get?" can come at any point. It is answered the same way
    // every time: the agent has no figure to give.
    if (text && isAskingForAPrice(text, question)) {
      return { replies: [copy.noQuotes, question.ask] };
    }

    if (question.kind === 'photo') {
      if (incoming.media) {
        this.#storePhoto(customer, conversationId, state, question, incoming.media);
        this.#record(state, question, '[photo received]', true);
        return { replies: [copy.photoReceived, ...this.#nextPrompt(customer, conversationId, state)] };
      }
      if (question.optional && text) {
        this.#record(state, question, text, readConfirmation(text) === 'yes' ? true : null);
        return { replies: this.#nextPrompt(customer, conversationId, state) };
      }
      return { replies: [copy.photoExpected(question.ask)] };
    }

    if (incoming.media) {
      // A photo arrived while a written answer was expected — keep it anyway.
      this.#storePhoto(customer, conversationId, state, { ...question, photoKind: 'item' }, incoming.media);
      return { replies: [copy.photoReceived, question.ask] };
    }

    if (!text) return { replies: [copy.confirmExpected(question.ask)] };

    if (question.kind === 'confirm') {
      const confirmation = readConfirmation(text);
      if (confirmation === null) {
        return { replies: [copy.confirmExpected(question.ask)] };
      }
      this.#record(state, question, text, confirmation === 'yes' ? true : confirmation === 'no' ? false : null);
      return { replies: this.#nextPrompt(customer, conversationId, state) };
    }

    // Free-text answer (the item description).
    if (text.length < 3) return { replies: [copy.confirmExpected(question.ask)] };
    this.#record(state, question, text, null);
    if (question.id === 'item-description') {
      this.#ensureItem(customer, conversationId, state, text);
    }
    return { replies: this.#nextPrompt(customer, conversationId, state) };
  }

  #handleAmount(customer: Customer, conversationId: string, state: IntakeState, text: string): IntakeOutcome {
    const amount = parseAmount(text);
    if (amount === null && readConfirmation(text) !== 'unsure') {
      if (ASKING_FOR_A_PRICE.test(text)) return { replies: [copy.noQuotes, copy.askAmount] };
      return { replies: [copy.askAmount] };
    }
    state.requestedAmountCents = amount;
    return this.#submit(customer, conversationId, state);
  }

  #nextPrompt(customer: Customer, conversationId: string, state: IntakeState): string[] {
    const next = this.#nextQuestion(state);
    if (next) return [next.ask];
    return this.#askForAmount(state).replies;
  }

  #askForAmount(state: IntakeState): IntakeOutcome {
    state.step = 'amount';
    return { replies: [copy.askAmount] };
  }

  #plan(state: IntakeState): QuestionPlan {
    return buildQuestionPlan(this.#rules, state.categorySlug!, state.variant);
  }

  /** First question with no answer yet — so a playbook edit mid-chat still lands. */
  #nextQuestion(state: IntakeState): Question | null {
    return this.#plan(state).questions.find((question) => !(question.id in state.answers)) ?? null;
  }

  #record(state: IntakeState, question: Question, response: string, confirmed: boolean | null): void {
    state.answers[question.id] = {
      questionId: question.id,
      question: question.ask,
      kind: question.kind,
      source: question.source,
      response,
      confirmed,
    };
  }

  #ensureItem(customer: Customer, conversationId: string, state: IntakeState, description: string): Item {
    if (state.itemId) {
      this.#store.updateItem(state.itemId, { description });
      return this.#store.item(state.itemId)!;
    }
    const item = this.#store.createItem({
      customerId: customer.id,
      conversationId,
      categorySlug: state.categorySlug!,
      variant: state.variant,
      description,
      status: 'intake',
    });
    state.itemId = item.id;
    return item;
  }

  #storePhoto(
    customer: Customer,
    conversationId: string,
    state: IntakeState,
    question: Pick<Question, 'photoKind'>,
    media: NonNullable<Incoming['media']>,
  ): void {
    const item = state.itemId ? this.#store.item(state.itemId)! : this.#ensureItem(customer, conversationId, state, '');
    if (!this.#store.media) return; // media storage disabled — answers still recorded
    this.#store.addPhoto({
      itemId: item.id,
      kind: question.photoKind ?? 'item',
      content: media.content,
      extension: media.extension,
    });
  }

  #submit(customer: Customer, conversationId: string, state: IntakeState): IntakeOutcome {
    const plan = this.#plan(state);
    const created = this.#ensureItem(customer, conversationId, state, state.answers['item-description']?.response ?? '');
    const answers = Object.values(state.answers);
    const flagged = answers.filter((answer) => answer.confirmed === false || answer.confirmed === null).filter(
      (answer) => answer.kind === 'confirm' || answer.kind === 'photo',
    );
    const missing = plan.questions.filter((question) => !question.optional && !(question.id in state.answers));
    const photoKinds = this.#store.photos(created.id).map((photo) => photo.kind);

    this.#store.updateItem(created.id, { declaredDetails: state.answers, status: 'awaiting-approval' });
    const item = this.#store.item(created.id)!;
    this.#store.saveInspection({
      itemId: item.id,
      stage: 'remote',
      results: answers,
      outstanding: [...plan.inPersonChecks.map((check) => check.text), ...missing.map((question) => question.ask)],
      complete: missing.length === 0,
    });

    state.step = 'submitted';

    return {
      replies: [copy.submitted],
      submission: {
        customer,
        item,
        conversationId,
        plan,
        answers,
        flagged,
        missing,
        photoKinds,
        requestedAmountCents: state.requestedAmountCents,
      },
    };
  }
}

/**
 * Distinguishes "how much will you give me?" from a description that happens to
 * mention money ("bought it for 8000, mint condition"): a price question either
 * ends in a question mark or arrives where a description isn't expected.
 */
function isAskingForAPrice(text: string, question: Question): boolean {
  if (!ASKING_FOR_A_PRICE.test(text)) return false;
  return text.trim().endsWith('?') || question.kind !== 'text';
}

export function initialState(): IntakeState {
  return {
    step: 'category',
    greeted: false,
    itemId: null,
    categorySlug: null,
    variant: null,
    answers: {},
    requestedAmountCents: null,
  };
}
