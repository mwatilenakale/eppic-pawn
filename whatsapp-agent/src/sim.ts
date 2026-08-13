/**
 * Terminal simulator: the whole flow — intake, approval, the reply back to the
 * customer — without a Meta account or a webhook URL.
 *
 *   npm run sim
 *
 * You type as the customer. `/lukas <reply>` types as Lukas. Everything runs
 * against an in-memory database, so nothing here touches real records.
 */

import { createInterface } from 'node:readline/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getRules } from './playbook/index.ts';
import { Store } from './store/index.ts';
import { AgentRouter } from './router.ts';
import { MemoryTransport } from './whatsapp/transport.ts';
import { createValuator } from './valuator/index.ts';
import { ContractService } from './contract/index.ts';
import { CustomerDirectory } from './customers/directory.ts';
import type { InboundEvent } from './whatsapp/webhook.ts';

const CUSTOMER = '+264811234567';
const OWNER = '+264812823046';

const HELP = `
Commands:
  <anything>        send it as the customer
  /photo            send a photo as the customer
  /lukas <reply>    send a reply as Lukas (e.g. /lukas approve A1B2 3000)
  /sign             sign the open contract, as the customer would on their phone
  /pending          list applications waiting for a decision
  /contract         show the agreement as plain text
  /duplicates       list customer records waiting for a same/different ruling
  /rules            show the rules currently loaded from the documents
  /quit             exit
`;

async function main(): Promise<void> {
  const rules = getRules();
  const store = new Store(':memory:', {
    mediaDirectory: mkdtempSync(join(tmpdir(), 'eppic-sim-')),
    mediaKey: randomBytes(32),
  });
  const transport = new MemoryTransport();
  const contracts = new ContractService(store, rules, { baseUrl: 'http://localhost:8080' });
  const directory = new CustomerDirectory(store);
  const router = new AgentRouter({
    contracts,
    directory,
    store,
    rules,
    transport,
    ownerPhone: OWNER,
    valuator:
      createValuator(
        {
          openai: process.env['OPENAI_API_KEY'] ?? null,
          anthropic: process.env['ANTHROPIC_API_KEY'] ?? null,
          provider: process.env['VALUATOR_PROVIDER'] ?? null,
        },
        rules,
      ) ?? undefined,
  });

  console.log('Eppic Pawn Shop — WhatsApp agent simulator');
  console.log(`Rules loaded from ${rules.paths.playbook}`);
  console.log(`Categories: ${rules.categories.map((category) => category.label).join(', ')}`);
  console.log(HELP);

  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let messageNumber = 0;

  const deliver = async (event: Omit<InboundEvent, 'messageId'>) => {
    const before = transport.sent.length;
    await router.handle({ ...event, messageId: `sim.${(messageNumber += 1)}` });
    for (const message of transport.sent.slice(before)) {
      const who = message.to === OWNER ? 'to Lukas' : 'to customer';
      console.log(`\n\x1b[36m[${who}]\x1b[0m ${message.body}\n`);
    }
  };

  try {
    for await (const raw of readline) {
      const line = raw.trim();
      if (!line) continue;

      if (line === '/quit' || line === '/exit') break;
      if (line === '/help') { console.log(HELP); continue; }

      if (line === '/pending') {
        const pending = store.pendingApprovals();
        console.log(pending.length === 0 ? 'Nothing waiting.' : pending.map((entry) => `  ${entry.id} — ${store.item(entry.item_id)?.description ?? ''}`).join('\n'));
        continue;
      }

      if (line === '/duplicates') {
        const pending = directory.pending();
        console.log(
          pending.length === 0
            ? 'No possible duplicates waiting.'
            : pending
                .map((entry) => `  ${entry.reference} — ${entry.records.map((record) => record.phone).join(' / ')} (${entry.reasons.join('; ')})`)
                .join('\n'),
        );
        continue;
      }

      if (line === '/rules') {
        const standard = rules.rate('standard');
        console.log(`  Loan sizing: ${rules.playbook.loanSizing.formula}`);
        console.log(`  Standard rate: ${standard?.ratePct}% over ${standard?.termDays} days`);
        console.log(`  Grace: ${rules.playbook.grace.defaultDays} days (up to ${rules.playbook.grace.flexibleUpToDays})`);
        continue;
      }

      if (line === '/contract' || line === '/sign') {
        const pending = store.db
          .prepare("SELECT * FROM contracts WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1")
          .get() as { id: string; token: string; number: string } | undefined;
        if (!pending) { console.log('No contract is waiting to be signed.'); continue; }

        if (line === '/contract') {
          console.log(`\n${store.contract(pending.id)!.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}\n`);
          continue;
        }

        // A 1x1 PNG stands in for what the signature pad would send.
        const signature =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        try {
          const signed = contracts.sign(pending.token, {
            name: 'Simulated Customer',
            idNumber: '90010100123',
            signatureDataUrl: signature,
          });
          console.log(`\n\x1b[32m[signed]\x1b[0m contract ${signed.contract.number}, loan ${signed.loanId}`);
          console.log(`         balance owed: ${store.balance(signed.loanId) / 100} NAD\n`);
          await router.announceSignature(signed);
          for (const message of transport.sent.slice(-2)) {
            console.log(`\x1b[36m[to ${message.to === OWNER ? 'Lukas' : 'customer'}]\x1b[0m ${message.body}\n`);
          }
        } catch (error) {
          console.log(`Could not sign: ${(error as Error).message}`);
        }
        continue;
      }

      if (line === '/photo') {
        await deliver({ from: CUSTOMER, type: 'image', mediaId: `sim-photo-${messageNumber}` });
        continue;
      }

      if (line.startsWith('/lukas')) {
        await deliver({ from: OWNER, type: 'text', text: line.slice('/lukas'.length).trim() });
        continue;
      }

      await deliver({ from: CUSTOMER, type: 'text', text: line });
    }
  } finally {
    readline.close();
    store.close();
  }
}

if (import.meta.filename === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
