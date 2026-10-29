import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const pages = ['index.html', 'capture.html'].map((name) => [name, readFileSync(new URL(`../../src/renderer/${name}`, import.meta.url), 'utf8')])

describe('renderer Content-Security-Policy', () => {
  it.each(pages)('%s ships a strict policy: no inline or eval scripts, no remote connections', (_name, html) => {
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1]
    expect(csp).toBeDefined()
    const directives = Object.fromEntries(csp!.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]))
    expect(directives['default-src']).toEqual(["'self'"])
    expect(directives['script-src']).toEqual(["'self'"])
    expect(directives['connect-src']).toEqual(["'self'"])
  })
})
