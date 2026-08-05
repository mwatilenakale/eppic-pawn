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
        playbook.categories.find((category) => matchesLoosely(category, wanted)) ??
        null
      );
    },

    variantsFor(categorySlug: string): FraudCheckGroup[] {
      const groups = fraudChecks.get(categorySlug) ?? [];
      return groups.filter((group) => group.variant !== null);
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

/** Matches `iphone`, `phone`, `my phone` against `Phones (iPhone and Android)`. */
function matchesLoosely(category: Category, input: string): boolean {
  const haystack = `${category.slug} ${category.label}`.toLowerCase();
  const singular = category.slug.replace(/s$/, '');
  const words = input.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => {
    const stem = word.replace(/s$/, '');
    return stem.length >= 2 && (stem === singular || haystack.includes(stem));
  });
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
