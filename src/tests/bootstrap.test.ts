import { describe, it, expect } from 'vitest'
import { parseDataDirPointer } from '../shared/pointer-file'

describe('parseDataDirPointer', () => {
  it('returns dataDir from valid JSON', () => {
    expect(parseDataDirPointer('{"dataDir":"D:\\\\Games\\\\MyFTB"}')).toBe('D:\\Games\\MyFTB')
  })

  it('handles forward-slash paths', () => {
    expect(parseDataDirPointer('{"dataDir":"/home/user/myftb"}')).toBe('/home/user/myftb')
  })

  it('returns null for empty dataDir', () => {
    expect(parseDataDirPointer('{"dataDir":""}')).toBeNull()
  })

  it('returns null for whitespace-only dataDir', () => {
    expect(parseDataDirPointer('{"dataDir":"   "}')).toBeNull()
  })

  it('returns null for missing dataDir key', () => {
    expect(parseDataDirPointer('{}')).toBeNull()
  })

  it('returns null for non-string dataDir', () => {
    expect(parseDataDirPointer('{"dataDir":42}')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseDataDirPointer('not json')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseDataDirPointer('')).toBeNull()
  })

  it('ignores extra keys', () => {
    expect(parseDataDirPointer('{"dataDir":"/data","version":2}')).toBe('/data')
  })
})