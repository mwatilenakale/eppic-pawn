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

const liveRules = new Map<string, Rules>();

/**
 * A live view for long-lived services. loadRules() remains a fixed snapshot
 * for callers that need one. Do not pass a snapshot into a running server:
 * replacing the cache alone cannot update a service holding the old object.
 */
export function getRules(paths: RulesPaths = defaultRulesPaths()): Rules {
  const watched = { ...paths };
  const key = JSON.stringify(watched);
  const existing = liveRules.get(key);
  if (existing) return existing;

  let snapshot: Rules;
  let stamps = '';
  const current = (): Rules => {
    const next = [watched.playbook, watched.architecture].map((path) => {
      const stat = statSync(path);
      return `${path}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    }).join('|');
    if (next !== stamps) {
      // Assign only after successful parsing. A malformed edit throws on every
      // access until repaired; it never silently falls back to the old rules.
      snapshot = loadRules(watched);
      stamps = next;
    }
    return snapshot;
  };

  const view = new Proxy(current(), {
    get(_target, property) {
      const value = Reflect.get(current(), property);
      // Even a retained method (const lookup = rules.rate) must stay current;
      // the original functions close over the playbook that created them.
      return typeof value === 'function'
        ? (...args: unknown[]) => Reflect.apply(Reflect.get(current(), property), current(), args)
        : value;
    },
  });
  liveRules.set(key, view);
  return view;
}
