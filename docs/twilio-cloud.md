# Twilio WhatsApp — cloud deployment and Claude review

Status: **reviewed and merged, 29 October 2026. NOT deployed.** No live account
settings changed, no provider chosen, no templates submitted. Claude's review
verdict is at the foot of this file, including the two changes made on merge
and the three things still open before this can carry a real customer.
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

- The signature is validated across all form fields against PUBLIC_BASE_URL +
  request path/query, never a caller-supplied forwarding header. **Amended on
  review:** this no longer uses the `twilio` package. The validator is ~10 lines
  of `node:crypto` implementing Twilio's documented algorithm, checked against
  the package's own output before the package was removed, and pinned by
  known-answer vectors in `test/twilio.test.ts`. It is stricter than the
  package, which tries six URL spellings. See the review verdict below.
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
  **Amended on review:** the counts are now on the staff dashboard under
  "Messages that did not go through", so the SQL above is for digging into a
  case rather than for discovering there is one.
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

---

## Claude's review — 29 October 2026. Merged, with two changes.

Merged. 664 tests pass, `tsc --noEmit` clean. This is the best-reasoned branch
Codex has produced on this project, and most of what makes it good was not in
any spec I wrote — I never asked for a Twilio adapter at all.

### What it got right, unprompted

**It refuses to fetch `MediaUrl0`.** The webhook hands you a URL and the
obvious implementation downloads it. That is a server-side request forgery
hole: whatever is on the other end of that URL gets fetched by a process that
can reach the database and the media directory. It resolves media by SID under
the fixed account path instead and says why in a comment.

**It does not trust the webhook's timestamp.** It fetches Twilio's Message
resource for the authoritative send time, because a retry or a forged field
could otherwise reopen a customer's 24-hour window — which is the same insight
it had on task 004, applied again without being told.

**It rejects duplicate form fields before validating.** A signature checked
over a `Record<string, string>` cannot see that the body sent `Body` twice;
refusing the request outright closes that off.

**Single-attempt sends, and a receipt reserved before acknowledgement.** Same
reasoning as the collection notices: an ambiguous POST must not duplicate a
money message, and a restart must not replay Lukas's `APPROVE`. The receipt
table is reserved synchronously, before the empty TwiML goes back, so a Twilio
retry arriving mid-flight is deduplicated rather than racing.

**It told the truth about what it had not done.** No host chosen, no account
touched, no templates submitted, Docker not even installed in its environment —
and it said so rather than claiming a working deployment.

### The two changes

**1. The second runtime dependency is gone.** It was there for one function,
`twilio.validateRequest`, and brought 55 transitive packages — axios,
jsonwebtoken, eight lodash micro-packages, 21 MB — none of which this code
calls, into a repository holding customers' ID photos and the loan ledger.

Its argument was that canonicalisation should come from the provider rather
than a hand-written variant. That inverts here. `validateRequest` tries six
spellings of the URL — with the default port, without it, URL-normalised, and
two legacy query-string forms — because it must work for back ends of unknown
shape. This deployment pins one exact origin, which `loadConfig` already
enforces, so one comparison is strictly tighter: the package accepts a
signature computed for `https://host:443/path` on a request to
`https://host/path`; the replacement refuses it.

Hand-rolling a signature validator is the riskiest thing in this review, so it
was not taken on trust. The replacement was run against the package on 13
cases — unicode above the BMP, CRLF, ampersands and equals signs,
percent-encoding, an empty value, an empty form, a field name that is a prefix
of another, numeric field names that do not sort numerically, 40 fields, a
query string, a trailing slash — and agreed on all of them, accepting every
valid signature and refusing every tampered one. Ten are now known-answer
vectors in `test/twilio.test.ts`, generated by the package itself, so the
algorithm stays pinned without it. Both comparisons are timing-safe.

The cost is one failure mode worth knowing: the URL in the Twilio console must
be character-for-character `PUBLIC_BASE_URL` plus the path. A port, a trailing
slash, or a proxy rewriting the path and every webhook 401s. That is the right
way to fail, and it is now documented in the code.

**2. A message that did not go through was invisible.** At-most-once dispatch
is correct and stays. But nothing read the receipt state, and this document
told an operator to run SQL by hand to find out. The case that matters is
Lukas's own:

```
dispatch threw: Twilio inbound handling failed
receipt: { message_id: SM..., state: 'failed' }
dashboard mentions it: no
```

He sends `APPROVE`, it fails, nothing retries it, and nobody tells him — so he
believes a customer was approved who was not. `Store.inboundNeedingReview()`
now counts failed and interrupted receipts and the dashboard shows them near
the top, in terms of what it means for him. `processing` counts as unknown
rather than as still running, and the section is absent when there is nothing
to report.

Also fixed: `shutdown()` closed the database even when the caller passed its
own store.

### Verified by driving it, not only by the assertions

Over real HTTP: an unsigned forgery and one signed with the wrong token both
get 401; a correctly signed enquiry is routed and answered; a Twilio retry of
the same `MessageSid` sends nothing further; `/webhook` is 404 in Twilio mode.

Separately, the day-one case — a fresh deployment with `TWILIO_CONTENT_SIDS`
still empty and a customer whose window has shut:

```
refused, as it should be: No approved Twilio Content SID/parameters for
                          eppic_outcome_v1; message not sent
HTTP posts made to Twilio: 0
failure handler fired: true
inside the window, free-form: sent
```

No free-form fallback, no HTTP call attempted, the error names the template
that needs mapping, and Lukas gets the alert. That is the right behaviour, and
it means the shop can run on the sandbox for in-window conversations before any
template is approved — but **an approval decided overnight will not reach the
customer until the templates exist.** Plan the template approvals before
relying on it.

### Still open before this carries a real customer

1. **Hosting is still Lukas's decision and still unmade.** The checklist above
   names the requirements correctly — one always-on instance, a persistent disk,
   no scale-to-zero, no multiple replicas — and deliberately picks no provider.
   Nothing in this branch decides it, and nothing should be deployed until it is
   decided together with the backup arrangement, because an ephemeral filesystem
   loses the loan ledger and the encrypted ID photos on the first restart.
2. **Multiple attachments on one message are dropped silently.** `NumMedia`
   above 1 returns 400, Twilio does not retry a 4xx, and the customer gets no
   reply at all. WhatsApp sends one media per message, so this should not
   happen in practice — but if Twilio ever changes that, a customer's photo
   disappears with nothing said. Left alone deliberately: fixing it properly
   means touching media handling on both providers, which is its own task.
3. **`inbound_windows.source = 'meta'` now means "verified platform time",
   including Twilio.** The document says so, which is the honest short-term
   answer, but the column name is now wrong and will mislead whoever reads it
   next. Worth renaming when something else touches that table.
