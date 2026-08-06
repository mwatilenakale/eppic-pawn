/**
 * Reading an .xlsx without a spreadsheet library.
 *
 * Only what a one-way import needs: sheets by name, cells as values, and
 * dates that come back as dates rather than as the serial numbers Excel
 * actually stores. Formulas are not evaluated — the cached result Excel wrote
 * alongside each formula is used, which is what a saved workbook always has.
 *
 * The narrowness is the point. This reads a file Lukas already keeps; it is
 * not a general spreadsheet engine, and pretending otherwise would invite it
 * to be used as one.
 */

import { readFileSync } from 'node:fs';
import { ZipArchive } from './zip.ts';

export { ZipArchive, ZipError } from './zip.ts';

export type CellValue = string | number | boolean | Date | null;

export class XlsxError extends Error {}

export class Workbook {
  readonly sheetNames: string[];
  readonly #archive: ZipArchive;
  readonly #parts = new Map<string, string>();
  readonly #sharedStrings: string[];
  readonly #dateStyles: Set<number>;
  readonly #epoch1904: boolean;
  readonly #cache = new Map<string, CellValue[][]>();

  constructor(buffer: Buffer) {
    this.#archive = new ZipArchive(buffer);
    if (!this.#archive.has('xl/workbook.xml')) throw new XlsxError('Not an .xlsx file — xl/workbook.xml is missing');

    const workbook = this.#archive.readText('xl/workbook.xml');
    this.#epoch1904 = /date1904="(1|true)"/.test(workbook);

    const relationships = this.#archive.has('xl/_rels/workbook.xml.rels')
      ? parseRelationships(this.#archive.readText('xl/_rels/workbook.xml.rels'))
      : new Map<string, string>();

    this.sheetNames = [];
    for (const tag of workbook.match(/<sheet\b[^>]*\/?>/g) ?? []) {
      const name = decodeXml(attribute(tag, 'name') ?? '');
      const target = relationships.get(attribute(tag, 'r:id') ?? '');
      if (!name || !target) continue;
      this.sheetNames.push(name);
      this.#parts.set(name, resolvePart(target));
    }

    this.#sharedStrings = this.#archive.has('xl/sharedStrings.xml')
      ? parseSharedStrings(this.#archive.readText('xl/sharedStrings.xml'))
      : [];
    this.#dateStyles = this.#archive.has('xl/styles.xml')
      ? parseDateStyles(this.#archive.readText('xl/styles.xml'))
      : new Set();
  }

  static fromFile(path: string): Workbook {
    return new Workbook(readFileSync(path));
  }

  has(sheetName: string): boolean {
    return this.#parts.has(sheetName);
  }

  /**
   * A sheet as a dense grid: every row padded to the widest row, gaps filled
   * with null. Callers index by column position, so a blank cell has to hold
   * its place rather than shifting everything left.
   */
  sheet(sheetName: string): CellValue[][] {
    const cached = this.#cache.get(sheetName);
    if (cached) return cached;

    const part = this.#parts.get(sheetName);
    if (!part) throw new XlsxError(`The workbook has no sheet named "${sheetName}" (it has: ${this.sheetNames.join(', ')})`);

    const rows = this.#parseSheet(this.#archive.readText(part));
    this.#cache.set(sheetName, rows);
    return rows;
  }

  /** Rows below the header, as `{ header: value }`, with trailing blank rows dropped. */
  records(sheetName: string, headerRow = 0): Record<string, CellValue>[] {
    const rows = this.sheet(sheetName);
    const headers = (rows[headerRow] ?? []).map((cell) => (cell === null ? '' : String(cell).trim()));

    const records: Record<string, CellValue>[] = [];
    for (const row of rows.slice(headerRow + 1)) {
      if (row.every((cell) => cell === null || cell === '')) continue;
      const record: Record<string, CellValue> = {};
      headers.forEach((header, index) => {
        if (header) record[header] = row[index] ?? null;
      });
      records.push(record);
    }
    return records;
  }

  #parseSheet(xml: string): CellValue[][] {
    const rows: CellValue[][] = [];
    let width = 0;

    // The attribute groups are lazy on purpose: `[^>]*` would happily eat the
    // `/` of a self-closing `<c r="Y2"/>` and then match the *next* cell's
    // `</c>`, silently shifting every later column one place to the left.
    for (const match of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowIndex = Number(attribute(match[1]!, 'r') ?? rows.length + 1) - 1;
      const cells: CellValue[] = [];

      for (const cellMatch of (match[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cellMatch[1]!;
        const reference = attribute(attributes, 'r');
        const column = reference ? columnIndex(reference) : cells.length;
        while (cells.length < column) cells.push(null);
        cells[column] = this.#cellValue(attributes, cellMatch[2] ?? '');
      }

      while (rows.length < rowIndex) rows.push([]);
      rows[rowIndex] = cells;
      width = Math.max(width, cells.length);
    }

    for (const row of rows) while (row.length < width) row.push(null);
    return rows;
  }

  #cellValue(attributes: string, body: string): CellValue {
    const type = attribute(attributes, 't') ?? 'n';

    if (type === 'inlineStr') return textOf(body);
    if (type === 's') {
      const index = Number(firstTag(body, 'v') ?? '');
      return this.#sharedStrings[index] ?? null;
    }

    const raw = firstTag(body, 'v');
    if (raw === null) return type === 'str' ? textOf(body) : null;

    if (type === 'str') return decodeXml(raw);
    if (type === 'b') return raw === '1';
    if (type === 'e') return decodeXml(raw);

    const value = Number(raw);
    if (Number.isNaN(value)) return decodeXml(raw);

    const style = Number(attribute(attributes, 's') ?? -1);
    return this.#dateStyles.has(style) ? excelDate(value, this.#epoch1904) : value;
  }
}

/** Excel keeps dates as days since an epoch; 1900 workbooks also carry its phantom 29 Feb 1900. */
export function excelDate(serial: number, epoch1904 = false): Date {
  const base = epoch1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const days = !epoch1904 && serial < 60 ? serial + 1 : serial;
  return new Date(base + Math.round(days * 86400000));
}

function resolvePart(target: string): string {
  const cleaned = target.replace(/^\/+/, '');
  return cleaned.startsWith('xl/') ? cleaned : `xl/${cleaned}`;
}

function parseRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const tag of xml.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = attribute(tag, 'Id');
    const target = attribute(tag, 'Target');
    if (id && target) relationships.set(id, decodeXml(target));
  }
  return relationships;
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    strings.push(textOf(match[1] ?? ''));
  }
  return strings;
}

/**
 * Which cell styles mean "this number is a date". Built-in format ids 14-22
 * and 45-47 are dates and times; anything else has to be recognised from its
 * format code, since a custom `yyyy-mm-dd` is just as much a date.
 */
function parseDateStyles(xml: string): Set<number> {
  const dateFormats = new Set<number>([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

  for (const tag of xml.match(/<numFmt\b[^>]*\/?>/g) ?? []) {
    const id = Number(attribute(tag, 'numFmtId') ?? NaN);
    const code = decodeXml(attribute(tag, 'formatCode') ?? '');
    if (!Number.isNaN(id) && looksLikeDateFormat(code)) dateFormats.add(id);
  }

  const styles = new Set<number>();
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!cellXfs) return styles;

  let index = 0;
  for (const tag of cellXfs[1]!.match(/<xf\b[^>]*\/?>/g) ?? []) {
    if (dateFormats.has(Number(attribute(tag, 'numFmtId') ?? NaN))) styles.add(index);
    index += 1;
  }
  return styles;
}

function looksLikeDateFormat(code: string): boolean {
  // Quoted literals and escapes go first: `"N$ "#,##0.00` is money, and its
  // N and $ must not be read as format characters. What survives is date-like
  // only if it still contains one of the year/month/day/hour/second letters.
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(stripped);
}

/** `B7` -> 1. */
export function columnIndex(reference: string): number {
  let index = 0;
  for (const character of reference.toUpperCase()) {
    const position = character.charCodeAt(0) - 64;
    if (position < 1 || position > 26) break;
    index = index * 26 + position;
  }
  return index - 1;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`).exec(tag);
  return match ? match[1]! : null;
}

function firstTag(body: string, name: string): string | null {
  const match = new RegExp(`<${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${name}>)`).exec(body);
  if (!match) return null;
  return match[1] ?? '';
}

/** Concatenates every `<t>` run — a styled cell is split into several. */
function textOf(body: string): string {
  const parts: string[] = [];
  for (const match of body.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) parts.push(decodeXml(match[1] ?? ''));
  return parts.join('');
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
