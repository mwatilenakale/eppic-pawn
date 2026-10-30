/**
 * The second gate — playbook section 7, docs/tasks/002.
 *
 * Lukas, 30 October 2026: *"The customer cannot have access to the agreement,
 * because the agreement is at the end of their process. If things are
 * outstanding in between, they can't sign. They only sign when the item has
 * been approved — that means our staff have checked the item, approved, and
 * then only then they sign."*
 *
 * So one `APPROVE` used to do two jobs it should never have done together: it
 * told the customer a figure *and* put a signable agreement on their phone,
 * before anybody had seen the item. The whole meaning of "subject to the
 * in-person check" is that something happens in between.
 *
 * The sequence is now: approved in principle → item brought in and received →
 * staff inspect it → **RELEASE** → the agreement exists and can be signed →
 * signing starts the loan.
 *
 * `HOLD <ref> <reason>` is the other outcome at this gate, and the customer is
 * told kindly rather than left waiting.
 */

import type { Rules } from '../playbook/index.ts';
import type { Store, User } from '../store/index.ts';
import { InspectionQueue } from '../inspection/queue.ts';
import { describeRequirements, outstandingIds } from '../requirements.ts';
import { referenceFor } from '../reference.ts';
import { can } from '../staff/access.ts';

export interface ReleaseCommand {
  action: 'release' | 'hold';
  reference: string | null;
  reason: string;
}

const RELEASE = /^(release|releases|released|send the agreement|send agreement)\b/i;
const HOLD = /^(hold|holds|held|wait on)\b/i;

export function parseReleaseCommand(text: string): ReleaseCommand | null {
  const trimmed = text.trim();
  const release = RELEASE.test(trimmed);
  const hold = HOLD.test(trimmed);
  if (!release && !hold) return null;

  const rest = trimmed.replace(release ? RELEASE : HOLD, '').trim();
  const reference = /^([A-Z][A-Z0-9]{3})\b/.exec(rest.toUpperCase());
  return {
    action: release ? 'release' : 'hold',
    reference: reference ? reference[1]! : null,
    reason: (reference ? rest.slice(reference[1]!.length) : rest).replace(/^[\s,:—-]+/, '').trim(),
  };
}

export interface ReleaseOutcome {
  ownerMessage: string;
  /** Set when the gate passed and the agreement should now be issued. */
  releaseApprovalId?: string;
  customerPhone?: string;
  customerMessage?: string;
}

export class ReleaseGate {
  readonly #store: Store;
  readonly #rules: Rules;
  readonly #queue: InspectionQueue;

  constructor(store: Store, rules: Rules) {
    this.#store = store;
    this.#rules = rules;
    this.#queue = new InspectionQueue(store, rules);
  }

  /**
   * Everything waiting on this gate: approved, item here, inspection in,
   * agreement not yet issued.
   */
  waiting(): { approvalId: string; itemId: string; reference: string }[] {
    const rows = this.#store.db
      .prepare(
        "SELECT a.id, a.item_id FROM approvals a WHERE a.status = 'approved'" +
          ' AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.approval_id = a.id)' +
          ' ORDER BY a.decided_at',
      )
      .all() as unknown as { id: string; item_id: string }[];

    return rows
      .filter((row) => this.#submittedFor(row.item_id) !== null)
      .map((row) => ({ approvalId: row.id, itemId: row.item_id, reference: referenceFor(row.id) }));
  }

  run(command: ReleaseCommand, actor: User): ReleaseOutcome {
    // Both gates are Lukas's. Staff inspect and recommend; they do not
    // release. This is the same line `approvals.decide` already draws.
    if (!can(actor, 'approvals.decide')) {
      return {
        ownerMessage:
          'Releasing the agreement is not something this number can do. Submit the inspection and ' +
          `${this.#rules.playbook.ownerLabel} decides from there.`,
      };
    }

    if (!command.reference) {
      return {
        ownerMessage:
          `Which one? Reply *${command.action === 'release' ? 'RELEASE' : 'HOLD'} <ref>* with the reference from the ` +
          'inspection report, e.g. *RELEASE A1B2*.',
      };
    }

    const approvals = this.#store.db
      .prepare("SELECT * FROM approvals WHERE status = 'approved' ORDER BY decided_at DESC")
      .all() as unknown as { id: string; item_id: string }[];
    const approval = approvals.find((entry) => referenceFor(entry.id) === command.reference);
    if (!approval) {
      return { ownerMessage: `Nothing approved matches ${command.reference}.` };
    }

    const item = this.#store.item(approval.item_id);
    if (!item) return { ownerMessage: `The item behind ${command.reference} is missing from the records.` };
    const customer = this.#store.customer(item.customer_id);

    if (command.action === 'hold') {
      return {
        ownerMessage:
          `Held ${command.reference}${command.reason ? ` — ${command.reason}` : ''}.\n\n` +
          'No agreement has been issued and nothing has been sent for signing. The customer has been told.',
        customerPhone: customer?.phone,
        customerMessage: customer
          ? `We have looked at your ${item.description || 'item'} here at the shop, and we are not able to go ahead with it today.\n\n` +
            (command.reason ? `${command.reason}\n\n` : '') +
            `Please message here and ${this.#rules.playbook.ownerLabel} will explain and arrange for you to collect it.`
          : undefined,
      };
    }

    // --- release ---------------------------------------------------------

    const existing = this.#store.db
      .prepare("SELECT token FROM contracts WHERE approval_id = ? AND status <> 'void' LIMIT 1")
      .get(approval.id) as { token: string } | undefined;
    if (existing) {
      return { ownerMessage: `${command.reference} already has an agreement. Nothing was issued again.` };
    }

    if (!item.received_at) {
      return {
        ownerMessage:
          `${command.reference} is not recorded as being here yet, so there is nothing to release.\n\n` +
          'Reply *RECEIVED ' + command.reference + '* when the item is in the shop.',
      };
    }

    const inspection = this.#submittedFor(approval.item_id);
    if (!inspection) {
      return {
        ownerMessage:
          `${command.reference} has not been inspected yet.\n\n` +
          'The agreement is released after the physical check, not before — that is the whole point of ' +
          'telling the customer it is subject to the in-person check. Nothing was issued.',
      };
    }

    // "If things are outstanding in between, they can't sign." Reported
    // rather than refused, because waiving a document is his to do (playbook
    // section 5) — but he cannot not be told, and releasing anyway is
    // recorded as his call on this item.
    // Keyed by requirement id, not by label. Getting that wrong records a
    // waiver the dashboard cannot match against what it is chasing, so the
    // gap is both "waived" and still on the chase list — which is how it
    // first came out when driven for real.
    const gapIds = outstandingIds(this.#store, this.#rules, approval.item_id);
    const gaps = describeRequirements(this.#store, this.#rules, approval.item_id, gapIds);
    if (gaps.length > 0) {
      this.#store.waive({
        itemId: approval.item_id,
        approvalId: approval.id,
        requirements: gaps,
        waivedBy: actor.id,
      });
    }

    const failures = inspection.failed;
    return {
      releaseApprovalId: approval.id,
      ownerMessage:
        `Releasing ${command.reference} — ${item.description || 'item'}.\n\n` +
        `Inspected by ${inspection.inspector ?? 'staff'}, outcome *${inspection.outcome}*.\n` +
        (failures.length > 0
          ? `*You released this with ${failures.length} failed check${failures.length === 1 ? '' : 's'}:*\n${failures.map((text) => `  • ${text}`).join('\n')}\n\n`
          : '') +
        (gaps.length > 0
          ? `*And without:*\n${gaps.map((entry) => `  • ${entry.label}`).join('\n')}\nRecorded against the item as your call.\n\n`
          : '') +
        'The agreement is being generated and the signing link sent now.',
    };
  }

  /** The submitted inspection for an item, with its failures spelled out. */
  #submittedFor(itemId: string): { outcome: string; inspector: string | null; failed: string[] } | null {
    const job = this.#queue.submittedFor(itemId);
    if (!job) return null;

    const failed = this.#queue
      .worksheet(job.id)
      .filter((line) => line.answer === 'fail')
      .map((line) => line.text);
    return { outcome: job.outcome ?? 'unknown', inspector: job.claimedByName, failed };
  }
}
