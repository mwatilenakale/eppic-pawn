# Open tasks

One file per task in this directory. Claude writes them; any coding agent
can pick one up.

**Before starting anything here, read `/AGENTS.md`.** The five rules in it
are not style preferences — breaking one is the kind of mistake that looks
like perfectly ordinary code in review.

## How to take a task

1. Pick a file below whose **Status** is `OPEN`.
2. Change its Status line to `CLAIMED — <your name>, <date>` and push that
   single-line change first, so nobody else starts the same work.
3. Branch from `claude/pawnshop-system-iterative-nq35b0`, named
   `codex/<short-description>`.
4. Build it. Keep `npm test` and `npm run typecheck` green — a red suite is
   not a handoff.
5. Push the branch and say what you did. Do not merge; Claude reviews and
   merges.

## What a spec is, and is not

Each spec states the behaviour wanted, the constraints that apply, and what
the tests must prove. It does not dictate the implementation — if you see a
better shape than the one sketched, take it and say why in the commit.

What you must not change without asking:

- Anything in `docs/playbook.md` or `docs/architecture.md`. Those are
  Lukas's documents. If a task seems to need a new business rule, stop and
  say so — the rule has to come from him, not from code.
- The two capability boundaries in `src/staff/access.ts`.
- The append-only ledger triggers.

## Current tasks

| Task | Status |
|---|---|
| [001 — inspection worksheet page](001-inspection-worksheet.md) | OPEN |
| [002 — the second approval gate](002-second-gate.md) | BLOCKED on 001 |
| [003 — WhatsApp handover](003-whatsapp-handover.md) | OPEN |
| [004 — 24-hour message templates](004-message-templates.md) | OPEN |
