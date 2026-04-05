import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import crypto from 'node:crypto'
import { app } from 'electron'

import { LauncherConfig, DEFAULT_CONFIG } from '../../shared/types'
import { logger } from '../logger'
import {
  validateMigrationTarget,
  type MigrationValidation,
} from '../../shared/migrate-validation'

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
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }

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

  /** Guards against concurrent moveInstances calls. */
  private moving = false

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

  // ── Instance directory move ──────────────────────────────────────────────

  /**
   * Move modpack instances to a new directory.
   *
   * 1. Validates the target path
   * 2. Tests write access
   * 3. Checks for name collisions in the target
   * 4. Two-phase move: copies everything first, then deletes originals
   * 5. Updates `installationDir` and saves config
   *
   * Returns `{ success: true }` or `{ success: false, error: string }`.
   * No app restart required.
   */
  async moveInstances(targetDir: string): Promise<{ success: boolean; error?: string }> {
    if (this.moving) {
      logger.warn('[ConfigService] moveInstances called while already in progress')
      return { success: false, error: 'Verschiebung laeuft bereits.' }
    }
    this.moving = true
    try {
      return await this._doMoveInstances(targetDir)
    } finally {
      this.moving = false
    }
  }

  private async _doMoveInstances(
    targetDir: string,
  ): Promise<{ success: boolean; error?: string }> {
    const currentDir = this.getInstallDir()
    logger.info(`[ConfigService] Move instances requested: ${currentDir} -> ${targetDir}`)

    const validation = validateMigrationTarget(currentDir, targetDir)
    if (!validation.ok) {
      logger.warn(`[ConfigService] Move validation failed: ${validation.error} (target: ${targetDir})`)
      const messages: Record<
        Exclude<MigrationValidation, { ok: true }>['error'],
        string
      > = {
        'already-current': 'Das ist bereits der aktuelle Speicherort.',
        nested: 'Der Zielordner darf nicht innerhalb des aktuellen Speicherorts liegen (oder umgekehrt).',
        empty: 'Bitte waehle einen Ordner.',
      }
      return { success: false, error: messages[validation.error] }
    }

    // Ensure target exists and is writable
    try {
      await fs.mkdir(targetDir, { recursive: true })
      const testFile = path.join(targetDir, '.myftb-write-test')
      await fs.writeFile(testFile, 'test', 'utf8')
      await fs.unlink(testFile)
    } catch {
      logger.warn(`[ConfigService] Target directory not writable: ${targetDir}`)
      return { success: false, error: 'Der Zielordner ist nicht beschreibbar.' }
    }

    // Read current entries
    let entries: string[]
    try {
      entries = await fs.readdir(currentDir)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn(`[ConfigService] Current install dir does not exist, treating as empty: ${currentDir}`)
        entries = []
      } else {
        logger.error('[ConfigService] Failed to read current install dir:', err)
        return { success: false, error: 'Fehler beim Lesen des aktuellen Speicherorts.' }
      }
    }

    // Check for name collisions in target
    for (const entry of entries) {
      try {
        await fs.access(path.join(targetDir, entry))
        logger.warn(`[ConfigService] Name collision in target: "${entry}" already exists in ${targetDir}`)
        return { success: false, error: `"${entry}" existiert bereits im Zielordner.` }
      } catch {
        // Does not exist - good
      }
    }

    // Phase 1: Copy everything to target
    // (algorithm mirrored in src/tests/move-instances.test.ts - keep in sync)
    const copied: string[] = []
    for (const entry of entries) {
      const src = path.join(currentDir, entry)
      const dest = path.join(targetDir, entry)
      try {
        await fs.cp(src, dest, { recursive: true })
        copied.push(entry)
      } catch (err) {
        // Rollback: remove partially-copied current entry + already-copied entries
        await fs.rm(dest, { recursive: true, force: true }).catch(() => {})
        for (const name of copied) {
          await fs.rm(path.join(targetDir, name), { recursive: true, force: true }).catch(() => {})
        }
        logger.error(`[ConfigService] Move failed at "${entry}", rolled back ${copied.length} entries`, err)
        return { success: false, error: `Fehler beim Verschieben von "${entry}".` }
      }
    }

    // Phase 2: All copies succeeded - delete originals
    for (const entry of copied) {
      await fs.rm(path.join(currentDir, entry), { recursive: true, force: true }).catch((err) => {
        logger.warn(`[ConfigService] Failed to remove original after move: ${entry}`, err)
      })
    }

    // Update config and persist
    this.config.installationDir = targetDir
    await this.save()

    logger.info(`[ConfigService] Instances moved: ${currentDir} -> ${targetDir} (${copied.length} entries)`)
    return { success: true }
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const configService = new ConfigService()
