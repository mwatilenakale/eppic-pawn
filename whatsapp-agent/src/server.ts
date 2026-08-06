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
import { ContractError } from './store/index.ts';
import { ContractService, contractErrorPage, signedPage, signingPage } from './contract/index.ts';
import { CustomerDirectory } from './customers/directory.ts';

export interface BuiltServer {
  server: Server;
  store: Store;
  router: AgentRouter;
  contracts: ContractService;
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

  const contracts = new ContractService(store, rules, { baseUrl: config.publicBaseUrl });
  const directory = new CustomerDirectory(store);

  const router = new AgentRouter({
    store,
    rules,
    transport,
    ownerPhone: config.ownerPhone,
    ownerName: config.ownerName,
    valuator: valuator ?? undefined,
    contracts,
    directory,
  });

  const server = createServer((request, response) => {
    handleRequest(request, response, config, router, contracts).catch((error) => {
      console.error('[server]', error);
      if (!response.headersSent) respond(response, 500, 'Internal error');
    });
  });

  return { server, store, router, contracts, config };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: Config,
  router: AgentRouter,
  contracts: ContractService,
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

  // --- the customer's signing page ---------------------------------------
  // The token in the link is the only credential, so the page is never cached
  // and never framed.
  const signing = /^\/c\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (signing && (request.method === 'GET' || request.method === 'POST')) {
    const token = signing[1]!;

    if (request.method === 'GET') {
      try {
        const contract = contracts.openForSigning(token);
        return respondHtml(response, 200, contract.status === 'signed' ? signedPage(contract) : signingPage(contract));
      } catch (error) {
        return respondHtml(response, 404, contractErrorPage(messageFor(error)));
      }
    }

    const form = new URLSearchParams((await readBody(request)).toString('utf8'));
    try {
      const signed = contracts.sign(token, {
        name: form.get('name') ?? '',
        idNumber: form.get('idNumber') ?? '',
        signatureDataUrl: form.get('signature') ?? '',
      });
      // Tell Lukas and the customer, but never fail the signature because a
      // WhatsApp message did not go out — the contract is already signed.
      router.announceSignature(signed).catch((error) => console.error('[server]', error));
      return respondHtml(response, 200, signedPage(signed.contract));
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      const contract = contracts.openForSigning(token);
      return respondHtml(response, 400, signingPage(contract, { error: messageFor(error) }));
    }
  }

  respond(response, 404, 'Not found');
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function respondHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(body);
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
