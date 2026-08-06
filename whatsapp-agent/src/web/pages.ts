/**
 * The public website (architecture step 6): a front door onto the same engine.
 *
 * Deliberately small. It tells people what the shop takes, runs the pre-check,
 * and hands them to WhatsApp. It asks for no name, no number and no photos —
 * there is nothing here worth stealing, and nothing to leak.
 *
 * Like the signing page, it loads nothing from anywhere else.
 */

import { escapeHtml } from '../html.ts';
import { BUSINESS } from '../contract/document.ts';
import type { Rules } from '../playbook/index.ts';
import type { Question } from '../intake/questions.ts';
import { whatsappLink, type PrecheckOutcome } from './precheck.ts';

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 1.25rem 1rem 3rem; background: #f6f5f3; color: #1a1a1a;
         font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 40rem; margin: 0 auto; }
  header { margin-bottom: 1.5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 .5rem; }
  p.lead { font-size: 1.05rem; color: #4a453f; margin: 0 0 1.25rem; }
  .card { background: #fff; border: 1px solid #e2ded8; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
  ul { padding-left: 1.15rem; margin: .5rem 0; }
  li { margin: .35rem 0; }
  .categories { list-style: none; padding: 0; display: grid; gap: .5rem; }
  .categories a { display: block; padding: .9rem 1rem; border: 1px solid #cfc9c2; border-radius: 10px;
                  text-decoration: none; color: inherit; background: #fff; font-weight: 600; }
  .categories a:hover { border-color: #1a5c3a; }
  fieldset { border: 0; padding: 0; margin: 0 0 1.25rem; }
  legend { font-weight: 600; padding: 0; margin-bottom: .5rem; }
  .choices { display: flex; gap: .5rem; }
  .choices label { flex: 1; text-align: center; border: 1px solid #cfc9c2; border-radius: 8px;
                   padding: .6rem .4rem; cursor: pointer; background: #fff; font-size: .95rem; }
  .choices input { position: absolute; opacity: 0; pointer-events: none; }
  .choices input:checked + span { font-weight: 700; }
  .choices label:has(input:checked) { border-color: #1a5c3a; background: #eaf5ee; }
  input[type=text], textarea { width: 100%; padding: .75rem; font: inherit; border: 1px solid #cfc9c2;
                               border-radius: 8px; background: #fff; }
  button, .button { display: block; width: 100%; text-align: center; font: inherit; font-weight: 600;
                    padding: 1rem; border-radius: 10px; border: 1px solid #1a5c3a; background: #1a5c3a;
                    color: #fff; text-decoration: none; cursor: pointer; }
  .button.secondary { background: #fff; color: #1a5c3a; }
  .note { background: #fff8e6; border: 1px solid #e8d9a8; border-radius: 10px; padding: .9rem; }
  .good { background: #eaf5ee; border: 1px solid #b6dcc3; border-radius: 10px; padding: .9rem; }
  .muted { color: #6b6560; font-size: .9rem; }
  footer { margin-top: 2rem; text-align: center; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="Eppic Pawn Shop, Windhoek — cash against cars, phones, laptops, TVs and consoles.">
<style>${STYLES}</style>
</head>
<body><main>${body}
<footer class="muted">${escapeHtml(BUSINESS.name)} t/a ${escapeHtml(BUSINESS.tradingAs)} · ${escapeHtml(BUSINESS.place)}<br>
WhatsApp ${escapeHtml(BUSINESS.whatsapp)}</footer>
</main></body>
</html>`;
}

export function landingPage(rules: Rules): string {
  const categories = rules.categories
    .map((category) => `<li><a href="/apply?category=${encodeURIComponent(category.slug)}">${escapeHtml(category.label)}</a></li>`)
    .join('');

  const requirements = rules.playbook.requirements.map((item) => `<li>${escapeHtml(item)}</li>`).join('');

  return page(`${BUSINESS.tradingAs} — cash against your item, in Windhoek`, `
    <header>
      <h1>${escapeHtml(BUSINESS.tradingAs)}</h1>
      <p class="lead">Cash against something you own, in ${escapeHtml(BUSINESS.place.split(',')[0]!)}.
      Check in a minute whether we can look at your item — no name or phone number needed.</p>
    </header>

    <div class="card">
      <h2>What we take</h2>
      <ul class="categories">${categories}</ul>
    </div>

    <div class="card">
      <h2>How it works</h2>
      <ul>
        <li>Answer a few questions here about your item.</li>
        <li>If nothing stops it, you carry on with Lukas on WhatsApp — he asks for photos and the details.</li>
        <li>Lukas decides the amount himself and messages you. Nothing on this website is an offer.</li>
        <li>You sign the agreement on your phone, then bring the item in.</li>
      </ul>
    </div>

    <div class="card">
      <h2>What to bring</h2>
      <ul>${requirements}</ul>
    </div>

    <a class="button" href="/apply">Start the pre-check</a>`);
}

export function chooseCategoryPage(rules: Rules, error?: string): string {
  const categories = rules.categories
    .map((category) => `<li><a href="/apply?category=${encodeURIComponent(category.slug)}">${escapeHtml(category.label)}</a></li>`)
    .join('');

  return page('What do you have? — Eppic Pawn Shop', `
    <header><h1>What do you have?</h1></header>
    ${error ? `<div class="card note">${escapeHtml(error)}</div>` : ''}
    <div class="card"><ul class="categories">${categories}</ul></div>
    <p class="muted">We only take these five, on purpose — nothing that needs extra storage.</p>`);
}

export function questionsPage(
  rules: Rules,
  category: { slug: string; label: string },
  variant: string | null,
  questions: Question[],
): string {
  const variants = rules.variantsFor(category.slug);

  const variantChooser =
    variants.length > 1 && !variant
      ? `<div class="card">
           <fieldset>
             <legend>Which one is it?</legend>
             <ul class="categories">${variants
               .map(
                 (group) =>
                   `<li><a href="/apply?category=${encodeURIComponent(category.slug)}&amp;variant=${encodeURIComponent(group.variant!)}">${escapeHtml(group.label)}</a></li>`,
               )
               .join('')}</ul>
           </fieldset>
         </div>`
      : '';

  if (variantChooser) {
    return page(`${category.label} — Eppic Pawn Shop`, `<header><h1>${escapeHtml(category.label)}</h1></header>${variantChooser}`);
  }

  const fields = questions
    .map(
      (question, index) => `
      <fieldset>
        <legend>${index + 1}. ${escapeHtml(shorten(question.ask))}</legend>
        <div class="choices">
          ${['yes', 'no', 'not sure']
            .map(
              (choice) => `<label><input type="radio" name="${escapeHtml(question.id)}" value="${choice}"${choice === 'not sure' ? ' checked' : ''}><span>${choice}</span></label>`,
            )
            .join('')}
        </div>
      </fieldset>`,
    )
    .join('');

  return page(`${category.label} — Eppic Pawn Shop`, `
    <header>
      <h1>${escapeHtml(category.label)}</h1>
      <p class="lead">Answer honestly — this is a check for you, not a test. Lukas confirms everything in person anyway.</p>
    </header>

    <form method="post" action="/apply" class="card">
      <input type="hidden" name="category" value="${escapeHtml(category.slug)}">
      ${variant ? `<input type="hidden" name="variant" value="${escapeHtml(variant)}">` : ''}

      <fieldset>
        <legend>What is it, exactly?</legend>
        <input type="text" name="description" maxlength="160" placeholder="e.g. iPhone 13 Pro, 256GB, good condition">
      </fieldset>

      ${fields}
      <button type="submit">See what happens next</button>
    </form>

    <p class="muted">We don't ask for your name or number here, and nothing you enter is an application.</p>`);
}

export function outcomePage(outcome: PrecheckOutcome): string {
  const link = whatsappLink(BUSINESS.whatsapp, outcome.whatsappText);

  if (outcome.status === 'not-accepted') {
    return page('We cannot take that — Eppic Pawn Shop', `
      <header><h1>${escapeHtml(outcome.headline)}</h1></header>
      <div class="card note">${outcome.notes.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}</div>
      <a class="button secondary" href="/apply">Check something else</a>`);
  }

  const notes = outcome.notes.length
    ? `<div class="card note"><h2>Worth knowing first</h2><ul>${outcome.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></div>`
    : '';

  const inPerson = outcome.verifiedInPerson.length
    ? `<div class="card"><h2>Checked when you bring it in</h2><ul>${outcome.verifiedInPerson
        .map((check) => `<li>${escapeHtml(check)}</li>`)
        .join('')}</ul></div>`
    : '';

  return page('Next step — Eppic Pawn Shop', `
    <header><h1>${escapeHtml(outcome.headline)}</h1></header>

    ${outcome.status === 'ready' ? '<div class="card good">Nothing you answered stops an application.</div>' : ''}
    ${notes}

    <div class="card">
      <h2>Bring with you</h2>
      <ul>${outcome.bring.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    </div>

    ${inPerson}

    <div class="card">
      <p>Lukas decides the amount himself once he has seen the details and the photos. Nothing here is an offer.</p>
    </div>

    <a class="button" href="${escapeHtml(link)}">Continue on WhatsApp</a>
    <p class="muted" style="text-align:center;margin-top:.75rem">or message ${escapeHtml(BUSINESS.whatsapp)}</p>`);
}

function shorten(ask: string): string {
  return ask.split('\n')[0]!.replace(/^Can you confirm:\s*/i, '').replace(/\?$/, '');
}
