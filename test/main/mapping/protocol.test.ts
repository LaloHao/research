import { describe, expect, it } from 'vitest'
import { applyDraft, newProtocol } from '../../../src/main/mapping/protocol'
import type { ProtocolDraft, ProtocolFile } from '../../../src/shared/mapping'
import { AT, protocolFile } from '../../helpers/mappings'

const NOW = '2026-10-12T12:00:00.000Z'
const draftOf = (over: Partial<ProtocolDraft> = {}): ProtocolDraft => {
  const p = protocolFile().protocol
  return { title: p.title, objective: p.objective, research_questions: p.research_questions, inclusion: p.inclusion, exclusion: p.exclusion, years: p.years, publication_types: p.publication_types, ...over }
}

describe('protocol', () => {
  it('starts as version 1 with only a title', () => {
    expect(newProtocol('  Logs  ', AT)).toEqual({
      schema_version: 1,
      protocol: { title: 'Logs', objective: '', research_questions: [], inclusion: [], exclusion: [], years: { from: null, to: null }, publication_types: [] },
      phases: ['title_abstract', 'full_text'],
      version: 1,
      last_ids: { rq: 0, inclusion: 0, exclusion: 0 },
      created_at: AT,
      updated_at: AT,
      history: []
    })
  })

  it('gives new items the next free number, never one already used, and edits in place before screening', () => {
    const next = applyDraft(
      protocolFile(),
      draftOf({ inclusion: [{ id: 'I1', text: 'Edited.' }, { id: null, text: 'New one.' }], exclusion: [{ id: 'E1', text: 'Not about software logs.' }, { id: null, text: 'Replaces E2.' }] }),
      { screeningStarted: false, now: NOW }
    )
    expect(next.protocol.inclusion).toEqual([
      { id: 'I1', text: 'Edited.' },
      { id: 'I2', text: 'New one.' }
    ])
    expect(next.protocol.exclusion.map((c) => c.id)).toEqual(['E1', 'E3'])
    expect(next).toMatchObject({ version: 1, history: [], last_ids: { rq: 1, inclusion: 2, exclusion: 3 }, updated_at: NOW })
  })

  it('once screening started, keeps the previous body as an earlier version', () => {
    const current = protocolFile()
    const next = applyDraft(current, draftOf({ objective: 'Narrower.' }), { screeningStarted: true, now: NOW })
    expect(next).toMatchObject({ version: 2, history: [{ version: 1, replaced_at: NOW, protocol: current.protocol }] })
    expect(next.protocol.objective).toBe('Narrower.')
  })

  it('returns the same protocol when nothing changed, and refuses ids it does not know', () => {
    const current = protocolFile()
    expect(applyDraft(current, draftOf(), { screeningStarted: true, now: NOW })).toBe(current)
    expect(() => applyDraft(current, draftOf({ exclusion: [{ id: 'E9', text: 'x' }] }), { screeningStarted: false, now: NOW })).toThrow('invalid_edit')
    expect(() => applyDraft(current, draftOf({ exclusion: [{ id: 'I1', text: 'x' }] }), { screeningStarted: false, now: NOW })).toThrow('invalid_edit')
    expect(() => applyDraft(current, draftOf({ years: { from: 2020, to: 2010 } }), { screeningStarted: false, now: NOW })).toThrow('invalid_edit')
  })

  it('keeps keys a later version added, on the body and on its items', () => {
    const base = protocolFile()
    const current = {
      ...base,
      protocol: { ...base.protocol, facets: ['venue'], inclusion: [{ id: 'I1', text: base.protocol.inclusion[0].text, rq: 'RQ1' }] }
    } as ProtocolFile
    expect(applyDraft(current, draftOf(), { screeningStarted: false, now: NOW })).toBe(current)
    const next = applyDraft(current, draftOf({ objective: 'Other.', inclusion: [{ id: 'I1', text: 'Edited.' }] }), { screeningStarted: false, now: NOW })
    expect(next.protocol).toMatchObject({ facets: ['venue'], inclusion: [{ id: 'I1', text: 'Edited.', rq: 'RQ1' }] })
  })
})
