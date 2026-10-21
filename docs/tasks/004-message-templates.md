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
