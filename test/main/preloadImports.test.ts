import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAT_STREAM_CHANNEL as fromChat } from '../../src/shared/chat'
import { CHAT_STREAM_CHANNEL } from '../../src/shared/ipc'

const src = (file: string): Promise<string> => readFile(join(__dirname, '../../src', file), 'utf8')

/** Runtime (not type-only) imports of a module's source. */
function runtimeImports(text: string): string[] {
  return [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]!)
}

describe('preload imports', () => {
  // The preload runs sandboxed: it can require 'electron' only, so nothing it imports at runtime may pull in a package.
  it('loads only electron and the dependency-free shared/ipc at runtime', async () => {
    expect(runtimeImports(await src('preload/index.ts')).sort()).toEqual(['../shared/ipc', 'electron'])
    expect(runtimeImports(await src('shared/ipc.ts'))).toEqual([])
  })

  it('pushes chat answers on one channel, named the same from shared/chat', () => {
    expect(CHAT_STREAM_CHANNEL).toBe('chat:stream')
    expect(fromChat).toBe(CHAT_STREAM_CHANNEL)
  })
})
