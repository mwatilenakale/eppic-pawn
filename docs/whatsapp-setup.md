# Getting the shop onto WhatsApp

What has to happen at Meta before any of this system reaches a real phone.
None of it is code — it is registration, verification and waiting — but the
agent cannot run without it.

Work through it in order. Phase 1 is mostly waiting, so start it first.

---

## The two numbers

This is the thing that is easy to get wrong exactly once, and it is worth
being blunt about.

| | Number | What it does |
|---|---|---|
| **The shop** | **081-813-1462** | Registered with Meta, runs on the Cloud API. Customers message it. Printed on the flyer, the website and the contract. |
| **Lukas** | **081-555-0100** | Stays an ordinary WhatsApp account on his own phone. Approval requests arrive here; he replies `APPROVE`, `DECLINE`, `BOOK`, `DUE`. |

They cannot be the same number. A number registered on the WhatsApp Cloud API
can no longer use the normal WhatsApp app, and the agent cannot send a message
to itself — the server refuses to start if `OWNER_PHONE` matches the shop's
number in `docs/playbook.md`.

The shop's number lives in the header of `docs/playbook.md` and nowhere else.
Change it there and the contract, the website footer and the `wa.me` link all
follow.

### Before registering the shop's number

Registering a number on the Cloud API **permanently removes it from the
WhatsApp app**. If that handset currently has WhatsApp on it:

1. Delete the account first — WhatsApp → Settings → Account → Delete my account
2. Its chat history is gone for good
3. That SIM can never go back to ordinary WhatsApp

Also worth settling before you start: whose name the SIM is in. If the shop's
customer channel sits on someone else's number, that is a business-continuity
risk, not a technical one.

### Telling existing customers

Anyone who knows **081-555-0100** will keep messaging it, and it will no longer
be the number the agent answers on. Send a broadcast from that phone before
switching over.

---

## Phase 1 — Business verification (start first; takes days to weeks)

Everything else is an afternoon's work. This is the long pole.

1. **business.facebook.com** → create a Business Portfolio for
   **Mwatile Eppic Investment CC**
2. Settings → Business Info → **Start Verification**
3. Have ready:
   - BIPA registration / CC founding statement
   - Something showing the business address (bank statement or utility bill)
   - The legal name must match the documents exactly

Unverified, messaging is capped (roughly 250 business-initiated conversations a
day). That is enough to start with. Verify anyway.

## Phase 2 — The app

1. **developers.facebook.com** → My Apps → **Create App** → type **Business**
2. Link it to the portfolio from Phase 1
3. Add product → **WhatsApp** → Set up

This creates a WhatsApp Business Account and a free test number. Use the test
number to prove the pipe works before touching the real one.

## Phase 3 — Register the shop's number

1. WhatsApp → API Setup → **Add phone number**
2. Display name: `Eppic Pawn Shop` — Meta reviews it, and it has to plausibly
   relate to the business
3. Verify by SMS or voice call to that handset

Do the deletion check above first. This step is the irreversible one.

## Phase 4 — Four values into `.env`

Copy `whatsapp-agent/.env.example` to `whatsapp-agent/.env` and fill in:

| Variable | Where to find it |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | API Setup, under the number. A long numeric **ID** — not the phone number itself. |
| `WHATSAPP_APP_SECRET` | App → Settings → Basic → App Secret → Show |
| `WHATSAPP_VERIFY_TOKEN` | Invent one: `openssl rand -hex 16` |
| `WHATSAPP_TOKEN` | A System User token — see below |

**Do not use the token on the API Setup page.** It expires in 24 hours and the
agent would stop working the next morning. Instead:

Business Settings → Users → **System Users** → Add (`eppic-agent`, Admin)
→ Add Assets (the app *and* the WhatsApp account)
→ **Generate New Token** → tick `whatsapp_business_messaging` and
`whatsapp_business_management` → expiry **Never**

Also set:

```
OWNER_PHONE=081 555 0100
EPPIC_MEDIA_KEY=<openssl rand -hex 32>
```

Back the media key up somewhere other than the server. It decrypts every
customer ID photo and the device PINs imported from the workbook; lose it and
they are unrecoverable.

## Phase 5 — Hosting, then the webhook

Meta will not deliver webhooks to plain HTTP, so the agent needs a real HTTPS
host that stays on. A small VPS with Caddy in front handles the certificate
automatically. Get the agent running there, then:

App → WhatsApp → Configuration → Webhook → Edit

- **Callback URL:** `https://your-host/webhook`
- **Verify token:** the same string as `WHATSAPP_VERIFY_TOKEN`
- Verify and save, then **Manage** → subscribe to **`messages`** only

The handshake and the signature check are already built and tested. If the URL
is right it goes green immediately.

---

## The 24-hour window

WhatsApp only allows free-form messages **within 24 hours** of the customer's
last message. Outside that, only pre-approved templates deliver.

This is a real constraint on how the shop runs, not a detail:

- **Approvals.** A customer applies at 9am; the decision comes at lunchtime the
  next day. The outcome message will not reach them.
- **Collections.** Every past-grace customer is far outside 24 hours. Chasing
  them at all requires a template.

Templates are free to create and usually approved within a day. **Nothing in
the code handles this yet** — it is the next piece of work, and it has to exist
before anyone can be chased.

## First test

1. `npm run sim` locally — drives the whole conversation with no Meta account
2. Then message the shop's number from a different phone
3. The application should arrive on Lukas's phone; reply `APPROVE <ref>`

If the message never arrives, check the webhook is subscribed to `messages` and
that `OWNER_PHONE` is Lukas's number rather than the shop's.
