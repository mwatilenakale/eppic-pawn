/**
 * Recording that an item is physically in the shop.
 *
 * One thing this does NOT yet make true: the loan's dates are still fixed
 * when the contract is *issued*, not when it is signed. Approved on the
 * Monday and signed on the Thursday, the month still runs from the Monday —
 * three days of it gone before the customer had the money. That is the
 * remaining half of Codex's finding A and it is a decision for Lukas with
 * legal advice, because fixing it means re-dating the document a customer
 * signs and `contracts.body_sha256` exists to prove what that document was.
 * Until then the message below says nothing about when the month starts.
 *
 * Lukas, 30 October 2026: *"They can't sign until the item has been received,
 * so when they sign it is assumed that the item has been received by our staff
 * and is in the possession of the pawn shop."*
 *
 * That one sentence is what makes the rest of the money correct. Signing
 * creates the loan, posts the principal and the interest and starts the
 * 30-day clock, and the agreement tells the customer the loan starts at
 * handover — all three are true together only if nobody can sign before the
 * item arrives. Nothing enforced it, so a customer could open the link at home
 * and begin owing interest on an item still in their kitchen (Codex's website
 * audit, finding A).
 *
 * Not an approval, and not withheld from staff: the hire takes items in and
 * inspects them. It writes no money and decides nothing — it records a fact
 * about where an object is. Gated on `inspections.work`, which both roles
 * hold, rather than inventing a capability for one more verb.
 */

import type { Store } from '../store/index.ts';
import type { User } from '../store/index.ts';
import { referenceFor } from '../reference.ts';
import { can } from '../staff/access.ts';

export interface ReceivedCommand {
  reference: string | null;
}

const RECEIVED = /^(received|received item|item received|arrived|in the shop|got it)\b/i;

/** `RECEIVED A1B2` — from Lukas or from the hire. */
export function parseReceivedCommand(text: string): ReceivedCommand | null {
  const trimmed = text.trim();
  if (!RECEIVED.test(trimmed)) return null;

  const rest = trimmed.replace(RECEIVED, '').trim();
  const reference = /^([A-Z][A-Z0-9]{3})\b/.exec(rest.toUpperCase());
  return { reference: reference ? reference[1]! : null };
}

export interface ReceivedResult {
  /** What the person who typed it is told. */
  reply: string;
  /** Set when the item's owner should now be invited to come and sign. */
  customerPhone?: string;
  customerMessage?: string;
}

/**
 * Marks the item behind an approval as in the shop.
 *
 * Keyed on the approval reference, because that is the code the person has in
 * front of them — it is the one in the approval message they or Lukas read.
 */
export function recordReceipt(
  store: Store,
  command: ReceivedCommand,
  actor: User,
  options: { signingUrlFor: (approvalId: string) => string | null; ownerLabel: string },
): ReceivedResult {
  if (!can(actor, 'inspections.work')) {
    return { reply: 'Taking an item in is not something this number can record.' };
  }

  if (!command.reference) {
    return {
      reply: 'Which item? Reply *RECEIVED <ref>* with the reference from the approval message, e.g. *RECEIVED A1B2*.',
    };
  }

  // Only approved applications: an item for something nobody has said yes to
  // yet is not a handover, it is a customer who has arrived early.
  const approvals = store.db
    .prepare("SELECT * FROM approvals WHERE status = 'approved' ORDER BY decided_at DESC")
    .all() as unknown as { id: string; item_id: string }[];
  const approval = approvals.find((entry) => referenceFor(entry.id) === command.reference);

  if (!approval) {
    return {
      reply: `Nothing approved matches ${command.reference}. Check the reference against the approval message — only an approved application can have its item taken in.`,
    };
  }

  const before = store.item(approval.item_id);
  if (!before) return { reply: `The item behind ${command.reference} is missing from the records.` };
  if (before.received_at) {
    return {
      reply: `${command.reference} was already recorded as here on ${before.received_at.slice(0, 10)}. Nothing changed.`,
    };
  }

  store.markItemReceived(approval.item_id, actor.id);
  const customer = store.customer(before.customer_id);
  const link = options.signingUrlFor(approval.id);

  return {
    reply:
      `Recorded: ${command.reference} — ${before.description || 'the item'} is in the shop, taken in by ${actor.name}.\n\n` +
      (link
        ? 'The customer can sign now. Until this moment the agreement could not be signed, which is what keeps the loan from starting before the item arrived.'
        : 'No agreement has been issued for it yet, so there is nothing to sign.'),
    customerPhone: link ? customer?.phone : undefined,
    customerMessage: link
      ? `Thank you — we have your ${before.description || 'item'} here with us.\n\n` +
        `You can read and sign your agreement now: ${link}\n\n` +
        `Your dates and the amount to repay are on the agreement, and ${options.ownerLabel} will go through it with you before you sign.`
      : undefined,
  };
}
