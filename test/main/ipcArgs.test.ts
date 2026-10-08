import { describe, expect, it } from 'vitest'
import { arg, ipcArgs } from '../../src/main/ipcArgs'

describe('IPC argument validation', () => {
  it('accepts citation keys and rejects anything that could escape the papers folder', () => {
    expect(arg(ipcArgs.paperId, 'he2017drain', 'id')).toBe('he2017drain')
    for (const bad of ['../etc', 'He2017', '2017he', '', 'a/b', 42, null]) {
      expect(() => arg(ipcArgs.paperId, bad, 'id')).toThrow('Invalid IPC argument: id')
    }
  })

  it('checks strings, numbers and lists', () => {
    expect(arg(ipcArgs.hash, null, 'hash')).toBeNull()
    expect(() => arg(ipcArgs.text, 5, 'text')).toThrow()
    expect(() => arg(ipcArgs.jobId, '3', 'job')).toThrow()
    expect(() => arg(ipcArgs.jobId, 1.5, 'job')).toThrow()
    expect(() => arg(ipcArgs.paths, ['/a.pdf', 3], 'paths')).toThrow()
    expect(arg(ipcArgs.optionalText, undefined, 'input')).toBeUndefined()
  })

  it('lets the renderer change only the contact email', () => {
    expect(arg(ipcArgs.settingsPatch, { contactEmail: 'me@uni.test' }, 'patch')).toEqual({ contactEmail: 'me@uni.test' })
    expect(() => arg(ipcArgs.settingsPatch, { lastProjectPath: '/elsewhere' }, 'patch')).toThrow()
    expect(() => arg(ipcArgs.settingsPatch, { contactEmail: 1 }, 'patch')).toThrow()
  })

  it('accepts only known project keys and policies', () => {
    expect(arg(ipcArgs.projectPatch, { pdfPolicy: 'lfs', name: 'Tesis' }, 'patch')).toEqual({ pdfPolicy: 'lfs', name: 'Tesis' })
    expect(() => arg(ipcArgs.projectPatch, { pdfPolicy: 'everywhere' }, 'patch')).toThrow()
    expect(() => arg(ipcArgs.projectPatch, { schema_version: 2 }, 'patch')).toThrow()
    expect(() => arg(ipcArgs.projectPatch, { name: '  ' }, 'patch')).toThrow()
  })
})
