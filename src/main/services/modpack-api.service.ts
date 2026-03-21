import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { setMaxListeners } from 'node:events'
import { ipcMain } from 'electron'

import { configService } from './config.service'
import { IpcChannels } from '../ipc/channels'
import { Constants, fmt } from '../constants'
import type {
  ModpackManifestReference,
  ModpackManifest,
  Post,
  PacksGetManifestPayload,
  PacksGetLogoPayload,
} from '../../shared/types'

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Perform a GET request with a 30-second AbortController timeout.
 * Throws on network errors or non-2xx responses.
 */
async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController()
  setMaxListeners(0, controller.signal)
  const timer = setTimeout(() => controller.abort(), Constants.connectTimeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} — ${url}`)
    }
    return response
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Derive a stable filename-safe SHA-256 hex hash from an arbitrary string.
 * Used as the cache key for logo images.
 */
function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

/**
 * Fetch a post page and extract OG/meta tags for image, excerpt, and date.
 * Returns partial data — missing fields are simply undefined.
 */
async function fetchOgMeta(url: string): Promise<{ image?: string; excerpt?: string; date?: string }> {
  try {
    const response = await fetchWithTimeout(url)
    const html = await response.text()
    const meta = (prop: string): string | undefined => {
      const m = html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]+)"`))
               ?? html.match(new RegExp(`<meta[^>]+content="([^"]+)"[^>]+property="${prop}"`))
      return m?.[1]
    }
    return {
      image: meta('og:image:url') ?? meta('og:image'),
      excerpt: meta('og:description'),
      date: meta('article:published_time'),
    }
  } catch {
    return {}
  }
}



class ModpackApiService {
  // ── Pack list cache ────────────────────────────────────────────────────────

  /** Cached pack list, keyed by the packKey that was used to fetch it. */
  private cachedPackList: ModpackManifestReference[] | null = null
  private cachedPackKey: string | null = null

  // ── Posts cache ───────────────────────────────────────────────────────────

  private cachedPosts: Post[] | null = null

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  registerHandlers(): void {
    this.handleGetRemote()
    this.handleGetManifest()
    this.handleGetPosts()
    this.handleGetLogo()
  }

  // ── packs:get-remote ──────────────────────────────────────────────────────

  private handleGetRemote(): void {
    ipcMain.handle(IpcChannels.PACKS_GET_REMOTE, async (): Promise<ModpackManifestReference[]> => {
      const packKey = configService.get().packKey

      // Return cached result when the packKey has not changed.
      if (this.cachedPackList !== null && this.cachedPackKey === packKey) {
        return this.cachedPackList
      }

      const url = fmt(Constants.packList, packKey)

      try {
        const response = await fetchWithTimeout(url)
        const body = (await response.json()) as { packages?: ModpackManifestReference[] } | ModpackManifestReference[]
        // Server returns { minimumVersion, packages: [...] } (IndexModel)
        const data = Array.isArray(body) ? body : (body as { packages?: ModpackManifestReference[] }).packages ?? []
        this.cachedPackList = data
        this.cachedPackKey = packKey
        return data
      } catch (err) {
        console.error('[ModpackApiService] Failed to fetch pack list:', err)
        return []
      }
    })
  }

  // ── packs:get-manifest ────────────────────────────────────────────────────

  private handleGetManifest(): void {
    ipcMain.handle(
      IpcChannels.PACKS_GET_MANIFEST,
      async (_event, payload: PacksGetManifestPayload): Promise<ModpackManifest | null> => {
        const url = fmt(Constants.packManifest, payload.location)

        try {
          const response = await fetchWithTimeout(url)
          const data = (await response.json()) as ModpackManifest
          return data
        } catch (err) {
          console.error(
            `[ModpackApiService] Failed to fetch manifest for "${payload.location}":`,
            err,
          )
          return null
        }
      },
    )
  }

  // ── packs:get-posts ───────────────────────────────────────────────────────

  private handleGetPosts(): void {
    ipcMain.handle(IpcChannels.PACKS_GET_POSTS, async (): Promise<Post[]> => {
      if (this.cachedPosts !== null) {
        return this.cachedPosts
      }

      try {
        const response = await fetchWithTimeout(Constants.postsApi)
        const data = (await response.json()) as { title: string; url: string }[]
        const enriched: Post[] = await Promise.all(
          data.map(async (post) => {
            const og = await fetchOgMeta(post.url)
            return { title: post.title, url: post.url, ...og }
          }),
        )
        this.cachedPosts = enriched
        return enriched
      } catch (err) {
        console.error('[ModpackApiService] Failed to fetch posts:', err)
        return []
      }
    })
  }

  // ── packs:get-logo ────────────────────────────────────────────────────────

  private handleGetLogo(): void {
    ipcMain.handle(
      IpcChannels.PACKS_GET_LOGO,
      async (_event, payload: PacksGetLogoPayload): Promise<string | null> => {
        // logo field is a full URL when present (e.g. https://packs.myftb.de/packs/objects/…).
        // Fallback: launcher.myftb.de/images/<location>.png — matches old Java launcher behaviour.
        const imageUrl = payload.logo
          ? payload.logo
          : fmt(Constants.packLogoImage, `${payload.location.replace(/\.[^/.]+$/, '')}.png`)

        // Determine cache file path.
        const cacheKey = sha256Hex(`${payload.name}::${imageUrl}`)
        let cacheDir: string
        try {
          cacheDir = await configService.getSaveSubDir('cache')
        } catch (err) {
          console.error('[ModpackApiService] Failed to resolve cache directory:', err)
          return null
        }
        const cachePath = path.join(cacheDir, `${cacheKey}.png`)

        // Check for a valid cached file (within TTL).
        try {
          const stat = await fs.stat(cachePath)
          const ageMs = Date.now() - stat.mtimeMs
          if (ageMs < Constants.imageCacheTtlMs) {
            const buffer = await fs.readFile(cachePath)
            return `data:image/png;base64,${buffer.toString('base64')}`
          }
          // Cache is stale — fall through to re-fetch.
        } catch {
          // File does not exist yet — fall through to fetch.
        }

        // Fetch from remote.
        try {
          const response = await fetchWithTimeout(imageUrl)
          const arrayBuffer = await response.arrayBuffer()
          const buffer = Buffer.from(arrayBuffer)
          await fs.writeFile(cachePath, buffer)
          return `data:image/png;base64,${buffer.toString('base64')}`
        } catch (err) {
          console.error(
            `[ModpackApiService] Failed to fetch logo for "${payload.name}" (${imageUrl}):`,
            err,
          )
          return null
        }
      },
    )
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const modpackApiService = new ModpackApiService()
