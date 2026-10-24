/**
 * Who may do what.
 *
 * Two boundaries separate Lukas from the person at the counter, and only two.
 * Everything else is open to staff on purpose — they run the shop when he is
 * not there, and a system that makes them ask permission to do their job gets
 * worked around rather than used.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/playbook/index.ts';
import { Store, type User } from '../src/store/index.ts';
import { ApprovalWorkflow } from '../src/approval/index.ts';
import { Book } from '../src/book/index.ts';
import {
  AccessError,
  can,
  capabilitiesOf,
  generateStaffToken,
  hashStaffToken,
} from '../src/staff/access.ts';

const rules = loadRules();

let store: Store;
let lukas: User;
let staff: User;

beforeEach(() => {
  store = new Store(':memory:');
  lukas = store.ensureUser({ name: 'Lukas', phone: '+264811110000', role: 'owner' });
  staff = store.ensureUser({ name: 'Counter staff', phone: '+264811112222', role: 'inspector' });
});

afterEach(() => store.close());

describe('the one boundary', () => {
  test('only the owner decides on money', () => {
    assert.equal(can(lukas, 'approvals.decide'), true);
    assert.equal(can(staff, 'approvals.decide'), false);
  });

  test('and that is the whole of the difference', () => {
    const missing = capabilitiesOf(lukas).filter((capability) => !capabilitiesOf(staff).includes(capability));
    assert.deepEqual(missing.sort(), ['approvals.decide'], 'deciding money is the only thing staff cannot do');
  });

  test('staff can do the day-to-day work without asking', () => {
    for (const capability of ['book.chase', 'customers.lookup', 'conversations.reply', 'inspections.work', 'customers.merge'] as const) {
      assert.equal(can(staff, capability), true, `staff cannot ${capability}`);
    }
  });

  /**
   * Reversed by Lukas on 21 October 2026. It was a real restriction with real
   * tests behind it, so it is recorded as a decision rather than quietly
   * deleted: a person who can see per-loan amounts can add them up anyway.
   */
  test('staff see the book total as well, since October 2026', () => {
    assert.equal(can(staff, 'book.totals'), true);
    assert.equal(can(lukas, 'book.totals'), true);
  });

  test('nobody at all is somebody with no capabilities', () => {
    assert.equal(can(null, 'customers.lookup'), false);
    assert.equal(can(undefined, 'book.chase'), false);
  });
});

describe('approvals', () => {
  test('a staff member cannot approve, even holding a real application', () => {
    const customer = store.upsertCustomer('+264811119999', 'Aina');
    const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', description: 'iPhone 13' });
    const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: 300_000 });

    const result = new ApprovalWorkflow(store, rules).handleOwnerReply('APPROVE', staff);

    assert.match(result.ownerMessage, /Only Lukas can approve/);
    assert.equal(store.approval(approval.id)!.status, 'pending', 'nothing moved');
    assert.equal(result.customerMessage, undefined, 'and the customer was told nothing');
  });

  test('the refusal points them at what they can do', () => {
    const result = new ApprovalWorkflow(store, rules).handleOwnerReply('DECLINE A1B2 too old', staff);
    assert.match(result.ownerMessage, /the queue, a customer, replying to someone/);
  });

  test('the owner is unaffected', () => {
    const result = new ApprovalWorkflow(store, rules).handleOwnerReply('help', lukas);
    assert.match(result.ownerMessage, /APPROVE/);
  });
});

describe('the book total', () => {
  test('staff get it, as of October 2026', () => {
    assert.equal(new Book(store).summary(staff).activeLoans, 0);
  });

  test('the owner gets it', () => {
    assert.equal(new Book(store).summary(lukas).activeLoans, 0);
  });

  /**
   * The guard is still wired up even though nobody is currently denied by it,
   * so restoring the restriction stays a one-line change in access.ts rather
   * than re-plumbing Book and the router. Asserted against a role with no
   * capabilities at all, which is the one case that still fails the check.
   */
  test('the guard is still live, not removed', () => {
    const book = new Book(store);
    const nobody = { role: 'stranger' as never };

    assert.throws(() => book.summary(nobody), (error: Error) => {
      assert.ok(error instanceof AccessError);
      assert.equal(error.capability, 'book.totals');
      return true;
    });
  });

  test('an unguarded call still works, for the owner-only surfaces', () => {
    // The WhatsApp router already knows it is talking to Lukas; the parameter
    // exists for callers that do not.
    assert.equal(new Book(store).summary().activeLoans, 0);
  });
});

describe('the staff link', () => {
  test('identifies the person holding it', () => {
    const { token } = store.issueStaffToken(staff.id, 'counter phone');
    assert.equal(store.staffByToken(token)?.id, staff.id);
  });

  test('only the digest is stored, never the token', () => {
    const { token } = store.issueStaffToken(staff.id);
    const rows = JSON.stringify(store.db.prepare('SELECT * FROM staff_tokens').all());

    assert.doesNotMatch(rows, new RegExp(token.slice(0, 20)), 'a stolen database copy is not a set of keys');
    assert.match(rows, new RegExp(hashStaffToken(token)));
  });

  test('a revoked link stops working, and stays on the record', () => {
    const { token, id } = store.issueStaffToken(staff.id, 'old phone');
    store.revokeStaffToken(id, lukas.id);

    assert.equal(store.staffByToken(token), null);
    assert.equal(store.staffTokens().length, 1, 'who had access and when is not deleted');
    assert.ok(store.staffTokens()[0]!.revoked_at);
  });

  test('an unknown link and a revoked one are indistinguishable', () => {
    assert.equal(store.staffByToken(generateStaffToken()), null);
    assert.equal(store.staffByToken('not-a-token'), null);
  });

  test('tokens are not guessable', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateStaffToken()));
    assert.equal(tokens.size, 50);
    assert.ok([...tokens][0]!.length >= 40);
  });

  test('issuing and revoking are both audited', () => {
    const { id } = store.issueStaffToken(staff.id, 'counter phone');
    store.revokeStaffToken(id, lukas.id);

    const actions = store.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'staff.token%'").all();
    assert.deepEqual(actions.map((row) => (row as { action: string }).action), ['staff.token.issued', 'staff.token.revoked']);
  });
});
