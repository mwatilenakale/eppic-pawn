/**
 * Market-estimate lookup for the valuation engine (architecture 2.2, phase 1).
 *
 * Filled in by the Claude-backed valuator; with no API key configured this
 * returns null and the approval message asks Lukas for the amount instead.
 */

import type { Rules } from '../playbook/index.ts';
import type { Valuator } from '../router.ts';

export function createValuator(apiKey: string | null, _rules: Rules): Valuator | null {
  if (!apiKey) return null;
  return null;
}
