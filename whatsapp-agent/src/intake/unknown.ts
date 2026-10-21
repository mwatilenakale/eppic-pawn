/**
 * Items outside the five categories — playbook section 2, "Something else".
 *
 * A smartwatch, a camera, power tools, a generator. The agent does not refuse
 * these and does not accept them either. It tells the customer honestly that
 * we don't usually take that, asks Lukas, and waits for his word.
 *
 * This is the same rule as everywhere else in the project, applied one step
 * earlier than usual: the agent decides nothing. The only difference is what
 * it is asking about — whether the shop will look at the thing at all, rather
 * than what to lend against it.
 */

import type { Rules } from '../playbook/index.ts';
import type { CategoryRequest, Customer, Store, User } from '../store/index.ts';
import { can } from '../staff/access.ts';
import { referenceFor } from '../reference.ts';

export interface AskResult {
  request: CategoryRequest;
  /** What the customer is told while they wait. */
  customerMessage: string;
  /** The question for Lukas. Null when he has already been asked. */
  ownerMessage: string | null;
}

export interface CategoryDecisionResult {
  ownerMessage: string;
  customerMessage?: string;
  customerPhone?: string;
  request?: CategoryRequest;
}

/** `ACCEPT K3P9`, `REFUSE K3P9 too hard to sell`, `ACCEPT` when only one waits. */
export interface CategoryReply {
  action: 'accept' | 'refuse';
  reference: string | null;
  reason: string;
}

const ACCEPT = /^\s*(accept|take it|yes take|take)\b/i;
const REFUSE = /^\s*(refuse|reject|no thanks|decline it)\b/i;

/**
 * Reads Lukas's answer to a "can we take this?" question.
 *
 * Deliberately *not* the words APPROVE and DECLINE. Those decide money on an
 * application, and the two must never be confusable — replying APPROVE to a
 * question about a smartwatch must not approve a loan on somebody's car.
 */
export function parseCategoryReply(text: string): CategoryReply | null {
  const trimmed = text.trim();
  const accept = ACCEPT.test(trimmed);
  const refuse = REFUSE.test(trimmed);
  if (!accept && !refuse) return null;

  const rest = trimmed.replace(accept ? ACCEPT : REFUSE, '').trim();
  const reference = /^([A-Z][A-Z0-9]{3})\b/.exec(rest.toUpperCase());

  return {
    action: accept ? 'accept' : 'refuse',
    reference: reference ? reference[1]! : null,
    reason: (reference ? rest.slice(reference[1]!.length) : rest).replace(/^[\s,:—-]+/, '').trim(),
  };
}

export class CategoryGate {
  readonly #store: Store;
  readonly #rules: Rules;

  constructor(store: Store, rules: Rules) {
    this.#store = store;
    this.#rules = rules;
  }

  /** Is there already an answer for an item like this one? */
  previousAnswer(description: string): CategoryRequest | null {
    const recent = this.#store.db
      .prepare("SELECT * FROM category_requests WHERE status <> 'pending' ORDER BY decided_at DESC LIMIT 40")
      .all() as unknown as CategoryRequest[];

    const words = keywords(description);
    if (words.length === 0) return null;
    return recent.find((request) => keywords(request.description).some((word) => words.includes(word))) ?? null;
  }

  ask(customer: Customer, conversationId: string | null, description: string): AskResult {
    const label = this.#rules.playbook.ownerLabel;
    const already = this.#store.pendingCategoryRequestFor(customer.id);
    const request = this.#store.askAboutCategory({
      customerId: customer.id,
      conversationId,
      description,
    });

    return {
      request,
      customerMessage: already ? waitingAgain(label) : waiting(label),
      ownerMessage: already ? null : question(request, customer, description, this.#rules),
    };
  }

  pending(): CategoryRequest[] {
    return this.#store.pendingCategoryRequests();
  }

  /**
   * Lukas's answer, and what the customer is told. Gated on the same
   * capability as every other decision: staff cannot answer this either.
   */
  decide(reply: CategoryReply, owner: User): CategoryDecisionResult {
    if (!can(owner, 'approvals.decide')) {
      return { ownerMessage: 'Only Lukas can say whether we take an item we do not normally take.' };
    }

    const pending = this.pending();
    if (pending.length === 0) return { ownerMessage: 'No item is waiting on a yes or no from you.' };

    const request = reply.reference
      ? pending.find((entry) => referenceFor(entry.id) === reply.reference)
      : pending.length === 1
        ? pending[0]
        : undefined;

    if (!request) {
      if (!reply.reference && pending.length > 1) {
        return {
          ownerMessage:
            `${pending.length} items are waiting on you — say which:\n` +
            pending.map((entry) => `• ${referenceFor(entry.id)} — ${entry.description}`).join('\n'),
        };
      }
      return { ownerMessage: `Nothing is waiting under reference ${reply.reference}.` };
    }

    const label = this.#rules.playbook.ownerLabel;
    const decided = this.#store.decideCategoryRequest({
      id: request.id,
      status: reply.action === 'accept' ? 'accepted' : 'refused',
      reason: reply.reason,
      decidedBy: owner.id,
    });
    const customer = this.#store.customer(decided.customer_id);

    return {
      request: decided,
      ownerMessage:
        reply.action === 'accept'
          ? `Noted — ${decided.description} is in. I've told ${firstName(customer?.name)} and I'm taking the details now.`
          : `Noted — ${firstName(customer?.name)} has been told we can't take it${reply.reason ? `: ${reply.reason}` : ''}.`,
      customerMessage: reply.action === 'accept' ? accepted(label) : refused(label, reply.reason),
      customerPhone: customer?.phone,
    };
  }
}

// --- what everyone is told -------------------------------------------------

function waiting(owner: string): string {
  return (
    "That's not one of the five things we normally take, so I can't start an application for it myself.\n\n" +
    `What I can do is put it to ${owner} directly — these are decided one by one, and we do take things off ` +
    "the list when they're worth it. It has gone across now and I'll message you the moment I hear back."
  );
}

function waitingAgain(owner: string): string {
  return `${capitalise(owner)} has it — yours has already gone across, and I'll come straight back to you with an answer.`;
}

function accepted(owner: string): string {
  return (
    `Good news — ${owner} says we can take a look at it 👍\n\n` +
    "Let's get the details down so he can price it. Tell me exactly what you have: make, model, and its condition."
  );
}

function refused(owner: string, reason: string): string {
  return (
    `I've heard back from ${owner} and unfortunately we can't take that one${reason ? ` — ${reason}` : ''}.\n\n` +
    'If you have a phone, laptop, TV, console or a car, I can start an application for that right away.'
  );
}

/**
 * The question itself. Short, because it arrives on his phone while he is at
 * the FNB job, and it has to be answerable with one word.
 */
function question(request: CategoryRequest, customer: Customer, description: string, rules: Rules): string {
  const reference = referenceFor(request.id);
  const categories = rules.categories.map((category) => category.label).join(', ');

  return (
    `*Can we take this? — ${reference}*\n\n` +
    `*${description}*\n` +
    `From: ${customer.name ?? 'a new customer'} (${customer.phone})\n\n` +
    `Not one of: ${categories}.\n\n` +
    `Reply *ACCEPT ${reference}* and I'll take the details, or *REFUSE ${reference} <reason>* and I'll let them down gently.\n` +
    'They have been told you are deciding. Nothing else has been said.'
  );
}

// --- small helpers ---------------------------------------------------------

const COMMON = new Set([
  'the', 'and', 'with', 'for', 'have', 'has', 'this', 'that', 'its', 'new',
  'old', 'good', 'like', 'want', 'need', 'pawn', 'sell', 'inch', 'series',
  'model', 'condition', 'box', 'mine', 'very',
]);

/** The words worth matching one description against another. */
function keywords(description: string): string[] {
  return description
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length >= 4 && !COMMON.has(word));
}

/** "the manager" → "The manager", for the start of a sentence. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function firstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] ?? 'the customer';
}
