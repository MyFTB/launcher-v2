/**
 * Shared undici dispatchers for all download operations.
 *
 * Two dispatchers are exported:
 *
 *   downloadDispatcher      — connection pool + extended timeout + redirect.
 *                              Used by fetchWithRetry which handles retry itself.
 *
 *   xmclDownloadDispatcher  — same base config plus undici's built-in retry
 *                              interceptor.  Passed to @xmcl/installer calls.
 *
 * Both raise the connect timeout to Constants.connectTimeoutMs (30 s) to cope
 * with congested networks and slow CDN routing.
 */
import { Agent, interceptors } from 'undici'
import type { RetryHandler } from 'undici'

import { Constants } from './constants'

/**
 * Base dispatcher: connection pool + extended connect timeout + redirect.
 * No retry — fetchWithRetry applies its own retry strategy on top.
 */
export const downloadDispatcher = new Agent({
  connections: 16,
  connect: { timeout: Constants.connectTimeoutMs },
}).compose(
  interceptors.redirect({ maxRedirections: 5 }),
)

const RETRY_OPTIONS: RetryHandler.RetryOptions = {
  maxRetries: 3,
  minTimeout: 1_000,
  maxTimeout: 10_000,
  timeoutFactor: 2,
  // Omit errorCodes and statusCodes to use undici's sensible defaults:
  //   errorCodes: ECONNRESET, ECONNREFUSED, ENOTFOUND, ENETDOWN, ENETUNREACH,
  //              EHOSTDOWN, EHOSTUNREACH, EPIPE, UND_ERR_SOCKET
  //   statusCodes: 500, 502, 503, 504, 429
  // The 30 s connect timeout makes UND_ERR_CONNECT_TIMEOUT rare enough that
  // it does not need explicit retry; no allowlist to maintain.
}

/**
 * Extended dispatcher for @xmcl/installer downloads.
 * Adds undici's built-in retry interceptor on top of the base config.
 */
export const xmclDownloadDispatcher = new Agent({
  connections: 16,
  connect: { timeout: Constants.connectTimeoutMs },
}).compose(
  interceptors.retry(RETRY_OPTIONS),
  interceptors.redirect({ maxRedirections: 5 }),
)
