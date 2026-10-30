# Eppic Pawn Shop — Business Playbook

Windhoek. WhatsApp: 081-813-1462. Run solo, alongside an FNB job (can't get
FNB financing for this because of the conflict of interest).

**Customers are told "the manager", never a name.** Every message a customer
reads says the decision is the manager's — not Lukas's. He is named freely in
messages to him, on the staff screens, and in the records; he is not named to
the people on the other side of the counter. A one-man shop does not need to
advertise which one man, and a customer who knows the owner's name is a
customer who can ask for him by name when he would rather not be asked.

Change the words here and every customer-facing message changes with them.

The number above is the shop's — the one registered with Meta, printed on the
flyer and the contract, and the one customers message. Lukas's own phone
(081-555-0100) is separate: approvals arrive there and he replies from it. A
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

Five categories as standard, on purpose — no beds/furniture, nothing that
needs extra storage. Anything else is a question for Lukas, not an automatic
no (see "Something else" below).

The `recognise:` list after each category is what a customer might actually
type. It exists because a customer writes "Samsung Galaxy S25 Ultra", not
"phone", and being told "we don't take that" is how a good item walks away.
Add to these lists freely — they are not exhaustive and never will be.

- Cars — recognise: Toyota, VW, Volkswagen, Polo, Golf, Hilux, Corolla,
  Nissan, Mazda, BMW, Mercedes, Benz, Audi, Ford, Ranger, Hyundai, Kia,
  Isuzu, bakkie, sedan, hatchback, vehicle, motor
- Phones (iPhone and Android) — recognise: Samsung Galaxy, Galaxy, Nokia,
  Huawei, Xiaomi, Redmi, Oppo, Vivo, Tecno, Infinix, Itel, Pixel, OnePlus,
  Motorola, cellphone, cell phone, smartphone, handset
- Laptops — recognise: MacBook, Mac Book, Dell, XPS, Latitude, HP, Pavilion,
  Lenovo, ThinkPad, IdeaPad, Asus, Acer, Chromebook, notebook, ultrabook
- TVs — recognise: television, smart TV, QLED, OLED, plasma, LG, Hisense,
  Bravia, Skyworth, Samsung TV, inch TV
- Consoles — recognise: PlayStation, PS3, PS4, PS5, Xbox, Series X, Series S,
  Nintendo, Nintendo Switch, Wii

Deliberately absent from every list: **Apple** and bare **Samsung**. Both make
phones, laptops, TVs and watches, so the brand alone says nothing — "Apple
Watch" must not be taken in as a phone. Where the brand is all we have, the
agent asks rather than guesses.

Where the brand *does* settle which kind it is, the agent should not ask. Most
phones that come in are Androids, and asking the owner of a Nokia 3310 whether
it is an iPhone makes us look like we are not reading:

- Variant hints — android: Samsung Galaxy, Galaxy, Nokia, Huawei, Xiaomi,
  Redmi, Oppo, Vivo, Tecno, Infinix, Itel, Pixel, OnePlus, Motorola
- Variant hints — iphone: iPhone

**Storage:** a friend's garage (N$500/month) for bulkier items, plus his
storage container for delicate ones (smaller separate fee).

### Something else

An item outside the five categories is **not refused by the agent**. A
smartwatch, a camera, power tools, a generator, jewellery — these come up, and
some of them are worth taking.

What the agent does:

1. Tells the customer honestly: we don't usually take that.
2. Says it is asking Lukas, and that it will come back to them.
3. Sends Lukas the item and the customer's name, and **waits**.
4. Lukas replies *ACCEPT* or *REFUSE* with a word of reason.

Nothing proceeds while it waits, and the agent never guesses the answer. An
accepted one-off is screened on the general checks in section 6 — there is no
category checklist for an item we have not taken before, and Lukas inspects it
in person like everything else.

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
(false specs, stock photos, misrepresented condition). What a customer
sees on the website is an **estimate**, clearly marked as not final until
Lukas has approved it.

On WhatsApp the agent shows **no figure at all** until Lukas has replied. The
website's estimate was a deliberate decision of his (August 2026) about the
website; it has never been extended to WhatsApp, and the agent asking for
details then saying "Lukas sets every amount" is the behaviour that was asked
for. Changing that is his call to make in this document, not an inference from
the website's rule.

Two things about remembering a price, which are about *matching*, not quoting:

- A customer's stated name is recorded against their phone number and they are
  recognised next time. A WhatsApp profile nickname must never overwrite a name
  they have given us themselves.
- Storage capacity, battery health, damage and box availability are preserved
  when matching a previous item's price. A correction on a damaged 64GB phone
  must not become the price of a pristine 256GB one — a different specification
  needs fresh research, not an automatic copy of an old correction. Prior market
  estimates are kept as dated evidence for research, separately from Lukas's own
  corrections: a model's guess does not become his decision by having been
  stored.

### Minimum loan

- **Minimum loan: N$1,000.** Anything that prices below that is declined.

Not because the item is bad — because a small loan is the same work as a
large one. The intake, the inspection, the contract, the storage and the
chasing all cost the same whether the loan is N$300 or N$3,000, and at
the bottom end the interest does not cover the handling.

This is also what turns away obsolete stock without keeping a list of
models. An iPhone 7 prices below the floor on its own, and so will an
iPhone 11 in a few years, with nothing to maintain.

### Buying outright

Some customers would rather sell the item than pawn it. That offer is
**higher** than the pawn loan, deliberately:

- **Buy-now price: the pawn loan plus 25%.**

The pawn loan is lower because the customer keeps the right to redeem for
a month — the capital is tied up and the item can't be sold. Buying it
outright means it can be resold the next day, so the money comes back in
days rather than in thirty. At the assessed value that's roughly a 60%
margin on resale, which is why the customer can be paid more up front.

Worked through on a N$10,440 item: assessed N$7,830, pawn loan N$3,915,
buy-now N$4,894. At the typical N$1,000 loan the buy-now offer is N$1,250.

**[decide]** — 25% is the starting figure, chosen so the gap lands near
N$250-500 across the loan sizes the book actually runs at. Revisit it once
there are real buy-outright sales to measure against.

### Adjusted prices are remembered for 14 days

When Lukas overrides an estimate, that decision is kept and reused for
**14 days** for items of the same kind, instead of estimating that item
from scratch again. His correction is better information than the
estimate was. After 14 days it expires — second-hand prices move, and a
stale correction is worse than a fresh estimate.

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

Documents to bring:

- Copy of ID
- Proof of ownership
- Signed agreement
- Police declaration of ownership — only if there is no proof of ownership

The customer must also be able to confirm:

- Bought outright, not on an account or payment plan

Policy: **proof of purchase required above N$5,000** market value — the
original receipt, or a settlement letter where it was bought on credit.

On that last pair: a credit agreement is proof of a **debt**, not proof of
ownership. Until it is settled the financier has a better claim on the item
than the person holding it — and, on a phone, a switch that turns it off.

This is the Spectra lesson. A new S25 Ultra came in with its box and no
receipt, still on a Spectra account. It passed every inspection, because
nothing was wrong with it that day. The customer stopped paying, Spectra
locked the handset remotely weeks later, and the shop was left holding a
brick. No inspection can catch that — only the paperwork can, before the
item is ever taken in.

Section 2.3 of the architecture already said this for cars: *"a paid-off
declaration from the customer is evidence against them if false, but
doesn't override a bank's actual claim on a still-financed car."* The same
is now true of everything above the threshold.

Below N$5,000 a signed declaration remains enough — the loss is bounded and
the friction is not worth it.

### The declaration is a fallback, not a second document

A police declaration is only asked for where the customer **cannot** prove
they own the thing. Where they can, that is what we want and the declaration
never comes up. Sending somebody holding the original receipt to a police
station is friction for nothing.

What counts as proof of ownership: the original receipt, an invoice or till
slip, proof of payment such as a bank statement or EFT confirmation, a
warranty card, the box where the serial or IMEI matches the item, an insurance
schedule listing it, or a previous Eppic pawn ticket for the same item.

**[decide]** That list is a first draft and Lukas has not confirmed it. The
receipt and the invoice are certain; the rest are reasonable guesses at "other
forms that prove they are the owner" and need his word before they are relied
on. Taking one off the list just makes the police declaration the fallback
again, which is the safe direction to be wrong in.

Above the N$5,000 threshold, the proof has to be a **receipt or settlement
letter** specifically. A box with a matching serial is evidence of possession,
not of a debt being settled — which is the whole Spectra lesson.

### Waiving a document

Every document above is **always** asked for. The agent never drops one, the
website never stops listing it, and no customer is ever told they don't need
it — whatever the system knows about them. That is not negotiable and is not
a setting.

What Lukas can do is approve an application anyway. Where he knows the person
well, he may take a declaration on trust and decide the file is good enough
without it. That is his call on that one item, made with the gap in front of
him, and it is recorded against the application as his: who waived what, and
when. It is not a rule about that customer and it does not carry to their
next loan.

So the two ends are deliberately different, and that is the point:

- **Customer's end:** the requirement stands, always, unchanged.
- **Lukas's end:** he can approve around it, once, on the record.

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
- Not under finance — a handset still on an account can be switched off
  remotely by whoever is owed the money

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

### Detail photos — asked for by name, per category

Lukas, 29 October 2026: *"People are going to send multiple pictures about
phones and so on. We need to get those pictures. We need to get pictures with
the details, especially for the back of the TV. And some pictures for the
phones — screenshots showing battery life and all of that. Pictures showing
details. Laptop details as well."*

One photo of the item is not a pre-screen. The checks in architecture section
2.3 that the shop has to *record* rather than tick — exact model, serial,
battery health — are recorded by a picture, and asking for them by name is
what makes section 7's "the in-person visit becomes confirmation, not data
collection" true.

Each line below is `kind: what the customer is asked to send`. The agent asks
for them one at a time, after the general photo of the item and before the
documents. They are not optional in the sense of being skippable silently —
the same ask-twice-then-carry-the-gap rule applies as for any document.

**Cars**
- odometer: a photo of the dashboard with the ignition on, showing the mileage
- vin-plate: a photo of the VIN plate or sticker (usually the door frame or
  windscreen)

**Phones (iPhone / Android)**
- battery: a screenshot of the battery health screen — on an iPhone,
  Settings > Battery > Battery Health; on Android, the battery section in
  Settings or the phone's own diagnostics
- model-screen: a screenshot of the settings screen showing the exact model
  and the storage size
- imei: a photo of the IMEI — dial `*#06#` and photograph what comes up

**TVs**
- back-label: a photo of the back of the TV, close enough to read the model
  and serial number on the label
- screen-on: a photo of the screen switched on and showing a picture, taken
  straight on

**Laptops**
- specs-screen: a screenshot of the system information — model, processor,
  memory and storage
- underside-label: a photo of the label underneath the laptop showing the
  model and serial number

**Consoles**
- back-label: a photo of the label on the back or underneath, showing the
  model and serial number
- storage-screen: a photo of the storage/system information screen

**[decide]** — the TV and phone lines are Lukas's own words. The rest (cars,
consoles, the IMEI line, and which of these the shop can realistically expect
a customer to manage on a cheap Android) are inferred from section 2.3 and
need his confirmation or his cuts. Nothing below the shop actually needs
should stay in the list: every extra ask is a customer who gives up partway.

### The agreement comes last

Lukas, 30 October 2026: *"They can't sign until the item has been received, so
when they sign, it is assumed that the item has been received by our staff and
is in the possession of the pawn shop."* And, correcting it further the same
day: *"The customer cannot have access to the agreement, because the agreement
is at the end of their process. If things are outstanding in between, they
can't sign. They only sign when the item has been approved — that means our
staff have checked the item, approved, and then only then they sign."*

So the order is fixed, and there are two decisions in it, both his:

1. **Approved in principle.** The customer is told a figure and that it is
   subject to the check. No agreement exists and nothing can be signed.
2. **The item is brought in and received.** Whoever is at the counter records
   it. The inspection becomes real work at this moment.
3. **Staff check the item.** The worksheet, in person, with the thing in hand.
4. **Released.** He reads the report — the outcome, every failed check, what
   they found, and anything still outstanding — and releases the agreement, or
   holds it. Only now does an agreement exist and a signing link go out.
5. **Signed**, at the shop, which is when the month begins and interest starts
   running.

This is the rule the rest of the arithmetic depends on. Signing is what creates
the loan, posts the principal and the first month's interest, and starts the
30-day clock. The agreement also tells the customer the loan starts when the
item is handed over. Those are the same moment — but only because signing
cannot happen before the handover. Without this rule they are two different
days, and a customer who signed at home on the Monday and travelled in on the
Thursday would have spent three days of their month and owed three days of
interest on an item still in their own house.

- **Recording receipt is not an approval.** Whoever is at the counter does it,
  Lukas or the hire. It moves no money and decides nothing; it records where
  an object is. What it unlocks is only the customer's ability to sign.
- **No link is sent early, because no agreement exists early.** The first
  approval sends a figure and nothing else. If a link from an earlier release
  is opened before the item is recorded as here, it says so plainly rather
  than letting anyone sign or looking broken.
- **A gap is only his decision once the item has been seen.** Outstanding
  photos and documents at the first gate are not waived — they have not
  happened yet. At the release gate they are listed, and going ahead anyway is
  recorded against the item as his call (section 5).
- **A failed check does not refuse anything by itself.** It is put in front of
  him and he decides. What the system guarantees is that he cannot not be
  told.
- **Nobody can start a loan by accident.** A customer cannot bring the clock
  forward, and neither can the shop.

### "Not sure" is not a no

Lukas, 30 October 2026: *"If they are not sure, most of this can be verified,
or they can be guided how to check. If they still can't, then we can just give
an estimated value, and then we'll say we'll give a solid amount when you come,
after we've checked that particular thing."*

So three steps, in order, and the first two are the point:

1. **Tell them how to check.** Most of these questions have an answer the
   customer can find in a minute if someone says where to look. The hints
   below are what the agent and the website say.
2. **If they find it, that is the answer.** A customer who checks and reports
   back is better evidence than one who guessed yes to get through the form.
3. **If they still cannot tell, carry on anyway.** The item is not refused and
   the application is not held. They get the estimate, the unanswered point
   goes on the list the shop checks when the item arrives, and they are told
   plainly that the firm amount comes after that check.

**A "no" is different from a "not sure".** Someone who says the handset *is*
still on finance has told the shop something that matters, and that is a real
obstacle to work through. Someone who does not know has told the shop nothing
yet. The two must not be treated the same, and before this they were.

#### How to check

Each line is `phrase: what to tell them`. The phrase is matched against the
question, so a question that changes wording keeps its hint as long as the
phrase still appears. Add to this list freely — anything not covered here
simply gets no hint, which is the behaviour before this existed.

- find my: On an iPhone, Settings, your name at the top, then Find My. On
  Android it is Find My Device in Settings under Security.
- activation lock: Settings, your name at the top. If it asks for an Apple ID
  password you are still signed in, and signing out clears the lock.
- apple id: Settings, your name at the top, scroll down to Sign Out.
- signed out: Open Settings and look for your account at the top. If a name
  or an email is showing, it is still signed in.
- factory reset protection: Settings, Accounts. If a Google account is listed,
  remove it before the reset, or the phone locks to it afterwards.
- google/samsung account: Settings, Accounts and backup, Manage accounts.
- device administrator: Settings, Security, then Device admin apps.
- knox guard: On a Samsung, Settings, About phone. A managed phone usually
  shows a notice there or on the lock screen.
- managed by your organisation: It shows as a notice in Settings, usually at
  the very top or under About phone. A work or school phone often has one.
- under finance: Check whether you are still paying it off on an account or a
  contract — a shop account, a network contract, or a bank plan. Your last
  statement or the shop you bought it from will say.
- paid off: Check whether anything is still owed on it to a shop, a bank or a
  network.
- bios: Restart the laptop and press F2, F10 or Delete as it starts. If it
  asks for a password you cannot enter, it is BIOS-locked.
- passwords/accounts removed: Sign out of the Microsoft or Google account and
  remove any user passwords before bringing it in.
- smart tv: If it can open YouTube or Netflix on its own, without a box
  plugged in, it is a Smart TV.
- account/login removed: Open the TV's settings and sign out of any account
  and any app you are logged into.
- registered in the borrower: Check the registration papers show your own
  name, not a previous owner's.

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
   - **Nothing is ever sold automatically.** Once grace has run out the
     system says so and shows the margin check below; sending an item to
     market is Lukas's decision on that item, the same as every other
     decision about money here. A loan going quiet does not forfeit on a
     timer.
   - **Reminder before the due date: 3 days.** One message, three days out.
     Close enough that they have not forgotten, far enough to find the money.
   - **Final notice on the last day of grace.** On the fourth day of grace —
     the last one — the customer is told plainly: pay today, or from tomorrow
     the item is up for sale. That is the whole message and it goes once.
   - **Nothing after grace runs out.** No chasing, not weekly and not daily.
     The customer has had a reminder and a final warning, both while they
     could still do something about it; once grace is gone they have been told
     everything there is to tell. Who gets a phone call after that is Lukas's
     decision about that person, and a machine repeating itself is how a
     customer who would have paid decides not to come back.
3. **Extension test (the 75% line).** A customer who has not settled within
   the repayment period and asks for another month: add the next month's
   interest to what is already owed — the principal plus every month of
   interest so far — and compare that total against the item's **current
   market value**.
   - **Total at or below 75% of current market value → the extension may be
     granted.**
   - **Above 75% → no extension.** The customer is told plainly that the
     shop cannot extend and that the item has to be sold to recover the
     money owed.
   - The point of the line is that the shop must still be able to recover
     everything owed from a quick sale, priced to move rather than for the
     best price (step 5 below). At 75% there is room for that; past it, each
     further month makes the position worse, not better.
   - Granting it is still Lukas's decision. Passing the test permits an
     extension; it does not grant one.

   *Corrected from 70% to 75% by Lukas on 30 October 2026.* It is not a small
   difference. On the example below — a N$10,000 item, N$3,750 loan, N$1,087.50
   interest a month — the third month owes N$7,012.50, which is N$12.50 over
   the old 70% line of N$7,000 and comfortably inside the 75% line of N$7,500.
   The old figure refused a third month over twelve rand fifty.

   *Worked through: after two months N$5,925 is owed against a N$7,500
   ceiling — inside. After three months N$7,012.50 — still inside. After four
   months N$8,100 — past it, and the item goes to market.*

   **75% of market value is the assessed value.** The valuation in section 3
   multiplies the market estimate by 0.75 to get the assessed value, so this
   test is the same sentence said twice: *what would be owed must not exceed
   what the item would be assessed at today.* That is the version to say to a
   customer. The arithmetic still runs on current market value, because the
   item has depreciated since it was first assessed and the original figure is
   no longer the right one to measure against.

4. **Margin check before selling:** original assessed value + interest
   now owed (defaulted month + another month if extended) vs. current
   market value. Roughly **10%+** margin remaining → extend a month.
   Margin gone → sell.
   - *Example: N$10,000 item -> N$7,500 assessed -> N$3,750 loan -> 29%
     interest = N$1,087.50/month. Two missed months: 3,750 + 1,087.50 +
     1,087.50 = N$5,925, still ~21% under the N$7,500 sale price — safe
     to extend.*
5. **Sale pricing:** intentionally below market value so it sells within
   a day or two — speed over maximum price; can't compete with buy/sell
   shops on holding time.
6. **Why the urgency:** month-to-month cash business — capital needs to
   come back quickly to fund new loans and cover expenses.

### Two tests, and which one governs

**[decide]** Steps 3 and 4 are both tests of the same moment and they do not
always agree. Step 3 measures what is owed against **75% of current market
value**, which is the same as the assessed value recomputed today; step 4
measures it against the **original assessed value** with a 10% margin left
over. On the worked example they agree. They part company once the item has
lost value since intake, because step 3 follows the item down and step 4 does
not: owed N$7,000 against an original assessed N$7,500 passes step 4's margin
only just, while step 3 on a market value that has since fallen to N$9,000
gives a N$6,750 ceiling and refuses.

Until Lukas says otherwise, the code treats **step 3 as the extension test**,
because it is the one he stated in those terms, he restated it on 30 October,
and it is the one that tracks what the item is worth now rather than what it
was worth at intake. Step 4 stays
as written and is shown alongside, so a disagreement is visible rather than
silently resolved. Neither grants anything: both are checks on a decision that
remains his.

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
