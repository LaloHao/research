import { isDeepStrictEqual } from 'node:util'
import { PHASES, ProtocolBodySchema, type ProtocolDraft, type ProtocolFile } from '../../shared/mapping'
import { UserFacingError } from '../library/UserFacingError'

export function newProtocol(title: string, at: string): ProtocolFile {
  return {
    schema_version: 1,
    protocol: ProtocolBodySchema.parse({ title: title.trim() }),
    phases: [...PHASES],
    version: 1,
    last_ids: { rq: 0, inclusion: 0, exclusion: 0 },
    created_at: at,
    updated_at: at,
    history: []
  }
}

type Item = { id: string; text: string } & Record<string, unknown>

/**
 * The draft's items with their ids: an item that has one keeps it (it must be one of the protocol's own items of that
 * list, whose other keys it keeps), a new one takes the next number above every number ever used (`last`, and the
 * current ids, in case `last_ids` lags behind).
 */
function withIds(items: ProtocolDraft['inclusion'], current: Item[], prefix: 'RQ' | 'I' | 'E', last: number): { items: Item[]; last: number } {
  const known = new Map(current.map((c) => [c.id, c]))
  let n = Math.max(last, ...current.map((c) => Number(c.id.slice(prefix.length)) || 0))
  const out = items.map((item): Item => {
    if (item.id !== null) {
      const before = known.get(item.id)
      if (!before) throw new UserFacingError('invalid_edit')
      return { ...before, id: item.id, text: item.text.trim() }
    }
    n++
    return { id: `${prefix}${n}`, text: item.text.trim() }
  })
  return { items: out, last: n }
}

/**
 * «Guardar protocolo». Before the first decision the body is replaced in place; afterwards a change creates a new
 * version and keeps the previous body in the history. The same object comes back when nothing changed. Keys a later
 * version added (on the body, its years or its items) are kept.
 */
export function applyDraft(current: ProtocolFile, draft: ProtocolDraft, opts: { screeningStarted: boolean; now: string }): ProtocolFile {
  const before = current.protocol
  const rq = withIds(draft.research_questions, before.research_questions, 'RQ', current.last_ids.rq)
  const inclusion = withIds(draft.inclusion, before.inclusion, 'I', current.last_ids.inclusion)
  const exclusion = withIds(draft.exclusion, before.exclusion, 'E', current.last_ids.exclusion)
  const parsed = ProtocolBodySchema.safeParse({
    ...before,
    title: draft.title,
    objective: draft.objective.trim(),
    research_questions: rq.items,
    inclusion: inclusion.items,
    exclusion: exclusion.items,
    years: { ...before.years, from: draft.years.from, to: draft.years.to },
    publication_types: [...new Set(draft.publication_types)]
  })
  if (!parsed.success) throw new UserFacingError('invalid_edit')
  if (isDeepStrictEqual(parsed.data, before)) return current
  const last_ids = { ...current.last_ids, rq: rq.last, inclusion: inclusion.last, exclusion: exclusion.last }
  if (!opts.screeningStarted) return { ...current, protocol: parsed.data, last_ids, updated_at: opts.now }
  return {
    ...current,
    protocol: parsed.data,
    last_ids,
    version: current.version + 1,
    history: [...current.history, { version: current.version, replaced_at: opts.now, protocol: before }],
    updated_at: opts.now
  }
}
