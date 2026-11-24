# Changing the rules yourself

**For Lukas. You do not need a programmer for any of this.**

Everything in this file is a change you make by editing `docs/playbook.md` and
restarting the agent. No code, no developer, no waiting.

The one thing to understand: **the system reads your document every time it
starts.** It does not have its own copy of your rules. If the document and the
code ever disagree, the document wins — and if a rule is missing from the
document, the agent refuses to start rather than guess. That is deliberate.

---

## How to make a change

1. Open `docs/playbook.md` in any text editor (Obsidian is fine).
2. Edit the line.
3. Restart the agent (`npm start`, or redeploy on the host).
4. Check it took: `npm run sim`, then type `/rules` to see exactly what it read.

**If you make a mistake it will not start**, and it will tell you which section
is wrong. That is better than it starting with the wrong rate.

---

## What you can change on your own

### A new document to bring in

Section 5, under "Documents to bring". Add a line:

```
- Proof of address — a utility bill or a bank statement, under three months old
```

That is all. The agent will ask for a photo of it, chase it on the dashboard
until it arrives, list it on the agreement, and show it to you at the release
gate if it is still missing. Write the explanation after a dash — that part
reaches the customer, so put what you want them to read.

### A new thing the customer must confirm

Section 5, under "The customer must also be able to confirm":

```
- The item has never been reported to an insurer as lost or stolen
```

The agent will ask it as a yes / no / not sure question.

### Interest, terms, grace

Section 4, the table. Change `29%` or `30 days` and that is the new rate on
every loan written after the restart. Existing loans keep the terms they were
written under — the rate is stored on the loan, not looked up later.

The grace period is the line under the table.

### The minimum loan, the valuation formula, the buy-now markup

Section 3. The formula is written out in words and the code follows it.

### What you check per category, and which photos you ask for

Section 6. The checklists per category, and the "Detail photos" subsection
below them — that is where the back-of-TV label and the battery screenshot
live. Add or remove lines freely. **Cut anything the shop does not really
need: every extra question is a customer who gives up partway.**

### How to tell a customer where to look

Section 6, "How to check". These are the hints the agent sends when somebody
answers "not sure". Each line is `phrase: what to tell them`, and the phrase is
matched against the question.

### Reminders, the final notice, the extension ceiling

Section 8. The 3 days before due, the final notice on the last day of grace,
the 75% line.

---

## What needs a developer

Honestly, so you know where the line is:

- **A new category of item** (jewellery, tools). The category list is in
  section 2 and the agent will read it, but the valuation and the fraud checks
  for a new kind of thing need thinking about, not just typing.
- **Changing how the agreement is laid out** — the wording of its sections,
  as opposed to the rates and documents in it.
- **Anything about how the messages are sent** — Twilio, templates, the
  website.
- **A new command** on WhatsApp.

---

## Two things never to do

**Do not change a heading's level.** `## 4. Interest rates` must stay `##`. If
it becomes `###` the agent cannot find the section and will not start. It will
say so clearly, and the fix is to put the `##` back.

**Do not let anyone put a rate in the code.** If a developer tells you a
threshold is "hard-coded", that is a bug, not a decision. Every rate, term and
threshold is in your document for a reason: so you can change it without
asking anybody.

---

## When you are not sure a change worked

```bash
cd whatsapp-agent
npm run sim
```

Then type `/rules`. It prints every rule it has read out of your document —
rates, grace, thresholds, documents, the lot. If what you changed is not in
that list, it did not take, and the shape of the line is usually why.
