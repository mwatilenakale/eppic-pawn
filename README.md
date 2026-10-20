# Eppic Pawn Shop

A system for Eppic Pawn Shop (Mwatile Eppic Investment CC, Windhoek), starting
with the WhatsApp intake and approval agent. This folder is also a Claude Code
project — `CLAUDE.md` is read automatically on every session.

## Folder structure

```
eppic-pawn/
├── CLAUDE.md              ← standing instructions for Claude Code
├── AGENTS.md              ← the same constraints, for any other coding agent
├── docs/
│   ├── playbook.md        ← every business rule: rates, terms, screening,
│   │                         collections logic. The source of truth.
│   ├── architecture.md    ← full system design and build order
│   └── whatsapp-setup.md  ← getting the shop onto Meta's Cloud API
└── whatsapp-agent/        ← Step 1, built. See its README to run it.
```

## Quick start

```bash
cd whatsapp-agent
npm install
npm run sim     # drive the whole flow in your terminal — no Meta account needed
npm test
npm run import -- ~/Eppic_PawnWorkbook.xlsx   # dry run against the existing book
```

## What is built (architecture Section 5, step 1)

- **Intake over WhatsApp** — one question at a time, only the five categories
  the playbook accepts, iPhone/Android asked before the phone checklist, photos
  and the Section 5 documents collected.
- **Screening and fraud checks enforced in the same flow** — playbook Section 6
  plus architecture Section 2.3, split into what a customer can answer remotely
  and what only holds up with the item in hand.
- **Approval by Lukas, and only by Lukas** — an application message with the
  item, photos, flags, what is still missing and the in-person verification
  list; his reply is the only thing that can price or approve anything.
- **Valuation** — the playbook's own formula (lowest estimate x 0.75 / 2), the
  rate table (29%/30 days, 40%/60 days from N$15,000, the 9/20 referral split),
  grace, interest compounding on partial payments, and the Section 8 margin
  check.
- **Contract, signed before handover** (architecture step 3) — the agreement
  auto-fills from the approved amount and the playbook's rules, the customer
  signs it with their finger on a phone, and only then does the loan open with
  its ledger. The document is kept exactly as it was signed, with its digest.
- **Possible duplicate customers flagged, never merged** (architecture step 5) —
  matched on ID number and name similarity, never on name alone, and two
  different ID numbers rule a pair out. Lukas replies SAME or DIFFERENT over
  WhatsApp; both records are kept either way.
- **A website front door** (architecture step 6) — the same screening questions,
  built by the same code, as a one-minute pre-check that hands off to WhatsApp.
  It asks for no name, number or photos, and rejects nobody: a playbook
  condition answered "no" is explained, and the conversation is still offered.
- **The existing workbook, imported** (architecture step 7) — the LEDGER and
  CUSTOMERS tabs read straight from the .xlsx, with every loan kept at the rate
  and term it actually ran at rather than recalculated against today's playbook.
  A dry run reports the totals to check against the workbook's own DASHBOARD,
  the rows whose arithmetic disagrees with itself, and every place the book and
  the playbook differ. Device PINs written into the description column move into
  encrypted storage on the way in. A second run imports nothing twice, and a bad
  import is undone by reversing entries, never by deleting any.
- **An estimate on the website, adjustable by you** — the quote screen shows
  market value, assessed value, the pawn loan and the buy-outright price, all
  labelled as an estimate and carrying the verification banner. Reply
  `ADJUST <ref> market 8000 buy 4500` and any figure moves; correcting one high
  up carries down the playbook's chain, and anything you type explicitly beats
  what would be derived. Adjustments are remembered for 14 days, reused for the
  next item of the same kind, and fed to the estimator as local evidence.
- **Your book, over WhatsApp** — `BOOK` for what's out and what's come in,
  `DUE` for the week ahead, `OVERDUE` for what's past grace and what's still in
  it, `CUSTOMER <name or number>` for one person's history. This is what the
  workbook's DASHBOARD and ACTIVE LOANS tabs were doing, so there's no longer a
  reason to keep both. Every figure is summed from the ledger, and none of
  these commands can write anything.
- **Market estimates from OpenAI or Anthropic** — one env var picks the
  provider. Both are asked the same question against the same schema, with the
  same sanity checks, and the playbook's arithmetic runs in code either way, so
  the choice cannot change what the shop lends. With neither key set the agent
  still runs end to end and asks Lukas for the amount.
- **Records** — SQLite with an append-only ledger, encrypted ID photos and
  signatures, and an audit log of who decided what.

Every rate, term and screening question is read from `docs/playbook.md` at
runtime. Nothing is hard-coded, and the loader refuses to start rather than
default a rule it cannot find.

## Still to build (same section, later steps)

8. Valuation engine phase 2, calibrated on the Ledger's own outcomes. Now
   partly unblocked: the imported book has 372 loans of real history in it,
   though it records no item categories to calibrate against.

The contract wording is plain-language and derived from the playbook. Have a
lawyer read it before it is used with real customers.

## Two things that are not code

- **Section 0 of `docs/architecture.md`** — whether the Usury Act's moneylender
  rate cap applies to pawnbroking is still unresolved. It doesn't block this
  build, but it matters before the business scales.
- **WhatsApp Business API access** — the Meta account and registered number are
  a prerequisite with their own lead time. `docs/whatsapp-setup.md` walks
  through it, including the two-number rule and the 24-hour messaging window
  that collections outreach runs into. Until it exists, `npm run sim` exercises
  the entire flow locally.

## Keeping this current

When a rate, term, or business rule changes, edit `docs/playbook.md` — never a
hard-coded value in application code. That's the entire point of this structure:
one file governs the rules, every component reads from it instead of duplicating
it. The agent re-reads the document when it changes on disk, so a rate change
takes effect without a redeploy.
