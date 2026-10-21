import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/playbook/index.ts';
import { ClaudeValuator, OpenAiValuator, createValuator, type MessagesClient } from '../src/valuator/index.ts';
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
  test('historical prices reach the provider as dated unverified evidence with item details', async () => {
    const calls: Record<string, unknown>[] = [];
    const valuator = new ClaudeValuator(stubClient({ estimates: [], confidence: 'low', note: '' }, calls), rules);
    await valuator.estimate({ ...ITEM, history: [{
      description: 'iPhone 15 base 128GB box 95% battery', observedAt: '2026-10-21T10:00:00.000Z',
      estimates: [{ source: 'test evidence', amountCents: 1_000_000 }],
    }] });
    const request = JSON.stringify(calls[0]!['messages']);
    assert.match(request, /unverified historical evidence/);
    assert.match(request, /2026-10-21T10:00:00/);
    assert.match(request, /95% battery/);
    assert.match(request, /10000 NAD/);
  });

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
    assert.equal(createValuator({}, rules), null);
    assert.equal(createValuator({ openai: null, anthropic: null }, rules), null);
  });

  test('the provider is whichever key is configured', () => {
    assert.ok(createValuator({ anthropic: 'sk-ant-test' }, rules) instanceof ClaudeValuator);
    assert.ok(createValuator({ openai: 'sk-test' }, rules) instanceof OpenAiValuator);
    // Explicit on this deployment: OpenAI wins when both are present.
    assert.ok(createValuator({ openai: 'sk-test', anthropic: 'sk-ant-test' }, rules) instanceof OpenAiValuator);
  });

  test('asking for a provider whose key is missing fails loudly', () => {
    // Silently falling back would mean paying a different bill than intended,
    // and quietly using a model nobody chose.
    assert.throws(() => createValuator({ provider: 'openai', anthropic: 'sk-ant-test' }, rules), /OPENAI_API_KEY is not set/);
    assert.throws(() => createValuator({ provider: 'anthropic', openai: 'sk-test' }, rules), /ANTHROPIC_API_KEY is not set/);
  });
});

describe('the OpenAI valuator', () => {
  const ITEM_IN = { description: 'iPhone 13 Pro, 256GB, good condition', categorySlug: 'phones', variant: 'iphone' };

  /** Stands in for the API; records what was sent. */
  const stubFetch = (payload: unknown, calls: { url: string; body: Record<string, unknown> }[] = [], status = 200) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(payload), { status });
    }) as unknown as typeof fetch;

  const reply = (content: unknown) => ({ choices: [{ message: { content: JSON.stringify(content) } }] });

  test('asks the same question, against the same schema', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const valuator = new OpenAiValuator('sk-test', rules, {
      fetch: stubFetch(reply({ estimates: [{ source: 'Marketplace', amount_nad: 9000, condition: 'used' }], confidence: 'high', note: '' }), calls),
    });

    const estimates = await valuator.estimate(ITEM_IN);

    assert.equal(estimates.length, 1);
    assert.equal(estimates[0]!.amountCents, 900_000);
    assert.match(calls[0]!.url, /api\.openai\.com/);

    const body = calls[0]!.body as { messages: { role: string; content: string }[]; response_format: Record<string, never> };
    assert.equal(body.messages[0]!.role, 'system');
    assert.match(body.messages[0]!.content, /pawn shop in Windhoek/);
    assert.match(body.messages[0]!.content, /Never suggest a loan amount/, 'it is never asked what to lend');
    assert.match(body.messages[1]!.content, /iPhone 13 Pro/);
    assert.equal((body.response_format as unknown as { type: string }).type, 'json_schema');
  });

  test('the same sanity checks apply — an absurd figure is dropped', async () => {
    const valuator = new OpenAiValuator('sk-test', rules, {
      fetch: stubFetch(
        reply({
          estimates: [
            { source: 'sane', amount_nad: 9000, condition: 'used' },
            { source: 'typo', amount_nad: 900_000_000, condition: 'used' },
            { source: 'nonsense', amount_nad: 1, condition: 'used' },
          ],
          confidence: 'medium',
          note: '',
        }),
      ),
    });

    const estimates = await valuator.estimate(ITEM_IN);
    assert.deepEqual(estimates.map((estimate) => estimate.amountCents), [900_000]);
    assert.match(estimates[0]!.source, /medium confidence/);
  });

  test('an API failure means no figure, not a guess', async () => {
    const errors: unknown[] = [];
    const valuator = new OpenAiValuator('sk-test', rules, {
      onError: (error) => errors.push(error),
      fetch: (async () => new Response('model not found', { status: 404 })) as unknown as typeof fetch,
    });

    assert.deepEqual(await valuator.estimate(ITEM_IN), []);
    assert.match(String(errors[0]), /404.*model not found/s, 'and the reason is not swallowed');
  });

  test('a refusal is treated as no answer', async () => {
    const errors: unknown[] = [];
    const valuator = new OpenAiValuator('sk-test', rules, {
      onError: (error) => errors.push(error),
      fetch: stubFetch({ choices: [{ message: { refusal: 'I cannot help with that' } }] }),
    });

    assert.deepEqual(await valuator.estimate(ITEM_IN), []);
    assert.match(String(errors[0]), /refused/i);
  });

  test('an empty description is not sent anywhere', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const valuator = new OpenAiValuator('sk-test', rules, { fetch: stubFetch(reply({ estimates: [], confidence: 'low', note: '' }), calls) });

    assert.deepEqual(await valuator.estimate({ ...ITEM_IN, description: '   ' }), []);
    assert.equal(calls.length, 0, 'no request, no cost');
  });
});
