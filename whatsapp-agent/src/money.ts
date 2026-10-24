/**
 * Money is Namibian dollars held as integer cents everywhere in this system.
 * Nothing stores a floating-point amount: a rounding drift of a cent in a
 * ledger is a defect, not a rounding detail.
 */

export const CENTS = 100;

/**
 * N$1,087.50 -> 108750. Rejects anything that isn't a plain amount.
 *
 * A space is only treated as a thousands separator when it actually separates
 * groups of three ("3 750"), so two numbers side by side ("1234 20000") are
 * rejected rather than silently glued into one enormous amount.
 */
export function parseAmount(text: string): number | null {
  const cleaned = text
    .replace(/n\$|nad|\bn\s?\$/gi, '')
    .replace(/(?<=\d)[\s,](?=\d{3}(\D|$))/g, '')
    .trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = round(Number(cleaned) * CENTS);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** 108750 -> `N$1,087.50`. */
export function formatAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const units = Math.trunc(absolute / CENTS).toLocaleString('en-US');
  const fraction = String(absolute % CENTS).padStart(2, '0');
  return `${sign}N$${units}.${fraction}`;
}

/** Percentage of an amount, rounded half-up away from zero. */
export function percentOf(cents: number, percent: number): number {
  return round((cents * percent) / 100);
}

/** Half-up away from zero, so -0.5 rounds to -1 rather than 0. */
export function round(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Ratio of `part` to `whole` as a percentage, or null when whole is zero. */
export function percentageOf(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return (part / whole) * 100;
}
