/**
 * The public website (architecture step 6), on the Eppic design system.
 *
 * Four steps, as the design specifies: category, details, research, quote.
 *
 * What the quote screen shows changed on Lukas's instruction: the customer now
 * sees an **estimate**, not nothing. It is labelled as an estimate everywhere
 * it appears and carries the verification banner, because it is not an offer —
 * he still approves every figure, and that has not changed. See root CLAUDE.md.
 *
 * Loads nothing from anywhere else: no fonts, no scripts, no images. There is
 * nothing here worth stealing and nothing to leak.
 */

import { escapeHtml } from '../html.ts';
import { BUSINESS } from '../contract/document.ts';
import { formatAmount } from '../money.ts';
import type { Rules } from '../playbook/index.ts';
import type { Question } from '../intake/questions.ts';
import { THEME, iconFor } from './theme.ts';
import { whatsappLink, type PrecheckOutcome, type PrecheckQuote } from './precheck.ts';

// "Estimate", not "Research": there is no retrieval step behind it. See the
// comment on the submit button below (Codex's website audit, finding D).
/**
 * The submit label.
 *
 * Deliberately not "Research market value". The valuator sends the
 * description to a model against a fixed schema; it retrieves no listings,
 * and the page shows no sources, comparables or dates that would back such a
 * claim. Codex's website audit, finding D.
 *
 * A TypeScript comment and not an HTML one, which is where this started: an
 * HTML comment is served to the browser, so the word stayed on the page and
 * the test that forbids it kept failing — correctly.
 */
const ESTIMATE_BUTTON = 'Work out an estimate &rarr;';

const STEPS = ['Item', 'Details', 'Estimate', 'Quote'] as const;

/** "the manager" → "The manager", for a heading or the start of a sentence. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function page(title: string, body: string, whatsapp: string, step?: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="Eppic Pawn Shop, Windhoek — cash against cars, phones, laptops, TVs and consoles.">
<meta name="color-scheme" content="dark">
<style>${THEME}</style>
</head>
<body><div class="container page-enter">
${step ? stepBar(step) : ''}
${body}
<footer>${escapeHtml(BUSINESS.name)} t/a ${escapeHtml(BUSINESS.tradingAs)} · ${escapeHtml(BUSINESS.place)}<br>
WhatsApp ${escapeHtml(whatsapp)}</footer>
</div></body>
</html>`;
}

/** 1 Item → 2 Details → 3 Estimate → 4 Quote. */
function stepBar(current: number): string {
  return `<div class="step-bar">${STEPS.map((label, index) => {
    const number = index + 1;
    const state = number < current ? 'completed' : number === current ? 'active' : 'pending';
    const connector = index > 0 ? `<div class="step-connector ${number <= current ? 'completed' : ''}"></div>` : '';
    return `${connector}<div class="step">
      <div class="step-number ${state}">${number < current ? '&check;' : number}</div>
      <span class="step-label ${state === 'active' ? 'active' : ''}">${label}</span>
    </div>`;
  }).join('')}</div>`;
}

export function landingPage(rules: Rules): string {
  const categories = rules.categories
    .map(
      (category) => `<li><a class="category-card" href="/apply?category=${encodeURIComponent(category.slug)}">
        <span class="category-icon">${iconFor(category.slug)}</span>
        <span class="category-name">${escapeHtml(shortLabel(category.label))}</span>
      </a></li>`,
    )
    .join('');

  const requirements = rules.playbook.requirements.map((item) => `<li>${escapeHtml(item)}</li>`).join('');

  return page(`${BUSINESS.tradingAs} — cash against your item, in Windhoek`, `
    <header>
      <h1>Cash for your<br>stuff. Today.</h1>
      <p class="lead">Get an instant estimate on what ${escapeHtml(BUSINESS.tradingAs)} would lend you —
      or pay you outright — in ${escapeHtml(BUSINESS.place.split(',')[0]!)}. No name or number needed.</p>
    </header>

    <div class="card">
      <h2>What do you have?</h2>
      <ul class="category-grid stagger-children" style="margin-top:var(--space-4)">${categories}</ul>
    </div>

    <div class="card">
      <h2>How it works</h2>
      <ul class="plain">
        <li>Tell us what the item is and answer a few questions.</li>
        <li>We work out an estimate from what the item is worth second-hand.</li>
        <li>${escapeHtml(capitalise(rules.playbook.ownerLabel))} checks it and confirms the final figure on WhatsApp.</li>
        <li>You sign on your phone, then bring the item in.</li>
      </ul>
    </div>

    <div class="card">
      <h2>Bring with you</h2>
      <ul class="plain">${requirements}</ul>
    </div>

    <a class="btn btn-primary" href="/apply">Get my estimate</a>`, rules.playbook.whatsapp, 1);
}

export function chooseCategoryPage(rules: Rules, error?: string): string {
  const categories = rules.categories
    .map(
      (category) => `<li><a class="category-card" href="/apply?category=${encodeURIComponent(category.slug)}">
        <span class="category-icon">${iconFor(category.slug)}</span>
        <span class="category-name">${escapeHtml(shortLabel(category.label))}</span>
      </a></li>`,
    )
    .join('');

  return page('What do you have? — Eppic Pawn Shop', `
    <header><h1>What do you have?</h1></header>
    ${error ? `<div class="verification-banner" role="alert"><strong>${escapeHtml(error)}</strong></div>` : ''}
    <div class="card"><ul class="category-grid stagger-children">${categories}</ul></div>
    <p class="muted">These five are what we take as standard. Got something else?
    ${askAboutIt(rules.playbook.whatsapp, rules.playbook.ownerLabel)}</p>`,
    rules.playbook.whatsapp, 1);
}

/**
 * Something outside the five categories — playbook section 2, "Something
 * else".
 *
 * The website cannot ask Lukas itself: it has no name or number for whoever is
 * reading it, and his answer has nowhere to go back to. What it can do is stop
 * saying "we don't take that" — which is a decision the site has no business
 * making — and point them at the number where the agent will ask him.
 */
function askAboutIt(whatsapp: string, owner: string): string {
  const number = whatsapp.replace(/[^\d+]/g, '');
  return `<a href="https://wa.me/${encodeURIComponent(number.replace(/^\+/, ''))}">Message us on WhatsApp</a>
    and we'll ask ${escapeHtml(owner)} — we do take other things when they're worth it.`;
}

export function questionsPage(
  rules: Rules,
  category: { slug: string; label: string },
  variant: string | null,
  questions: Question[],
  options: { description?: string; error?: string; answers?: Record<string, string> } = {},
): string {
  const variants = rules.variantsFor(category.slug);

  if (variants.length > 1 && !variant) {
    const choices = variants
      .map(
        (group) => `<li><a class="category-card" href="/apply?category=${encodeURIComponent(category.slug)}&amp;variant=${encodeURIComponent(group.variant!)}">
          <span class="category-icon">${iconFor(category.slug)}</span>
          <span class="category-name">${escapeHtml(group.label)}</span>
        </a></li>`,
      )
      .join('');

    return page(`${category.label} — Eppic Pawn Shop`, `
      <header><h1>${escapeHtml(shortLabel(category.label))}</h1></header>
      <div class="card">
        <h2>Which one is it?</h2>
        <ul class="category-grid stagger-children" style="margin-top:var(--space-4)">${choices}</ul>
      </div>`, rules.playbook.whatsapp, 1);
  }

  const fields = questions
    .map(
      (question, index) => `
      <fieldset>
        <legend>${index + 1}. ${escapeHtml(shorten(question.ask))}</legend>
        <div class="choices">
          ${['yes', 'no', 'not sure']
            .map(
              // Whatever they already chose stays chosen. This used to check
              // "not sure" unconditionally, so a customer corrected on their
              // description — "please add its storage size" — got the form
              // back with all eight answers reset. Re-submitting then recorded
              // "not sure" against questions they had answered yes, which is
              // the shop being told something untrue about the item, not just
              // an annoyance. Falls back to "not sure" only when there is no
              // previous answer, which is the first visit.
              (choice) => `<label><input type="radio" name="${escapeHtml(question.id)}" value="${choice}"${
                choice === (options.answers?.[question.id] ?? 'not sure') ? ' checked' : ''
              }><span>${choice}</span></label>`,
            )
            .join('')}
        </div>
      </fieldset>`,
    )
    .join('');

  return page(`${category.label} — Eppic Pawn Shop`, `
    <header>
      <h1>${escapeHtml(shortLabel(category.label))}</h1>
      <p class="lead">Answer honestly — this is a check for you, not a test. Everything is confirmed in person anyway.</p>
    </header>

    ${options.error ? `<p class="verification-banner" role="alert">${escapeHtml(options.error)}</p>` : ''}
    <form method="post" action="/apply" class="card">
      <input type="hidden" name="category" value="${escapeHtml(category.slug)}">
      ${variant ? `<input type="hidden" name="variant" value="${escapeHtml(variant)}">` : ''}

      <div class="input-group">
        <label class="input-label" for="description">What is it, exactly?</label>
        <input class="input" type="text" id="description" name="description" maxlength="160"
               placeholder="e.g. iPhone 15, 128GB, box, 95% battery, no damage" autocomplete="off" value="${escapeHtml(options.description ?? '')}">
        <p class="muted" style="margin-top:var(--space-2)">The more exact, the closer the estimate.</p>
      </div>

      ${fields}
      <button class="btn btn-primary" type="submit">${ESTIMATE_BUTTON}</button>
    </form>

    <p class="muted">We don't ask for your name or number here, and nothing you enter is an application.</p>`,
    rules.playbook.whatsapp, 2);
}

export function outcomePage(outcome: PrecheckOutcome, whatsapp: string, ownerLabel: string): string {
  const link = whatsappLink(whatsapp, outcome.whatsappText);

  if (outcome.status === 'not-accepted') {
    return page('We cannot take that — Eppic Pawn Shop', `
      <header><h1>${escapeHtml(outcome.headline)}</h1></header>
      <div class="verification-banner" role="alert">
        ${outcome.notes.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}
      </div>
      <a class="btn btn-secondary" href="/apply">Check something else</a>`, whatsapp, 1);
  }

  return page('Your estimate — Eppic Pawn Shop', `
    <header>
      <h1>${escapeHtml(outcome.headline)}</h1>
    </header>

    ${outcome.quote?.belowMinimum ? tooSmallCard(outcome.quote) : outcome.quote ? quoteCard(outcome.quote) : noQuoteCard(ownerLabel)}

    ${outcome.quote?.belowMinimum ? '' : verificationBanner(ownerLabel)}

    ${
      outcome.notes.length
        ? `<div class="card">
             <h2>Worth knowing first</h2>
             <ul class="plain">${outcome.notes.map((note) => `<li class="warn">${escapeHtml(note)}</li>`).join('')}</ul>
           </div>`
        : ''
    }

    <div class="card">
      <h2>Bring with you</h2>
      <ul class="plain">${outcome.bring.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    </div>

    ${
      outcome.weWillCheck.length
        ? `<div class="card">
             <h2>You weren't sure about ${outcome.weWillCheck.length === 1 ? 'one thing' : `${outcome.weWillCheck.length} things`} — that's fine</h2>
             <p class="muted">Here is where to look, if you want to. If you still can't tell, bring the
             item anyway: we check ${outcome.weWillCheck.length === 1 ? 'it' : 'these'} ourselves when you come in. The estimate above stands,
             and ${escapeHtml(ownerLabel)} gives you the firm amount once ${outcome.weWillCheck.length === 1 ? 'that is' : 'those are'} checked.</p>
             <ul class="plain">${outcome.weWillCheck
               .map((entry) => `<li><strong>${escapeHtml(entry.question)}</strong>${
                 entry.howToCheck ? `<br><span class="muted">${escapeHtml(entry.howToCheck)}</span>` : ''
               }</li>`)
               .join('')}</ul>
           </div>`
        : ''
    }

    ${
      outcome.verifiedInPerson.length
        ? `<div class="card">
             <h2>Checked when you bring it in</h2>
             <ul class="plain">${outcome.verifiedInPerson.map((check) => `<li>${escapeHtml(check)}</li>`).join('')}</ul>
           </div>`
        : ''
    }

    <a class="btn btn-primary" href="${escapeHtml(link)}">Continue on WhatsApp</a>
    <p class="muted" style="text-align:center;margin-top:var(--space-3)">or message ${escapeHtml(whatsapp)}</p>`,
    whatsapp, 4);
}

/**
 * The figures. Every one of them is labelled an estimate, and the pawn loan is
 * marked as the better deal only in the sense the design intends — more cash
 * kept, since the item comes back.
 */
function quoteCard(quote: PrecheckQuote): string {
  return `<div class="card card-highlight">
    <span class="label">Estimated pawn loan</span>
    <div class="price-display price-large price-accent" style="margin:var(--space-2) 0 var(--space-6)">
      ${escapeHtml(formatAmount(quote.loanCents))}
    </div>

    <div class="price-row">
      <span class="label">Market value</span>
      <strong class="dim">${escapeHtml(formatAmount(quote.marketValueCents))}</strong>
    </div>
    <div class="price-row">
      <span class="label">Assessed value</span>
      <strong class="dim">${escapeHtml(formatAmount(quote.assessedValueCents))}</strong>
    </div>
    <div class="price-row">
      <span class="label">Pawn loan<span class="badge">Keep it</span></span>
      <strong class="price-accent">${escapeHtml(formatAmount(quote.loanCents))}</strong>
    </div>
    <div class="price-row">
      <span class="label">We buy it outright<span class="badge">Most cash</span></span>
      <strong class="price-success">${escapeHtml(formatAmount(quote.buyNowCents))}</strong>
    </div>

    <p class="muted" style="margin-top:var(--space-5)">
      Pawn it and you pay the loan back with interest and keep the item. Sell it outright and you get more
      cash now, but the item is ours.
    </p>
  </div>`;
}

/**
 * Under the playbook's floor. Said plainly and without blaming the item —
 * the reason is the shop's handling cost, not the customer's phone.
 */
function tooSmallCard(quote: PrecheckQuote): string {
  return `<div class="card">
    <h2>This one is too small for us</h2>
    <p class="lead" style="margin-top:var(--space-3)">Your item comes out at about
      ${escapeHtml(formatAmount(quote.loanCents))}, and we don't take on loans under
      ${escapeHtml(formatAmount(quote.minimumLoanCents))}. A small loan is the same amount of work as a big
      one, so we would not be doing you any favours at that size.</p>
    <p class="muted" style="margin-top:var(--space-4)">If you have something worth more — a car,
      a laptop, a newer phone — we would be glad to look at that instead.</p>
  </div>`;
}

function noQuoteCard(ownerLabel: string): string {
  return `<div class="card">
    <h2>${escapeHtml(capitalise(ownerLabel))} will work out your figure</h2>
    <p class="lead" style="margin-top:var(--space-3)">We could not price this one automatically — send it over on
    WhatsApp with a photo and you will get a figure back.</p>
  </div>`;
}

/** Section 5H of the design. `role="alert"` per its accessibility section. */
function verificationBanner(ownerLabel: string): string {
  return `<div class="verification-banner" role="alert">
    <span class="verification-icon" aria-hidden="true">&#9888;</span>
    <h2>This is an estimate, not an offer</h2>
    <p class="lead" style="margin-top:var(--space-2)">
      Every figure here is worked out from an automated guess at what the item is worth second-hand. It is
      not a checked selling price, and nobody has seen your item yet. ${escapeHtml(capitalise(ownerLabel))} confirms the final
      amount once the item and the photos have been seen — it can go up or down.
    </p>
  </div>`;
}

/** `Phones (iPhone and Android)` -> `Phones`, for a card that has to fit. */
function shortLabel(label: string): string {
  return label.replace(/\s*\(.*\)$/, '');
}

function shorten(ask: string): string {
  return ask.split('\n')[0]!.replace(/^Can you confirm:\s*/i, '').replace(/\?$/, '');
}
