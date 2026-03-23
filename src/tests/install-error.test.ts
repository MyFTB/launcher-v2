import { describe, it, expect } from 'vitest'
import { formatInstallError } from '../main/services/install.service'

describe('formatInstallError', () => {
  it('returns the message of a plain Error', () => {
    expect(formatInstallError(new Error('network timeout'))).toBe('network timeout')
  })

  it('falls back to constructor name when Error.message is empty', () => {
    const err = new Error('')
    expect(formatInstallError(err)).toBe('Error')
  })

  it('returns the child message for an AggregateError with one child', () => {
    const agg = new AggregateError([new Error('ENOENT: file not found')], '')
    expect(formatInstallError(agg)).toBe('ENOENT: file not found')
  })

  it('returns first child message + count for an AggregateError with multiple children', () => {
    const agg = new AggregateError(
      [new Error('ENOENT: file not found'), new Error('HTTP 404'), new Error('timeout')],
      '',
    )
    expect(formatInstallError(agg)).toBe('ENOENT: file not found (+2 more)')
  })

  it('falls back to "AggregateError" when errors array is empty', () => {
    const agg = new AggregateError([], '')
    expect(formatInstallError(agg)).toBe('AggregateError')
  })

  it('uses constructor name for AggregateError child with empty message', () => {
    const child = new Error('')
    child.constructor = class CustomError {}
    const agg = new AggregateError([child], '')
    // child.message is '', child.constructor.name is 'CustomError'
    expect(formatInstallError(agg)).toBe('CustomError')
  })

  it('handles a non-Error thrown value (string)', () => {
    expect(formatInstallError('something went wrong')).toBe('something went wrong')
  })

  it('handles a non-Error thrown value (number)', () => {
    expect(formatInstallError(42)).toBe('42')
  })
})
