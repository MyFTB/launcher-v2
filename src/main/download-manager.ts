import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fetch as undiciFetch, type Response as UndiciResponse } from 'undici'

import type { DownloadFailure, DownloadFailureKind } from '../shared/types'
import { downloadDispatcher } from './download-agent'
import { Constants } from './constants'
import { logger } from './logger'
import { detectHashAlgorithm } from './fetch-retry'

interface PartialMetadata {
  version: 1
  url: string
  hash: string
  etag?: string
  lastModified?: string
  total?: number
}

export interface DownloadFileOptions {
  url: string
  target: string
  hash: string
  signal?: AbortSignal
  maxRetries?: number
  headerTimeoutMs?: number
  idleTimeoutMs?: number
  requireStrongHash?: boolean
  taskName?: string
  onBytes?: (received: number) => void
}

export interface DownloadSuccess {
  attempts: number
  bytesReceived: number
  resumed: boolean
  durationMs: number
}

export class DownloadError extends Error {
  constructor(readonly failure: DownloadFailure, options?: ErrorOptions) {
    super(failure.message, options)
    this.name = 'DownloadError'
  }
}

export function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase().replace(/^(?:md5|sha1|sha256|sha512):/, '')
}

export function isStrongHash(hash: string): boolean {
  const length = normalizeHash(hash).length
  return length === 64 || length === 128
}

function isSupportedHash(hash: string): boolean {
  return [32, 40, 64, 128].includes(normalizeHash(hash).length)
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? abortError())
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function retryAfterMs(response: UndiciResponse): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1_000), 60_000)
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return undefined
  return Math.min(Math.max(0, date - Date.now()), 60_000)
}

function backoff(attempt: number): number {
  const base = Math.min(750 * 2 ** Math.max(0, attempt - 1), 15_000)
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

function classifyError(error: unknown): { kind: DownloadFailureKind; retryable: boolean } {
  if (error instanceof DownloadError) {
    return { kind: error.failure.kind, retryable: error.failure.retryable }
  }
  if (error instanceof Error && error.name === 'AbortError') return { kind: 'cancelled', retryable: false }
  const record = error as (NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException }) | undefined
  const code = record?.code ?? record?.cause?.code ?? ''
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return { kind: 'dns', retryable: true }
  if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code)) {
    return { kind: 'connection', retryable: true }
  }
  if (code.includes('TLS') || code.includes('CERT')) return { kind: 'tls', retryable: false }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return { kind: 'permission', retryable: false }
  if (code === 'ENOSPC' || code === 'EDQUOT') return { kind: 'disk', retryable: false }
  if (error instanceof Error && /timeout/i.test(error.name + error.message)) return { kind: 'timeout', retryable: true }
  if (error instanceof TypeError && !code) return { kind: 'connection', retryable: true }
  return { kind: 'unknown', retryable: false }
}

async function hashFile(filePath: string, expectedHash: string): Promise<string> {
  const algorithm = detectHashAlgorithm(expectedHash)
  const hash = crypto.createHash(algorithm)
  const handle = await fs.open(filePath, 'r')
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer)
    return hash.digest('hex').toLowerCase()
  } finally {
    await handle.close().catch(() => {})
  }
}

async function loadMetadata(filePath: string): Promise<PartialMetadata | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as PartialMetadata
    return value.version === 1 && typeof value.url === 'string' && typeof value.hash === 'string'
      ? value
      : null
  } catch {
    return null
  }
}

async function atomicReplace(partial: string, target: string): Promise<void> {
  const backup = `${target}.replace-${process.pid}-${crypto.randomUUID()}`
  let hadTarget = false
  try {
    try {
      await fs.rename(target, backup)
      hadTarget = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await fs.rename(partial, target)
    if (hadTarget) await fs.rm(backup, { force: true })
  } catch (error) {
    if (hadTarget) await fs.rename(backup, target).catch(() => {})
    throw error
  }
}

async function request(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ response: UndiciResponse; controller: AbortController; cleanup: () => void }> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(signal?.reason ?? abortError())
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('Header timeout', 'TimeoutError')), timeoutMs)
  try {
    const response = await undiciFetch(url, {
      headers,
      signal: controller.signal,
      dispatcher: downloadDispatcher,
    })
    clearTimeout(timer)
    return {
      response,
      controller,
      cleanup: () => signal?.removeEventListener('abort', onAbort),
    }
  } catch (error) {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    throw error
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  controller: AbortController,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new DOMException('Body idle timeout', 'TimeoutError')
          controller.abort(error)
          reject(error)
        }, idleTimeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function parseContentRange(response: UndiciResponse): { start: number; end: number; total?: number } | null {
  const match = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i)
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? undefined : Number(match[3])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null
  if (total !== undefined && (!Number.isSafeInteger(total) || total <= end)) return null
  return { start, end, ...(total !== undefined ? { total } : {}) }
}

export async function downloadFile(options: DownloadFileOptions): Promise<DownloadSuccess> {
  const url = new URL(options.url)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new DownloadError({
      task: options.taskName ?? path.basename(options.target),
      host: url.hostname,
      kind: 'invalid-source',
      message: 'Downloads sind nur über HTTPS ohne eingebettete Zugangsdaten erlaubt.',
      retryable: false,
      attempts: 0,
    })
  }
  const expectedHash = normalizeHash(options.hash)
  if (!/^[0-9a-f]+$/.test(expectedHash) || !isSupportedHash(expectedHash) || (options.requireStrongHash && !isStrongHash(expectedHash))) {
    throw new DownloadError({
      task: options.taskName ?? path.basename(options.target),
      host: url.hostname,
      kind: 'invalid-source',
      message: 'Für diesen Download fehlt eine starke Prüfsumme.',
      retryable: false,
      attempts: 0,
    })
  }

  const maximumRetries = options.maxRetries ?? 3
  const partial = `${options.target}.part`
  const metadataPath = `${partial}.json`
  await fs.mkdir(path.dirname(options.target), { recursive: true })
  let lastFailure: DownloadFailure | undefined

  for (let attempt = 1; attempt <= maximumRetries + 1; attempt++) {
    options.signal?.throwIfAborted()
    const started = Date.now()
    let receivedThisAttempt = 0
    let resumed = false
    let requestCleanup: (() => void) | undefined
    let requestController: AbortController | undefined
    let responseBody: UndiciResponse['body'] | null = null
    try {
      let offset = 0
      let partialMtime = 0
      let metadata = await loadMetadata(metadataPath)
      try {
        const stat = await fs.stat(partial)
        offset = stat.size
        partialMtime = stat.mtimeMs
      } catch {
        offset = 0
      }
      if (
        offset <= 0
        || !metadata
        || metadata.url !== options.url
        || normalizeHash(metadata.hash) !== expectedHash
        || (!metadata.etag && !metadata.lastModified)
        || (metadata.total !== undefined && (!Number.isSafeInteger(metadata.total) || metadata.total <= 0 || offset > metadata.total))
        || (partialMtime > 0 && Date.now() - partialMtime > 7 * 24 * 60 * 60 * 1_000)
      ) {
        offset = 0
        metadata = null
        await fs.rm(partial, { force: true }).catch(() => {})
        await fs.rm(metadataPath, { force: true }).catch(() => {})
      }

      const headers: Record<string, string> = {}
      if (offset > 0 && metadata) {
        headers.Range = `bytes=${offset}-`
        headers['If-Range'] = metadata.etag ?? metadata.lastModified!
      }
      const { response, controller, cleanup } = await request(
        options.url,
        headers,
        options.signal,
        options.headerTimeoutMs ?? Constants.connectTimeoutMs,
      )
      requestCleanup = cleanup
      requestController = controller
      responseBody = response.body

      if (response.status === 416 && offset > 0) {
        await response.body?.cancel().catch(() => {})
        cleanup()
        requestCleanup = undefined
        await fs.rm(partial, { force: true })
        await fs.rm(metadataPath, { force: true })
        throw new DownloadError({
          task: options.taskName ?? path.basename(options.target),
          host: url.hostname,
          kind: 'connection',
          message: 'Der Server hat den Wiederaufnahmebereich abgelehnt.',
          retryable: true,
          attempts: attempt,
        })
      }
      if (isRetryableStatus(response.status)) {
        const delay = retryAfterMs(response)
        await response.body?.cancel().catch(() => {})
        throw new DownloadError({
          task: options.taskName ?? path.basename(options.target),
          host: url.hostname,
          kind: 'http',
          message: `Download-Server antwortet mit HTTP ${response.status}.`,
          retryable: true,
          attempts: attempt,
          status: response.status,
          bytesReceived: offset,
          ...(delay !== undefined ? { retryAfterMs: delay } : {}),
        } as DownloadFailure & { retryAfterMs?: number })
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadError({
          task: options.taskName ?? path.basename(options.target),
          host: url.hostname,
          kind: 'http',
          message: `Download abgelehnt (HTTP ${response.status}).`,
          retryable: false,
          attempts: attempt,
          status: response.status,
        })
      }

      const contentRange = response.status === 206 ? parseContentRange(response) : null
      const rangedLength = contentRange ? contentRange.end - contentRange.start + 1 : undefined
      const responseLength = Number(response.headers.get('content-length') ?? 0)
      const validRange = !!contentRange
        && contentRange.start === offset
        && (responseLength <= 0 || rangedLength === responseLength)
        && (metadata?.total === undefined || contentRange.total === undefined || metadata.total === contentRange.total)
      if (offset > 0 && response.status === 206 && validRange) {
        resumed = true
      } else if (offset > 0) {
        // A 200 or mismatched Content-Range means the server ignored resume.
        offset = 0
        resumed = false
        await fs.rm(partial, { force: true })
      }
      if (offset === 0 && response.status === 206 && !validRange) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadError({
          task: options.taskName ?? path.basename(options.target),
          host: url.hostname,
          kind: 'connection',
          message: 'Der Server hat einen ungültigen Teilbereich gesendet.',
          retryable: true,
          attempts: attempt,
        })
      }
      if (!response.body) throw new Error('Download response has no body')

      const totalHeader = Number(response.headers.get('content-length') ?? 0)
      const total = totalHeader > 0 ? offset + totalHeader : undefined
      const nextMetadata: PartialMetadata = {
        version: 1,
        url: options.url,
        hash: expectedHash,
        ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
        ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}),
        ...(total ? { total } : {}),
      }
      await fs.writeFile(metadataPath, `${JSON.stringify(nextMetadata)}\n`, { mode: 0o600 })
      const handle = await fs.open(partial, offset > 0 ? 'r+' : 'w', 0o600)
      try {
        let position = offset
        const reader = response.body.getReader()
        try {
          for (;;) {
            const chunk = await readWithIdleTimeout(
              reader,
              options.idleTimeoutMs ?? Constants.socketTimeoutMs,
              controller,
            )
            if (chunk.done) break
            await handle.write(chunk.value, 0, chunk.value.byteLength, position)
            position += chunk.value.byteLength
            receivedThisAttempt += chunk.value.byteLength
            options.onBytes?.(position)
          }
        } finally {
          reader.releaseLock()
        }
        await handle.truncate(position)
        await handle.sync()
        if (total !== undefined && position !== total) throw new Error('Download ended before the advertised size')
      } finally {
        await handle.close().catch(() => {})
      }

      const actualHash = await hashFile(partial, expectedHash)
      if (actualHash !== expectedHash) {
        await fs.rm(partial, { force: true })
        await fs.rm(metadataPath, { force: true })
        throw new DownloadError({
          task: options.taskName ?? path.basename(options.target),
          host: url.hostname,
          kind: 'checksum',
          message: 'Die Prüfsumme der geladenen Datei stimmt nicht.',
          retryable: true,
          attempts: attempt,
          bytesReceived: receivedThisAttempt,
        })
      }
      await atomicReplace(partial, options.target)
      await fs.rm(metadataPath, { force: true })
      const durationMs = Date.now() - started
      logger.debug(`[DownloadManager] ${url.hostname} ${path.basename(options.target)} attempt=${attempt} bytes=${receivedThisAttempt} durationMs=${durationMs} resumed=${resumed}`)
      responseBody = null
      return { attempts: attempt, bytesReceived: receivedThisAttempt, resumed, durationMs }
    } catch (error) {
      requestController?.abort(error)
      await responseBody?.cancel().catch(() => {})
      requestCleanup?.()
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw options.signal?.reason ?? error
      }
      const classification = classifyError(error)
      const inherited = error instanceof DownloadError ? error.failure : undefined
      lastFailure = {
        task: options.taskName ?? path.basename(options.target),
        host: url.hostname,
        kind: classification.kind,
        message: inherited?.message ?? (error instanceof Error ? error.message : 'Unbekannter Downloadfehler.'),
        retryable: classification.retryable,
        attempts: attempt,
        bytesReceived: inherited?.bytesReceived ?? receivedThisAttempt,
        status: inherited?.status,
      }
      if (!classification.retryable || attempt > maximumRetries) throw new DownloadError(lastFailure, { cause: error })
      const retryDelay = (inherited as DownloadFailure & { retryAfterMs?: number } | undefined)?.retryAfterMs
        ?? backoff(attempt)
      logger.warn(`[DownloadManager] ${url.hostname} attempt=${attempt} kind=${classification.kind}; retrying in ${retryDelay}ms`)
      await sleep(retryDelay, options.signal)
    } finally {
      requestCleanup?.()
    }
  }
  throw new DownloadError(lastFailure ?? {
    task: options.taskName ?? path.basename(options.target),
    host: url.hostname,
    kind: 'unknown',
    message: 'Download fehlgeschlagen.',
    retryable: false,
    attempts: maximumRetries + 1,
  })
}
