/**
 * Configuration, all from the environment. Nothing here has a default that
 * would let the agent run in a state that looks fine but isn't — a missing
 * WhatsApp token or media key stops start-up with a message that says what to
 * do about it.
 */

import { resolve } from 'node:path';
import { normalizePhone } from './whatsapp/webhook.ts';
import type { TwilioOptions } from './whatsapp/twilio.ts';

export interface Config {
  messagingProvider?: 'meta' | 'twilio';
  twilio?: TwilioOptions;
  port: number;
  whatsapp: {
    token: string;
    phoneNumberId: string;
    appSecret: string;
    verifyToken: string;
  };
  ownerPhone: string;
  ownerName: string;
  /** Public origin customers reach the signing page on. */
  publicBaseUrl: string;
  dbPath: string;
  mediaDirectory: string;
  mediaKey: Buffer;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  /** 'openai' | 'anthropic', or null to pick by whichever key is set. */
  valuatorProvider: string | null;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string, hint: string): string => {
    const value = env[name];
    if (!value) throw new ConfigError(`${name} is not set. ${hint}`);
    return value;
  };

  const mediaKeyHex = required(
    'EPPIC_MEDIA_KEY',
    'Generate one with `openssl rand -hex 32` and keep it out of the repository — it decrypts customer ID photos.',
  );
  if (!/^[0-9a-f]{64}$/i.test(mediaKeyHex)) {
    throw new ConfigError('EPPIC_MEDIA_KEY must be 64 hex characters (32 bytes).');
  }

  const provider = env['MESSAGING_PROVIDER'] ?? 'meta';
  if (provider !== 'meta' && provider !== 'twilio') throw new ConfigError('MESSAGING_PROVIDER must be meta or twilio.');
  const publicBaseUrl = (env['PUBLIC_BASE_URL'] ?? `http://localhost:${Number(env['PORT'] ?? 8080)}`).replace(/\/$/, '');
  let twilio: TwilioOptions | undefined;
  if (provider === 'twilio') {
    const origin = new URL(publicBaseUrl);
    if (origin.protocol !== 'https:' || origin.origin !== publicBaseUrl) {
      throw new ConfigError('Twilio requires PUBLIC_BASE_URL to be the exact public HTTPS origin, without a path.');
    }
    const accountSid = required('TWILIO_ACCOUNT_SID', 'Find it on the Twilio account dashboard.');
    const from = required('TWILIO_WHATSAPP_FROM', 'The sandbox or approved sender, as whatsapp:+countrycodeNumber.');
    if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || !/^whatsapp:\+[1-9]\d{7,14}$/.test(from)) {
      throw new ConfigError('Invalid Twilio Account SID or WhatsApp sender.');
    }
    if (from.slice('whatsapp:'.length) === normalizePhone(env['OWNER_PHONE'] ?? '')) {
      throw new ConfigError('The owner and Twilio business sender must be different numbers.');
    }
    let contentSids: Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(env['TWILIO_CONTENT_SIDS'] ?? '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          Object.values(parsed).some((sid) => typeof sid !== 'string' || !/^HX[0-9a-f]{32}$/i.test(sid))) throw new Error();
      contentSids = parsed as Record<string, string>;
    } catch { throw new ConfigError('TWILIO_CONTENT_SIDS must be a JSON object mapping template names to approved HX Content SIDs.'); }
    twilio = { accountSid, authToken: required('TWILIO_AUTH_TOKEN', 'Store this only in your cloud secret settings.'), from, contentSids };
  }
  const metaRequired = (name: string, hint: string): string => provider === 'meta' ? required(name, hint) : '';

  return {
    messagingProvider: provider,
    twilio,
    port: Number(env['PORT'] ?? 8080),
    whatsapp: {
      token: metaRequired('WHATSAPP_TOKEN', 'This is the permanent access token from the Meta app.'),
      phoneNumberId: metaRequired('WHATSAPP_PHONE_NUMBER_ID', 'Found under WhatsApp > API Setup in the Meta dashboard.'),
      appSecret: metaRequired('WHATSAPP_APP_SECRET', 'Meta app secret — used to verify that webhooks really come from Meta.'),
      verifyToken: metaRequired('WHATSAPP_VERIFY_TOKEN', 'Any string you choose; paste the same one into the Meta webhook setup.'),
    },
    ownerPhone: normalizePhone(required('OWNER_PHONE', "Lukas's WhatsApp number, e.g. 081 282 3046.")),
    ownerName: env['OWNER_NAME'] ?? 'Lukas',
    publicBaseUrl,
    dbPath: resolve(env['EPPIC_DB_PATH'] ?? 'data/eppic.db'),
    mediaDirectory: resolve(env['EPPIC_MEDIA_DIR'] ?? 'data/media'),
    mediaKey: Buffer.from(mediaKeyHex, 'hex'),
    anthropicApiKey: env['ANTHROPIC_API_KEY'] ?? null,
    openaiApiKey: env['OPENAI_API_KEY'] ?? null,
    valuatorProvider: env['VALUATOR_PROVIDER'] ?? null,
  };
}

