# Website audit — approval requested before implementation

Reviewed 30 October 2026. Repository: mwatilenakale/eppic-pawn, architect branch,
commit `6388cda25becb6e9cc1aba4c39288ab021c195ed`.

**Report only. No website/backend source, existing tests, business rules,
instruction files, approval capabilities or ledger triggers changed.**
Lukas will review these recommendations in chat before authorising any fix.

## Executive judgement

The charcoal/gold visual foundation is strong: bold typography, readable primary
actions, generous touch targets and restrained page structure. Keep it. It is a
functional estimate-and-WhatsApp front door, not yet a full marketplace. It is
not ready to call polished or launch-ready: the quick-value journey is too
inspection-heavy, important money details are missing at the estimate stage,
and signing has two high-priority correctness problems.

No cross-customer disclosure or unauthorised privileged money action was
demonstrated in this review. That is not a security certification. The public
valuation endpoint does expose an unbounded paid-API/storage abuse path, and
anonymous descriptions can retain personal information.

## Method and limits

- Rendered existing source in Chromium, using the actual HTTP server and pages.
- Isolated in-memory database, fictional people/items, MemoryTransport and a
  fixed **MOCK** market value of N$10,450.00. These are not current iPhone prices.
- No live customer contacted, no Meta/Twilio/AI request made, no production
  service deployed or tested. Browser requests outside the fixture server were
  blocked. The existence of a production cloud URL was not assumed.
- Mobile views at 390px; details reflow checked at 320/360/390px; desktop home
  at 1440px. Reduced-motion rendering checked after animation delays settled.
  Full screen-reader and real cheap-Android-device testing remains outstanding.
- A hundred repeated submissions, not ten thousand live requests. The 10,000
  request risk below is an explicit extrapolation from code and that sample.
- Existing regression suite: **664 passing, zero failures**, no skips.
  `npm run typecheck`: clean. Diagnostic script is outside the existing tests.
- Captured dates in fictional contracts reflect the execution host's UTC date
  at fixture creation, not a claim about a live customer's signing date.

## Current customer flow and pages

1. **Home `/`**: “Cash for your stuff. Today.” Five emoji category cards;
   how it works; documents to bring; Get my estimate. Dark/gold throughout.
2. **Category `/apply`**: category chooser. Home category cards link directly
   to the relevant category, so this extra chooser is skipped on that path.
3. **Phone type `/apply?category=phones`**: iPhone or Android. Categories
   without multiple variants go directly to the details form.
4. **Details `/apply?category=phones&variant=iphone`**: one free-text item
   description plus eight yes/no/not-sure technical questions, then Research
   market value. No declaration or ID upload is required to see an estimate.
5. **Research**: no separate visible page. The browser waits for POST /apply,
   then receives the result. The progress indicator jumps from Details to Quote.
6. **Estimate POST `/apply`**: estimated loan, market value, assessed value,
   outright-sale estimate; non-binding warning; paperwork and inspection lists;
   Continue on WhatsApp at the bottom. No-quote/below-minimum/needs-attention
   alternatives are generated within the same flow.
7. **WhatsApp handoff**: opens the shop chat with the description prefilled;
   normal intake runs again. The estimate is NOT an approved loan or a trusted
   screening pass. The manager still decides amounts and acceptance.
8. **Private agreement `/c/<token>`**: manager-approved fixture, loan/repayment
   summary, full agreement, typed name/ID and finger-signature pad. White rather
   than dark/gold. Not a page reachable directly from an anonymous estimate.
9. **Signed confirmation, same private URL**: thank-you, collection instruction,
   repayment total/due date and agreement. The fixture signs without an in-person
   handover event; see finding A below.

No public stock listing, product detail, marketplace search or checkout route
was present in this reviewed web server. That is a scope gap against the wider
marketplace vision, not evidence that the current pre-check is broken.

## Findings and recommendations

### A — High: the stated loan-start event and the accounting event disagree

**What:** Both signing and signed pages say the loan starts when the item is
handed over, but signing immediately creates the loan, pledges the item and
posts principal plus fixed interest. Dates were already fixed at contract issue.

**Evidence:** `src/contract/page.ts:129` and `:168` describe handover; contract
issue fixes `startDate: today` in `src/contract/index.ts:99`. Its complete-signing
routine creates the loan and ledger. Browser diagnostic, without any handover:
`loansBefore=0`, `loansAfter=1`; principal `391875` cents, interest `113644` cents.

**Why it matters:** A customer can appear to owe money before receiving it, and
waiting to visit can consume the already-running term. Owner approval was still
required in the fixture; this is not a claim that anyone can approve a loan.

**Suggested scope:** First obtain Lukas's decision about the actual activation
event, then align contract dates, accounting and customer copy. This is NOT
permission to change money rules or ledger entries. Never update/delete existing
ledger entries to conceal the mismatch; any correction remains reversal-based.

### B — High: a cleared signature can still be submitted successfully

**What:** Mobile resizing clears the drawing but leaves the form's signed flag
true and Submit enabled; the server accepts the resulting blank PNG.

**Evidence:** `src/contract/page.ts:59–71` resets canvas dimensions on resize;
`:77–81` sets signed=true on pointerdown. Browser drew a signature, resized from
390 to 412px, then measured `beforeResize=true`, `afterResize=false`,
`submitEnabledAfterResize=true`. Submission reached Signed — thank you and
created the fixture loan. The server validates PNG format, not visible ink.

**Why it matters:** The shop can retain a supposed signed agreement with no
visible signature. A phone rotation/viewport change is ordinary customer use.

**Suggested scope:** Preserve strokes on resize or clear signed state; require
actual meaningful strokes rather than pointerdown alone, provide clear redraw
feedback, and add focused browser/server validation tests. Confirm an accessible
alternative for customers unable to draw; do not invent legal signing policy.

### C — High before public launch: repeated anonymous submissions spend API calls

**What:** Repeating a valid pre-check repeatedly calls the valuator and writes
more rows; there is no visible rate/concurrency/budget limit in this path.

**Evidence:** `src/server.ts:233–250`, `src/valuator/quotes.ts:69–74`.
Diagnostic: 100 identical POSTs -> 100 mocked estimate calls and 100 precheck rows.
The real adapters are billable model calls; no paid call was made in this audit.

**Why it matters:** A small public bot can create provider charges, database
growth and contention for real customers. At the same behaviour, 10,000 requests
would attempt 10,000 valuations; provider-internal retries may increase this.
Cost is `requests × measured billable input/output tokens × configured rates`,
plus any tool costs if introduced. No defensible fixed NAD amount can be given
without model, real usage and current account pricing; none is invented here.

**Suggested scope:** Approved request/body limits, per-client/global throttling,
concurrency ceiling, provider timeout and spend alerts. Choose safe dedup/cache
semantics without treating a stored model guess as an owner correction. Bounds
and retention decisions belong to an authorised follow-up, not this audit.

### D — High trust risk: “research market value” overstates the current evidence

**What:** Model-generated estimates are presented as market research without
current-source retrieval or dated comparable listings in the inspected adapters.

**Evidence:** `src/valuator/openai.ts` sends chat messages plus a JSON schema;
`src/valuator/index.ts` sends a schema-constrained model message. Neither request
contains a web-search tool or marketplace feed. The quote page renders amounts
but no sources, comparable condition/specs, observation date or uncertainty.

**Why it matters:** A schema-valid number can still be a stale or invented market
price. The mock screenshots prove the page layout, not valuation accuracy.

**Suggested scope:** Either describe the current result honestly as a preliminary
AI estimate, or separately scope verified comparables/source freshness and an
evidence display. No provider or overarching architecture change is authorised.

### E — Medium/high conversion: value check asks inspection questions too early

**What:** A visitor asking a value must face eight technical yes/no questions
including Find My, Apple ID, Activation Lock and MDM, while storage, battery,
damage and box are packed into one free-text input/example.

**Evidence:** `src/web/pages.ts:166–205`, actual 1498px mobile details page. The
placeholder is clipped at 390px. A missing-storage correction resets all eight
previous yes answers: diagnostic `yesSelected=0`, `unsureSelected=8`.

**Why it matters:** A normal owner may not understand MDM and should not think
they must disable device security just to discover a rough value. Re-answering
the same form makes abandonment more likely. No upload is currently required;
keep that positive behaviour.

**Suggested scope:** Clear item-specification inputs and short guided copy first;
retain paperwork requirements as notices and inspection checks for the actual
application/handover. Do not remove a playbook requirement. Decide with Lukas
which questions remain on the pre-check and preserve answers on validation errors.

### F — Medium: the quote is too long before the next action

**What:** The primary handoff action appears only after detailed paperwork and
fraud checks; internal assessed-value language competes with the customer's two
real choices, borrow or sell.

**Evidence:** 390px result height=2473px; only Continue on WhatsApp appears near
the bottom (`src/web/pages.ts:252`). “Pawn loan / Keep it” can be read as keeping
the item now; the explanatory paragraph is less prominent than the badge.

**Why it matters:** The next step is hidden roughly three viewport heights down.
Customers need to understand the shop holds the item until redemption, and that
an outright sale transfers it permanently.

**Suggested scope:** Put clear borrow-versus-sell choices and the non-binding
notice together with a prominent nearby WhatsApp action; keep required document
and inspection information below. Consider explanatory labels or disclosure for
assessed value rather than deleting a figure without approval.

### G — Medium: borrowing cost is only made clear at the agreement stage

**What:** The estimate says repayment is “with interest” but does not show term,
interest amount, repayment total or a worked repayment example beside the loan.

**Evidence:** `src/web/pages.ts:262–290`; signing page later shows N$5,055.19
repayment against the fixture N$3,918.75 loan. No term/repayment row is on the
quote card. These are MOCK fixture amounts using current parsed rules.

**Why it matters:** Customers cannot compare borrowing to selling on the actual
cost of getting their item back until much later.

**Suggested scope:** A clearly labelled estimated term/repayment summary derived
from the playbook, not constants. Ask Lukas whether it belongs on the quote.
The unresolved legal review in architecture section 0 remains unresolved.

### H — Medium accessibility: low contrast and hidden keyboard focus

**What:** Some money values are too dim, and focused radio inputs are invisible.

**Evidence:** Market/assessed numbers compute to `rgb(82,82,82)` at 15px on the
dark quote card. Against base #141414 this is approximately 2.35:1 contrast.
`src/web/theme.ts:221` makes radio inputs opacity:0. Keyboard Tab reaches an
INPUT/radio with opacity=0 while its visible parent has outline=none.

**Why it matters:** Low-end screens, sunlight, vision impairment and keyboard
navigation make important figures and current focus difficult to perceive.

**Suggested scope:** Increase text contrast and visibly style the radio wrapper
on focus-within; check focus/large text, phone zoom, screen readers and touch.
Keep existing native fieldsets/legends, 48px targets, zoom and reduced-motion
support. This review is not a complete accessibility conformance assessment.

### I — Medium privacy: anonymous free text is not necessarily anonymous data

**What:** Whatever the visitor includes in their description can be retained in
the prechecks table and passed to the valuation provider.

**Evidence:** Fictional ID/phone included in a description remained verbatim in
`SELECT description FROM prechecks` (`src/store/index.ts:1526–1547`). There is no
redaction step in POST /apply before priceIt or recordPrecheck.

**Why it matters:** “No name or number needed” is true as a field requirement,
but does not stop people putting personal details into the only text box. That
creates avoidable retention/provider-disclosure risk, not a demonstrated leak
between customers.

**Suggested scope:** “Item details only—no ID numbers, PINs or contact details”
guidance, minimal storage and a concise privacy notice. Lukas must approve
retention/deletion and redaction policy; no legal compliance claim is made here.

### J — Medium correctness: malformed input gets inconsistent or costly handling

**Evidence:** `src/server.ts:208–250` accepts unknown variant `not-a-phone` with
200 and a form. A form body marked text/plain produces 200 and a valuation call;
JSON body/no category produces “We don't take that at the moment.” Duplicate
category/description fields are accepted with first-value semantics, while
answer fields use last-value semantics through Object.fromEntries. A 100KB
description bypasses client maxlength and reaches the mock valuator. A body
over 5,000,000 bytes resets the connection, rather than returning a useful 413.

**Why it matters:** Ambiguous requests, unnecessary model input cost and confusing
errors; a malformed submission should not sound like a business rejection.

**Suggested scope:** Server-side schema/content-type/length/variant checks,
consistent duplicate handling and safe actionable errors. No fix implemented.

### K — High policy consistency: agreement default text has fallen behind playbook

**What:** The displayed agreement promises contact after grace and describes
extension largely through the margin check, despite the current playbook saying
no automated chasing after grace and making the 70%-of-market test govern.

**Evidence:** `src/contract/document.ts:164–169`; compare playbook section 8,
“Nothing after grace runs out” and “Two tests, and which one governs”. The quoted
agreement does not clearly reserve outreach/sale/extension decisions to the
manager in the same way as the current rules.

**Why it matters:** The contract a customer signs can describe different
expectations from the workflow the shop actually follows.

**Suggested scope:** Lukas-approved wording aligned with parsed rules, with
professional legal review before real contracts. Do not edit the playbook or
silently amend previously signed agreements to make code look compliant.

### L — Design judgement: strengthen identity and wayfinding, not a total redesign

**Evidence:** Home has no dedicated brand header/logo; its heading is “Cash for
your stuff. Today.” The footer is very dim. Phone chooser has substantial empty
space and no visible Back/Edit/Home route. Signing switches to plain white.
Contact is often printed text, not a tappable WhatsApp action. The inspected
pages identify Windhoek but not a confirmed street address, directions or hours.

**Why it matters:** The shop needs trust and clarity when asking customers to
bring valuable belongings. Casual copy/emoji icons can be friendly, but read less
like a polished financial service. This is judgement, not a functional failure.

**Suggested scope:** Keep charcoal/gold, add consistent Eppic identity and simple
Back/Edit controls; use plain borrowing/selling language and branded, readable
contract chrome. Add address/hours only when Lukas supplies/approves the real
details. Do not invent reviews, guarantees, turnaround promises or imagery.

## Things that passed / should stay

- No document upload/login/name/phone required just to obtain a website estimate.
- Primary amount prominent; borrow-versus-sell explanation already exists.
- Manager sign-off warning prominent; role label rather than Lukas's name.
- Actual form labels, fieldsets and legends; touch-friendly choices; mobile
  details pages have no horizontal overflow at the tested widths.
- All category cards appear in settled reduced-motion and standard rendering.
  An early animation screenshot briefly hid later cards; it was a capture-timing
  artefact, not retained as a defect.
- No third-party render assets observed; contract responses use no-store and
  no-referrer protections. Unknown contract tokens have existing refusal tests.
- Owner approval is still required to issue a contract; anonymous pre-checks do
  not themselves create approvals or loans.
- Signature/media encrypted at rest by the existing store; signing transaction
  and duplicate-signing protections remain covered by the unchanged test suite.

## Suggested approval sequence

1. Approve the desired customer journey and visual direction in chat first.
2. Separately decide activation/signature/contract-rule corrections (A, B, K).
3. Scope launch safeguards and truthful pricing/privacy behaviour (C, D, I, J).
4. Implement approved UI changes (E, F, G, H, L) in a later explicitly authorised
   task with allowed files and acceptance tests. No marketplace build is implied.

## Claude's response

awaiting response
