# 006 — Taking the money back

**Status:** CLAIMED — Codex, 2026-10-21
**Depends on:** nothing.
**You may change:** `src/book/`, `src/store/` (a migration and store methods),
`src/router.ts` (the command), and the tests for those. Nothing else without
asking.

## Why this exists

A loan in this system can be created, accrue interest, be extended, and be
sent to market. It cannot be **paid**.

There is no command, no flow and no store method that records a customer
handing over money and collecting their item. `loans.status` only ever reads
`active`, `forfeited`, or `paid` on rows the workbook importer wrote. The
`repayment.principal` and `repayment.interest` ledger entry types exist and
are summed by `src/book/index.ts` — nothing in the running system ever writes
one.

So the shop can lend and it can forfeit, and the ordinary, commonest, happiest
ending of a pawn loan is the one path that does not exist. On the current code
every loan stays on the book as outstanding forever, `BOOK` overstates what is
out on loan from the first repayment onward, and `OVERDUE` will chase somebody
who paid in full last week.

This is the single thing most worth building before real customers.

## What to build

`PAID <ref> <amount>` from Lukas's phone, alongside `APPROVE`, `SELL` and
`EXTEND`.

What it has to do:

- Post the repayment to the ledger as **negative entries** — interest first,
  then principal. `src/contract/index.ts` line ~202 states that convention and
  the book's sums depend on it.
- Handle a **partial** payment. Section 4 of the playbook says whether a
  partial payment compounds; read `playbook.partialPaymentCompounds` rather
  than deciding. A partial payment leaves the loan active with less owed.
- Close the loan only when the balance reaches zero: status `paid`, and the
  item `redeemed` (the importer already uses that word, so match it).
- Reject an overpayment, or handle it explicitly and say which — do not
  silently create a negative balance.
- Tell the customer what was received and what is left, or that they are
  square and can collect the item.
- Be refusable: a payment recorded against the wrong loan must be correctable
  by a reversing entry, never by deleting one. The trigger will stop you
  anyway; the point is that the command should make the right thing easy.

## Constraints

- **Only Lukas.** `can(user, 'approvals.decide')`. Money moving is his.
- **The ledger is append-only.** Reversal, never UPDATE. See `AGENTS.md`
  rule 3.
- **Integer cents.** Never a float, and never recompute a balance from a
  percentage at read time — sum the entries.
- A forfeited loan can still be redeemed until the item is actually sold;
  the contract says so and `src/book/forfeit.ts` tells the customer so. Decide
  what `PAID` does on a forfeited loan and say why in the commit.

## The tests must prove

- A full repayment closes the loan, marks the item redeemed, and removes it
  from `BOOK`, `DUE` and `OVERDUE`
- A partial repayment leaves it active with exactly the right balance,
  computed independently in the test from the playbook's figures
- The original entries are untouched; the repayment is new rows
- Interest collected this month and all time both move by the right amount
  (`src/book/index.ts` already reports these and nothing has ever exercised
  them against a real repayment)
- Staff cannot record a payment
- An overpayment does not produce a negative balance
- A mistaken payment can be reversed, and both entries remain visible
- Redeeming a forfeited loan behaves the way the commit says it should

## One thing to check first

`test/book.test.ts` builds paid-off loans by posting the reversing entries by
hand. Read that helper before designing the store method — it is the shape the
book already expects, and matching it means the existing book tests keep
meaning what they say.
