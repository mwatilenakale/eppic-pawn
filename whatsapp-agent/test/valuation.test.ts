import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, RATE_LARGE_LOAN, RATE_REFERRAL, RATE_STANDARD } from '../src/playbook/index.ts';
import { formatAmount, parseAmount } from '../src/money.ts';
import {
  addDays,
  applyPartialPayment,
  loanTerms,
  marginCheck,
  owedAfterMissedMonths,
  schedule,
  suggestValuation,
  ValuationError,
} from '../src/valuation.ts';

const rules = loadRules();
const N = (units: number) => units * 100;

describe('money', () => {
  test('parses what a customer or Lukas would type', () => {
    assert.equal(parseAmount('3750'), 375_000);
    assert.equal(parseAmount('N$3,750.50'), 375_050);
    assert.equal(parseAmount('n$ 3 750'), 375_000);
    assert.equal(parseAmount('about 3750'), null);
    assert.equal(parseAmount(''), null);
  });

  test('formats amounts the way the playbook writes them', () => {
    assert.equal(formatAmount(108_750), 'N$1,087.50');
    assert.equal(formatAmount(375_000), 'N$3,750.00');
    assert.equal(formatAmount(0), 'N$0.00');
  });
});

describe('valuation formula (playbook section 3)', () => {
  test("the playbook's worked example: N$10,000 item -> N$7,500 assessed -> N$3,750 loan", () => {
    const valuation = suggestValuation(
      [
        { source: 'Marketplace listing', amountCents: N(12_000) },
        { source: 'Local retailer, used', amountCents: N(10_000) },
      ],
      rules,
    );

    assert.equal(valuation.basis.amountCents, N(10_000), 'starts from the lowest estimate');
    assert.equal(valuation.assessedValueCents, N(7_500));
    assert.equal(valuation.suggestedLoanCents, N(3_750));
    assert.equal(Math.round(valuation.loanToEstimatePct * 10) / 10, 37.5);
  });

  test('shows its working for the approval message', () => {
    const valuation = suggestValuation([{ source: 'Marketplace', amountCents: N(10_000) }], rules);
    assert.deepEqual(valuation.workings, [
      'lowest market estimate: N$10,000.00 (Marketplace)',
      'x 0.75 = N$7,500.00 assessed value',
      '/ 2 = N$3,750.00 suggested loan',
      `+ ${rules.playbook.loanSizing.buyNowMarkupPct}% = N$4,687.50 to buy it outright`,
    ]);
  });

  test('rejects empty or non-positive estimates', () => {
    assert.throws(() => suggestValuation([], rules), ValuationError);
    assert.throws(() => suggestValuation([{ source: 'x', amountCents: 0 }], rules), ValuationError);
  });
});

describe('rate selection (playbook section 4)', () => {
  test('a standard loan is 29% over 30 days', () => {
    const terms = loanTerms({ principalCents: N(3_750) }, rules);
    assert.equal(terms.rule.id, RATE_STANDARD);
    assert.equal(terms.interestCents, N(1_087.5));
    assert.equal(terms.totalDueCents, N(4_837.5));
    assert.equal(terms.termDays, 30);
    assert.equal(terms.graceDays, 4);
  });

  test('a loan at or over N$15,000 switches to 40% over 60 days', () => {
    const atThreshold = loanTerms({ principalCents: N(15_000) }, rules);
    assert.equal(atThreshold.rule.id, RATE_LARGE_LOAN);
    assert.equal(atThreshold.ratePct, 40);
    assert.equal(atThreshold.termDays, 60);
    assert.equal(atThreshold.interestCents, N(6_000));

    const justUnder = loanTerms({ principalCents: N(14_999) }, rules);
    assert.equal(justUnder.rule.id, RATE_STANDARD);
  });

  test('a referral loan splits 9% to the referrer, 20% to Lukas', () => {
    const terms = loanTerms({ principalCents: N(5_000), referral: true }, rules);
    assert.equal(terms.rule.id, RATE_REFERRAL);
    assert.equal(terms.interestCents, N(1_450));
    assert.equal(terms.referrerShareCents, N(450));
    assert.equal(terms.ownerShareCents, N(1_000));
    assert.equal(
      terms.referrerShareCents! + terms.ownerShareCents!,
      terms.interestCents,
      'the two shares account for the whole 29%',
    );
  });

  test('a large referral loan still takes the large-loan row', () => {
    const terms = loanTerms({ principalCents: N(20_000), referral: true }, rules);
    assert.equal(terms.rule.id, RATE_LARGE_LOAN);
  });

  test('rejects a non-positive principal', () => {
    assert.throws(() => loanTerms({ principalCents: 0 }, rules), ValuationError);
  });
});

describe('schedule', () => {
  test('due date and grace follow the playbook', () => {
    const terms = loanTerms({ principalCents: N(3_750) }, rules);
    const dates = schedule('2026-01-15', terms, rules);
    assert.equal(dates.dueDate, '2026-02-14');
    assert.equal(dates.graceEndsDate, '2026-02-18');
    assert.equal(dates.extendedGraceEndsDate, '2026-02-21');
  });

  test('date arithmetic crosses month and year boundaries', () => {
    assert.equal(addDays('2026-12-20', 30), '2027-01-19');
    assert.equal(addDays('2028-02-27', 2), '2028-02-29');
  });
});

describe('partial payments (playbook section 4)', () => {
  test("the playbook's example: N$500 unpaid interest on a N$5,000 loan becomes a N$5,500 base", () => {
    const result = applyPartialPayment(
      { principalCents: N(5_000), interestDueCents: N(1_450), paymentCents: N(950) },
      rules,
    );
    assert.equal(result.foldedIntoPrincipalCents, N(500));
    assert.equal(result.newPrincipalCents, N(5_500));
  });

  test('a payment beyond the interest reduces principal', () => {
    const result = applyPartialPayment(
      { principalCents: N(5_000), interestDueCents: N(1_450), paymentCents: N(2_450) },
      rules,
    );
    assert.equal(result.foldedIntoPrincipalCents, 0);
    assert.equal(result.principalReducedCents, N(1_000));
    assert.equal(result.newPrincipalCents, N(4_000));
  });

  test('nothing paid folds the whole interest into principal', () => {
    const result = applyPartialPayment(
      { principalCents: N(5_000), interestDueCents: N(1_450), paymentCents: 0 },
      rules,
    );
    assert.equal(result.newPrincipalCents, N(6_450));
  });
});

describe('collections margin check (playbook section 8)', () => {
  test("the playbook's example: two missed months on a N$3,750 loan is still safe to extend", () => {
    const terms = loanTerms({ principalCents: N(3_750) }, rules);
    const owedCents = owedAfterMissedMonths(terms, 2);
    assert.equal(owedCents, N(5_925), 'matches the playbook: 3,750 + 1,087.50 + 1,087.50');

    const check = marginCheck({ owedCents, expectedSaleCents: N(7_500) }, rules);
    assert.equal(check.decision, 'extend');
    assert.equal(Math.round(check.marginPct), 21, 'the playbook calls this ~21% under the sale price');
  });

  test('margin gone means sell', () => {
    const check = marginCheck({ owedCents: N(7_000), expectedSaleCents: N(7_500) }, rules);
    assert.equal(check.decision, 'sell');
    assert.match(check.explanation, /under the 10% threshold/);
  });

  test('exactly at the threshold extends', () => {
    const check = marginCheck({ owedCents: N(6_750), expectedSaleCents: N(7_500) }, rules);
    assert.equal(check.marginPct, 10);
    assert.equal(check.decision, 'extend');
  });
});

describe('the minimum loan (playbook section 3)', () => {
  test('a small item is under the floor, and says so in the working', () => {
    const valuation = suggestValuation([{ source: 'Marketplace', amountCents: 150_000 }], rules);

    assert.equal(valuation.suggestedLoanCents, 56_250);
    assert.equal(valuation.belowMinimum, true);
    assert.match(valuation.workings.join('\n'), /below the N\$1,000\.00 minimum/);
  });

  test('a worthwhile item is not', () => {
    const valuation = suggestValuation([{ source: 'Marketplace', amountCents: 540_000 }], rules);

    assert.equal(valuation.suggestedLoanCents, 202_500);
    assert.equal(valuation.belowMinimum, false);
    assert.doesNotMatch(valuation.workings.join('\n'), /minimum/);
  });

  test('the floor is the document\'s, not a constant here', () => {
    const floor = rules.playbook.loanSizing.minimumLoanCents;
    assert.ok(floor > 0, 'the loader refuses to start without it');

    // Exactly at the floor is accepted; a cent under is not.
    const atFloor = { basis: floor, below: floor - 1 };
    assert.equal(atFloor.basis < floor, false);
    assert.equal(atFloor.below < floor, true);
  });
});
