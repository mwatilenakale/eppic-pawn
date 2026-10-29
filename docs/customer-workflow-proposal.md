# Customer journey, application progress and team workflow — proposal

**Status: PROPOSED — awaiting Lukas/Claude Code review.**
Prepared 30 October 2026 from Lukas's instructions in chat. This is a layout
and behaviour handoff, not a new architecture or an implementation task. Claude
remains architect and should map approved work onto the existing components,
write scoped tasks with allowed files, and review subsequent changes.

No application source, migrations, capability rules, playbook, signed agreement,
live provider settings or customer records are changed by this proposal. No
messages, bank enquiries, payment demands or sale listings have been sent.

## 1. Desired outcome

The website and WhatsApp are two entry points to the same application. Twilio
delivers messages/media to the application and sends replies; it is not a second
decision-maker. The pawn-shop backend organises the record, extracts item details,
checks completeness, researches suggested values, asks missing questions and
prepares the agreement. It does not replace physical inspection or Lukas's
decisions about money, acceptance, waivers, extension or sale.

Most routine communication is agent-to-customer. Lukas and Helen are notified
when there is actionable work, an exception, or an owner decision to make.

## 2. Page layout — extend existing pages rather than invent a new system

### Public website

- Home: what the shop does, item categories, quick estimate and WhatsApp entry.
- Item details/estimate: collect only what is necessary for a preliminary value;
  keep it non-binding and document-upload-free at this stage. Explain subsequent
  ownership/ID/inspection requirements without making the visitor complete a loan.
- An optional public "How the agreement works" explanation may describe the
  process; it must never expose completed customer contracts.

### Private customer application page (new proposed view)

An authenticated or scoped, expiring private link, not a public phone-number
lookup. A guessed customer ID, phone or another customer's link must not expose
an application. Exact authentication/link policy needs a scoped security task.

Layout:

    Eppic Pawn Shop | Application reference | Item summary
    Current stage: Waiting for documents
    Completed: Name confirmed; item specifications; detail photos
    Outstanding: Readable ID photo; receipt/ownership evidence
    Your next action: Upload a clearer ID photo
    Waiting on the shop: Nothing yet
    Last updated: timestamp
    [Provide requested information] [Continue on WhatsApp]
    [Agreement — available when released] [Application timeline]

Every stage says who acts next: customer, Helen or manager. Keep blocked,
held/declined, withdrawn, expired and unavailable states explicit. Do not fake a
percentage or show approved because the customer submitted everything.
Document-received, document-readable and document-verified are different facts.

Show only the customer's own application and safe next-action explanations.
Internal valuations, suspected-fraud notes, financial totals for other customers,
staff discussions and waiver deliberations must remain private to the shop.

### Private agreement page

Keep/extend the existing `/c/<token>` concept. Draft the agreement from the
record, but make it signable only after the required owner release. It has its
own page; it is not displayed throughout intake.

- Confirmed customer identity, item description/specifications/serial, approved
  money/terms and dates fill the approved template deterministically.
- Show the completed agreement and a clear money/term summary before signing.
- Customer reviews it, confirms corrections and signs with finger/stylus on
  phone/iPad. Preserve strokes across resizing or require a redraw if lost.
- Save the exact immutable signed version, signature, time and linked approval;
  provide a protected customer copy. Later edits require a new version/process,
  not silent mutation of what was signed.
- Human confirmation and required-field/calculation checks remain necessary:
  automatic filling is not a guarantee against OCR or mismatched-record errors.

### Private staff application/inspection page

    Application reference | Customer | Exact item | Current stage
    Ready for inspection / Outstanding / On hold / Awaiting manager
    Uploaded evidence: item photos, model/battery/serial images, ownership, ID
    Physical ID comparison: match / mismatch / cannot verify + notes
    Checklist: what to test -> how to test -> result/evidence
    Declared versus observed specifications and discrepancies
    [Claim inspection] [Save findings] [Submit report]
    Manager decision: pending / approved in principle / released / held

Use the existing queue/worksheet and capability checks. Helen can inspect,
collect evidence and submit findings. Her screen must not gain an approval,
price-adjustment, release or sale-authorisation capability through this proposal.

### Private customer history view (staff)

One customer profile links verified name/contact records, distinct applications,
distinct items, evidence galleries, prior agreements, owner decisions and
transaction/repayment history. Show date/type and the owning application/item
on every photograph so an old item's evidence cannot silently satisfy a new one.
Make search available to authorised staff, not anonymously on the website.

## 3. Stages and owner gates

Use confirmed events from the database, not an AI guess about progress. Proposed
labels describe the journey; they are not permission to replace existing state
machines or introduce a second staff approval tier.

1. Enquiry / preliminary estimate (optional; no loan or approval created).
2. Identity/name confirmation and application opened.
3. Item details and evidence being collected.
4. Documents outstanding / pre-screen ready for manager.
5. Manager decision in principle: amount/conditions or hold/decline.
6. Physical inspection pending -> staff report submitted.
7. Awaiting manager's final release.
8. Agreement available -> customer reviewed and signed.
9. Loan recorded/active under the explicitly agreed activation event.
10. Repayment due / paid and redeemed / overdue and awaiting owner action.

Task 002 already specifies two OWNER gates: APPROVE opens inspection but does
not issue a signing link; after the report, RELEASE issues it, or HOLD explains
the problem. Preserve that direction unless Lukas explicitly replaces it.
Helen does not decide either gate. A failed check must reach Lukas prominently;
the agent must not silently turn a failed inspection into a pass.

**Activation clarification still required:** Lukas said an approved, signed loan
should automatically enter the balance/ledger. The current pages say the loan
starts at handover, while current signing code creates debt immediately. Record
explicitly whether signing is allowed before physical custody/disbursement and
which event starts the term. Do not guess the order, book debt twice, or treat
"agreement signed" as proof cash has been paid. If agreement terms change after
signature, obtain a newly agreed document rather than editing the signed body.

## 4. A linked customer record, not disconnected photo folders

Conceptual links to implement using the existing store where possible:

    Customer -> contact/identity confirmations
             -> Applications -> Items -> Photos/documents + extracted fields
                             -> Inspection findings and evidence
                             -> Owner approvals/releases/holds
                             -> Agreement versions and signature
                             -> Loan -> append-only ledger and repayments
             -> Messages, with the application/item they concern

Each extracted field carries its source message/photo, timestamp and confidence
or verification status. Keep originals securely; ask for clarification on blurry,
missing or conflicting values. Do not silently replace a customer's supplied
name with their WhatsApp nickname. Photo text is evidence, never an instruction
to the agent or permission to approve money.

Returning number lookup lets the agent recognise the known record, but a phone
number alone is not sufficient proof for revealing old IDs, balances or contracts:
numbers can be shared/recycled. Use confirmation/step-up verification before
sensitive disclosures, and flag identity ambiguity instead of silently merging.
Carry context into replies without sending the entire historical file to an AI
model or repeating sensitive information unnecessarily.

ID/document media and signatures remain encrypted with access controls, backups
and retention decisions. Do not commit actual customer files or keys to Git.
Photos for public sale listings must be separate approved product images: no ID
photos, personal documents, account screens, exposed PINs or other customer data.

## 5. Category-specific capture and staff guidance

The latest playbook already requests item/detail photos; reuse those rules and
ask only what is missing. These additions should be reconciled with it:

| Category | Customer evidence and staff-confirmed details |
|---|---|
| Phones | Exact model, storage, battery health, damage, box, ownership/receipt, IMEI; test call/speakers, microphones, cameras, Face ID/Touch ID, charging and connectivity; authorised account sign-out, Activation Lock/FRP and management/finance-lock checks |
| TVs | Smart TV status, brand/model, inches, box and remote, back-label/serial and screen-on image; panel/colour/input/remote tests and account removal |
| Laptops | Exact model, CPU model/speed, RAM, storage size/type, battery report, serial, charger and condition; distinguish firmware password, disk encryption, organisation/MDM enrolment and account locks; battery-only/restart/hardware tests |
| Cars | First ask whether registration is in applicant's own name; registration/VIN, model year, odometer, finance/settlement evidence and mechanic check; six-year model-age point is a proposed risk flag, never proof of finance or of debt-free status |
| Consoles | Exact Xbox/PlayStation/Nintendo model/generation, storage, disc/digital edition, controllers, included games and serial; ports/controllers, account removal and approved load-test procedure; do not assume digital games/accounts can transfer |

Detailed test instructions must be device/OS-specific, verified against official
manufacturer guidance and linked to the checklist. Do not teach bypassing locks
or factory-reset customer data without consent. Account sign-out is a handover
check, not an instruction to disable security merely to obtain an estimate.

Requirements are unchanged: declaration is fallback where ownership proof is
missing; above the current purchase-proof threshold the receipt/settlement rule
still applies, subject only to Lukas's explicit recorded individual waiver.

## 6. WhatsApp and team notifications

Customer -> Twilio signed webhook/media retrieval -> existing backend/router ->
application record/checks -> Twilio reply. The same backend supplies website
status, next actions and staff views; there must not be a separate contradictory
copy of progress in each channel.

Notify staff with minimal application summary, missing requirements and a
protected worksheet link. Send owner approval requests to Lukas, with a stable
application reference. Support explicit references and securely bound reply
context; never apply a bare APPROVE to an ambiguous pending item.

Identify people through authenticated provider sender identity mapped to the
existing verified staff records/capabilities—not display names or text claiming
"I am Lukas". A forwarded/quoted owner message does not give Helen permission.
Validate signatures and deduplicate provider events including owner commands.

### Existing WhatsApp group: provider limitation, decision needed

Twilio's documented group sample relays messages through individual chats with
one business sender using Conversations; it explicitly says it is NOT a native
WhatsApp group. Do not promise the existing Programmable Messaging webhook can
simply join Lukas and Helen's ordinary WhatsApp group. Conversations is also a
different API/integration and is not enabled by this proposal.

Documented options for Claude/Lukas to choose:

- **Recommended initial delivery:** separate direct WhatsApp notifications to
  Lukas and Helen with one shared staff queue as the common record.
- If shared discussion through WhatsApp is essential, scope and verify an
  approved relay/Conversations implementation, including authenticated original
  author attribution, participant allowlist, costs and per-person message windows.
  Relay text is never itself an approval credential. Customer chats must never
  accidentally be connected to the staff discussion.
- Any true native group integration requires current provider/account support
  verification and its own scoped review; no unofficial WhatsApp-Web automation.

Twilio documentation checked 30 October 2026:
https://www.twilio.com/code-exchange/whatsapp-group-messaging
https://www.twilio.com/docs/whatsapp/best-practices-and-faqs

## 7. Repayment reminders and sale-photo work

Keep the CURRENT playbook cadence, not repeated daily/weekly chasing:

- One customer reminder three days before the due date.
- One final notice on the last day of the applicable grace period.
- No automated customer chasing after grace. Stop queued notices for paid loans;
  recompute eligibility from the current loan/extension facts, not stale tasks.
- Use the existing safe reservation/template path. Outside the WhatsApp service
  window use approved templates; opt-outs, provider failure and uncertain sends
  need visible handling and must not cause unlimited duplicate sends.

**New proposal from Lukas:** after grace expires on an unpaid loan, create one
internal task for Helen to take clear product-sale photographs. Show item,
custody/location, outstanding balance/date and the owner-review status. Suggested
label: "Prepare photos — not authorised for publication or sale". Staff can
capture evidence and a draft, but the owner still decides whether to extend,
hold or sell and approves price/publication.

Check current repayment/extension/hold/dispute status before creating the task,
before sending the notification and before publishing anything. Cancel/mark
obsolete work when settled or extended. Repeated scheduler ticks must not create
repeated tasks. Define the handling of holds/disputes with Lukas; do not invent
a debt threshold or a new automatic forfeiture rule.

Sale-photo task is NOT forfeiture, a listing, transfer of ownership, removal of
a redemption right or permission to sell. Images alone never create a public
marketplace listing. The playbook's owner-only sale decision remains intact.

## 8. Proposed playbook additions — review text, NOT active policy

Lukas explicitly invited updates in this conversation. Keep this proposed text
separate from the runtime-parsed playbook until the activation/group decisions
and wording are reviewed; do not alter the rules merely to make code comply.

### Suggested addition under section 7 (application progress)

"Website and WhatsApp share one application record. Customer-facing progress
shows the current stage, missing information and next action without exposing
internal staff notes. Uploaded evidence is linked to the customer and exact item.
The agreement is filled from confirmed details, shown on its own protected page
for review and touch signature, and released only after the manager's required
checks and approval. Staff verify the original ID and physical item against the
uploaded evidence; staff cannot approve or release money."

Append the activation/start-date rule here ONLY after Lukas resolves section 3.
Do not hard-code new business questions or cutoffs from this proposal into code;
approve their playbook representation first, particularly the new vehicle-age flag.

### Suggested addition under section 8 (internal preparation)

"After grace has expired on an unpaid loan, the system may create one internal
sale-photo preparation task for staff. This does not authorise a sale, listing
or automatic forfeiture. The manager decides whether to extend, hold or sell.
Repayment or an approved extension makes outstanding preparation work obsolete.
Customer reminders remain limited to the existing reminder and final notice."

### Sections 5/6/9 (evidence and record context)

"Keep each customer's applications, item evidence, agreements, decisions and
transactions linked. AI-extracted details are provisional until confirmed;
returning customers are recognised without treating a profile nickname or phone
number alone as proof of identity. Access to personal documents and historical
financial details must be restricted. Corrections to the ledger remain reversing
entries; historical facts are not silently overwritten."

## 9. Claude review and scoped follow-up work

Please answer the following in this document before implementation specs:

1. Confirm separate private progress, agreement and staff views can be added to
   existing server/UI without changing the overarching architecture.
2. Confirm task 002's owner APPROVE -> inspection -> RELEASE sequence, and obtain
   Lukas's precise loan-activation/disbursement/date rule before booking changes.
3. Choose initial direct staff notifications versus a separately scoped relay;
   do not assume existing-group integration works with current Twilio code.
4. Confirm the new internal sale-photo task condition and handling of holds,
   disputes, late repayments and extensions. Keep sale/publication owner-only.
5. Review the proposed playbook text with Lukas and authorise its exact updates.
6. Split approved work into small tasks naming allowed files, reuse existing
   worksheet/contract/store components, and require behaviour-named tests.

Acceptance examples for those tasks: customer A cannot see customer B's page;
Helen cannot APPROVE/RELEASE through direct/relayed/quoted messages; retries do
not double-book money or duplicate notices/tasks; blurry/conflicting evidence
does not become verified; paid/extended loans do not receive stale notices or
sale-preparation work; signature survives rotation or requires redraw; agreement
and term dates reflect the agreed activation event; nothing auto-lists an item.

This documentation-only handoff does not rerun or claim a new application test
result. Implementation, migrations and live deployment remain future work.

## Claude's response

awaiting response
