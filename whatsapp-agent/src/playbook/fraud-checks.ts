/**
 * Reads the per-category fraud & condition checklists from
 * `docs/architecture.md` section 2.3. These are enforced inside the intake
 * flow alongside the playbook's own screening questions — architecture
 * section 5 step 2 folds them into step 1 rather than a later phase.
 */

import { readFileSync } from 'node:fs';
import { labelledBlocks, plain, subsection } from './markdown.ts';
import { PlaybookError, slugify, type ChecklistItem } from './playbook.ts';

const FRAUD_SECTION = '2.3';

/**
 * Synonyms between the architecture doc's labels and the playbook's category
 * names. Only naming differences live here — no screening content.
 */
const LABEL_SYNONYMS: Record<string, { root: string; variant: string | null }> = {
  iphone: { root: 'phone', variant: 'iphone' },
  android: { root: 'phone', variant: 'android' },
  vehicle: { root: 'car', variant: null },
};

export interface FraudCheckGroup {
  /** Label as written in the architecture doc, e.g. `iPhone`. */
  label: string;
  categorySlug: string;
  /** Set when a category has several device flavours, e.g. `iphone`. */
  variant: string | null;
  checks: ChecklistItem[];
}

/** Fraud-check groups keyed by playbook category slug. */
export function loadFraudChecks(path: string, categorySlugs: string[]): Map<string, FraudCheckGroup[]> {
  const markdown = readFileSync(path, 'utf8');
  const block = subsection(markdown, FRAUD_SECTION);
  if (!block) throw new PlaybookError(path, `section ${FRAUD_SECTION} (fraud & condition checklists) not found`);

  const groups = new Map<string, FraudCheckGroup[]>();

  for (const { label, body } of labelledBlocks(block)) {
    const { root, variant } = LABEL_SYNONYMS[slugify(label)] ?? { root: slugify(label), variant: null };
    const categorySlug = categorySlugs.find((slug) => slug === root || slug === `${root}s` || slug.startsWith(root));
    if (!categorySlug) continue; // a category the playbook doesn't accept

    const idPrefix = variant ?? categorySlug;
    const checks = splitChecks(body).map((text, index) => ({
      id: `fraud-${idPrefix}-${index + 1}`,
      text,
      source: 'fraud' as const,
      provisional: false,
    }));
    if (checks.length === 0) continue;

    const existing = groups.get(categorySlug) ?? [];
    existing.push({ label, categorySlug, variant, checks });
    groups.set(categorySlug, existing);
  }

  if (groups.size === 0) throw new PlaybookError(path, `section ${FRAUD_SECTION} yielded no checklists`);
  return groups;
}

/**
 * Each category is written as one long bullet with checks separated by
 * semicolons; the trailing "watch for ..." clause is kept as its own check so
 * it shows up in the inspection record.
 */
function splitChecks(body: string): string[] {
  return plain(body.replace(/\n\s*/g, ' '))
    .split(';')
    .map((part) => part.trim().replace(/\.$/, ''))
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
}
