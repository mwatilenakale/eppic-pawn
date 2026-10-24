/**
 * Reads `docs/playbook.md` — the single source of truth for every business
 * rule (root CLAUDE.md). Rates, terms, screening questions and collections
 * logic are parsed out of that document at runtime; nothing here restates a
 * number from it.
 *
 * When the document changes shape and a rule can no longer be found, the
 * loader throws. That is deliberate: a missing rate must stop the agent, not
 * silently become a default.
 */

import { readFileSync } from 'node:fs';
import {
  amountCents,
  bullets,
  days,
  labelledBlocks,
  percent,
  percents,
  plain,
  section,
  tableRows,
} from './markdown.ts';

/** Section numbers in playbook.md that this loader depends on. */
const SECTIONS = {
  categories: 2,
  loanSizing: 3,
  rates: 4,
  requirements: 5,
  screening: 6,
  collections: 8,
} as const;

/** Rate-table rows the rest of the system looks up by name. */
export const RATE_STANDARD = 'standard';
export const RATE_LARGE_LOAN = 'large-loan';
export const RATE_REFERRAL = 'referral';
export const RATE_FRIEND_CAPITAL = 'friend-capital';
export const RATE_FAVOR = 'favor';

export interface Category {
  /** Stable key used in code and storage, e.g. `phones`. */
  slug: string;
  /** Label as written in the playbook, e.g. `Phones (iPhone and Android)`. */
  label: string;
  /**
   * What a customer might actually type for this category, from the
   * `recognise:` list in section 2 — "Samsung Galaxy", "bakkie", "PS5".
   *
   * Empty is legal: a category with no list is matched on its own name only.
   */
  recognise: string[];
}

export interface RateRule {
  id: string;
  /** The scenario cell, verbatim. */
  scenario: string;
  /** Percentage for the full term; null when the playbook says "negotiated". */
  ratePct: number | null;
  termDays: number | null;
  /** Threshold read from the scenario cell, e.g. `Loan >= N$15,000`. */
  minAmountCents: number | null;
  /** Cap read from the split cell, e.g. the favour loan's `capped at N$500`. */
  capAmountCents: number | null;
  /** The split cell, verbatim. */
  split: string;
  referrerSharePct: number | null;
  ownerSharePct: number | null;
}

export interface ChecklistItem {
  /** Unique within its category, e.g. `phones-3`. */
  id: string;
  text: string;
  /** `playbook` (section 6) or `fraud` (architecture section 2.3). */
  source: 'playbook' | 'fraud';
  /** Set when the playbook marks the rule `[decide]` — proposed, not policy. */
  provisional: boolean;
}

export interface Playbook {
  path: string;
  /** The number customers are told to message, from the document's header. */
  whatsapp: string;
  /**
   * What a customer is told to call the person who decides — "the manager".
   *
   * Never the owner's name. He is named to himself, to staff and in the
   * records; customers read the role. From the document's header, so changing
   * the wording there changes every customer-facing message.
   */
  ownerLabel: string;
  categories: Category[];
  /** Which variant a brand implies, keyed by variant (section 2). */
  variantHints: Record<string, string[]>;
  loanSizing: {
    /** Which of the market estimates to start from, verbatim from section 3. */
    basis: string;
    discountFactor: number;
    divisor: number;
    /** Human-readable formula, for approval messages. */
    formula: string;
    /** How much more than the pawn loan an outright purchase pays, as a percentage. */
    buyNowMarkupPct: number;
    /** Below this the shop declines: the handling costs the same either way. */
    minimumLoanCents: number;
  };
  /** Days an override by Lukas is reused before it expires (section 3). */
  adjustmentMemoryDays: number;
  rates: RateRule[];
  grace: { defaultDays: number; flexibleUpToDays: number };
  partialPaymentCompounds: boolean;
  collections: {
    marginThresholdPct: number;
    /**
     * Section 8 step 3: what is owed, plus the next month's interest, must be
     * at or below this percentage of the item's current market value for an
     * extension to be allowed at all.
     */
    extensionCeilingPct: number;
    /**
     * Section 8 step 2: days before the due date a reminder goes out. One
     * message, that many days out.
     */
    reminderDaysBeforeDue: number;
    /**
     * Section 8 step 2: a final notice on the last day of grace — "pay today,
     * or from tomorrow the item is up for sale".
     *
     * On the last day rather than after it, because a warning the customer can
     * still act on is worth something and one they cannot is just bad news.
     */
    finalNoticeOnLastGraceDay: boolean;
    /**
     * Whether the system keeps chasing once grace has gone. False: by then the
     * customer has had a reminder and a final warning and there is nothing
     * left to tell them.
     */
    chaseAfterGrace: boolean;
  };
  /** Documents the customer brings in (section 5). */
  requirements: string[];
  /**
   * Things they must be able to confirm but do not hand over (section 5).
   * Kept apart from the documents because "bring this with you" and "this
   * must be true of your item" are different instructions.
   */
  declarations: string[];
  /**
   * Above this market value a signed declaration is not enough — the
   * original receipt or a settlement letter is required (section 5).
   */
  proofOfPurchaseAboveCents: number;
  /** Screening bullets per category slug (section 6). */
  screening: Map<string, ChecklistItem[]>;
}

export function loadPlaybook(path: string): Playbook {
  const markdown = readFileSync(path, 'utf8');
  const need = (n: number, what: string): string => {
    const body = section(markdown, n);
    if (!body) throw new PlaybookError(path, `section ${n} (${what}) not found`);
    return body;
  };

  const categories = readCategories(path, need(SECTIONS.categories, 'what we accept'));
  const screening = readScreening(need(SECTIONS.screening, 'item screening checklists'));

  for (const category of categories) {
    if (!screening.has(category.slug)) {
      throw new PlaybookError(path, `section ${SECTIONS.screening} has no checklist for ${category.label}`);
    }
  }

  return {
    path,
    whatsapp: readBusinessNumber(path, markdown),
    ownerLabel: readOwnerLabel(path, markdown),
    categories,
    variantHints: readVariantHints(need(SECTIONS.categories, 'what we accept')),
    loanSizing: readLoanSizing(path, need(SECTIONS.loanSizing, 'loan sizing')),
    adjustmentMemoryDays: readAdjustmentMemoryDays(path, need(SECTIONS.loanSizing, 'loan sizing')),
    rates: readRates(path, need(SECTIONS.rates, 'interest rates & terms')),
    ...readGraceAndPartials(path, need(SECTIONS.rates, 'interest rates & terms')),
    collections: readCollections(path, need(SECTIONS.collections, 'default & collections')),
    ...readRequirements(path, need(SECTIONS.requirements, 'requirements')),
    screening,
  };
}

/**
 * How customers are told to refer to whoever decides.
 *
 * Parsed rather than hard-coded for the same reason as the phone number: the
 * shop's own words about itself belong in the shop's own document, and a copy
 * of them in thirty string literals goes stale silently.
 */
function readOwnerLabel(path: string, markdown: string): string {
  const match = /Customers are told\s*\*{0,2}"([^"]{2,40})"/i.exec(markdown);
  if (!match) {
    throw new PlaybookError(
      path,
      'the header does not say what customers call the decision-maker (expected a line like: Customers are told "the manager", never a name)',
    );
  }
  return match[1]!.trim();
}

/**
 * The number on the contract, on the website and on the flyer. It lives in the
 * playbook's header line ("Windhoek. WhatsApp: 081-282-3046.") rather than in
 * code, because changing the shop's number should mean editing one document —
 * not hunting through pages, agreements and links for a copy that went stale.
 */
function readBusinessNumber(path: string, markdown: string): string {
  // Mid-sentence in the header: "Windhoek. WhatsApp: 081-282-3046. Run solo…"
  const match = /WhatsApp:\s*(\+?[\d\s()-]{7,})/i.exec(markdown);
  if (!match) {
    throw new PlaybookError(path, 'the header does not give the business WhatsApp number (expected a line like "WhatsApp: 081-282-3046")');
  }
  return match[1]!.trim().replace(/[.,]$/, '');
}

/** Everything up to the first `###` heading — the rules, without the commentary. */
function untilSubsection(block: string): string {
  const heading = /^###\s/m.exec(block);
  return heading ? block.slice(0, heading.index) : block;
}

/**
 * Section 5 holds three different kinds of thing, and the document says which
 * is which: documents to bring, statements to confirm, and the policy line.
 * Mixing them put "proof of purchase required above N$5,000" on the website
 * under "bring with you", which is neither true nor useful.
 */
function readRequirements(
  path: string,
  block: string,
): Pick<Playbook, 'requirements' | 'declarations' | 'proofOfPurchaseAboveCents'> {
  const [documentPart = '', confirmPart = ''] = block.split(/^.*must also be able to confirm.*$/im, 2);

  // Both lists stop at the first `###` subsection.
  //
  // Everything under one is commentary — why the rule is what it is, what
  // Lukas may waive, a worked example — and it is written as prose with
  // bullets like anything else. Without this cut, an explanatory bullet
  // becomes a rule: two lines explaining the waiver policy were asked of real
  // customers as "Can you confirm: Lukas's end: he can approve around it?".
  const requirements = bullets(untilSubsection(documentPart)).map(plain);
  if (requirements.length === 0) {
    throw new PlaybookError(path, `section ${SECTIONS.requirements} lists no documents to bring`);
  }

  return {
    requirements,
    declarations: bullets(untilSubsection(confirmPart)).map(plain),
    proofOfPurchaseAboveCents: readProofThreshold(path, block),
  };
}

/**
 * Where a declaration stops being enough. Below it the loss is bounded and
 * the friction is not worth it; above it the shop wants the actual receipt.
 */
function readProofThreshold(path: string, block: string): number {
  const match = /proof of purchase required above\s*N\$\s?([\d,]+(?:\.\d+)?)/i.exec(plain(block));
  if (!match) {
    throw new PlaybookError(path, `section ${SECTIONS.requirements} does not say above what value proof of purchase is required`);
  }
  return Math.round(Number(match[1]!.replace(/,/g, '')) * 100);
}

export class PlaybookError extends Error {
  constructor(path: string, detail: string) {
    super(`Cannot read business rules from ${path}: ${detail}. Fix the document — rules are never defaulted in code.`);
    this.name = 'PlaybookError';
  }
}

/** `Phones (iPhone and Android)` -> `phones`. */
export function slugify(label: string): string {
  return plain(label)
    .replace(/\(.*?\)/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * `Variant hints — android: Samsung Galaxy, Nokia, …` from section 2.
 *
 * Which kind of phone a brand implies, so the agent does not ask the owner of
 * a Nokia whether it is an iPhone. Keyed by variant, because the variant names
 * are unique across categories and this stays correct if another category
 * ever gains variants.
 */
function readVariantHints(block: string): Record<string, string[]> {
  const hints: Record<string, string[]> = {};
  for (const line of bullets(block).map(plain)) {
    const match = /^variant hints?\s*[—-]\s*([a-z0-9-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    hints[match[1]!.toLowerCase()] = match[2]!
      .split(',')
      .map((term) => term.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean);
  }
  return hints;
}

function readCategories(path: string, block: string): Category[] {
  const categories = bullets(block)
    .map(plain)
    .filter((line) => !/^storage\b/i.test(line))
    .filter((line) => !/^variant hints?\b/i.test(line))
    .map((line) => {
      // `Phones (iPhone and Android) — recognise: Samsung Galaxy, Nokia, …`
      const split = /^(.*?)\s+[—-]\s*recognise:\s*(.*)$/is.exec(line);
      const label = (split ? split[1]! : line).trim();
      const recognise = split
        ? split[2]!
            .split(',')
            .map((term) => term.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
        : [];
      return { slug: slugify(label), label, recognise };
    });

  if (categories.length === 0) {
    throw new PlaybookError(path, `section ${SECTIONS.categories} lists no accepted categories`);
  }
  return categories;
}

function readLoanSizing(path: string, block: string): Playbook['loanSizing'] {
  const steps = block.split('\n').map(plain);
  const find = (pattern: RegExp): number | null => {
    for (const step of steps) {
      const match = pattern.exec(step);
      // Thousands separators are normal in the document: N$1,000.
      if (match) return Number(match[1]!.replace(/,/g, ''));
    }
    return null;
  };

  const discountFactor = find(/multiply by\s+(\d+(?:\.\d+)?)/i);
  const divisor = find(/divide (?:that )?by\s+(\d+(?:\.\d+)?)/i);
  const buyNowMarkupPct = find(/buy-now price:\s*the pawn loan plus\s+(\d+(?:\.\d+)?)\s*%/i);
  const minimumLoan = find(/minimum loan:\s*N\$\s?([\d,]+(?:\.\d+)?)/i);
  const basisLine = steps.find((step) => /take the\s+\*?\*?(lowest|highest|average)/i.test(step));
  const basis = /lowest/i.test(basisLine ?? '') ? 'lowest' : /highest/i.test(basisLine ?? '') ? 'highest' : 'average';

  if (discountFactor === null || divisor === null || !basisLine) {
    throw new PlaybookError(path, `section ${SECTIONS.loanSizing} does not state the loan-sizing formula`);
  }
  if (buyNowMarkupPct === null) {
    throw new PlaybookError(path, `section ${SECTIONS.loanSizing} does not state the buy-now price`);
  }
  if (minimumLoan === null) {
    throw new PlaybookError(path, `section ${SECTIONS.loanSizing} does not state the minimum loan`);
  }

  return {
    basis,
    discountFactor,
    divisor,
    buyNowMarkupPct,
    minimumLoanCents: Math.round(minimumLoan * 100),
    formula: `${basis} market estimate x ${discountFactor} / ${divisor}`,
  };
}

/**
 * How long Lukas's override outlives the item it was made for. His correction
 * beats the estimate; a fortnight later it is just an old price.
 */
function readAdjustmentMemoryDays(path: string, block: string): number {
  const line = block.split('\n').map(plain).find((step) => /remember|reuse/i.test(step) && /\bdays?\b/i.test(step));
  const match = line ? /(\d+)\s*days?/i.exec(line) : null;
  if (!match) {
    throw new PlaybookError(path, `section ${SECTIONS.loanSizing} does not say how long an adjusted price is reused`);
  }
  return Number(match[1]);
}

function readRates(path: string, block: string): RateRule[] {
  const rows = tableRows(block);
  if (rows.length === 0) throw new PlaybookError(path, `section ${SECTIONS.rates} has no rate table`);

  const rates = rows.map((cells) => {
    const [scenario = '', rate = '', term = '', split = ''] = cells.map(plain);
    const shares = percents(split);
    return {
      id: classifyRate(scenario),
      scenario,
      ratePct: percent(rate),
      termDays: days(term),
      minAmountCents: /(>=|≥|\b(?:over|above|from|at least)\b)/i.test(scenario) ? amountCents(scenario) : null,
      capAmountCents: /capp?ed/i.test(split) ? amountCents(split) : null,
      split,
      referrerSharePct: /referrer/i.test(split) ? (shares[0] ?? null) : null,
      ownerSharePct: /referrer/i.test(split) ? (shares[1] ?? null) : (shares[0] ?? null),
    } satisfies RateRule;
  });

  const standard = rates.find((rule) => rule.id === RATE_STANDARD);
  if (!standard || standard.ratePct === null || standard.termDays === null) {
    throw new PlaybookError(path, `section ${SECTIONS.rates} has no usable standard rate row`);
  }
  return rates;
}

/** Maps a rate-table scenario cell onto the id the rest of the code uses. */
function classifyRate(scenario: string): string {
  if (/referral/i.test(scenario)) return RATE_REFERRAL;
  if (/friend[- ]capital/i.test(scenario)) return RATE_FRIEND_CAPITAL;
  if (/favou?r/i.test(scenario)) return RATE_FAVOR;
  if (/loan/i.test(scenario) && /N\$/.test(scenario)) return RATE_LARGE_LOAN;
  if (/standard/i.test(scenario)) return RATE_STANDARD;
  return slugify(scenario);
}

function readGraceAndPartials(
  path: string,
  block: string,
): Pick<Playbook, 'grace' | 'partialPaymentCompounds'> {
  const lines = bullets(block).map(plain);
  const graceLine = lines.find((line) => /grace period/i.test(line));
  const defaultDays = graceLine ? days(graceLine) : null;
  if (defaultDays === null) {
    throw new PlaybookError(path, `section ${SECTIONS.rates} does not state the grace period`);
  }

  // "flexible up to about a week on request"
  const extension = /about\s+a\s+week/i.test(graceLine!) ? 7 : (days(graceLine!.split(',').slice(1).join(',')) ?? defaultDays);
  const partialLine = lines.find((line) => /partial payment/i.test(line)) ?? '';

  return {
    grace: { defaultDays, flexibleUpToDays: Math.max(defaultDays, extension) },
    partialPaymentCompounds: /compound/i.test(partialLine) || /folds into principal/i.test(partialLine),
  };
}

function readCollections(path: string, block: string): Playbook['collections'] {
  const marginLine = block.split('\n').map(plain).find((line) => /margin/i.test(line) && /%/.test(line));
  const marginThresholdPct = marginLine ? percent(marginLine) : null;
  if (marginThresholdPct === null) {
    throw new PlaybookError(path, `section ${SECTIONS.collections} does not state the margin threshold`);
  }
  // Section 8 step 3, the 70% line. Deliberately a separate read from the
  // margin threshold: the two tests measure against different bases and can
  // disagree, and the document says so.
  const ceilingLine = block
    .split('\n')
    .map(plain)
    .find((line) => /at or below/i.test(line) && /%/.test(line) && /market value/i.test(line));
  const extensionCeilingPct = ceilingLine ? percent(ceilingLine) : null;
  if (extensionCeilingPct === null) {
    throw new PlaybookError(
      path,
      `section ${SECTIONS.collections} does not state the extension ceiling (expected a line like "at or below 70% of current market value")`,
    );
  }

  // Section 8 step 2, the outreach cadence. Lukas's decision, 25 October
  // 2026; before that the document said "direct outreach" and never said when,
  // which is a rule nobody should be inventing in a transport.
  const reminderLine = block
    .split('\n')
    .map(plain)
    .find((line) => /reminder before the due date/i.test(line));
  const reminderDaysBeforeDue = reminderLine ? dayCount(reminderLine) : null;
  if (reminderDaysBeforeDue === null) {
    throw new PlaybookError(
      path,
      `section ${SECTIONS.collections} does not say how many days before the due date a reminder goes out`,
    );
  }

  // The final warning, and the absence of chasing after it. Both read rather
  // than assumed: "nothing after grace" is a decision, and somebody who later
  // thinks more chasing is better should have to edit the document to get it.
  const lines = block.split('\n').map(plain);
  const finalNotice = lines.find((line) => /final notice/i.test(line) && /grace/i.test(line));
  const afterGrace = lines.find((line) => /after grace runs out/i.test(line));

  if (!finalNotice) {
    throw new PlaybookError(
      path,
      `section ${SECTIONS.collections} does not say when the final notice goes out (expected a line like "Final notice on the last day of grace")`,
    );
  }
  if (!afterGrace) {
    throw new PlaybookError(path, `section ${SECTIONS.collections} does not say what happens after grace runs out`);
  }

  return {
    marginThresholdPct,
    extensionCeilingPct,
    reminderDaysBeforeDue,
    finalNoticeOnLastGraceDay: /last day of grace/i.test(finalNotice),
    chaseAfterGrace: !/nothing after/i.test(afterGrace),
  };
}

/** `Reminder before the due date: 3 days.` -> 3 */
function dayCount(line: string): number | null {
  const match = /(\d+)\s*days?/i.exec(line);
  return match ? Number(match[1]) : null;
}

function readScreening(block: string): Map<string, ChecklistItem[]> {
  const screening = new Map<string, ChecklistItem[]>();

  // Section 6 introduces each category with a bold heading on its own line;
  // bullets underneath belong to it, even when a bullet itself starts bold
  // (e.g. the consoles `**[decide, draft proposed]**` item).
  for (const { label, body } of labelledBlocks(block, { inlineBullets: false })) {
    const slug = slugify(label);
    const items = bullets(body).map(plain).map((text, index) => ({
      id: `${slug}-${index + 1}`,
      text,
      source: 'playbook' as const,
      provisional: /\[decide/i.test(text),
    }));
    if (items.length > 0) screening.set(slug, items);
  }

  return screening;
}
