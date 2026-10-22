import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import type { DraftStreamEvent, DraftStreamUpdate } from '../../src/shared/writing/draft'
import { applyDraftUpdate, draftFileName, draftPapers, draftTitle, liveFromPartial, type LiveDraft } from '../../src/renderer/lib/drafts'

const t = ((key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)) as unknown as TFunction
const u = (seq: number, e: DraftStreamEvent): DraftStreamUpdate => ({ ...e, draftId: 'd', seq })

describe('«Borrador» in the window', () => {
  it('shows the version as it streams: a new turn starts over, the end asks for the file, older updates are ignored', () => {
    let live: LiveDraft | null = null
    const step = (update: DraftStreamUpdate): boolean => {
      const next = applyDraftUpdate(live, update)
      live = next.live
      return next.resync
    }
    expect(step(u(1, { kind: 'start' }))).toBe(false)
    step(u(2, { kind: 'delta', text: 'Thinking' }))
    step(u(3, { kind: 'turn' }))
    step(u(4, { kind: 'tool', name: 'find_in_paper' }))
    step(u(5, { kind: 'delta', text: 'Drain ' }))
    step(u(6, { kind: 'delta', text: 'parses.' }))
    step(u(5, { kind: 'delta', text: 'late' }))
    expect(live).toEqual({ text: 'Drain parses.', tools: 1, seq: 6, status: 'running', error: null })
    expect(step(u(7, { kind: 'done' }))).toBe(true)
    expect(live).toBeNull()
    // Opened mid-run: a delta with nothing to apply it to asks for the draft again.
    expect(applyDraftUpdate(null, u(8, { kind: 'delta', text: 'x' }))).toEqual({ live: null, resync: true })
    expect(applyDraftUpdate(liveFromPartial({ text: 'a', tools: 0, seq: 9 }), u(10, { kind: 'error', error: 'llm_timeout' })).live).toMatchObject({ status: 'error', error: 'llm_timeout', text: 'a' })
  })

  it('names copies, counts the chosen papers once and names the saved file', () => {
    expect(draftTitle(t, { title: 'Parsing', copyOf: null })).toBe('Parsing')
    expect(draftTitle(t, { title: 'Parsing', copyOf: { machine: 'desktop' } })).toBe('writing.draft.copy_title {"title":"Parsing","machine":"desktop"}')
    expect(draftPapers(['a', 'b', 'a'])).toEqual({ papers: ['a', 'b'], over: false })
    expect(draftPapers(Array.from({ length: 61 }, (_v, i) => `p${i}`)).over).toBe(true)
    expect(draftFileName('Log parsing: state of the art', 'org')).toBe('Log-parsing-state-of-the-art.org')
    expect(draftFileName('Parsing', 'latex')).toBe('Parsing.tex')
  })
})
