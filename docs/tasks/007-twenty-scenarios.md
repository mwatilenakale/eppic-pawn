# 007 — Twenty scenarios, both channels, end to end

**Status:** DONE — Codex ran the audit 21 October 2026 (`audits/twenty-scenarios.ts`,
`docs/twenty-scenarios.md`), reporting 18/20 with two findings. Claude fixed both
on 24 October; the unedited audit now passes 20/20.
**Depends on:** 006 (repayment). Scenarios 14–17 cannot be written until a
loan can be paid.
**You may change:** `test/` only, plus `docs/twenty-scenarios.md` for the
write-up. Any source fix a scenario exposes goes in its own commit with its
own regression test, and **says in the commit message which scenario found
it**.

## Why this exists

Lukas wants a full-scale test before real customers. Ten scenarios have been
run twice and both rounds found real defects that no unit test had caught — a
matcher that read "PlayStation" as a phone, an item reaching him described as
"yes" with a figure against it, an honest customer reported as a thief. Every
one was found by **reading a transcript**, not by a failing assertion.

So this is not a request for more unit tests. It is a request to drive the
whole system the way a month of real trading would, and read what comes out.

## How to work

Each scenario is a real conversation or page visit through the public surface
— `POST /webhook` for WhatsApp, `POST /apply` for the website — not a direct
call into a class. `test/channel-scenarios.test.ts` already does it this way;
follow it.

For each scenario, record in `docs/twenty-scenarios.md`:

- what the customer did, verbatim
- what the system said back, verbatim
- **pass or fail, and your own judgement of whether the reply was any good** —
  a technically correct reply that would lose the customer is a fail, and say
  so

A scenario that passes mechanically but reads badly is the most valuable thing
you can find. Say it plainly.

## The twenty

**Ordinary trade (1–6).** These must simply work.

1. A new customer, iPhone, complete paperwork, approved, contract signed.
2. A returning customer recognised by number, second loan on a laptop.
3. A car: the mechanic checks, the N$50 fee, test drive deferred to staff.
4. A console: the 20–30 minute burn-in test deferred to staff.
5. A TV via the website pre-check, then handed off to WhatsApp.
6. A customer with the original receipt — confirm the police declaration is
   **never** asked for (playbook section 5).

**Where it goes wrong (7–13).**

7. An item outside the five categories. Both of Lukas's answers.
8. The same out-of-category item from a second customer after he refused the
   first — his reason must be reused without asking him again.
9. A customer who will not or cannot give a usable item description.
10. A customer with no receipt and no police declaration, approved anyway —
    the waiver must be recorded and the customer still told to bring both.
11. An item priced below the N$1,000 minimum.
12. A phone still on a payment plan — the Spectra case, in the customer's own
    words.
13. A customer who asks for a person, and the full TAKE / SAY / BACK round trip.

**Money over time (14–17).** These need task 006.

14. A loan repaid in full, on time: the book must stop showing it.
15. A partial repayment, then a second one that clears it.
16. A loan that goes past grace, is extended under the 70% line, and is then
    repaid.
17. A loan that goes past grace, fails the 70% line, and is sent to market —
    then redeemed before it sells.

**Pressure (18–20).**

18. Ten customers at once, interleaved, with two duplicate webhook deliveries
    in the middle. No crossed wires, no doubled replies, no lost message.
19. The valuator times out, returns nonsense, and returns nothing. The website
    must say so rather than invent a figure, and WhatsApp must behave exactly
    as it always does, because it quotes nothing either way.
20. A full day's trading: six intakes, two approvals, one decline, one
    extension, one forfeiture, one repayment — then read the dashboard and
    the `BOOK` reply and confirm every figure reconciles against the ledger,
    summed independently in the test.

## Hard rules these scenarios must confirm

Assert these in whichever scenarios touch them. They are the project's
constraints and a scenario run is the only place they are tested together:

- **No figure reaches a customer on WhatsApp before Lukas has replied.**
  `test/no-owner-name.test.ts` and `test/handover.test.ts` both guard this;
  do not weaken either.
- **No customer-facing message names Lukas.** The guard is
  `test/no-owner-name.test.ts`.
- **Nothing approves, extends, sells or forfeits without his reply.** No
  clock does any of it.
- **No money on any inspection screen.**
- **The ledger is only ever appended to.**

## What you must not do

- Do not change `docs/playbook.md`, `AGENTS.md`, or either `CLAUDE.md`. If a
  scenario seems to need a rule relaxed, **stop and write it in the handoff**.
  This is `AGENTS.md` rule 0 and it exists because it has already gone wrong
  once.
- Do not weaken an existing test to make a scenario pass. If an existing test
  and a scenario disagree, that disagreement is the finding — report it.
- Do not call live OpenAI or live WhatsApp. Fixed fixtures, and say in the
  write-up that the prices are fixtures and not market data.

## Done looks like

- 20 scenarios in `test/twenty-scenarios.test.ts` (split the file if it gets
  unwieldy), all green
- `docs/twenty-scenarios.md` written as above, including the scenarios that
  passed but read badly
- `npm test` and `npm run typecheck` green
- Each source fix in its own commit, naming the scenario that found it
