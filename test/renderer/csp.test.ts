import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../src/renderer/index.html', import.meta.url), 'utf8')

describe('renderer Content-Security-Policy', () => {
  it('ships a strict policy: no inline or eval scripts, no remote connections', () => {
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1]
    expect(csp).toBeDefined()
    const directives = Object.fromEntries(csp!.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]))
    expect(directives['default-src']).toEqual(["'self'"])
    expect(directives['script-src']).toEqual(["'self'"])
    expect(directives['connect-src']).toEqual(["'self'"])
  })
})
