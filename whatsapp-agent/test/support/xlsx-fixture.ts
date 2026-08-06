/**
 * Builds a real .xlsx in memory, so the tests never need a checked-in binary
 * — and never need Lukas's actual workbook, which is full of customers'
 * names and phone numbers.
 *
 * This is a test fixture, not a spreadsheet writer: it emits the smallest
 * file the reader has to cope with, and every shape it emits is one the real
 * workbook contains (shared strings, cached formula results, date styles,
 * blank cells in the middle of a row).
 */

import { deflateRawSync } from 'node:zlib';

export type FixtureCell = string | number | boolean | Date | null | { formula: string; value: string | number };

export interface FixtureSheet {
  name: string;
  rows: FixtureCell[][];
}

const DATE_STYLE = 1;

export function buildXlsx(sheets: FixtureSheet[]): Buffer {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const intern = (value: string): number => {
    const existing = stringIndex.get(value);
    if (existing !== undefined) return existing;
    stringIndex.set(value, strings.length);
    strings.push(value);
    return strings.length - 1;
  };

  const sheetParts = sheets.map((sheet, index) => ({
    path: `xl/worksheets/sheet${index + 1}.xml`,
    xml: sheetXml(sheet.rows, intern),
  }));

  const files: ZipFile[] = [
    { name: '[Content_Types].xml', data: contentTypes(sheets.length) },
    { name: '_rels/.rels', data: rootRels() },
    { name: 'xl/workbook.xml', data: workbookXml(sheets) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(sheets.length) },
    { name: 'xl/styles.xml', data: stylesXml() },
    { name: 'xl/sharedStrings.xml', data: sharedStringsXml(strings) },
    ...sheetParts.map((part) => ({ name: part.path, data: part.xml })),
  ];

  return zip(files);
}

function sheetXml(rows: FixtureCell[][], intern: (value: string) => number): string {
  const body = rows
    .map((cells, rowIndex) => {
      const rendered = cells
        .map((cell, columnIndex) => cellXml(reference(rowIndex, columnIndex), cell, intern))
        .filter(Boolean)
        .join('');
      return `<row r="${rowIndex + 1}">${rendered}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function cellXml(ref: string, cell: FixtureCell, intern: (value: string) => number): string {
  // A blank cell is written self-closing — the shape that used to make the
  // reader shift every later column one place to the left.
  if (cell === null) return `<c r="${ref}"/>`;
  if (cell instanceof Date) return `<c r="${ref}" s="${DATE_STYLE}"><v>${serial(cell)}</v></c>`;
  if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
  if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
  if (typeof cell === 'string') return `<c r="${ref}" t="s"><v>${intern(cell)}</v></c>`;

  // A formula, saved with the result Excel last calculated — what the reader
  // uses, since it does not evaluate anything.
  const value = typeof cell.value === 'number' ? `<v>${cell.value}</v>` : `<v>${escapeXml(cell.value)}</v>`;
  const type = typeof cell.value === 'number' ? '' : ' t="str"';
  return `<c r="${ref}"${type}><f>${escapeXml(cell.formula)}</f>${value}</c>`;
}

function reference(rowIndex: number, columnIndex: number): string {
  let column = '';
  let remaining = columnIndex;
  do {
    column = String.fromCharCode(65 + (remaining % 26)) + column;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return `${column}${rowIndex + 1}`;
}

/** Days since 30 December 1899, the epoch Excel counts from. */
function serial(date: Date): number {
  return Math.round((date.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
}

function sharedStringsXml(strings: string[]): string {
  const items = strings.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

/** Style 0 is money, style 1 is a custom date format — the reader must tell them apart. */
function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="165" formatCode="&quot;N$ &quot;#,##0.00"/><numFmt numFmtId="167" formatCode="yyyy\\-mm\\-dd"/></numFmts>
<cellXfs count="2"><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;
}

function workbookXml(sheets: FixtureSheet[]): string {
  const tags = sheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 10}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="false"/><sheets>${tags}</sheets></workbook>`;
}

/** Relationship ids deliberately do not match sheet order — they must be resolved, not assumed. */
function workbookRels(count: number): string {
  const relationships = Array.from(
    { length: count },
    (_, index) =>
      `<Relationship Id="rId${index + 10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function rootRels(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function contentTypes(count: number): string {
  const overrides = Array.from(
    { length: count },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- the ZIP container ----------------------------------------------------

interface ZipFile {
  name: string;
  data: string;
}

/**
 * Half the entries are stored and half deflated, so both paths through the
 * reader are exercised by every test that opens a fixture.
 */
function zip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  files.forEach((file, index) => {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data, 'utf8');
    const deflate = index % 2 === 0;
    const payload = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + payload.length;
  });

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
