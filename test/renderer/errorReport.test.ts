import { describe, expect, it } from 'vitest'
import { errorReport, reportUncaughtErrors } from '../../src/renderer/lib/errorReport'
import type { RendererErrorReport } from '../../src/shared/ipc'

describe('errorReport', () => {
  it('keeps the name, message and stack of an error', () => {
    const error = new TypeError('x is undefined')
    expect(errorReport('error', error, 'app.js:3:7')).toEqual({ kind: 'error', message: 'TypeError: x is undefined', stack: error.stack, source: 'app.js:3:7' })
  })

  it('reads anything else as text', () => {
    expect(errorReport('unhandledrejection', 'nope')).toEqual({ kind: 'unhandledrejection', message: 'nope', stack: null, source: null })
    expect(errorReport('unhandledrejection', undefined).message).toBe('undefined')
    expect(errorReport('unhandledrejection', { toString: () => { throw new Error('no') } }).message).toBe('Unprintable error')
  })

  it('reports errors and unhandled rejections of the window, never throwing again', () => {
    const target = new EventTarget() as unknown as Window
    const sent: RendererErrorReport[] = []
    reportUncaughtErrors(target, (r) => {
      sent.push(r)
      throw new Error('ipc gone')
    })
    const error = Object.assign(new Event('error'), { error: new Error('boom'), filename: 'app.js', lineno: 1, colno: 2, message: 'boom' })
    expect(() => target.dispatchEvent(error)).not.toThrow()
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'later' }))
    expect(sent.map((r) => [r.kind, r.message, r.source])).toEqual([
      ['error', 'Error: boom', 'app.js:1:2'],
      ['unhandledrejection', 'later', null]
    ])
  })
})
