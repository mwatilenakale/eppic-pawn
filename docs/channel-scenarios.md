# iPhone 15 channel scenarios — Codex to Claude

Historical channel-pass notes below. The current integration and validation are
in `ten-scenarios.md`; Claude's newer modules are preserved and research evidence
is now migration 12, not the earlier draft's migration 9.

## Plan and owner clarification

The owner requested scenario tests and fixes for an iPhone 15 (base model),
box present, about 95% battery health, through WhatsApp and the website. Both
channels should show market, pawn-loan and buy-outright estimates from the same
engine. Only the owner can approve a deal. Customer-facing estimates are not
approval, acceptance or a binding purchase offer.

Preserve the existing architecture. Extract the duplicated quote calculation
into a shared service, add a WhatsApp estimate conversation and name capture,
recognise returning customers without replacing their name with a profile
nickname, and retain prior price evidence for subsequent estimates. Ask for
missing storage and condition rather than assuming them. Reuse owner corrections
before asking the estimator. Keep all arithmetic and thresholds in the playbook.

Exercise the real HTTP website and signed webhook with a deterministic estimator
and synthetic customer. Test unknown and returning customers, missing details,
provider failure, repeat delivery, historical evidence and owner-only approval.
Fixture prices test wiring and arithmetic; they are not current market prices.

## Scenario results

Before this change all six initial HTTP scenarios failed. WhatsApp discarded
the item enquiry, did not ask a stated name, and could overwrite a known name
with the Meta profile nickname. The website would estimate an unspecified
storage size. Historical estimates were not supplied as research context.

The corrected synthetic conversation is:

1. Customer: "What is the value of my iPhone 15 normal, with a box and about
   95% battery health?"
2. Unknown customer: asked their name; their original enquiry is kept.
3. Customer: "Scenario Customer". Their name is saved under the phone number.
4. Agent asks for storage size rather than guessing one.
5. Customer: "128GB, fully working, no damage".
6. With a **synthetic N$10,000 market estimate**, both channels calculate:
   assessed N$7,500; pawn-loan estimate N$3,750; buy-outright estimate N$4,687.50.
   Both display "estimate, not an offer". No approval, contract or loan appears.

The website asks for the missing details on the form and preserves the original
description. A known WhatsApp customer is recognised by name without repeating
registration. The same name, customer ID and unfinished enquiry survive a real
SQLite close/reopen. Replayed/concurrent enquiries call the estimator only once.
Research failure or absent credentials produces no invented price.

## Handoff details

- QuoteService is shared by the website, WhatsApp estimates, and the suggestion
  sent for owner approval. Explicit owner corrections retain all four figures.
- Schema migration 9 adds market_observations for dated AI evidence. It is not
  the append-only financial ledger and never changes approvals. The estimator
  receives up to eight recent observations for the same category/variant.
- AI evidence stays separate from price_adjustments, whose reuse period still
  comes from the playbook. Exact matching now preserves storage, battery,
  condition and box differences. Existing corrections are matched using their
  stored descriptions so no destructive fingerprint migration is needed.
- The customer name and enquiry state live in existing customers/conversations
  tables. Profile nicknames are no longer treated as permission to rename a
  customer. Per-phone async queues protect conversation ordering in one process;
  these are not a substitute for the durable inbox/outbox noted in the audit.
- Existing plain intake still gathers evidence without quoting. The new explicit
  valuation-enquiry path shows nonbinding estimates before an application. The
  owner remains the only person who can approve, adjust or decline a deal.

No valuation API credentials were configured in the test environment. HTTP
webhooks were correctly signed synthetic requests and replies used MemoryTransport,
not Meta's production number. These tests establish behaviour, arithmetic and
database persistence; they do not establish today's market value, real-provider
quality, live WhatsApp delivery or a deployment. The earlier live-market-retrieval
follow-up remains open: neither provider currently verifies actual listings.

Validation: 348 passing tests (335 before this scenario pass), zero failures;
`npm run typecheck` passes on Node v24.19.0. The old intake regression fixtures
now answer the new name question, and price-screen fixtures supply actual
storage and condition rather than relying on an unspecified configuration.
