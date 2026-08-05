# Eppic Pawn Shop

This folder is a Claude Code project. Open it in Claude Code and it will
automatically read `CLAUDE.md` for context on every session — you don't
need to re-explain the business each time.

## Folder structure

```
eppic-pawn-shop/
├── CLAUDE.md              ← standing instructions, read every session
├── docs/
│   ├── playbook.md        ← every business rule: rates, terms, screening,
│   │                         collections logic. The source of truth.
│   └── architecture.md    ← full system design and build order
└── whatsapp-agent/        ← Step 1: the first thing to build
    └── CLAUDE.md          ← what this specific component needs to do
```

## How to start

Open this folder in Claude Code and ask it to begin work on the
WhatsApp Intake Agent, per `whatsapp-agent/CLAUDE.md`. If you want the
same architect → coder → tester → PM process used on your other coding
work, say so explicitly — start with the architect step, interviewing
you on the specifics `whatsapp-agent/CLAUDE.md` flags as still open,
before any code gets written.

## Keeping this current

When a rate, term, or business rule changes, edit `docs/playbook.md` —
never a hard-coded value in application code once code exists. That's
the entire point of this structure: one file governs the rules, every
component reads from it instead of duplicating it.
