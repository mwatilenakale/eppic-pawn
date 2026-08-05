/**
 * Configuration, all from the environment. Nothing here has a default that
 * would let the agent run in a state that looks fine but isn't — a missing
 * WhatsApp token or media key stops start-up with a message that says what to
 * do about it.
 */

import { resolve } from 'node:path';
import { normalizePhone } from './whatsapp/webhook.ts';

export interface Config {
  port: number;
  whatsapp: {
    token: string;
    phoneNumberId: string;
    appSecret: string;
    verifyToken: string;
  };
  ownerPhone: string;
  ownerName: string;
  dbPath: string;
  mediaDirectory: string;
  mediaKey: Buffer;
  anthropicApiKey: string | null;
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

  return {
    port: Number(env['PORT'] ?? 8080),
    whatsapp: {
      token: required('WHATSAPP_TOKEN', 'This is the permanent access token from the Meta app.'),
      phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID', 'Found under WhatsApp > API Setup in the Meta dashboard.'),
      appSecret: required('WHATSAPP_APP_SECRET', 'Meta app secret — used to verify that webhooks really come from Meta.'),
      verifyToken: required('WHATSAPP_VERIFY_TOKEN', 'Any string you choose; paste the same one into the Meta webhook setup.'),
    },
    ownerPhone: normalizePhone(required('OWNER_PHONE', "Lukas's WhatsApp number, e.g. 081 282 3046.")),
    ownerName: env['OWNER_NAME'] ?? 'Lukas',
    dbPath: resolve(env['EPPIC_DB_PATH'] ?? 'data/eppic.db'),
    mediaDirectory: resolve(env['EPPIC_MEDIA_DIR'] ?? 'data/media'),
    mediaKey: Buffer.from(mediaKeyHex, 'hex'),
    anthropicApiKey: env['ANTHROPIC_API_KEY'] ?? null,
  };
}
