# What the database holds, and how work gets typed in

**A proposal for Lukas, 30 October 2026. Nothing here is built.**

He asked three things: show what the database will have, make sure it has all
the information, and support entering work by hand. This answers those. The
PostgreSQL mechanics are a separate document — `postgresql-migration-review.md`
— and they are about *where* the database runs, not *what is in it*.

---

## 1. What is in there today

Twenty-six tables, seventeen migrations. Grouped by what they mean to the shop
rather than by how they are stored:

**The people**
| Table | Holds |
|---|---|
| `customers` | name, phone, ID number, encrypted ID photo reference |
| `users` | Lukas and the hire, with their role |
| `staff_tokens` | the signed links that let staff open the dashboard |
| `duplicate_flags` | two records that might be the same person, awaiting a ruling |

**The item**
| Table | Holds |
|---|---|
| `items` | category, variant, description, status, when it arrived and who took it in |
| `item_photos` | every picture, encrypted on disk, by kind — item, back-label, battery, ID, ownership |
| `valuations` | the assessed value and suggested loan for an item |
| `price_adjustments` | Lukas's own corrections to a figure, and when they expire |
| `market_observations` | what the AI estimated, dated, kept as evidence |
| `category_requests` | "can we take a smartwatch?" and his answer |

**The decision**
| Table | Holds |
|---|---|
| `approvals` | the figure, who decided, when, and the outcome |
| `waivers` | what he went ahead without, with his name on it |
| `inspection_jobs` | the physical check — who holds it, what they answered, what they found |
| `inspections` | the recorded report |

**The money**
| Table | Holds |
|---|---|
| `loans` | principal, rate, term, start, due, grace end, status |
| `ledger_entries` | every amount in and out, append-only, corrections by reversal |
| `contracts` | the agreement, its number, its token, the hash of what was signed |

**The talking**
| Table | Holds |
|---|---|
| `conversations`, `messages` | the full transcript, both directions |
| `inbound_windows` | when each number last messaged, for WhatsApp's 24-hour rule |
| `collection_notices` | which reminder or final notice has gone, exactly once |
| `twilio_receipts` | which inbound message has been handled, exactly once |
| `prechecks` | anonymous website estimates |

**The record**
| Table | Holds |
|---|---|
| `audit_log` | who did what to which record, when |
| `imports`, `imported_rows` | what came out of the Eppic workbook, so nothing imports twice |

**Honest summary:** the loan book is thoroughly covered. Every loan, every
cent, every decision, with an audit trail and an append-only ledger. What is
*not* covered is the business around the loan book. That is section 2.

---

## 2. Four things it does not hold, and what each costs

These are gaps I would want closed before calling the database complete. Each
one is money or evidence that currently exists only in Lukas's head or on
paper.

### a. What a forfeited item actually sold for

`ledger_entries.loan_id` is `NOT NULL`, so every amount in the system belongs
to a loan. When an item goes to market and sells, there is nowhere to record
the sale price, the date, or who bought it.

**What that costs:** the shop cannot answer "did we recover what we lent on
that TV?" — which is the only question that tells him whether the 75% line and
the margin check are set right. Playbook section 8 is a set of rules about
recovering money from a sale, and the outcome of every such sale is currently
unrecorded.

### b. Expenses

The N$50 mechanic fee is in the playbook as a real cost he sometimes bears
himself. Transport, airtime, the Twilio bill, the valuation API. None of it has
a home.

**What that costs:** interest collected is not profit, and right now the
dashboard shows interest as though it were.

### c. Whose capital funded a loan, and who gets what share

Playbook section 4 has four funding arrangements: his own capital at 100%, a
referral at 9% to the referrer and 20% to him, friend-capital on a negotiated
split, and the capped favour loan. `loans.rate_rule` records *which* rate
applied, so a referral loan is identifiable — but not who the referrer was, or
that they are owed 9%, or whether they have been paid.

**What that costs:** a referrer's share is an obligation the shop owes. It is a
liability tracked nowhere.

### d. The cash position

Section 6 calls this a month-to-month cash business where capital has to
recycle. There is no record of cash on hand, so "how much can I lend this
week?" is not a question the system can answer.

**What that costs:** this is the question that governs every other decision,
and it is the one the system is silent on.

**My recommendation on the four:** (a) and (c) are records of money that
already moves and should be added. (b) and (d) are bookkeeping, and bookkeeping
that nobody keeps up is worse than none — I would want to hear whether he
actually wants to type expenses in before building anywhere for them.

---

## 3. Manual entry — the real question

Today there is exactly one way a loan can come into existence: WhatsApp intake
→ his approval → item received → inspection → release → the customer signs.
That is the right path and it should stay the default. But it is the *only*
path, and a pawn shop does not work that way. A walk-in with cash. A deal done
over the counter in two minutes. A Saturday where the phone is flat. The 190
customers already in the workbook.

The one-off workbook importer exists and is not a general answer: it is a batch
tool for a file that holds real customer data and must never be committed.

### The principle I would hold to

**Manual entry is a different front door, not a different system.** Whatever
gets typed in produces the same rows in the same tables, runs through the same
rules, posts to the same append-only ledger, and lands in the same audit log —
with two extra columns: that it was entered by hand, and by whom.

The failure mode to avoid is a side door that writes loans without the ledger
triggers, or that lets a figure in without an approval. That would give the
shop two sets of books, and the one typed by hand would be the one that is
wrong.

### Three ways to do it

**A. A form on the staff dashboard.** New pages behind the existing
`staff_tokens` link, which already works. One screen per thing: new customer,
new loan on an item, record a repayment, record a sale.

- *For:* room to show the playbook's own arithmetic as he types — the rate, the
  due date, the total — so a typo is visible before it is saved. Works for a
  walk-in while the person is standing there. Can refuse to save something the
  playbook forbids, with the reason.
- *Against:* it is the most to build, and he is on his phone.

**B. WhatsApp commands.** He already types `APPROVE`, `PAID`, `RECEIVED`,
`RELEASE`, `EXTEND`, `SELL`. Add `NEWLOAN`.

- *For:* nothing new to learn, works where he already is, fastest at a counter.
- *Against:* a whole deal is six or seven values, and one message holding all of
  them is a parsing problem and a typo waiting to happen. Getting a confirmation
  wrong by one digit is a wrong loan amount, not a wrong word.
- *My read:* right for **one value at a time** — recording a repayment, a sale
  price — and wrong for creating a loan from nothing.

**C. Keep using the spreadsheet and import it regularly.**

- *For:* familiar, and the importer is written.
- *Against:* it is a batch, so the database is stale between runs and the
  dashboard lies in the meantime; the file holds real customer data; and two
  places both being written to is how they diverge.
- *My read:* good for the one-off backfill of history. Not an ongoing answer.

### What I would recommend

**A for creating things, B for recording single amounts, C once for history.**

Concretely, and in the order I would build it:

1. **`SELL <ref> <amount>`** on WhatsApp — record what a forfeited item
   actually fetched. One number, he is already using `SELL`, and it closes gap
   (a). Smallest useful piece.
2. **A "new loan by hand" form** on the staff dashboard — customer, item,
   amount, with the playbook's terms shown as he types and his approval
   recorded as the approval. Closes the walk-in case.
3. **A "new customer" form**, which the above needs anyway, plus editing a
   customer whose details were taken down wrong.
4. **The workbook backfill**, run once against the real file, on the machine
   that holds it, with the output reconciled against his own totals before
   anyone trusts it.
5. Gaps (c) and (d) — the referrer's share and the cash position — only after
   he has said he wants them, because they are both things somebody has to keep
   up every day.

### Two things that must stay true

- **A hand-entered loan still needs his approval**, even when he is the one
  typing it. Not a ceremony: it means the record says a human authorised this
  amount, which is the thing every audit of a lending business asks for.
- **Nothing hand-entered may edit the ledger.** Same rule as everywhere else:
  a mistake is corrected by a reversing entry, never by changing history. The
  database triggers already enforce this and manual entry must not be given a
  way around them.

---

## 4. On PostgreSQL

Codex's `postgresql-migration-review.md` is a good plan and I agree with its
boundaries. One thing to be clear about, because it affects what to do next:

**SQLite is not the thing holding this back.** It is a real database with real
transactions, and for one shop with one always-on instance it is the right
choice today — it is a single file, which makes backups and restores something
he can actually understand and test. The reason to move to PostgreSQL is
*multiple application instances*, and the architecture deliberately has one.

So I would not migrate now. I would migrate when one of these is true: he wants
a second instance, or more than two people are writing at once, or the hosting
he picks cannot give him a persistent disk. Until then the migration plan is a
document to keep current, not work to do.

**What is urgent in that document is not the database at all:** durable media
storage, the paid-API budget limits, and backups. Those matter on day one of a
live test, whichever database is underneath.

---

## 5. Where this sits against Twilio

He has said the priority is getting WhatsApp and Twilio live for a real test.
None of this is a prerequisite for that, and I would not start any of it first.

The order I would take:

1. **Twilio live** — the four stages in `docs/twilio-setup.md`. Nothing in this
   document blocks it.
2. **`SELL <ref> <amount>`** — half an hour, and it stops the first forfeited
   sale going unrecorded.
3. **The manual-entry forms** — once a real customer has been through the
   WhatsApp path, because that will change what the forms need to look like.
4. **PostgreSQL** — when the hosting decision forces it, and not before.

## Claude's note on what is still Lukas's to decide

- Does he want to type expenses in? (gap b)
- Does he want the referrer's share tracked as a debt the shop owes? (gap c)
- Does he want the cash position in the system, knowing it has to be kept
  current by hand to be worth anything? (gap d)
- Is the 14-day reuse of AI estimates his number? It is in the playbook now,
  marked `[decide]`, on Codex's report that he authorised it.
