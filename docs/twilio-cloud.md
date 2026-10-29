# Twilio WhatsApp — cloud deployment and Claude review

Status: implementation for review, NOT deployed. No live account settings changed.
User-authorised scope: Twilio messaging adapter, configuration, signed webhook,
receipt migration, tests, environment example, and container packaging. No changes
to playbook, architecture, approval capabilities or ledger triggers.

## What runs where

Twilio receives WhatsApp messages and POSTs them to the always-on cloud service.
The existing AgentRouter performs intake/valuation and sends responses through
Twilio's REST API. The website and signing pages run in that same service.
No laptop, local tunnel, local process or local secret file is needed in operation.
Meta remains the default provider for existing deployments.

## Deployment checklist (after Claude review)

1. Choose a cloud container host with **one always-on instance**, a persistent
   writable disk, HTTPS ingress, secret environment variables, and backup support.
   Do not use an ephemeral filesystem, scale-to-zero function, multiple replicas,
   or a public/shared database volume. Hosting/account/billing approval is still
   required; no provider or paid plan has been selected by this branch.
2. Connect this GitHub repository and the reviewed/merged branch. Build with the
   repository-root `Dockerfile`, not the `whatsapp-agent` subdirectory as context.
   Expose port 8080 (or set PORT). Route HTTPS to the container. `/health` returns
   `ok`; it is a process check, not proof of Twilio/AI connectivity.
3. Mount a persistent disk at `/var/lib/eppic`, writable by UID/GID 1000 (node).
   Database defaults to `/var/lib/eppic/eppic.db`; encrypted media defaults to
   `/var/lib/eppic/media`. A mounted volume hides image permissions: configure
   ownership in the host's volume settings/init step before starting this image.
4. Set these in the **cloud secret/environment settings**, never in Git or chat:

   | Variable | Value |
   |---|---|
   | MESSAGING_PROVIDER | `twilio` |
   | TWILIO_ACCOUNT_SID | Account SID from the Twilio account dashboard |
   | TWILIO_AUTH_TOKEN | Auth Token from that same account; also validates webhooks |
   | TWILIO_WHATSAPP_FROM | Exact sandbox/approved sender, `whatsapp:+countrycodeNumber` |
   | PUBLIC_BASE_URL | Exact public HTTPS origin, e.g. `https://agent.your-domain.example` (no path) |
   | OWNER_PHONE | Lukas's separate personal WhatsApp number, NOT the sender |
   | OWNER_NAME | `Lukas` |
   | EPPIC_MEDIA_KEY | Generate a cryptographically random 32-byte key, encoded as 64 hex characters; keep it stable |
   | TWILIO_CONTENT_SIDS | JSON mapping described below |
   | OPENAI_API_KEY or ANTHROPIC_API_KEY | Optional valuation provider key; absent means ask Lukas, not invent a value |

   WHATSAPP_TOKEN/PHONE_NUMBER_ID/APP_SECRET/VERIFY_TOKEN are not needed in Twilio
   mode. Do not put a Twilio token in those Meta variables. No separate API key is
   required for this implementation: server-to-Twilio authentication uses Account
   SID + Auth Token over HTTPS. Credentials are never sent to the browser.
5. In Twilio Console > Messaging > Try it out > Send a WhatsApp message > Sandbox
   settings, set **When a message comes in** to
   `https://YOUR-CLOUD-DOMAIN/webhooks/twilio`, method **POST**, then Save.
   Do not use `/webhook` (that is the disabled Meta endpoint in Twilio mode).
   Do not configure delivery-status callbacks to this incoming-message endpoint.
6. Both test customer and owner must join this account's sandbox. Send a normal
   message from each number after setting the webhook; this lets the application
   record each person's window. Sandbox tutorial success alone does not prove
   this application is connected. Test a harmless enquiry, owner BOOK, and a
   website estimate. Do not approve or pay a real deal just to test connectivity.
7. Before production, register/approve a real WhatsApp sender and templates with
   Twilio/Meta and update the sender. Sandbox is for opted-in test participants,
   not a public shop number. Twilio is an alternative integration, not a bypass
   of WhatsApp's production business/sender approval requirements.

## Templates and delivery

The existing 24-hour gate stays in place. Free-form messages go only to a number
whose verified platform message timestamp establishes an open window. The adapter
fetches Twilio's Message resource; webhook arrival/retry time is never substituted.
The storage marker `inbound_windows.source='meta'` retains its historical name;
here it denotes verified platform time, including Twilio. No migration rewrites
existing window history.

Create/approve Twilio Content templates matching the bodies/variable order in
`whatsapp-agent/src/whatsapp/templates.ts`. Map each internal template name
(`eppic_outcome_v1`, `eppic_payment_reminder_v1`, `eppic_final_notice_v1`, and
`eppic_inspection_passed_v1`) to its actual HX Content SID in TWILIO_CONTENT_SIDS.
Confirm the exact names against that source before configuring. Content SIDs
identify a specific template/language; ensure each mapping is the approved English
version. ContentVariables use string keys `1`, `2`, ... in the existing parameter
order. Do not substitute sandbox demo templates for the business templates.
Missing mappings fail visibly rather than attempting forbidden free-form sends.
Lukas should send the agent a message before sandbox testing approvals; outside
his window, a configured approved template is required to deliver the request.
An accepted provider SID is NOT proof of final delivery; inspect Twilio logs for
delivery failures. Status-callback tracking is not added by this branch.

## Reliability and security — review before going live

- Official Twilio SDK validates the signature across all form fields against
  PUBLIC_BASE_URL + request path/query, never a caller-supplied forwarding header.
  The second runtime dependency is deliberate: security canonicalisation uses
  the provider-maintained validator rather than a hand-written signing variant.
- Account, recipient, sender, message SID and inbound direction are cross-checked
  with Twilio. Failed metadata lookups return 503 before dispatch. Configure and
  verify Twilio's webhook retry policy for HTTP 5xx responses; do not assume every
  failed delivery is retried by default. Inspect Twilio's error logs if delivery
  stops. Preserve the exact public URL through any reverse proxy.
- New migration 16 only adds `twilio_receipts`; no ledger triggers change. A
  durable unique SID reserves each dispatch, including Lukas's commands, before
  acknowledging with empty TwiML. Duplicates do not execute again after restart.
- This is **at-most-once dispatch, not an exactly-once job queue**. A crash after
  reservation can leave work incomplete. A failed send may already have changed
  business state. Monitor cloud error logs and inspect
  `SELECT message_id, state, created_at FROM twilio_receipts WHERE state != 'handled';`
  with an authorised operator. Reconcile against Twilio Message logs and the
  business audit/ledger before requesting a new command. Do not delete receipts
  or auto-replay financial commands. A handled receipt does not prove delivery.
- REST sends make a single attempt: an ambiguous timeout must not duplicate a
  financial notification. Media is resolved by SID under this account, never by
  trusting webhook MediaUrl0. Native fetch removes Basic auth on cross-origin
  media redirects; downloads have a 20 MB technical limit and a network timeout.
- Configure host log/error monitoring and daily consistent backups: use SQLite's
  online backup facility or pause the service and snapshot the whole persistent
  disk (including WAL/SHM if present) together with encrypted media. Do not copy a
  live .db file alone. Store backups encrypted off-host; separately back up the
  media key in a secret vault. Test a restore before real customer intake.
- Keep one instance and persistent storage during redeploys. SIGTERM/SIGINT stop
  new connections and drain acknowledged webhook work before closing SQLite.
  Set the host's termination grace period longer than the longest agent task;
  a forced kill still leaves interrupted receipts needing operator review.
- The cloud image bakes in the reviewed playbook/architecture. When Lukas updates
  them in Git, redeploy that revision; this does not sync a laptop automatically.

## Claude handoff

Review signature/URL handling, template mapping, receipt failure semantics, and
host disk/backup configuration first. Run `npm ci`, `npm test`, and
`npm run typecheck` under Node 24. No merge, deployment, paid account change,
production sender registration, or live credential entry has been performed.
The remaining operational choices are cloud host/domain, secrets, approved
templates, volume permissions/backups, and end-to-end sandbox verification.

Verification on this branch: 649 tests passing, zero failures; TypeScript
typecheck clean under Node 24. Twilio/AI calls in tests are mocked. Docker is not
installed in the execution environment, so the image build and real cloud/Twilio
smoke test remain release checks, not claims of completed deployment.

Official references:
[Twilio request security](https://www.twilio.com/docs/usage/security),
[Message resource](https://www.twilio.com/docs/messaging/api/message-resource),
[Media resource](https://www.twilio.com/docs/messaging/api/media-resource).
