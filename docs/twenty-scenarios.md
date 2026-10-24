> **Both findings fixed by Claude, 24 October 2026, and this audit now
> passes 20/20 unchanged** — the audit script was not edited, so the result is
> the same test that failed before. Scenario 18's own diagnostic now prints
> `invalid answer rejected=true; status=claimed; outcome=null`.
>
> 13: the threshold is applied on the website and in the owner's review
> (`src/requirements.ts`, `proofOfPurchaseFor`); there is deliberately no
> automatic check, because nothing here can read a photograph.
> 18: answers are validated at the queue boundary in `record` and `submit`
> (`src/inspection/queue.ts`, `#validate`).
>
> Regression tests: `test/proof-of-purchase.test.ts`,
> `test/inspection.test.ts` ("an invalid answer is not a pass").

# Twenty-scenario adversarial audit — 21 October 2026

Result at the time of the audit: **18 passed, 2 failed.** This is an audit with unresolved findings,
not an implementation handoff claiming every check is green.

Audited Claude branch: `claude/pawnshop-system-iterative-nq35b0`, pinned at
`ef1df9861a9dd82954773937934d93ef41949019`. Checked the branch again after
testing: it was still at this commit. Read the current AGENTS.md, task README,
playbook and architecture before writing the audit. In particular, WhatsApp
quotes no amount before an owner reply and customer-facing messages use
"the manager", never Lukas's name. The previous branch's estimate policy was
not reused.

## Scope and short plan

Lukas requested 20 different serious test scenarios. Exercise the current
implementation with fresh synthetic customers, an in-memory SQLite database,
mocked research and MemoryTransport; use localhost HTTP for website and signed
webhook checks. Derive monetary rules from the freshly loaded playbook. Run
the existing suite and typechecker independently, then retain failing audit
expectations and report exactly what they reveal.

Only two new files belong to this work:

- `whatsapp-agent/audits/twenty-scenarios.ts`
- `docs/twenty-scenarios.md`

No runtime logic, policy, capability, ledger trigger, task status, dependency or
existing regression test was changed. The inspection worksheet branch was not
silently combined with the architect branch. Inspection scenarios here test the
domain queue, not an unmerged worksheet HTTP page.

## Results

| # | Scenario | Result |
|---|---|---|
| 01 | New WhatsApp visitor gives a name; no price or owner name disclosed | PASS |
| 02 | Returning customer keeps stated identity despite profile nickname | PASS |
| 03 | Same iPhone on both channels: lowest-price website estimate, WhatsApp deferral | PASS |
| 04 | Missing storage clarified before website research | PASS |
| 05 | Below-floor quote flagged without automatically deciding a deal | PASS |
| 06 | Different storage, battery, damage or box cannot inherit an owner correction | PASS |
| 07 | Correction expires on the playbook clock; AI history remains dated evidence | PASS |
| 08 | Empty, malformed and failed research never fabricates website prices | PASS |
| 09 | Forged webhook rejected; signed redelivery produces one reply | PASS |
| 10 | First-contact financed collateral pauses for a person | PASS |
| 11 | Unknown Apple Watch awaits the manager, not accepted as a phone | PASS |
| 12 | Customer command injection cannot approve or reveal another deal | PASS |
| 13 | High-value boxed phone explicitly requires receipt or settlement letter | FAIL |
| 14 | Receipt skips the police fallback but does not skip other documents | PASS |
| 15 | Missing documents remain required; owner waiver audited and item-specific | PASS |
| 16 | Staff may read the book but cannot approve a waiting application | PASS |
| 17 | Incomplete sheet refused; failed check remains failed and approves no money | PASS |
| 18 | Invalid runtime answer must not masquerade as a passed inspection | FAIL |
| 19 | Ledger edits/deletes blocked; reversal preserves original repayment | PASS |
| 20 | Extension ceiling uses current market; denial never auto-sells | PASS |

## Findings and suggested fixes for Claude

### 13 — High-value ownership requirement is parsed but not applied

Playbook section 5 requires a receipt or settlement letter specifically above
the market-value threshold. The fixture's market value is 1,000,000 cents;
`rules.playbook.proofOfPurchaseAboveCents` is 500,000 cents. The website result
contains neither "receipt" nor "settlement letter", even after affirmative
answers to the screening questions. It lists only the generic documents.

Evidence: the diagnostic prints
`market=1000000 cents; proof threshold=500000 cents; receipt/settlement instruction present=false`.
Repository search finds `proofOfPurchaseAboveCents` only in the playbook parser,
not in the application consumers. This is an existing-rule integration gap,
not a missing policy to invent. The demonstrated failure is the website
instruction; this audit does not claim a live financed item was approved.

Suggested scope for a follow-up spec: derive the stronger instruction from the
existing playbook threshold and receipt/settlement requirement, carry it through
precheck/requirements/intake/owner review consistently, and test below, exactly
on, and above the threshold. A matching box must not stand in for settled
finance above the threshold. Retain the owner's item-specific waiver authority
and never tell the customer a required document has been waived. No playbook
edit is needed to implement this existing requirement.

### 18 — InspectionQueue trusts TypeScript instead of runtime answer values

`src/inspection/queue.ts`, `submit()` around lines 200–215, checks whether each
answer is truthy, then treats absence of the exact string `fail` as passing.
The audit claims a job as an inspector and submits every check with the invalid
answer `approved-by-client`. Observed result:
`invalid answer rejected=false; status=submitted; outcome=pass`.

This is a domain-layer validation defect. The test calls the queue directly;
it does not establish an unauthenticated/public HTTP exploit. It also does not
approve money: that authority remains with the owner.

Suggested scope for a follow-up spec: validate `pass | fail | na` at the queue
boundary in both progress-save and submit operations before writing anything;
reject duplicate/unknown check IDs, use canonical check text, and verify that
invalid input leaves job status, report, item inspection and audit unchanged.
Add regression cases for truthy invalid strings and conflicting duplicate
answers. The HTTP guard in the separate worksheet branch should not be the
only place this domain invariant is enforced.

## Reproduction and verification

Use Node >=22.6; this run used Node 24.19.0. From `whatsapp-agent/`:

```sh
npm install
npm test
npm run typecheck
node --test audits/twenty-scenarios.ts
```

- Existing regression suite: **538 passed, 0 failed**.
- Existing typecheck: **passed**.
- Separate adversarial audit: **20 executed, 18 passed, 2 failed, 0 skipped**.
  Its exit code is deliberately **1** while findings 13 and 18 remain unresolved.
- The audit file itself was also typechecked using the same strict NodeNext
  compiler settings explicitly, because `audits/` is outside tsconfig's normal
  include list.

The audit was placed outside `test/` from its creation as a separate diagnostic
deliverable, not moved after failures to conceal them. `npm test` does not run
it. Promote these assertions into normal regressions when the follow-up fixes
are implemented; do not change their expectations to make broken behaviour pass.

Market inputs are synthetic, not today's prices. Media is synthetic; no real
customer data or existing database was loaded. MemoryTransport does not prove
Meta delivery, template approval, or the 24-hour messaging window. No live AI
provider, customer message, payout, production ledger write or deployment was
performed. Failure-mode logs for malformed research and the synthetic outage
are expected in scenario 08.

Do not merge this report as proof the system is production-ready. Claude can
review the reproductions and create tightly scoped fixes for the two findings.
