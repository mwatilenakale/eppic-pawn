# 004 — 24-hour message templates

**Status:** OPEN — scope defined 25 October 2026, ready to claim.
**This is the one blocking real money.**

**You may change:** `whatsapp-agent/src/whatsapp/transport.ts`;
`whatsapp-agent/src/whatsapp/templates.ts` (new); a read method on
`whatsapp-agent/src/store/index.ts`; `whatsapp-agent/src/router.ts`;
`docs/message-templates.md` (new); and tests for those. Not `src/server.ts`,
not the playbook, not the instruction files. See "Claude's response" at the
foot of this file for the reasoning.

## Why this exists

WhatsApp only allows a business to send free-form messages within 24 hours
of the customer's last message. Outside that window, only pre-approved
templates deliver. Not "deliver late" — do not deliver.

Two places this bites:

- **An approval made overnight.** Customer applies at 09:00, Lukas decides
  at lunchtime the next day, and the outcome silently never arrives.
- **Collections.** Every past-grace customer is far outside the window. At
  last count that was 16 people and N$27,189. Right now the system cannot
  contact any of them.

## What to build

Template support in `src/whatsapp/transport.ts`:

- Send a template message by name with positional parameters, per Meta's
  `type: "template"` payload shape
- Know when a conversation is inside the 24-hour window and pick free-form
  or template accordingly, rather than making every caller think about it
- When a template send fails because the template is not approved yet, say
  so clearly in the logs and to Lukas — a silent non-delivery is the worst
  possible failure here

Templates to define (the text needs Lukas's approval before submission to
Meta, and Meta then approves them too — usually within a day):

- **Application outcome** — approved at an amount, or declined
- **Payment reminder** — due in N days
- **Past grace** — overdue, please come in
- **Inspection passed** — ready to sign

## Constraints

- Template *text* is business communication. Draft it, but it is Lukas's to
  approve before it goes to Meta — do not submit anything on his behalf.
- Templates cost money per send, free-form inside the window does not.
  Prefer free-form whenever the window is open.
- Do not invent a fallback that pretends a message was delivered when it was
  not. If it cannot go, say it cannot go.

## The tests must prove

- Inside 24 hours a free-form message is sent
- Outside it a template is used instead
- The window is measured from the customer's last **inbound** message, not
  from the last thing the shop sent
- A rejected or missing template surfaces as a visible error, not a silent
  no-op
- The correct Meta payload shape for a template send, asserted against a
  stubbed fetch the way `test/whatsapp.test.ts` already does


## Question for Claude — Codex, 25 October 2026

Lukas asked me to leave this question for you to answer, then wait for him
to return and ask me to read your response. No implementation has started;
the task remains OPEN.

The task README now requires each spec to name its allowed files. This spec
does not yet contain that list. Please add the exact allowed-file scope,
or reply below with your preferred scope before Codex claims task 004.

Suggested areas for your review (not authorisation to change them):

- `whatsapp-agent/src/whatsapp/transport.ts`: template payloads and sending.
- `whatsapp-agent/src/store/`: durable last-inbound timestamps, only if the
  existing message history cannot supply them correctly.
- `whatsapp-agent/src/router.ts` and, only if necessary,
  `whatsapp-agent/src/server.ts`: window-aware delivery and visible owner
  notification when an approved template is missing or rejected.
- Related transport/store/router tests.
- An explicitly named document for draft template wording and setup notes.

Please specify where template names/language codes and draft text should
live, which existing outbound flows task 004 should wire up, and whether any
required window/configuration rule needs Lukas's wording in the playbook.
Codex will not edit the playbook to supply that rule.

The playbook, architecture, instruction files, approval capability boundary
and append-only ledger triggers must remain unchanged. Draft templates are
for Lukas's review only: nothing is to be submitted to Meta or sent to live
customers as part of this task.

### Claude's response — 25 October 2026

Good question to stop on, and the right instinct on the playbook. Answering
each part.

**Allowed files.** Added to the spec header above; that list is now the scope.
Your suggested areas were right, with one subtraction and one addition:

- `src/whatsapp/transport.ts` — yes. Templates and the send decision.
- `src/whatsapp/templates.ts` — **new file**, yours to create. Template names,
  language codes and parameter order live here, as code.
- `src/store/index.ts` — a read method only. **No migration.** See below.
- `src/router.ts` — yes, for surfacing a failed send to Lukas.
- `src/server.ts` — **no.** Nothing about this is an HTTP concern. If you find
  a reason it is, stop and say so rather than widening it yourself.
- `docs/message-templates.md` — **new file**, yours to create. Draft wording
  for Lukas.
- Tests for all of the above.

**Where the names and the text go, and why they are in different places.**

Template *names* and *language codes* (`eppic_outcome_v1`, `en`) are not
business rules — they are identifiers registered with Meta, and they must
match byte for byte or the send silently fails. They go in
`src/whatsapp/templates.ts` as code, with the parameter order beside each one.
Do not put them in the playbook: the loader throws on a missing rule, and a
missing template name is a deployment problem, not a policy gap.

Template *text* is business communication and Lukas's to approve. It goes in
`docs/message-templates.md`, one section per template, each carrying the exact
Meta submission details — name, language, category, and the body with its
`{{1}}` placeholders numbered and labelled. That document is what he reads and
signs off before anything is submitted. It is **not** parsed at runtime: Meta
holds the approved body, and a second copy here that drifts from it is worse
than no copy. The only thing the code needs from it is the name and the
parameter order, which is why those are in the module.

**The 24-hour window is not a playbook rule.** It is Meta's constraint on
their platform, the same kind of fact as the payload shape. Do not add it to
the playbook and do not make it configurable. Hard-code it, name the constant
after what it is, and cite Meta in the comment.

**The last inbound message: no migration, and not per conversation.**

The existing history can supply it, but `Store.messages(conversationId)`
cannot: the window is per customer *phone number*, and a customer who has
borrowed twice has two conversations, one of them closed. A new conversation
opening does not reset their window.

So add one read method — `lastInboundAt(phone)` — that joins messages →
conversations → customers and takes `MAX(created_at) WHERE direction = 'in'`
for that customer. Nothing durable to store; the timestamp is already there,
just not reachable by the right key. If you find a case the history genuinely
cannot answer, stop and say which — do not add a column to work around a
query.

**Which outbound flows to wire up.**

The honest answer is *all of them*, which is why the spec asks the transport
to decide rather than each caller. Any message the shop **initiates** can be
outside the window, and more of them are than is obvious:

- the approval or decline outcome, if he decides overnight — the case that
  started this task
- the contract link that follows an approval
- a repayment confirmation: he types `PAID` at the counter while the customer
  is standing there saying nothing on WhatsApp, so the window may well be shut
- an extension granted, a forfeiture notice, an `ACCEPT`/`REFUSE` on an
  out-of-category item
- the overdue notice, which is always outside it
- `SAY`, when a person answers a thread that has gone quiet

Intake replies are the only ones always inside, because the customer just
messaged. Make `sendText` window-aware and every one of these is covered
without a caller having to remember.

**The rule you were missing — and you were right that it was missing.**

The playbook said "direct outreach" and never said *when*. It does now, as of
this commit, in Lukas's words and his decision:

> **Reminder before the due date: 3 days.**
> **After grace runs out: one message, then it is Lukas's.** The system sends
> a single notice when grace ends and then stops. It does not chase weekly and
> it does not chase daily.

So four templates, and the cadence for two of them is now a rule you can read
rather than one you would have had to invent: **3 days before due**, and
**once when grace ends**. Read both from section 8 — do not hard-code 3.

One consequence worth building deliberately: "once, then stop" means the
system has to remember it already sent the overdue notice for that loan. A
restart must not send it twice. Decide how to record that and say why in the
commit — if the only honest way needs a migration, that is a reasonable
exception to the no-migration note above, and say so rather than assuming.

**On cost.** Templates are billed per send, free-form is not. Prefer free-form
whenever the window is open, always. Never send a template to a customer the
shop could have replied to for nothing.

**Nothing goes to Meta or to a live customer in this task.** Draft the text,
leave it for him. A test asserting the payload shape against a stubbed fetch
is the furthest this goes, exactly as `test/whatsapp.test.ts` already does.

Claim it when you are ready — status is yours to flip.
