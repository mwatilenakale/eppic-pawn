/**
 * Encrypted media at rest (architecture section 4): ID photos, proof of
 * ownership and item pictures are customers' identity documents and never sit
 * on disk in plaintext.
 *
 * AES-256-GCM with a per-file random IV; the key comes from EPPIC_MEDIA_KEY
 * (64 hex characters). No key, no media storage — the agent refuses rather
 * than falling back to plaintext.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class MediaKeyError extends Error {}

export function mediaKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const hex = env['EPPIC_MEDIA_KEY'];
  if (!hex) {
    throw new MediaKeyError(
      'EPPIC_MEDIA_KEY is not set. Generate one with `openssl rand -hex 32` — customer ID photos are not stored unencrypted.',
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new MediaKeyError('EPPIC_MEDIA_KEY must be 64 hex characters (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

export function generateMediaKey(): string {
  return randomBytes(32).toString('hex');
}

export interface StoredMedia {
  path: string;
  sha256: string;
  bytes: number;
}

export class MediaStore {
  readonly #directory: string;
  readonly #key: Buffer;

  constructor(directory: string, key: Buffer = mediaKeyFromEnv()) {
    if (key.length !== 32) throw new MediaKeyError('Media key must be 32 bytes');
    this.#directory = directory;
    this.#key = key;
    mkdirSync(directory, { recursive: true });
  }

  /** Encrypts and writes a blob, returning its path and plaintext digest. */
  put(content: Buffer, extension = 'bin'): StoredMedia {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
    const path = join(this.#directory, `${randomUUID()}.${extension}.enc`);

    writeFileSync(path, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });

    return {
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.length,
    };
  }

  /** Reads a blob back, failing loudly if the file was tampered with. */
  get(path: string): Buffer {
    const blob = readFileSync(path);
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
