/opt/homebrew/Library/Homebrew/cmd/shellenv.sh: line 18: /bin/ps: Operation not permitted
/**
 * Sending and receiving on WhatsApp.
 *
 * The rest of the system talks to this interface, never to Meta directly, so
 * the intake and approval logic can be exercised end to end without a Meta
 * account — which matters, because that account is a prerequisite with its own
 * lead time (whatsapp-agent/CLAUDE.md, open question 1).
 */

import { updateTemplate, type TemplateMessage } from './templates.ts';

export interface OutboundMessage {
  to: string;
  body: string;
  template?: TemplateMessage;
  /** Collection notices must not retry a possibly accepted POST. */
  singleAttempt?: boolean;
}

export interface DownloadedMedia {
  content: Buffer;
  mimeType: string;
  extension: string;
}

export interface WhatsAppTransport {
  sendText(message: OutboundMessage): Promise<string>;
  sendTemplate?(message: TemplateMessage): Promise<string>;
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

  async sendText({ to, body, singleAttempt }: OutboundMessage): Promise<string> {
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
      }), singleAttempt ? 1 : this.#options.maxAttempts,
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

  async sendTemplate(message: TemplateMessage): Promise<string> {
    if (!message.name || !message.language || message.parameters.some((value) => !value.trim())) {
      throw new WhatsAppError('Missing template name, language or parameter');
    }
    const { baseUrl, apiVersion, phoneNumberId, token } = this.#options;
    try {
      const response = await this.#withRetry(() => this.#options.fetch(`${baseUrl}/${apiVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: message.to,
          type: 'template', template: { name: message.name, language: { code: message.language },
            components: [{ type: 'body', parameters: message.parameters.map((text) => ({ type: 'text', text })) }] } }),
      }), 1);
      const payload = await response.json() as { messages?: { id: string }[] };
      const id = payload.messages?.[0]?.id;
      if (!id) throw new WhatsAppError('Meta accepted no message ID; delivery is unconfirmed');
      return id;
    } catch (error) {
      throw new WhatsAppError(`Template ${message.name} (${message.language}) could not be sent. Check that it exists, is approved and has the expected parameters. ${error instanceof Error ? error.message : 'Unknown failure'}`, error instanceof WhatsAppError ? error.status : 0);
    }
  }

  async #withRetry(call: () => Promise<Response>, maxAttempts = this.#options.maxAttempts): Promise<Response> {
    let lastError: WhatsAppError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await call();
      } catch (error) {
        lastError = new WhatsAppError(`WhatsApp request failed: ${(error as Error).message}`);
        if (attempt < maxAttempts) await delay(this.#options.retryDelayMs * attempt);
        continue;
      }

      if (response.ok) return response;

      const detail = await response.text().catch(() => '');
      lastError = new WhatsAppError(`WhatsApp returned ${response.status}: ${detail.slice(0, 300)}`, response.status);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw lastError;
      if (attempt < maxAttempts) await delay(this.#options.retryDelayMs * attempt);
    }

    throw lastError ?? new WhatsAppError('WhatsApp request failed');
  }
}

/** Records what would have been sent. Used by the simulator and the tests. */
export class MemoryTransport implements WhatsAppTransport {
  readonly sent: OutboundMessage[] = [];
  readonly templates: TemplateMessage[] = [];
  readonly media = new Map<string, DownloadedMedia>();

  async sendText(message: OutboundMessage): Promise<string> {
    this.sent.push(message);
    return `local.${this.sent.length}`;
  }

  async sendTemplate(message: TemplateMessage): Promise<string> {
    this.templates.push(message);
    this.sent.push({ to: message.to, body: message.body, template: message });
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

/** Meta's customer-service window is 24 hours after the user's message.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 * Unknown, future or receipt-only timestamps never prove an open window.
 */
export const META_CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class WindowAwareTransport implements WhatsAppTransport {
  readonly #raw: WhatsAppTransport;
  readonly #lastInbound: (phone: string) => { at: string; source: 'meta' | 'received' } | null;
  readonly #clock: () => Date;
  readonly #onFailure: (message: OutboundMessage, error: Error) => void | Promise<void>;

  constructor(raw: WhatsAppTransport, options: {
    lastInboundAt: (phone: string) => { at: string; source: 'meta' | 'received' } | null;
    clock?: () => Date;
    onFailure?: (message: OutboundMessage, error: Error) => void | Promise<void>;
  }) {
    this.#raw = raw; this.#lastInbound = options.lastInboundAt;
    this.#clock = options.clock ?? (() => new Date());
    this.#onFailure = options.onFailure ?? ((message, error) => console.error(`[whatsapp] Send to ${message.to} failed`, error));
  }

  async sendText(message: OutboundMessage): Promise<string> {
    try {
      const inbound = this.#lastInbound(message.to);
      const age = inbound ? this.#clock().getTime() - Date.parse(inbound.at) : NaN;
      let id: string;
      if (inbound?.source === 'meta' && age >= 0 && age < META_CUSTOMER_SERVICE_WINDOW_MS) {
        id = await this.#raw.sendText(message);
      } else {
        if (!this.#raw.sendTemplate) throw new WhatsAppError('No template-capable transport; message not sent');
        if (message.template && message.template.to !== message.to) throw new WhatsAppError('Template recipient does not match the message');
        id = await this.#raw.sendTemplate(message.template ?? updateTemplate(message.to, message.body));
      }
      if (!id) throw new WhatsAppError('No provider message ID; message delivery is unconfirmed');
      return id;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      await this.#onFailure(message, error);
      throw error;
    }
  }

  downloadMedia(mediaId: string): Promise<DownloadedMedia> { return this.#raw.downloadMedia(mediaId); }
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

