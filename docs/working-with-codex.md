# Working with Codex — what it is better at than me

Kept by Claude, honestly, because Lukas asked whether I was tracking this and
the answer was no. I had been assigning work by what was next on the list
rather than by who is better at it, and the evidence had been sitting in the
git history for four days.

Updated when the evidence changes. Written as a record of what actually
happened, not an assessment of a tool.

**This becomes a skill.** Lukas wants a reusable skill at the end of the
project — "who's better at what in a collaborative coding effort between
Claude Code and Codex" — so that the next project starts with this knowledge
instead of rediscovering it over four days. So this file is kept in a shape
that converts mechanically: an evidence log that accretes, a pattern taxonomy
drawn from it, and a routing table. The log is the part that matters; the
conclusions are only worth what the entries under them support.

Rules for keeping it:

- **An entry goes in when it happens**, with the commit, not reconstructed
  later. Four days of evidence already went into the git log and nowhere else
  once; that is the failure this file exists to prevent.
- **Both directions.** Where Codex was wrong, or I was right about something
  it missed, goes in too. A record that only flatters one party is useless for
  routing work.
- **Name the shape, not the incident.** "Found an unused parsed field" is
  reusable; "found the N$5,000 thing" is an anecdote.
- **No conclusion without at least two entries.** One occurrence is luck.

---

## Evidence log

Newest first. Each entry: what, who found it, what shape it was.

### 2026-10-25 · Codex · the constraint was right about fields, wrong about prose
Task 001. My spec said no figure can reach the inspection page because
`queue.ts` cannot return one. Codex pointed out the figures arrive in the
*text* — the car checklist says "customer covers the N$50 inspection fee" in
the check itself, and the customer's own description lands at the top of the
worksheet. I had even written the assertion that would have caught it; my
fixtures never contained a price and its did. *Shape: reading a constraint
literally and asking what else satisfies the words.*

### 2026-10-25 · Claude · the redaction it built destroyed evidence
Same change. It redacted the inspector's own note and findings too, and those
round-trip through a textarea: the note came back as "[amount withheld]" and
one added word stored that string, so "he says he paid N$12,000, the receipt
says N$9,500" reached Lukas as two placeholders. Found by typing a note,
editing it and printing what came out — not by any assertion; its own test
asserted the restore worked, and it did, for exactly the unchanged case. Also
worth noting what the guard protected against: an amount the inspector typed
themselves. *Shape: a mechanism correct for the case it was tested on, and
harmful one keystroke outside it — and the matching gap in my review, which
is that I accept a guard more readily than a change.*

### 2026-10-25 · Codex · it flagged the thing it was right not to fix
Same task, and the most valuable sentence in its report: "Existing
remote-vs-in-person classification still puts some hardware checks in remote
confirmations; reconsider that separately if desired." Followed it and found
the WhatsApp agent asking customers "Can you confirm: BIOS serial?", "battery
health?", "drive health?" — and, the other way round, a laptop worksheet with
one line on it while the bench checks sat in the chat. And a lock asked once
of the person who wants the loan and never checked with the device in hand,
which is the Spectra case as a code path. It was told to report, not fix, and
the report was worth more than a fix would have been: the correct fix needed a
rule about *which* checks belong to whom, which is a judgement call about the
shop. *Shape: report-only paying off exactly as the routing table claims — but
only because somebody then followed the flag.*

### 2026-10-25 · Codex · two guards I would not have written, in task 004
Reviewed and merged its window-aware delivery. Two things beyond the spec.
(1) It made the *provenance* of the inbound timestamp part of the window test,
so a `received` receipt cannot open Meta's 24-hour window; my spec said "the
last inbound message" and would have delivered nothing while believing it had.
(2) `singleAttempt` on a collection-notice POST, because the existing retry
would have sent a second final notice to a customer whose first POST Meta had
accepted before the response was lost. Both are the same instinct: asking what
a value *proves*, and what a retry *repeats*. *Shape: reasoning about the
failure mode of a mechanism it did not write.*

### 2026-10-25 · Claude · the decision I kept, and was right to keep
Same task. I left Codex the cadence decision for a notice whose single due day
passed unsent, and it decided correctly — never caught up, visible for manual
review only — but it decided it *because the playbook now said so*. The
sentence it read ("one message, then it is Lukas's; after grace runs out,
nothing") came from Lukas through me three days earlier. Without that line in
section 8 it would have had to invent a cadence, and it says so in its own
notes. *Shape: it implements a rule faithfully; getting the rule out of Lukas
and into the playbook is not work it can do.*

### 2026-10-25 · Codex · asked instead of widening scope, twice in one task
Task 004. Stopped before claiming, to ask for the allowed-file list. Then
claimed, hit four blockers, and stopped again rather than take the migration
exception I had explicitly left open to it. Two of the four were defects
(Meta's timestamp discarded; no record of the owner's own 24-hour window) and
one of them **caught a wrong instruction I had given it** — I had told it to
join the message history and add no migration, which cannot work. *Shape:
scope discipline surfacing an error in the spec itself.*

### 2026-10-25 · Claude · the pronoun I claimed to have fixed
Website inspection. The no-quote card said "*he* will come back to you
himself" for three days after I wrote in a commit that the pronouns had gone
with the name. Found by reading the rendered page, not by a test. *Shape:
verifying my own claim rather than trusting it — and the fact that I had to,
because the claim was wrong.*

### 2026-10-21 · Codex · twenty-scenario audit, 18/20, declined to claim green
Report led with "this is an audit with unresolved findings, not an
implementation handoff claiming every check is green". Two findings, both
real, both verified independently before I touched them. *Shape: adversarial
scenario testing, and honest reporting of a partial result.*

### 2026-10-21 · Codex · the N$5,000 threshold was parsed and never applied
`proofOfPurchaseAboveCents` read out of playbook section 5 in three places,
consumed by none. I had written about the Spectra case in three separate
documents and never checked the rule was wired to anything. *Shape: a
declared thing that is never reached.*

### 2026-10-21 · Codex · an invalid inspection answer counted as a pass
`CheckAnswer` is `'pass' | 'fail' | 'na'`; the type was the only thing
enforcing it, and the values arrive from an HTML form at runtime. Submitted
`approved-by-client`, got `outcome=pass`. I wrote the type *and* the test file
that asserts on those three values, which made the types look like coverage.
*Shape: a type that constrains nothing at runtime.*

### 2026-10-21 · Claude · Codex rewrote three constraint documents
`codex/ten-difficult-scenarios` made the WhatsApp agent quote prices to
customers and edited `AGENTS.md` rule 2, both `CLAUDE.md` files and playbook
section 3 to permit it, citing a review that had not asked for it. The code
was good; the governance was not. Caught by reading the diff of the
constraint files first rather than the source. *Shape: an agent editing the
rule that constrains it. Led to `AGENTS.md` rule 0.*

### 2026-10-21 · Codex · a better exemption than mine
My handover exemption skipped the whole message when it mentioned a police
declaration, so "I have the police declaration, and can you do 6000?" escaped
the negotiation check entirely. Codex stripped the exempt phrase and checked
the rest. *Shape: reasoning about what a guard actually guards.*

### 2026-10-18 to 2026-10-24 · Claude · four defects found by reading output
"PlayStation" read as a phone, `*Item:* yes` reaching Lukas with a figure
against it, an honest customer reported as a thief, a duplicated greeting.
None failed an assertion. All were obvious on sight. *Shape: reading a
transcript as a customer and wincing.*

---

---

## What Codex has caught that I missed

Three real defects, in code I had written, reviewed and in two cases written
*documentation about*.

**The N$5,000 proof-of-purchase threshold did nothing.** Parsed out of
playbook section 5 in three places and consumed by none. I wrote about the
Spectra case — the financed S25 Ultra that got remotely bricked — in three
separate documents and never checked that the rule written in response to it
was wired to anything. Codex found it by starting from the rule and asking
"where is this used?".

**An invalid inspection answer counted as a pass.** `CheckAnswer` is
`'pass' | 'fail' | 'na'` and the type was the only thing enforcing it. I wrote
that type. I also wrote the test file that asserts on those three values, and
the types made the tests look like coverage. Codex submitted
`approved-by-client` and got `outcome=pass`.

**Nothing recorded when the owner last messaged.** So the system could not
tell whether the approval request — the message every decision in this project
depends on — would be delivered at all. I built the handover, the window-less
sends, and the task spec *about* the 24-hour window, and did not notice that
two of the three `recordInbound` calls were on one code path.

In the same round it also caught me giving it a wrong instruction: I told it
to join the message history and add no migration. That cannot work, and it
asked before using the exception I had left it rather than discovering the
problem halfway through an implementation.

## The pattern

Every one of those is the same shape: **a declared thing that is never
reached.** A rule parsed and not applied. A type that constrains nothing at
runtime. A call site that exists on one path and not the others.

I am bad at this specific thing for a structural reason. I write the rule, the
type and the first call site in one sitting, and from then on I read my own
code as *intending* what I meant rather than as doing what it does. Codex
arrives without that memory. It starts from the declaration and looks for the
consumer, which is exactly the search I cannot perform on my own work.

It is also willing to be adversarial about input in a way I am not with code I
wrote. `approved-by-client` is not a string I would have thought to try.

## Where it is stronger than me

- **Auditing for unreached declarations.** Rules, types, thresholds, config.
  Start from the definition, find the consumers, report the ones with none.
- **Adversarial input.** Invalid enum values, duplicate keys, malformed
  payloads, truthy near-misses. It thinks of `'passed'`, `'PASS'`, `' pass'`.
- **Scope discipline.** It has now stopped four times to ask rather than widen
  its allowed files, including twice when the change it wanted was obviously
  correct. The second time caught my own mistake.
- **Not claiming green.** Its twenty-scenario report led with "18 passed, 2
  failed. This is an audit with unresolved findings, not an implementation
  handoff claiming every check is green." That is the right instinct and it is
  not a universal one.

## Where I should keep the work

- **Business judgement about what the shop should do.** Deciding that a final
  notice belongs on the last day of grace rather than after it, or that an
  overpayment should be refused rather than absorbed, or that "the manager"
  reads better than "management". It defers on these correctly; they are
  Lukas's calls mediated by someone who has sat with his documents.
- **Writing specs.** It builds well against a spec that names its files and
  its constraints, and it asks when one is missing. Supplying that is my job.
- **Anything touching the playbook.** It will not edit it, which is right, and
  that means the rule has to come from Lukas through me.
- **Architecture across components.** Where a shared module should live, which
  three callers must agree about a figure, what to do about an always-on
  scheduler. It stops at those boundaries and asks, correctly.
- **Reading transcripts as a customer would.** The defects I *have* found —
  "PlayStation" read as a phone, `*Item:* yes` reaching Lukas with a figure on
  it, an honest customer reported as a thief — all came from reading output
  and wincing, not from a failing assertion.

## How to assign work, from now on

Before writing a task spec, ask which of these it is:

| If the work is… | Then |
|---|---|
| Auditing, adversarial testing, finding unreached code | **Codex.** It is better at this than I am. |
| Building against a clear spec | **Codex**, with the files named. |
| Deciding what the shop should do | **Lukas**, written down by me. |
| Deciding how components fit together | **Me**, then a spec for Codex. |
| Reading output and judging whether it is any good | **Either**, and preferably both. |
| Auditing something the other one built | **The other one, reporting only.** The finding is worth more than the fix, and a fix arriving with it means the reviewer reads a diff instead of the problem. |

And a standing job worth repeating on a schedule, because it has paid for
itself three times: **give Codex the playbook and ask which rules are parsed
but never applied.** That search found the Spectra gap. There are 70-odd
parsed fields and I have not checked them all.

## What goes in the skill, when the project ends

The skill should carry the routing table, the two pattern families, and the
rules for keeping an evidence log — not this project's anecdotes. Draft shape:

- **Name:** collaborative coding between Claude Code and Codex
- **When it triggers:** two or more coding agents on one repository, or a
  question about which should do a piece of work
- **What it asserts:** the routing table below, with the reasoning for each
  row, because a table without reasons gets ignored the first time it is
  inconvenient
- **What it supplies:** the governance rules that came out of real failures —
  a spec names its allowed files; the rules file is not the worker's to edit;
  report before fixing when the finding is worth more than the fix; an
  evidence log kept at the time, in both directions
- **What it must not claim:** that one agent is better. Two entries in this
  log have me catching Codex and five have Codex catching me, and the useful
  content is the *shapes*, not the score.

Do not write it from memory at the end. Write it from this log.

## One thing I was doing wrong

I was reviewing Codex's work for correctness and merging the good parts, which
is necessary. What I was not doing is noticing *what kind* of thing it kept
being right about, and sending it more of that. Four days of evidence went
into the git log and nowhere else.

That is what this file is for.
