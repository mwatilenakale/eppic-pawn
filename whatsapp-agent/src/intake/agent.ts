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
import { buildQuestionPlan, liveQuestions, readConfirmation, type Question, type QuestionPlan } from './questions.ts';

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
  /** Descriptions too thin to value. After three we stop asking. */
  vagueDescriptions?: number;
  /**
   * Questions we gave up on rather than loop. Answered, so the conversation
   * moves past them; still outstanding, so Lukas is told.
   */
  unusableAnswers?: string[];
  /** Times each document has been asked for, so we ask twice and move on. */
  photoAsks?: Record<string, number>;
  /** The last thing we asked, and how many times running we have asked it. */
  lastAsk?: string;
  repeatedAsk?: number;
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
   * The agent has asked the same question three times running and is getting
   * nowhere. The caller hands the conversation to a person rather than let it
   * ask a fourth time — "two strikes, not five" (docs/tasks/003).
   */
  stuck?: boolean;
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
  unclear: (owner: string, categories: string[]) =>
    `I'm not quite sure what that is. We normally take:\n${categories
      .map((label) => `• ${label}`)
      .join('\n')}\n\nIf it's one of those, tell me which. If it's something else, say what it is and I'll ask ${owner} whether we can take it.`,
  /**
   * Lukas has already said no to something like this. Reusing his answer
   * rather than asking him the same question every time somebody walks in
   * with a camera — but said as his decision, not the agent's.
   */
  refusedBefore: (owner: string, reason: string, categories: string[]) =>
    `${capitalise(owner)} has looked at one of those before and we don't take them${reason ? ` — ${reason}` : ''}.\n\n` +
    `What we do take:\n${categories.map((label) => `• ${label}`).join('\n')}\n\nHave you got any of those?`,
  /**
   * The description was too thin to value. Asked a different way the second
   * time, because repeating a question word for word is how a customer decides
   * the thing is broken.
   */
  needMoreDetail: (owner: string, attempt: number) =>
    attempt === 1
      ? `I need a bit more than that to put in front of ${owner} — what make and model is it?\n\nFor example: *iPhone 13 Pro, 256GB, small scratch on the back* or *Toyota Hilux 2016, 180,000km*.`
      : 'Still not quite enough, sorry. Just the make and the model is fine — even *Dell laptop 2021* or *55 inch Samsung* gives them something to work with.',

  /**
   * A required document they don't have yet.
   *
   * Careful wording: it is still required. The customer is not told they can
   * skip it — they are told to bring it in. Whether the file is good enough
   * without it is Lukas's decision, and the customer never hears that the
   * question was even asked (playbook section 5, "Waiving a document").
   */
  bringItLater: (question: Question) =>
    `No problem — bring it with you when you come in. It is still needed before anything is handed over.\n\n` +
    `I'll note that ${documentName(question)} is still to come and carry on with the rest.`,

  /** They messaged again while Lukas has the question. */
  stillWaiting: (owner: string) =>
    `I'm still waiting on ${owner} for that one — I'll message you straight away once I hear back.\n\n` +
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
  priceAsked: (owner: string) =>
    `I can't give you a figure myself — ${owner} sets every amount after seeing the item and the photos.\n\n` +
    'What I can do is take the details now so you get an answer quickly.',
  photoExpected: (ask: string) => `I still need that as a photo. ${ask}`,
  confirmExpected: (ask: string) => `Sorry, I didn't catch that. ${ask}`,
  photoReceived: 'Got the photo, thank you.',
  askAmount: (owner: string) =>
    'Last question: how much are you hoping to borrow? Give me a figure if you have one, or reply *not sure*.\n\n' +
    `(This is not an offer — ${owner} sets the final amount.)`,
  submitted: (owner: string) =>
    `Thank you — that's everything I need. I've sent your application to ${owner} for review.\n\n` +
    'Nothing is approved or priced yet: every application is checked personally, and I will message you as soon as I have an answer.',
  alreadySubmitted: (owner: string) =>
    `Your application is with ${owner} — each one is reviewed personally, so nothing is confirmed until I hear back. ` +
    "I'll message you the moment I do.",
  noQuotes: (owner: string) =>
    `I can't give you an amount myself — ${owner} decides every offer after seeing the item. ` +
    "Let's finish the details and you'll get an answer.",
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
    return this.#store.transaction(() => this.#handleIncoming(fromPhone, incoming));
  }

  #handleIncoming(fromPhone: string, incoming: Incoming): IntakeOutcome {
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

    // Is it getting anywhere?
    //
    // A customer who answers "Is it iPhone or Android?" with something that
    // matches neither used to be asked it again, and again, forever — the
    // conversation never reached Lukas and nobody knew. One counter here
    // covers every question rather than each step guarding itself.
    const asked = outcome.replies.at(-1) ?? '';
    state.repeatedAsk = asked && asked === state.lastAsk ? (state.repeatedAsk ?? 0) + 1 : 0;
    state.lastAsk = asked;
    if ((state.repeatedAsk ?? 0) >= 2) {
      outcome.stuck = true;
      state.repeatedAsk = 0;
    }

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
      return { replies: [copy.refusedBefore(this.#owner, previous.reason, this.#categoryLabels())] };
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
      return { replies: [copy.alreadySubmitted(this.#owner)] };
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
      return { replies: [copy.stillWaiting(this.#owner)] };
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

  /** What customers call whoever decides — "the manager", from the playbook. */
  get #owner(): string {
    return this.#rules.playbook.ownerLabel;
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
        return { replies: [`${GREETING}\n\n${copy.priceAsked(this.#owner)}`, copy.askNameBody] };
      }
      return { replies: [copy.askName] };
    }

    // Plenty of people answer "what is your name?" with "iPhone" — they are
    // already thinking about the item. Do not file that as a person. The test
    // is on the name we extracted, not on the whole message: "my name is Aina,
    // I want to pawn my phone" is both a name and an item, and rejecting it
    // because the word "phone" appears loses the name.
    const candidate = readName(text);
    const item = this.#rules.category(text) ? text : null;

    // A message that names an item is only *also* a name if they said so
    // outright. "my name is Aina, I want to pawn my iPhone" gives up both;
    // "actually I have an iPhone 13 to pawn" is an item and nothing else —
    // it was being filed as a customer called "Actually I Have".
    const alsoAName = !item || NAME_LEAD_IN.test(text);
    const name = candidate && alsoAName && !this.#rules.category(candidate) ? candidate : null;

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
      openers.push(copy.priceAsked(this.#owner));
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
        return { replies: [...openers, copy.unclear(this.#owner, this.#categoryLabels())] };
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
      //
      // The brand can answer it too: a Nokia or a Samsung Galaxy is an
      // Android, from the hints in playbook section 2. Most phones that come
      // in are Androids, so this is the common path, not the clever one.
      const named = matchVariant(variants, text) ?? this.#rules.variantFrom(category.slug, text);
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
    const chosen = matchVariant(variants, text) ?? this.#rules.variantFrom(state.categorySlug!, text);
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
      return { replies: [copy.noQuotes(this.#owner), question.ask] };
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

      // A required document they do not have yet.
      //
      // The requirement stands — it was asked, and it is asked again — but a
      // customer who genuinely has not been to the police station cannot
      // produce one by being asked a fifth time. Blocking here meant no
      // application could ever reach Lukas with a document missing, which
      // meant the waiver in playbook section 5 could never happen: his whole
      // point is that he decides these one by one, and he cannot decide about
      // a file he never sees.
      //
      // So: ask twice, then carry the gap to him and say so. The customer is
      // still told to bring it, and the contract still requires it.
      if (text) {
        const asks = (state.photoAsks ??= {});
        asks[question.id] = (asks[question.id] ?? 0) + 1;

        if (haventGotIt(text) || asks[question.id]! >= 2) {
          this.#record(state, question, text, false);
          state.unusableAnswers = [...(state.unusableAnswers ?? []), question.id];
          return {
            replies: [copy.bringItLater(question), ...this.#nextPrompt(customer, conversationId, state)],
          };
        }
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

    // The description is what gets valued. Letting a bare "yes" through sent
    // Lukas a car application reading "*Item:* yes" with a suggested loan of
    // N$1,612.50 against it, computed by asking the valuer what the word "yes"
    // is worth. Ask again rather than price a word.
    if (question.id === 'item-description' && !describesAnItem(text)) {
      state.vagueDescriptions = (state.vagueDescriptions ?? 0) + 1;
      if (state.vagueDescriptions < 3) {
        return { replies: [copy.needMoreDetail(this.#owner, state.vagueDescriptions)] };
      }

      // Three tries is enough — trapping somebody on one question forever is
      // worse. But what they gave is not a description of anything, so it does
      // not get to become one: the answer is kept for the transcript, the item
      // stays undescribed, and it is reported to Lukas as outstanding. Filing
      // "yes" as the description is how he ended up with an application
      // reading "*Item:* yes" and a figure against it.
      this.#record(state, question, text, false);
      state.unusableAnswers = [...(state.unusableAnswers ?? []), question.id];
      return { replies: this.#nextPrompt(customer, conversationId, state) };
    }

    this.#record(state, question, text, null);
    if (question.id === 'item-description') {
      this.#ensureItem(customer, conversationId, state, text);
    }
    return { replies: this.#nextPrompt(customer, conversationId, state) };
  }

  #handleAmount(customer: Customer, conversationId: string, state: IntakeState, text: string): IntakeOutcome {
    const amount = parseAmount(text);
    if (amount === null && readConfirmation(text) !== 'unsure') {
      if (ASKING_PRICE.test(text)) return { replies: [copy.noQuotes(this.#owner), copy.askAmount(this.#owner)] };
      return { replies: [copy.askAmount(this.#owner)] };
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
    return { replies: [copy.askAmount(this.#owner)] };
  }

  #plan(state: IntakeState): QuestionPlan {
    return buildQuestionPlan(this.#rules, state.categorySlug!, state.variant);
  }

  /** First question with no answer yet — so a playbook edit mid-chat still lands. */
  #nextQuestion(state: IntakeState): Question | null {
    return liveQuestions(this.#plan(state), this.#photoKinds(state)).find(
      (question) => !(question.id in state.answers),
    ) ?? null;
  }

  /** Photos already in, so a superseded fallback is not asked for. */
  #photoKinds(state: IntakeState): string[] {
    return state.itemId ? this.#store.photos(state.itemId).map((photo) => photo.kind) : [];
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
    // An answer we gave up on is kept for the transcript but is not a
    // description, so it must not become one here either — this is the last
    // place "yes" could still have reached Lukas as "*Item:* yes".
    const described = state.unusableAnswers?.includes('item-description')
      ? ''
      : state.answers['item-description']?.response ?? '';
    const created = this.#ensureItem(customer, conversationId, state, described);
    const answers = Object.values(state.answers);
    const flagged = answers.filter((answer) => answer.confirmed === false || answer.confirmed === null).filter(
      (answer) => answer.kind === 'confirm' || answer.kind === 'photo',
    );
    // Outstanding covers both the never-answered and the answered-uselessly:
    // an item described as "yes" is exactly as unready as one not described
    // at all, and hiding that from Lukas is the part that costs money.
    const unusable = new Set(state.unusableAnswers ?? []);
    const photoKinds = this.#store.photos(created.id).map((photo) => photo.kind);
    const missing = liveQuestions(plan, photoKinds).filter(
      (question) => !question.optional && (!(question.id in state.answers) || unusable.has(question.id)),
    );

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
      replies: [copy.submitted(this.#owner)],
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

/**
 * A conversation starts by asking who this is, unless we already know. A
 * returning customer should never have to introduce themselves twice.
 */
export function initialState(knownName?: string | null): IntakeState {
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
/**
 * Is this actually a description of an item?
 *
 * The bar is deliberately low — people type "ps5 1tb" and that is plenty — but
 * it has to stop a bare confirmation or a sentence about something else
 * becoming the thing we ask the valuer to price. Two signals, either of which
 * is enough: a model number, or three words that are not filler.
 */
function describesAnItem(text: string): boolean {
  const trimmed = text.trim();

  // "yes", "ok", "not sure" — an answer to a different question.
  if (readConfirmation(trimmed) !== null) return false;

  // A digit almost always means a model, a size or a year: "iPhone 15",
  // "55 inch", "ps5", "2016 Polo".
  if (/\d/.test(trimmed) && /[a-z]/i.test(trimmed)) return true;

  const words = trimmed
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 1 && !DESCRIPTION_FILLER.has(word));

  return words.length >= 3;
}

/** Words that pad a sentence without saying anything about the item. */
const DESCRIPTION_FILLER = new Set([
  'the', 'and', 'but', 'for', 'with', 'have', 'has', 'had', 'its', 'it', 'is',
  'are', 'was', 'this', 'that', 'my', 'me', 'you', 'your', 'want', 'need',
  'just', 'only', 'also', 'please', 'can', 'could', 'would', 'will', 'dont',
  'not', 'any', 'some', 'very', 'really', 'today', 'now', 'cash', 'money',
  'papers', 'receipt', 'thanks', 'thank', 'hello', 'okay', 'sure',
]);

/** "the manager" → "The manager", for the start of a sentence. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "I don't have it", "not yet", "I'll bring it" — an honest answer, not a dodge. */
const HAVENT_GOT_IT =
  /\b(don'?t have|do not have|haven'?t got|have not got|haven'?t been|have not been|not yet|no receipt|no papers|lost it|can'?t find|cannot find|i'?ll bring|will bring|bring it|later|tomorrow|next week)\b/i;

function haventGotIt(text: string): boolean {
  return HAVENT_GOT_IT.test(text);
}

/** "the police declaration", for a sentence about what is still to come. */
function documentName(question: Question): string {
  const names: Record<string, string> = {
    item: 'a photo of the item',
    box: 'a photo of the box',
    id: 'a copy of your ID',
    ownership: 'your proof of ownership',
    'police-declaration': 'the police declaration',
  };
  return names[question.photoKind ?? 'item'] ?? 'that document';
}

/** They are telling us a name on purpose, not just happening to start with "I". */
const NAME_LEAD_IN = /\b(my name is|name'?s|i'?m|i am|it'?s|this is|call me)\b/i;

function readName(text: string): string | null {
  // A question is not a name. "I said are you hiring" was filed as a customer
  // called "I Said Are", which is both useless and faintly insulting to greet
  // somebody by next time.
  if (/\?\s*$/.test(text.trim())) return null;
  if (/^\s*(are|is|was|do|does|did|can|could|will|would|what|where|when|why|how|who|which|whose)\b/i.test(text)) {
    return null;
  }
  if (/^\s*i\s+(said|asked|told|want|need|have)\b/i.test(text)) return null;

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
