# AGENTS.md — read before writing any code here

This file is for coding agents working on this repository (Codex and
others). Claude Code reads `CLAUDE.md`, which says the same things in
more detail; this is the short version that matters.

Work is coordinated through git. Branch, commit, push, and say what you
did — do not expect another agent to be watching your working tree.

---

## The five rules that are not negotiable

**1. `docs/playbook.md` is the source of truth for every business rule.**

Interest rates, loan terms, the minimum loan, the buy-now markup,
screening questions, grace periods, collections thresholds — all of it
is parsed out of that document at runtime by `src/playbook/`.

Never hard-code a rate, a term, a threshold or a screening question. If
you need a new rule, add it to the playbook and parse it. The loader
deliberately throws when a rule is missing rather than defaulting, so a
rule you cannot find is a document to fix, not a constant to invent.

This has already caught real staleness: the shop's WhatsApp number was
once hard-coded and printed on every contract, and changing it in the
playbook did nothing.

**2. Nothing approves money without the owner's reply.**

Every valuation is a suggestion. Every accept, decline and price change
routes to Lukas over WhatsApp and waits. There is no auto-approve path
and none may be added, not behind a flag, not for testing, not "just for
the demo". The website may show an *estimate* — labelled as one, with
the verification banner — but an estimate binds nobody.

**3. The ledger is append-only.**

SQLite triggers abort any `UPDATE` or `DELETE` on `ledger_entries`. A
mistake is corrected by posting a reversing entry; both stay visible.
Do not work around the triggers. Balances are summed from entries, never
read from a cached total.

**4. No n8n, no low-code workflow tools.** Application code only. This
has been said explicitly and repeatedly.

**5. Sized for two people.** Lukas, plus one hire who inspects items and
has no approval authority. Do not build permission tiers, admin
hierarchies or role systems for staff that do not exist. Assigning an
inspection task to someone is fine; a second approval tier is not.

---

## How to work here

- **Run `npm install` first** if `node_modules` is absent — the test and
  typecheck failures you will otherwise see are all one missing-deps
  cause.
- `npm test` and `npm run typecheck` both pass on `main`. Keep them
  passing; a red suite is not a handoff.
- Tests are `node:test`, no framework. Name them after the behaviour
  being protected, not the function being called.
- TypeScript runs natively via type stripping — there is no build step.
  `tsc` is for typechecking only.
- One runtime dependency (`@anthropic-ai/sdk`). Think hard before adding
  a second; the `.xlsx` reader and the OpenAI client were both written
  against the standard library rather than taking one on.
- Money is integer NAD cents everywhere. Never a float.

## What must never enter the repository

- `docs/*.xlsx` or any export of the Eppic workbook — it holds 190 real
  customers' names, phone numbers and device PINs.
- `.env`, `data/`, the SQLite file, the media directory.
- `EPPIC_MEDIA_KEY` or any API key, in any file, including tests.

## Where things are

```
docs/playbook.md        every business rule — edit here, not in code
docs/architecture.md    design, build order, open regulatory question
docs/whatsapp-setup.md  Meta Cloud API setup

whatsapp-agent/src/
  playbook/   parses the documents at runtime
  intake/     the WhatsApp conversation
  approval/   APPROVE · ADJUST · DECLINE, and only from the owner
  book/       BOOK · DUE · OVERDUE · CUSTOMER — read-only by construction
  valuation   the formula, the rate table, the minimum, collections maths
  valuator/   OpenAI or Anthropic, the price memory, adjustments
  contract/   agreement, signing page, signature
  store/      SQLite, append-only ledger, encrypted media
  web/        public site and the Eppic design tokens
  whatsapp/   Cloud API transport, webhook signature verification
  migrate/    the workbook importer
```

## Open work, in priority order

1. **Inspection queue and worksheet.** A staff page: unclaimed jobs,
   claim one, work the checklist for that item with a tick per line,
   findings in their own words. The checks already come from the
   documents — see `buildQuestionPlan(...).inPersonChecks`. Submission
   blocked until every line is answered.
2. **A second approval gate.** Today one `APPROVE` issues the contract.
   It splits: approve in principle, then release after inspection.
3. **Human handover on WhatsApp.** `TAKE` / `SAY` / `BACK`, plus the
   escalation triggers (any attempt to negotiate a figure, anything
   about an existing loan, a request for a person, two unparseable
   messages in a row).
4. **24-hour message templates.** WhatsApp only allows free-form
   messages within 24 hours of the customer's last one. Without
   templates, nothing reaches the overdue book.

## Before you build any of it

Write the short plan first and check it against `docs/playbook.md` and
`docs/architecture.md`. Those documents already answer most "how should
this behave" questions, and the answer in them beats a guess.
