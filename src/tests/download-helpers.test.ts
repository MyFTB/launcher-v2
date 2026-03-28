import { describe, it, expect } from 'vitest'
import { Readable, PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { detectHashAlgorithm, createHashingStream } from '../main/fetch-retry'

// ─── detectHashAlgorithm ─────────────────────────────────────────────────────

describe('detectHashAlgorithm', () => {
  it('detects MD5 from 32-char hex string', () => {
    expect(detectHashAlgorithm('d41d8cd98f00b204e9800998ecf8427e')).toBe('md5')
  })

  it('detects SHA-1 from 40-char hex string', () => {
    expect(detectHashAlgorithm('da39a3ee5e6b4b0d3255bfef95601890afd80709')).toBe('sha1')
  })

  it('detects SHA-256 from 64-char hex string', () => {
    expect(detectHashAlgorithm(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )).toBe('sha256')
  })

  it('detects SHA-512 from 128-char hex string', () => {
    expect(detectHashAlgorithm(
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce' +
      '47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
    )).toBe('sha512')
  })

  it('falls back to sha1 for unknown lengths', () => {
    expect(detectHashAlgorithm('abc123')).toBe('sha1')
    expect(detectHashAlgorithm('')).toBe('sha1')
  })
})

// ─── createHashingStream ─────────────────────────────────────────────────────

describe('createHashingStream', () => {
  it('computes correct SHA-1 hash for known data', async () => {
    const { stream, digest } = createHashingStream('sha1')
    const input = Readable.from([Buffer.from('hello world')])
    const output = new PassThrough()
    await pipeline(input, stream, output)
    expect(digest()).toBe('2aae6c35c94fcfb415dbe95f408b9ce91ee846ed')
  })

  it('passes data through unchanged', async () => {
    const { stream } = createHashingStream('sha1')
    const chunks: Buffer[] = []
    const input = Readable.from([Buffer.from('test data')])
    const output = new PassThrough()
    output.on('data', (chunk: Buffer) => chunks.push(chunk))
    await pipeline(input, stream, output)
    expect(Buffer.concat(chunks).toString()).toBe('test data')
  })

  it('computes correct SHA-256 hash of empty input', async () => {
    const { stream, digest } = createHashingStream('sha256')
    const input = Readable.from([Buffer.from('')])
    const output = new PassThrough()
    await pipeline(input, stream, output)
    expect(digest()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('handles multiple chunks', async () => {
    const { stream, digest } = createHashingStream('sha1')
    const input = Readable.from([Buffer.from('hello'), Buffer.from(' '), Buffer.from('world')])
    const output = new PassThrough()
    await pipeline(input, stream, output)
    // Same as "hello world" in one chunk
    expect(digest()).toBe('2aae6c35c94fcfb415dbe95f408b9ce91ee846ed')
  })
})
