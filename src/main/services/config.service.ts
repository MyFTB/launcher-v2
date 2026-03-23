import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import crypto from 'node:crypto'
import { app } from 'electron'

import { LauncherConfig, DEFAULT_CONFIG } from '../../shared/types'
import { logger } from '../logger'

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Detect a sensible default maxMemory value based on available system RAM.
 * Mirrors the Java LauncherConfig heuristic:
 *   >= 16 GB → 8192 MB
 *   >= 12 GB → 6144 MB
 *   >=  8 GB → 4096 MB
 *   else     → 4096 MB
 */
function detectDefaultMaxMemory(): number {
  const totalMb = os.totalmem() / (1024 * 1024)
  if (totalMb >= 16 * 1024) return 8192
  if (totalMb >= 12 * 1024) return 6144
  if (totalMb >= 8 * 1024) return 4096
  return 4096
}

/**
 * Deep-merge `incoming` on top of `base`, returning a new object.
 * Only own enumerable properties are considered; nested objects are merged
 * recursively (arrays are replaced, not concatenated).
 */
function deepMerge<T extends object>(base: T, incoming: Partial<T>): T {
  const result: Record<string, unknown> = { ...base }

  for (const key of Object.keys(incoming) as (keyof T)[]) {
    const incomingVal = incoming[key]
    const baseVal = result[key as string]

    if (
      incomingVal !== null &&
      typeof incomingVal === 'object' &&
      !Array.isArray(incomingVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key as string] = deepMerge(
        baseVal as object,
        incomingVal as Partial<object>,
      )
    } else if (incomingVal !== undefined) {
      result[key as string] = incomingVal
    }
  }

  return result as T
}

/** Return a deep clone of a plain JSON-serialisable object. */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ─── Service ─────────────────────────────────────────────────────────────────

class ConfigService {
  private config: LauncherConfig = {
    ...DEFAULT_CONFIG,
    maxMemory: detectDefaultMaxMemory(),
  }

  /** True when config.json was absent at load time (first launch). */
  private firstStart = false

  /** Absolute path of config.json inside Electron's userData directory. */
  private get configPath(): string {
    return path.join(app.getPath('userData'), 'config.json')
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Hook for IPC handler registration.  The actual handlers live in router.ts;
   * this method exists so the service follows the same lifecycle contract as
   * every other service.
   */
  registerHandlers(): void {
    // Handlers are wired in router.ts
  }

  /**
   * Read config.json from userData and merge with DEFAULT_CONFIG so that any
   * keys added in a new launcher version are always present.
   */
  async load(): Promise<void> {
    const defaults: LauncherConfig = {
      ...DEFAULT_CONFIG,
      maxMemory: detectDefaultMaxMemory(),
    }

    let persisted: Partial<LauncherConfig> = {}

    try {
      const raw = await fs.readFile(this.configPath, 'utf8')
      persisted = JSON.parse(raw) as Partial<LauncherConfig>
      this.firstStart = false
    } catch (err: unknown) {
      // ENOENT → first run; any other error → treat as missing and log.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('[ConfigService] Failed to read config.json, using defaults:', err)
      }
      this.firstStart = true
    }

    this.config = deepMerge(defaults, persisted)

    if (this.firstStart) {
      logger.info('[ConfigService] First start - config.json not found, using defaults')
    } else {
      logger.info('[ConfigService] Config loaded from disk')
    }
  }

  /** Serialise the current config to config.json. */
  async save(): Promise<void> {
    const dir = path.dirname(this.configPath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf8')
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /** Returns a deep clone of the current config so callers cannot mutate state. */
  get(): LauncherConfig {
    return deepClone(this.config)
  }

  /** Merge a partial config object into the current state (does NOT auto-save). */
  merge(partial: Partial<LauncherConfig>): void {
    this.config = deepMerge(this.config, partial)
    // packConfigs uses replacement semantics — deepMerge can only add/update
    // keys, never remove them, so an explicit pack deletion would be ignored.
    if (partial.packConfigs !== undefined) {
      this.config.packConfigs = { ...partial.packConfigs }
      const names = Object.keys(this.config.packConfigs)
      logger.debug(`[ConfigService] packConfigs replaced - ${names.length} override(s): ${names.join(', ') || '(none)'}`)
    }
  }

  /** Returns `true` when config.json was absent during `load()`. */
  isFirstStart(): boolean {
    return this.firstStart
  }

  // ── Directory helpers ─────────────────────────────────────────────────────

  /**
   * Returns the root installation directory for modpack instances.
   * Falls back to `<userData>/instances` when `installationDir` is empty.
   */
  getInstallDir(): string {
    const configured = this.config.installationDir
    if (configured && configured.trim().length > 0) {
      return configured
    }
    return path.join(app.getPath('userData'), 'instances')
  }

  /**
   * Returns the path `<installDir>/<name>`, creating it on disk if necessary.
   */
  async getSaveSubDir(name: string): Promise<string> {
    const dir = path.join(this.getInstallDir(), name)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  // ── Token ─────────────────────────────────────────────────────────────────

  /**
   * Ensures a client token exists.  If `clientToken` is an empty string a
   * random UUID is generated, written into the config, and persisted to disk.
   */
  async generateClientToken(): Promise<void> {
    if (this.config.clientToken === '') {
      this.config.clientToken = crypto.randomUUID()
      await this.save()
    }
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const configService = new ConfigService()
