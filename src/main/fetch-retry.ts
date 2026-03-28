/**
 * Resilient fetch wrapper with automatic retry and hash verification helpers.
 *
 * Uses undici's fetch with the shared downloadDispatcher (connection pool,
 * extended connect timeout, redirect support).  Retry is handled here rather
 * than via undici's retry interceptor so that ANY non-abort error is retried
 * without maintaining an explicit error-code allowlist.
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
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
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
 *   - Any network-level error except AbortError (no error-code allowlist)
 *   - HTTP 429 (Too Many Requests) and 5xx (Server Error)
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
        logger.warn(
          `[fetchWithRetry] ${url} returned ${res.status}, ` +
            `retrying (${attempt + 1}/${maxRetries})...`,
        )
        await sleep(Math.min(1_000 * 2 ** attempt, 10_000), signal)
        continue
      }

      return res
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') throw err
      if (attempt >= maxRetries) throw err

      logger.warn(
        `[fetchWithRetry] ${url} failed (${(err as Error).message}), ` +
          `retrying (${attempt + 1}/${maxRetries})...`,
      )
      await sleep(Math.min(1_000 * 2 ** attempt, 10_000), signal)
    }
  }
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
