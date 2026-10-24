/**
 * Just enough of the ZIP format to open an .xlsx.
 *
 * An .xlsx is a ZIP of XML parts, and Node can already inflate a deflate
 * stream — so reading one needs no dependency, only the central directory
 * walk that tells us where each part starts. That matters here: the rest of
 * this system runs on the standard library, and a spreadsheet import is a
 * poor reason to take on a package that reads arbitrary files.
 *
 * Deliberately narrow. It reads entries; it does not write, encrypt, or
 * handle spanned archives.
 */

import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const ZIP64_END_RECORD = 0x06064b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

export class ZipError extends Error {}

interface Entry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipArchive {
  readonly #buffer: Buffer;
  readonly #entries = new Map<string, Entry>();

  constructor(buffer: Buffer) {
    this.#buffer = buffer;
    for (const entry of readCentralDirectory(buffer)) this.#entries.set(entry.name, entry);
  }

  /** Every entry name, in central-directory order. */
  names(): string[] {
    return [...this.#entries.keys()];
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  read(name: string): Buffer {
    const entry = this.#entries.get(name);
    if (!entry) throw new ZipError(`The archive has no entry named ${name}`);

    const start = dataStart(this.#buffer, entry);
    const raw = this.#buffer.subarray(start, start + entry.compressedSize);

    if (entry.compression === STORED) return Buffer.from(raw);
    if (entry.compression === DEFLATED) return inflateRawSync(raw);
    throw new ZipError(`Entry ${name} uses compression method ${entry.compression}, which is not supported`);
  }

  readText(name: string): string {
    return this.read(name).toString('utf8');
  }
}

/**
 * The local header repeats the name and extra field, and its lengths are the
 * ones that count — some writers pad the extra field differently from the
 * central directory copy.
 */
function dataStart(buffer: Buffer, entry: Entry): number {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== LOCAL_FILE_HEADER) {
    throw new ZipError(`Entry ${entry.name} does not start with a local file header`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  return offset + 30 + nameLength + extraLength;
}

function readCentralDirectory(buffer: Buffer): Entry[] {
  const end = findEndOfCentralDirectory(buffer);
  let count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);

  // ZIP64: the 32-bit fields saturate and the real numbers live in a separate
  // record. Rare for a spreadsheet, cheap to support, and a silent truncation
  // would be worse than the twenty lines it takes to avoid.
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = findSignature(buffer, ZIP64_END_LOCATOR, end);
    if (locator < 0) throw new ZipError('The archive looks like ZIP64 but has no end locator');
    const record = Number(buffer.readBigUInt64LE(locator + 8));
    if (buffer.readUInt32LE(record) !== ZIP64_END_RECORD) throw new ZipError('Corrupt ZIP64 end record');
    count = Number(buffer.readBigUInt64LE(record + 32));
    offset = Number(buffer.readBigUInt64LE(record + 48));
  }

  const entries: Entry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new ZipError(`Corrupt central directory at entry ${index}`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);

    const entry: Entry = {
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      compression: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    };

    if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff || entry.localHeaderOffset === 0xffffffff) {
      applyZip64Extra(buffer, offset + 46 + nameLength, extraLength, entry);
    }

    entries.push(entry);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Header 0x0001 carries the 64-bit values, in order, for whatever saturated. */
function applyZip64Extra(buffer: Buffer, start: number, length: number, entry: Entry): void {
  let cursor = start;
  const end = start + length;
  while (cursor + 4 <= end) {
    const headerId = buffer.readUInt16LE(cursor);
    const size = buffer.readUInt16LE(cursor + 2);
    let field = cursor + 4;
    if (headerId === 0x0001) {
      if (entry.uncompressedSize === 0xffffffff) { entry.uncompressedSize = Number(buffer.readBigUInt64LE(field)); field += 8; }
      if (entry.compressedSize === 0xffffffff) { entry.compressedSize = Number(buffer.readBigUInt64LE(field)); field += 8; }
      if (entry.localHeaderOffset === 0xffffffff) entry.localHeaderOffset = Number(buffer.readBigUInt64LE(field));
      return;
    }
    cursor += 4 + size;
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const offset = findSignature(buffer, END_OF_CENTRAL_DIRECTORY, buffer.length);
  if (offset < 0) throw new ZipError('Not a ZIP archive — no end-of-central-directory record found');
  return offset;
}

/** Scans backwards from `before`; the trailing comment means it is not at a fixed place. */
function findSignature(buffer: Buffer, signature: number, before: number): number {
  for (let offset = Math.min(before, buffer.length - 4); offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}
