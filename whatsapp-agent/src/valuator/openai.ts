/**
 * Market estimates from OpenAI (architecture 2.2, phase 1).
 *
 * Same question, same schema, same sanity checks as the Anthropic one — only
 * the wire format differs. Which provider answers is a deployment choice, not
 * a behavioural one, and the shared prompt module is what keeps it that way.
 *
 * Called over plain `fetch` against the REST API rather than through the
 * `openai` package. The endpoint used here is three fields wide and the rest
 * of this system has one runtime dependency; a second one to POST some JSON
 * would not pay for itself.
 */

import type { Rules } from '../playbook/index.ts';
import type { Valuator } from '../router.ts';
import type { MarketEstimate } from '../valuation.ts';
import type { PriceMemory } from './memory.ts';
import {
  ESTIMATE_SCHEMA,
  readEstimates,
  systemPrompt,
  userPrompt,
  type EstimateInput,
  type EstimateResponse,
} from './prompt.ts';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/**
 * Overridable, because model names change faster than this code will. Set
 * OPENAI_MODEL to whatever is current and capable — the valuation is the one
 * place in this system where a better model is worth paying for.
 */
const DEFAULT_MODEL = 'gpt-5';

export interface OpenAiValuatorOptions {
  model?: string;
  onError?: (error: unknown) => void;
  memory?: PriceMemory | null;
  /** Swappable for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export class OpenAiValuator implements Valuator {
  readonly #apiKey: string;
  readonly #rules: Rules;
  readonly #model: string;
  readonly #onError: (error: unknown) => void;
  readonly #memory: PriceMemory | null;
  readonly #fetch: typeof globalThis.fetch;

  constructor(apiKey: string, rules: Rules, options: OpenAiValuatorOptions = {}) {
    this.#apiKey = apiKey;
    this.#rules = rules;
    this.#model = options.model ?? process.env['OPENAI_MODEL'] ?? DEFAULT_MODEL;
    this.#onError = options.onError ?? ((error) => console.error('[valuator:openai]', error));
    this.#memory = options.memory ?? null;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async estimate(input: EstimateInput): Promise<MarketEstimate[]> {
    if (!input.description.trim()) return [];

    try {
      const response = await this.#fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.#model,
          messages: [
            { role: 'system', content: systemPrompt(this.#rules) },
            { role: 'user', content: userPrompt(this.#rules, input, this.#memory) },
          ],
          // Strict structured output: the answer arrives as the schema or not
          // at all, so a malformed reply cannot reach the playbook's formula.
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'market_estimates', strict: true, schema: ESTIMATE_SCHEMA },
          },
        }),
      });

      if (!response.ok) {
        // The body carries the reason — a wrong model name, an exhausted
        // quota — and swallowing it would make this very annoying to diagnose.
        throw new Error(`OpenAI returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string | null; refusal?: string | null } }[];
      };

      const message = payload.choices?.[0]?.message;
      if (message?.refusal) throw new Error(`OpenAI refused to answer: ${message.refusal}`);

      const content = message?.content;
      if (!content) return [];

      return readEstimates(JSON.parse(content) as EstimateResponse);
    } catch (error) {
      // Best-effort, like every other path here: with no usable estimate the
      // approval message asks Lukas for the amount instead of inventing one.
      this.#onError(error);
      return [];
    }
  }
}
