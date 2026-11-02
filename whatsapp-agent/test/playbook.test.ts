import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultRulesPaths,
  getRules,
  loadRules,
  PlaybookError,
  RATE_FAVOR,
  RATE_LARGE_LOAN,
  RATE_REFERRAL,
  RATE_STANDARD,
} from '../src/playbook/index.ts';
import { buildQuestionPlan } from '../src/intake/questions.ts';

const rules = loadRules();

describe('playbook loader', () => {
  test('reads the five accepted categories', () => {
    assert.deepEqual(
      rules.categories.map((category) => category.slug),
      ['cars', 'phones', 'laptops', 'tvs', 'consoles'],
    );
  });

  test('reads the loan-sizing formula', () => {
    assert.equal(rules.playbook.loanSizing.basis, 'lowest');
    assert.equal(rules.playbook.loanSizing.discountFactor, 0.75);
    assert.equal(rules.playbook.loanSizing.divisor, 2);
  });

  test('reads the standard rate: 29% over 30 days', () => {
    const standard = rules.rate(RATE_STANDARD);
    assert.equal(standard?.ratePct, 29);
    assert.equal(standard?.termDays, 30);
  });

  test('reads the large-loan rate: 40% over 60 days from N$15,000', () => {
    const large = rules.rate(RATE_LARGE_LOAN);
    assert.equal(large?.ratePct, 40);
    assert.equal(large?.termDays, 60);
    assert.equal(large?.minAmountCents, 1_500_000);
  });

  test('reads the referral split: 9% referrer / 20% owner', () => {
    const referral = rules.rate(RATE_REFERRAL);
    assert.equal(referral?.ratePct, 29);
    assert.equal(referral?.referrerSharePct, 9);
    assert.equal(referral?.ownerSharePct, 20);
  });

  test('reads the favour-loan cap of N$500', () => {
    assert.equal(rules.rate(RATE_FAVOR)?.capAmountCents, 50_000);
  });

  test('reads grace period, compounding and margin threshold', () => {
    assert.equal(rules.playbook.grace.defaultDays, 4);
    assert.equal(rules.playbook.grace.flexibleUpToDays, 7);
    assert.equal(rules.playbook.partialPaymentCompounds, true);
    assert.equal(rules.playbook.collections.marginThresholdPct, 10);
  });

  test('reads the documents required on every loan', () => {
    const requirements = rules.playbook.requirements.join(' | ').toLowerCase();
    assert.match(requirements, /copy of id/);
    assert.match(requirements, /proof of ownership/);
    assert.match(requirements, /signed agreement/);
    assert.match(requirements, /police declaration/);
  });
});

describe('checklists', () => {
  test('every accepted category has screening questions', () => {
    for (const category of rules.categories) {
      assert.ok(
        rules.checklistFor(category.slug).length > 0,
        `${category.slug} has no checklist`,
      );
    }
  });

  test('phones expose iPhone and Android variants', () => {
    assert.deepEqual(
      rules.variantsFor('phones').map((group) => group.variant),
      ['iphone', 'android'],
    );
  });

  test('iPhone intake asks the iPhone fraud checks and not the Android ones', () => {
    const iphone = rules.checklistFor('phones', 'iphone').map((item) => item.text).join(' | ');
    assert.match(iphone, /Activation Lock/i);
    assert.doesNotMatch(iphone, /Factory Reset Protection/i);

    const android = rules.checklistFor('phones', 'android').map((item) => item.text).join(' | ');
    assert.match(android, /Factory Reset Protection/i);
  });

  test('checklists combine playbook screening with architecture fraud checks', () => {
    const console_ = rules.checklistFor('consoles');
    assert.ok(console_.some((item) => item.source === 'playbook'));
    assert.ok(console_.some((item) => item.source === 'fraud'));
    // Playbook section 6 marks the console test method [decide] — not yet policy.
    assert.ok(console_.some((item) => item.provisional));
  });

  test('car checks include the finance-settlement and VIN cross-check', () => {
    const cars = rules.checklistFor('cars').map((item) => item.text).join(' | ');
    assert.match(cars, /VIN/i);
    assert.match(cars, /finance settlement/i);
    assert.match(cars, /mechanic/i);
  });

  test('checklist item ids are unique per category', () => {
    for (const category of rules.categories) {
      const ids = rules.checklistFor(category.slug).map((item) => item.id);
      assert.equal(new Set(ids).size, ids.length, `${category.slug} has duplicate ids`);
    }
  });
});

describe('category matching', () => {
  test('matches what a customer is likely to type', () => {
    assert.equal(rules.category('phone')?.slug, 'phones');
    assert.equal(rules.category('iPhone')?.slug, 'phones');
    assert.equal(rules.category('my laptop')?.slug, 'laptops');
    assert.equal(rules.category('TV')?.slug, 'tvs');
    assert.equal(rules.category('PS5 console')?.slug, 'consoles');
    assert.equal(rules.category('car')?.slug, 'cars');
  });

  test('rejects categories the playbook does not accept', () => {
    assert.equal(rules.category('bed'), null);
    assert.equal(rules.category('fridge'), null);
    assert.equal(rules.category(''), null);
  });
});

describe('failure behaviour', () => {
  test('an existing service sees edited rules without being rebuilt', () => {
    const paths = defaultRulesPaths();
    const dir = mkdtempSync(join(tmpdir(), 'eppic-live-rules-'));
    const playbook = join(dir, 'playbook.md');
    const architecture = join(dir, 'architecture.md');
    const original = readFileSync(paths.playbook, 'utf8');
    writeFileSync(playbook, original);
    copyFileSync(paths.architecture, architecture);
    const held = getRules({ playbook, architecture });
    const heldRateLookup = held.rate;

    writeFileSync(playbook, original.replace('29%', '31.5%').replace('N$1,000.**', 'N$1,200.**'));
    assert.equal(heldRateLookup(RATE_STANDARD)?.ratePct, 31.5);
    assert.equal(held.playbook.loanSizing.minimumLoanCents, 120_000);

    writeFileSync(playbook, '# Invalid rules');
    assert.throws(() => held.playbook, PlaybookError, 'invalid edits must not keep old prices alive');
  });

  test('a playbook whose rate table is gone throws instead of defaulting', () => {
    const paths = defaultRulesPaths();
    const dir = mkdtempSync(join(tmpdir(), 'eppic-rules-'));
    const brokenPlaybook = join(dir, 'playbook.md');
    const withoutRateTable = readFileSync(paths.playbook, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('|'))
      .join('\n');
    writeFileSync(brokenPlaybook, withoutRateTable);
    copyFileSync(paths.architecture, join(dir, 'architecture.md'));

    assert.throws(
      () => loadRules({ playbook: brokenPlaybook, architecture: join(dir, 'architecture.md') }),
      (error: unknown) => error instanceof PlaybookError && /section 4/.test((error as Error).message),
    );
  });

  test('a playbook with no screening section throws', () => {
    const paths = defaultRulesPaths();
    const dir = mkdtempSync(join(tmpdir(), 'eppic-rules-'));
    const brokenPlaybook = join(dir, 'playbook.md');
    writeFileSync(brokenPlaybook, '# Playbook\n\n## 2. What we accept\n\n- Phones\n');
    copyFileSync(paths.architecture, join(dir, 'architecture.md'));

    assert.throws(
      () => loadRules({ playbook: brokenPlaybook, architecture: join(dir, 'architecture.md') }),
      PlaybookError,
    );
  });
});

/**
 * Lukas editing the playbook in a Markdown app.
 *
 * He asked on 2 November 2026 about keeping `docs/` in Obsidian, which is a
 * reasonable thing to want: the playbook is his document and that is a better
 * place to write it than a code editor. So the question is what such an app
 * does to the file, and the answer was mostly "nothing" and once "something
 * bad and silent".
 *
 * A wrong heading level stops the server with a message naming the section —
 * loud, and the loader is built to throw rather than default. A wiki-link
 * parsed perfectly: every rate and threshold came out right, and the brackets
 * went to the customer, who was asked "Can you confirm: Must be a
 * [[Smart TV]]?".
 */
describe('the playbook survives being edited in a Markdown app', () => {
  const rulesFrom = (markdown: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'eppic-pb-')), 'playbook.md');
    writeFileSync(path, markdown);
    return loadRules({ playbook: path, architecture: defaultRulesPaths().architecture });
  };
  const real = () => readFileSync(defaultRulesPaths().playbook, 'utf8');

  test('properties at the top of the file change nothing', () => {
    const rules = rulesFrom(`---\ntags:\n  - business\nupdated: 2026-11-02\n---\n\n${real()}`);
    assert.equal(rules.playbook.collections.extensionCeilingPct, 75);
    assert.equal(rules.categories.length, 5);
  });

  test('a reformatted table changes nothing', () => {
    // Markdown linters love to re-pad table cells.
    const padded = real().replace(
      '| Standard (your capital) | 29% | 30 days | 100% you |',
      '|  Standard (your capital)  |  29%  |  30 days  |  100% you  |',
    );
    assert.equal(rulesFrom(padded).playbook.rates[0]!.ratePct, 29);
  });

  test('a wiki-link does not reach the customer', () => {
    const linked = real().replace(
      '- Must be a Smart TV; account/login removed',
      '- Must be a [[Smart TV]]; account/login removed',
    );
    const asked = buildQuestionPlan(rulesFrom(linked), 'tvs').questions.map((question) => question.ask).join('\n');
    assert.match(asked, /Must be a Smart TV/);
    assert.doesNotMatch(asked, /\[\[|\]\]/, 'the brackets used to go out as written');
  });

  test('a piped wiki-link keeps the words he meant to show', () => {
    const linked = real().replace('- Must be a Smart TV', '- Must be a [[smart-tv-note|Smart TV]]');
    const asked = buildQuestionPlan(rulesFrom(linked), 'tvs').questions.map((question) => question.ask).join('\n');
    assert.match(asked, /Must be a Smart TV/);
    assert.doesNotMatch(asked, /smart-tv-note/, 'the link target is not for the customer to read');
  });

  test('a wrong heading level is refused loudly, naming the section', () => {
    // The right failure: no rate is defaulted and the server will not start.
    const demoted = real().replace('## 4. Interest rates', '### 4. Interest rates');
    assert.throws(() => rulesFrom(demoted), /section 4 \(interest rates/i);
  });
});
