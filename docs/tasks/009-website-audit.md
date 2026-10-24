# 009 — Audit the website. Report only.

**Status:** OPEN
**Depends on:** nothing.
**You may change:** `whatsapp-agent/audits/` and `docs/website-audit.md` —
nothing else, at all. See "This is not an implementation task" below.

## Why this exists

Lukas asked for the website to be checked by both of us, and specifically
asked that Codex report rather than correct. He is right to: the two of us
find different things, and a fix landing before the finding has been read
loses the finding.

Claude inspected it on 25 October and found one real fault — the no-quote
card said "*he* will come back to you himself", which on a one-man shop tells
a customer exactly as much as the owner's name did. It was on the page shown
to anyone whose item could not be priced automatically, so the customers most
likely to end up talking to a person were the ones being told which person.

That is the kind of thing a second pair of eyes catches. Hence this.

## This is not an implementation task

**Report. Do not fix.** Not even the obvious ones, not even a one-character
typo. Write what you found, with evidence, and wait.

This is not a lack of trust — it is that you have been right about things I
had reviewed and signed off three times now, and each time the *finding* was
worth more than the fix. A fix arriving with the finding means I read a diff
instead of reading the problem. Put your findings in
`docs/website-audit.md`, with a `## Claude's response` section at the foot
saying "awaiting response", exactly as you did on task 004. I will answer
there and then authorise whatever needs doing — by you or by me.

If something you find is a live security hole rather than a defect — anything
that exposes one customer's data to another, or lets an outsider write to the
database — say so at the very top of the document in those words, so it is
the first thing read rather than the eleventh thing on a list.

## What Claude already checked, so you do not repeat it

Driven over real HTTP, `GET /`, `GET /apply`, `POST /apply`:

- The four figures are arithmetically correct on the page — N$10,450 market
  gives N$7,837.50 assessed, N$3,918.75 pawn, N$4,898.44 buy-now
- All eight rendered questions round-trip; answering every one `yes` gives
  status `ready`, so an honest customer is not stuck on "something to sort
  out" forever
- The verification banner appears on every page carrying a figure
- The N$5,000 proof-of-purchase instruction appears above the threshold and
  not below it
- An out-of-category item is not refused outright
- An empty or unpriceable description invents no figure
- Below the minimum loan says so, with the reason
- No `<script>`, nothing third-party, viewport meta, colour-scheme declared
- An unknown path 404s, `/health` responds
- **HTML escaping of the description**: script tags, `img onerror`, attribute
  breaks, a closing-div injection, 20,000 characters, and unicode with an RTL
  override — all escaped, nothing survived into the markup

Those are covered. Starting from them wastes your round.

## What Claude did not check — start here

Honest list of where I did not look:

1. **The variant path.** `GET /apply?category=phones` with no variant. And an
   invalid variant. And a category with no variants at all.
2. **Malformed requests.** A `POST /apply` with no `category`, the wrong
   content-type, a body larger than anything reasonable, duplicated fields,
   array-style fields (`q[]=yes&q[]=no`). What a hand-rolled client does to it.
3. **Accessibility.** Labels tied to inputs, focus order, whether the radio
   groups are reachable and announced, contrast against the dark theme, and
   whether the page is usable with the keyboard alone. Lukas's customers are
   on cheap Android phones, some of them with the text size turned up.
4. **What the pre-check stores.** `recordPrecheck()` writes the description
   and answers to the database on every submission, from an anonymous visitor.
   Is that right? Is anything in it personal? It is the one place the website
   writes, and I have never looked at what accumulates there.
5. **Repetition and abuse.** Ten thousand submissions. Nothing rate-limits
   `POST /apply`, and each one calls the valuator — which in production is a
   paid API. Say what that costs and what should bound it.
6. **The contract pages.** `signingPage`, `signedPage`, the signature capture.
   I touched only the expired-link message. A customer signs a loan agreement
   on those pages and I have not read them as a customer.
7. **Declared-but-unreached things, which is your strength.** You found the
   N$5,000 threshold that way. There are roughly seventy parsed playbook
   fields; `PrecheckOutcome` has fields I am not certain every page renders;
   `src/web/theme.ts` declares tokens that may be unused. Start from the
   declaration and look for the consumer.
8. **Reading it as a customer.** Does the quote page actually explain the
   difference between pawning and selling? Is "Assessed value" a phrase a
   customer in Windhoek understands? Would you know what to do next? A page
   that is technically correct and leaves somebody confused is a finding, and
   it is the kind this project has repeatedly been worst at.

## How to report a finding

For each one:

- **What** — one sentence
- **Evidence** — the request, the response, the line of code. A diagnostic
  print is ideal; that is how your scenario-18 finding was immediately
  believable.
- **Why it matters** — in terms of a customer or of money, not in terms of
  code quality
- **Your judgement of severity**, in your own words
- **Suggested scope for a fix** — not the fix

Pass as well as fail. If a thing is sound, say so briefly: knowing the
signature capture is fine is worth something.

## The constraints that do not move

- No source change. No test change. No playbook, architecture or instruction
  file change.
- Nothing submitted to Meta, no live customer contacted, no real API called.
- If an audit needs a fixture price, it is a fixture — say so in the document,
  as you correctly did on the twenty scenarios.
- `npm test` and `npm run typecheck` must still pass when you are done, which
  they will, because you are not touching anything they cover.
