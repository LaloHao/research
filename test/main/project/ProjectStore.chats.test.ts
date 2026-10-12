import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConflictError } from '../../../src/main/project/errors'
import { renderChat } from '../../../src/main/project/chatFile'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { assistantMessage, CHAT_ID_A, chatFile, userMessage } from '../../helpers/chats'
import { tmpDir } from '../../helpers/tmp'

describe('ProjectStore chats', () => {
  it('writes, lists, reads and deletes conversations, hash-checked', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    expect(await store.listChatIds()).toEqual([])
    expect(await store.readChat(CHAT_ID_A)).toBeNull()
    const hash = await store.writeChat(chatFile(), null)
    await writeFile(join(store.root, 'chats', 'notes.md'), 'not a chat')
    expect(await store.listChatIds()).toEqual([CHAT_ID_A])
    const read = await store.readChat(CHAT_ID_A)
    expect(read).toMatchObject({ ok: true, hash, value: chatFile() })
    expect(await readFile(store.chatPath(CHAT_ID_A), 'utf8')).toBe(renderChat(chatFile()))
    await expect(store.writeChat(chatFile(), null)).rejects.toBeInstanceOf(ConflictError)
    await expect(store.deleteChat(CHAT_ID_A, 'other')).rejects.toBeInstanceOf(ConflictError)
    await store.deleteChat(CHAT_ID_A, hash)
    expect(existsSync(store.chatPath(CHAT_ID_A))).toBe(false)
    await store.deleteChat(CHAT_ID_A, hash)
  })

  it('never overwrites a file with conflict markers, and refuses an invalid id', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    await store.writeChat(chatFile(), null)
    const conflicted = `<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n`
    await writeFile(store.chatPath(CHAT_ID_A), conflicted)
    const read = await store.readChat(CHAT_ID_A)
    expect(read).toMatchObject({ ok: false, problem: { kind: 'conflict_markers' } })
    await expect(store.writeChat(chatFile(), read!.hash)).rejects.toBeInstanceOf(ConflictError)
    expect(await readFile(store.chatPath(CHAT_ID_A), 'utf8')).toBe(conflicted)
    expect(() => store.chatPath('../project')).toThrow()
  })

  it('reads a conversation whose frontmatter id does not match its file name as invalid', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    await store.writeChat(chatFile(), null)
    const other = '20261011-120000-ffff'
    await writeFile(store.chatPath(other), renderChat(chatFile()))
    expect(await store.readChat(other)).toMatchObject({ ok: false, problem: { kind: 'invalid_schema' } })
  })

  it('refuses a message that would break the file, writing nothing', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    for (const bad of [
      userMessage({ at: '2026 x' }),
      userMessage({ at: '' }),
      assistantMessage({ model: 'a\n## Tú — b' }),
      assistantMessage({ model: 'a · b' }),
      assistantMessage({ model: 'detenida' }),
      assistantMessage({ costUsd: 1e21 }),
      assistantMessage({ costUsd: -1 }),
      userMessage({ excerpt: { paper: 'he2017drain', page: 1, quote: 'ends "]] early' } })
    ]) {
      await expect(store.writeChat(chatFile([userMessage(), bad]), null)).rejects.toThrow()
    }
    expect(await store.listChatIds()).toEqual([])
  })

  it('recomputes cost_usd from the answers', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    await store.writeChat(chatFile([userMessage(), assistantMessage({ costUsd: 0.1 }), assistantMessage({ costUsd: 0.2 })], { cost_usd: 7 }), null)
    expect(await store.readChat(CHAT_ID_A)).toMatchObject({ ok: true, value: { meta: { cost_usd: 0.3 } } })
  })
})
