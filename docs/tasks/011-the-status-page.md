# 011 — The customer's status page, and who the customer is

**Status:** PLAN — awaiting Lukas's confirmation. No code yet.
**Raised by:** Lukas, 24 November 2026, in a website design conversation.
**Depends on:** nothing. Can be built before hosting.

---

## What he asked for

In his words, condensed:

- The landing page must be clearly a pawn shop offering a free value
  check. A lead generation page.
- Three figures, not one: market value, a purchase offer, and a loan
  offer against the item.
- A progress tracker — "you are here, you've inquired, you've started
  providing information".
- A page where you check progress, but **only** once you have passed the
  checks and been accepted as a potential deal, and been told to come in.
- Different questions for different products: an iPhone 15 must be asked
  battery health; every laptop, battery health and charger.
- Do customers log in? Google? Or just be remembered by name and number?
- Can competitors use the valuator as their own free pricing tool, and do
  we need to stop them?
- Deals first come, first served.
- Every device must carry instructions on how to inspect it properly.

---

## What was already built, so it does not get built twice

Checked against the code, not from memory:

| Asked for | State |
|---|---|
| Three figures | **Done.** `quoteCard` already shows market value, assessed value, pawn loan and buy-outright, with a "keep it" / "most cash" badge on each |
| Progress tracker on the form | **Done.** `stepBar` — Item, Details, Estimate, Quote |
| First come, first served | **Done.** The inspection queue is `ORDER BY j.created_at`, headed "Waiting — oldest first" |
| Inspection instructions | **Done 24 Nov.** The worksheet now shows the playbook's "how to check" hint under each line; 4 of 5 categories have them |
| Landing page says pawn shop | **Done 24 Nov**, and it had a worse problem — see below |
| Per-category questions | **Mostly done.** Checklists, detail photos and variants (iPhone vs Android) all come from the playbook. Battery health is already a required photo for phones |
| Per-*model* questions | **Not built.** See "Open" below |
| Status page | **Not built.** This task |
| Competitor / cost safeguard | **Not built.** Website audit finding C |

**The defect found while reading the landing page**, worth recording
because it is the fourth of its kind: the page said *"You sign on your
phone, then bring the item in."* That is backwards. `sign()` refuses
until the item has been received, correctly, on Lukas's own rule — so a
customer who did what the page told them reached a link that said no.
Fixed, with a test that asserts the order of the steps rather than the
wording. No test caught it; reading the page did.

---

## The design

### Who the customer is — recommendation: no accounts, ever

**No login. No Google. No password.** The identity is the phone number,
and the credential is a link.

Reasoning, in order of weight:

1. **The landing page's strongest selling point is "no name or number
   needed."** A value check that demands a sign-up loses most of the
   people it was built to attract. He called it a lead generation page;
   a login is the opposite of lead generation.
2. **A pawn shop customer already identifies by phone.** Every
   conversation is on WhatsApp, every loan is against a number, and the
   `customers` table is keyed on one. An account would be a second,
   weaker identity for the same person.
3. **An account is a breach waiting to happen.** Passwords to reset,
   sessions to expire, and a login page to brute-force — guarding data
   the shop already holds against a number.
4. **The pattern is already in the codebase, twice.** Staff reach the
   dashboard by a signed link; customers reach the agreement by a signed
   link. Both are unguessable tokens, both are revocable, neither has a
   password. The status page is the third of the same thing.

So:

- **Anonymous value check** — no identity at all, as now.
- **Handing off to WhatsApp** is where the person becomes a customer:
  their number arrives with the message, and the record is created from
  it. This already happens.
- **The status link is sent to them on WhatsApp** once they are an
  accepted deal. `/t/<token>`, like `/c/<token>` for signing. They
  cannot reach it by typing a URL, which is also the access control.
- **Returning customers** are recognised by number, by the existing
  `customers` directory. Nothing to log into.

One consequence to accept deliberately: a customer who loses the link
asks on WhatsApp and is sent it again. That is the right trade for a
shop this size, and it is how the signing link already works.

### What the status page shows

Gated exactly as he said: **the link only exists once the deal is
accepted in principle.** Before that there is nothing to track, and a
page that says "declined" is a conversation for WhatsApp, not a URL.

Stages, which are the states the database already holds — this is a
*view*, not new state, and that is the point:

1. **Accepted — bring it in.** The figure is confirmed. What to bring,
   from the playbook's requirements. What is still outstanding, by name,
   from the same list the dashboard chases.
2. **Item received.** Who took it in, when.
3. **Being checked.** An inspection is open. No findings, no figures,
   no inspector's notes — those are internal, and `inspectionText`
   already exists to withhold amounts.
4. **Checked and released — ready to sign.** The link to the agreement.
5. **Signed.** Principal, due date, what to pay.

**Hard rule it must respect:** the page reports, it never decides. It
shows no figure that Lukas has not approved, and reaching stage 4 is
caused by his `RELEASE`, never by the page being loaded.

### Per-model questions — recommendation: playbook, not code

He wants an iPhone 15 asked battery health specifically. Two routes:

- **A third level under variants** (category → variant → model). Real
  code, a schema change, and a list of models that is stale in a month.
- **A conditional line in the playbook**, which the parser can already
  nearly do: a check that applies when the description matches a word.

**I would do neither yet.** Battery health is *already* a required
detail photo for every phone, and charger is a one-line addition to the
laptop checklist that he can make himself today — the `askFor` change
on 24 November means a new document generates its own request, and a new
checklist line has always worked that way. The per-model machinery earns
its cost only once he has found a question that genuinely applies to one
model and not its category. **Let real use decide.** Adding the
machinery first is how the system grows a feature nobody needed.

### The competitor question — real, but the motive is the wrong frame

He asked whether rival pawn shops could use the valuator as their own
pricing tool. Yes, trivially — it is public and anonymous by design.

But **policing motive is not possible and not worth trying.** A rival
and a curious customer send identical requests. Any check that tried to
tell them apart would be wrong in both directions and would cost real
customers.

The thing that actually needs defending is **the bill**, which is
website audit finding C and does not care who is calling:

- a per-visitor ceiling, so one source cannot loop;
- a global daily ceiling, so a bad day cannot empty the OpenAI account;
- at the ceiling, a polite fallback: "message us on WhatsApp".

That also happens to blunt a rival, because a pricing tool that stops
after a handful of lookups is useless to them and perfectly adequate for
a customer with one phone to check.

Two things make it cheaper still, and neither needs a decision: the
14-day estimate reuse already means the same item is not priced twice,
and the 190-odd items in the imported workbook are a free answer for
anything the shop has already seen.

**Blocked on Lukas for two numbers only:** lookups per visitor per day,
and total lookups per day.

---

## What I need from him before building

1. **Confirm no-accounts**, status link sent on WhatsApp. (Recommended.)
2. **The two ceiling numbers.**
3. **Does the status page show the amount?** It is approved by then, and
   it is already on the agreement — but it puts a figure on a URL that
   could be forwarded. I lean yes, because hiding it helps nobody and
   the token is the same credential the contract uses.

Items 2 and 3 are his. Item 1 he asked me to decide, and the answer is
above.

## What does not move

- The status page shows state. It never changes it, and it never
  approves anything.
- No figure on it that Lukas has not approved.
- No inspection findings, notes or internal amounts.
- Nothing about it may let a customer sign before the item is received
  and released — that gate stays in `sign()`.
