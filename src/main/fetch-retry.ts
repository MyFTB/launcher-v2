/**
 * Resilient fetch wrapper with automatic retry and hash verification helpers.
 *
 * Uses undici's fetch with the shared downloadDispatcher (connection pool,
 * extended connect timeout, redirect support). Retry decisions are explicit:
 * transient network failures and selected HTTP statuses are retried.
 */

import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { fetch as undiciFetch, type Response as UndiciResponse } from 'undici'

import { downloadDispatcher } from './download-agent'
import { logger } from './logger'
import { Constants } from './constants'

// ─── Retry wrapper ────────────────────────────────────────────────────────────

/** Sleep for `ms` milliseconds, aborting early if `signal` fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1_000), 60_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now), 60_000) : undefined
}

export function isRetryableNetworkError(error: unknown): boolean {
  const record = error as (NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException }) | undefined
  const code = record?.code ?? record?.cause?.code ?? ''
  if (/TLS|CERT|SSL/i.test(code)) return false
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return true
  return error instanceof Error && (error.name === 'TimeoutError' || (error instanceof TypeError && !code))
}

export interface FetchWithRetryOptions {
  signal?: AbortSignal
  /** Per-request timeout in ms (default: Constants.socketTimeoutMs). */
  timeoutMs?: number
  /** Max retry attempts after the initial try (default: 3). */
  maxRetries?: number
}

/**
 * Undici-backed fetch with automatic retry on transient errors.
 *
 * Retries on:
 *   - classified transient DNS, connection, and timeout failures
 *   - HTTP 408, 425, 429, and 5xx responses
 *
 * Exponential back-off: 1 s, 2 s, 4 s ... capped at 10 s.
 *
 * All requests go through the shared downloadDispatcher which provides
 * connection pooling, a 30 s connect timeout, and redirect support.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<UndiciResponse> {
  const { signal, timeoutMs = Constants.socketTimeoutMs, maxRetries = 3 } = options
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Only credential-free HTTPS downloads are allowed')
  }

  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()

    try {
      const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
      if (signal) signals.push(signal)
      const reqSignal = AbortSignal.any(signals)

      const res = await undiciFetch(url, {
        signal: reqSignal,
        dispatcher: downloadDispatcher,
      })

      if (isRetryableStatus(res.status) && attempt < maxRetries) {
        const delay = parseRetryAfter(res.headers.get('retry-after'))
          ?? Math.min(1_000 * 2 ** attempt, 10_000)
        await res.body?.cancel().catch(() => {})
        logger.warn(
          `[fetchWithRetry] ${parsed.hostname} returned ${res.status}; retry ${attempt + 1}/${maxRetries} in ${delay}ms`,
        )
        await sleep(delay, signal)
        continue
      }

      return res
    } catch (err: unknown) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err
      if (attempt >= maxRetries || !isRetryableNetworkError(err)) throw err
      const delay = Math.min(1_000 * 2 ** attempt, 10_000)
      logger.warn(
        `[fetchWithRetry] ${parsed.hostname} transient request failure; retry ${attempt + 1}/${maxRetries} in ${delay}ms`,
      )
      await sleep(delay, signal)
    }
  }
}

/** Read and parse a bounded JSON body, cancelling the connection on overflow. */
export async function readJsonResponseLimited(
  response: UndiciResponse,
  maximumBytes: number,
): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maximumBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Remote JSON response exceeds size limit')
  }
  if (!response.body) throw new Error('Remote JSON response has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let completed = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        completed = true
        break
      }
      received += chunk.value.byteLength
      if (received > maximumBytes) throw new Error('Remote JSON response exceeds size limit')
      chunks.push(chunk.value)
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

// ─── Hash verification ────────────────────────────────────────────────────────

/**
 * Detect hash algorithm from the hex digest length.
 * Falls back to sha1 for unrecognised lengths.
 */
export function detectHashAlgorithm(hash: string): string {
  switch (hash.length) {
    case 32:
      return 'md5'
    case 40:
      return 'sha1'
    case 64:
      return 'sha256'
    case 128:
      return 'sha512'
    default:
      return 'sha1'
  }
}

/**
 * Create a pass-through Transform stream that computes a hash on the fly.
 * Insert between the response body and the file write stream in a pipeline
 * to verify integrity without an extra disk read.
 *
 * Call `digest()` **once** after the pipeline completes to get the hex hash.
 */
export function createHashingStream(algorithm = 'sha1'): {
  stream: Transform
  digest: () => string
} {
  const hash = createHash(algorithm)
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  return { stream, digest: () => hash.digest('hex') }
}
