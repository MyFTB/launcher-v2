import { describe, it, expect } from 'vitest'
import path from 'node:path'

import { isPathWithinDir } from '../main/services/install.service'

// ─── isPathWithinDir ─────────────────────────────────────────────────────────

describe('isPathWithinDir', () => {
  const base = path.join('/', 'home', 'user', '.myftb', 'instances', 'mypack')

  it('accepts a simple filename', () => {
    expect(isPathWithinDir(base, 'mods/mymod.jar')).toBe(true)
  })

  it('accepts a nested relative path', () => {
    expect(isPathWithinDir(base, 'config/forge/settings.cfg')).toBe(true)
  })

  it('rejects classic ../ traversal to parent', () => {
    expect(isPathWithinDir(base, '../otherpack/evil.jar')).toBe(false)
  })

  it('rejects deep traversal escaping base entirely', () => {
    expect(isPathWithinDir(base, '../../../../etc/passwd')).toBe(false)
  })

  it('rejects traversal that escapes then re-enters a sibling dir', () => {
    expect(isPathWithinDir(base, '../mypack2/file.jar')).toBe(false)
  })

  it('rejects an absolute path to a different location', () => {
    const absolute = process.platform === 'win32' ? 'C:\\Windows\\evil.exe' : '/etc/evil'
    expect(isPathWithinDir(base, absolute)).toBe(false)
  })

  it('accepts a path with redundant ./ segments', () => {
    expect(isPathWithinDir(base, './mods/../config/options.txt')).toBe(true)
  })
})
