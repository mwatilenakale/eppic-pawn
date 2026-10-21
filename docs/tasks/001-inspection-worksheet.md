# 001 — The inspection worksheet page

**Status:** OPEN
**Depends on:** nothing — `src/inspection/queue.ts` is built and tested.

## Why this exists

Lukas approves an item in principle, the customer carries it into the shop,
and somebody has to physically check it before money changes hands. Today
that happens in somebody's head. This is the screen that makes it happen the
same way every time, with a name against it.

## What to build

A web surface, on the existing server, for a member of staff holding a
signed link.

**The queue** — jobs waiting, oldest first, and the ones this person is
already holding. Each row: what the item is, how long it has waited, and who
has it if anyone. A button to take one.

**The worksheet** — for a claimed job: every check for that exact item, in
the documents' order. Per line: the check text, a pass / fail / N/A control,
and an optional note. Then a findings box in the inspector's own words.
Submit is refused until every line has an answer — the domain layer already
enforces this; the page should also not let them try.

**The submitted view** — read-only afterwards: what was checked, what was
found, who did it and when.

## Everything you need already exists

`src/inspection/queue.ts` is the contract. Do not query `inspection_jobs`
directly from the page; go through it.

```ts
const queue = new InspectionQueue(store, rules);

queue.waiting()                 // unclaimed, oldest first
queue.mine(user.id)             // what this person is holding
queue.job(jobId)                // one job
queue.claim(jobId, user)        // take it — throws if somebody else has it
queue.release(jobId, user)      // put it back
queue.worksheet(jobId)          // the checks, merged with answers so far
queue.record(jobId, user, results)   // save progress without finishing
queue.submit({ jobId, user, results, findings })  // throws if incomplete
```

Identify the person with `Store.staffByToken(token)` and gate the routes on
`can(user, 'inspections.work')` from `src/staff/access.ts`.

Suggested routes, but use your judgement:

```
GET  /staff/<token>              the queue
POST /staff/<token>/claim        take a job
GET  /staff/<token>/job/<id>     the worksheet
POST /staff/<token>/job/<id>     save progress, or submit
```

## Constraints

**No money on this screen. None.** Not the valuation, not the loan, not what
the customer hoped for. An inspector who knows the target has a reason to
wave something through — the playbook already worries about exactly this
with car mechanics. `queue.ts` cannot return a figure, so the only way one
reaches the page is if you fetch it from somewhere else. Don't.

**Use the existing design system** in `src/web/theme.ts`. It is the one
Lukas chose and already carries tokens for cards, choices, buttons and the
verification banner. No new CSS framework. No external fonts or scripts —
the pages load nothing third-party and there is a test enforcing it.

**This page approves nothing.** Submitting hands a report to Lukas. The
final decision is his, over WhatsApp, as it is everywhere else in this
system.

## The tests must prove

- A staff member can see the queue, claim a job, and submit a complete sheet
- Submit is refused while any line is unanswered, and the page says which
- A job somebody else is holding cannot be claimed
- **No `N$` figure appears anywhere in any rendered inspection page.** Assert
  it against the HTML, the way `test/website.test.ts` does for the public
  site — that technique has caught real leaks here
- A bad or revoked token gets nothing, and the two look the same from outside
- The page loads nothing from a third party

## One known flaw to fix on the way

The car checks come out of the clause splitter as sentence fragments:

```
• Inspected by a mechanic before acceptance — customer covers the N$50 fee
• but he keeps using his own trusted mechanic rather than letting the customer pick one
• to avoid a friendly inspector waving through a bad car. If the car fails and there's
• he bears that cost himself.
```

Acceptable as a prompt in a WhatsApp message. Not acceptable as tick boxes
on a worksheet somebody has to sign off.

See `CONTINUATION` and `ENUMERATION_LEAD` in `src/intake/questions.ts`. A
clause that cannot stand alone as a checkable statement should attach to the
one before it rather than becoming its own line. Add cases to
`test/intake.test.ts` for whatever you change, and check the generated plan
for **every** category afterwards — print it and read it. Three of the four
defects found in this area were found by reading output, not by a failing
assertion.

Do not fix it by editing `docs/playbook.md`. The document is Lukas's; the
parser is ours.
