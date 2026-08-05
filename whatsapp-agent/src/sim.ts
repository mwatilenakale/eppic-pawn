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
import type { InboundEvent } from './whatsapp/webhook.ts';

const CUSTOMER = '+264811234567';
const OWNER = '+264812823046';

const HELP = `
Commands:
  <anything>        send it as the customer
  /photo            send a photo as the customer
  /lukas <reply>    send a reply as Lukas (e.g. /lukas approve A1B2 3000)
  /pending          list applications waiting for a decision
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
  const router = new AgentRouter({
    store,
    rules,
    transport,
    ownerPhone: OWNER,
    valuator: createValuator(process.env['ANTHROPIC_API_KEY'] ?? null, rules) ?? undefined,
  });

  console.log('Eppic Pawn Shop — WhatsApp agent simulator');
  console.log(`Rules loaded from ${rules.paths.playbook}`);
  console.log(`Categories: ${rules.categories.map((category) => category.label).join(', ')}`);
  console.log(HELP);

  const readline = createInterface({ input: process.stdin, output: process.stdout });
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
    for (;;) {
      const line = (await readline.question('> ')).trim();
      if (!line) continue;

      if (line === '/quit' || line === '/exit') break;
      if (line === '/help') { console.log(HELP); continue; }

      if (line === '/pending') {
        const pending = store.pendingApprovals();
        console.log(pending.length === 0 ? 'Nothing waiting.' : pending.map((entry) => `  ${entry.id} — ${store.item(entry.item_id)?.description ?? ''}`).join('\n'));
        continue;
      }

      if (line === '/rules') {
        const standard = rules.rate('standard');
        console.log(`  Loan sizing: ${rules.playbook.loanSizing.formula}`);
        console.log(`  Standard rate: ${standard?.ratePct}% over ${standard?.termDays} days`);
        console.log(`  Grace: ${rules.playbook.grace.defaultDays} days (up to ${rules.playbook.grace.flexibleUpToDays})`);
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
