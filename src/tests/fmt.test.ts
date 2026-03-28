import { describe, it, expect } from 'vitest'
import { fmt } from '../main/constants'

describe('fmt', () => {
  it('replaces multiple %s placeholders in order', () => {
    expect(fmt('Hello %s, welcome to %s!', 'Alice', 'Wonderland')).toBe(
      'Hello Alice, welcome to Wonderland!',
    )
  })

  it('replaces a single %s placeholder', () => {
    expect(fmt('https://example.com/%s', 'abc123')).toBe('https://example.com/abc123')
  })

  it('leaves leftover %s when fewer args than placeholders', () => {
    expect(fmt('%s and %s and %s', 'one')).toBe('one and %s and %s')
  })

  it('ignores extra args when more args than placeholders', () => {
    expect(fmt('only %s here', 'first', 'second', 'third')).toBe('only first here')
  })

  it('returns template unchanged when no placeholders', () => {
    expect(fmt('no placeholders at all')).toBe('no placeholders at all')
  })

  it('returns empty string for empty template', () => {
    expect(fmt('')).toBe('')
  })

  it('handles empty string args', () => {
    expect(fmt('a%sb', '')).toBe('ab')
  })
})
