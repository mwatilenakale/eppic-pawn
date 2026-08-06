# Eppic Pawn Shop — Business Playbook

Windhoek. WhatsApp: 081-813-1462. Run solo, alongside an FNB job (can't get
FNB financing for this because of the conflict of interest).

The number above is the shop's — the one registered with Meta, printed on the
flyer and the contract, and the one customers message. Lukas's own phone
(081-282-3046) is separate: approvals arrive there and he replies from it. A
number registered on the WhatsApp Cloud API cannot also run the normal
WhatsApp app, so these can never be the same number.

This is the "how we do things here" reference — the context every agent
(intake, records, contracts) reads before it acts. When a rule changes,
edit this file, not any code. Still-open items are marked **[decide]**.

---

## 1. Where the business stands

- Confirmed with NAMFISA directly: pawnbrokers don't need a microlending
  licence to operate, because it's a secured exchange (goods for money) —
  that's specifically what separates a pawnbroker from a microlender in
  their rules.
- Considered also registering as a microlender (to serve customers with no
  collateral, lending against payslips/bank statements) but decided
  against making it a focus: unsecured cash loans can take up to 3 months
  to return ~30%, while the pawn book returns interest in 30 days — much
  better capital velocity.
- Growth plan: sell the forfeited Polo (~N$90,000), combine with a
  Standard Bank loan (~N$250,000) and the ~N$55,000 already in
  circulation — roughly **N$400,000** to push out through the business.

## 2. What we accept

Five categories only, on purpose — no beds/furniture, nothing that needs
extra storage:

- Cars
- Phones (iPhone and Android)
- Laptops
- TVs
- Consoles

**Storage:** a friend's garage (N$500/month) for bulkier items, plus his
storage container for delicate ones (smaller separate fee).

## 3. Loan sizing

1. Find current market value estimates for the item.
2. Take the **lowest** estimate.
3. Multiply by **0.75**.
4. Divide that by **2**.
5. That's the loan amount offered (~37.5% of the lowest market estimate —
   same number the flyer describes as "up to 50% of item value," just
   measured from the discounted figure rather than raw market value).

Pricing is not something an intake agent should quote automatically —
it stays a human sign-off, since it's the step most exposed to fraud
(false specs, stock photos, misrepresented condition).

## 4. Interest rates & terms

| Scenario | Rate | Term | Split |
|---|---|---|---|
| Standard (your capital) | 29% | 30 days | 100% you |
| Loan >= N$15,000 | 40% total | 60 days | 100% you |
| Referral (someone brings you a customer) | 29% total | 30 days | 9% referrer / 20% you |
| Friend-capital (out of cash, use a friend's money) | negotiated | as above | you keep collateral + manage customer; split negotiated case-by-case |
| Friend "favor" loan, no collateral | — | — | capped at N$500, avoided where possible |

- **Grace period:** 4 days by default, flexible up to about a week on
  request.
- **Partial payments:** unpaid interest shortfall folds into principal
  (compounds) rather than being written off — e.g. N$500 unpaid interest
  on a N$5,000 loan becomes a new N$5,500 base, then the margin check
  below runs again on the new number.

## 5. Requirements (every loan)

- Copy of ID
- Proof of ownership / declaration
- Signed agreement
- Police declaration of ownership

## 6. Item screening checklists

**Cars**
- Paid off, registered in the borrower's own name; copy of ID, car papers
- Inspected by a mechanic before acceptance — **customer covers the N$50
  inspection fee** (not built into cost base), but he keeps using his own
  trusted mechanic rather than letting the customer pick one, to avoid a
  friendly inspector waving through a bad car. If the car fails and there's
  no loan, he bears that cost himself.

**Phones (iPhone / Android)**
- Box present? iCloud/account signed out + bypassed, diagnostic mode to
  check all features, test call for speakers, Face ID check
- Proof of ownership, ID, signed agreement

**Watches (Apple / Android, newer models only)**
- Same as phones. **[decide]** — use a minimum loan-value threshold
  (e.g. N$300-500) instead of a fixed model-year cutoff; the valuation
  formula already prices in age/obsolescence.

**TVs**
- Box present? (still accepted without one, priced significantly lower)
- Must be a Smart TV; account/login removed

**Laptops**
- Box, proof of ownership/declaration, ID; passwords/accounts removed;
  BIOS-locked laptops unlocked before accepting

**Consoles**
- **[decide, draft proposed]** — run a demanding game or stress test for
  20-30 minutes, watching for fan noise/grinding, thermal shutdown,
  freezing, disc-read errors. Check ports for damage. Clean run = pass.

## 7. Intake process (moving toward remote pre-screening)

Goal: as much of the checklist above happens *before* the customer walks
in, so in-person time is minimal.

- Customer applies through a website/chat: declares the item, answers the
  category checklist, uploads photos (item, box, ID, proof of ownership).
- He pre-screens it remotely and, if it looks acceptable, tells whoever
  does the in-person check exactly what to verify — the in-person visit
  becomes confirmation, not data collection.
- Contract is auto-generated from the declared details and **signed
  online (finger/touch signature) before handover**, rather than paper
  signed on the spot.
- Pricing and final acceptance still require his sign-off — the remote
  step narrows things down, it doesn't approve loans on its own.

## 8. Default & collections

1. Grace period runs out (4 days, flexible extension as above).
2. Direct outreach — item will need to be sold if unpaid.
3. **Margin check before selling:** original assessed value + interest
   now owed (defaulted month + another month if extended) vs. current
   market value. Roughly **10%+** margin remaining → extend a month.
   Margin gone → sell.
   - *Example: N$10,000 item -> N$7,500 assessed -> N$3,750 loan -> 29%
     interest = N$1,087.50/month. Two missed months: 3,750 + 1,087.50 +
     1,087.50 = N$5,925, still ~21% under the N$7,500 sale price — safe
     to extend.*
4. **Sale pricing:** intentionally below market value so it sells within
   a day or two — speed over maximum price; can't compete with buy/sell
   shops on holding time.
5. **Why the urgency:** month-to-month cash business — capital needs to
   come back quickly to fund new loans and cover expenses.

## 9. Records

- Master data lives in the Eppic workbook (LEDGER / ACTIVE LOANS /
  CUSTOMERS & COLLATERAL), migrated from the daily cashflow sheet.
- Loan marked **Paid Off** once fully repaid.
- Item PINs/passwords currently sometimes noted in plain text — needs a
  safer place, not the Ledger itself.

## 10. Marketing

- Has access to someone who already does social media marketing and
  content creation (video, posters) — considering working with her,
  alongside or instead of an AI-driven content workflow.

## 11. Still open — worth deciding on purpose

- Console test method and watch loan-value cutoff above are proposed,
  not yet confirmed policy.
- What separates **Default** from **Written Off** — is Written Off ever
  actually used, and when would it apply?
- Any customer he'd refuse a repeat loan to, and on what grounds?
