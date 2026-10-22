import { isDeepStrictEqual } from 'node:util'
import { DRAFT_ID, type DraftFile, type DraftMeta } from '../../shared/writing/draft'
import { sha256 } from '../project/atomicWrite'
import { DRAFTS_DIR, draftFileName, parseDraft, renderDraft } from '../project/draftFile'
import type { ChatMergeResult } from './chatMerge'
import type { MergeInput } from './mergers'

/** A draft file, relative to the project folder: `drafts/<id>.md`. */
export const DRAFT_PATH = new RegExp(`^${DRAFTS_DIR}/${DRAFT_ID.source.slice(1, -1)}\\.md$`)

/** The draft's id from its path relative to the project folder, or null when it is not a draft file. */
export function draftIdOfPath(relPath: string): string | null {
  return DRAFT_PATH.test(relPath) ? relPath.slice(DRAFTS_DIR.length + 1, -3) : null
}

const instant = (s: string): number => {
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

/** The versions (heading data and text) of a draft, compared as a whole. */
const versionsOf = (f: DraftFile): unknown[] => f.meta.versions.map((v, i) => ({ ...v, text: f.texts[i] }))
const isPrefix = (short: unknown[], long: unknown[]): boolean => short.length <= long.length && short.every((v, i) => isDeepStrictEqual(v, long[i]))

/**
 * The longer side's frontmatter (a new version was written from its form), with the title and «archivado» taken field
 * by field: changed on one machine only → that machine's value; on both → the newest `updated_at`'s.
 */
function mergeMeta(base: DraftMeta | null, longer: DraftMeta, ours: DraftMeta, theirs: DraftMeta): DraftMeta {
  const newer = instant(theirs.updated_at) > instant(ours.updated_at) ? theirs : ours
  const pick = <K extends 'title' | 'archived'>(key: K): DraftMeta[K] => {
    if (base) {
      const oursChanged = !isDeepStrictEqual(ours[key], base[key])
      const theirsChanged = !isDeepStrictEqual(theirs[key], base[key])
      if (oursChanged && !theirsChanged) return ours[key]
      if (theirsChanged && !oursChanged) return theirs[key]
    }
    return newer[key]
  }
  const meta: DraftMeta = { ...theirs, ...ours, ...longer, title: pick('title'), archived: pick('archived'), updated_at: newer.updated_at }
  if (newer.updated_on === undefined) delete meta.updated_on
  else meta.updated_on = newer.updated_on
  return meta
}

/** The draft as the file will hold it, or null when it would not read back with the same versions. */
function renderChecked(file: DraftFile): string | null {
  let text: string
  try {
    text = renderDraft(file)
  } catch {
    return null
  }
  const back = parseDraft(text)
  return back.ok && back.value.meta.id === file.meta.id && isDeepStrictEqual(back.value.texts, file.texts) ? text : null
}

/**
 * drafts/<id>.md changed on both machines. When one side only added versions after what the other has (or neither
 * changed a version), the draft merges: the longer side, and the title and «archivado» field by field. Otherwise (the
 * same version edited differently, or different versions written) both are kept: ours at its path, theirs as
 * `<id>-<6 hex of its text>` marked `copy_of`, which the list shows as «(copia de <equipo>)». Null when a side cannot be
 * read (conflict markers, invalid frontmatter, a frontmatter id that is not `fileId`): the user decides.
 */
export function mergeDraftText({ base, ours, theirs }: MergeInput, fileId?: string): ChatMergeResult | null {
  const o = parseDraft(ours)
  const t = parseDraft(theirs)
  if (!o.ok || !t.ok) return null
  if (fileId !== undefined && (o.value.meta.id !== fileId || t.value.meta.id !== fileId)) return null
  const b = base === null ? null : parseDraft(base)
  const baseMeta = b?.ok ? b.value.meta : null
  const ov = versionsOf(o.value)
  const tv = versionsOf(t.value)
  if (isPrefix(ov, tv) || isPrefix(tv, ov)) {
    const longer = ov.length >= tv.length ? o.value : t.value
    const text = renderChecked({ meta: mergeMeta(baseMeta, longer.meta, o.value.meta, t.value.meta), texts: longer.texts })
    return text === null ? null : { text, copy: null }
  }
  const id = `${t.value.meta.id}-${sha256(theirs).slice(0, 6)}`
  if (!DRAFT_ID.test(id)) return null
  const copy = renderChecked({ meta: { ...t.value.meta, id, copy_of: { id: t.value.meta.id, machine: t.value.meta.updated_on ?? null } }, texts: t.value.texts })
  if (copy === null) return null
  return { text: ours, copy: { relPath: `${DRAFTS_DIR}/${draftFileName(id)}`, text: copy } }
}
