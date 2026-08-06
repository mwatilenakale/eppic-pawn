# WhatsApp Intake Agent

Step 1 from `docs/architecture.md` Section 5: a WhatsApp agent that runs the
intake conversation, enforces the per-category screening and fraud checks, and
sends Lukas an approval message he replies to. Nothing is priced or approved
without that reply.

## Try it without a Meta account

```bash
npm install
npm run sim
```

You type as the customer. `/lukas approve A1B2 3000` types as Lukas. Everything
runs in memory, so nothing touches real records.

`/sign` signs the contract the way a customer would on their phone.

```bash
npm test          # 191 tests, no network
npm run typecheck
```

## Run it for real

1. Copy `.env.example` to `.env` and fill it in (see the open questions below).
2. `npm start` — one process serves everything on `PORT` (default 8080).
3. Point the Meta webhook at `https://<your-host>/webhook`, using the same
   verify token, and subscribe to `messages`.

| Route | What it is |
|---|---|
| `GET /` | The public website — what the shop takes, and the pre-check |
| `GET|POST /apply` | The pre-check form and its result |
| `GET|POST /c/<token>` | A customer's contract, and signing it |
| `GET|POST /webhook` | Meta's webhook (verified by signature) |
| `GET /health` | `ok`, for uptime checks |

## How it fits together

```
WhatsApp  ──▶ server.ts ──▶ router.ts ──┬──▶ intake/    (customers)
              (verify        (customer   │     questions from the playbook,
               signature)     or Lukas?) │     answers, photos
                                         └──▶ approval/  (Lukas)
                                               his reply, and only then a
                                               figure to the customer
                                                 │
              /c/<token> ────────────────────────┴──▶ contract/
              (the customer signs on their phone)      agreement, signature,
                                                       and the loan it opens
                                                         │ name + ID number
                                                         ▼
                                                       customers/
                                                       possible duplicates,
                                                       flagged for Lukas

web/       the public site: same questions, no figures, no personal data
playbook/  reads docs/playbook.md + architecture.md at runtime
valuation/ applies the playbook's formula and rate table
store/     SQLite: append-only ledger, encrypted photos, audit log
valuator/  Claude API: market estimates only, never a loan amount
migrate/   brings the existing Eppic workbook into the database
xlsx/      reads .xlsx with no dependency — a zip of XML, and Node can inflate
```

Rules are read from the documents at runtime and reload when the files change,
so changing a rate means editing `docs/playbook.md` — not this code.

## Importing the existing workbook

```bash
npm run import -- ~/Eppic_PawnWorkbook.xlsx          # dry run: reports, writes nothing
npm run import -- ~/Eppic_PawnWorkbook.xlsx --write  # actually import
npm run import -- --list                             # imports already run
npm run import -- --revert <id>                      # undo one
```

Read the dry run first. Its totals are meant to be checked against the
workbook's own DASHBOARD tab before anything is written, and it is where two
other things surface:

- **Rows whose arithmetic disagrees with itself** — interest that isn't the
  stated percentage of the principal, a loan marked paid off that still shows
  an outstanding balance.
- **Where the book and the playbook disagree.** Loans are imported at the rate,
  term and grace period they actually ran at — a book that ran at 30% does not
  become one that ran at 29% because `docs/playbook.md` says 29% today. The
  import reports the gap and changes nothing; whether the playbook or the book
  is out of date is Lukas's call, made by editing the playbook.

Importing is safe to get wrong. Every record is tagged with the workbook row
that produced it, so a second run skips what it already did, and `--revert`
undoes a batch by posting reversing entries — the ledger is never edited or
deleted from. Device PINs written into the workbook's description column
(playbook Section 9 flags this) are moved into the encrypted store on the way
in, so `EPPIC_MEDIA_KEY` is required to import.

## The decisions this step made

The component brief left four questions open. Three are answered here; the first
is not ours to answer.

| Question | Answer |
|---|---|
| **WhatsApp Business API access** | Still needed from Lukas. Not a coding task — the Meta Business account, a registered number and a verified business have their own lead time. Until it exists, `npm run sim` exercises everything else. |
| **Hosting** | Any always-on host that can terminate TLS: one small VM, or a container host. The server is plain Node with no build step and no external services. |
| **Data storage** | SQLite (`node:sqlite`) — a real database from the first day, but one file and no server to run. The MVP tables from architecture Section 3, not the full 40. |
| **Claude API access** | Called directly with the official SDK, for market estimates only. Optional: without a key the agent asks Lukas for the amount. |

## What is deliberately not built

- **No auto-approval, behind any flag.** The only path from "pending" to
  "approved" is a parsed reply from Lukas's number.
- **No approval tiers.** One owner, one hire who inspects. The `users` table
  allows exactly those two roles.
- **The loan is not created at approval.** Approving is a decision. The loan row
  and the ledger open when the customer signs the agreement, and the message to
  Lukas says to verify the in-person checks before the money changes hands.
- **No silent merging of customer records.** A possible duplicate is flagged
  with its reasons and waits for Lukas to reply SAME or DIFFERENT. Both rows are
  kept either way; the duplicate points at the older record rather than being
  overwritten.
- **In-person-only checks are never asked over chat** — a mechanic's inspection,
  a 20-30 minute console load test, a reset done in front of staff. They go to
  Lukas as the verification list (playbook Section 7).

## Security

- ID photos and documents are AES-256-GCM encrypted on disk. With no
  `EPPIC_MEDIA_KEY` the agent refuses to store media rather than writing
  plaintext.
- Webhook payloads without a valid `X-Hub-Signature-256` are rejected — without
  that check, anyone who found the URL could impersonate Lukas and approve a loan.
- Ledger entries cannot be updated or deleted: SQLite triggers abort the
  statement, so a correction has to be a reversing entry with both kept.
- Every money movement and every decision lands in `audit_log` with the actor.

Back up `EPPIC_DB_PATH` and `EPPIC_MEDIA_DIR` together, daily (architecture
Section 4). The database is useless without the key and the key is useless
without the database.
