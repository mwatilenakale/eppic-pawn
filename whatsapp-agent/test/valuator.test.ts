import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/playbook/index.ts';
import { ClaudeValuator, createValuator, type MessagesClient } from '../src/valuator/index.ts';
import { suggestValuation } from '../src/valuation.ts';

const rules = loadRules();
const ITEM = { description: 'iPhone 13 Pro, 256GB, good condition', categorySlug: 'phones', variant: 'iphone' };

/** A stub standing in for the Anthropic SDK. */
function stubClient(reply: unknown, calls: Record<string, unknown>[] = []): MessagesClient {
  return {
    messages: {
      async create(params) {
        calls.push(params);
        if (reply instanceof Error) throw reply;
        return { content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] };
      },
    },
  };
}

describe('claude valuator', () => {
  test('asks for market prices in Namibian dollars, and never for a loan amount', async () => {
    const calls: Record<string, unknown>[] = [];
    const valuator = new ClaudeValuator(stubClient({ estimates: [], confidence: 'low', note: '' }, calls), rules);
    await valuator.estimate(ITEM);

    const request = calls[0]!;
    assert.equal(request['model'], 'claude-opus-5');
    const system = String(request['system']);
    assert.match(system, /Namibia/);
    assert.match(system, /Never suggest a loan amount/);
    assert.match(JSON.stringify(request['output_config']), /json_schema/);
    assert.match(JSON.stringify(request['messages']), /iPhone 13 Pro/);
  });

  test('turns estimates into the input the playbook formula expects', async () => {
    const valuator = new ClaudeValuator(
      stubClient({
        estimates: [
          { source: 'Facebook Marketplace, Windhoek', amount_nad: 12000, condition: 'used, good' },
          { source: 'Local dealer trade-in', amount_nad: 10000, condition: 'used' },
        ],
        confidence: 'high',
        note: '',
      }),
      rules,
    );

    const estimates = await valuator.estimate(ITEM);
    assert.equal(estimates.length, 2);
    assert.equal(estimates[1]?.amountCents, 1_000_000);
    assert.match(estimates[0]!.source, /AI estimate: Facebook Marketplace/);

    // The formula runs on the lowest, exactly as the playbook says.
    const valuation = suggestValuation(estimates, rules);
    assert.equal(valuation.suggestedLoanCents, 375_000);
  });

  test('flags low confidence to Lukas in the source line', async () => {
    const valuator = new ClaudeValuator(
      stubClient({
        estimates: [{ source: 'Marketplace', amount_nad: 8000, condition: 'unknown' }],
        confidence: 'low',
        note: 'no storage size given',
      }),
      rules,
    );
    const [estimate] = await valuator.estimate(ITEM);
    assert.match(estimate!.source, /low confidence/);
  });

  test('an empty answer is accepted — no estimate is better than a guess', async () => {
    const valuator = new ClaudeValuator(
      stubClient({ estimates: [], confidence: 'low', note: 'description too vague' }),
      rules,
    );
    assert.deepEqual(await valuator.estimate(ITEM), []);
  });

  test('implausible numbers are dropped, not passed to the formula', async () => {
    const valuator = new ClaudeValuator(
      stubClient({
        estimates: [
          { source: 'nonsense high', amount_nad: 99_000_000, condition: 'used' },
          { source: 'nonsense low', amount_nad: 0, condition: 'used' },
          { source: 'negative', amount_nad: -5000, condition: 'used' },
          { source: 'not a number', amount_nad: Number.NaN, condition: 'used' },
          { source: 'sensible', amount_nad: 9000, condition: 'used' },
        ],
        confidence: 'medium',
        note: '',
      }),
      rules,
    );

    const estimates = await valuator.estimate(ITEM);
    assert.equal(estimates.length, 1);
    assert.equal(estimates[0]?.amountCents, 900_000);
  });

  test('an API failure or malformed answer degrades to no estimate', async () => {
    const errors: unknown[] = [];
    const failing = new ClaudeValuator(stubClient(new Error('503 overloaded')), rules, { onError: (e) => errors.push(e) });
    assert.deepEqual(await failing.estimate(ITEM), []);
    assert.equal(errors.length, 1);

    const garbled = new ClaudeValuator(stubClient('not json at all'), rules, { onError: () => {} });
    assert.deepEqual(await garbled.estimate(ITEM), []);

    const wrongShape = new ClaudeValuator(stubClient({ estimates: 'nope' }), rules, { onError: () => {} });
    assert.deepEqual(await wrongShape.estimate(ITEM), []);
  });

  test('an empty description is not sent to the API at all', async () => {
    const calls: Record<string, unknown>[] = [];
    const valuator = new ClaudeValuator(stubClient({ estimates: [], confidence: 'low', note: '' }, calls), rules);
    assert.deepEqual(await valuator.estimate({ ...ITEM, description: '  ' }), []);
    assert.equal(calls.length, 0);
  });

  test('with no API key there is no valuator — Lukas is asked for the amount', () => {
    assert.equal(createValuator(null, rules), null);
    assert.notEqual(createValuator('sk-ant-test', rules), null);
  });
});
