import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/eval/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 30 * 60_000
  }
})
