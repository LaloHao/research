import type { LlmModel } from '../../shared/summary'

/** List price of an input token of each model, in US$ per million (the most expensive of its current versions). */
export const INPUT_USD_PER_MTOK: Record<LlmModel, number> = { opus: 5, sonnet: 3, haiku: 1 }
/** Characters per token of thesis prose (Spanish, Org markup): fewer than English, so the estimate errs high. */
export const CHARS_PER_TOKEN = 3.5
/**
 * How many times an agent answer pays its input: written to the cache once (1.25×) and read back on every later
 * turn (0.1× each, a dozen tool calls at most), about 3× in all.
 */
export const INPUT_PASSES = 3

/** What sending `chars` more characters of input adds to one agent answer, in US$ (rounded up to the cent). */
export function inputSurchargeUsd(model: LlmModel, chars: number): number {
  if (chars <= 0) return 0
  const usd = (chars / CHARS_PER_TOKEN / 1_000_000) * INPUT_USD_PER_MTOK[model] * INPUT_PASSES
  return Math.ceil(usd * 100) / 100
}
