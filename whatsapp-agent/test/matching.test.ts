import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  editDistance,
  matchCustomers,
  nameSimilarity,
  normalizeIdNumber,
  normalizeName,
  shouldFlag,
} from '../src/customers/matching.ts';

describe('normalising what people type', () => {
  test('names lose titles, punctuation and accents', () => {
    assert.deepEqual(normalizeName('Mr. Johannes Shikongo'), ['johannes', 'shikongo']);
    assert.deepEqual(normalizeName('josé  da-silva'), ['jose', 'da', 'silva']);
    assert.deepEqual(normalizeName('   '), []);
  });

  test('ID numbers lose spacing and case', () => {
    assert.equal(normalizeIdNumber('90 01 01 00123'), '900101 00123'.replace(/\s/g, ''));
    assert.equal(normalizeIdNumber('90-01-01-00123'), '90010100123');
    assert.equal(normalizeIdNumber(null), '');
  });
});

describe('name similarity', () => {
  test('the same name in a different order still matches', () => {
    assert.equal(nameSimilarity('Johannes Shikongo', 'Shikongo Johannes'), 1);
  });

  test('an initial is a half match for the name it stands for', () => {
    const score = nameSimilarity('Johannes Shikongo', 'J Shikongo');
    assert.ok(score > 0.7 && score < 1, `expected a partial match, got ${score}`);
  });

  test('one typo is the same name; a different first name is not', () => {
    assert.ok(nameSimilarity('Johannes Shikongo', 'Johanes Shikongo') >= 0.85);
    assert.ok(nameSimilarity('Johannes Shikongo', 'Maria Shikongo') < 0.7);
    assert.ok(nameSimilarity('Johannes Shikongo', 'Petrus Amutenya') < 0.3);
  });

  test('an empty name matches nothing', () => {
    assert.equal(nameSimilarity('', 'Johannes Shikongo'), 0);
    assert.equal(nameSimilarity(null, null), 0);
  });

  test('edit distance behaves', () => {
    assert.equal(editDistance('shikongo', 'shikongo'), 0);
    assert.equal(editDistance('shikongo', 'shikong'), 1);
    assert.equal(editDistance('', 'abc'), 3);
  });
});

describe('matching two customer records', () => {
  test('the same ID number is decisive, whatever the names say', () => {
    const result = matchCustomers(
      { name: 'Johannes Shikongo', idNumber: '90010100123' },
      { name: 'J. Shikongo', idNumber: '90 01 01 00123' },
    );
    assert.equal(result.score, 1);
    assert.deepEqual(result.reasons, ['same ID number']);
    assert.ok(shouldFlag(result));
  });

  test('two different ID numbers rule the pair out, however alike the names', () => {
    const result = matchCustomers(
      { name: 'Johannes Shikongo', idNumber: '90010100123' },
      { name: 'Johannes Shikongo', idNumber: '85030200456' },
    );
    assert.equal(result.ruledOut, true);
    assert.equal(shouldFlag(result), false, 'namesakes with different IDs are two people');
  });

  test('a near-identical name with no ID numbers is worth asking about', () => {
    const result = matchCustomers({ name: 'Johannes Shikongo' }, { name: 'Johanes Shikongo' });
    assert.ok(shouldFlag(result));
    assert.match(result.reasons.join(' '), /nearly the same name/);
  });

  test('a shared surname alone is never enough', () => {
    assert.equal(shouldFlag(matchCustomers({ name: 'Maria Shikongo' }, { name: 'Johannes Shikongo' })), false);
    assert.equal(shouldFlag(matchCustomers({ name: 'Shikongo' }, { name: 'Shikongo' })), true, 'identical full names do flag');
  });

  test('names alone never reach the certainty of an ID match', () => {
    const byName = matchCustomers({ name: 'Johannes Shikongo' }, { name: 'Johannes Shikongo' });
    const byId = matchCustomers({ name: 'A', idNumber: '90010100123' }, { name: 'B', idNumber: '90010100123' });
    assert.ok(byName.score < byId.score, 'a name is never as strong as an ID number');
  });

  test('says when only one side has an ID number, so it can be collected', () => {
    const result = matchCustomers(
      { name: 'Johannes Shikongo', idNumber: '90010100123' },
      { name: 'Johannes Shikongo' },
    );
    assert.ok(shouldFlag(result));
    assert.match(result.reasons.join(' '), /only one record has an ID number/);
  });

  test('two records with nothing in common are not flagged', () => {
    assert.equal(shouldFlag(matchCustomers({ name: 'Petrus Amutenya' }, { name: 'Maria Nangolo' })), false);
    assert.equal(shouldFlag(matchCustomers({}, {})), false, 'two blanks are not a match');
  });
});
