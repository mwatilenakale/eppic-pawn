# Reliability audit — Codex to Claude

Historical audit notes for the base below. See `ten-scenarios.md` for current
integration with Claude's newer handover, inspection and dashboard modules.

Base: `claude/pawnshop-system-iterative-nq35b0`, commit
`0797fce1b71a3d620272e02380aba402461ff82d`.

## Plan

Review the existing modules and tests, reproduce failures at money and storage
boundaries, and fix confirmed defects without changing the planned architecture.
Keep the playbook as the rule source, owner replies as the approval authority,
and the ledger append-only. Test failure recovery as well as successful flows.
Run the complete test suite and typecheck before publishing this branch.

The inspection queue, release gate, handover commands and message templates in
AGENTS.md remain separate feature work. This pass addresses existing behaviour.

## Changes and regression evidence

- Contract signing previously inserted a loan and ledger before writing its
  signature. A simulated disk error left a pending contract with debt, and a
  retry could create another loan. Signing now uses one SQLite savepoint for
  all database writes, including audit. Late database failures roll it back too.
- Intake previously marked an inbound message as seen before advancing its
  state. A failed photo write consumed the message ID permanently. The marker,
  answers and state now commit together; a failed message can be retried.
- Owner approval previously saved the decision before calculating terms. Zero
  approved the row and then threw. Negative or malformed explicit figures could
  fall back to the suggestion. Validate first, enforce the playbook minimum,
  and commit decisions, overrides, item status and audit as one operation.
- SQLite INTEGER affinity did not prevent fractional ledger entries. Reject
  fractional, non-finite and unsafe cents at the ledger boundary; also reject
  them in market estimates and loan-term inputs. Oversized typed amounts now
  fail parsing rather than losing precision.
- Services retained the original Rules object even when getRules replaced its
  cache. getRules now provides a live view, including retained lookup methods;
  loadRules still provides an explicit snapshot. Invalid edits fail closed.
  Capture a fresh snapshot if a future operation needs rules frozen across an
  await; do not retain a nested playbook object expecting it to update itself.
- Website price memory showed assessed value in the market-value row, ignoring
  an explicit market correction. Preserve the actual correction; legacy rows
  derive missing values from the playbook, not a hard-coded divisor. The model
  prompt's inverse discount now also comes from the playbook.

Inline comments mark the recovery and rule-lifetime constraints. Store.transaction
is synchronous: never put WhatsApp/API calls or other awaited work inside it.
Rollback does not delete committed ledger entries or change the reversal rule.

## Verification

Baseline: 325 passing tests. Added failure-injection regressions reproduced the
defects before their fixes. Final validation: 335 passing tests, zero failures;
`npm run typecheck` passes. Runtime: Node v24.19.0. No external API calls,
customer data, workbook import, real messages or deployment were used to test.
The system Node on this machine is v18; use a supported runtime explicitly.
The declared minimum Node v22.6 was not tested in this environment.

## Follow-up for Claude

1. Durable webhook inbox/outbox: server.ts acknowledges before processing and
   router.handle catches failures. The intake retry fix permits reprocessing,
   but does not make Meta retry an already acknowledged message. Persist inbound
   events before ACK and persist outbound delivery jobs; replay after a crash.
   Owner commands also need deduplication by provider message ID so a delayed
   duplicate bare APPROVE cannot target the next pending application.
2. Contract reissue and workbook import/revert still contain multi-write paths
   without a surrounding transaction. Use the synchronous savepoint helper and
   add injected-write-failure tests. A database rollback cannot roll back an
   encrypted file write; late failure can leave an unreferenced encrypted blob.
   Design recovery/cleanup explicitly rather than deleting media blindly.
3. Four-character references can collide. Approval resolution currently takes
   the first matching pending row. Refuse ambiguous matches and design a longer
   unambiguous reply before changing the shared reference format.
4. The OpenAI/Anthropic estimators currently request model-generated prices;
   neither implementation retrieves or verifies current market listings. Source
   strings are model output, not evidence of a real listing. Add retrieval with
   dated provenance before describing these as live market research.
5. Finish the inspection worksheet and owner release gate in AGENTS.md. Signing
   still opens the loan before physical inspection; that existing workflow is
   preserved here. Proof-of-purchase-above-threshold is parsed from the playbook
   but not yet enforced as an inspection/release requirement.

Next agent: branch from or incorporate codex/reliability-audit before working on
these same files. Keep the failure-injection tests and rerun the full suite.
No dependency, schema, rate, term, or business-rule document was changed here.
