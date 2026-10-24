/**
 * Adjusting the figures. All four of them, not just the loan.
 *
 * The four numbers on a quote are a chain, and the playbook is what links
 * them: market value → x0.75 → assessed → ÷2 → loan → +25% → buy-now. So
 * correcting the top of the chain should carry down it. If Lukas says the
 * market has this phone at N$8,000 rather than N$10,440, he means the whole
 * quote was built on a wrong number, not that he wants to retype three more.
 *
 * What he types explicitly always wins over what would be derived. Setting the
 * loan directly is an override of the formula, not an input to it, and it stays
 * exactly where he put it.
 */

import { percentOf, round } from '../money.ts';
import type { Rules } from '../playbook/index.ts';

export type Figure = 'market' | 'assessed' | 'loan' | 'buy';

export interface Figures {
  marketValueCents: number | null;
  assessedValueCents: number | null;
  loanCents: number;
  buyNowCents: number;
}

/** What Lukas asked to change; anything absent is left to the playbook. */
export type FigureEdits = Partial<Record<Figure, number>>;

/**
 * Applies the edits and rebuilds whatever follows from them.
 *
 * Order matters and mirrors the playbook: each figure is taken from the edit
 * if given, otherwise derived from the one above it, otherwise left as it was.
 */
export function applyAdjustment(current: Figures, edits: FigureEdits, rules: Rules): Figures {
  const { discountFactor, divisor, buyNowMarkupPct } = rules.playbook.loanSizing;

  const marketValueCents = edits.market ?? current.marketValueCents;

  const assessedValueCents =
    edits.assessed ??
    // Recomputed only when the market value it derives from actually moved.
    (edits.market !== undefined && marketValueCents !== null
      ? round(marketValueCents * discountFactor)
      : current.assessedValueCents);

  const loanCents =
    edits.loan ??
    (assessedValueCents !== null && assessedValueCents !== current.assessedValueCents
      ? round(assessedValueCents / divisor)
      : current.loanCents);

  const buyNowCents =
    edits.buy ?? (loanCents !== current.loanCents ? loanCents + percentOf(loanCents, buyNowMarkupPct) : current.buyNowCents);

  return { marketValueCents, assessedValueCents, loanCents, buyNowCents };
}

const FIGURE_WORDS: [RegExp, Figure][] = [
  [/^(market|market\s*value|value)$/i, 'market'],
  [/^(assessed|assessed\s*value|assess)$/i, 'assessed'],
  [/^(loan|pawn|principal)$/i, 'loan'],
  [/^(buy|buynow|buy\s*now|purchase|outright)$/i, 'buy'],
];

export function figureFor(word: string): Figure | null {
  const cleaned = word.trim().toLowerCase();
  return FIGURE_WORDS.find(([pattern]) => pattern.test(cleaned))?.[1] ?? null;
}

/** `market 8000 loan 3000` — and a bare amount means the loan. */
export function parseFigureEdits(text: string, parseAmount: (input: string) => number | null): FigureEdits {
  const edits: FigureEdits = {};
  const tokens = text.trim().split(/\s+/).filter(Boolean);

  let field: Figure | null = null;
  for (const token of tokens) {
    const named = figureFor(token.replace(/[:,]$/, ''));
    if (named) {
      field = named;
      continue;
    }
    const amount = parseAmount(token);
    if (amount === null) continue;
    // A number with no field in front of it is the loan — the figure he
    // changes most, and the one APPROVE already treats that way.
    edits[field ?? 'loan'] = amount;
    field = null;
  }

  return edits;
}

export function describeFigures(figures: Figures, format: (cents: number) => string): string {
  const lines = [
    figures.marketValueCents !== null ? `Market value: ${format(figures.marketValueCents)}` : null,
    figures.assessedValueCents !== null ? `Assessed value: ${format(figures.assessedValueCents)}` : null,
    `Pawn loan: *${format(figures.loanCents)}*`,
    `Buy outright: *${format(figures.buyNowCents)}*`,
  ];
  return lines.filter(Boolean).join('\n');
}
