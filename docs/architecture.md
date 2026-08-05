# Eppic Pawn Shop — System Architecture (v2)

Merges the detailed blueprint you shared with what's actually true about
this business — your real rates, your real team size (you + one hire,
no committee of approval tiers), and a build sequence sized for one
person building this, not a funded startup's dev team. No n8n, per your
own instruction — Claude-based agents plus real code throughout.

---

## 0. Read this section first

**Open regulatory question, unresolved:** Namibia's Usury Act has a
separate "moneylender" category (distinct from microlender), capped at
prime x 1.6 -- currently roughly 14.8-16.6% per annum. Your NAMFISA call
confirmed pawnbroking doesn't need *microlending* registration because
it's secured. It did not confirm pawnbroking is also exempt from the
*moneylender* rate cap, and your rates (29%/30 days, 40%/60 days) are
far above that cap if it applied. This needs a lawyer's written
confirmation before this business scales 5-6x, not an assumption either
way. Nothing below changes that -- it's listed here so it doesn't get
lost under the technical detail.

**Cost and timeline, before any stack decisions:** the fuller version of
this build (website + WhatsApp agent + fraud checklists + full ledger)
is realistically 4-6 months of focused solo development, or a real
budget if any of it is contracted out. Know that number before
committing to it -- it changes the build order below more than any
technical choice does.

---

## 1. Design principles

- **The pawn-shop-playbook is the single source of truth.** Rates,
  splits, screening rules, collections logic -- every one of those lives
  in that file. Nothing below hard-codes a number that's already defined
  there.
- **AI never gives final approval on money or acceptance.** Every
  valuation is a suggestion; every accept/decline is yours. This isn't a
  v1 limitation to remove later -- it's the permanent design, for the
  same reason you don't let a WhatsApp bot quote a binding number.
- **Sized for your actual team.** You, plus one hire who checks items
  but doesn't decide anything. Not five approval tiers for staff that
  don't exist yet -- that gets added if and when you actually have more
  people, not before.
- **No n8n.** Real code, built with Claude Code, reading the playbook as
  context -- consistent with how you wanted the coding side of this run.

---

## 2. Components

### 2.1 Customer & Item Intake (WhatsApp + Website)

One valuation and intake engine, two front doors -- a WhatsApp agent for
full intake, a website for a quick pre-check before someone commits to
the WhatsApp flow. Both read the category-specific screening questions
straight from the playbook, so the questions asked always match what's
actually in Section 5-6 of that document, not a separately maintained
copy of the same list.

### 2.2 Valuation Engine

Your actual formula, not a generic one: lowest current market estimate
-> x 0.75 -> / 2 -> suggested loan amount (~37.5% of market value).

- **Phase 1:** AI-assisted search-based estimate + condition input from
  photos and the customer's answers.
- **Phase 2, the real edge:** calibrated against your own Ledger --
  372 loans of real assessed values, real resale outcomes on defaults,
  real accuracy of past estimates. This is the genuinely valuable,
  hard-to-copy version of this engine, and it only exists once there's
  enough of your own outcome data behind it.
- Always a suggestion in the approval message. Never auto-quoted to the
  customer as final.

### 2.3 Fraud & Condition Checklists (per category)

This is the strongest part of the blueprint you shared, and worth
keeping close to verbatim -- it's more thorough than what either of us
had built before. Each category gets a fixed, enforced checklist the
system won't let an item pass without:

- **iPhone:** IMEI/serial recorded and cross-checked against device and
  box; Find My iPhone off, Apple ID signed out, Activation Lock removed,
  device reset in front of staff, no MDM/school-management profile;
  full hardware test (display, Face ID/Touch ID, cameras, speakers,
  charging, Wi-Fi, Bluetooth, battery health); checked against known
  fraud patterns -- fake Android-as-iPhone, cloned box, mismatched
  serial, Activation Lock re-enabled after handover, low-quality screen
  replacement, IMEI blacklisted post-loan.
- **Android:** Google/Samsung account removed, Factory Reset Protection
  cleared, model and storage verified inside settings (not just asked),
  IMEI + dual-SIM IMEIs recorded; watch for fake-storage firmware,
  FRP-locked devices, blacklisted IMEIs, aftermarket screens.
- **Laptop:** exact model, BIOS serial, BIOS password and BitLocker
  status, Microsoft/organisation enrolment (flags a stolen work
  laptop), battery health, drive health, restart + battery-only test;
  watch for company-locked machines and undisclosed liquid damage.
- **Console:** serial and model verified against the box (substitution
  fraud -- an older console in newer packaging -- is a bigger real risk
  than outright counterfeits), 20-30 minute load test (already in the
  playbook), account/profile removed, factory reset, check for a
  network ban through normal use, controller drift checked.
- **TV:** Smart TV only (per playbook), full-screen colour test
  (white/black/red/green/blue/grey) for dead pixels, burn-in, and panel
  damage; account removed.
- **Vehicle:** ownership + registration + VIN cross-check, finance
  settlement letter (a paid-off declaration from the customer is
  evidence against them if false, but doesn't override a bank's actual
  claim on a still-financed car), roadworthy status, start-from-cold
  check, keys controlled during custody, test drives supervised.

### 2.4 Approval Workflow (your WhatsApp)

Right-sized to your actual team: **one approval tier -- you.** No
customer-service/valuation-officer/senior-officer ladder from the
blueprint; that's built for a staff you don't have. Your hire runs the
in-person checklist and reports results; the accept/decline/adjust
decision comes to you by WhatsApp either way, exactly as scoped before.

### 2.5 Contract Generator

Unchanged from before -- auto-fills from the confirmed item and value,
using the document checklist that's already category-specific in the
playbook, signed digitally before handover.

### 2.6 Customer Identity & De-duplication

Worth adopting from the blueprint -- genuinely useful, and currently a
real gap (your data-migration work earlier this year found the same
customer recorded under multiple slightly different names). Each
customer gets one internal ID, matched on ID number, phone number, and
name similarity -- not name alone -- with a "possible duplicate" flag
rather than silent merging, so you make that call, not the system.

### 2.7 Ledger

Adopt the blueprint's **reversal-based correction** pattern -- never
silently edit a past transaction; a correction is a new entry that
reverses the old one, both kept, both visible. This is standard
bookkeeping practice and closes a real gap in a spreadsheet-only system,
where an edited cell leaves no trace it was ever different.

Wired to your actual numbers, not the blueprint's generic example:
principal, your 29%/40% rate structure, referral share (9%/20%) where
applicable, friend-capital split where applicable, outstanding balance --
same fields your current Ledger already tracks, same rules, just
enforced against edits instead of open to them.

### 2.8 Data Layer

Same note as before: your Ledger is fine for one person entering data.
Once WhatsApp and a website are both writing to it automatically and
concurrently, that's the point to move to a proper lightweight database
-- not before, and not as a day-one requirement.

---

## 3. Minimum database tables (MVP, trimmed from the blueprint's full 40+)

Start with what an MVP actually needs -- add the rest only once a table
you don't have yet becomes a real, felt gap, not a theoretical one:

```
customers          - one row per person, deduplicated
items               - one row per pledged item
item_photos         - linked to items
loans               - principal, rate, term, status, dates
ledger_entries      - every transaction, reversal-based corrections only
inspections          - checklist results per item, per category
valuations           - engine output + staff override, both kept
whatsapp_conversations - full message history per customer
users               - you + your hire, with roles
audit_log           - who changed what, when
```

The blueprint's fuller list (commissions, storage_locations, buyers,
disputes, etc.) is worth keeping as a reference for later -- not a
blocker for a working v1.

---

## 4. Security, right-sized

Full OWASP ASVS and row-level PostgreSQL security policies are the
right target eventually, not on day one for a single-founder MVP. What
actually matters at this stage:

- Encrypted storage for ID photos and documents (not optional, even at
  small scale -- this is customers' identity documents).
- A real login with a real password for you and your hire -- not a
  shared password in a group chat.
- Backups of the database, automatic, daily, from week one.
- An audit log on the Ledger (Section 2.7) -- this one's worth having
  early, not late, since it's the thing that protects you if a number
  is ever disputed.

---

## 5. Build order (realistic for one person)

1. **WhatsApp Intake Agent + Approval Workflow**, wired to the playbook.
   Usable and valuable on its own before anything else exists.
2. **Fraud/condition checklists**, enforced inside that same flow --
   this is the highest-value addition from the blueprint, and it slots
   directly into step 1 rather than needing its own phase.
3. **Contract Generator** -- removes the manual Loan-ID lookup step.
4. **Valuation Engine, Phase 1** -- AI-assisted estimates feeding
   straight into the WhatsApp approval message.
5. **Customer de-duplication** -- worth adding once volume is high enough
   that repeat customers under slightly different names is a real,
   recurring problem, not a hypothetical one.
6. **Website** -- a second front door onto the same engine, once the
   WhatsApp flow is proven.
7. **Ledger migration to a proper database with reversal-based
   corrections** -- once concurrent writes from WhatsApp and the website
   make the spreadsheet the actual bottleneck.
8. **Valuation Engine, Phase 2** -- calibrated against your own outcome
   data once there's enough of it post-launch.

---

## 6. Next step

Same as before: point your coding-business crew at step 1, with this
document and the playbook as its brief. Resolve the Section 0 legal
question in parallel -- it doesn't block writing code, but it does
matter before this scales, so don't let it sit unresolved for months
while the build is underway.
