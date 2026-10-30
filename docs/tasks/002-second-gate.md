# 002 — The second approval gate

**Status:** DONE — Claude, 30 October 2026. Built after Lukas corrected the
sequence twice in one day: first that nobody can sign before the item is
received, then that the agreement itself belongs at the very end, after staff
have checked the item.

**What landed:** `APPROVE` tells the customer a figure and issues nothing.
`RECEIVED <ref>` records the item as in the shop and opens the inspection —
the spec put that at approval time, and receipt is the better trigger now that
there is one, because a queue full of items that may never arrive is a queue
nobody trusts. A submitted worksheet messages Lukas with the outcome, every
failed check, and the inspector's findings. `RELEASE <ref>` issues the
agreement and sends the link; `HOLD <ref> <reason>` tells the customer kindly.
Staff can inspect and submit; they cannot release, and trying says so rather
than printing the help text.

**One thing the spec had wrong.** It said the agreement could be *drafted* at
gate one so it was ready. Lukas's correction rules that out — "the customer
cannot have access to the agreement" — and drafting early would have meant the
document carried dates fixed before anyone saw the item. Nothing is drafted
until release.

**A change this forced elsewhere.** Approving used to record every outstanding
requirement as *waived*, which made sense while `APPROVE` was the last gate.
As the first gate it was wrong and it looked it: one approval produced a
sixteen-line "you approved this without" list naming every photo and fraud
check, before the item was in the shop. Those are not waived, they have not
happened. The waiver moved to the release gate, where a gap really is him
deciding to go ahead without something.

**Still open, and not this task's:** the loan's dates are fixed when the
contract is issued rather than when it is signed. Release now happens with the
customer at the counter, so the gap is minutes rather than days — but it is
not zero, and it is why no message claims the month starts at signing. See
`docs/website-audit.md`, finding A.

## Why this exists

Today one `APPROVE` does two jobs at once: it tells the customer a figure
*and* issues the agreement. But the item has not been seen yet. The whole
point of "subject to the physical check" is that something happens between
those two moments.

## What to build

Split the approval in two.

**Gate one — approve in principle.** `APPROVE <ref>` keeps its current
meaning to the customer: here is a figure, bring the item in. It should
additionally open an inspection job (`InspectionQueue.open`). It must *not*
issue the contract.

**Gate two — release.** When an inspection is submitted, Lukas gets a message
with: the item, who inspected it, every check and its answer, the failures
called out, and their findings in their own words. He replies `RELEASE <ref>`
and only then is the agreement issued and the signing link sent.
`HOLD <ref> <reason>` is the other outcome — the customer is told, kindly.

The agreement can be *drafted* at gate one so it is ready; it must not be
*signable* until gate two.

## Constraints

- Lukas decides both gates. Staff can submit a report and recommend; they
  cannot release. `can(user, 'approvals.decide')` already draws that line.
- A failed check does not auto-decline. It is reported prominently and he
  chooses — the system's job is to make sure he cannot not be told.
- The contract body is immutable once signed; there is a trigger enforcing
  it. Draft early, issue once.

## The tests must prove

- `APPROVE` tells the customer a figure and opens an inspection job
- `APPROVE` alone does **not** produce a signing link
- A signing link exists only after `RELEASE`
- `RELEASE` before any inspection is submitted is refused, with a reason
- A staff member cannot `RELEASE`
- `HOLD` tells the customer and leaves no contract behind
- An inspection that failed a check still reaches Lukas, and the failures are
  visible in the message he gets
