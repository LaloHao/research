import { PAPER_KEY } from '../../shared/chat'
import type { UserErrorCode } from '../../shared/library'

/**
 * «Cambiar clave»: what is wrong with the key as typed (spaces around it ignored), before asking the main process; null
 * when it may be saved. Whether another paper uses it only the main process knows (`key_taken`).
 */
export function newKeyProblem(typed: string, current: string): Extract<UserErrorCode, 'invalid_key' | 'key_unchanged'> | null {
  const key = typed.trim()
  if (!PAPER_KEY.test(key)) return 'invalid_key'
  if (key === current) return 'key_unchanged'
  return null
}
