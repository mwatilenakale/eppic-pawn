# Eppic Pawn Shop

A system for Eppic Pawn Shop (Mwatile Eppic Investment CC, Windhoek), starting
with the WhatsApp intake and approval agent. This folder is also a Claude Code
project — `CLAUDE.md` is read automatically on every session.

## Folder structure

```
eppic-pawn/
├── CLAUDE.md              ← standing instructions, read every session
├── docs/
│   ├── playbook.md        ← every business rule: rates, terms, screening,
│   │                         collections logic. The source of truth.
│   └── architecture.md    ← full system design and build order
└── whatsapp-agent/        ← Step 1, built. See its README to run it.
```

## Quick start

```bash
cd whatsapp-agent
npm install
npm run sim     # drive the whole flow in your terminal — no Meta account needed
npm test
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
- **Records** — SQLite with an append-only ledger, encrypted ID photos and an
  audit log of who decided what.

Every rate, term and screening question is read from `docs/playbook.md` at
runtime. Nothing is hard-coded, and the loader refuses to start rather than
default a rule it cannot find.

## Still to build (same section, later steps)

3. Contract generator 4. Valuation engine phase 2, calibrated on the Ledger
5. Customer de-duplication 6. Website 7. Ledger migration from the workbook

## Two things that are not code

- **Section 0 of `docs/architecture.md`** — whether the Usury Act's moneylender
  rate cap applies to pawnbroking is still unresolved. It doesn't block this
  build, but it matters before the business scales.
- **WhatsApp Business API access** — the Meta account and registered number are
  a prerequisite with their own lead time. Until they exist, `npm run sim`
  exercises the entire flow locally.

## Keeping this current

When a rate, term, or business rule changes, edit `docs/playbook.md` — never a
hard-coded value in application code. That's the entire point of this structure:
one file governs the rules, every component reads from it instead of duplicating
it. The agent re-reads the document when it changes on disk, so a rate change
takes effect without a redeploy.
