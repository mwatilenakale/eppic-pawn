/**
 * Meta's webhook: subscription handshake, signature verification, and turning
 * their payload shape into the events the agent actually cares about.
 *
 * Signature verification is not optional. The webhook URL is public, and
 * without it anyone who finds it could impersonate Lukas and approve a loan.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface InboundEvent {
  /** E.164 with a leading +. */
  from: string;
  messageId: string;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'unsupported';
  text?: string;
  mediaId?: string;
  profileName?: string;
  timestamp?: string;
}

/** Meta sends `264811234567`; everything internal uses `+264811234567`. */
export function normalizePhone(input: string, defaultCountryCode = '264'): string {
  const digits = input.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  // Namibian local form: 081 282 3046 -> +264 81 282 3046
  if (digits.startsWith('0')) return `+${defaultCountryCode}${digits.slice(1)}`;
  return `+${digits}`;
}

export function samePhone(left: string, right: string): boolean {
  return normalizePhone(left) === normalizePhone(right);
}

/** GET /webhook — Meta's subscription handshake. */
export function verifySubscription(
  query: URLSearchParams,
  verifyToken: string,
): { status: number; body: string } {
  const mode = query.get('hub.mode');
  const token = query.get('hub.verify_token');
  const challenge = query.get('hub.challenge') ?? '';

  if (mode === 'subscribe' && token && verifyToken && token === verifyToken) {
    return { status: 200, body: challenge };
  }
  return { status: 403, body: 'Verification failed' };
}

/**
 * Checks Meta's `X-Hub-Signature-256` header against the raw request body.
 * A missing or malformed header is a failure, never a pass.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;

  const [algorithm, provided] = header.split('=');
  if (algorithm !== 'sha256' || !provided) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const providedBuffer = Buffer.from(provided, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/** Test/dev helper: the header Meta would have sent for this body. */
export function signPayload(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(Buffer.from(rawBody)).digest('hex')}`;
}

interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string };
  document?: { id?: string };
  audio?: { id?: string };
  video?: { id?: string };
}

interface MetaPayload {
  entry?: {
    changes?: {
      value?: {
        messages?: MetaMessage[];
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        statuses?: unknown[];
      };
    }[];
  }[];
}

/** Pulls inbound messages out of a webhook payload; delivery statuses are ignored. */
export function parseWebhookPayload(payload: unknown): InboundEvent[] {
  const events: InboundEvent[] = [];
  const body = payload as MetaPayload;

  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages) continue;

      const names = new Map(
        (value.contacts ?? []).map((contact) => [contact.wa_id ?? '', contact.profile?.name ?? '']),
      );

      for (const message of value.messages) {
        if (!message.from || !message.id) continue;
        const mediaId = message.image?.id ?? message.document?.id ?? message.audio?.id ?? message.video?.id;

        events.push({
          from: normalizePhone(message.from),
          messageId: message.id,
          type: isKnownType(message.type) ? message.type : 'unsupported',
          text: message.text?.body,
          mediaId,
          profileName: names.get(message.from) || undefined,
          timestamp: message.timestamp,
        });
      }
    }
  }

  return events;
}

function isKnownType(type: string | undefined): type is InboundEvent['type'] {
  return type === 'text' || type === 'image' || type === 'document' || type === 'audio' || type === 'video';
}

/**
 * Meta sends `timestamp` as Unix seconds in a string. Null for anything that
 * is not one, because a wrong time here is worse than no time: an unknown
 * window reads as shut, which costs a template, while a wrong one reads as
 * open and costs a message nobody receives.
 */
export function metaTimestampToIso(timestamp: string | undefined): string | null {
  if (!timestamp || !/^\d{9,11}$/.test(timestamp)) return null;
  const date = new Date(Number(timestamp) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
