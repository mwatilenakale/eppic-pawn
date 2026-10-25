# 002 — The second approval gate

**Status:** OPEN — unblocked 25 October 2026. Task 001 is merged, so the
inspection it gates on now exists end to end: queue, worksheet, submitted
report. `eppic_inspection_passed_v1` is also already defined in
`src/whatsapp/templates.ts` from task 004 — use it only after the real
inspection and owner checks pass, as that task's notes say.

**Was blocked on:** the gate releases the contract after an inspection, so the
inspection had to exist first.

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
