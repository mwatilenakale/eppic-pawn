/** Report-only diagnostic for task 009. Never import into production.
 * Fictional records, in-memory SQLite, MemoryTransport and a fixed MOCK market
 * estimate. No provider/network calls except the local HTTP server/browser.
 * Run under Node 24 with the bundled Playwright path supplied via AUDIT_PLAYWRIGHT.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { Store } from '../src/store/index.ts';
import { buildServer } from '../src/server.ts';
import { MemoryTransport } from '../src/whatsapp/transport.ts';
import { getRules } from '../src/playbook/index.ts';
import { precheckQuestions } from '../src/web/precheck.ts';

const output = resolve('audits/website-review-output'); mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'eppic-website-review-'));
const store = new Store(':memory:', { mediaDirectory: temporary, mediaKey: randomBytes(32) });
const memory = new MemoryTransport(); let estimates = 0;
const built = buildServer({ port: 0, whatsapp: { token: '', phoneNumberId: '', appSecret: '', verifyToken: '' },
  ownerPhone: '+264811110000', ownerName: 'Lukas', publicBaseUrl: 'http://127.0.0.1', dbPath: ':memory:',
  mediaDirectory: temporary, mediaKey: randomBytes(32), anthropicApiKey: null, openaiApiKey: null, valuatorProvider: null },
  { store, transport: memory, valuator: { estimate: async () => { estimates++; return [{ source: 'MOCK audit fixture — not a live market price', amountCents: 1_045_000 }]; } } });
built.server.listen(0, '127.0.0.1'); await once(built.server, 'listening');
const base = `http://127.0.0.1:${(built.server.address() as { port: number }).port}`;
const rules = getRules();
const description = 'iPhone 15, 128GB, box, 95% battery health, no damage';
const fields = new URLSearchParams({ category: 'phones', variant: 'iphone', description });
for (const question of precheckQuestions(rules, 'phones', 'iphone')) fields.set(question.id, 'yes');
const post = async (body: string | URLSearchParams, type = 'application/x-www-form-urlencoded') => {
  const before = estimates; const response = await fetch(`${base}/apply`, { method: 'POST', headers: { 'content-type': type }, body });
  const html = await response.text();
  return { status: response.status, calls: estimates - before, html };
};
const evidence: Record<string, unknown> = { base, fixturePriceCents: 1_045_000, screenshots: [], scenarios: {} };
const scenarios = evidence.scenarios as Record<string, unknown>;
const owner = store.ensureUser({ name: 'Fictional owner', phone: '+264811110000', role: 'owner' });
const customer = store.upsertCustomer('+264811110001', 'Fictional Audit Customer');
const item = store.createItem({ customerId: customer.id, categorySlug: 'phones', variant: 'iphone', description });
const approval = store.createApproval({ itemId: item.id, suggestedLoanCents: 391_875 });
// Isolated fixture setup, never a production auto-approval path.
store.decideApproval({ approvalId: approval.id, status: 'approved', approvedLoanCents: 391_875, decidedBy: owner.id });
const issued = built.contracts.issueForApproval(approval.id, { actor: owner.id });
const signing = `${base}/c/${issued.contract.token}`;
let browser: any;
try {
  const modulePath = process.env['AUDIT_PLAYWRIGHT'];
  if (!modulePath) throw new Error('Set AUDIT_PLAYWRIGHT to the installed Playwright module path');
  const { chromium } = await import(modulePath);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  // Prevent accidental navigation/calls to WhatsApp or any real provider.
  await context.route('**/*', (route: any) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  const page = await context.newPage();
  const screenshots: string[] = [];
  const capture = async (name: string, url?: string) => {
    if (url) await page.goto(url);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true }); screenshots.push(`${name}.png`);
    return await page.evaluate(() => ({ title: document.title, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight, headings: [...document.querySelectorAll('h1,h2')].map(e => e.textContent),
      links: [...document.querySelectorAll('a')].map(e => ({ text: e.textContent?.trim(), href: e.getAttribute('href') })) }));
  };
  scenarios.home = await capture('01-home-mobile', base);
  scenarios.reducedMotionCategories = await page.locator('.category-card').evaluateAll((elements: Element[]) => elements.map(e => ({
    label: e.textContent?.trim(), opacity: getComputedStyle(e.parentElement!).opacity, animation: getComputedStyle(e.parentElement!).animationName })));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await capture('01-home-mobile-standard-motion', base);
  scenarios.variant = await capture('02-phone-type-mobile', `${base}/apply?category=phones`);
  scenarios.details = await capture('03-details-mobile', `${base}/apply?category=phones&variant=iphone`);
  await page.locator('#description').fill(description);
  for (const question of precheckQuestions(rules, 'phones', 'iphone')) await page.locator(`input[name="${question.id}"][value="yes"]`).check({ force: true });
  await page.getByRole('button', { name: 'Research market value' }).click(); await page.waitForLoadState();
  scenarios.quote = await capture('04-estimate-mobile');
  const quoteHtml = await page.content(); writeFileSync(join(output, 'estimate.html'), quoteHtml);
  scenarios.contrast = await page.locator('.price-row .dim').first().evaluate((element: Element) => ({ color: getComputedStyle(element).color,
    background: getComputedStyle(element.closest('.card')!).backgroundColor, fontSize: getComputedStyle(element).fontSize }));
  scenarios.signing = await capture('05-signing-mobile', signing);
  const loansBefore = (store.db.prepare('SELECT COUNT(*) n FROM loans').get() as { n: number }).n;
  await page.locator('#name').fill('Fictional Audit Customer'); await page.locator('#idNumber').fill('00000000000');
  const pad = page.locator('#pad'); await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  await page.mouse.move(box!.x + 30, box!.y + 70); await page.mouse.down();
  await page.mouse.move(box!.x + 130, box!.y + 90); await page.mouse.move(box!.x + 200, box!.y + 60); await page.mouse.up();
  const beforeResize = await pad.evaluate((e: HTMLCanvasElement) => [...e.getContext('2d')!.getImageData(0, 0, e.width, e.height).data].some((v, i) => i % 4 === 3 && v > 0));
  await page.setViewportSize({ width: 412, height: 844 });
  await page.waitForTimeout(250);
  const afterResize = await pad.evaluate((e: HTMLCanvasElement) => [...e.getContext('2d')!.getImageData(0, 0, e.width, e.height).data].some((v, i) => i % 4 === 3 && v > 0));
  scenarios.signatureResize = { beforeResize, afterResize, submitEnabledAfterResize: await page.locator('#submit').isEnabled() };
  await page.getByRole('button', { name: 'Sign contract' }).click(); await page.waitForLoadState();
  scenarios.signed = await capture('06-signed-mobile');
  scenarios.signingAccounting = { loansBefore, loansAfter: (store.db.prepare('SELECT COUNT(*) n FROM loans').get() as { n: number }).n,
    entries: store.db.prepare('SELECT entry_type, amount_cents FROM ledger_entries').all(),
    contractStartDate: issued.contract.start_date, dueDate: issued.contract.due_date,
    pageSaysLoanStartsAtHandover: (await page.content()).includes('The loan starts') };
  await page.setViewportSize({ width: 1440, height: 1000 }); await capture('07-home-desktop', base);
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 844 }); await page.goto(`${base}/apply?category=phones&variant=iphone`);
    scenarios[`detailsWidth${width}`] = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  }
  await page.locator('#description').focus(); await page.keyboard.press('Tab');
  scenarios.keyboardRadioFocus = await page.evaluate(() => { const e = document.activeElement as HTMLElement; return { tag: e.tagName,
    type: e.getAttribute('type'), opacity: getComputedStyle(e).opacity, parentOutline: getComputedStyle(e.parentElement!).outlineStyle }; });
  await page.goto(signing);
  scenarios.signedHeaders = { cacheControl: (await fetch(signing)).headers.get('cache-control'),
    referrerPolicy: (await fetch(signing)).headers.get('referrer-policy') };
  scenarios.invalidVariant = { status: (await fetch(`${base}/apply?category=phones&variant=not-a-phone`)).status,
    hasForm: (await (await fetch(`${base}/apply?category=phones&variant=not-a-phone`)).text()).includes('id="description"') };
  scenarios.noCategory = await post('description=hello');
  scenarios.wrongContentType = await post(fields, 'text/plain');
  scenarios.jsonContentType = await post(JSON.stringify(Object.fromEntries(fields)), 'application/json');
  const duplicate = new URLSearchParams(fields); duplicate.append('category', 'cars'); duplicate.append('description', 'different item');
  scenarios.duplicateFields = await post(duplicate);
  const missingStorage = new URLSearchParams(fields); missingStorage.set('description', 'iPhone 15, box, 95% battery');
  scenarios.missingStorage = await post(missingStorage);
  scenarios.answersAfterValidation = { yesSelected: ((scenarios.missingStorage as any).html.match(/value="yes" checked/g) ?? []).length,
    unsureSelected: ((scenarios.missingStorage as any).html.match(/value="not sure" checked/g) ?? []).length };
  const personal = new URLSearchParams(fields); personal.set('description', 'iPhone 15 128GB 95% battery; fictional ID 00000000000 phone +264811110009');
  await post(personal);
  scenarios.anonymousStorage = store.db.prepare('SELECT description, answers FROM prechecks ORDER BY rowid DESC LIMIT 1').get();
  const beforeAbuse = estimates; const rowsBefore = (store.db.prepare('SELECT COUNT(*) n FROM prechecks').get() as { n: number }).n;
  for (let i = 0; i < 100; i++) await post(fields);
  scenarios.repeatSubmissions = { requests: 100, estimateCalls: estimates - beforeAbuse,
    rowsAdded: (store.db.prepare('SELECT COUNT(*) n FROM prechecks').get() as { n: number }).n - rowsBefore };
  const long = new URLSearchParams(fields); long.set('description', `${description} ${'x'.repeat(100_000)}`);
  scenarios.longDescription = await post(long);
  scenarios.largeRequest = await fetch(`${base}/apply`, { method: 'POST', body: 'x'.repeat(5_000_001) })
    .then(r => ({ status: r.status })).catch(e => ({ error: e.cause?.code ?? e.message }));
  evidence.screenshots = screenshots;
  // Keep diagnostic output concise: HTML is locally captured but not duplicated in JSON.
  for (const value of Object.values(scenarios)) if (value && typeof value === 'object' && 'html' in value) {
    const v = value as any; v.heading = v.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]; delete v.html;
  }
  writeFileSync(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await browser?.close(); await built.shutdown(); }
