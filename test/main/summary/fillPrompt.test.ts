import { describe, expect, it } from 'vitest'
import { fillJsonSchema, fillSystemPrompt, parseFillOutput } from '../../../src/main/summary/fillPrompt'
import type { FacetDef } from '../../../src/shared/summary'
import { sampleThesis } from '../../helpers/summaries'

const DATA_SOURCE: FacetDef = { key: 'data_source', type: 'multi', description: 'Where the analyzed data comes from', values: ['production_logs', 'public_dataset'] }
const MATURITY: FacetDef = { key: 'maturity', type: 'scale', description: 'How mature the tool is', min: 1, max: 3 }

describe('fill prompt', () => {
  it('asks only for the new facets, with the thesis as context only', () => {
    const system = fillSystemPrompt([DATA_SOURCE, MATURITY], 'es', sampleThesis)
    expect(system).toContain('- data_source (zero or more values): Where the analyzed data comes from. Allowed: production_logs, public_dataset.')
    expect(system).toContain('- maturity (integer 1–3 with a one-sentence justification): How mature the tool is.')
    expect(system).toContain('For context only')
    expect(system).toContain('Spanish')
    expect(system).not.toContain('tldr')
    expect(fillSystemPrompt([DATA_SOURCE], 'en', null)).not.toContain('For context only')
    const schema = fillJsonSchema([DATA_SOURCE]) as { required: string[]; properties: { facets: { required: string[] } } }
    expect(schema.required).toEqual(['facets'])
    expect(schema.properties.facets.required).toEqual(['data_source'])
  })

  it('reads an answer for exactly those facets', () => {
    const ok = parseFillOutput({ facets: { data_source: { values: ['public_dataset'], proposed: ['synthetic'], evidence: [{ quote: 'q', page: 1 }] } } }, [DATA_SOURCE])
    expect(ok).toMatchObject({ ok: true, value: { facets: { data_source: { values: ['public_dataset'], proposed: ['synthetic'] } } } })
    expect(parseFillOutput({ facets: {} }, [DATA_SOURCE])).toMatchObject({ ok: false })
    expect(parseFillOutput({ facets: { maturity: { score: 9, justification: 'j', evidence: [] } } }, [MATURITY])).toMatchObject({ ok: false })
  })
})
