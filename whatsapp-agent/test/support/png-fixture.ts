/**
 * Builds real PNGs in memory, so the signature tests never need a checked-in
 * binary and can describe what is on the image rather than assert on opaque
 * base64.
 *
 * This is a fixture, not an image library: it emits only the shapes a browser
 * canvas emits — 8 bits per channel, RGBA or RGB, no interlacing — plus a
 * couple of deliberately wrong ones so the refusals can be tested.
 */

import { deflateSync, crc32 } from 'node:zlib';

export interface PngOptions {
  width: number;
  height: number;
  /** 4 = RGBA (what `canvas.toDataURL()` produces), 3 = RGB. */
  channels?: 3 | 4;
  /** PNG row filter to encode with. Real encoders use several; so should we. */
  filter?: 0 | 1 | 2 | 3 | 4;
  interlaced?: boolean;
  /** Called per pixel; return null for "nothing here". */
  paint?: (x: number, y: number) => { r: number; g: number; b: number; a: number } | null;
}

export function png(options: PngOptions): Buffer {
  const { width, height, channels = 4, filter = 0, interlaced = false, paint } = options;

  // The unfiltered scanlines, as a decoder would see them after un-filtering.
  const stride = width * channels;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x += 1) {
      const mark = paint?.(x, y) ?? null;
      const at = x * channels;
      if (mark) {
        row[at] = mark.r; row[at + 1] = mark.g; row[at + 2] = mark.b;
        if (channels === 4) row[at + 3] = mark.a;
      } else if (channels === 3) {
        // No alpha channel, so "blank" is white paper rather than transparent.
        row[at] = 255; row[at + 1] = 255; row[at + 2] = 255;
      }
    }
    rows.push(row);
  }

  // Apply the requested filter, which is what makes this worth having: a
  // decoder that forgets to reverse filtering reads a blank image as marked.
  const raw = Buffer.alloc((stride + 1) * height);
  const previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y]!;
    const start = y * (stride + 1);
    raw[start] = filter;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? row[i - channels]! : 0;
      const up = previous[i]!;
      const upLeft = i >= channels ? previous[i - channels]! : 0;
      let subtract = 0;
      if (filter === 1) subtract = left;
      else if (filter === 2) subtract = up;
      else if (filter === 3) subtract = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const dLeft = Math.abs(estimate - left);
        const dUp = Math.abs(estimate - up);
        const dUpLeft = Math.abs(estimate - upLeft);
        subtract = dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
      }
      raw[start + 1 + i] = (row[i]! - subtract) & 0xff;
    }
    row.copy(previous);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  ihdr[12] = interlaced ? 1 : 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The same, as the data URL a browser form would post. */
export function pngDataUrl(options: PngOptions): string {
  return `data:image/png;base64,${png(options).toString('base64')}`;
}

/** A stroke across the pad — what a signature looks like to these tests. */
export function signatureDataUrl(options: { channels?: 3 | 4; filter?: 0 | 1 | 2 | 3 | 4 } = {}): string {
  return pngDataUrl({
    width: 240,
    height: 80,
    ...options,
    paint: (x, y) => (Math.abs(y - 40 - Math.sin(x / 18) * 14) < 2 ? { r: 26, g: 26, b: 26, a: 255 } : null),
  });
}

/** Nothing drawn: a cleared canvas, which is what a resize used to produce. */
export function blankDataUrl(options: { channels?: 3 | 4; filter?: 0 | 1 | 2 | 3 | 4 } = {}): string {
  return pngDataUrl({ width: 240, height: 80, ...options });
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
