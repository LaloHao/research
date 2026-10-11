import { describe, expect, it } from 'vitest'
import { CONFLICT_ID, hasPasswordInUrl, isRemoteUrl } from '../../src/shared/sync'

describe('remote URLs', () => {
  it('accepts the usual remotes, a user name included', () => {
    for (const url of [
      'git@github.com:me/thesis.git',
      'https://github.com/me/thesis.git',
      'https://me@gitlab.com/me/thesis.git',
      'ssh://git@host.example:2222/thesis.git',
      '/media/usb/thesis.git',
      'C:\\remotes\\thesis.git'
    ]) {
      expect(isRemoteUrl(url)).toBe(true)
    }
  })

  it('refuses what git would read as an option, whitespace, control characters and a password in the URL', () => {
    for (const url of ['', '-u', '--upload-pack=touch /tmp/x', 'a b', 'x\ny', 'https://me:secret@github.com/me/thesis.git']) {
      expect(isRemoteUrl(url)).toBe(false)
    }
    expect(hasPasswordInUrl('https://me:secret@github.com/x.git')).toBe(true)
    expect(hasPasswordInUrl('https://me@github.com/x.git')).toBe(false)
    expect(hasPasswordInUrl('git@github.com:me/x.git')).toBe(false)
  })

  it('names conflicts by file or by paper', () => {
    expect(CONFLICT_ID.test('file:papers/he2017drain/summary.md')).toBe(true)
    expect(CONFLICT_ID.test('paper:he2017drain')).toBe(true)
    for (const id of ['file:', 'paper:', 'paper:../x', 'papers/he2017drain/summary.md']) expect(CONFLICT_ID.test(id)).toBe(false)
  })
})
