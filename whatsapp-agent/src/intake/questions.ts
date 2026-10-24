/**
 * Turns the rule documents into an intake question plan.
 *
 * No screening content lives here — every question's text comes from
 * `docs/playbook.md` section 6 or `docs/architecture.md` section 2.3. What this
 * module decides is only *how* a check is collected:
 *
 *   - some checks a customer can answer or photograph remotely (playbook
 *     section 7: "as much of the checklist happens before the customer walks
 *     in");
 *   - some can only be confirmed with the item in hand — a mechanic's
 *     inspection, a 20-30 minute console load test, a reset done in front of
 *     staff. Those are not asked over WhatsApp. They go to Lukas as the
 *     in-person verification list, which is exactly what playbook section 7
 *     asks for: "tell whoever does the in-person check exactly what to verify".
 */

import type { ChecklistItem, Rules } from '../playbook/index.ts';

export type QuestionKind = 'text' | 'confirm' | 'photo';

export interface Question {
  id: string;
  kind: QuestionKind;
  /** What the customer is asked, verbatim. */
  ask: string;
  /** For photo questions: what the picture is of. */
  photoKind?: string;
  source: 'item' | 'playbook' | 'fraud' | 'documents';
  /** Intake continues without it, but it is listed as missing to Lukas. */
  optional: boolean;
  /**
   * Not needed if this photo has already arrived.
   *
   * Playbook section 5: the police declaration is the *fallback* for somebody
   * who cannot prove they own the thing, not a second document on top of the
   * receipt. Asking a customer holding the original invoice to also go to a
   * police station is friction for nothing.
   */
  unlessPhoto?: string;
}

export interface QuestionPlan {
  /** Null for a one-off Lukas accepted outside the five categories. */
  categorySlug: string | null;
  variant: string | null;
  questions: Question[];
  /** Checks deferred to the in-person visit, with their source text. */
  inPersonChecks: ChecklistItem[];
}

/** Checks that cannot honestly be confirmed over chat. */
const IN_PERSON_ONLY = [
  /watch(ing)? for/i,
  /in front of staff/i,
  /supervised|test drive/i,
  /load test|stress test|20-30 minute|demanding game/i,
  /mechanic/i,
  /diagnostic mode/i,
  /full hardware test|colour test|color test|full-screen/i,
  /keys controlled/i,
  /start-from-cold|start from cold/i,
  /checked against known fraud patterns/i,
  /controller drift/i,
  /network ban|through normal use/i,
  /inspected by/i,
];

/** Checks best answered with a picture, and what the picture should show. */
const PHOTO_CHECKS: { pattern: RegExp; photoKind: string; ask: string }[] = [
  { pattern: /box present|^box$/i, photoKind: 'box', ask: 'Please send a photo of the box (or reply "no box" if you do not have it).' },
  { pattern: /car papers|registration/i, photoKind: 'ownership', ask: 'Please send a photo of the car papers / registration in your name.' },
];

/**
 * Documents playbook section 5 requires on every loan, and how to collect them.
 * Order matters: "police declaration of ownership" must be recognised as the
 * police document, not as ordinary proof of ownership.
 */
const DOCUMENT_REQUESTS: { pattern: RegExp; photoKind: string; ask: string; unlessPhoto?: string }[] = [
  {
    pattern: /police declaration/i,
    photoKind: 'police-declaration',
    ask: 'Please send a photo of the police declaration of ownership.',
    // The fallback, not a second document: skipped entirely once proof of
    // ownership is in (playbook section 5).
    unlessPhoto: 'ownership',
  },
  { pattern: /copy of id|^id\b/i, photoKind: 'id', ask: 'Please send a photo of your ID.' },
  {
    pattern: /proof of ownership|declaration of ownership/i,
    photoKind: 'ownership',
    ask:
      'Please send a photo of your proof of ownership — the receipt, invoice, proof of payment, ' +
      'or the box if the serial matches.\n\nIf you do not have any of those, say so and I will ask for a police declaration instead.',
  },
];

/** Collected at handover, not during chat — the contract is generated later. */
const NOT_COLLECTED_REMOTELY = /signed agreement/i;

/**
 * The slug for an item outside the five categories that Lukas accepted as a
 * one-off — a smartwatch, a camera (playbook section 2, "Something else").
 *
 * A reserved value rather than null, so `items.category_slug` stays NOT NULL
 * and a one-off is something you can search the book for later.
 */
export const OTHER = 'other';

export function buildQuestionPlan(
  rules: Rules,
  categorySlug: string | null,
  variant: string | null = null,
): QuestionPlan {
  const oneOff = !categorySlug || categorySlug === OTHER;
  const category = oneOff ? null : rules.categories.find((entry) => entry.slug === categorySlug);

  // There is no category checklist for something the shop has not taken
  // before, so a one-off gets the documents every loan needs and Lukas
  // inspects it himself. A slug that was given but is not a category is still
  // a programming error.
  if (!oneOff && !category) throw new Error(`Not an accepted category: ${categorySlug}`);

  const questions: Question[] = [
    {
      id: 'item-description',
      kind: 'text',
      ask: category
        ? `Tell me exactly what you have — make, model, storage/size, and its condition. (${category.label})`
        : 'Tell me exactly what you have — make, model, and its condition.',
      source: 'item',
      optional: false,
    },
    {
      id: 'photo-item',
      kind: 'photo',
      photoKind: 'item',
      ask: 'Please send a clear photo of the item itself.',
      source: 'item',
      optional: false,
    },
  ];

  const inPersonChecks: ChecklistItem[] = [];

  const asked: string[] = [];

  const checklist = category ? rules.checklistFor(category.slug, variant) : [];
  for (const { check, inPerson } of checklist.flatMap(classifyClauses)) {
    if (inPerson) {
      inPersonChecks.push(check);
      continue;
    }
    if (DOCUMENT_REQUESTS.some((request) => request.pattern.test(check.text))) {
      continue; // asked once in the documents block below
    }
    if (NOT_COLLECTED_REMOTELY.test(check.text)) {
      continue; // signed at handover, once the contract exists
    }

    const photoCheck = PHOTO_CHECKS.find((entry) => entry.pattern.test(check.text));
    if (photoCheck) {
      if (questions.some((question) => question.photoKind === photoCheck.photoKind)) continue;
      questions.push({
        id: check.id,
        kind: 'photo',
        photoKind: photoCheck.photoKind,
        ask: photoCheck.ask,
        source: check.source,
        optional: true,
      });
      continue;
    }

    // The two documents overlap ("Must be a Smart TV" / "Smart TV only") — ask
    // once rather than twice.
    if (asked.some((previous) => saysTheSameThing(previous, check.text))) continue;
    asked.push(check.text);

    questions.push({
      id: check.id,
      kind: 'confirm',
      ask: `Can you confirm: ${stripLeadIn(check.text)}\n\nReply *yes*, *no*, or *not sure*.`,
      source: check.source,
      optional: false,
    });
  }

  // Asked before anything is collected: a "no, it is still on an account"
  // should end the conversation before the customer has been made to
  // photograph their ID.
  for (const declaration of rules.playbook.declarations) {
    const id = `declaration-${slug(declaration)}`;
    if (questions.some((question) => question.id === id)) continue;

    questions.push({
      id,
      kind: 'confirm',
      ask: `Can you confirm: ${stripLeadIn(declaration)}\n\nReply *yes*, *no*, or *not sure*.`,
      source: 'documents',
      optional: false,
    });
  }

  for (const requirement of rules.playbook.requirements) {
    if (NOT_COLLECTED_REMOTELY.test(requirement)) continue;

    const request = DOCUMENT_REQUESTS.find((entry) => entry.pattern.test(requirement));
    if (!request) continue;
    if (questions.some((question) => question.photoKind === request.photoKind)) continue;

    questions.push({
      id: `document-${request.photoKind}`,
      kind: 'photo',
      photoKind: request.photoKind,
      ask: request.ask,
      source: 'documents',
      optional: false,
      ...(request.unlessPhoto ? { unlessPhoto: request.unlessPhoto } : {}),
    });
  }

  // The fallback comes after what it stands in for, whatever order the
  // document list happens to be in. A customer asked for the police
  // declaration before being asked for a receipt has been sent to a police
  // station for nothing.
  questions.sort((a, b) => Number(Boolean(a.unlessPhoto)) - Number(Boolean(b.unlessPhoto)));

  return { categorySlug, variant, questions, inPersonChecks };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function isInPersonOnly(text: string): boolean {
  return IN_PERSON_ONLY.some((pattern) => pattern.test(text));
}

/**
 * A clause that opens a list of things staff should look out for — "checked
 * against known fraud patterns —", "watching for", "for dead pixels". Everything
 * after it in that bullet is an example, not a separate check.
 */
const ENUMERATION_LEAD = /watch(ing)? for|fraud patterns|for dead pixels/i;

/** Clauses that continue the previous sentence rather than starting a new check. */
const CONTINUATION = /^(but|to|he|she|it|they|if|that|which|rather|so|though|although|since|because|as long as|unless)\b/i;

/**
 * Splits a bullet into clauses and decides which side of the remote/in-person
 * line each falls on.
 *
 * "Checked against known fraud patterns — fake Android-as-iPhone, cloned box,
 * mismatched serial" is one staff check with examples: "cloned box" is not a
 * question to put to a customer. So once a clause opens an enumeration, the
 * rest of that bullet goes to the in-person list with it — as does any clause
 * that is grammatically a continuation of a deferred one.
 */
function classifyClauses(check: ChecklistItem): { check: ChecklistItem; inPerson: boolean }[] {
  let enumerating = false;
  let previousWasInPerson = false;

  return splitIntoClauses(check).map((clause) => {
    const inPerson =
      enumerating ||
      isInPersonOnly(clause.text) ||
      (previousWasInPerson && CONTINUATION.test(clause.text));

    enumerating = enumerating || ENUMERATION_LEAD.test(clause.text);
    previousWasInPerson = inPerson;
    return { check: clause, inPerson };
  });
}

/** Words that carry no meaning when comparing two checks for overlap. */
const NOISE_WORDS = new Set([
  'a', 'an', 'the', 'is', 'be', 'must', 'only', 'per', 'playbook', 'and', 'or', 'of', 'to', 'in', 'on',
  'it', 'its', 'check', 'checked', 'verify', 'verified', 'please', 'with', 'for', 'no', 'not',
]);

/** True when two checks are close enough that asking both is just repetition. */
function saysTheSameThing(left: string, right: string): boolean {
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 1 && !NOISE_WORDS.has(word)),
    );

  const a = words(left);
  const b = words(right);
  if (a.size === 0 || b.size === 0) return false;

  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / (a.size + b.size - shared) >= 0.6;
}

/**
 * Both documents write a category's checks as one long bullet — "Box present?
 * iCloud/account signed out + bypassed, diagnostic mode to check all features,
 * test call for speakers, Face ID check". Asked whole, a customer can't answer
 * it, and one staff-only clause would defer the remote-answerable ones with it.
 *
 * So a bullet is split into its clauses on semicolons and commas, with
 * bracketed asides left intact ("full hardware test (display, cameras, …)"
 * stays one check rather than becoming eight fragments).
 */
function splitIntoClauses(check: ChecklistItem): ChecklistItem[] {
  const asides: string[] = [];
  const masked = check.text.replace(/\([^)]*\)|\[[^\]]*\]/g, (aside) => {
    asides.push(aside);
    return ` ${asides.length - 1} `;
  });

  const clauses = masked
    .split(/[;,?]/)
    .map((clause) => clause.replace(/ (\d+) /g, (_, index: string) => asides[Number(index)]!).trim())
    .map((clause) => clause.replace(/^(and|then|plus)\s+/i, '').trim())
    // A clause that is nothing but a bracketed aside ("(still accepted without
    // one, priced significantly lower)") is context for staff, not a question.
    .filter((clause) => clause.length > 0 && !/^[([].*[)\]]$/.test(clause));

  if (clauses.length <= 1) return [check];

  return clauses.map((text, index) => ({
    ...check,
    id: `${check.id}.${index + 1}`,
    text,
  }));
}

/** Drops the `[decide, draft proposed]` style lead-in from a provisional rule. */
function stripLeadIn(text: string): string {
  const cleaned = text.replace(/^\[[^\]]*\]\s*(—|-)?\s*/, '').trim();
  return cleaned.endsWith('?') ? cleaned : `${cleaned.replace(/[.;]$/, '')}?`;
}

export type Confirmation = 'yes' | 'no' | 'unsure';

/** Reads a yes/no/not-sure answer the way a customer would actually type it. */
export function readConfirmation(text: string): Confirmation | null {
  const answer = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(no box|not sure|unsure|dunno|don'?t know|do not know|maybe|idk)\b/.test(answer)) return 'unsure';
  if (/^(y|yes|yep|yeah|yebo|ja|correct|confirmed|affirmative|sure|ok|okay)\b/.test(answer)) return 'yes';
  if (/^(n|no|nope|nee|negative|not really)\b/.test(answer)) return 'no';
  return null;
}

/**
 * Is this question still needed, given the photos already in?
 *
 * Only `unlessPhoto` is considered — whether the question has been *answered*
 * is the caller's business. Playbook section 5: a customer who has shown proof
 * of ownership is never asked for the police declaration as well.
 */
export function stillNeeded(question: Question, photos: string[]): boolean {
  return !question.unlessPhoto || !photos.includes(question.unlessPhoto);
}

/** The plan with superseded fallbacks dropped. */
export function liveQuestions(plan: QuestionPlan, photos: string[]): Question[] {
  return plan.questions.filter((question) => stillNeeded(question, photos));
}
