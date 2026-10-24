/**
 * Sending and receiving on WhatsApp.
 *
 * The rest of the system talks to this interface, never to Meta directly, so
 * the intake and approval logic can be exercised end to end without a Meta
 * account — which matters, because that account is a prerequisite with its own
 * lead time (whatsapp-agent/CLAUDE.md, open question 1).
 */

export interface OutboundMessage {
  to: string;
  body: string;
}

export interface DownloadedMedia {
  content: Buffer;
  mimeType: string;
  extension: string;
}

export interface WhatsAppTransport {
  sendText(message: OutboundMessage): Promise<string>;
  downloadMedia(mediaId: string): Promise<DownloadedMedia>;
}

export class WhatsAppError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'WhatsAppError';
    this.status = status;
  }
}

export interface CloudApiOptions {
  token: string;
  phoneNumberId: string;
  apiVersion?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Retries on 429 and 5xx; WhatsApp rate-limits in normal operation. */
  maxAttempts?: number;
  retryDelayMs?: number;
}

/** WhatsApp Cloud API (Meta Graph). */
export class CloudApiTransport implements WhatsAppTransport {
  readonly #options: Required<Omit<CloudApiOptions, 'fetch'>> & { fetch: typeof globalThis.fetch };

  constructor(options: CloudApiOptions) {
    this.#options = {
      apiVersion: 'v21.0',
      baseUrl: 'https://graph.facebook.com',
      maxAttempts: 3,
      retryDelayMs: 500,
      fetch: options.fetch ?? globalThis.fetch,
      ...options,
    };
  }

  async sendText({ to, body }: OutboundMessage): Promise<string> {
    const { baseUrl, apiVersion, phoneNumberId, token } = this.#options;
    const response = await this.#withRetry(() =>
      this.#options.fetch(`${baseUrl}/${apiVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body },
        }),
      }),
    );

    const payload = (await response.json()) as { messages?: { id: string }[] };
    return payload.messages?.[0]?.id ?? '';
  }

  async downloadMedia(mediaId: string): Promise<DownloadedMedia> {
    const { baseUrl, apiVersion, token } = this.#options;
    const lookup = await this.#withRetry(() =>
      this.#options.fetch(`${baseUrl}/${apiVersion}/${mediaId}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const { url, mime_type: mimeType } = (await lookup.json()) as { url: string; mime_type: string };

    const download = await this.#withRetry(() =>
      this.#options.fetch(url, { headers: { authorization: `Bearer ${token}` } }),
    );

    return {
      content: Buffer.from(await download.arrayBuffer()),
      mimeType: mimeType ?? 'application/octet-stream',
      extension: extensionFor(mimeType),
    };
  }

  async #withRetry(call: () => Promise<Response>): Promise<Response> {
    let lastError: WhatsAppError | null = null;

    for (let attempt = 1; attempt <= this.#options.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await call();
      } catch (error) {
        lastError = new WhatsAppError(`WhatsApp request failed: ${(error as Error).message}`);
        await delay(this.#options.retryDelayMs * attempt);
        continue;
      }

      if (response.ok) return response;

      const detail = await response.text().catch(() => '');
      lastError = new WhatsAppError(`WhatsApp returned ${response.status}: ${detail.slice(0, 300)}`, response.status);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw lastError;
      await delay(this.#options.retryDelayMs * attempt);
    }

    throw lastError ?? new WhatsAppError('WhatsApp request failed');
  }
}

/** Records what would have been sent. Used by the simulator and the tests. */
export class MemoryTransport implements WhatsAppTransport {
  readonly sent: OutboundMessage[] = [];
  readonly media = new Map<string, DownloadedMedia>();

  async sendText(message: OutboundMessage): Promise<string> {
    this.sent.push(message);
    return `local.${this.sent.length}`;
  }

  async downloadMedia(mediaId: string): Promise<DownloadedMedia> {
    return (
      this.media.get(mediaId) ?? {
        content: Buffer.from(`fake-media:${mediaId}`),
        mimeType: 'image/jpeg',
        extension: 'jpg',
      }
    );
  }

  to(phone: string): string[] {
    return this.sent.filter((message) => message.to === phone).map((message) => message.body);
  }
}

function extensionFor(mimeType: string | undefined): string {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'video/mp4': 'mp4',
  };
  return known[mimeType ?? ''] ?? 'bin';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
