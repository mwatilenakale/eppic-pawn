/**
 * Minimal markdown readers used by the playbook loader.
 *
 * These exist so business rules can be read out of `docs/playbook.md` at
 * runtime instead of being restated in code (root CLAUDE.md). They are
 * deliberately strict: if the document shape changes, the reader returns
 * nothing and the loader raises a loud error, rather than quietly falling
 * back to a stale default.
 */

/** A `## <n>. <title>` section of a document, without its heading line. */
export function section(markdown: string, headingNumber: number): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) =>
    new RegExp(`^##\\s+${headingNumber}(\\.|\\s)`).test(line),
  );
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** A `### <number> <title>` subsection, without its heading line. */
export function subsection(markdown: string, headingNumber: string): string | null {
  const lines = markdown.split('\n');
  const escaped = headingNumber.replace(/\./g, '\\.');
  const start = lines.findIndex((line) => new RegExp(`^###\\s+${escaped}(\\s|$)`).test(line));
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{2,3}\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** Top-level `- ` bullets of a block, with nested bullets folded into the parent. */
export function bullets(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split('\n')) {
    const top = /^[-*]\s+(.*)$/.exec(line);
    if (top) {
      out.push(top[1]!.trim());
      continue;
    }
    const nested = /^\s+[-*]\s+(.*)$/.exec(line);
    const continuation = /^\s{2,}(\S.*)$/.exec(line);
    const last = out.length - 1;
    if (nested && last >= 0) {
      out[last] = `${out[last]} — ${nested[1]!.trim()}`;
    } else if (continuation && last >= 0) {
      out[last] = `${out[last]} ${continuation[1]!.trim()}`;
    }
  }
  return out;
}

/**
 * Blocks introduced by a bold lead-in — `**Cars**` in playbook section 6, or
 * `- **iPhone:** ...` in architecture section 2.3. Returns them in document
 * order as `{ label, body }`.
 */
export function labelledBlocks(
  block: string,
  { inlineBullets = true }: { inlineBullets?: boolean } = {},
): { label: string; body: string }[] {
  const out: { label: string; body: string }[] = [];
  const lines = block.split('\n');

  for (const line of lines) {
    const heading = /^\*\*(.+?)\*\*\s*$/.exec(line.trim());
    const inlineBullet = inlineBullets ? /^[-*]\s+\*\*(.+?):?\*\*\s*(.*)$/.exec(line.trim()) : null;

    if (heading) {
      out.push({ label: heading[1]!.trim(), body: '' });
    } else if (inlineBullet) {
      out.push({ label: inlineBullet[1]!.replace(/:$/, '').trim(), body: inlineBullet[2]!.trim() });
    } else if (out.length > 0) {
      const last = out[out.length - 1]!;
      last.body = last.body ? `${last.body}\n${line}` : line;
    }
  }

  return out.map(({ label, body }) => ({ label, body: body.trim() }));
}

/** Rows of the first pipe table in a block, as arrays of trimmed cells. */
export function tableRows(block: string): string[][] {
  const rows: string[][] = [];
  let seenHeader = false;

  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) {
      if (rows.length > 0) break; // table ended
      continue;
    }
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim());

    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue; // separator
    if (!seenHeader) {
      seenHeader = true;
      continue; // header row
    }
    rows.push(cells);
  }

  return rows;
}

/** Strips markdown emphasis so values can be matched regardless of bolding. */
export function plain(text: string): string {
  return text.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

/** First `N$1,234.50`-style amount in a string, in cents. */
export function amountCents(text: string): number | null {
  const match = /N\$\s?([\d,]+(?:\.\d+)?)/.exec(text);
  if (!match) return null;
  return Math.round(Number(match[1]!.replace(/,/g, '')) * 100);
}

/** First percentage in a string, as a number (`29% total` -> 29). */
export function percent(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s?%/.exec(text);
  return match ? Number(match[1]!) : null;
}

/** All percentages in a string, in order. */
export function percents(text: string): number[] {
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s?%/g)].map((m) => Number(m[1]!));
}

/** First `N days` / `N day` count in a string. */
export function days(text: string): number | null {
  const match = /(\d+)\s?days?\b/.exec(text);
  return match ? Number(match[1]!) : null;
}
