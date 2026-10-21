# Ten difficult scenarios — Codex handoff

Base: Claude commit `6717f06e6a7ca6cd32cb4da0c0db1558f1a0edfc`.

Plan: execute the ten scenarios Lukas requested against the latest code,
preserve Claude's inspection/dashboard/handover work, integrate the earlier
audit and channel fixes, and publish regression tests and results. No loan
approval authority, ledger trigger, staff capability or lending rate changes.
Customer estimates are permitted by Lukas's explicit channel clarification;
final deals still require his reply. Use synthetic customers, mocked research,
HTTP website requests and signed webhook requests; do not contact real clients.

The ten scenarios cover registration and missing details; returning customers;
website-to-WhatsApp handoff; different specifications; expired memory; duplicates
and concurrency; process restart; failed/malformed research; negotiation and
owner impersonation; and an overdue client offering financed collateral.

## Results

| Scenario | Result |
|---|---|
| 1. New customer, iPhone 15, box, 95% battery, missing storage | Pass: name and storage collected; original description preserved |
| 2. Returning customer, changed profile nickname | Pass: same customer ID and stated name retained |
| 3. Website estimate followed by its WhatsApp link | Pass: item details transferred; registration still required |
| 4. Different storage, battery, damage and box | Pass: fresh research instead of copying a pristine correction |
| 5. Expired owner correction | Pass: fresh research; expired record remains in history |
| 6. Duplicate/rapid messages and two customers | Pass: one estimate per message ID; per-customer ordering and isolation |
| 7. Restart between name and item details | Pass: SQLite reopen preserves name, customer ID and unfinished enquiry |
| 8. Empty, malformed and timed-out research | Pass on both channels: no invented prices or financial records |
| 9. Negotiation, followed by customer APPROVE command | Pass: owner notified, thread held, pending deal unchanged |
| 10. Overdue client offering financed collateral | Pass: owner notified; old debt unchanged; no other customer data leaked |

Executable tests: the ten `scenario N:` tests in
`whatsapp-agent/test/channel-scenarios.test.ts`. Run just these:

```sh
cd whatsapp-agent
node --disable-warning=ExperimentalWarning --test --test-name-pattern='scenario [0-9]+' test/channel-scenarios.test.ts
```

Claude's latest baseline had 432 passing tests. The integrated branch has
**460 passing tests, zero failures**, and `npm run typecheck` passes on Node
v24.19.0. No runtime dependency was added.

## Defects reproduced and fixed

- First-contact handover: previously no conversation meant no trigger check.
  A first message negotiating a figure or discussing debt entered intake
  instead of reaching a person. Create a transcript for that first trigger
  and use the existing HandoverDesk; do not wait for another message.
- Finance/previous-loan language and customer decision commands now reach the
  existing desk. This is a request for owner review, never an approval or an
  automatic decline. Existing takeover, staff access and BACK semantics remain.
- The police-document exemption used to exempt an entire message. Strip just
  the paperwork phrases so a negotiation or ownership concern in the rest of
  the message still escalates.
- Integrated the earlier audit and customer-estimate fixes with Claude's newer
  name capture, unknown-category gate, dashboard and inspection modules. Do not
  replace them with the earlier router draft. Intake emits an estimate request;
  the router uses QuoteService, while the owner-only decision path stays separate.
- Migration **12** adds research evidence. Claude's already-published migrations
  9–11 are preserved verbatim. Never reuse migration 9 from the old draft.
- Stated names are not overwritten with profile nicknames; retained playbook
  views reload; invalid amounts and partial financial writes are covered by
  audit regressions. All of Claude's existing test modules remain in the suite.

One initial scenario assertion incorrectly treated a fresh assessed value as
reuse of an old loan value because the numbers happened to coincide. It now
checks the research calls and appropriate quote fields, rather than banning a
number wherever it appears.

## Limits and next-agent notes

Synthetic signed webhooks and local HTTP website requests exercised application
behaviour. Research prices were fixed fixtures; outbound WhatsApp used
MemoryTransport. No real messages, real customers, provider credentials or
production deployment were used. These results do not establish current market
prices or production Meta delivery. Live listing retrieval and durable inbox/
outbox recovery remain follow-ups from the earlier audit.

This branch is based on the pinned Claude commit above and includes the earlier
audit/channel work. No merge into Claude's branch is performed. Review the
integration here before picking up overlapping router or intake work. The old
handoff documents describe their earlier snapshots; this document is the current
integration report.
