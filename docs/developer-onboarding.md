# Developer onboarding

**Read this first. It will save you a day.**

You have been brought in to finish a system that is already built and
tested — not to build one. 16,500 lines of source, 11,000 lines of
tests, more than 700 of them passing. Your job is deployment, a live
test, and a short list of named findings. The job card
(`docs/job-card-developer.md`) is the scope. This file is the map.

---

## 1. What the business is

Eppic Pawn Shop, Windhoek. Mwatile Eppic Investment CC. One owner —
Lukas — plus one hire who inspects items and **has no authority to
approve money**.

A pawn loan here works like this: a customer brings an item, the shop
lends against it, the customer pays back with interest within 30 days
(plus a grace period) and gets the item back. If they don't pay, the
shop sells the item to recover the money. The shop will also buy items
outright, for more cash, at a markup over the loan figure.

Two ways in:

- **WhatsApp** — the main channel. A customer messages the shop, the
  agent runs the intake conversation, and Lukas approves or declines
  from his own phone.
- **The website** — a free value check that shows estimates and
  captures a lead. It is explicitly lead generation, not a shop.

---

## 2. The one rule that explains the whole design

**Every business rule lives in `docs/playbook.md`, and the code reads it
at startup.**

Not a config file. Not constants. A Markdown document the owner edits
himself, parsed at runtime by `src/playbook/`. Interest rates, loan
terms, the grace period, the valuation formula, the minimum loan, the
screening checklist for each category, which photos to ask for,
collections timing, the extension ceiling — all of it.

If a rule is missing or malformed, **the server refuses to start** and
names the section. That is deliberate. Starting with a guessed interest
rate is worse than not starting.

So:

- **Never type a rate, term, threshold or question into code.** If you
  find yourself writing `0.29` or `30` or `75`, stop and look in the
  playbook.
- **Never edit `docs/playbook.md`.** It is the owner's document. If a
  rule you need isn't there, ask him to add it.
- A rule you can't find is a question for him, not a default for you.

`docs/changing-the-rules.md` is the owner-facing version of this, so you
can see what he changes without you.

---

## 3. The invariant that is not negotiable

**AI never gives final approval on money or on accepting an item.**

Every valuation the system produces is a *suggestion*. Every accept and
decline routes to Lukas on WhatsApp and waits for his reply. This is
permanent — not a v1 placeholder, not behind a feature flag. Do not
build a path that skips him, even a disabled one.

The website *does* show a customer an estimate. That is not an
exception: the figure is labelled an estimate, carries a verification
banner, and binds nobody.

Related, and it caught people out: **an approved amount is still a
ballpark** until the item has been physically inspected. Lukas, 24
November 2026: *"even if it's approved it's still subject to final
product inspection."*

---

## 4. Getting it running (ten minutes, no accounts)

```bash
cd whatsapp-agent
npm ci          # not `npm install` — see §9
npm test        # no network, no accounts
npm run typecheck
npm run sim     # the whole flow in your terminal
```

`npm run sim` is the most useful thing in the repository. You type as
the customer; `/lukas approve A1B2 3000` types as Lukas; `/sign` signs
the contract. Everything is in memory. **Drive this before you read
any code** — the system will explain itself faster than this document
can.

Other scripts: `npm start` (the real server), `npm run link` (issue a
staff dashboard link), `npm run import` (read the owner's existing
Excel workbook).

---

## 5. The stack, and why it is this small

- **Node 22, TypeScript, no build step.** Node strips the types
  natively. `tsc --noEmit` typechecks; nothing compiles.
- **`node:sqlite`** for the database, **`node:test`** for tests,
  **`node:http`** for the server, native `fetch` for HTTP.
- **One runtime dependency**: `@anthropic-ai/sdk`.

That is not minimalism for its own sake. This runs on the cheapest
hosting the shop can keep alive, and every dependency is something that
can break on a Saturday with nobody to fix it. The Twilio SDK was added
once and removed on review — it pulled in fifty packages to do what
thirty lines of `fetch` already did.

**If you want to add a package, say why first.**

---

## 6. The codebase, module by module

Start at `src/server.ts` (the routes) and `src/router.ts` (the WhatsApp
commands). Everything else hangs off those two.

| Path | What it does |
|---|---|
| `src/server.ts` | Every HTTP route. Website, webhooks, signing, dashboard |
| `src/router.ts` | Every inbound WhatsApp message, and Lukas's commands |
| `src/playbook/` | Parses `docs/playbook.md` into rules. Read this early |
| `src/store/` | SQLite: schema, 18 migrations, every query. The biggest file |
| `src/intake/` | The customer conversation: questions, photos, handover |
| `src/approval/` | Lukas's two gates — `APPROVE`/`DECLINE`, then `RELEASE`/`HOLD` |
| `src/inspection/` | The hire's worksheet and job queue |
| `src/contract/` | Generating the agreement, the signing page, the signature |
| `src/book/` | Repayment, extension, forfeit, collections notices |
| `src/valuator/` | The AI estimate, and the 14-day price memory |
| `src/web/` | The public website and the staff dashboard, as HTML |
| `src/whatsapp/` | Meta and Twilio transports, webhooks, media, templates |
| `src/customers/` | Matching a person to an existing record |
| `src/xlsx/`, `src/migrate/` | Reading the owner's existing Excel book |
| `src/staff/access.ts` | Who may do what. Small and important |
| `src/money.ts` | **All money is integer cents.** Never a float |

### The flow end to end

```
customer messages  →  intake asks questions, collects photos
                   →  valuator suggests a figure
                   →  Lukas: APPROVE <ref> <amount>   ← gate 1
                   →  customer told, comes to the shop
                   →  RECEIVED <ref>                  ← item physically here
                   →  hire inspects, submits worksheet
                   →  Lukas: RELEASE <ref> [amount]   ← gate 2, can re-price
                   →  agreement issued, customer signs on their phone
                   →  signing creates the loan and starts the clock
```

The two gates are the shape of the whole system. Approving in principle
and releasing an agreement are **different decisions at different
times**, and the customer cannot reach the agreement until the item is
in the shop and has been checked.

---

## 7. Conventions that are load-bearing

- **Money is integer cents** (`src/money.ts`). A float in a loan book
  is a bug waiting for the right number.
- **The ledger is append-only**, enforced by SQLite triggers. A mistake
  is corrected by posting a *reversing entry*, never by editing or
  deleting history. Do not look for a way around the triggers.
- **Migrations are forward-only**, numbered, in `src/store/schema.ts`,
  tracked by `PRAGMA user_version`. Add to the end; never edit an
  existing one.
- **ID photos and signatures are encrypted at rest** with AES-256-GCM
  under `EPPIC_MEDIA_KEY`. Not optional.
- **Customer-facing messages say "the manager", never "Lukas".** There
  is a test enforcing this.
- **Comments explain *why*, not what.** The existing ones carry the
  reasoning and often the owner's own words with a date. Match that.
  If you change a rule's implementation, update the comment that says
  why it was the other way.

---

## 8. Where the real bugs came from

Worth knowing, because it tells you how to work here. Every serious
defect on this project was found by **driving the real flow and looking
at the output** — not by a failing test:

- A TV's back-label photo filed under the wrong name.
- A **blank signature** creating a live loan with interest posted.
- A waiver recorded against the wrong key, so the dashboard marked a
  gap waived *and* kept chasing it.
- `[[Smart TV]]` wiki syntax reaching a customer's WhatsApp.
- A required document that was promised on the agreement and **never
  asked for**.
- The landing page telling customers to *"sign on your phone, then
  bring the item in"* — backwards, and the signing page correctly
  refused them.
- `RELEASE` taking no amount, so an item that came in worse than
  described could only be accepted at the original figure or killed.

The whole suite caught none of those. Clicking through did.

**So: the standard here is not "the tests pass". It is "I drove it and
watched it."** Every pull request should say what you ran and what you
did *not* check.

---

## 9. Things that will waste your time if nobody warns you

- **`npm ci`, not `npm install`.** A fresh container with an empty
  `node_modules` produces eight mystery failures and a test count that
  drops by 150. This has happened more than once.
- **Never change a heading's level in `docs/playbook.md`.** `## 4.`
  must stay `##`. The parser finds sections by heading, and the server
  will refuse to start.
- **The owner's workbook and `data/` must never be committed.** They
  hold real customer identity documents. `.gitignore` covers them.
  Don't override it, and don't paste their contents into any AI tool.
- **`EPPIC_MEDIA_KEY` and every API key must never enter the
  repository**, including in tests.
- **Two different phone numbers.** The shop's number (registered with
  the provider, printed on the contract) and Lukas's own phone (where
  approvals arrive). The server refuses to start if they match.
- **Dates in tests**: don't hard-code "today". A test with a fixed date
  and a clockless store passed for eleven days and failed on 1
  November.

---

## 10. The documents, and which to read when

| File | Read it when |
|---|---|
| `docs/playbook.md` | Always. Every business rule. **Never edit** |
| `docs/architecture.md` | Before anything structural. **§0 is an unresolved legal question — do not resolve it yourself** |
| `docs/job-card-developer.md` | Your scope, your milestones, what not to touch |
| `docs/twilio-setup.md` | Stage 2 is your deployment task |
| `docs/website-audit.md` | The twelve findings and which are yours |
| `docs/tasks/` | One file per task. `README.md` explains the flow |
| `docs/working-with-agents.md` | How review works here, and the defect history |
| `AGENTS.md` | The hard constraints. Applies to you |
| `docs/changing-the-rules.md` | What the owner changes without you |
| `docs/database-proposal.md` | §3 on manual entry, if you get that far |

---

## 11. How your work gets reviewed

Branch per milestone, pull request, never push to a branch that isn't
yours. `npm test` and `npm run typecheck` both clean. New behaviour
comes with a test that fails without it.

Every pull request states three things:

1. What you changed.
2. What you ran.
3. **What you did not check.**

The third is the one that matters and the one people skip.

If something in the playbook or the architecture looks wrong to you,
**say so**. Don't quietly code around it. Several rules in there exist
because somebody said exactly that.
