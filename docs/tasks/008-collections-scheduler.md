# 008 — Firing the collections notices

**Status:** OPEN — Claude's. Not for Codex.
**Depends on:** 004 (the `Collections` service it schedules).

## Why this is mine rather than Codex's

Task 004 builds a service that answers "what should go out right now?" and
sends it when called. Nothing calls it. This is what calls it.

It is mine because the answer depends on where this runs — a cron entry, a
`setInterval` in the server process, a hosted scheduler — and that is a
hosting decision Lukas has not made yet. Codex correctly refused to invent a
wiring location and refused to ship an unused method described as automatic.
Both right.

## What it has to get right

- **A missed day is a missed day.** The final notice has exactly one day on
  which it is due. A process that was down for two days must not send it late
  to somebody whose item is already on the market.
- **Exactly once.** A restart, two processes, or a double fire must not send
  the same notice twice.
- **Visible when it does not run.** A scheduler that silently stops is worse
  than none, because the overdue list keeps looking handled.
- **Nothing sends on a timer that is a decision.** Reminders and the final
  notice are notifications. Approving, extending, selling and forfeiting stay
  Lukas's replies, and no scheduler may touch them.

## Blocked on a decision that is not mine

Where this runs. Until there is a host, writing the scheduler means guessing
the deployment, and the guess would be the kind of thing that looks like
working code and is not.
