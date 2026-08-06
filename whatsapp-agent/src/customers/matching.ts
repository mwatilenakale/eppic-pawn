/**
 * Deciding whether two customer records might be the same person
 * (architecture 2.6).
 *
 * Two rules shape everything here:
 *
 *   - **Never match on name alone.** People share names, and the migration
 *     earlier this year showed the same person recorded several ways. A name
 *     that looks similar is a reason to *ask*, never a reason to merge.
 *   - **Two different ID numbers mean two different people.** That is the one
 *     signal strong enough to rule a match out outright, and it is checked
 *     before anything else.
 *
 * Nothing in this file merges anything. It produces a score and the reasons
 * behind it; the decision is Lukas's (architecture 2.6, "a 'possible duplicate'
 * flag rather than silent merging").
 */

/** At or above this, the pair is put in front of Lukas. */
export const FLAG_THRESHOLD = 0.6;

/** Titles carry no identifying information. */
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'rev', 'sir', 'mnr', 'mev']);

export interface MatchResult {
  score: number;
  reasons: string[];
  /** True when a signal rules the pair out regardless of everything else. */
  ruledOut: boolean;
}

export interface CustomerIdentity {
  name?: string | null;
  idNumber?: string | null;
  phone?: string | null;
}

/** Lowercase, unaccented, punctuation-free words. */
export function normalizeName(name: string | null | undefined): string[] {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !TITLES.has(word));
}

/** Namibian ID numbers get written with spaces and dashes; those don't matter. */
export function normalizeIdNumber(idNumber: string | null | undefined): string {
  return (idNumber ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

/**
 * How alike two names are, 0 to 1.
 *
 * Word order is ignored — records from the workbook have surnames both first
 * and last — and an initial counts as a half-match for the name it stands for.
 */
export function nameSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (a.length === 0 || b.length === 0) return 0;

  const unmatched = [...b];
  let matched = 0;

  for (const word of a) {
    let bestIndex = -1;
    let bestWeight = 0;

    for (const [index, candidate] of unmatched.entries()) {
      const weight = wordWeight(word, candidate);
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0) {
      matched += bestWeight;
      unmatched.splice(bestIndex, 1);
    }
  }

  return matched / Math.max(a.length, b.length);
}

/** 1 for the same word, 0.5 for an initial standing in for it, 0 otherwise. */
function wordWeight(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length === 1 || right.length === 1) return left[0] === right[0] ? 0.5 : 0;

  const distance = editDistance(left, right);
  const ratio = 1 - distance / Math.max(left.length, right.length);
  // One typo in a short name is still the same name; two is a different name.
  return ratio >= 0.8 ? ratio : 0;
}

/** Levenshtein distance, iterative and allocation-light. */
export function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    previous = current;
  }

  return previous[right.length]!;
}

/**
 * Scores two customer records against each other.
 *
 * The scale is deliberately coarse — it decides whether to ask Lukas, not
 * whether two records are the same person.
 */
export function matchCustomers(left: CustomerIdentity, right: CustomerIdentity): MatchResult {
  const reasons: string[] = [];

  const leftId = normalizeIdNumber(left.idNumber);
  const rightId = normalizeIdNumber(right.idNumber);

  if (leftId && rightId) {
    if (leftId === rightId) {
      return { score: 1, reasons: ['same ID number'], ruledOut: false };
    }
    return { score: 0, reasons: ['different ID numbers'], ruledOut: true };
  }

  const similarity = nameSimilarity(left.name, right.name);
  let score = 0;

  if (similarity >= 0.85) {
    score = 0.7;
    reasons.push(`nearly the same name (${describe(left.name)} / ${describe(right.name)})`);
  } else if (similarity >= 0.7) {
    score = 0.5;
    reasons.push(`similar name (${describe(left.name)} / ${describe(right.name)})`);
  }

  // One ID number known and the other not is neutral on its own, but it means
  // the missing one is worth capturing — say so where it helps Lukas decide.
  if (score > 0 && Boolean(leftId) !== Boolean(rightId)) {
    reasons.push('only one record has an ID number');
  }

  return { score, reasons, ruledOut: false };
}

function describe(name: string | null | undefined): string {
  return (name ?? '').trim() || 'no name';
}

export function shouldFlag(result: MatchResult): boolean {
  return !result.ruledOut && result.score >= FLAG_THRESHOLD;
}
