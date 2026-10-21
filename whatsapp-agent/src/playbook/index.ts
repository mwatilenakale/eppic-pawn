/**
 * The rule set the agent runs on: `docs/playbook.md` plus the fraud checklists
 * in `docs/architecture.md` section 2.3.
 *
 * `getRules()` re-reads the documents when they change on disk, so editing the
 * playbook is enough to change how the agent behaves — no code edit, no
 * redeploy. That is the point of the structure (README, "Keeping this
 * current").
 */

import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFraudChecks, type FraudCheckGroup } from './fraud-checks.ts';
import {
  loadPlaybook,
  type Category,
  type ChecklistItem,
  type Playbook,
  type RateRule,
} from './playbook.ts';

export * from './playbook.ts';
export type { FraudCheckGroup } from './fraud-checks.ts';

export interface RulesPaths {
  playbook: string;
  architecture: string;
}

export interface Rules {
  paths: RulesPaths;
  playbook: Playbook;
  categories: Category[];
  /** Accepted category by slug, or by a label the customer might type. */
  category(input: string): Category | null;
  /** Device flavours for a category, e.g. iPhone / Android for phones. */
  variantsFor(categorySlug: string): FraudCheckGroup[];
  /**
   * The variant a message already implies, from the hints in playbook
   * section 2 — "Nokia 3310" is an Android and does not need asking.
   * Null when the brand genuinely does not settle it.
   */
  variantFrom(categorySlug: string, text: string): string | null;
  /** Playbook screening questions plus fraud checks, in that order. */
  checklistFor(categorySlug: string, variant?: string | null): ChecklistItem[];
  rate(id: string): RateRule | null;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function defaultRulesPaths(): RulesPaths {
  return {
    playbook: process.env['EPPIC_PLAYBOOK_PATH'] ?? resolve(projectRoot, 'docs/playbook.md'),
    architecture: process.env['EPPIC_ARCHITECTURE_PATH'] ?? resolve(projectRoot, 'docs/architecture.md'),
  };
}

export function loadRules(paths: RulesPaths = defaultRulesPaths()): Rules {
  const playbook = loadPlaybook(paths.playbook);
  const slugs = playbook.categories.map((category) => category.slug);
  const fraudChecks = loadFraudChecks(paths.architecture, slugs);

  return {
    paths,
    playbook,
    categories: playbook.categories,

    category(input: string): Category | null {
      const wanted = input.trim().toLowerCase();
      if (!wanted) return null;
      return (
        playbook.categories.find((category) => category.slug === wanted) ??
        playbook.categories.find((category) => category.label.toLowerCase() === wanted) ??
        matchCategory(playbook.categories, wanted)
      );
    },

    variantsFor(categorySlug: string): FraudCheckGroup[] {
      const groups = fraudChecks.get(categorySlug) ?? [];
      return groups.filter((group) => group.variant !== null);
    },

    variantFrom(categorySlug: string, text: string): string | null {
      const available = (fraudChecks.get(categorySlug) ?? [])
        .map((group) => group.variant)
        .filter((variant): variant is string => variant !== null);

      // Longest term first, so "Samsung Galaxy" is considered before "Galaxy"
      // and a two-word brand cannot lose to a one-word one.
      const candidates = Object.entries(playbook.variantHints)
        .filter(([variant]) => available.includes(variant))
        .flatMap(([variant, terms]) => terms.map((term) => ({ variant, term })))
        .sort((a, b) => b.term.length - a.term.length);

      return candidates.find(({ term }) => mentions(text, term))?.variant ?? null;
    },

    checklistFor(categorySlug: string, variant?: string | null): ChecklistItem[] {
      const screening = playbook.screening.get(categorySlug) ?? [];
      const groups = fraudChecks.get(categorySlug) ?? [];
      const relevant = groups.filter((group) => group.variant === null || !variant || group.variant === variant);
      return [...screening, ...relevant.flatMap((group) => group.checks)];
    },

    rate(id: string): RateRule | null {
      return playbook.rates.find((rule) => rule.id === id) ?? null;
    },
  };
}

/**
 * Noise words that must never identify a category.
 *
 * This list is the fix for a real and expensive bug. The matcher used to test
 * whether any word of two letters or more appeared *as a substring* of the
 * category's name, which meant:
 *
 *   "I have an Apple Watch"        → "an" is inside "iPhone and Android" → phones
 *   "PlayStation 5 ... and FIFA"   → "and"                               → phones
 *   "let me talk to a real person" → "to" is inside "laptops"            → laptops
 *
 * while "Samsung Galaxy S25 Ultra" and "Nokia 3310" matched nothing at all and
 * were told "we don't take that". Matching is whole-word now, so most of these
 * cannot recur, but the stop list keeps the short connecting words out of the
 * terms derived from a category's own label.
 */
const NOISE = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'with', 'in', 'on', 'to', 'for', 'my',
  'is', 'it', 'at', 'be', 'by', 'as', 'we', 'me', 'do', 'if', 'so', 'up',
]);

/**
 * Everything that identifies this category: its slug, its singular, the words
 * of its label, and the `recognise:` list from the playbook.
 *
 * Longest first, so the most specific term decides. "Samsung TV" beats "TV",
 * and a message naming both a brand and a product type lands on the type.
 */
function termsFor(category: Category): string[] {
  const singular = category.slug.replace(/s$/, '');
  const fromLabel = category.label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !NOISE.has(word));

  const terms = new Set<string>([
    category.slug.replace(/-/g, ' '),
    singular.replace(/-/g, ' '),
    ...fromLabel,
    ...category.recognise.map((term) => term.toLowerCase()),
  ]);

  return [...terms].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** True when `term` appears in `text` as a whole word (or whole phrase). */
function mentions(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  // Plural tolerated on the term: "laptop" matches "laptops", "PS5" matches "PS5s".
  return new RegExp(`(?<![a-z0-9])${escaped}s?(?![a-z0-9])`, 'i').test(text);
}

/**
 * Which category this message is about, by the most specific term that
 * appears in it. Null means "we could not tell" — which is a question for
 * Lukas (playbook section 2, "Something else"), never a refusal.
 */
function matchCategory(categories: Category[], input: string): Category | null {
  let best: { category: Category; length: number } | null = null;

  for (const category of categories) {
    for (const term of termsFor(category)) {
      if (!mentions(input, term)) continue;
      if (!best || term.length > best.length) best = { category, length: term.length };
      break; // terms are longest-first, so the first hit is this category's best
    }
  }

  return best?.category ?? null;
}

let cached: { rules: Rules; paths: RulesPaths; stamps: string } | null = null;

/** Cached rules, reloaded automatically when either document changes. */
export function getRules(paths: RulesPaths = defaultRulesPaths()): Rules {
  const stamps = [paths.playbook, paths.architecture]
    .map((path) => {
      const stat = statSync(path);
      return `${path}:${stat.mtimeMs}:${stat.size}`;
    })
    .join('|');

  if (cached && cached.stamps === stamps && cached.paths.playbook === paths.playbook) {
    return cached.rules;
  }
  const rules = loadRules(paths);
  cached = { rules, paths, stamps };
  return rules;
}
