import { describe, expect, it } from 'vitest'
import { CHAT_ID, ChatMessageSchema, ChatMetaSchema, ChatScopeSchema, normalizeExcerpt } from '../../src/shared/chat'
import { ACTION_READ_TOOLS, ACTION_TOOLS, SYNC_TOOLS, TOOL_RISK } from '../../src/shared/chatActions'

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
    expect(ChatMetaSchema.parse({ ...meta, later: 1 })).toEqual({ ...meta, archived: false, cost_usd: 0, actions: false, sync: false, later: 1 })
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

describe('ChatMessageSchema', () => {
  const user = { role: 'user', at: '2026-10-11T12:00:00.000Z', text: 'Q', excerpt: null }
  const answer = { role: 'assistant', at: '2026-10-11T12:00:05.000Z', model: 'claude-sonnet-5', costUsd: 0.02, stopped: false, text: 'A' }

  it('accepts messages that the file format writes and reads back unchanged', () => {
    expect(ChatMessageSchema.safeParse(user).success).toBe(true)
    expect(ChatMessageSchema.safeParse(answer).success).toBe(true)
    expect(ChatMessageSchema.safeParse({ ...user, excerpt: { paper: 'he2017drain', page: 3, quote: 'a parse tree' } }).success).toBe(true)
    expect(ChatMessageSchema.safeParse({ ...user, excerpt: { paper: 'he2017drain', page: null, quote: 'web text' } }).success).toBe(true)
  })

  it('rejects heading fields that would break the file', () => {
    for (const at of ['2026 x', '', '2026\n## Tú — b']) {
      expect(ChatMessageSchema.safeParse({ ...user, at }).success).toBe(false)
      expect(ChatMessageSchema.safeParse({ ...answer, at }).success).toBe(false)
    }
    for (const model of ['a\n## Tú — b', 'a · b', 'a b', '', '$1']) expect(ChatMessageSchema.safeParse({ ...answer, model }).success).toBe(false)
    for (const costUsd of [1e21, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) expect(ChatMessageSchema.safeParse({ ...answer, costUsd }).success).toBe(false)
  })

  it('rejects an excerpt whose marker would not read back the same', () => {
    for (const excerpt of [
      { paper: 'he2017drain', page: 3, quote: 'two  spaces' },
      { paper: 'he2017drain', page: 3, quote: 'ends "]] early' },
      { paper: 'He2017', page: 3, quote: 'q' },
      { paper: 'he2017drain', page: 0, quote: 'q' },
      { paper: 'he2017drain', page: 3, quote: ' ' }
    ])
      expect(ChatMessageSchema.safeParse({ ...user, excerpt }).success).toBe(false)
  })

  it('normalizes an excerpt to what its marker reads back', () => {
    expect(normalizeExcerpt({ paper: 'he2017drain', page: 3, quote: ' two  spaces\n' })).toEqual({ paper: 'he2017drain', page: 3, quote: 'two spaces' })
    expect(normalizeExcerpt({ paper: 'he2017drain', page: 3, quote: '  ' })).toBeNull()
  })
})

describe('conversation switches', () => {
  it('are off by default, kept when set, and refused when not booleans', () => {
    expect(ChatMetaSchema.parse(meta)).toMatchObject({ actions: false, sync: false })
    expect(ChatMetaSchema.parse({ ...meta, actions: true, sync: true })).toMatchObject({ actions: true, sync: true })
    expect(ChatMetaSchema.safeParse({ ...meta, actions: 'yes' }).success).toBe(false)
  })
})

describe('action tools', () => {
  it('give every write tool a risk; only reversible free tools have none; the sync tools are their own group', () => {
    expect(Object.keys(TOOL_RISK).sort()).toEqual([...ACTION_TOOLS].sort())
    expect(ACTION_TOOLS.filter((t) => TOOL_RISK[t] === null)).toEqual([
      'add_paper',
      'write_note',
      'decide_relation',
      'review_summary',
      'decide_facet_suggestion',
      'restore_papers'
    ])
    expect([TOOL_RISK.summarize, TOOL_RISK.trash_papers, TOOL_RISK.delete_forever, TOOL_RISK.sync_now, TOOL_RISK.attach_pdf]).toEqual(['spends', 'removes', 'removes', 'sync', 'file'])
    expect([TOOL_RISK.edit_summary, TOOL_RISK.resolve_proposed_value]).toEqual(['edits', 'edits'])
    const all: readonly string[] = [...ACTION_TOOLS, ...ACTION_READ_TOOLS]
    expect(SYNC_TOOLS.every((t) => all.includes(t))).toBe(true)
    expect(new Set(all).size).toBe(all.length)
  })
})
