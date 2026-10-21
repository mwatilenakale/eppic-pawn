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
import { chooseCategoryPage, landingPage, outcomePage, questionsPage } from './web/pages.ts';
import { dashboardPage } from './web/dashboard.ts';
import { DashboardQuery } from './dashboard/index.ts';
import { can } from './staff/access.ts';
import { evaluatePrecheck, precheckQuestions, type PrecheckQuote } from './web/precheck.ts';
import { PriceMemory } from './valuator/memory.ts';
import { suggestValuation } from './valuation.ts';
import { percentOf } from './money.ts';
import type { Rules } from './playbook/index.ts';

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

  const memory = new PriceMemory(store, rules);
  const valuator =
    overrides.valuator === undefined
      ? createValuator(
          { openai: config.openaiApiKey, anthropic: config.anthropicApiKey, provider: config.valuatorProvider },
          rules,
          memory,
        )
      : overrides.valuator;

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

  /**
   * Step 3 of the design: what the "Researching..." state is actually doing.
   *
   * An adjustment Lukas made in the last fortnight beats a fresh estimate —
   * his correction is a fact about what this shop pays, the estimate is a
   * guess. With neither, the customer gets no figure rather than an invented
   * one, and is asked to send it to him.
   */
  const priceIt = async (categorySlug: string, variant: string | null, description: string): Promise<PrecheckQuote | null> => {
    const remembered = memory.recall({ categorySlug, variant, description });
    if (remembered) {
      return {
        marketValueCents: remembered.assessedValueCents ?? remembered.loanCents * 2,
        assessedValueCents: remembered.assessedValueCents ?? remembered.loanCents * 2,
        loanCents: remembered.loanCents,
        buyNowCents: remembered.buyNowCents ?? buyNowFrom(remembered.loanCents, rules),
        fromAdjustment: true,
        belowMinimum: remembered.loanCents < rules.playbook.loanSizing.minimumLoanCents,
        minimumLoanCents: rules.playbook.loanSizing.minimumLoanCents,
      };
    }

    if (!valuator || !description.trim()) return null;

    try {
      const estimates = await valuator.estimate({ description, categorySlug, variant });
      if (estimates.length === 0) return null;
      const valuation = suggestValuation(estimates, rules);
      return {
        marketValueCents: valuation.basis.amountCents,
        assessedValueCents: valuation.assessedValueCents,
        loanCents: valuation.suggestedLoanCents,
        buyNowCents: valuation.buyNowCents,
        fromAdjustment: false,
        belowMinimum: valuation.belowMinimum,
        minimumLoanCents: rules.playbook.loanSizing.minimumLoanCents,
      };
    } catch (error) {
      // A failed estimate is not a failed application: the customer still gets
      // their screening result and the handoff, just without a figure.
      console.error('[server] valuation failed', error);
      return null;
    }
  };

  const server = createServer((request, response) => {
    handleRequest(request, response, config, router, contracts, store, priceIt).catch((error) => {
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
  store: Store,
  priceIt: (categorySlug: string, variant: string | null, description: string) => Promise<PrecheckQuote | null>,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const rules = getRules();

  if (request.method === 'GET' && url.pathname === '/health') {
    return respond(response, 200, 'ok');
  }

  // --- the public website (architecture step 6) ---------------------------
  if (request.method === 'GET' && url.pathname === '/') {
    return respondHtml(response, 200, landingPage(rules));
  }

  // --- the staff dashboard ------------------------------------------------
  //
  // Reached with a signed link, which is how a phone with no login identifies
  // the person holding it. An unknown token and a revoked one are deliberately
  // indistinguishable from outside: both get the same 404 as a URL that was
  // never a route, so the page cannot be found by guessing.
  const staffLink = /^\/staff\/([A-Za-z0-9_-]{20,64})\/?$/.exec(url.pathname);
  if (request.method === 'GET' && staffLink) {
    const user = store.staffByToken(staffLink[1]!);
    if (!user || !can(user, 'book.chase')) return respond(response, 404, 'Not found');

    const dashboard = new DashboardQuery(store, rules).read();
    return respondHtml(response, 200, dashboardPage(dashboard, user.name, can(user, 'book.totals')));
  }

  if (request.method === 'GET' && url.pathname === '/apply') {
    const wanted = url.searchParams.get('category');
    if (!wanted) return respondHtml(response, 200, chooseCategoryPage(rules));

    const category = rules.category(wanted);
    if (!category) {
      // Not "we don't take that" — whether the shop takes something is
      // Lukas's call, not the website's (playbook section 2). The page offers
      // the five it can price now and the number where he gets asked.
      return respondHtml(
        response,
        404,
        chooseCategoryPage(rules, `We don't normally take ${wanted}, but it isn't an automatic no.`),
      );
    }

    const variant = url.searchParams.get('variant');
    return respondHtml(
      response,
      200,
      questionsPage(rules, category, variant, precheckQuestions(rules, category.slug, variant)),
    );
  }

  if (request.method === 'POST' && url.pathname === '/apply') {
    const form = new URLSearchParams((await readBody(request)).toString('utf8'));
    const answers = Object.fromEntries([...form.entries()].filter(([key]) => !['category', 'variant', 'description'].includes(key)));

    const category = rules.category(form.get('category') ?? '');
    const description = form.get('description') ?? '';

    // Step 3 of the design — the research the loader stands for. Lukas's own
    // recent adjustment for this kind of item wins over a fresh estimate
    // (playbook section 3); a valuation only happens if there is none.
    const quote = category ? await priceIt(category.slug, form.get('variant'), description) : null;

    const outcome = evaluatePrecheck(rules, {
      category: form.get('category') ?? '',
      variant: form.get('variant'),
      description,
      answers,
      quote,
    });

    if (category) {
      store.recordPrecheck({
        categorySlug: category.slug,
        variant: form.get('variant'),
        description,
        answers: outcome.answers,
        status: outcome.status,
      });
    }

    return respondHtml(response, 200, outcomePage(outcome, rules.playbook.whatsapp));
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
        return respondHtml(response, 200, contract.status === 'signed' ? signedPage(contract, rules.playbook.whatsapp) : signingPage(contract));
      } catch (error) {
        return respondHtml(response, 404, contractErrorPage(messageFor(error), rules.playbook.whatsapp));
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
      return respondHtml(response, 200, signedPage(signed.contract, rules.playbook.whatsapp));
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
    // Everything this app serves is either a contract or a form: never cached.
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

/** A remembered adjustment may predate the buy-now rule; derive it if so. */
function buyNowFrom(loanCents: number, rules: Rules): number {
  return loanCents + percentOf(loanCents, rules.playbook.loanSizing.buyNowMarkupPct);
}
