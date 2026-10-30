# Core build handoff for Claude — 30 October 2026

Reconciled onto architect commit 2b043091679ab562a8dc0942ecf335b553839dad,
including Claude's second approval gate, receipt flow and 75% correction.
Review this branch; do not treat this note as authority to change protected rules.

## Explicit instructions from Lukas

Lukas requested 75% of current market value for extension eligibility and
confirmed that equality qualifies. He confirmed two-week reuse for both AI
estimates and owner corrections, kept separately, and authorised PostgreSQL
migration preparation without moving live data or changing hosting.
The playbook changes here record those instructions, not an agent-invented rate.

## Implemented

- Preserved Claude's 75% extension correction and added the one-cent-over test.
  Tests cover equality,
  one cent over, declining market value, owner authority and append-only entries.
  Existing next-period interest and term rules remain unchanged; no new rate or
  proration formula was invented for special loan terms.
- QuoteService reuses dated AI observations for the playbook's memory window.
  Owner corrections take precedence. AI results stay in market_observations;
  they never become price_adjustments, approvals or loans. Reads do not renew
  the expiry. Only exact normalised descriptions reuse AI evidence.
  Concurrent identical requests in one QuoteService share one in-flight call;
  cross-instance deduplication still needs the cloud database work.
- src/valuator/refresh.ts exports an owner-authorised invalidation helper.
  A reason is mandatory. Audited insertion cutoffs invalidate earlier AI and
  correction records without deleting history, including same-time records.
  Claude still needs to connect this helper to an authenticated owner interface;
  no public reset endpoint or automatic market-news detector was added.
- Customer media now requires matching message type, MIME and recognised image
  or PDF headers. Audio and unsupported media get a text fallback without
  advancing intake. PDFs cannot satisfy item-photo questions. Existing human
  handover remains quiet. Header validation is not a decoder or a malware scan.
- PostgreSQL preparation is in postgresql-migration-review.md. It is a review
  plan, not a driver, executable migration or completed cloud deployment.

## Not implemented — do not mark these complete

Google sign-in, verified website-to-WhatsApp session continuation, customer
progress/account pages, OCR, voice transcription, a general conversational
pawn-agent, the collections scheduler and a PostgreSQL runtime are separate
scoped follow-ups. The existing website handoff still starts intake afresh.
Voice fallback is deliberate: never pretend a voice note was understood.

For continuation, retain anonymous estimates without name, ID or declarations.
Use an opaque, expiring single-use continuation token and verified phone linking;
never merge customers on a typed name, Google email or public application ID.
Do not put ID images, financial details or private customer history in wa.me
URLs. Ask consent before switching channels. Late-stage Google sign-in must not
lock anonymous visitors out of an estimate.

Before deployment, review paid-API abuse limits, durable media storage and
signature/media decoding separately. Do not deploy or migrate customer data from
this branch automatically. Owner approval and the existing ledger triggers were
not relaxed.

Validation after reconciliation: all 705 tests pass and npm run typecheck passes.
No live provider calls, customer data migration, merge or deployment performed.
