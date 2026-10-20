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
  categories: Category[];
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
  collections: { marginThresholdPct: number };
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
    categories,
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

  const requirements = bullets(documentPart).map(plain);
  if (requirements.length === 0) {
    throw new PlaybookError(path, `section ${SECTIONS.requirements} lists no documents to bring`);
  }

  return {
    requirements,
    declarations: bullets(confirmPart).map(plain),
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

function readCategories(path: string, block: string): Category[] {
  const categories = bullets(block)
    .map(plain)
    .filter((line) => !/^storage\b/i.test(line))
    .map((label) => ({ slug: slugify(label), label }));

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
  return { marginThresholdPct };
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
