import { isDeepStrictEqual } from 'node:util'
import { CHAT_ID, type ChatFile, type ChatMessage, type ChatMeta } from '../../shared/chat'
import { sha256 } from '../project/atomicWrite'
import { CHATS_DIR, chatFileName, checkMessages, parseChat, renderChat, totalCost } from '../project/chatFile'
import type { MergeInput } from './mergers'

/** A conversation file, relative to the project folder: `chats/<id>.md`. */
export const CHAT_PATH = new RegExp(`^${CHATS_DIR}/${CHAT_ID.source.slice(1, -1)}\\.md$`)

/** The conversation's id from its path relative to the project folder, or null when it is not a conversation file. */
export function chatIdOfPath(relPath: string): string | null {
  return CHAT_PATH.test(relPath) ? relPath.slice(CHATS_DIR.length + 1, -3) : null
}

/** The merged conversation, plus the other machine's version as a new conversation when the two cannot be joined. */
export type ChatMergeResult = { text: string; copy: { relPath: string; text: string } | null }

const instant = (s: string): number => {
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

/** Whether `short` is the start of `long`: the same messages, in order. */
const isPrefix = (short: ChatMessage[], long: ChatMessage[]): boolean => short.length <= long.length && short.every((m, i) => isDeepStrictEqual(m, long[i]))

type MergedField = 'title' | 'model' | 'archived' | 'actions' | 'sync' | 'writing'

/** title, model, archived, the switches and an editor conversation's passage (its mode): changed on one machine only → that machine's value; on both → the newest `updated_at`'s. */
function mergeMeta(base: ChatMeta | null, ours: ChatMeta, theirs: ChatMeta): ChatMeta {
  const newer = instant(theirs.updated_at) > instant(ours.updated_at) ? theirs : ours
  const pick = <K extends MergedField>(key: K): ChatMeta[K] => {
    if (base) {
      const oursChanged = !isDeepStrictEqual(ours[key], base[key])
      const theirsChanged = !isDeepStrictEqual(theirs[key], base[key])
      if (oursChanged && !theirsChanged) return ours[key]
      if (theirsChanged && !oursChanged) return theirs[key]
    }
    return newer[key]
  }
  const meta: ChatMeta = {
    ...theirs,
    ...ours,
    title: pick('title'),
    model: pick('model'),
    archived: pick('archived'),
    actions: pick('actions'),
    sync: pick('sync'),
    updated_at: newer.updated_at
  }
  const writing = pick('writing')
  if (writing === undefined) delete meta.writing
  else meta.writing = writing
  if (newer.updated_on === undefined) delete meta.updated_on
  else meta.updated_on = newer.updated_on
  return meta
}

/**
 * The conversation as the file will hold it, or null when it would not read back with the same messages (or a message
 * would not pass the writer's check): the merge never writes a conversation the app could not write itself, nor drops a
 * message on the way.
 */
function renderChecked(file: ChatFile): string | null {
  try {
    checkMessages(file.messages)
  } catch {
    return null
  }
  const text = renderChat({ meta: { ...file.meta, cost_usd: totalCost(file.messages) }, messages: file.messages })
  const back = parseChat(text)
  return back.ok && back.value.meta.id === file.meta.id && isDeepStrictEqual(back.value.messages, file.messages) ? text : null
}

/**
 * chats/<id>.md changed on both machines. When one side only added messages at the end of what the other has (or
 * neither added any), the conversation merges: the longer list, and title/model/archived/actions/sync field by field. Otherwise both
 * are kept: ours at its path, theirs as `<id>-<6 hex of its text>` marked `copy_of` (the same id on every machine that
 * merges the same two versions). Null when a side cannot be read (conflict markers, invalid frontmatter, a frontmatter
 * id that is not `fileId`, the file's own): the user decides, as for any other file.
 */
export function mergeChatText({ base, ours, theirs }: MergeInput, fileId?: string): ChatMergeResult | null {
  const o = parseChat(ours)
  const t = parseChat(theirs)
  if (!o.ok || !t.ok) return null
  if (fileId !== undefined && (o.value.meta.id !== fileId || t.value.meta.id !== fileId)) return null
  const b = base === null ? null : parseChat(base)
  const baseMeta = b?.ok ? b.value.meta : null
  const om = o.value.messages
  const tm = t.value.messages
  if (isPrefix(om, tm) || isPrefix(tm, om)) {
    const messages = om.length >= tm.length ? om : tm
    const text = renderChecked({ meta: mergeMeta(baseMeta, o.value.meta, t.value.meta), messages })
    return text === null ? null : { text, copy: null }
  }
  const id = `${t.value.meta.id}-${sha256(theirs).slice(0, 6)}`
  if (!CHAT_ID.test(id)) return null
  const copy = renderChecked({ meta: { ...t.value.meta, id, copy_of: { id: t.value.meta.id, machine: t.value.meta.updated_on ?? null } }, messages: tm })
  if (copy === null) return null
  return { text: ours, copy: { relPath: `${CHATS_DIR}/${chatFileName(id)}`, text: copy } }
}
