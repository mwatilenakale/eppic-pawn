# WhatsApp Intake Agent — Component Brief

This is Step 1 from `docs/architecture.md` Section 5 — the first thing
to build, and usable on its own before anything else in the project
exists.

## What it does

1. A customer messages the business WhatsApp number.
2. The agent asks which item category (per `docs/playbook.md` Section
   1: cars, phones, laptops, TVs, consoles), then works through that
   category's screening checklist (playbook Section 5) and the fraud
   checks (`docs/architecture.md` Section 2.3) — one question at a
   time, collecting photos where the checklist calls for them.
3. Once intake is complete, the agent produces a suggested valuation
   using the playbook's formula (lowest market estimate x 0.75 / 2)
   and assembles a summary.
4. The agent sends Lukas a WhatsApp message: item summary, photos,
   suggested value, what's still missing if anything. He replies to
   approve, adjust, or decline.
5. The customer is told the outcome once Lukas responds. Nothing is
   approved, priced, or finalised without that reply.

## Hard constraints (see root CLAUDE.md — these are not optional)

- The agent never quotes a **binding** number to the customer itself.
  Both channels may show estimates clearly marked as not an offer. Only
  Lukas's reply can approve a deal or establish its final price.
- The agent never marks anything approved on its own.
- No n8n or workflow-automation tool — this is application code.
- Read screening questions and rates from `docs/playbook.md` — don't
  duplicate them as hard-coded strings in the agent's logic.

## Open questions to resolve before/while building

These are genuinely unanswered — don't guess at them, ask:

1. **WhatsApp Business API access** — does Lukas already have a Meta
   Business/WhatsApp Cloud API developer account and a registered
   number for the pawn shop, separate from his other business's
   WhatsApp automation? If not, that registration is a prerequisite,
   not a coding task, and has its own lead time.
2. **Hosting** — where does this run? A small always-on server/hosting
   account is needed to receive WhatsApp webhook messages continuously
   — this isn't optional for a WhatsApp bot, unlike a script that runs
   on demand.
3. **Data storage for this step** — the architecture doc's fuller
   database plan (Section 3) is for later phases. For this first step,
   decide the smallest workable option: appending to the existing
   Ledger workbook via an API, a simple database from the start, or
   another lightweight store. Don't default to the full schema before
   it's needed.
4. **LLM API access** — resolved. Market estimates come from either
   OpenAI or Anthropic, chosen by which key is set; the deployment
   choice is OpenAI. Both are asked the same question against the same
   schema, and the playbook's arithmetic runs in code afterwards, so the
   provider cannot change what the shop lends. Billing still has to
   exist with whichever is chosen.

## Suggested first milestone

Not the whole flow at once. A good first working slice: the agent can
hold a conversation for exactly one category (start with phones, since
the playbook's checklist for it is the most fully specified), collect
the required photos, and send Lukas a correctly formatted WhatsApp
approval message — end to end, for that one category, before expanding
to the rest.
