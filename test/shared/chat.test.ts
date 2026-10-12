import { describe, expect, it } from 'vitest'
import { CHAT_ID, ChatMetaSchema, ChatScopeSchema } from '../../src/shared/chat'

const AT = '2026-10-11T12:00:00.000Z'
const meta = { schema_version: 1, id: '20261011-120000-a1b2', title: 'What does Drain do?', scope: 'library', model: 'sonnet', created_at: AT, updated_at: AT }

describe('chat ids', () => {
  it('name the creation time plus a random part, and one suffix per sync copy', () => {
    for (const id of ['20261011-120000-a1b2', '20261011-120000-a1b2-0f9e8d', '20261011-120000-a1b2-0f9e8d-a0b1c2']) expect(CHAT_ID.test(id)).toBe(true)
    for (const id of ['', '20261011-1200-a1b2', '20261011-120000-A1B2', '20261011-120000-a1b2-xyz', '../20261011-120000-a1b2']) expect(CHAT_ID.test(id)).toBe(false)
  })
})

describe('ChatMetaSchema', () => {
  it('fills archived and cost, and keeps keys a later version adds', () => {
    expect(ChatMetaSchema.parse({ ...meta, later: 1 })).toEqual({ ...meta, archived: false, cost_usd: 0, later: 1 })
    expect(ChatMetaSchema.parse({ ...meta, scope: { paper: 'he2017drain' }, copy_of: { id: '20261011-110000-ffff', machine: null } })).toMatchObject({
      scope: { paper: 'he2017drain' },
      copy_of: { id: '20261011-110000-ffff', machine: null }
    })
  })

  it('refuses a bad id, scope, model, title or schema version', () => {
    for (const bad of [{ id: 'x' }, { scope: { paper: 'He2017' } }, { scope: 'global' }, { model: 'gpt' }, { title: '' }, { title: 'x'.repeat(121) }, { schema_version: 2 }]) {
      expect(ChatMetaSchema.safeParse({ ...meta, ...bad }).success).toBe(false)
    }
    expect(ChatScopeSchema.safeParse({ paper: 'he2017drain', extra: 1 }).success).toBe(false)
  })
})
