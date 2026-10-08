import { afterAll } from 'vitest'
import { cleanupTmpDirs } from './helpers/tmp'

// Tests never reach the network: every HTTP call must go through an injected FetchFn.
globalThis.fetch = async () => {
  throw new Error('network disabled in tests')
}

afterAll(cleanupTmpDirs)
