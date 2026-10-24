/**
 * What is still outstanding on an application, and what Lukas waived.
 *
 * One place, because three things have to agree about it: the message that
 * asks him to decide, the dashboard list that says who still needs chasing,
 * and the "ready for the office" list that sends somebody across Windhoek.
 * When the dashboard worked this out for itself it disagreed with the approval
 * message within a day.
 *
 * Playbook section 5, "Waiving a document": every document is always asked of
 * the customer. What Lukas can do is approve an application anyway, and that
 * is recorded against the application as his — who waived what, and when.
 */

import type { Rules } from './playbook/index.ts';
import type { Store } from './store/index.ts';
import { buildQuestionPlan, liveQuestions } from './intake/questions.ts';

export interface Outstanding {
  /** Photos and documents still missing — what somebody has to chase. */
  documents: string[];
  /** Screening questions with no usable answer yet. */
  questions: string[];
  /** Of the above, the ones Lukas has already decided to approve around. */
  waived: string[];
}

/**
 * Everything still missing on an item, in the documents' own words.
 *
 * Recomputed from the item each time rather than read from a snapshot taken
 * at submission: a photo that arrived after he was asked to decide is no
 * longer missing, and reporting it as missing is how he loses trust in the
 * list.
 */
export function outstandingFor(store: Store, rules: Rules, itemId: string): Outstanding {
  const item = store.item(itemId);
  if (!item) return { documents: [], questions: [], waived: [] };

  const photos = store.photos(itemId).map((photo) => photo.kind);
  const answered = answersFor(store, item);
  const waived = new Set(store.waivedFor(itemId));

  const plan = buildQuestionPlan(rules, item.category_slug, item.variant);
  const missing = liveQuestions(plan, photos).filter((question) => !question.optional).filter((question) => {
    if (question.kind === 'photo') return !photos.includes(question.photoKind ?? 'item');
    if (!(question.id in answered)) return true;

    // An answer the agent gave up on is recorded so the conversation can move
    // past it, with `confirmed: false`. For a written answer that means it was
    // unusable — an item described as "yes" is as outstanding as one not
    // described at all.
    const answer = answered[question.id] as { confirmed?: boolean | null } | undefined;
    return question.kind === 'text' && answer?.confirmed === false;
  });

  const described = item.description.trim().length > 0;

  return {
    documents: missing
      .filter((question) => question.kind === 'photo' || question.id === 'item-description')
      .filter((question) => !(described && question.id === 'item-description'))
      .filter((question) => !waived.has(question.id))
      .map(label),
    questions: missing
      .filter((question) => question.kind !== 'photo' && question.id !== 'item-description')
      .filter((question) => !waived.has(question.id))
      .map(label),
    waived: missing.filter((question) => waived.has(question.id)).map(label),
  };
}

/** The ids of everything outstanding — what a waiver is recorded against. */
export function outstandingIds(store: Store, rules: Rules, itemId: string): string[] {
  const item = store.item(itemId);
  if (!item) return [];

  const photos = store.photos(itemId).map((photo) => photo.kind);
  const answered = answersFor(store, item);
  const described = item.description.trim().length > 0;

  return liveQuestions(buildQuestionPlan(rules, item.category_slug, item.variant), photos)
    .filter((question) => !question.optional)
    .filter((question) => {
      if (question.kind === 'photo') return !photos.includes(question.photoKind ?? 'item');
      if (question.id === 'item-description' && described) return false;
      if (!(question.id in answered)) return true;
      const answer = answered[question.id] as { confirmed?: boolean | null } | undefined;
      return question.kind === 'text' && answer?.confirmed === false;
    })
    .map((question) => question.id);
}

/** Nothing left for anyone to chase, counting a waiver as settled. */
export function isComplete(outstanding: Outstanding): boolean {
  return outstanding.documents.length === 0 && outstanding.questions.length === 0;
}

// --- internals -------------------------------------------------------------

/**
 * `items.declared_details` is only written when intake completes, so for an
 * application still in progress the live answers are in the conversation's own
 * state. Reading only the column reported ten unanswered questions for a
 * customer who had answered most of them.
 */
function answersFor(store: Store, item: { declared_details: string; conversation_id: string | null }): Record<string, unknown> {
  const declared = parseObject(item.declared_details);
  if (Object.keys(declared).length > 0) return declared;
  if (!item.conversation_id) return {};

  const conversation = store.conversationById(item.conversation_id);
  if (!conversation) return {};
  const state = parseObject(conversation.state) as { answers?: Record<string, unknown> };
  return state.answers ?? {};
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `police-declaration` reads better as "police declaration" on a screen. */
const DOCUMENT_LABELS: Record<string, string> = {
  item: 'photo of the item',
  box: 'photo of the box',
  id: 'copy of ID',
  ownership: 'proof of ownership',
  'police-declaration': 'police declaration',
};

function label(question: { kind: string; id: string; photoKind?: string; ask: string }): string {
  if (question.kind === 'photo') {
    const kind = question.photoKind ?? 'item';
    return DOCUMENT_LABELS[kind] ?? kind.replace(/-/g, ' ');
  }
  if (question.id === 'item-description') return 'a description';
  return question.ask
    .split('\n')[0]!
    .replace(/^Can you confirm:\s*/i, '')
    .replace(/\?\s*$/, '')
    .trim();
}

/**
 * Pairs requirement ids with how they read, for recording a waiver.
 *
 * The label is stored alongside the id so the record still makes sense after
 * the plan is reworded — "what did he wave through?" should be answerable
 * from the row, not by rebuilding a year-old question plan.
 */
export function describeRequirements(
  store: Store,
  rules: Rules,
  itemId: string,
  requirementIds: string[],
): { requirement: string; label: string }[] {
  const item = store.item(itemId);
  if (!item || requirementIds.length === 0) return [];

  const byId = new Map(
    buildQuestionPlan(rules, item.category_slug, item.variant).questions.map((question) => [question.id, question]),
  );

  return requirementIds.map((id) => {
    const question = byId.get(id);
    return { requirement: id, label: question ? label(question) : id };
  });
}

// --- the N$5,000 proof-of-purchase line (playbook section 5) ---------------

/**
 * Above the threshold a declaration stops being enough.
 *
 * The playbook: *"proof of purchase required above N$5,000 market value — the
 * original receipt, or a settlement letter where it was bought on credit."*
 * And, on the forms that count: *"a box with a matching serial is evidence of
 * possession, not of a debt being settled — which is the whole Spectra
 * lesson."*
 *
 * The threshold was parsed from the document and then consumed by nothing at
 * all, in three places, for weeks. A N$10,000 phone was asked for exactly the
 * same documents as a N$800 one. The rule written after losing money on a
 * financed S25 Ultra did nothing.
 *
 * **There is no automatic check here, and there cannot be one.** A photo of a
 * receipt and a photo of a handwritten declaration are both `ownership` and
 * nothing in this system can read either. So what this does is tell the people
 * who can look: the website visitor, before they travel in, and Lukas, with
 * the valuation in front of him. The same shape as every other check the
 * system cannot perform itself.
 */
export interface ProofOfPurchase {
  /** True when the item's value puts it over the line. */
  required: boolean;
  thresholdCents: number;
  /** The market value the decision was made on, when one is known. */
  marketValueCents: number | null;
  /** What to tell somebody, or null when the rule does not bite. */
  instruction: string | null;
}

/** The rule, given a market value. Null value means nobody has priced it yet. */
export function proofOfPurchaseFor(rules: Rules, marketValueCents: number | null): ProofOfPurchase {
  const thresholdCents = rules.playbook.proofOfPurchaseAboveCents;
  const required = marketValueCents !== null && marketValueCents > thresholdCents;

  return {
    required,
    thresholdCents,
    marketValueCents,
    instruction: required
      ? `Over ${money(thresholdCents)}, so the proof of ownership has to be the original receipt — or a ` +
        'settlement letter if it was bought on credit. A written declaration is not enough at this value, ' +
        'and neither is the box: a matching serial shows possession, not that a debt was settled.'
      : null,
  };
}

/** The same rule, read off whatever valuation the item already has. */
export function proofOfPurchaseForItem(store: Store, rules: Rules, itemId: string): ProofOfPurchase {
  const valuation = store.db
    .prepare('SELECT assessed_value_cents, estimates FROM valuations WHERE item_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(itemId) as { assessed_value_cents: number; estimates: string } | undefined;

  if (!valuation) return proofOfPurchaseFor(rules, null);

  // The threshold is on *market* value, not the assessed figure the loan is
  // sized from. Taking the lowest estimate, as section 3 does everywhere else.
  let market: number | null = null;
  try {
    const estimates = JSON.parse(valuation.estimates) as { amountCents?: number }[];
    const amounts = estimates.map((estimate) => estimate.amountCents ?? 0).filter((amount) => amount > 0);
    if (amounts.length > 0) market = Math.min(...amounts);
  } catch {
    market = null;
  }

  return proofOfPurchaseFor(rules, market);
}

function money(cents: number): string {
  return `N$${(cents / 100).toLocaleString('en-NA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
