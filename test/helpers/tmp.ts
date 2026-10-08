import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'research-test-'))
}
