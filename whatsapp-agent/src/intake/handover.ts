/**
 * Knowing when to stop talking — docs/tasks/003.
 *
 * The agent answers everything by default, and that is the right default: it
 * is the only thing in this system that can reply to ten people at 21:00
 * without getting tired. But some messages are not its to answer, and the
 * damage from guessing at those is much worse than the cost of waiting.
 *
 * When a trigger fires the agent goes quiet on that thread, Lukas is told who
 * and why with the last few messages, and nothing resumes until a human types
 * BACK. There is no timeout on purpose: an automatic resume halfway through
 * somebody's complaint is worse than silence.
 */

import type { Conversation, Store, User } from '../store/index.ts';
import { can } from '../staff/access.ts';

export type HandoverReason =
  /** "Can you do 5,000?" — a figure being negotiated is a decision. */
  | 'negotiating'
  /** An existing loan: extensions, can't-pay, disputes. */
  | 'existing-loan'
  /** They asked for a person, or they are angry. */
  | 'asked-for-a-person'
  /** Police, theft, ownership disputes. Never the agent's to answer. */
  | 'ownership'
  /** Two messages in a row it could not place. Two strikes, not five. */
  | 'lost';

/**
 * Ordinary intake talk that merely sounds alarming.
 *
 * The checklist itself asks for a *police declaration of ownership*, so a
 * customer answering "yes, I have the police declaration" is doing exactly
 * what was asked. Escalating that would punish the honest ones and bury Lukas
 * in messages about paperwork that is going fine.
 */
const EXEMPT = /\b(police\s+(declaration|affidavit|clearance)|declaration of ownership)\b/i;

const TRIGGERS: { reason: HandoverReason; pattern: RegExp; why: string }[] = [
  {
    reason: 'ownership',
    pattern: /\b(stolen|stole|steal|i took it|not mine|belongs to|police|reported it|robbed|snatch)\b/i,
    why: 'Something about ownership or the police',
  },
  {
    reason: 'existing-loan',
    pattern:
      /\b(my loan|existing loan|extend|extension|roll ?over|can'?t pay|cannot pay|late payment|already pawned|still owe|owe you|my item back|collect my)\b/i,
    why: 'About a loan they already have',
  },
  {
    reason: 'asked-for-a-person',
    pattern:
      /\b(real person|a human|speak to (someone|a person|lukas)|talk to (someone|a person|lukas|a real)|manager|useless|rubbish|scam|you'?re a bot|stupid bot)\b/i,
    why: 'They asked for a person, or they are unhappy',
  },
  {
    reason: 'negotiating',
    pattern:
      /\b(can you do|will you take|how about|make it|i'?ll accept|lowest you|best you can|negotiate|more than that|too low)\b/i,
    why: 'Negotiating a figure',
  },
];

export interface Handover {
  reason: HandoverReason;
  why: string;
}

/**
 * Which trigger this message fires, if any.
 *
 * Checked in order of seriousness, not of appearance: a message that mentions
 * both the police and a price is an ownership question first.
 */
export function detectHandover(text: string): Handover | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (EXEMPT.test(trimmed)) return null;
  for (const trigger of TRIGGERS) {
    if (trigger.pattern.test(trimmed)) return { reason: trigger.reason, why: trigger.why };
  }
  return null;
}

/** `TAKE 081 555 0101`, `SAY 0815550101 we close at 5`, `BACK ...`, `WAITING`. */
export interface HandoverCommand {
  action: 'take' | 'say' | 'back' | 'waiting';
  phone: string | null;
  message: string;
}

const COMMAND = /^\s*(take|say|back|waiting)\b\s*(.*)$/is;

export function parseHandoverCommand(text: string): HandoverCommand | null {
  const match = COMMAND.exec(text);
  if (!match) return null;

  const action = match[1]!.toLowerCase() as HandoverCommand['action'];
  const rest = match[2]!.trim();
  if (action === 'waiting') return { action, phone: null, message: '' };

  // A Namibian number with or without the country code, spaces and dashes
  // tolerated: people paste these out of their contacts.
  const number = /^(\+?\d[\d\s-]{7,15}\d)/.exec(rest);
  if (!number) return null;

  return {
    action,
    phone: number[1]!.replace(/[\s-]/g, ''),
    message: rest.slice(number[1]!.length).trim(),
  };
}

export interface HandoverResult {
  /** What the human who typed the command is told. */
  ownerMessage: string;
  /** Sent to the customer, through the shop's number. */
  customerMessage?: string;
  customerPhone?: string;
}

export class HandoverDesk {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  /** Does this thread need a person — escalated or already claimed? */
  needsAPerson(conversationId: string): boolean {
    return this.#store.conversationNeedsAPerson(conversationId);
  }

  /**
   * The agent steps back on its own. Returns what Lukas is told, or null if a
   * human already has the thread — escalating twice is noise.
   */
  escalate(conversation: Conversation, handover: Handover, customerName: string | null, phone: string): string | null {
    if (conversation.held_reason) return null;

    // No `by`: the agent is stepping back, not assigning this to anybody. It
    // shows on WAITING as unclaimed until somebody types TAKE or SAY.
    this.#store.holdConversation(conversation.id, { reason: handover.why, actor: 'agent' });

    const recent = this.#store
      .messages(conversation.id)
      .slice(-6)
      .map((message) => `${message.direction === 'in' ? '›' : '‹'} ${message.body.split('\n')[0]!.slice(0, 90)}`)
      .join('\n');

    return (
      `*Someone needs you — ${customerName ?? 'a new customer'}*\n` +
      `${phone}\n\n` +
      `${trigger(handover)}\n\n` +
      `${recent}\n\n` +
      `I've stopped replying to them. Use *SAY ${phone} <message>* to answer as the shop, ` +
      `or *BACK ${phone}* to let me carry on.`
    );
  }

  /** A human taking, replying on, or handing back a thread. */
  run(command: HandoverCommand, user: User): HandoverResult {
    if (!can(user, 'conversations.reply')) {
      return { ownerMessage: 'You cannot reply to customers from here.' };
    }

    if (command.action === 'waiting') return { ownerMessage: this.#waiting() };

    const customer = this.#store.customerByPhone(command.phone!);
    const conversation = customer ? this.#store.activeConversation(customer.id) : null;
    if (!customer || !conversation) {
      return { ownerMessage: `No open conversation with ${command.phone}.` };
    }

    const who = customer.name ?? command.phone!;

    if (command.action === 'take') {
      if (conversation.held_by && conversation.held_by !== user.id) {
        const holder = this.#store.user(conversation.held_by);
        return { ownerMessage: `${holder?.name ?? 'Somebody'} already has ${who}.` };
      }
      this.#store.holdConversation(conversation.id, { reason: 'taken by hand', actor: user.id, by: user.id });
      return {
        ownerMessage: `You have ${who}. I've stopped replying.\n\nUse *SAY ${command.phone} <message>*, then *BACK ${command.phone}* when you're done.`,
      };
    }

    if (command.action === 'say') {
      if (!command.message) return { ownerMessage: `Say what? *SAY ${command.phone} <message>*` };

      // Taking it implicitly: typing a reply to somebody the agent is still
      // talking to, without it going quiet, is how two voices end up in one
      // thread.
      if (conversation.held_by !== user.id) {
        this.#store.holdConversation(conversation.id, {
          reason: conversation.held_reason || 'taken by hand',
          actor: user.id,
          by: user.id,
        });
      }
      this.#store.recordOutbound({ conversationId: conversation.id, body: command.message });

      return {
        // Deliberately no mention of approvals: SAY is a message and nothing
        // more. A figure typed in here changes no loan, approval or ledger row.
        ownerMessage: `Sent to ${who}.`,
        customerMessage: command.message,
        customerPhone: customer.phone,
      };
    }

    // back
    if (!conversation.held_reason) return { ownerMessage: `I'm already handling ${who}.` };
    this.#store.releaseConversation(conversation.id, user.id);
    return { ownerMessage: `Thanks — I'll carry on with ${who} from where we left off.` };
  }

  #waiting(): string {
    const held = this.#store.heldConversations();
    if (held.length === 0) return 'Nobody is waiting on a person right now.';

    return (
      `*Waiting on a person — ${held.length}*\n\n` +
      held
        .map((row) => {
          const holder = row.held_by ? this.#store.user(row.held_by) : null;
          const name = holder?.name ? ` · with ${holder.name.split(' ')[0]}` : ' · nobody yet';
          return `• ${row.customer_name ?? row.customer_phone} (${row.customer_phone}) — ${row.held_reason}${name}`;
        })
        .join('\n') +
      '\n\nReply with *SAY <number> <message>*, or *BACK <number>* to hand one back to me.'
    );
  }
}

function trigger(handover: Handover): string {
  const detail: Record<HandoverReason, string> = {
    negotiating: 'They are trying to agree a figure. That is yours, not mine.',
    'existing-loan': 'This is about a loan they already have.',
    'asked-for-a-person': 'They asked to speak to a person.',
    ownership: 'Ownership or the police came up. I will not touch this one.',
    lost: 'I have stopped asking rather than ask a fourth time.',
  };
  return `*${handover.why}.* ${detail[handover.reason]}`;
}
