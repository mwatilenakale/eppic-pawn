# Job card — contract developer

**Project:** Eppic Pawn Shop WhatsApp agent and valuation website
**Client:** Mwatile Eppic Investment CC, Windhoek
**Reports to:** Lukas (owner). No one else assigns work on this.
**Date issued:** 25 November 2026

---

## Read this before you quote

The system is **already built and tested**. It is not a greenfield job.
There are more than 700 automated tests passing, the Twilio integration is written,
the OpenAI valuation call is written, the agreement and signing flow are
written, and the business rules are read out of a document at runtime.

What is missing is not code. It is **the last mile**: putting it on a
server, pointing a real WhatsApp number at it, running real money through
it once with the owner watching, and closing a specific list of known
findings. If you quote this as "build me a pawn shop system" you have
misread it and your number will be wrong in both directions.

**Before you start anything**, read
**`docs/developer-onboarding.md`** — the tour of the codebase, the
conventions that are load-bearing, and the traps that have cost people
a day each. Then, in this order:

1. `CLAUDE.md` (repo root) — the rules that do not move.
2. `docs/playbook.md` — the business. Every rate and term lives here.
3. `docs/architecture.md` — the design, and §0, an unresolved legal
   question. Do not resolve it yourself.
4. `docs/twilio-setup.md` — stages 0 to 3. Your Milestone 1 is stage 2.
5. `docs/working-with-agents.md` — how work gets reviewed here.
6. `AGENTS.md` — applies to you as much as to an AI agent.

Then run `npm ci && npm test` in `whatsapp-agent/` and show the owner a
clean run — every test passing, nothing skipped — before you change a
line. If it does not pass on your machine, that is the first thing to
fix, and it is almost always `npm ci`.

---

## Milestone 1 — Live on a real number (the only one that matters)

**This is the whole point of the engagement.** Milestones 2 and 3 matter,
but nothing in them changes the shop's day until this one is done. If
only one milestone gets finished, it is this one.

Today the agent runs on a laptop behind a tunnel. It must run on a host
that stays up, because a WhatsApp webhook that is not answered is a
customer who got no reply.

**Deliverables**

1. The agent deployed to a host the owner can afford and log into
   himself. Recommend one and explain the monthly cost before buying
   anything. Anything that keeps a small Node 22 process and a disk
   alive is enough — this needs no cluster and no Kubernetes.
2. HTTPS on a real domain or the host's own subdomain, because Meta and
   Twilio both refuse plain HTTP, and the customer's signing link has to
   open on a phone.
3. The database file and the media directory on **storage that survives
   a restart and is backed up**. If a redeploy wipes `data/`, you have
   deleted the shop's loan book. Show the owner a restore, not a backup.
4. `EPPIC_MEDIA_KEY` generated once, stored in the host's secret
   settings, and **written down somewhere offline**. Losing it loses
   every customer ID photo and every signature. It must never reach the
   repository, a screenshot, a chat message or a test.
5. Twilio's webhook pointed at `/webhooks/twilio` on that host, with the
   signature check live, and `MESSAGING_PROVIDER=twilio` set.
6. `OPENAI_API_KEY` set, and a real valuation produced for a real item.
7. The scheduled notices actually firing — see Milestone 3. Until that
   exists, nobody gets a reminder, so flag it to the owner as a gap
   rather than letting it look handled.

**Acceptance — all of this with the owner watching, on real phones**

A full loan, start to finish, on the live host:

- A customer phone messages the shop number and is asked the category.
- The screening questions arrive one at a time, including the per-item
  photo requests (the back label of a TV, the battery screenshot of a
  phone).
- "Not sure" is answered with guidance, not treated as a refusal.
- The owner's phone receives the approval request with the photos.
- The owner replies `APPROVE <ref> <amount>` and the customer is told.
- `RECEIVED <ref>` is sent when the item is physically in the shop.
- The inspection worksheet opens and is filled in.
- `RELEASE <ref>` is sent, and only then can the agreement be signed.
- The agreement is signed on the customer's phone, and the loan appears
  with the right principal and interest.
- A repayment is recorded and the ledger balances.

Then do it again and **decline** one, and **let one go overdue** and
check the notices.

**Done when:** the owner can take a real customer through that without
you in the room.

---

## Milestone 2 — Close the known website findings

An audit of the public valuation site produced twelve findings in
`docs/website-audit.md`. Four are fixed. Do these four, in this order,
and no others:

- **C — spend ceiling on the public valuator.** Anonymous visitors can
  currently trigger an unlimited number of paid OpenAI calls. Needs a
  per-visitor and a global daily ceiling, and a polite fallback when the
  ceiling is hit ("message us on WhatsApp"). **Ask the owner for the two
  numbers. Do not invent a budget.**
- **H — contrast and keyboard focus.** Low-contrast text and an
  invisible focus ring. Cheap, and it affects every customer on a bright
  Windhoek afternoon.
- **J — request body size limit** and consistent handling of malformed
  input, so a junk request cannot cost money.
- **I — one line of guidance** under the free-text description box:
  item details only, no ID numbers, no PINs. **The owner writes the
  wording.**

Leave **F, G and L** (copy length, cost disclosure placement, visual
identity) unless the owner asks. Leave **A** entirely — see "Do not
touch" below.

---

## Milestone 3 — Make the notices fire

`docs/tasks/008-collections-scheduler.md` is the spec; read it in full.
It was deliberately left unwritten because it depends on where the thing
runs, which Milestone 1 settles.

The four rules it has to get right, which are the whole difficulty:

- A missed day is a missed day. The final notice has exactly one day on
  which it is due. A process that was down for two days must not send it
  late to somebody whose item is already on the market.
- Exactly once. A restart, two processes or a double fire must not send
  the same notice twice.
- Visible when it does not run. A scheduler that silently stops is worse
  than none, because the overdue list keeps looking handled.
- **Nothing that is a decision sends on a timer.** Reminders and the
  final notice are notifications. Approving, extending, selling and
  forfeiting stay the owner's replies.

---

## Do not touch

These are not preferences. Breaking one of them is grounds for ending
the engagement, and in two cases it is how the shop loses money.

1. **No rate, term, threshold or screening question goes into code.**
   They are parsed out of `docs/playbook.md` at startup. If you find
   yourself typing `0.29` or `30` or `75`, stop. The owner must be able
   to change his own business rules without phoning you. If a rule you
   need is not in the playbook, ask him to add it; do not add it
   yourself, and do not edit that file.
2. **No n8n, Zapier, Make, or any low-code workflow tool.** This has
   been said many times. Real code only.
3. **The AI never gives final approval on money or on accepting an
   item.** Every valuation is a suggestion. Every accept and decline
   waits for the owner's WhatsApp reply. There is no flag, no admin
   override and no "auto-approve under NAD X". Do not build a path that
   skips him, even a disabled one.
4. **Do not add approval roles.** The team is the owner plus one person
   who inspects items and has no approval authority. That is modelled
   already. No admin tiers, no permission matrix.
5. **Finding A — when the loan's dates are fixed.** There is a real
   open problem: the dates are set when the contract is issued, not when
   it is signed, so a customer can lose days of her month. It touches
   `contracts.body_sha256`, which exists to prove what was signed, and
   it runs into an unresolved regulatory question. It needs the owner
   and a lawyer, not a developer. Leave it alone and do not "improve"
   it in passing.
6. **The workbook and `data/` never get committed.** They hold real
   customer identity documents. `.gitignore` covers them; do not
   override it, and do not paste their contents into a chat with any AI
   tool.
7. **Keep the dependency count where it is.** One runtime dependency
   today. Adding the Twilio SDK was tried and reverted: it pulled in
   fifty packages to do what thirty lines of `fetch` already did. If you
   want to add a package, say why first.

---

## Keys and access — how this is staged

Access is staged, and it is worth saying why: `EPPIC_MEDIA_KEY` decrypts
every customer ID photo and signature the shop holds. A leak of it
cannot be undone, so it moves as late and as little as possible. The
same staging would apply to anyone, including the owner's own staff.

- **Day one:** the private repository, and `npm run sim`, which runs the
  entire flow in a terminal with no accounts at all. Stage 0 of the
  Twilio guide. You can do real work here.
- **Once Milestone 1 planning is agreed:** your own Twilio sandbox and
  your own OpenAI key, on the owner's account or reimbursed, with a
  spend cap set.
- **At the live test:** the shop's real number and the real media key.
  The owner enters these into the host's settings himself, with you on a
  call, so that the only copy of the media key stays with him.

You will see real customer names, phone numbers, ID photos and item
details. Treat all of it as confidential, do not copy it off the host,
and do not feed it to any AI tool. Sign a short confidentiality
agreement before access.

---

## How work is reviewed

Branch per milestone, pull request, no pushing to anyone else's branch.
Every pull request must state: what you changed, what you ran, and what
you did **not** check. `npm test` and `npm run typecheck` must both be
clean, and new behaviour comes with a test that fails without it.

The standard here is not "the tests pass". It is "I drove the real flow
and watched it". Most defects on this project were found that way, not
by a failing assertion — a photo of a TV's back label filed under the
wrong name, a blank signature creating a live loan, a document the shop
promised and never asked for. Tests caught none of those. Clicking
through did.

If something in the playbook or the architecture looks wrong, say so.
Do not quietly code around it.

---

## Commercial terms

**Fixed price for the whole card, in three payments — one per
milestone. Not hourly.** The codebase is new to you, so your first
hours are reading; a fixed milestone price means nobody has to account
for that time.

The figure is agreed between you and the owner before you start. Quote
on the scope above, once you have read the onboarding document and run
the test suite, rather than on this page alone.

Each payment falls due when that milestone is **accepted**, against the
acceptance criteria written above it. For Milestone 1 that means the
live test has passed — a real loan, on real phones, start to finish.
Not when the host is provisioned.

Hosting, the domain, Twilio and OpenAI are paid for by the shop, on the
owner's own accounts and cards. Do not put them on yours and invoice:
the shop needs to keep control of those accounts after the engagement
ends, and you should not be carrying its running costs.

---

## Questions

Ask the owner. He is the only person who assigns or changes work on
this.

Before you do, though: the build history, every review verdict, and the
reasoning behind each rule above is written down in `docs/`. It is
unusually complete, and the answer to most "why is it like this"
questions is already there. Read first — but when the answer is not
there, ask rather than guess, particularly about anything touching
money.
