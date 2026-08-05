import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultRulesPaths,
  loadRules,
  PlaybookError,
  RATE_FAVOR,
  RATE_LARGE_LOAN,
  RATE_REFERRAL,
  RATE_STANDARD,
} from '../src/playbook/index.ts';

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
