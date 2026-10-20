/**
 * Who may do what.
 *
 * Two people work here — Lukas and one member of staff — so this is a map,
 * not a permission framework. Adding a role system sized for a company that
 * does not exist is explicitly out of scope (root CLAUDE.md); what is in
 * scope is the one real boundary the shop needs.
 *
 * Two capabilities separate them:
 *
 *   `approvals.decide` — pricing and accepting a loan is Lukas's alone. This
 *   is the project's oldest constraint and is not a preference: no path may
 *   exist for anyone else to move money, not behind a flag, not for testing.
 *
 *   `book.totals` — the aggregate position of the book. Staff can see what an
 *   individual customer owes, because they need it to serve that customer;
 *   they do not get the screen that adds the whole book up.
 *
 * On that second one, honestly: a determined person who can see per-loan
 * amounts can add them up. Lukas chose that trade-off knowingly. What this
 * does buy is that the aggregate is never *computed* on a staff code path —
 * so it cannot leak through a layout change, a debug panel or a view-source —
 * and that looking up a customer is written to the audit log with a name
 * against it. The control is "one at a time, and we know who looked", not
 * "impossible".
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Role, User } from '../store/index.ts';

export type Capability =
  /** Approve, adjust or decline a loan. Owner only, permanently. */
  | 'approvals.decide'
  /** The book-wide position: out on loan, interest collected, profit. */
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
 * Staff get everything except the two that separate them. Written as a
 * subtraction from the full list on purpose: a capability added later is
 * granted to staff unless someone decides otherwise, which is the right
 * default for a shop where the hire does most of the work.
 */
const WITHHELD_FROM_STAFF: Capability[] = ['approvals.decide', 'book.totals'];

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
