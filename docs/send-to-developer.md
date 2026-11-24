# What to send the developer

Everything he needs is in the repository. Give him access to it and
send the message below — the documents do the rest.

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
> Please read these three files before you give me a number. They are
> in the repository:
>
> 1. `docs/developer-onboarding.md` — a tour of the code, how to run it
>    in ten minutes with no accounts needed, and the conventions.
> 2. `docs/job-card-student.md` — the actual scope, in three
>    milestones, and the things that are not yours to change.
> 3. `docs/playbook.md` — all my business rules. The code reads this
>    file at startup, so this is where the rates and terms live. Do not
>    edit it; it is mine.
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
