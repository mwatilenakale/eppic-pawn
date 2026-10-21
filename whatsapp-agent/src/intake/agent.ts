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
import { CategoryGate } from './unknown.ts';
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
  step: 'name' | 'category' | 'variant' | 'questions' | 'amount' | 'submitted' | 'asking-lukas';
  /** False until the customer has been greeted, so "hi" isn't read as an item. */
  greeted: boolean;
  /** Set when we already know this number, so they are greeted by name. */
  knownName?: string | null;
  /** How many loans they have had, for the welcome-back line. */
  timesBorrowed?: number;
  /** Times we have asked for a name. We stop after two. */
  nameAttempts?: number;
  /** An item named before we had a name for them — so we don't ask for it twice. */
  pendingItemText?: string | null;
  /** True once we have said we cannot quote, so we don't say it twice running. */
  priceAnswered?: boolean;
  /**
   * Times we have failed to work out what the item is. The first time we ask
   * them to say it plainly; the second time we stop guessing and ask Lukas,
   * because by then it is probably a real item we simply do not take.
   */
  unclearAttempts?: number;
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
  /**
   * Something for Lukas, sent alongside the customer's reply — today only the
   * "can we take this at all?" question from playbook section 2. It is not an
   * approval request; `submission` is still the only thing that asks for money.
   */
  ownerMessages?: string[];
}

/**
 * Said once per conversation, and only once. Every other line that follows a
 * greeting takes the body on its own — a customer who has just read "Hello,
 * this is Eppic Pawn Shop" and is then told it again is talking to a machine
 * that lost its place.
 */
const GREETING = 'Hello, this is Eppic Pawn Shop in Windhoek 👋';

/** The item list and the question, without the greeting in front of it. */
function whichCategory(categories: string[]): string {
  return `I can start a pawn application for you here on WhatsApp. We take:\n${categories
    .map((label) => `• ${label}`)
    .join('\n')}\n\nWhich one do you have?`;
}

const copy = {
  greeting: GREETING,
  whichCategory,
  welcome: (categories: string[]) => `${GREETING}\n\n${whichCategory(categories)}`,
  /**
   * First time we cannot tell what the item is. Deliberately not a refusal:
   * the matcher is not perfect and the shop does take things off the list, so
   * the customer is invited to say it plainly rather than shown the door.
   */
  unclear: (categories: string[]) =>
    `I'm not quite sure what that is. We normally take:\n${categories
      .map((label) => `• ${label}`)
      .join('\n')}\n\nIf it's one of those, tell me which. If it's something else, say what it is and I'll ask Lukas whether we can take it.`,
  /**
   * Lukas has already said no to something like this. Reusing his answer
   * rather than asking him the same question every time somebody walks in
   * with a camera — but said as his decision, not the agent's.
   */
  refusedBefore: (reason: string, categories: string[]) =>
    `Lukas has looked at one of those before and we don't take them${reason ? ` — ${reason}` : ''}.\n\n` +
    `What we do take:\n${categories.map((label) => `• ${label}`).join('\n')}\n\nHave you got any of those?`,
  /** They messaged again while Lukas has the question. */
  stillWaiting:
    "I'm still waiting on Lukas for that one — he gets back to me as soon as he sees it, and I'll message you straight away.\n\n" +
    'If you have a phone, laptop, TV, console or a car as well, I can get started on that in the meantime.',
  notAccepted: (input: string, categories: string[]) =>
    `Sorry — we don't take ${input.trim()} at the moment. We only take:\n${categories
      .map((label) => `• ${label}`)
      .join('\n')}\n\nWhich of those do you have?`,
  askVariant: (labels: string[]) => `Is it ${labels.join(' or ')}?`,

  /** First contact from a number nobody has seen before. */
  askName: `${GREETING}\n\nBefore we start — what is your name?`,
  /** The same question without the greeting, once hello has been said. */
  askNameBody: 'Before we start — what is your name?',
  /** Same question again, after they answered it with their item. */
  askNameAgain: 'Sorry — I meant your own name. What should I call you?',

  /**
   * A returning customer. Being known by name is most of what makes a small
   * shop feel like a small shop rather than a form.
   */
  welcomeBack: (name: string, timesBorrowed: number) =>
    timesBorrowed > 0
      ? `Welcome back ${name} 👋\n\nGood to hear from you again. What do you have for us this time?`
      : `Hello again ${name} 👋\n\nWhat do you have for us?`,

  /** They asked what it is worth. Say honestly that the number is not ours to give. */
  priceAsked:
    "I can't give you a figure myself — Lukas sets every amount after he has seen the item and the photos.\n\n" +
    'What I can do is take the details now so he can come back to you quickly.',
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

/**
 * "how much", "what can I get", "price", "worth" — a fair question, and it can
 * arrive at any point in the conversation. One pattern, used everywhere it is
 * asked: two spellings of this drifted apart once already and the agent
 * answered the same question differently depending on where it was asked.
 */
const ASKING_PRICE = /how much|what (can|will|would) (i|you)|what.*(offer|get|give me)|price|worth|value|quote|pay me/i;
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
    const customer = this.#store.upsertCustomer(fromPhone);
    const conversation =
      this.#store.activeConversation(customer.id) ??
      this.#store.openConversation(customer.id, {
        ...initialState(customer.name),
        knownName: customer.name,
        timesBorrowed: this.#timesBorrowed(customer.id),
      });

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

  /**
   * An item we do not normally take. Playbook section 2, "Something else":
   * the customer is told honestly, Lukas is asked, and the conversation waits.
   *
   * If Lukas has already answered about something like this, that answer is
   * reused rather than asking him the same question twice.
   */
  #askLukas(customer: Customer, conversationId: string, state: IntakeState, description: string): IntakeOutcome {
    const gate = new CategoryGate(this.#store, this.#rules);

    const previous = gate.previousAnswer(description);
    if (previous?.status === 'refused') {
      state.unclearAttempts = 0;
      return { replies: [copy.refusedBefore(previous.reason, this.#categoryLabels())] };
    }

    const asked = gate.ask(customer, conversationId, description);
    state.step = 'asking-lukas';
    return {
      replies: [asked.customerMessage],
      ownerMessages: asked.ownerMessage ? [asked.ownerMessage] : [],
    };
  }

  #advance(customer: Customer, conversationId: string, state: IntakeState, incoming: Incoming): IntakeOutcome {
    const text = (incoming.text ?? '').trim();

    if (RESTART.test(text)) {
      // Starting the item again does not make us strangers. Keep who they are;
      // throw away only what they said about the item.
      const knownName = state.knownName ?? null;
      const timesBorrowed = state.timesBorrowed ?? 0;
      Object.assign(state, initialState(knownName), { knownName, timesBorrowed, greeted: true });
      return {
        replies: [
          copy.restarted,
          knownName ? whichCategory(this.#categoryLabels()) : copy.askNameBody,
        ],
      };
    }

    if (state.step === 'submitted') {
      return { replies: [copy.alreadySubmitted] };
    }

    // Waiting on Lukas's yes or no about an item we don't normally take. Not a
    // dead end: the customer can change their mind and offer something we do
    // take, and the question to Lukas stays open either way.
    if (state.step === 'asking-lukas') {
      const offered = text ? this.#rules.category(text) : null;
      if (offered) {
        state.step = 'category';
        return this.#handleCategory(customer, conversationId, state, text);
      }
      return { replies: [copy.stillWaiting] };
    }

    if (state.step === 'name') return this.#handleName(customer, conversationId, state, text);
    if (state.step === 'category') return this.#handleCategory(customer, conversationId, state, text);
    if (state.step === 'variant') return this.#handleVariant(state, text);
    if (state.step === 'amount') return this.#handleAmount(customer, conversationId, state, text);
    return this.#handleQuestion(customer, conversationId, state, incoming, text);
  }

  /** How many loans this customer has had, for the welcome-back line. */
  #timesBorrowed(customerId: string): number {
    const row = this.#store.db.prepare('SELECT COUNT(*) AS n FROM loans WHERE customer_id = ?').get(customerId) as { n: number };
    return Number(row.n);
  }

  #categoryLabels(): string[] {
    return this.#rules.categories.map((category) => category.label);
  }

  /**
   * Who are we talking to.
   *
   * Asked once, on a number nobody has seen before, and then never again —
   * the next time this person messages they are greeted by name. A pawn shop
   * that makes a returning customer reintroduce themselves every time is a
   * form, not a shop.
   *
   * The name here is for the conversation and the record. The legal name on
   * the agreement is captured separately at signing, against an ID.
   */
  #handleName(customer: Customer, conversationId: string, state: IntakeState, text: string): IntakeOutcome {
    if (!state.greeted) {
      state.greeted = true;

      // Their opening message usually carries the item, and often a question
      // about price. Both get kept: the item so we never ask for it again, the
      // question so it gets an answer rather than being talked over.
      if (this.#rules.category(text)) state.pendingItemText = text;
      if (ASKING_PRICE.test(text)) {
        state.priceAnswered = true;
        return { replies: [`${GREETING}\n\n${copy.priceAsked}`, copy.askNameBody] };
      }
      return { replies: [copy.askName] };
    }

    // Plenty of people answer "what is your name?" with "iPhone" — they are
    // already thinking about the item. Do not file that as a person. The test
    // is on the name we extracted, not on the whole message: "my name is Aina,
    // I want to pawn my phone" is both a name and an item, and rejecting it
    // because the word "phone" appears loses the name.
    const candidate = readName(text);
    const name = candidate && !this.#rules.category(candidate) ? candidate : null;
    const item = this.#rules.category(text) ? text : null;

    if (!name) {
      // They told us the item instead. Keep it — asking for it a second time
      // once we have their name is how an agent reads as not listening.
      if (item) state.pendingItemText = item;
      state.nameAttempts = (state.nameAttempts ?? 0) + 1;

      // Two tries, then stop asking. A nameless record is a small problem; an
      // agent that will not move on until it gets one is a much bigger one,
      // and the name is captured against an ID at signing anyway.
      if (state.nameAttempts >= 2) {
        state.step = 'category';
        const carried = state.pendingItemText ?? text;
        if (this.#rules.category(carried)) return this.#handleCategory(customer, conversationId, state, carried);
        return { replies: [whichCategory(this.#categoryLabels())] };
      }
      return { replies: [copy.askNameAgain] };
    }

    this.#store.updateCustomerIdentity(customer.id, { name }, 'agent');
    state.knownName = name;
    state.step = 'category';

    const replies = [`Thank you ${name}.`];
    const carried = item ?? state.pendingItemText ?? null;
    if (carried) {
      const onwards = this.#handleCategory(customer, conversationId, state, carried);
      return { replies: [...replies, ...onwards.replies] };
    }
    // Already greeted when we asked for the name, so the list only.
    return { replies: [...replies, whichCategory(this.#categoryLabels())] };
  }

  #handleCategory(customer: Customer, conversationId: string, state: IntakeState, text: string): IntakeOutcome {
    const category = text ? this.#rules.category(text) : null;

    // An opening "hi" is a greeting, not an item — greet back and ask, rather
    // than telling someone we don't accept "hi".
    //
    // And greet even when the first message already names an item. Inferring
    // the category and jumping straight to "Is it iPhone or Android?" reads as
    // a machine that did not hear you, which is exactly what a customer
    // nervous about pawning their phone does not need.
    const openers: string[] = [];
    if (!state.greeted) {
      state.greeted = true;
      const hello = state.knownName
        ? copy.welcomeBack(state.knownName, state.timesBorrowed ?? 0)
        : copy.welcome(this.#categoryLabels());
      if (!category) return { replies: [hello] };
      // Their first message already named the item, so the "which one do you
      // have?" list would be answering a question they didn't ask. Greet, then
      // get on with it.
      openers.push(state.knownName ? hello : GREETING);
    }

    // "How much can I get for an iPhone 15?" is a fair question and deserves
    // an answer, even though the answer is "not from me". Once, though — the
    // opening message is often carried forward here after being answered.
    if (ASKING_PRICE.test(text) && !state.priceAnswered) {
      state.priceAnswered = true;
      openers.push(copy.priceAsked);
    }

    if (!category) {
      // A price question with no item named is not a rejection — they simply
      // haven't told us what it is yet, so ask rather than say "we don't take".
      if (!text || ASKING_PRICE.test(text)) {
        return { replies: [...openers, whichCategory(this.#categoryLabels())] };
      }

      // Once to be sure we heard them; after that, stop guessing and ask
      // Lukas. Telling somebody with a perfectly good smartwatch "we don't
      // take that" is a decision the agent is not allowed to make.
      state.unclearAttempts = (state.unclearAttempts ?? 0) + 1;
      if (state.unclearAttempts < 2) {
        return { replies: [...openers, copy.unclear(this.#categoryLabels())] };
      }
      const asked = this.#askLukas(customer, conversationId, state, text);
      return { ...asked, replies: [...openers, ...asked.replies] };
    }

    state.unclearAttempts = 0;

    state.categorySlug = category.slug;
    const variants = this.#rules.variantsFor(category.slug);
    if (variants.length > 1) {
      // "iPhone 15" has already answered "is it iPhone or Android?". Asking it
      // anyway is the single clearest sign to a customer that nobody is
      // reading what they wrote.
      const named = matchVariant(variants, text);
      if (named) state.variant = named;
      else {
        state.step = 'variant';
        return { replies: [...openers, copy.askVariant(variants.map((group) => group.label))] };
      }
    }

    state.step = 'questions';
    return { replies: [...openers, this.#nextQuestion(state)!.ask] };
  }

  #handleVariant(state: IntakeState, text: string): IntakeOutcome {
    const variants = this.#rules.variantsFor(state.categorySlug!);
    const chosen = matchVariant(variants, text);
    if (!chosen) {
      return { replies: [copy.askVariant(variants.map((group) => group.label))] };
    }

    state.variant = chosen;
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
      if (ASKING_PRICE.test(text)) return { replies: [copy.noQuotes, copy.askAmount] };
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
/**
 * Which variant a message names, if any. Used both when the variant is asked
 * for and when it was volunteered before being asked.
 */
function matchVariant(variants: { variant: string | null }[], text: string): string | null {
  for (const group of variants) {
    if (group.variant && new RegExp(`\\b${group.variant}\\b`, 'i').test(text)) return group.variant;
  }
  return null;
}

function isAskingForAPrice(text: string, question: Question): boolean {
  if (!ASKING_PRICE.test(text)) return false;
  return text.trim().endsWith('?') || question.kind !== 'text';
}

export /**
 * A conversation starts by asking who this is, unless we already know. A
 * returning customer should never have to introduce themselves twice.
 */
function initialState(knownName?: string | null): IntakeState {
  return {
    step: knownName ? 'category' : 'name',
    greeted: false,
    itemId: null,
    categorySlug: null,
    variant: null,
    answers: {},
    requestedAmountCents: null,
  };
}

/**
 * Reads a name out of whatever they typed. People answer "Aina", "it's
 * Aina", "my name is Aina Shipanga", or a whole sentence about their phone.
 */
function readName(text: string): string | null {
  const cleaned = text
    .replace(/^(hi|hello|hey|good (morning|afternoon|evening))\b[,.!\s]*/i, '')
    .replace(/^(it'?s|this is|i'?m|i am|my name is|name is|call me)\b[\s:]*/i, '')
    .trim();

  // Take the opening words only: "Aina, I want to pawn my phone" is a name
  // followed by business, and the business is handled by the next step.
  const words = cleaned.split(/[,.;!?\n]/)[0]!.trim().split(/\s+/).filter(Boolean).slice(0, 3);
  const name = words.join(' ').replace(/[^\p{L}\p{M}'\- ]/gu, '').trim();

  if (name.length < 2 || name.length > 60) return null;
  // Whether this is an item rather than a person is not decided here: the
  // caller asks the playbook, so the category words live in one place.
  return name.replace(/\b\p{Ll}/gu, (letter) => letter.toUpperCase());
}
