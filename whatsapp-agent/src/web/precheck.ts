/**
 * The website's quick pre-check (architecture 2.1, step 6).
 *
 * "One valuation and intake engine, two front doors." This is the second door:
 * a short form someone can fill in before committing to the WhatsApp
 * conversation. It asks *the same questions* — the plan is built by the same
 * code the WhatsApp intake uses, so the two can never drift apart.
 *
 * What it must not do is decide anything. It never quotes a figure, and it
 * never tells anyone they are rejected: a "no" on a playbook must-have is
 * reported as what the playbook says, with the conversation still offered.
 * Acceptance is Lukas's call (root CLAUDE.md).
 */

import { buildQuestionPlan, readConfirmation, type Question } from '../intake/questions.ts';
import type { Rules } from '../playbook/index.ts';
import { normalizePhone } from '../whatsapp/webhook.ts';

/** Keep the form short enough that people finish it. */
const MAX_QUESTIONS = 8;

/**
 * Checks the playbook states as conditions of accepting an item at all. A "no"
 * here doesn't reject anyone — it tells them what the rule is before they make
 * the trip.
 *
 *   "Must be a Smart TV"                        — playbook section 6, TVs
 *   "Paid off, registered in the borrower's own name" — section 6, Cars
 *   "BIOS-locked laptops unlocked before accepting"   — section 6, Laptops
 *   "iCloud/account signed out"                 — section 6, Phones
 */
const MUST_HAVES = [
  /must be/i,
  /paid off/i,
  /registered in the borrower/i,
  /unlocked before accepting/i,
  /signed out/i,
  /accounts? removed|account\/login removed|passwords\/accounts removed/i,
];

export type PrecheckStatus = 'ready' | 'needs-attention' | 'not-accepted';

export interface PrecheckAnswer {
  questionId: string;
  question: string;
  answer: 'yes' | 'no' | 'unsure';
  /** True when the playbook treats this as a condition of accepting the item. */
  mustHave: boolean;
}

/**
 * The figures on the quote screen. An estimate, and labelled as one wherever
 * it is shown: Lukas still sets the number that counts.
 */
export interface PrecheckQuote {
  marketValueCents: number;
  assessedValueCents: number;
  loanCents: number;
  buyNowCents: number;
  /** True when this came from an adjustment Lukas made, not from an estimate. */
  fromAdjustment: boolean;
}

export interface PrecheckOutcome {
  status: PrecheckStatus;
  headline: string;
  /** Anything the customer should know before travelling in. */
  notes: string[];
  answers: PrecheckAnswer[];
  /** Documents to bring, from playbook section 5. */
  bring: string[];
  /** What still gets checked with the item in hand. */
  verifiedInPerson: string[];
  /** Prefilled WhatsApp handoff — the real intake still runs from scratch. */
  whatsappText: string;
  /** Null when no market estimate could be had; then Lukas is asked instead. */
  quote: PrecheckQuote | null;
}

/** The questions the web form asks — the same ones WhatsApp would. */
export function precheckQuestions(rules: Rules, categorySlug: string, variant: string | null = null): Question[] {
  return buildQuestionPlan(rules, categorySlug, variant)
    .questions.filter((question) => question.kind === 'confirm')
    .slice(0, MAX_QUESTIONS);
}

export function isMustHave(question: Question): boolean {
  return MUST_HAVES.some((pattern) => pattern.test(question.ask));
}

export interface PrecheckSubmission {
  category: string;
  variant?: string | null;
  description?: string;
  /** questionId -> whatever the form sent. */
  answers: Record<string, string>;
  /** Figures for the quote screen, when they could be worked out. */
  quote?: PrecheckQuote | null;
}

export function evaluatePrecheck(rules: Rules, submission: PrecheckSubmission): PrecheckOutcome {
  const category = rules.category(submission.category);

  if (!category) {
    return {
      status: 'not-accepted',
      headline: `We don't take ${submission.category.trim() || 'that'} at the moment.`,
      notes: [`Eppic Pawn Shop takes ${rules.categories.map((entry) => entry.label).join(', ')}.`],
      answers: [],
      bring: [],
      verifiedInPerson: [],
      whatsappText: 'Hello, I would like to ask about pawning an item.',
      quote: null,
    };
  }

  const plan = buildQuestionPlan(rules, category.slug, submission.variant ?? null);
  const questions = precheckQuestions(rules, category.slug, submission.variant ?? null);

  const answers: PrecheckAnswer[] = questions.map((question) => {
    const raw = submission.answers[question.id] ?? '';
    const confirmation = readConfirmation(raw);
    return {
      questionId: question.id,
      question: shorten(question.ask),
      answer: confirmation === 'yes' ? 'yes' : confirmation === 'no' ? 'no' : 'unsure',
      mustHave: isMustHave(question),
    };
  });

  const blocking = answers.filter((answer) => answer.mustHave && answer.answer !== 'yes');
  const unsure = answers.filter((answer) => !answer.mustHave && answer.answer !== 'yes');

  const notes: string[] = [];
  for (const answer of blocking) {
    notes.push(`The playbook treats this as a condition of taking the item in: ${answer.question}`);
  }
  if (unsure.length > 0) {
    notes.push(`Lukas will want to go through ${unsure.length === 1 ? 'one other point' : `${unsure.length} other points`} with you: ${unsure.map((answer) => answer.question).join('; ')}`);
  }

  const status: PrecheckStatus = blocking.length > 0 ? 'needs-attention' : 'ready';

  return {
    status,
    headline:
      status === 'ready'
        ? submission.quote
          ? 'Here is your estimate'
          : 'Nothing here stops an application — send it to Lukas on WhatsApp.'
        : 'There is something to sort out first, but you can still ask Lukas.',
    notes,
    answers,
    bring: rules.playbook.requirements,
    verifiedInPerson: plan.inPersonChecks.map((check) => check.text),
    whatsappText: composeHandoff(category.label, submission.description ?? '', blocking.length > 0),
    quote: submission.quote ?? null,
  };
}

/**
 * The message that arrives in WhatsApp. It only says what the item is — the
 * intake conversation starts from the beginning either way, so the pre-check
 * can never smuggle an answer past the real screening.
 */
function composeHandoff(categoryLabel: string, description: string, hadBlockers: boolean): string {
  const item = description.trim() || categoryLabel.replace(/\s*\(.*\)$/, '');
  return [
    `Hello, I filled in the pre-check on your website. I have: ${item}.`,
    hadBlockers ? 'I know there is something to sort out first, but I would like to ask about it.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** The web form shows the question without the "Reply *yes*..." tail. */
function shorten(ask: string): string {
  return ask.split('\n')[0]!.replace(/^Can you confirm:\s*/i, '').replace(/\?$/, '');
}

/**
 * `https://wa.me/264812823046?text=...`
 *
 * wa.me only accepts a full international number. The playbook writes the local
 * Namibian form (081-282-3046), so it is normalised first — a link built from
 * the local digits opens a chat with nobody.
 */
export function whatsappLink(businessNumber: string, text: string): string {
  const international = normalizePhone(businessNumber).replace('+', '');
  return `https://wa.me/${international}?text=${encodeURIComponent(text)}`;
}
