/**
 * The always-on webhook receiver (whatsapp-agent/CLAUDE.md, open question 2).
 *
 * Meta retries a webhook it doesn't get a fast 200 for, so the handler
 * acknowledges first and processes afterwards; duplicate deliveries are already
 * harmless because inbound messages are recorded by their WhatsApp id.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadConfig, type Config } from './config.ts';
import { getRules } from './playbook/index.ts';
import { Store } from './store/index.ts';
import { AgentRouter, type Valuator } from './router.ts';
import { CloudApiTransport, type WhatsAppTransport } from './whatsapp/transport.ts';
import { parseWebhookPayload, verifySignature, verifySubscription } from './whatsapp/webhook.ts';
import { createValuator } from './valuator/index.ts';

export interface BuiltServer {
  server: Server;
  store: Store;
  router: AgentRouter;
  config: Config;
}

export function buildServer(
  config: Config,
  overrides: { transport?: WhatsAppTransport; store?: Store; valuator?: Valuator | null } = {},
): BuiltServer {
  const rules = getRules();
  const store =
    overrides.store ??
    new Store(config.dbPath, { mediaDirectory: config.mediaDirectory, mediaKey: config.mediaKey });

  const transport =
    overrides.transport ??
    new CloudApiTransport({ token: config.whatsapp.token, phoneNumberId: config.whatsapp.phoneNumberId });

  const valuator =
    overrides.valuator === undefined ? createValuator(config.anthropicApiKey, rules) : overrides.valuator;

  const router = new AgentRouter({
    store,
    rules,
    transport,
    ownerPhone: config.ownerPhone,
    ownerName: config.ownerName,
    valuator: valuator ?? undefined,
  });

  const server = createServer((request, response) => {
    handleRequest(request, response, config, router).catch((error) => {
      console.error('[server]', error);
      if (!response.headersSent) respond(response, 500, 'Internal error');
    });
  });

  return { server, store, router, config };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: Config,
  router: AgentRouter,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    return respond(response, 200, 'ok');
  }

  if (request.method === 'GET' && url.pathname === '/webhook') {
    const result = verifySubscription(url.searchParams, config.whatsapp.verifyToken);
    return respond(response, result.status, result.body);
  }

  if (request.method === 'POST' && url.pathname === '/webhook') {
    const rawBody = await readBody(request);
    if (!verifySignature(rawBody, request.headers['x-hub-signature-256'] as string | undefined, config.whatsapp.appSecret)) {
      return respond(response, 401, 'Invalid signature');
    }

    let events;
    try {
      events = parseWebhookPayload(JSON.parse(rawBody.toString('utf8')));
    } catch {
      return respond(response, 400, 'Malformed payload');
    }

    // Acknowledge before doing the work, or Meta will redeliver.
    respond(response, 200, 'ok');
    for (const event of events) {
      await router.handle(event);
    }
    return;
  }

  respond(response, 404, 'Not found');
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 5_000_000) {
        reject(new Error('Webhook payload too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
}

/** `npm start` */
if (import.meta.filename === process.argv[1]) {
  const config = loadConfig();
  const { server, config: active } = buildServer(config);
  server.listen(active.port, () => {
    console.log(`Eppic WhatsApp agent listening on :${active.port}`);
    console.log(`Rules: ${getRules().paths.playbook}`);
    console.log(`Owner: ${active.ownerName} ${active.ownerPhone}`);
  });
}
