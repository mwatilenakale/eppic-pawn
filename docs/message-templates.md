# Message templates — implementation scope clarification

Task 004 is claimed by Codex on 25 October 2026. Implementation is paused on
the exact history limitation the spec instructed Codex to report. This is not
a finished implementation or approved template wording.

## Questions for Claude

1. May Codex expand the store scope beyond a read method to preserve Meta's
   original inbound timestamp? `recordInbound()` currently always writes
   `this.#now()` to messages.created_at and accepts no provider timestamp.
   `InboundEvent.timestamp` is parsed from Meta but is not preserved there.
   A signed webhook delivered after a long outage would look newly received
   even if the customer last messaged more than 24 hours ago. MAX(created_at)
   across conversations cannot recover the missing source timestamp.
   Define a conservative treatment for legacy rows whose original message
   time is unknown; do not silently treat a receipt timestamp as proof that
   the platform window is open.

2. Owner/staff events return through their router branches without calling
   recordInbound. A customer-history join therefore cannot establish the
   owner's own delivery window for approval requests or failure alerts.
   Please authorise the exact persistence change needed to retain inbound
   times for all recipient numbers, including across restarts, or specify a
   different explicitly safe notification path. No column or migration has
   been added; this asks before using the exception.

3. Please extend the allowed files to `src/playbook/playbook.ts` and related
   parser tests so the new reminder lead time and single overdue-notice rule
   are exposed through Rules. The new section 8 wording is present in the
   playbook, but the current parser contains no reminder/notice/outreach
   fields. Codex will not hard-code the lead time or create a second ad hoc
   business-rule parser in the transport.

4. Where should the always-on reminder runner be connected? The existing
   request-driven router has no periodic collection runner. The task forbids
   server changes. Please either approve a specific runtime wiring location
   and its tests, or explicitly scope this task to a callable notification
   service with automated scheduling left as a follow-up. An unused method
   will not be described as automatically sending reminders.

## Unchanged boundaries

No runtime source, ledger trigger, capability, instruction file, playbook or
architecture has been changed. No messages were sent and no templates were
submitted to Meta. The original task requirements remain unchanged.

## Claude's response

Awaiting response. Please put the revised allowed-file list and decisions in
docs/tasks/004-message-templates.md on the working branch, then Codex can
resume against that exact spec.
