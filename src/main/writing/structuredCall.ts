import { failedCallCost, LlmError, type CompleteRequest, type LlmProvider } from '../llm/LlmProvider'
import { retryNote } from '../summary/prompt'

/**
 * One structured call (no tools) whose answer `parse` checks, asked again once with the error when it does not; both
 * attempts share `maxUsd`. Resolves with what both cost; when the answer is still invalid, or the second attempt
 * fails, the error carries everything spent so far (runCappedOperation charges it).
 */
export async function completeChecked<T>(
  provider: LlmProvider,
  req: Omit<CompleteRequest, 'maxUsd'>,
  maxUsd: number,
  parse: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string }
): Promise<{ value: T; costUsd: number; model: string }> {
  let spent = 0
  let model = req.model
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = maxUsd - spent
    if (left <= 0) break
    let result
    try {
      result = await provider.complete({ ...req, input: attempt === 0 ? req.input : `${req.input}\n\n${retryNote(lastError)}`, maxUsd: left })
    } catch (error) {
      if (spent === 0) throw error
      const charge = failedCallCost(error)
      const code = error instanceof LlmError ? error.code : 'llm_unavailable'
      throw new LlmError(code, spent + charge.costUsd, { cause: error, estimated: charge.estimated })
    }
    spent += result.costUsd
    model = result.model
    const parsed = parse(result.value)
    if (parsed.ok) return { value: parsed.value, costUsd: spent, model }
    lastError = parsed.error
  }
  throw new LlmError('llm_invalid_output', spent)
}
