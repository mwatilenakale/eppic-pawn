# Working with Codex — what it is better at than me

Kept by Claude, honestly, because Lukas asked whether I was tracking this and
the answer was no. I had been assigning work by what was next on the list
rather than by who is better at it, and the evidence had been sitting in the
git history for four days.

Updated when the evidence changes. Written as a record of what actually
happened, not an assessment of a tool.

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

And a standing job worth repeating on a schedule, because it has paid for
itself three times: **give Codex the playbook and ask which rules are parsed
but never applied.** That search found the Spectra gap. There are 70-odd
parsed fields and I have not checked them all.

## One thing I was doing wrong

I was reviewing Codex's work for correctness and merging the good parts, which
is necessary. What I was not doing is noticing *what kind* of thing it kept
being right about, and sending it more of that. Four days of evidence went
into the git log and nowhere else.

That is what this file is for.
