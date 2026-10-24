/**
 * Market-estimate lookup for the valuation engine (architecture 2.2, phase 1).
 *
 * Claude is asked for *market estimates only* — never for a loan amount. The
 * playbook's formula (lowest estimate x 0.75 / 2) is applied in code, from the
 * document, so the number Lukas sees is arithmetic he can check rather than a
 * figure a model invented.
 *
 * Everything here is best-effort: with no API key, an unparseable answer, or an
 * estimate that fails a sanity check, it returns nothing and the approval
 * message asks Lukas for the amount instead. It never guesses to fill a gap.
 *
 * Phase 2 (architecture 2.2) replaces this with a model calibrated against the
 * Ledger's own outcomes — 372 loans of real assessed values and resale results.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Rules } from '../playbook/index.ts';
import type { PriceMemory } from './memory.ts';
import type { Valuator } from '../router.ts';
import type { MarketEstimate } from '../valuation.ts';
import {
  ESTIMATE_SCHEMA,
  readEstimates,
  systemPrompt,
  userPrompt,
  type EstimateInput,
  type EstimateResponse,
} from './prompt.ts';
import { OpenAiValuator } from './openai.ts';

const MODEL = process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-5';

/** The subset of the SDK this module uses, so tests can pass a stub. */
export interface MessagesClient {
  messages: {
    create(params: Record<string, unknown>): Promise<{ content: { type: string; text?: string }[] }>;
  };
}

export interface ClaudeValuatorOptions {
  model?: string;
  maxTokens?: number;
  onError?: (error: unknown) => void;
  /** Recent owner corrections, given to the model as local evidence. */
  memory?: PriceMemory | null;
}

export class ClaudeValuator implements Valuator {
  readonly #client: MessagesClient;
  readonly #rules: Rules;
  readonly #options: {
    model: string;
    maxTokens: number;
    onError: (error: unknown) => void;
    memory: PriceMemory | null;
  };

  constructor(client: MessagesClient, rules: Rules, options: ClaudeValuatorOptions = {}) {
    this.#client = client;
    this.#rules = rules;
    this.#options = {
      model: options.model ?? MODEL,
      maxTokens: options.maxTokens ?? 2048,
      onError: options.onError ?? ((error) => console.error('[valuator]', error)),
      memory: options.memory ?? null,
    };
  }

  async estimate(input: EstimateInput): Promise<MarketEstimate[]> {
    if (!input.description.trim()) return [];

    try {
      const response = await this.#client.messages.create({
        model: this.#options.model,
        max_tokens: this.#options.maxTokens,
        system: systemPrompt(this.#rules),
        output_config: { format: { type: 'json_schema', schema: ESTIMATE_SCHEMA } },
        messages: [{ role: 'user', content: userPrompt(this.#rules, input, this.#options.memory) }],
      });

      const text = response.content.find((block) => block.type === 'text')?.text;
      if (!text) return [];

      return readEstimates(JSON.parse(text) as EstimateResponse);
    } catch (error) {
      this.#options.onError(error);
      return [];
    }
  }

}

export interface ValuatorKeys {
  openai?: string | null;
  anthropic?: string | null;
  /** Forces a provider; otherwise whichever key is present wins. */
  provider?: string | null;
}

/**
 * Picks the provider from whichever key is configured.
 *
 * OpenAI first when both are set, because that is the explicit choice on this
 * deployment. Neither key means no valuator at all, which is a supported state:
 * the approval message then asks Lukas for the amount rather than inventing
 * one, exactly as it does when an estimate comes back unusable.
 *
 * The provider is a deployment detail. Both answer the same question, against
 * the same schema and the same sanity checks, and the playbook's arithmetic
 * runs in code either way — so switching cannot change what the shop lends.
 */
export function createValuator(keys: ValuatorKeys, rules: Rules, memory?: PriceMemory): Valuator | null {
  const wanted = (keys.provider ?? '').trim().toLowerCase();

  if (wanted === 'openai' || (!wanted && keys.openai)) {
    if (!keys.openai) throw new Error('VALUATOR_PROVIDER is openai but OPENAI_API_KEY is not set');
    return new OpenAiValuator(keys.openai, rules, { memory });
  }

  if (wanted === 'anthropic' || (!wanted && keys.anthropic)) {
    if (!keys.anthropic) throw new Error('VALUATOR_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set');
    return new ClaudeValuator(new Anthropic({ apiKey: keys.anthropic }) as unknown as MessagesClient, rules, { memory });
  }

  return null;
}

export { OpenAiValuator } from './openai.ts';
