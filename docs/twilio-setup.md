# Getting started with Twilio — step by step

For Lukas. Written 29 October 2026. The reviewed implementation notes are in
`docs/twilio-cloud.md`; this is the walkthrough.

Four stages. **Stage 0 needs no account, no card and no hosting** — do it
first, today. Stage 1 gets real WhatsApp messages flowing to and from your own
phone, still with no hosting decision. Stage 2 moves it off your laptop.
Stage 3 is the real shop number.

Do not skip to Stage 3. Meta's business verification takes days and you will
spend them waiting instead of finding out whether the agent asks the right
questions.

---

## Read this first: what the free tiers will and will not do

These limits are Twilio's, not ours, and two of them will surprise you.

| | Trial account | Sandbox |
|---|---|---|
| Who you can message | up to **5 verified numbers** | only people who **joined your sandbox** |
| How long | trial expires after **30 days** | a join lasts **3 days**, then re-join |
| Custom templates | **not available** | **not available** — 3 fixed demo ones only |
| Speed | — | **1 message every 3 seconds** |

**The consequence that matters.** WhatsApp only lets a business send a
free-form message within 24 hours of the customer's last message. Outside that
window it must be a pre-approved template — and neither the trial nor the
sandbox will let you approve your own. So until Stage 3:

- A conversation where the customer has just messaged: **works properly.**
- An approval you decide the next morning: **will not reach the customer.** The
  agent refuses to send rather than send something undeliverable, and sends you
  an alert saying which template is missing. That is correct behaviour, not a
  fault.

So test the conversation flow in Stages 1–2, and expect overnight approvals to
start working only at Stage 3.

The sandbox's 1-message-every-3-seconds limit also matters: the agent sometimes
sends two messages back to back ("Got the photo, thank you." then the next
question). On the sandbox the second may lag. Not a bug.

---

## Stage 0 — work today, no account needed (20 minutes)

The whole flow runs in your terminal against a throwaway database. No Twilio,
no Meta, no host, no money, and nothing touches a real record.

```bash
cd whatsapp-agent
npm install
npm test            # expect: all passing
npm run sim
```

You type as the customer. Useful commands inside it:

```
<anything>          send it as the customer
/photo              send a photo as the customer
/lukas approve A1B2 3000    reply as yourself, approving at N$3,000
/pending            applications waiting for your decision
/rules              what it has read out of the playbook right now
/quit               exit
```

**What to actually do in here**, because this is the cheapest place to find
things wrong:

1. Run a TV through it. Check it asks for the back label and the screen, and
   that the questions are ones a customer in Windhoek can answer.
2. Run a phone through it. Same for the battery screenshot and the IMEI.
3. Try being a difficult customer: refuse to send the ID, ask "how much can I
   get?" five times, send ten photos, describe the item as "yes".
4. Read every message as though you were the customer, and tell me what reads
   wrong. **This is the most valuable thing you can do this week** — most
   defects we have found came from someone reading output and wincing, not from
   a failing test.
5. Check the detail-photo list in playbook section 6 is what you actually want.
   The TV and phone lines are your words; cars, consoles and the IMEI line I
   inferred and marked `[decide]`. Cut what the shop does not need — every
   extra question is a customer who gives up partway.

Nothing below this line is needed to do any of that.

---

## Stage 1 — real WhatsApp, on your laptop (about an hour)

End of this stage: you message a WhatsApp number from your own phone and the
agent answers, for real. Still no hosting decision, still free.

### 1.1 Create the Twilio account

1. Sign up at **twilio.com**. A free trial is enough.
2. Verify your own mobile number when it asks.
3. From the Console dashboard, copy your **Account SID** (starts `AC`) and
   **Auth Token**. They are on the dashboard home, or under Account → API keys
   & tokens.

Keep the Auth Token somewhere private. It is the account's root credential — it
can send messages, read every message log, and create sub-accounts. **Do not
paste it into a chat, including to me.** It goes in a file on your machine that
git already ignores.

### 1.2 Turn on the WhatsApp sandbox

In the Console, go to **Messaging → Try it out → Send a WhatsApp message**.
(Twilio moves this around; if the menu does not match, search the Console for
"WhatsApp sandbox" or follow twilio.com/docs/whatsapp/quickstart.)

You will be given:

- a **sandbox number**, usually `+1 415 523 8886`
- a **join code**, two words, like `join apple-tree`

### 1.3 Join from both phones

From **your own** WhatsApp, send the join code as a message to the sandbox
number. You should get a confirmation back.

Then do the same from a **second phone** — a test customer. Use a phone you
control, not a real customer.

Both numbers must also be **verified recipients** on the trial account
(Console → Phone Numbers → Verified Caller IDs). The trial allows five.

Remember: each join lasts **3 days**. When messages stop arriving a week later,
this is usually why — just re-send the join code.

### 1.4 Make your laptop reachable from the internet

Twilio has to be able to POST to your machine. For testing only, a tunnel does
this. Install **cloudflared** or **ngrok**, then:

```bash
cloudflared tunnel --url http://localhost:8080
#   or
ngrok http 8080
```

It prints an HTTPS address like `https://wandering-tree-1234.trycloudflare.com`.
Copy it exactly.

**This address changes every time you restart the tunnel**, unless you pay for
a fixed one. Each time it changes you must update **both** the Twilio console
box and `PUBLIC_BASE_URL` below, or every message will be rejected. More on why
in 1.7.

### 1.5 Write your settings file

In the `whatsapp-agent` folder:

```bash
cp .env.example .env
```

Then open `.env` and set these. Everything else can stay as it is.

```
MESSAGING_PROVIDER=twilio
TWILIO_ACCOUNT_SID=AC...                      from 1.1
TWILIO_AUTH_TOKEN=...                         from 1.1
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886    the sandbox number, with the whatsapp: prefix
PUBLIC_BASE_URL=https://....trycloudflare.com the tunnel address from 1.4, no trailing slash
OWNER_PHONE=081 555 0100                      your own WhatsApp
OWNER_NAME=Lukas
EPPIC_MEDIA_KEY=                              see below
```

Generate the media key **once** and never change it:

```bash
openssl rand -hex 32
```

That key encrypts customers' ID photos on disk. Lose it and those photos are
unreadable; leak it and someone has customers' identity documents. Keep a copy
somewhere safe and private — not in this repository, which ignores `.env` on
purpose.

`OWNER_PHONE` must be a **different number** from `TWILIO_WHATSAPP_FROM`. The
server refuses to start if they match, because the agent cannot message itself.

Leave `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` empty for now. Without them the
agent still works end to end — it asks you for the amount instead of suggesting
one. Add a key later if you want the suggested figure.

### 1.6 Start it

```bash
npm start
```

You should see it listening on `:8080` and print which playbook it loaded. If
it refuses to start, it will say exactly which setting is wrong — it will not
start with a rule missing, by design.

### 1.7 Point Twilio at it

Back in the sandbox settings page, in **"When a message comes in"**, enter:

```
https://YOUR-TUNNEL-ADDRESS/webhooks/twilio
```

Method **POST**. Save.

**Get this exactly right.** It must be character-for-character your
`PUBLIC_BASE_URL` plus `/webhooks/twilio` — no trailing slash, no port, `https`
not `http`. Twilio signs each request using the URL as you typed it here, and
the agent checks that signature against `PUBLIC_BASE_URL`. If the two differ by
one character, every message is rejected with a 401 and the agent looks dead.
That strictness is deliberate: it is what stops anyone who finds the address
from approving loans.

Do **not** set a delivery-status callback to this same URL.

Also leave the old `/webhook` path alone — in Twilio mode it deliberately
returns "not found".

### 1.8 Test it

From your **test customer** phone, message the sandbox number:

> Hello, I want to pawn my TV

The agent should answer. Work through a whole application, sending photos.
When it finishes, **your** phone gets the approval request. Reply as yourself:

```
APPROVE A1B2 3000
```

Then check the staff dashboard. The server prints a `/staff/<token>` link on
startup; open it in a browser.

**Do not approve a real deal to test connectivity.** Use the test phone and a
pretend item.

### What to watch for

- **Nothing arrives at all** → the URL in 1.7 does not match `PUBLIC_BASE_URL`.
  Check for a trailing slash. The server log will show 401s.
- **It worked yesterday, not today** → the sandbox join expired (3 days), or
  the tunnel restarted and changed address.
- **"No approved Twilio Content SID"** → expected. You are outside the 24-hour
  window and the sandbox has no custom templates. Message in from the customer
  phone first, then retry. Properly fixed at Stage 3.
- **Replies arrive slowly** → sandbox rate limit, 1 message per 3 seconds.

---

## Stage 2 — move it off your laptop

Stage 1 dies when you close your laptop. For the shop to answer messages at
2pm while you are out, it needs a machine that is always on.

**What it needs**, and these are not negotiable:

- **one** always-on instance — not two, not scale-to-zero, not a serverless
  function. The database is a single SQLite file and two copies of the app
  would corrupt each other's view of the book.
- a **persistent disk**, mounted at `/var/lib/eppic`. On an ephemeral
  filesystem you lose the loan ledger and every encrypted ID photo on the first
  restart.
- **HTTPS** with a fixed domain.
- somewhere to put **secrets** that is not the repository.
- **backups**, from day one. See below.

**My recommendation:** a small VPS — Hetzner or DigitalOcean, roughly €4–6 a
month, check current prices — running the repository `Dockerfile`. A plain
virtual machine with a real disk and snapshot backups is the simplest thing
that satisfies all five, and the mental model is one you can hold: one
machine, one file, one backup.

Fly.io and Railway also work, but both want to scale and restart containers by
default, and you have to go out of your way to keep a single instance pinned to
a volume. That is the opposite of what this needs.

Build from the **repository root**, not the `whatsapp-agent` folder:

```bash
docker build -t eppic .
```

Then on the host: mount the disk at `/var/lib/eppic`, set the same variables
from 1.5 in the host's **secret/environment settings** rather than a `.env`
file, set `PUBLIC_BASE_URL` to your real domain, and update the Twilio webhook
box to match.

**Backups.** Do not copy a live `.db` file — you will get a corrupt one. Either
use SQLite's online backup command, or stop the service and snapshot the whole
disk, including any `-wal` and `-shm` files, together with the media directory.
Store them encrypted and off the host. Keep `EPPIC_MEDIA_KEY` somewhere
separate, because a backup of encrypted photos without the key is useless.
**Test a restore before the first real customer.**

---

## Stage 3 — the real shop number

This is the stage with lead time, so start it while Stage 1 is still running.

1. **A real WhatsApp sender.** You need a Meta Business Portfolio, a WhatsApp
   Business Account, and a phone number that is **not already in use on
   WhatsApp** — including not in the normal WhatsApp app. Once a number is on
   the API you cannot use it in the app any more, which is exactly why
   `OWNER_PHONE` is a different number.
2. **Meta business verification.** Expect to supply a business registration or
   licence for Mwatile Eppic Investment CC, and allow about 3–5 business days.
3. **Check Namibia.** I could not confirm whether Twilio supports registering a
   +264 number as a WhatsApp sender. Ask Twilio support directly before you
   commit to a number — if +264 is not supported you will need a different
   arrangement, and it is much cheaper to find that out now.
4. **Approve the four templates.** In the Console, Messaging → Content Template
   Builder. Create one per template in
   `whatsapp-agent/src/whatsapp/templates.ts`, with wording from
   `docs/message-templates.md` once you have read and approved it:

   | Template | What it is for |
   |---|---|
   | `eppic_outcome_v1` | approvals, declines, contract links, repayment confirmations |
   | `eppic_payment_reminder_v1` | 3 days before a loan falls due |
   | `eppic_final_notice_v1` | the last day of grace |
   | `eppic_inspection_passed_v1` | ready to sign, after the physical check |

   Each one gets an SID starting `HX`. Note two things: once submitted you
   **cannot edit** a template or change its language, and Meta wants enough
   fixed wording around each variable — roughly two ordinary words per
   variable, plus one.

5. **Map the SIDs.** Set `TWILIO_CONTENT_SIDS` on the host to a JSON object:

   ```
   TWILIO_CONTENT_SIDS={"eppic_outcome_v1":"HX...","eppic_payment_reminder_v1":"HX...","eppic_final_notice_v1":"HX...","eppic_inspection_passed_v1":"HX..."}
   ```

   Until a template is mapped and approved, messages to that customer outside
   the 24-hour window are refused and you get an alert naming the missing one.

6. **Switch the sender** — set `TWILIO_WHATSAPP_FROM` to the real number and
   point the production number's webhook at `/webhooks/twilio`.

Only after this does an approval you decide overnight reach the customer.

---

## Things I would get wrong if I were you

- **Approving a real deal to test.** Use the test phone. A real approval writes
  to the ledger and sends a real contract.
- **Putting the Auth Token in the repository.** `.env` is ignored by git; the
  host's secret settings are the right place in production. Never in a commit,
  never in chat.
- **Changing `EPPIC_MEDIA_KEY`.** Every ID photo stored before the change
  becomes unreadable.
- **Running two copies.** One instance. Always.
- **Assuming a message was delivered.** A Twilio message ID means Twilio
  accepted it, not that it arrived. The dashboard has a "Messages that did not
  go through" section — if something of yours is listed there, it did not take
  effect and nothing retried it.

## Where to shout

- It will not start → it names the setting. If the message is unclear, that is
  a fault worth telling me about.
- Messages rejected with 401 → the URL mismatch in 1.7.
- Something reads badly to a customer → tell me the exact wording. That is the
  single most useful report.
- Anything about rates, terms, which photos or which checks → those live in
  `docs/playbook.md` and they are yours. Tell me the rule and I will put it in
  the document; do not expect me to have guessed it.
