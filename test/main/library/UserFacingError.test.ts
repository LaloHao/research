import { describe, expect, it } from 'vitest'
import { EmbeddingError } from '../../../src/main/embeddings/Embedder'
import { HttpError } from '../../../src/main/ingest/http'
import { toUserFacing, UserFacingError } from '../../../src/main/library/UserFacingError'
import { ConflictError, ProjectError } from '../../../src/main/project/errors'
import { InvalidEdit } from '../../../src/main/summary/merge'

const named = (name: string): Error => Object.assign(new Error('raw English text'), { name })

describe('toUserFacing', () => {
  it('maps known failures to codes the UI translates', () => {
    expect(toUserFacing(new UserFacingError('not_a_pdf')).code).toBe('not_a_pdf')
    expect(toUserFacing(new HttpError(404, 'https://doi.org/x')).code).toBe('not_found')
    expect(toUserFacing(new HttpError(500, 'https://doi.org/x')).code).toBe('network')
    expect(toUserFacing(new ConflictError('/p')).code).toBe('conflict')
    expect(toUserFacing(new ProjectError('A project already exists in /x', 'project_exists')).code).toBe('project_exists')
    expect(toUserFacing(new ProjectError('No project.yaml in /x', 'not_a_project')).code).toBe('not_a_project')
    expect(toUserFacing(named('InvalidPDFException')).code).toBe('unreadable_pdf')
    expect(toUserFacing(named('PasswordException')).code).toBe('unreadable_pdf')
    expect(toUserFacing(new InvalidEdit('x')).code).toBe('invalid_edit')
  })

  it('maps an OpenAlex 429 to openalex_limit only when it is the daily limit', () => {
    const oa = 'https://api.openalex.org/works/W1'
    const h = (headers: Record<string, string>): Headers => new Headers(headers)
    expect(toUserFacing(new HttpError(429, oa, h({ 'x-ratelimit-remaining': '0', 'retry-after': '5' }))).code).toBe('openalex_limit')
    expect(toUserFacing(new HttpError(429, oa, h({ 'x-ratelimit-remaining-usd': '0.0', 'retry-after': '5' }))).code).toBe('openalex_limit')
    expect(toUserFacing(new HttpError(429, oa, h({ 'x-ratelimit-remaining': '40', 'retry-after': '3600' }))).code).toBe('openalex_limit')
    expect(toUserFacing(new HttpError(429, oa)).code).toBe('openalex_limit')
    expect(toUserFacing(new HttpError(429, oa, h({ 'x-ratelimit-remaining': '40', 'retry-after': '2' }))).code).toBe('network')
    expect(toUserFacing(new HttpError(429, 'https://api.crossref.org/works/x')).code).toBe('network')
  })

  it('maps embedding failures to model_error', () => {
    expect(toUserFacing(new EmbeddingError('could not load')).code).toBe('model_error')
  })
})
