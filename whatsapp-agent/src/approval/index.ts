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
import { referenceFor } from '../reference.ts';
import type { Rules } from '../playbook/index.ts';
import type { Approval, Store, User } from '../store/index.ts';
import type { IntakeSubmission } from '../intake/agent.ts';
import { loanTerms, schedule, suggestValuation, type MarketEstimate, type Valuation } from '../valuation.ts';
import { PriceMemory } from '../valuator/memory.ts';
import { can } from '../staff/access.ts';
import { applyAdjustment, describeFigures, parseFigureEdits, type FigureEdits, type Figures } from '../valuator/adjust.ts';

export interface ApprovalRequest {
  approval: Approval;
  reference: string;
  ownerMessage: string;
  valuation: Valuation | null;
}

export type OwnerAction = 'approve' | 'decline' | 'adjust' | 'help';

export interface OwnerReply {
  action: OwnerAction;
  reference: string | null;
  amountCents: number | null;
  note: string | null;
  /** Which figures he named, for an ADJUST. */
  edits: FigureEdits;
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
  '• *DECLINE <ref> <reason>* — turn it down\n' +
  '• *ADJUST <ref> <amount>* — change the loan and remember it\n' +
  '• *ADJUST <ref> market 8000 buy 4500* — change any figure by name\n\n' +
  'The reference is the code in the application message, e.g. APPROVE A1B2 3000.\n' +
  'Figures you can name: *market*, *assessed*, *loan*, *buy*.\n\n' +
  'To look at the book instead:\n' +
  '• *BOOK* — what is out, what is coming in\n' +
  '• *DUE* — falling due this week\n' +
  '• *OVERDUE* — past grace, and what is in grace\n' +
  '• *CUSTOMER <name or number>* — one person’s history';

export { referenceFor };

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
  request(submission: IntakeSubmission, estimates: MarketEstimate[] = [], suggestion?: Valuation): ApprovalRequest {
    const valuation = suggestion ?? (estimates.length > 0 ? suggestValuation(estimates, this.#rules) : null);
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
    // Keep the decision, item status, overrides and audit in one commit. The
    // router sends WhatsApp messages only after this synchronous work returns.
    return this.#store.transaction(() => this.#applyOwnerReply(text, owner));
  }

  #applyOwnerReply(text: string, owner: User): DecisionResult {
    // The project's oldest constraint, enforced here rather than only at the
    // routing layer: pricing and accepting a loan is the owner's alone, and
    // no second caller may reach this by holding a User of the wrong kind.
    if (!can(owner, 'approvals.decide')) {
      return {
        ownerMessage:
          'Only Lukas can approve, adjust or decline an application. ' +
          'Everything else here is open to you — the queue, a customer, replying to someone.',
      };
    }

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

    if (reply.action === 'adjust') return this.#adjust(approval, reply, owner);
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

    // Validate before writing the decision or override. A bad amount used to
    // approve the row first and only then fail while calculating its terms.
    const minimum = this.#rules.playbook.loanSizing.minimumLoanCents;
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents < minimum) {
      return { ownerMessage: `The loan must be at least ${formatAmount(minimum)} under the playbook. Nothing was approved.` };
    }
    const terms = loanTerms({ principalCents: amountCents }, this.#rules);

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

  /**
   * Changes the figures without deciding anything. The application stays
   * pending — adjusting a price is not approving a loan — and what he decided
   * goes into the knowledge base so the next item of the same kind starts from
   * his number instead of a fresh guess (playbook section 3).
   */
  #adjust(approval: Approval, reply: OwnerReply, owner: User): DecisionResult {
    const reference = referenceFor(approval.id);
    if (Object.keys(reply.edits).length === 0) {
      return {
        ownerMessage:
          `Tell me what to change, e.g. *ADJUST ${reference} 3500* for the loan, ` +
          `or *ADJUST ${reference} market 8000 buy 4500*.`,
      };
    }

    if (Object.values(reply.edits).some((amount) => !Number.isSafeInteger(amount) || amount <= 0)) {
      return { ownerMessage: 'Every adjusted figure must be a positive amount. Nothing was changed.' };
    }

    const item = this.#store.item(approval.item_id)!;
    const current = this.#figuresFor(approval);
    const adjusted = applyAdjustment(current, reply.edits, this.#rules);

    this.#store.updateApprovalSuggestion(approval.id, adjusted.loanCents, owner.id);
    if (approval.valuation_id) {
      this.#store.recordValuationOverride(approval.valuation_id, adjusted.loanCents, 'adjusted by Lukas', owner.id);
    }

    new PriceMemory(this.#store, this.#rules).remember({
      key: { categorySlug: item.category_slug, variant: item.variant, description: item.description },
      marketValueCents: adjusted.marketValueCents,
      assessedValueCents: adjusted.assessedValueCents,
      loanCents: adjusted.loanCents,
      buyNowCents: adjusted.buyNowCents,
      suggestedLoanCents: approval.suggested_loan_cents,
      itemId: item.id,
      valuationId: approval.valuation_id,
      adjustedBy: owner.id,
    });

    const days = this.#rules.playbook.adjustmentMemoryDays;
    return {
      ownerMessage:
        `Adjusted ${reference} — ${item.description || item.category_slug}\n\n` +
        `${describeFigures(adjusted, formatAmount)}\n\n` +
        `Remembered for ${days} days, so the next one like it starts here.\n` +
        `Still waiting on you: *APPROVE ${reference}* or adjust again.`,
    };
  }

  /**
   * The figures as they stand.
   *
   * An adjustment he already made outranks the original valuation, so a second
   * ADJUST builds on the first instead of silently reverting whatever he
   * changed last time — he corrects the market value, then the buy price, and
   * both stick.
   */
  #figuresFor(approval: Approval): Figures {
    const { discountFactor, buyNowMarkupPct } = this.#rules.playbook.loanSizing;
    const valuation = approval.valuation_id ? this.#store.valuation(approval.valuation_id) : null;
    const item = this.#store.item(approval.item_id)!;

    const loanCents = approval.suggested_loan_cents ?? valuation?.suggested_loan_cents ?? 0;
    const fromValuation: Figures = {
      marketValueCents: valuation ? Math.round(valuation.assessed_value_cents / discountFactor) : null,
      assessedValueCents: valuation?.assessed_value_cents ?? null,
      loanCents,
      buyNowCents: loanCents + Math.round((loanCents * buyNowMarkupPct) / 100),
    };

    const remembered = new PriceMemory(this.#store, this.#rules).recall({
      categorySlug: item.category_slug,
      variant: item.variant,
      description: item.description,
    });
    if (!remembered) return fromValuation;

    return {
      marketValueCents: remembered.marketValueCents ?? fromValuation.marketValueCents,
      assessedValueCents: remembered.assessedValueCents ?? fromValuation.assessedValueCents,
      loanCents: approval.suggested_loan_cents ?? remembered.loanCents,
      buyNowCents: remembered.buyNowCents ?? fromValuation.buyNowCents,
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
 * Reads a reply from Lukas. Deliberately narrow: anything it does not clearly
 * recognise as an approve or a decline returns `help`, so an ambiguous message
 * can never be read as a decision.
 */
export function parseOwnerReply(text: string): OwnerReply {
  const trimmed = text.trim();
  const match = /^(approve|approved|yes|ok|okay|decline|declined|no|reject|adjust|change|set)\b\s*(.*)$/i.exec(trimmed);
  if (!match) return { action: 'help', reference: null, amountCents: null, note: null, edits: {} };

  const verb = match[1]!.toLowerCase();
  const action: OwnerAction = /^(decline|declined|no|reject)/.test(verb)
    ? 'decline'
    : /^(adjust|change|set)/.test(verb)
      ? 'adjust'
      : 'approve';
  let rest = match[2]!.trim();

  let reference: string | null = null;
  const referenceMatch = /^([A-Za-z0-9]{4})\b/.exec(rest);
  if (referenceMatch && !isAmount(referenceMatch[1]!)) {
    reference = referenceMatch[1]!.toUpperCase();
    rest = rest.slice(referenceMatch[0].length).trim();
  }

  // An ADJUST can name several figures at once, so its whole tail is read as
  // field/amount pairs rather than as one amount and a note.
  if (action === 'adjust') {
    const edits = parseFigureEdits(rest, parseAmount);
    return { action, reference, amountCents: edits.loan ?? null, note: null, edits };
  }

  let amountCents: number | null = null;
  const amountMatch = /^(n\$\s?)?-?[\d][\d\s,.]*/i.exec(rest);
  if (amountMatch) {
    amountCents = parseAmount(amountMatch[0]);
    // An explicit but unreadable figure is not permission to use the suggested
    // one. Ask again instead of converting a typo into a different offer.
    if (amountCents === null) return { action: 'help', reference, amountCents: null, note: null, edits: {} };
    rest = rest.slice(amountMatch[0].length).trim();
  }

  return { action, reference, amountCents, note: rest.replace(/^[-—:]\s*/, '').trim() || null, edits: {} };
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
    if (valuation.belowMinimum) {
      lines.push('');
      lines.push(
        `⚠️ *Under your ${formatAmount(rules.playbook.loanSizing.minimumLoanCents)} minimum.* ` +
          'The playbook declines these — same work as a big loan, and the interest does not cover it.',
      );
    }
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
  lines.push('Only estimates may have been shown. No final price or approval has been given.');

  return lines.join('\n');
}

/** Trims the "Reply *yes*..." tail off a question for the summary. */
function shorten(text: string): string {
  return text.split('\n')[0]!.replace(/^Can you confirm:\s*/i, '').trim();
}
