# 010 — The website on a cheap phone in the sun

**Status:** OPEN — for Kimi Code.
**Depends on:** nothing. The findings are confirmed and reproduced.
**You may change:** `whatsapp-agent/src/web/theme.ts`,
`whatsapp-agent/src/web/pages.ts`, `whatsapp-agent/src/contract/page.ts`,
`whatsapp-agent/src/server.ts` (the `POST /apply` guards only), and the tests
for those — `whatsapp-agent/test/website.test.ts`,
`whatsapp-agent/test/quote.test.ts`, `whatsapp-agent/test/signing.test.ts`.
Nothing else. Not the playbook, not `AGENTS.md`, not either `CLAUDE.md`, not
`src/playbook/`, not `src/store/`, not the valuator.

Welcome. Read `AGENTS.md` first — it is the whole contract and it is short.

## Why you

Lukas's judgement, 30 October 2026: of the three of us you are the strongest
on websites. This is the first task so it is deliberately a bounded one with
objectively right answers, partly so the change is easy to review and partly
so we both learn how this works. The design judgement comes next, and that one
is more interesting; see "What comes after this".

## What is wrong

All of this is from Codex's audit (`docs/website-audit.md`, findings H, I and
J) and I have re-checked the two that matter most.

**1. Money figures are illegible.** `--text-muted` is `#525252`, used by
`.dim`, which is what the market value and assessed value render in at 15px on
the dark quote card. Against `--bg-primary` that measures **2.36:1**. WCAG AA
wants 4.5:1 for body text. Lukas's customers are on cheap Android phones,
often outdoors in Windhoek. A figure nobody can read is worse than no figure.

Fix the token, not the call sites — `.dim` is used in several places and they
should all improve together. Keep the visual hierarchy: these numbers are
meant to sit behind the headline amount, so make them legible rather than
loud.

**2. Keyboard focus is invisible.** `src/web/theme.ts` has
`.choices input { position: absolute; opacity: 0; pointer-events: none }` and
the visible `label` has no focus style. Tab through the eight screening
questions and nothing shows where you are. The radio groups are otherwise
good — real `fieldset`, real `legend`, 48px targets — so this is the one thing
between them and being properly usable without a mouse.

`:focus-visible` on the input with `:has()` on the label is the obvious
approach and the sheet already uses `:has()`. Whatever you choose, the
*visible* element has to show focus, and it must not move the layout.

**3. A long or malformed submission is handled inconsistently.** In
`POST /apply`:

- a description of 100,000 characters passes the client `maxlength` and
  reaches the valuator, which in production is a paid API call per request
- a body over about 5 MB resets the connection instead of answering
- `content-type: text/plain` is accepted and priced
- an unknown `variant` such as `not-a-phone` returns 200 and a form

Add a request body limit that answers **413** rather than dropping the
connection, a server-side length cap on `description` that matches the form's
own `maxlength`, a content-type check, and a known-variant check. A malformed
request should never read like a business rejection — "We don't take that at
the moment" is the wrong answer to a broken content-type.

**Not in scope, and deliberately:** rate limiting and spend caps on the
valuator (audit finding C). Those need a budget decision from Lukas. A body
limit is not a rate limit; stop at the limit.

**4. One sentence of guidance** under the description box on `/apply`:
something to the effect of *item details only — no ID numbers, PINs or
contact details*. Codex found that whatever a visitor types there is stored
and sent to the valuation provider, and the box is the only place they can
type. Keep it short and non-alarming; the wording is yours.

## How to check your own work

```bash
cd whatsapp-agent && npm install
npm test          # 694 passing before you start. Keep them passing.
npm run typecheck
```

There is no build step — TypeScript runs natively. `npm run sim` drives the
WhatsApp side in a terminal if you want to see the rest of the system.

For the contrast change, state the computed ratio in your handoff rather than
asserting it is better. For focus, say how you checked it — a screenshot or a
described tab order both work.

## The things that will get a change rejected

- **Editing the playbook, `AGENTS.md` or either `CLAUDE.md`.** `AGENTS.md`
  rule 0. If a rule seems to block the task, say so in the handoff.
- **A hard-coded rate, term, threshold or screening question.** Everything of
  that kind is parsed from `docs/playbook.md` at runtime.
- **A new runtime dependency.** There is one (`@anthropic-ai/sdk`) and a
  second was removed last week after review. No CSS framework, no component
  library, no fonts or scripts from a third party — a test enforces that the
  pages load nothing external, and it should keep passing.
- **A figure on a page without the verification banner.** The website shows an
  estimate, never an offer, and the banner saying so goes with every figure.
- **Touching the money.** Nothing in this task needs `src/playbook/`,
  `src/store/`, the valuator or any arithmetic. If you think it does, stop.

## What comes after this

Codex's findings F, G and L are open and they are the ones that play to your
strength: the quote page is 2,473px tall at 390px with the WhatsApp action
three viewport heights down, borrowing cost only appears at the agreement
stage, and the site has no real identity or Back/Edit wayfinding. Those are
partly Lukas's taste, so he decides the direction before anyone writes CSS —
and when he has, a design task is yours if you want it.

## Handoff

Branch `kimi/website-accessibility`, push it, do not merge. Write what you did
and what you measured at the foot of this file under `## Kimi's handoff`, with
a `## Claude's response` section below it saying "awaiting response". I will
answer there and merge, the same way Codex's tasks go.

If something here is wrong or unclear, that is worth more than a workaround —
say so. Twice now a question from Codex has turned out to be a mistake in my
spec rather than a gap in the task.
