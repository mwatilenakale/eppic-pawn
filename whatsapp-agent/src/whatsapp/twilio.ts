/** Twilio is an edge adapter only. Intake, permissions and money stay in AgentRouter.
 * Review notes and cloud setup: docs/twilio-cloud.md.
 */
import twilio from 'twilio';
import type { DatabaseSync } from 'node:sqlite';
import type { InboundEvent } from './webhook.ts';
import { WhatsAppError, type WhatsAppTransport, type OutboundMessage, type DownloadedMedia } from './transport.ts';
import type { TemplateMessage } from './templates.ts';

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  from: string;
  contentSids: Record<string, string>;
}

const messageSid = /^(?:SM|MM)[0-9a-f]{32}$/i;
const whatsappNumber = /^whatsapp:\+[1-9]\d{7,14}$/;

/** Reject ambiguous duplicate parameters, but include ALL supplied fields in validation. */
export function verifiedTwilioForm(raw: string, signature: string | undefined, publicUrl: string, token: string): Record<string, string> | null {
  if (!signature || !token) return null;
  const form = new URLSearchParams(raw);
  const params: Record<string, string> = Object.create(null);
  for (const [key, value] of form) {
    if (Object.hasOwn(params, key)) return null;
    params[key] = value;
  }
  return twilio.validateRequest(token, signature, publicUrl, params) ? params : null;
}

export class TwilioTransport implements WhatsAppTransport {
  readonly #options: TwilioOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #base: string;
  constructor(options: TwilioOptions, fetcher: typeof globalThis.fetch = globalThis.fetch) {
    this.#options = options; this.#fetch = fetcher;
    this.#base = `https://api.twilio.com/2010-04-01/Accounts/${options.accountSid}`;
  }

  async #request(path: string, body?: URLSearchParams): Promise<Response> {
    // No automatic POST retry: a timeout may mean Twilio already accepted it.
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Basic ${Buffer.from(`${this.#options.accountSid}:${this.#options.authToken}`).toString('base64')}`,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body, signal: AbortSignal.timeout(10_000),
    });
    // Never log provider bodies: they can contain customer data or credentials.
    if (!response.ok) throw new WhatsAppError(`Twilio returned HTTP ${response.status}`, response.status);
    return response;
  }

  async #send(to: string, fields: Record<string, string>): Promise<string> {
    const target = `whatsapp:${to}`;
    if (!whatsappNumber.test(target)) throw new WhatsAppError('Invalid WhatsApp recipient');
    const response = await this.#request('/Messages.json', new URLSearchParams({ From: this.#options.from, To: target, ...fields }));
    const payload = await response.json() as { sid?: string };
    if (!payload.sid || !messageSid.test(payload.sid)) throw new WhatsAppError('Twilio accepted no message SID; delivery is unconfirmed');
    return payload.sid;
  }

  sendText({ to, body }: OutboundMessage): Promise<string> { return this.#send(to, { Body: body }); }

  sendTemplate(message: TemplateMessage): Promise<string> {
    const contentSid = Object.hasOwn(this.#options.contentSids, message.name) ? this.#options.contentSids[message.name] : undefined;
    if (!contentSid || !/^HX[0-9a-f]{32}$/i.test(contentSid) || message.parameters.some((value) => !value.trim())) {
      throw new WhatsAppError(`No approved Twilio Content SID/parameters for ${message.name}; message not sent`);
    }
    return this.#send(message.to, { ContentSid: contentSid,
      ContentVariables: JSON.stringify(Object.fromEntries(message.parameters.map((value, index) => [String(index + 1), value]))) });
  }

  /** Fetch authoritative send time: delivery/retry time must NEVER reopen a window.
   * The core's legacy source='meta' means verified platform time; no receipt-time fallback.
   */
  async inbound(params: Record<string, string>): Promise<InboundEvent> {
    if (params['AccountSid'] !== this.#options.accountSid || params['To'] !== this.#options.from ||
        !whatsappNumber.test(params['From'] ?? '') || !messageSid.test(params['MessageSid'] ?? '')) {
      throw new WhatsAppError('Invalid Twilio inbound identity', 400);
    }
    const id = params['MessageSid']!;
    const record = await (await this.#request(`/Messages/${id}.json`)).json() as {
      sid?: string; account_sid?: string; from?: string; to?: string; direction?: string; date_sent?: string; date_created?: string;
    };
    if (record.sid !== id || record.account_sid !== this.#options.accountSid || record.from !== params['From'] ||
        record.to !== this.#options.from || record.direction !== 'inbound') throw new WhatsAppError('Twilio message identity mismatch', 400);
    const at = Date.parse(record.date_sent ?? record.date_created ?? '');
    if (!Number.isFinite(at) || at <= 0 || at > Date.now()) throw new WhatsAppError('Twilio message has no valid platform timestamp', 502);
    const count = params['NumMedia'] ?? '0';
    if (!/^[01]$/.test(count)) throw new WhatsAppError('Unsupported Twilio media count', 400);
    const mime = params['MediaContentType0'] ?? '';
    const type: InboundEvent['type'] = count === '0' ? 'text' : mime.startsWith('image/') ? 'image' :
      mime === 'application/pdf' ? 'document' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'unsupported';
    return { from: params['From']!.slice('whatsapp:'.length), messageId: id, type,
      text: params['Body'], profileName: params['ProfileName'], timestamp: String(Math.floor(at / 1000)),
      mediaId: count === '1' ? id : undefined };
  }

  async downloadMedia(id: string): Promise<DownloadedMedia> {
    if (!messageSid.test(id)) throw new WhatsAppError('Invalid Twilio media message SID');
    // Never fetch the webhook's MediaUrl0 (SSRF). Resolve media under our fixed account path.
    const listing = await (await this.#request(`/Messages/${id}/Media.json`)).json() as {
      media_list?: { sid: string; content_type: string }[];
    };
    const media = listing.media_list?.[0];
    if (!media || listing.media_list?.length !== 1 || !/^ME[0-9a-f]{32}$/i.test(media.sid)) throw new WhatsAppError('Expected exactly one Twilio media attachment');
    const response = await this.#request(`/Messages/${id}/Media/${media.sid}`);
    const chunks: Buffer[] = []; let size = 0;
    if (!response.body) throw new WhatsAppError('Empty Twilio media response');
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 20_000_000) throw new WhatsAppError('Twilio media exceeds the download limit');
      chunks.push(Buffer.from(chunk));
    }
    const mimeType = media.content_type;
    const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'video/mp4': 'mp4' };
    return { content: Buffer.concat(chunks), mimeType, extension: extensions[mimeType] ?? 'bin' };
  }
}

/** Durable at-most-once dispatch, including owner commands. Uncertain/failed work
 * requires human reconciliation, NOT automatic replay of a possible money action.
 */
export async function dispatchTwilio(db: DatabaseSync, event: InboundEvent, handle: (event: InboundEvent) => Promise<void>): Promise<void> {
  const inserted = db.prepare("INSERT OR IGNORE INTO twilio_receipts(message_id, state, created_at) VALUES (?, 'processing', ?)")
    .run(event.messageId, new Date().toISOString());
  if (!inserted.changes) return;
  try {
    await handle(event);
    db.prepare("UPDATE twilio_receipts SET state = 'handled' WHERE message_id = ?").run(event.messageId);
  } catch {
    db.prepare("UPDATE twilio_receipts SET state = 'failed' WHERE message_id = ?").run(event.messageId);
    throw new WhatsAppError('Twilio inbound handling failed; receipt requires operator review');
  }
}
