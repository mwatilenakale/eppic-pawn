# 005 — Extending a loan by a month

**Status:** DONE — Claude, 21 October 2026. `src/book/extend.ts`,
`test/extend.test.ts`. Built against Lukas's 70% rule (playbook section 8
step 3), which he gave after this spec was written; the spec's reference to
the 10% margin check is superseded — see "Two tests, and which one governs".
**Depends on:** nothing. `SELL` / `KEEP` are built (`src/book/forfeit.ts`).

## Why this exists

Playbook section 8 step 3 gives Lukas two branches once grace has run out:

> Roughly **10%+** margin remaining → extend a month. Margin gone → sell.

Only one of them is built. `SELL <ref>` sends an item to market and tells him
the margin. If the margin check says *extend*, the system says so — and then
there is nothing he can do about it in the system. He has to carry the
extension in his head or on paper, which is exactly the kind of gap the
workbook import was supposed to close.

That is not a small omission. The playbook's own worked example is an
extension, and the whole point of the margin check is that extending is
usually the better business: a loan that runs another month earns another
29% on capital already out.

## What to build

`EXTEND <ref>` from Lukas's phone, alongside `SELL` and `KEEP`.

What it has to do:

- Push the due date and the grace date out by one term, from the playbook's
  own term length — not a hard-coded 30.
- Post another month's interest to the ledger as a new entry. Section 4 says
  whether partial payments compound; read `playbook.partialPaymentCompounds`
  rather than deciding. The existing interest entry is **not** edited: the
  ledger is append-only and the trigger will abort an UPDATE.
- Tell the customer the new date and the new total, in the same plain terms
  the approval message uses.
- Record the margin it was decided against, as `SELL` does, so the reasoning
  survives.

## Constraints

- **Only Lukas.** `can(user, 'approvals.decide')`, same as everything else
  that moves money. Staff may see the past-grace list; they may not act on it.
- **No automatic extension.** Nothing may extend on a timer, any more than
  anything sells on one. An extension is a decision about money.
- **Do not edit the loan's interest.** Post a second entry. If you find
  yourself reaching for an UPDATE on `ledger_entries`, the design is wrong —
  see `AGENTS.md` rule 3.
- Section 8 allows "flexible extension" of grace as well
  (`playbook.grace.flexibleUpToDays`). Decide whether that is the same command
  or a different one, and say why in the commit.

## The tests must prove

- A loan past grace can be extended, and the new due and grace dates come
  from the playbook's term length
- The original interest entry is untouched and a second one appears
- What the customer owes afterwards matches the playbook's arithmetic, to the
  cent, computed in a test that does the sum independently
- Staff cannot extend
- Nothing extends without the command — assert a loan months past grace still
  has its original dates
- An extended loan leaves the past-grace list and reappears when the new
  grace runs out

## One thing to check first

Whether an extension should create a *second* loan row or modify the existing
one is a real design question, and the imported workbook may already answer
it — some of those 190 rows are almost certainly extensions of earlier loans.
Look at how the import represented them before choosing, and if the workbook
is ambiguous, ask Lukas rather than guessing.
