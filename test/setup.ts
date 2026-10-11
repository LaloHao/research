import { afterAll } from 'vitest'
import { cleanupTmpDirs } from './helpers/tmp'

const realFetch = globalThis.fetch

// Tests never reach the network: only local MCP servers on 127.0.0.1 are reachable; every other HTTP call must go through an injected FetchFn.
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (new URL(href).hostname !== '127.0.0.1') throw new Error('network disabled in tests')
  return realFetch(input, init)
}

afterAll(cleanupTmpDirs)
