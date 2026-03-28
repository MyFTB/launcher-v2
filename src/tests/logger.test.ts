import { describe, it, expect } from 'vitest'
import { formatLogArg } from '../main/logger'

describe('formatLogArg', () => {
  it('serialises a plain string', () => {
    expect(formatLogArg('hello world')).toBe('hello world')
  })

  it('serialises a number', () => {
    expect(formatLogArg(42)).toBe('42')
  })

  it('serialises a plain object as JSON', () => {
    expect(formatLogArg({ a: 1 })).toBe('{"a":1}')
  })

  it('serialises a regular Error using its stack', () => {
    const err = new Error('something broke')
    const result = formatLogArg(err)
    expect(result).toContain('something broke')
  })

  it('falls back to constructor name when Error has no stack or message', () => {
    const err = new Error('')
    delete err.stack
    const result = formatLogArg(err)
    expect(result).toBe('Error: ')
  })

  describe('AggregateError', () => {
    it('includes first child message in "Caused by" line', () => {
      const agg = new AggregateError([new Error('Connect Timeout')], '')
      const result = formatLogArg(agg)
      expect(result).toContain('Caused by: Connect Timeout')
    })

    it('appends count when there are multiple children', () => {
      const agg = new AggregateError(
        [new Error('Connect Timeout'), new Error('ENOENT'), new Error('HTTP 503')],
        '',
      )
      const result = formatLogArg(agg)
      expect(result).toContain('Caused by: Connect Timeout (+2 more)')
    })

    it('does not append count for a single child', () => {
      const agg = new AggregateError([new Error('only one')], '')
      const result = formatLogArg(agg)
      expect(result).not.toContain('more)')
      expect(result).toContain('Caused by: only one')
    })

    it('falls back to child constructor name when child message is empty', () => {
      const child = new Error('')
      const agg = new AggregateError([child], '')
      const result = formatLogArg(agg)
      expect(result).toContain('Caused by: Error')
    })

    it('handles an empty errors array without crashing', () => {
      const agg = new AggregateError([], '')
      const result = formatLogArg(agg)
      expect(result).not.toContain('Caused by:')
    })

    it('handles non-Error children', () => {
      const agg = new AggregateError(['string child'], '')
      const result = formatLogArg(agg)
      expect(result).toContain('Caused by: string child')
    })
  })
})
