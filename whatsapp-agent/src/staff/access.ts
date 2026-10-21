/**
 * Who may do what.
 *
 * Two people work here — Lukas and one member of staff — so this is a map,
 * not a permission framework. Adding a role system sized for a company that
 * does not exist is explicitly out of scope (root CLAUDE.md); what is in
 * scope is the one real boundary the shop needs.
 *
 * One capability separates them:
 *
 *   `approvals.decide` — pricing and accepting a loan is Lukas's alone. This
 *   is the project's oldest constraint and is not a preference: no path may
 *   exist for anyone else to move money, not behind a flag, not for testing.
 *
 * `book.totals` used to be the second. Staff could look up one customer but
 * not the screen that adds the whole book up. Lukas lifted that on 21 October
 * 2026: staff see the totals and the overdue list like he does. His reasoning
 * was that a person who can see per-loan amounts can add them up anyway, so
 * the restriction was costing the hire more than it was protecting.
 *
 * The capability still exists, and the two places that check it still check
 * it — `Book.summary()` and the WhatsApp *BOOK* command. Only the grant
 * changed, so putting the restriction back is a one-line edit here rather
 * than re-plumbing the guards. Every customer lookup is still written to the
 * audit log with a name against it; that was never the part being relaxed.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Role, User } from '../store/index.ts';

export type Capability =
  /** Approve, adjust or decline a loan. Owner only, permanently. */
  | 'approvals.decide'
  /**
   * The book-wide position: out on loan, interest collected, profit.
   * Granted to staff as well since 21 October 2026 — see the note above.
   */
  | 'book.totals'
  /** Who is due and who is late, so someone can be chased. */
  | 'book.chase'
  /** One customer's history and balance, when serving them. */
  | 'customers.lookup'
  /** Reply to a customer through the shop's number. */
  | 'conversations.reply'
  /** Claim an inspection job and complete its worksheet. */
  | 'inspections.work'
  /** Rule that two customer records are the same person. */
  | 'customers.merge';

const ALL: Capability[] = [
  'approvals.decide',
  'book.totals',
  'book.chase',
  'customers.lookup',
  'conversations.reply',
  'inspections.work',
  'customers.merge',
];

/**
 * Staff get everything except approving money. Written as a subtraction from
 * the full list on purpose: a capability added later is granted to staff
 * unless someone decides otherwise, which is the right default for a shop
 * where the hire does most of the work.
 */
const WITHHELD_FROM_STAFF: Capability[] = ['approvals.decide'];

const CAPABILITIES: Record<Role, Capability[]> = {
  owner: ALL,
  inspector: ALL.filter((capability) => !WITHHELD_FROM_STAFF.includes(capability)),
};

export function can(user: Pick<User, 'role'> | null | undefined, capability: Capability): boolean {
  if (!user) return false;
  return (CAPABILITIES[user.role] ?? []).includes(capability);
}

/** Everything this person may do — for rendering a menu without guessing. */
export function capabilitiesOf(user: Pick<User, 'role'>): Capability[] {
  return [...(CAPABILITIES[user.role] ?? [])];
}

export class AccessError extends Error {
  readonly capability: Capability;
  constructor(capability: Capability, message: string) {
    super(message);
    this.name = 'AccessError';
    this.capability = capability;
  }
}

/** Throws rather than returning false, where a caller must not continue. */
export function require(user: Pick<User, 'role'> | null | undefined, capability: Capability, what: string): void {
  if (!can(user, capability)) throw new AccessError(capability, what);
}

// --- the staff link --------------------------------------------------------

/**
 * The credential itself. Long enough that guessing is not a strategy, and
 * URL-safe so it survives being pasted into WhatsApp.
 */
export function generateStaffToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only the digest is stored; a stolen database copy is not a set of keys. */
export function hashStaffToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
