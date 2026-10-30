import { describe, expect, it } from 'vitest'
import { clipboardAction } from '../../../src/main/tray/clipboardAction'

describe('clipboard action', () => {
  it('adds what the «Agregar» box accepts: a DOI, an arXiv or OpenAlex id, an http(s) address', () => {
    for (const text of ['10.1109/ICWS.2017.13', 'doi: 10.1109/ICWS.2017.13', 'https://doi.org/10.1109/ICWS.2017.13', '2008.06448', 'arXiv:2008.06448v2', 'W2132031035', 'https://example.org/paper']) {
      expect(clipboardAction(text, 'add')).toEqual({ kind: 'add', input: text })
    }
    expect(clipboardAction('  10.1109/ICWS.2017.13\n', 'add')).toEqual({ kind: 'add', input: '10.1109/ICWS.2017.13' })
  })

  it('does nothing with plain text, several lines, other schemes or something far too long', () => {
    for (const text of ['', '   ', 'hola mundo', 'a paragraph about 10.1109/ICWS.2017.13 copied whole', 'https://a.org\nhttps://b.org', 'ftp://example.org/x', 'file:///etc/passwd', `https://example.org/${'x'.repeat(5000)}`]) {
      expect(clipboardAction(text, 'add')).toEqual({ kind: 'none' })
    }
  })

  it('opens only http(s) addresses in the app browser', () => {
    expect(clipboardAction(' https://arxiv.org/abs/2008.06448 ', 'browse')).toEqual({ kind: 'browse', url: 'https://arxiv.org/abs/2008.06448' })
    expect(clipboardAction('http://example.org', 'browse')).toEqual({ kind: 'browse', url: 'http://example.org' })
    for (const text of ['10.1109/ICWS.2017.13', '2008.06448', 'javascript:alert(1)', 'file:///etc/passwd', 'example.org', 'hola']) {
      expect(clipboardAction(text, 'browse')).toEqual({ kind: 'none' })
    }
  })
})
