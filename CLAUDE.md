# Eppic Pawn Shop — Project Context

Read this first, every session. This file is what Claude Code loads
automatically — treat it as standing instructions, not a one-time brief.

## What this project is

A system for Eppic Pawn Shop (Mwatile Eppic Investment CC, Windhoek,
Namibia) — starting with a WhatsApp agent that handles customer intake
and item screening, sends the owner (Lukas) a WhatsApp message for every
approval decision, and eventually extends to a valuation website and
auto-generated loan contracts. Full design: `docs/architecture.md`.

## Where the rules live

**`docs/playbook.md` is the source of truth for every business rule** —
interest rates, loan terms, screening checklists per item category,
collections logic, referral and capital-split arrangements. Never
hard-code a rate, term, or rule anywhere in application code. Read it
from this file at runtime, or at minimum reference it directly rather
than restating it from memory — it changes, and code that duplicates it
goes stale silently.

**`docs/architecture.md` is the system design** — components, data
flow, build order, and the open regulatory question in its Section 0.
Read that section before writing anything related to interest rates or
loan terms; it's unresolved and matters.

## Non-negotiable constraints

- **No n8n, no low-code workflow tools.** Real code only. This has been
  said explicitly and repeatedly — don't reach for a workflow-automation
  tool as a shortcut.
- **AI never gives final approval on money or item acceptance.** Every
  valuation the system produces is a suggestion. Every accept/decline
  decision routes to Lukas via WhatsApp and waits for his reply. This is
  permanent, not a v1 stand-in — do not build a path that skips it, even
  behind a flag.
  - Both the website and WhatsApp may show the customer an estimate (Lukas's decision,
    August 2026). That is not a loosening of the rule: the figure is
    labelled an estimate, carries the verification banner, and binds
    nobody. What must never happen is a figure presented as final, or an
    application progressing, without his reply. WhatsApp estimates were requested
    in the iPhone 15 scenario review; see docs/channel-scenarios.md.
- **Sized for the actual team**: Lukas, plus one hire who inspects items
  but has no approval authority. Do not build multi-tier approval roles,
  admin hierarchies, or permission systems sized for a staff that
  doesn't exist.
- **Build order matters** — see `docs/architecture.md` Section 5. Don't
  jump ahead to the website or the full database migration before the
  WhatsApp agent itself is working end-to-end.

## Current focus

**Step 1 (see `whatsapp-agent/`): WhatsApp Intake Agent + Approval
Workflow**, with the per-category fraud/condition checklists (playbook
Section 5, architecture Section 2.3) built directly into the same
intake flow rather than as a separate later phase.

## Working style

This project follows the same architect → coder → tester → PM pattern
used on Lukas's other coding work. Before writing implementation code
for a new component, produce or confirm a short written plan for that
specific piece and check it against `docs/playbook.md` and
`docs/architecture.md` rather than assuming — these documents already
answer most "how should this behave" questions.
