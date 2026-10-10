import { describe, expect, it } from 'vitest'
import { candidateLink, candidateTitle, defaultMinCount } from '../../src/renderer/lib/candidates'
import type { Candidate } from '../../src/shared/relations'

const candidate = (over: Partial<Candidate> = {}): Candidate => ({ openalexId: 'W2153470728', work: null, citedByLibrary: 2, citesLibrary: 0, paperIds: ['a'], ...over })

describe('candidates view', () => {
  it('asks for fewer shared papers when looking at one paper', () => {
    expect(defaultMinCount(null)).toBe(2)
    expect(defaultMinCount('he2017drain')).toBe(1)
  })

  it('falls back to the OpenAlex id and page when metadata is missing', () => {
    expect(candidateTitle(candidate())).toBe('W2153470728')
    expect(candidateLink(candidate())).toBe('https://openalex.org/W2153470728')
    const work = { openalexId: 'W2153470728', title: 'LogSig', year: 2011, authors: 'Tang et al.', doi: '10.1145/2063576.2063690', citedByCount: 249 }
    expect(candidateTitle(candidate({ work }))).toBe('LogSig')
    expect(candidateLink(candidate({ work }))).toBe('https://doi.org/10.1145/2063576.2063690')
  })
})
