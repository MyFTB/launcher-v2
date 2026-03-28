/**
 * Shared undici dispatcher for all @xmcl/installer downloads.
 *
 * The @xmcl/file-transfer default agent uses a 10-second connect timeout and
 * does not retry on UND_ERR_CONNECT_TIMEOUT. Users on congested networks or
 * with slow Microsoft CDN routing regularly hit this limit when downloading
 * Minecraft assets (resources.download.minecraft.net).
 *
 * This dispatcher:
 *   - Raises the connect timeout to Constants.connectTimeoutMs (30 s)
 *   - Retries up to 3 times with exponential back-off (1 s, 2 s, 4 s)
 *   - Explicitly retries on UND_ERR_CONNECT_TIMEOUT in addition to the
 *     standard network error codes
 */
import { Agent, interceptors } from 'undici'
import type { RetryHandler } from 'undici'

import { Constants } from './constants'

const RETRY_ERROR_CODES: string[] = [
  // Standard Node.js network errors
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  // undici errors
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]

const RETRY_OPTIONS: RetryHandler.RetryOptions = {
  maxRetries: 3,
  minTimeout: 1_000,
  maxTimeout: 10_000,
  timeoutFactor: 2,
  errorCodes: RETRY_ERROR_CODES,
}

export const xmclDownloadDispatcher = new Agent({
  connections: 16,
  connect: { timeout: Constants.connectTimeoutMs },
}).compose(
  interceptors.retry(RETRY_OPTIONS),
  interceptors.redirect({ maxRedirections: 5 }),
)
