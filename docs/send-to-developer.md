# What to send the developer

> ## ⚠ DO NOT SEND THIS FILE
>
> This one is for Lukas only. It contains the pay range, the negotiating
> room and the handover staging. The two files that are safe to send
> straight to a developer are `developer-onboarding.md` and
> `job-card-developer.md` — both are written to be read by him, and
> neither mentions money.

Give him access to the repository and send the message below — the
documents do the rest.

---

## The message (paste this)

> Hi — thanks for meeting.
>
> Here is the project. It is a system for my pawn shop in Windhoek: a
> WhatsApp agent that handles customer enquiries and sends me every
> approval decision, plus a website where someone can check what their
> item is worth.
>
> Important so you quote correctly: **the system is already built and
> tested.** There are over 700 automated tests passing. I am not asking
> you to build it. I need it put on a server, connected to a real
> WhatsApp number, tested end to end with me watching, and a short list
> of known issues closed.
>
> I have attached two documents. Please read both before you give me a
> number:
>
> 1. `developer-onboarding.md` — a tour of the code, how to run it in
>    ten minutes with no accounts needed, and the conventions.
> 2. `job-card-developer.md` — the actual scope, in three milestones,
>    and the things that are not yours to change.
>
> There is a third document you will want, `docs/playbook.md` — all my
> business rules. The code reads that file at startup, so it is where
> every rate and term lives. It comes with the repository. Do not edit
> it; it is mine.
>
> The quickest way to understand it is to run `npm ci && npm run sim` in
> the `whatsapp-agent` folder. That drives the whole flow in a terminal
> with no accounts and no keys. Do that before you read any code.
>
> Two things to know up front: I will not be giving you the live keys or
> customer data on day one — that comes at the live test, and I will
> enter them myself. And I will need a short confidentiality agreement
> signed before repository access, because the system holds customers'
> ID documents.
>
> Let me know your number once you have read the job card.

---

## What to pay

This used to sit in the job card. It is out of there now, because the
job card goes straight to him and that section told him your floor,
your ceiling and not to let him close Milestone 1 early.

**NAD 12,000 fixed for the whole card, in three payments. Not hourly.**

- **Milestone 1 — NAD 6,000.** Half the money on the only deliverable
  that changes your day. Pay it when the live test passes, not when the
  host is provisioned.
- **Milestone 2 — NAD 3,500.**
- **Milestone 3 — NAD 2,500.**

**Why that figure.** A full-time junior developer in Windhoek is widely
quoted at NAD 20,000–35,000 a month in 2026, though the sources
disagree badly and the low ones look like small samples. This is not a
month of full-time work: for someone competent it is roughly ten to
fifteen working days over four to six weeks part-time, on a codebase
already written and tested. NAD 12,000 is near NAD 800–1,200 a day —
fair for a capable developer on a scoped contract, and well under what
an agency would charge for the same deployment.

**Negotiating room.** NAD 10,000 is defensible for someone early in
their career who will need hand-holding. Go to NAD 15,000 for someone
who has deployed a production Node service before **and can show you
one** — that single fact decides whether Milestone 1 takes three days
or three weeks, and it is worth paying for. Ask to see it.

**Do not pay hourly.** You cannot supervise hours, his early hours are
reading, and a fixed milestone price puts the risk of a slow start
where it belongs. For the same reason, pay nothing up front beyond at
most NAD 1,000 as a good-faith start.

**Be firm on one thing.** Milestone 1 is not done when the host is
running. It is done when a real customer could be taken through a real
loan on real phones. People will try to close it at "deployed".

**Infrastructure is yours, on your own card** — the host, the domain,
Twilio, OpenAI. Roughly NAD 150–400 a month for host and domain, plus
usage. Do not let him put them on his accounts and invoice you: you
need to still control them after he has gone. The job card tells him
this too.

---

## What to actually hand over, and when

**At the meeting** — nothing but the three documents above. He can read
them without the code and give you a number.

**After he agrees the scope and signs the confidentiality agreement:**

- Read access to the GitHub repository.
- Nothing else. `npm run sim` needs no accounts, no keys and no
  network, and it exercises the entire flow. He can do real work for
  days on that alone.

**When Milestone 1 planning is agreed:**

- His own Twilio sandbox and his own OpenAI key — on your account with
  a spend cap set, or reimbursed. Not yours.

**Only at the live test, entered by you, ideally with him on a call:**

- The shop's real WhatsApp number.
- `EPPIC_MEDIA_KEY`.
- The host's credentials.

---

## Do not hand over

- **The workbook.** It holds real customer names, ID numbers and item
  details. He does not need it to do any of this work.
- **`EPPIC_MEDIA_KEY`**, until the live test. If it leaks, every
  customer ID photo the shop holds is exposed, and it cannot be undone.
- **Your Google or Meta account passwords.** If something needs
  configuring in a console, do it with him on a call.
- **This file.** It has the pay range and the negotiating room in it.
  The two documents written for him are `developer-onboarding.md` and
  `job-card-developer.md`, and neither mentions money.

---

## The three questions he will ask, and your answers

**"Where is it hosted?"** — Not decided yet. That is his first
deliverable: recommend one, tell you the monthly cost, and let you buy
it on your own card.

**"What is the AI doing?"** — Suggesting a market value, nothing more.
Every figure goes to you on WhatsApp and waits for your reply. He must
not build anything that changes that.

**"Can I restructure X?"** — Default no, for this engagement. The scope
is deployment and the named findings. If he thinks something is wrong,
he should say so and let you decide — the job card says this too.

---

## How you will know Milestone 1 is really done

Not when the server is running. When a real customer could be taken
through a real loan, on real phones, without him in the room:

enquiry → questions and photos → your approval → item brought in →
`RECEIVED` → inspection → `RELEASE` → signed on their phone → cash out
→ a repayment recorded.

Then decline one, and let one go overdue to check the reminders.

People will try to close that milestone at "deployed". Don't let them.
