/**
 * The approval workflow: one tier, and that tier is Lukas (architecture 2.4).
 *
 * The agent assembles what he needs to decide with — item, photos, answers,
 * flags, the in-person verification list and, where estimates exist, a
 * *suggested* figure with its working. Then it waits. Nothing here can move an
 * application forward without a reply from him, and the customer is never told
 * a number until that reply exists.
 */

import { formatAmount, parseAmount } from '../money.ts';
import type { Rules } from '../playbook/index.ts';
import type { Approval, Store, User } from '../store/index.ts';
import type { IntakeSubmission } from '../intake/agent.ts';
import { loanTerms, schedule, suggestValuation, type MarketEstimate, type Valuation } from '../valuation.ts';

export interface ApprovalRequest {
  approval: Approval;
  reference: string;
  ownerMessage: string;
  valuation: Valuation | null;
}

export type OwnerAction = 'approve' | 'decline' | 'help';

export interface OwnerReply {
  action: OwnerAction;
  reference: string | null;
  amountCents: number | null;
  note: string | null;
}

export interface DecisionResult {
  /** What to send back to Lukas. */
  ownerMessage: string;
  /** What the customer is told, once there is a decision to tell them. */
  customerMessage?: string;
  customerPhone?: string;
  approval?: Approval;
}

const HELP =
  'Reply with one of:\n' +
  '• *APPROVE <ref>* — approve at the suggested amount\n' +
  '• *APPROVE <ref> <amount>* — approve at your own amount\n' +
  '• *DECLINE <ref> <reason>* — turn it down\n\n' +
  'The reference is the code in the application message, e.g. APPROVE A1B2 3000.';

export class ApprovalWorkflow {
  readonly #store: Store;
  readonly #rules: Rules;

  constructor(store: Store, rules: Rules) {
    this.#store = store;
    this.#rules = rules;
  }

  /**
   * Records a pending approval and composes the message to Lukas. A valuation
   * is included only when market estimates were supplied; without them the
   * message asks him for the amount rather than inventing one.
   */
  request(submission: IntakeSubmission, estimates: MarketEstimate[] = []): ApprovalRequest {
    const valuation = estimates.length > 0 ? suggestValuation(estimates, this.#rules) : null;
    const stored = valuation
      ? this.#store.saveValuation({
          itemId: submission.item.id,
          estimates: valuation.estimates,
          assessedValueCents: valuation.assessedValueCents,
          suggestedLoanCents: valuation.suggestedLoanCents,
          formula: valuation.formula,
          workings: valuation.workings,
        })
      : null;

    const approval = this.#store.createApproval({
      itemId: submission.item.id,
      valuationId: stored?.id ?? null,
      conversationId: submission.conversationId,
      suggestedLoanCents: valuation?.suggestedLoanCents ?? null,
    });

    const reference = referenceFor(approval.id);
    return {
      approval,
      reference,
      valuation,
      ownerMessage: composeApprovalMessage(submission, valuation, reference, this.#rules),
    };
  }

  /** Applies a reply from Lukas. Anything it cannot read decides nothing. */
  handleOwnerReply(text: string, owner: User): DecisionResult {
    const reply = parseOwnerReply(text);
    const pending = this.#store.pendingApprovals();

    if (reply.action === 'help') {
      return { ownerMessage: pending.length === 0 ? `Nothing is waiting for you right now.\n\n${HELP}` : HELP };
    }
    if (pending.length === 0) {
      return { ownerMessage: 'Nothing is waiting for a decision right now.' };
    }

    const approval = reply.reference
      ? pending.find((entry) => referenceFor(entry.id) === reply.reference)
      : pending.length === 1
        ? pending[0]
        : undefined;

    if (!approval) {
      if (!reply.reference && pending.length > 1) {
        return {
          ownerMessage:
            `${pending.length} applications are waiting — tell me which one:\n` +
            pending.map((entry) => `• ${referenceFor(entry.id)} — ${this.#describe(entry)}`).join('\n'),
        };
      }
      return { ownerMessage: `I can't find a pending application with reference ${reply.reference}.` };
    }

    return reply.action === 'approve' ? this.#approve(approval, reply, owner) : this.#decline(approval, reply, owner);
  }

  #approve(approval: Approval, reply: OwnerReply, owner: User): DecisionResult {
    const amountCents = reply.amountCents ?? approval.suggested_loan_cents;
    if (amountCents === null) {
      return {
        ownerMessage:
          `No suggested amount exists for ${referenceFor(approval.id)} — reply *APPROVE ${referenceFor(approval.id)} <amount>* with the figure you want to offer.`,
      };
    }

    if (approval.valuation_id && reply.amountCents !== null && reply.amountCents !== approval.suggested_loan_cents) {
      this.#store.recordValuationOverride(
        approval.valuation_id,
        reply.amountCents,
        reply.note ?? 'adjusted on approval',
        owner.id,
      );
    }

    const decided = this.#store.decideApproval({
      approvalId: approval.id,
      status: 'approved',
      approvedLoanCents: amountCents,
      decidedBy: owner.id,
      note: reply.note ?? undefined,
    });
    this.#store.updateItem(approval.item_id, { status: 'approved' });

    const terms = loanTerms({ principalCents: amountCents }, this.#rules);
    const item = this.#store.item(approval.item_id)!;
    const customer = this.#store.db
      .prepare('SELECT phone FROM customers WHERE id = ?')
      .get(item.customer_id) as { phone: string };

    return {
      approval: decided,
      ownerMessage:
        `Approved ${referenceFor(approval.id)} at ${formatAmount(amountCents)}.\n` +
        `Terms from the playbook: ${terms.ratePct}% over ${terms.termDays} days — ${formatAmount(terms.totalDueCents)} due, ${terms.graceDays}-day grace.\n` +
        'The customer has been told. The loan itself starts at handover, once the in-person checks pass.',
      customerPhone: customer.phone,
      customerMessage:
        `Good news — Lukas has reviewed your application and can offer ${formatAmount(amountCents)} on your ${item.description || 'item'}.\n\n` +
        `Terms: ${terms.ratePct}% over ${terms.termDays} days, so ${formatAmount(terms.totalDueCents)} to collect it, with a ${terms.graceDays}-day grace period.\n\n` +
        'This is subject to the in-person check when you bring the item in. Bring your ID, proof of ownership and the police declaration. Reply here to arrange a time.',
    };
  }

  #decline(approval: Approval, reply: OwnerReply, owner: User): DecisionResult {
    const decided = this.#store.decideApproval({
      approvalId: approval.id,
      status: 'declined',
      decidedBy: owner.id,
      note: reply.note ?? undefined,
    });
    this.#store.updateItem(approval.item_id, { status: 'declined' });

    const item = this.#store.item(approval.item_id)!;
    const customer = this.#store.db
      .prepare('SELECT phone FROM customers WHERE id = ?')
      .get(item.customer_id) as { phone: string };

    return {
      approval: decided,
      ownerMessage: `Declined ${referenceFor(approval.id)}${reply.note ? ` — ${reply.note}` : ''}. The customer has been told.`,
      customerPhone: customer.phone,
      customerMessage:
        'Thank you for your application. Unfortunately Lukas is not able to take this item on at the moment' +
        (reply.note ? `: ${reply.note}.` : '.') +
        '\n\nYou are welcome to try again with something else — we take cars, phones, laptops, TVs and consoles.',
    };
  }

  #describe(approval: Approval): string {
    const item = this.#store.item(approval.item_id);
    return item ? `${item.category_slug}: ${item.description || 'no description'}` : 'unknown item';
  }
}

/**
 * Short code Lukas types back, e.g. `KP7R`.
 *
 * The first character is always a letter and the alphabet drops I/O/0/1, so a
 * reference can never be mistaken for the amount that follows it, and can't be
 * misread off a phone screen.
 */
const REFERENCE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const REFERENCE_ALPHABET = `${REFERENCE_LETTERS}23456789`;

export function referenceFor(approvalId: string): string {
  let value = Number.parseInt(approvalId.replace(/-/g, '').slice(0, 8), 16);
  const characters = [REFERENCE_LETTERS[value % REFERENCE_LETTERS.length]!];
  value = Math.floor(value / REFERENCE_LETTERS.length);

  for (let index = 1; index < 4; index += 1) {
    characters.push(REFERENCE_ALPHABET[value % REFERENCE_ALPHABET.length]!);
    value = Math.floor(value / REFERENCE_ALPHABET.length);
  }
  return characters.join('');
}

/**
 * Reads a reply from Lukas. Deliberately narrow: anything it does not clearly
 * recognise as an approve or a decline returns `help`, so an ambiguous message
 * can never be read as a decision.
 */
export function parseOwnerReply(text: string): OwnerReply {
  const trimmed = text.trim();
  const match = /^(approve|approved|yes|ok|okay|decline|declined|no|reject)\b\s*(.*)$/i.exec(trimmed);
  if (!match) return { action: 'help', reference: null, amountCents: null, note: null };

  const verb = match[1]!.toLowerCase();
  const action: OwnerAction = /^(decline|declined|no|reject)/.test(verb) ? 'decline' : 'approve';
  let rest = match[2]!.trim();

  let reference: string | null = null;
  const referenceMatch = /^([A-Za-z0-9]{4})\b/.exec(rest);
  if (referenceMatch && !isAmount(referenceMatch[1]!)) {
    reference = referenceMatch[1]!.toUpperCase();
    rest = rest.slice(referenceMatch[0].length).trim();
  }

  let amountCents: number | null = null;
  const amountMatch = /^(n\$\s?)?[\d][\d\s,.]*/i.exec(rest);
  if (amountMatch) {
    amountCents = parseAmount(amountMatch[0]);
    if (amountCents !== null) rest = rest.slice(amountMatch[0].length).trim();
  }

  return { action, reference, amountCents, note: rest.replace(/^[-—:]\s*/, '').trim() || null };
}

function isAmount(token: string): boolean {
  return /^\d+$/.test(token);
}

/** The message Lukas actually receives on WhatsApp. */
export function composeApprovalMessage(
  submission: IntakeSubmission,
  valuation: Valuation | null,
  reference: string,
  rules: Rules,
): string {
  const { item, customer, plan, answers, flagged, missing, photoKinds, requestedAmountCents } = submission;
  const lines: string[] = [];

  lines.push(`*New pawn application — ${reference}*`);
  lines.push('');
  lines.push(`*Item:* ${item.description || '(not described)'}`);
  lines.push(`*Category:* ${item.category_slug}${item.variant ? ` / ${item.variant}` : ''}`);
  lines.push(`*Customer:* ${customer.name ?? 'name not given'} (${customer.phone})`);
  if (requestedAmountCents !== null) lines.push(`*Customer is hoping for:* ${formatAmount(requestedAmountCents)}`);
  lines.push(`*Photos received:* ${photoKinds.length > 0 ? photoKinds.join(', ') : 'none'}`);

  lines.push('');
  if (valuation) {
    const terms = loanTerms({ principalCents: valuation.suggestedLoanCents }, rules);
    const dates = schedule(new Date().toISOString().slice(0, 10), terms, rules);
    lines.push('*Suggested loan (your formula, not an offer):*');
    for (const step of valuation.workings) lines.push(`  ${step}`);
    lines.push(`  → ${terms.ratePct}% over ${terms.termDays} days = ${formatAmount(terms.totalDueCents)} due ${dates.dueDate}`);
  } else {
    lines.push('*No market estimate yet* — reply with the amount you want to offer.');
  }

  const confirmed = answers.filter((answer) => answer.confirmed === true && answer.kind === 'confirm');
  lines.push('');
  lines.push(`*Customer confirmed:* ${confirmed.length} of ${answers.filter((a) => a.kind === 'confirm').length} checks`);

  if (flagged.length > 0) {
    lines.push('');
    lines.push('*⚠️ Flagged — not confirmed:*');
    for (const answer of flagged) lines.push(`  • ${shorten(answer.question)} → "${answer.response}"`);
  }

  if (missing.length > 0) {
    lines.push('');
    lines.push('*Still missing:*');
    for (const question of missing) lines.push(`  • ${shorten(question.ask)}`);
  }

  if (plan.inPersonChecks.length > 0) {
    lines.push('');
    lines.push('*To verify in person (from the playbook):*');
    for (const check of plan.inPersonChecks) lines.push(`  • ${check.text}`);
  }

  lines.push('');
  lines.push(`Reply *APPROVE ${reference}*, *APPROVE ${reference} <amount>*, or *DECLINE ${reference} <reason>*.`);
  lines.push('Nothing has been said to the customer about price.');

  return lines.join('\n');
}

/** Trims the "Reply *yes*..." tail off a question for the summary. */
function shorten(text: string): string {
  return text.split('\n')[0]!.replace(/^Can you confirm:\s*/i, '').trim();
}
