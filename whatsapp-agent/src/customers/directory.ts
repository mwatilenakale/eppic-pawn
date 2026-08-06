/**
 * The customer directory (architecture 2.6): one internal record per person,
 * with possible duplicates flagged for Lukas rather than merged silently.
 *
 * The scan is a full pass over the customer table. At this shop's volume that
 * is a few hundred rows and costs nothing; when it stops being cheap, the fix
 * is an index on ID number, not a cleverer algorithm.
 */

import { referenceFor } from '../reference.ts';
import type { DuplicateFlag, Store, User } from '../store/index.ts';
import { matchCustomers, shouldFlag } from './matching.ts';

export interface RaisedFlag {
  flag: DuplicateFlag;
  reference: string;
  score: number;
  reasons: string[];
  /** The two records, oldest first. */
  records: { id: string; phone: string; name: string | null; idNumber: string | null }[];
}

export interface IdentityResult {
  raised: RaisedFlag[];
  /** What to send Lukas, or null when nothing needs his attention. */
  ownerMessage: string | null;
}

export interface ResolutionResult {
  ownerMessage: string;
  flag?: DuplicateFlag;
  /** Set when Lukas said the records are the same person. */
  survivorId?: string;
}

export class CustomerDirectory {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  /**
   * Records the identity a customer gave — typically the name and ID number
   * from a signed contract — and checks it against everyone already known.
   */
  recordIdentity(customerId: string, identity: { name?: string; idNumber?: string }, actor: string): IdentityResult {
    this.#store.updateCustomerIdentity(customerId, identity, actor);
    const subject = this.#store.customer(customerId)!;

    const raised: RaisedFlag[] = [];

    for (const other of this.#store.customers()) {
      if (other.id === subject.id) continue;
      if (other.merged_into || subject.merged_into) continue; // already ruled on

      const result = matchCustomers(
        { name: subject.name, idNumber: subject.id_number, phone: subject.phone },
        { name: other.name, idNumber: other.id_number, phone: other.phone },
      );
      if (!shouldFlag(result)) continue;

      const flag = this.#store.raiseDuplicateFlag({
        customerId: subject.id,
        otherCustomerId: other.id,
        score: result.score,
        reasons: result.reasons,
      });
      if (!flag) continue; // this pair was flagged before

      raised.push({
        flag,
        reference: referenceFor(flag.id),
        score: result.score,
        reasons: result.reasons,
        records: [flag.customer_id, flag.other_customer_id].map((id) => {
          const record = this.#store.customer(id)!;
          return { id: record.id, phone: record.phone, name: record.name, idNumber: record.id_number };
        }),
      });
    }

    return { raised, ownerMessage: raised.length > 0 ? composeFlagMessage(raised) : null };
  }

  pending(): RaisedFlag[] {
    return this.#store.pendingDuplicateFlags().map((flag) => ({
      flag,
      reference: referenceFor(flag.id),
      score: flag.score,
      reasons: JSON.parse(flag.reasons) as string[],
      records: [flag.customer_id, flag.other_customer_id].map((id) => {
        const record = this.#store.customer(id)!;
        return { id: record.id, phone: record.phone, name: record.name, idNumber: record.id_number };
      }),
    }));
  }

  /**
   * Applies Lukas's ruling. "Same" links the newer record to the older one —
   * both rows stay, and the older is the one that survives, because it carries
   * the loan history.
   */
  resolve(reference: string, status: 'same' | 'different', owner: User): ResolutionResult {
    const flag = this.#store.pendingDuplicateFlags().find((entry) => referenceFor(entry.id) === reference);
    if (!flag) {
      return { ownerMessage: `I can't find a possible-duplicate pair with reference ${reference}.` };
    }

    const decided = this.#store.resolveDuplicateFlag({ flagId: flag.id, status, decidedBy: owner.id });

    // The pair is stored in id order so it is only flagged once; that says
    // nothing about which record came first. Age decides that.
    const pair = [this.#store.customer(flag.customer_id)!, this.#store.customer(flag.other_customer_id)!].sort(
      (left, right) => (left.created_at ?? '').localeCompare(right.created_at ?? '') || left.id.localeCompare(right.id),
    );
    const [survivor, duplicate] = [pair[0]!, pair[1]!];

    if (status === 'different') {
      return {
        flag: decided,
        ownerMessage: `Noted — ${describe(survivor)} and ${describe(duplicate)} are different people. I won't ask again.`,
      };
    }

    // The older record survives: it carries the earlier loans.
    this.#store.mergeCustomer(duplicate.id, survivor.id, owner.id);

    return {
      flag: decided,
      survivorId: survivor.id,
      ownerMessage:
        `Linked — ${describe(duplicate)} now points at ${describe(survivor)}.\n` +
        'Both records are kept; the older one is the person of record from now on.',
    };
  }

  /** Every record that has been linked into this one. */
  linkedTo(customerId: string): { id: string; phone: string; name: string | null }[] {
    return this.#store
      .customers()
      .filter((customer) => customer.merged_into === customerId)
      .map((customer) => ({ id: customer.id, phone: customer.phone, name: customer.name }));
  }
}

function describe(customer: { name: string | null; phone: string }): string {
  return customer.name ? `${customer.name} (${customer.phone})` : customer.phone;
}

function composeFlagMessage(raised: RaisedFlag[]): string {
  const lines = ['*Possible duplicate customer*', ''];

  for (const entry of raised) {
    const [first, second] = entry.records;
    lines.push(`Reference *${entry.reference}*`);
    lines.push(`  • ${describe(first!)}${first!.idNumber ? ` — ID ${first!.idNumber}` : ''}`);
    lines.push(`  • ${describe(second!)}${second!.idNumber ? ` — ID ${second!.idNumber}` : ''}`);
    lines.push(`  Why: ${entry.reasons.join('; ')}`);
    lines.push('');
  }

  lines.push('Reply *SAME <ref>* if it is one person, or *DIFFERENT <ref>* if not.');
  lines.push('Nothing is merged until you say so, and both records are kept either way.');
  return lines.join('\n');
}

/** Reads a duplicate ruling from Lukas. Anything else is left alone. */
export function parseDuplicateReply(text: string): { status: 'same' | 'different'; reference: string } | null {
  const match = /^(same|different|dup|duplicate|not the same|not same)\s+([A-Za-z0-9]{4})\b/i.exec(text.trim());
  if (!match) return null;

  const verb = match[1]!.toLowerCase();
  const status = verb === 'same' || verb === 'dup' || verb === 'duplicate' ? 'same' : 'different';
  return { status, reference: match[2]!.toUpperCase() };
}
