import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'

import { configService } from './config.service'
import { IpcChannels } from '../ipc/channels'
import { noPayload, requireObject, secureHandle } from '../ipc/security'
import { Constants, fmt } from '../constants'
import { logger } from '../logger'
import type {
  ModpackManifestReference,
  ModpackManifest,
  Post,
  PacksGetManifestPayload,
  PacksGetLogoPayload,
} from '../../shared/types'
import {
  assertManifestLocation,
  assertPackName,
  validateModpackManifest,
  validateModpackReference,
  ValidationError,
} from '../../shared/validation'
import {
  assertAllowedExternalUrl,
  assertAllowedPackAssetUrl,
} from '../security/url-policy'

const MAX_LOGO_BYTES = 5 * 1024 * 1024
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_POSTS_BYTES = 2 * 1024 * 1024
const MAX_PACK_LIST_BYTES = 10 * 1024 * 1024
const MAX_MANIFEST_BYTES = 50 * 1024 * 1024

async function fetchWithTimeout(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(Constants.connectTimeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  return response
}

async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maximum) throw new Error('Remote response exceeds size limit')
  if (!response.body) throw new Error('Remote response has no body')
  const chunks: Uint8Array[] = []
  let received = 0
  const reader = response.body.getReader()
  let completed = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        break
      }
      received += value.byteLength
      if (received > maximum) throw new Error('Remote response exceeds size limit')
      chunks.push(value)
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

async function fetchOgMeta(url: string): Promise<{ image?: string; excerpt?: string; date?: string }> {
  try {
    assertAllowedExternalUrl(url)
    const html = (await readBounded(await fetchWithTimeout(url), MAX_HTML_BYTES)).toString('utf8')
    const meta = (property: string): string | undefined => {
      const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = html.match(new RegExp(`<meta[^>]+property="${escaped}"[^>]+content="([^"]+)"`))
        ?? html.match(new RegExp(`<meta[^>]+content="([^"]+)"[^>]+property="${escaped}"`))
      return match?.[1]
    }
    const imageCandidate = meta('og:image:url') ?? meta('og:image')
    let image: string | undefined
    if (imageCandidate) {
      try { image = assertAllowedPackAssetUrl(imageCandidate) } catch { /* omit untrusted image */ }
    }
    return {
      ...(image ? { image } : {}),
      excerpt: meta('og:description'),
      date: meta('article:published_time'),
    }
  } catch {
    return {}
  }
}

function manifestPayload(value: unknown): PacksGetManifestPayload {
  const payload = requireObject(value)
  return { location: assertManifestLocation(payload.location) }
}

function logoPayload(value: unknown): PacksGetLogoPayload {
  const payload = requireObject(value)
  const location = assertManifestLocation(payload.location)
  const name = assertPackName(payload.name)
  if (payload.logo !== undefined && typeof payload.logo !== 'string') {
    throw new ValidationError('Die Logo-Adresse ist ungültig.')
  }
  return { location, name, ...(typeof payload.logo === 'string' ? { logo: payload.logo } : {}) }
}

class ModpackApiService {
  private cachedPackList: ModpackManifestReference[] | null = null
  private cachedPackKey: string | null = null
  private cachedPosts: Post[] | null = null

  registerHandlers(): void {
    secureHandle(IpcChannels.PACKS_RELOAD, { validate: noPayload }, () => {
      this.cachedPackList = null
      this.cachedPackKey = null
    })

    secureHandle(IpcChannels.PACKS_GET_REMOTE, { validate: noPayload }, async () => {
      const packKey = configService.get().packKey
      if (this.cachedPackList && this.cachedPackKey === packKey) return this.cachedPackList
      try {
        const response = await fetchWithTimeout(fmt(Constants.packList, packKey))
        const body = JSON.parse(
          (await readBounded(response, MAX_PACK_LIST_BYTES)).toString('utf8'),
        ) as { packages?: unknown[] } | unknown[]
        const raw = Array.isArray(body) ? body : body.packages ?? []
        const data: ModpackManifestReference[] = []
        for (const item of raw.slice(0, 2_000)) {
          try { data.push(validateModpackReference(item)) } catch { /* ignore malformed server entry */ }
        }
        this.cachedPackList = data
        this.cachedPackKey = packKey
        return data
      } catch (error) {
        logger.warn('[ModpackApiService] Pack service unavailable; retaining local/cached data:', error)
        return this.cachedPackList ?? []
      }
    })

    secureHandle(
      IpcChannels.PACKS_GET_MANIFEST,
      { validate: manifestPayload },
      async (_event, payload): Promise<ModpackManifest | null> => {
        try {
          const response = await fetchWithTimeout(fmt(Constants.packManifest, payload.location))
          return validateModpackManifest(
            JSON.parse((await readBounded(response, MAX_MANIFEST_BYTES)).toString('utf8')) as unknown,
            payload.location,
          )
        } catch (error) {
          logger.warn(`[ModpackApiService] Manifest fetch failed for ${payload.location}:`, error)
          return null
        }
      },
    )

    secureHandle(IpcChannels.PACKS_GET_POSTS, { validate: noPayload }, async () => {
      if (this.cachedPosts) return this.cachedPosts
      try {
        const response = await fetchWithTimeout(Constants.postsApi)
        const raw = JSON.parse(
          (await readBounded(response, MAX_POSTS_BYTES)).toString('utf8'),
        ) as unknown
        if (!Array.isArray(raw)) throw new Error('Post response is not an array')
        const base = raw.slice(0, 100).flatMap((entry): Array<{ title: string; url: string }> => {
          if (typeof entry !== 'object' || entry === null) return []
          const item = entry as Record<string, unknown>
          if (typeof item.title !== 'string' || item.title.length > 512) return []
          try { return [{ title: item.title, url: assertAllowedExternalUrl(item.url) }] } catch { return [] }
        })
        this.cachedPosts = await Promise.all(base.map(async (post) => ({ ...post, ...await fetchOgMeta(post.url) })))
        return this.cachedPosts
      } catch (error) {
        logger.warn('[ModpackApiService] Post service unavailable:', error)
        return this.cachedPosts ?? []
      }
    })

    secureHandle(
      IpcChannels.PACKS_GET_LOGO,
      { validate: logoPayload },
      async (_event, payload): Promise<string | null> => {
        let imageUrl: string
        try {
          imageUrl = assertAllowedPackAssetUrl(
            payload.logo ?? fmt(Constants.packLogoImage, `${payload.location.replace(/\.[^/.]+$/, '')}.png`),
          )
        } catch {
          return null
        }
        const cacheDir = configService.getCacheDir()
        await fs.mkdir(cacheDir, { recursive: true })
        const cachePath = path.join(cacheDir, `${sha256Hex(`${payload.name}::${imageUrl}`)}.png`)
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined
        try {
          handle = await fs.open(cachePath, 'r')
          const stat = await handle.stat()
          if (stat.size <= MAX_LOGO_BYTES && Date.now() - stat.mtimeMs < Constants.imageCacheTtlMs) {
            return `data:image/png;base64,${(await handle.readFile()).toString('base64')}`
          }
        } catch {
          // Cache miss.
        } finally {
          await handle?.close().catch(() => {})
        }
        try {
          const buffer = await readBounded(await fetchWithTimeout(imageUrl), MAX_LOGO_BYTES)
          await fs.writeFile(cachePath, buffer, { mode: 0o600 })
          return `data:image/png;base64,${buffer.toString('base64')}`
        } catch (error) {
          logger.warn(`[ModpackApiService] Logo fetch failed for ${payload.name}:`, error)
          return null
        }
      },
    )
  }
}

export const modpackApiService = new ModpackApiService()
