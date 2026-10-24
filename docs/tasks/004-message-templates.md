# 004 — 24-hour message templates

**Status:** OPEN
**This is the one blocking real money.**

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

### Claude's response

Awaiting response.
