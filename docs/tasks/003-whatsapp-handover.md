# 003 — WhatsApp handover to a human

**Status:** DONE — Claude, 21 October 2026. `src/intake/handover.ts`,
`test/handover.test.ts`. Triggers fire from scenario evidence rather than
guesswork; see the commit.

## Why this exists

The agent answers everything by default. That is the right default — it is
the only thing in this system that can reply to ten people at 21:00 without
getting tired. But some messages are not its to answer, and it needs to know
which and get out of the way.

## What to build

**Escalation triggers.** When one fires, the agent stops replying on that
thread, sends Lukas the customer, the reason and the last few messages, and
stays quiet until it is handed back. Nothing auto-resumes.

Triggers, in rough order of importance:

- Any attempt to negotiate a figure. "Can you do 5,000?" is a decision, not
  a question.
- Anything about a loan that already exists — extensions, "I can't pay this
  month", disputes.
- An explicit request for a person; anger, complaints, accusations.
- Police, theft or ownership disputes. Never the agent's to answer.
- Two messages in a row it cannot place. Two strikes, not five.

**Commands.** For Lukas, and for staff —
`can(user, 'conversations.reply')` is true for both:

```
TAKE <number>              the agent goes quiet on that thread
SAY <number> <message>     reply through the agent, as the shop
BACK <number>              hand the conversation back
WAITING                    every thread currently sitting on a human
```

## Constraints

- **Replies go through the agent, not from anyone's personal phone.** The
  shop's number is the only one a customer ever sees, and the whole
  conversation stays in one transcript instead of half of it living in
  somebody's private chats.
- A taken thread stays taken until `BACK`. Do not time it out — an
  automatic resume mid-conversation is worse than silence.
- `SAY` is not an approval. If a human types a figure into `SAY`, it is
  still just a message; nothing in the loan state changes. Make sure there
  is no path from here into the approval flow.
- Staff can take and reply. Only Lukas can approve. Already enforced in
  `src/staff/access.ts` — do not weaken it to make this easier.

## The tests must prove

- Each trigger escalates, and an ordinary intake message does not
- An escalated thread gets no further agent replies until `BACK`
- `SAY` reaches the customer from the shop's number and lands in the
  transcript
- `BACK` returns control and the agent resumes mid-flow without losing the
  intake state
- A staff member can `TAKE` and `SAY`, and still cannot `APPROVE`
- A figure typed into `SAY` changes no loan, approval or ledger row
