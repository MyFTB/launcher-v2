import { describe, it, expect } from 'vitest'
import { validateMigrationTarget } from '../shared/migrate-validation'

describe('validateMigrationTarget', () => {
  it('rejects empty target', () => {
    expect(validateMigrationTarget('/old', '')).toEqual({ ok: false, error: 'empty' })
  })

  it('rejects whitespace-only target', () => {
    expect(validateMigrationTarget('/old', '   ')).toEqual({ ok: false, error: 'empty' })
  })

  it('rejects same directory (exact match)', () => {
    const r = validateMigrationTarget('/data', '/data')
    expect(r).toEqual({ ok: false, error: 'already-current' })
  })

  it('rejects same directory (case-insensitive on win32)', () => {
    const r = validateMigrationTarget('C:\\Data', 'c:\\data', 'win32')
    expect(r).toEqual({ ok: false, error: 'already-current' })
  })

  it('is case-sensitive on linux', () => {
    const r = validateMigrationTarget('/Data', '/data', 'linux')
    expect(r).toEqual({ ok: true })
  })

  it('rejects target inside current', () => {
    const r = validateMigrationTarget('/data', '/data/sub')
    expect(r).toEqual({ ok: false, error: 'nested' })
  })

  it('rejects current inside target', () => {
    const r = validateMigrationTarget('/data/sub', '/data')
    expect(r).toEqual({ ok: false, error: 'nested' })
  })

  it('does not falsely reject similar prefixes', () => {
    const r = validateMigrationTarget('/data', '/data-backup')
    expect(r).toEqual({ ok: true })
  })

  it('accepts valid different directory', () => {
    const r = validateMigrationTarget('/old', '/new')
    expect(r).toEqual({ ok: true })
  })

  it('accepts different drives on windows', () => {
    const r = validateMigrationTarget('C:\\old', 'D:\\new', 'win32')
    expect(r).toEqual({ ok: true })
  })
})