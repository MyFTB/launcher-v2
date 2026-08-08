import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import crypto from 'node:crypto'
import { app } from 'electron'

import {
  DEFAULT_CONFIG,
  type DataDirMigrationResult,
  type DataRecoveryAction,
  type DataRecoveryState,
  type LauncherConfig,
  type RendererConfig,
} from '../../shared/types'
import {
  assertPackName,
  parseLauncherConfig,
  type LegacyCredential,
} from '../../shared/validation'
import { logger } from '../logger'
import { assertContainedNoLinks } from '../filesystem-safety'
import { writeDataDirPointer } from '../bootstrap'
import {
  validateMigrationTarget,
  type MigrationValidation,
} from '../../shared/migrate-validation'

function detectDefaultMaxMemory(): number {
  const totalMb = os.totalmem() / (1024 * 1024)
  if (totalMb >= 16 * 1024) return 8192
  if (totalMb >= 12 * 1024) return 6144
  return 4096
}

function deepMerge<T extends object>(base: T, incoming: Partial<T>): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const key of Object.keys(incoming) as (keyof T)[]) {
    const incomingValue = incoming[key]
    const baseValue = result[key as string]
    if (
      incomingValue !== null
      && typeof incomingValue === 'object'
      && !Array.isArray(incomingValue)
      && baseValue !== null
      && typeof baseValue === 'object'
      && !Array.isArray(baseValue)
    ) {
      result[key as string] = deepMerge(baseValue as object, incomingValue as Partial<object>)
    } else if (incomingValue !== undefined) {
      result[key as string] = incomingValue
    }
  }
  return result as T
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(directory, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is not available on every supported platform/filesystem.
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Write a file through a same-directory temporary file and atomic rename. */
export async function atomicWriteFile(target: string, data: string | Uint8Array): Promise<void> {
  const directory = path.dirname(target)
  await fs.mkdir(directory, { recursive: true })
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, target)
    await syncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function hashFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r')
  try {
    const hash = crypto.createHash('sha256')
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer)
    return hash.digest('hex')
  } finally {
    await handle.close().catch(() => {})
  }
}

const VOLATILE_USER_DATA_ENTRIES = new Set([
  'Cache',
  'Code Cache',
  'Crashpad',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'DevToolsActivePort',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'VideoDecodeStats',
  'blob_storage',
  'lockfile',
])

/** Electron recreates these top-level cache and process-lock entries after restart. */
export function shouldSkipDataDirEntry(relativePath: string): boolean {
  return !relativePath.includes(path.sep) && VOLATILE_USER_DATA_ENTRIES.has(relativePath)
}

async function copyStableFile(source: string, target: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    await fs.rm(target, { force: true }).catch(() => {})
    try {
      const before = await fs.lstat(source)
      if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Nicht unterstützter Dateityp: ${source}`)
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL)
      await fs.chmod(target, before.mode & 0o777).catch(() => {})
      const [sourceHash, targetHash, after] = await Promise.all([
        hashFile(source),
        hashFile(target),
        fs.lstat(source),
      ])
      if (
        sourceHash === targetHash
        && before.size === after.size
        && before.mtimeMs === after.mtimeMs
      ) return
      lastError = new Error(`Datei wurde während der Migration verändert: ${source}`)
    } catch (error) {
      lastError = error
    }
    await fs.rm(target, { force: true }).catch(() => {})
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
  }
  throw lastError instanceof Error ? lastError : new Error(`Datei konnte nicht kopiert werden: ${source}`)
}

/** Copy without following symbolic links and verify every copied regular file. */
async function copyAndVerifyTree(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source)
  if (stat.isSymbolicLink()) throw new Error(`Symbolischer Link kann nicht migriert werden: ${source}`)
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: false })
    for (const entry of await fs.readdir(source)) {
      await copyAndVerifyTree(path.join(source, entry), path.join(target, entry))
    }
    return
  }
  if (!stat.isFile()) throw new Error(`Nicht unterstützter Dateityp: ${source}`)
  await copyStableFile(source, target)
}

async function copyUserDataTree(source: string, target: string, relative = ''): Promise<void> {
  const stat = await fs.lstat(source)
  if (stat.isSymbolicLink()) throw new Error(`Symbolischer Link kann nicht migriert werden: ${source}`)
  if (stat.isDirectory()) {
    if (relative) await fs.mkdir(target, { recursive: false, mode: stat.mode & 0o777 })
    const entries = await fs.readdir(source)
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry) : entry
      if (shouldSkipDataDirEntry(childRelative)) continue
      await copyUserDataTree(path.join(source, entry), path.join(target, entry), childRelative)
    }
    return
  }
  if (!stat.isFile()) throw new Error(`Nicht unterstützter Dateityp: ${source}`)
  await copyStableFile(source, target)
}

function remapInstallationDir(configured: string, oldDataDir: string, newDataDir: string): string {
  if (!configured.trim()) return ''
  const resolved = path.resolve(configured)
  const relative = path.relative(path.resolve(oldDataDir), resolved)
  if (relative === '') return path.resolve(newDataDir)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return configured
  return path.join(path.resolve(newDataDir), relative)
}

class ConfigService {
  private config: LauncherConfig = this.defaults()
  private firstStart = false
  private moving = false
  private movingDataDir = false
  private writeQueue: Promise<void> = Promise.resolve()
  private legacyCredentials: LegacyCredential[] = []
  private recovery: DataRecoveryState = { status: 'ok' }

  private defaults(): LauncherConfig {
    return { ...DEFAULT_CONFIG, maxMemory: detectDefaultMaxMemory() }
  }

  getConfigPath(): string {
    return path.join(app.getPath('userData'), 'config.json')
  }

  getBackupPath(): string {
    return `${this.getConfigPath()}.bak`
  }

  registerHandlers(): void {
    // Handlers are registered in router.ts.
  }

  private async readValidated(filePath: string): Promise<LauncherConfig> {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) {
      throw new Error('Configuration file is not a safe regular file')
    }
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = parseLauncherConfig(JSON.parse(raw) as unknown, this.defaults())
    this.legacyCredentials.push(...parsed.legacyCredentials)
    return parsed.config
  }

  async load(): Promise<void> {
    this.legacyCredentials = []
    const configPath = this.getConfigPath()
    try {
      this.config = await this.readValidated(configPath)
      this.firstStart = false
      this.recovery = { status: 'ok' }
      logger.info('[ConfigService] Config loaded and validated')
      return
    } catch (primaryError) {
      const primaryMissing = (primaryError as NodeJS.ErrnoException).code === 'ENOENT'
      if (!primaryMissing) logger.error('[ConfigService] Primary config is unreadable or invalid:', primaryError)
      try {
        this.config = await this.readValidated(this.getBackupPath())
        this.firstStart = false
        this.recovery = {
          status: 'recovered-backup',
          source: 'config',
          message: 'Die beschädigte Konfiguration wurde aus der letzten Sicherung wiederhergestellt.',
          brokenPath: configPath,
          backupAvailable: true,
        }
        const quarantine = `${configPath}.corrupt-${Date.now()}`
        await fs.rename(configPath, quarantine).catch(() => {})
        // Do not rewrite a sanitized primary until legacy credentials have been
        // durably imported into the secure store by startup orchestration.
        logger.warn(`[ConfigService] Recovered config from backup; broken file kept as ${quarantine}`)
        return
      } catch (backupError) {
        const backupMissing = (backupError as NodeJS.ErrnoException).code === 'ENOENT'
        if (primaryMissing && backupMissing) {
          this.config = this.defaults()
          this.firstStart = true
          this.recovery = { status: 'ok' }
          logger.info('[ConfigService] First start - config.json and backup not found')
          return
        }
        logger.error('[ConfigService] Config backup is unavailable or invalid:', backupError)
        this.config = this.defaults()
        this.firstStart = false
        this.recovery = {
          status: 'needs-recovery',
          source: 'config',
          message: 'Die Launcher-Konfiguration ist beschädigt. Es wurden keine Daten überschrieben.',
          brokenPath: primaryMissing ? this.getBackupPath() : configPath,
          backupAvailable: !backupMissing,
        }
      }
    }
  }

  private enqueueWrite(snapshot: LauncherConfig): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const parsed = parseLauncherConfig(snapshot, this.defaults()).config
      const json = `${JSON.stringify(parsed, null, 2)}\n`
      await atomicWriteFile(this.getConfigPath(), json)
      await atomicWriteFile(this.getBackupPath(), json)
    })
    this.writeQueue = operation.catch(() => {})
    return operation
  }

  async save(): Promise<void> {
    if (this.recovery.status === 'needs-recovery') {
      throw new Error('RECOVERY_REQUIRED: Die beschädigte Konfiguration muss zuerst wiederhergestellt werden.')
    }
    return this.enqueueWrite(deepClone(this.config))
  }

  /** Wait until every queued write has settled. */
  async flush(): Promise<void> {
    await this.writeQueue
  }

  get(): LauncherConfig {
    return deepClone(this.config)
  }

  getPublic(): RendererConfig {
    const { clientToken: _clientToken, ...publicConfig } = this.get()
    return publicConfig
  }

  merge(partial: Partial<LauncherConfig>): void {
    const merged = deepMerge(this.config, partial)
    if (partial.packConfigs !== undefined) merged.packConfigs = { ...partial.packConfigs }
    this.config = parseLauncherConfig(merged, this.defaults()).config
  }

  isFirstStart(): boolean {
    return this.firstStart
  }

  getRecoveryState(): DataRecoveryState {
    return { ...this.recovery }
  }

  setExternalRecovery(state: DataRecoveryState): void {
    const priority: Record<NonNullable<DataRecoveryState['source']>, number> = {
      'update-journal': 1,
      config: 2,
      pointer: 3,
    }
    if (this.recovery.status === 'ok') {
      this.recovery = { ...state }
      return
    }
    if (state.status !== 'needs-recovery') return
    const currentPriority = this.recovery.source ? priority[this.recovery.source] : 0
    const nextPriority = state.source ? priority[state.source] : 0
    if (this.recovery.status !== 'needs-recovery' || nextPriority > currentPriority) {
      this.recovery = { ...state }
    }
  }

  acknowledgeExternalRecovery(source: DataRecoveryState['source']): void {
    if (this.recovery.source === source) this.recovery = { status: 'ok' }
  }

  async resolveRecovery(action: DataRecoveryAction): Promise<void> {
    if (action === 'locate-data') throw new Error('locate-data wird vom Bootstrap-Handler verarbeitet.')
    if (action === 'accept-current') throw new Error('accept-current ist nur für ein Update-Protokoll erlaubt.')
    if (action === 'restore-backup') {
      this.config = await this.readValidated(this.getBackupPath())
      this.recovery = { status: 'recovered-backup', source: 'config' }
      // The router imports any legacy credentials before saving this sanitized config.
      return
    }
    if (action === 'fresh-start') {
      const timestamp = Date.now()
      const brokenPath = this.recovery.brokenPath
      if (brokenPath) await fs.rename(brokenPath, `${brokenPath}.corrupt-${timestamp}`).catch(() => {})
      await fs.rename(this.getBackupPath(), `${this.getBackupPath()}.recovery-${timestamp}`).catch(() => {})
      this.config = this.defaults()
      this.firstStart = true
      await this.enqueueWrite(this.config)
      this.recovery = { status: 'ok' }
    }
  }

  takeLegacyCredentials(): LegacyCredential[] {
    const credentials = this.legacyCredentials
    this.legacyCredentials = []
    return credentials
  }

  // ── Explicit directory helpers ────────────────────────────────────────────

  /** Root containing shared Minecraft resources plus instances/ and cache/. */
  getResourceDir(): string {
    const configured = this.config.installationDir.trim()
    return configured || path.join(app.getPath('userData'), 'instances')
  }

  /** Compatibility alias used by XMCL resource installation. */
  getInstallDir(): string {
    return this.getResourceDir()
  }

  getInstancesDir(): string {
    return path.join(this.getResourceDir(), 'instances')
  }

  getCacheDir(): string {
    return path.join(this.getResourceDir(), 'cache')
  }

  getRuntimesDir(): string {
    return path.join(app.getPath('userData'), 'runtimes')
  }

  async getInstanceDir(name: string, create = true): Promise<string> {
    const safeName = assertPackName(name)
    const root = path.resolve(this.getInstancesDir())
    const directory = path.resolve(root, safeName)
    if (path.dirname(directory) !== root) throw new Error('Modpack-Pfad verlässt den Instanzordner.')
    if (create) {
      await fs.mkdir(root, { recursive: true })
      await assertContainedNoLinks(root, directory, { includeLeaf: true, label: 'Instanzpfad' })
      await fs.mkdir(directory, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      const stat = await fs.lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Der Instanzpfad ist kein sicherer Ordner.')
    } else {
      try {
        await assertContainedNoLinks(root, directory, { includeLeaf: true, label: 'Instanzpfad' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return directory
  }

  /** Compatibility helper preserving the existing <resource>/<name> layout. */
  async getSaveSubDir(name: string): Promise<string> {
    const safeName = assertPackName(name)
    const directory = path.join(this.getResourceDir(), safeName)
    await fs.mkdir(directory, { recursive: true })
    return directory
  }

  async generateClientToken(): Promise<void> {
    if (this.config.clientToken === '') {
      this.config.clientToken = crypto.randomUUID()
      await this.save()
    }
  }

  // ── Launcher data-directory migration ─────────────────────────────────────

  isDataDirMigrationActive(): boolean {
    return this.movingDataDir
  }

  isStorageMigrationActive(): boolean {
    return this.movingDataDir || this.moving
  }

  async migrateDataDir(
    targetDir: string,
    flushExternal?: () => Promise<void>,
  ): Promise<DataDirMigrationResult> {
    if (this.movingDataDir || this.moving) {
      return { success: false, error: 'Eine Speicherort-Migration läuft bereits.' }
    }
    this.movingDataDir = true
    try {
      await flushExternal?.()
      return await this.doMigrateDataDir(targetDir)
    } finally {
      this.movingDataDir = false
    }
  }

  private async doMigrateDataDir(targetDir: string): Promise<DataDirMigrationResult> {
    if (this.recovery.status === 'needs-recovery') {
      return { success: false, error: 'Vor der Migration muss die Datenwiederherstellung abgeschlossen werden.' }
    }
    if (!path.isAbsolute(targetDir)) {
      return { success: false, error: 'Der Zielordner muss ein absoluter Pfad sein.' }
    }

    const currentDir = path.resolve(app.getPath('userData'))
    const resolvedTarget = path.resolve(targetDir)
    const validation = validateMigrationTarget(currentDir, resolvedTarget)
    if (!validation.ok) {
      const messages: Record<Exclude<MigrationValidation, { ok: true }>['error'], string> = {
        'already-current': 'Das ist bereits der aktuelle Speicherort.',
        nested: 'Der Zielordner darf nicht im aktuellen Datenordner liegen (oder umgekehrt).',
        empty: 'Bitte wähle einen Ordner.',
      }
      return { success: false, error: messages[validation.error] }
    }

    let stagingDir: string | null = null
    let promoted = false
    try {
      await this.flush()
      const sourceStat = await fs.lstat(currentDir)
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
        return { success: false, error: 'Der aktuelle Datenordner ist nicht sicher.' }
      }

      await fs.mkdir(resolvedTarget, { recursive: true })
      const targetStat = await fs.lstat(resolvedTarget)
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        return { success: false, error: 'Der Zielordner darf kein symbolischer Link oder eine Junction sein.' }
      }
      if ((await fs.readdir(resolvedTarget)).length > 0) {
        return { success: false, error: 'Der Zielordner muss leer sein.' }
      }
      const probe = path.join(resolvedTarget, `.myftb-write-test-${crypto.randomUUID()}`)
      await fs.writeFile(probe, 'test', { flag: 'wx', mode: 0o600 })
      await fs.rm(probe)

      const parent = path.dirname(resolvedTarget)
      stagingDir = await fs.mkdtemp(path.join(parent, `.${path.basename(resolvedTarget)}.myftb-staging-`))
      await copyUserDataTree(currentDir, stagingDir)

      // Keep external resource directories unchanged. Paths below userData move
      // with the new root; an empty value continues to use the default layout.
      const migratedConfig = deepClone(this.config)
      migratedConfig.installationDir = remapInstallationDir(
        migratedConfig.installationDir,
        currentDir,
        resolvedTarget,
      )
      const parsed = parseLauncherConfig(migratedConfig, this.defaults()).config
      const configJson = `${JSON.stringify(parsed, null, 2)}\n`
      await atomicWriteFile(path.join(stagingDir, 'config.json'), configJson)
      await atomicWriteFile(path.join(stagingDir, 'config.json.bak'), configJson)
      await atomicWriteFile(path.join(stagingDir, '.myftb-data-migration.json'), `${JSON.stringify({
        version: 1,
        source: currentDir,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`)

      // Revalidate immediately before the atomic same-filesystem promotion.
      const finalStat = await fs.lstat(resolvedTarget)
      if (!finalStat.isDirectory() || finalStat.isSymbolicLink() || (await fs.readdir(resolvedTarget)).length > 0) {
        throw new Error('Der Zielordner wurde während der Migration verändert.')
      }
      await fs.rmdir(resolvedTarget)
      await fs.rename(stagingDir, resolvedTarget)
      promoted = true
      stagingDir = null

      // The pointer is the final commit record. The old tree is deliberately
      // retained so a failed restart can always be rolled back manually.
      writeDataDirPointer(resolvedTarget)
      logger.info(`[ConfigService] Data directory copied and committed: ${currentDir} -> ${resolvedTarget}`)
      return { success: true }
    } catch (error) {
      logger.error('[ConfigService] Data-directory migration failed:', error)
      return {
        success: false,
        error: promoted
          ? 'Die Daten wurden vollständig kopiert, aber der Datenzeiger konnte nicht sicher gespeichert werden. Der alte Ordner wurde beibehalten.'
          : 'Die Launcher-Daten konnten nicht vollständig kopiert und geprüft werden.',
      }
    } finally {
      if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ── Instance-directory migration ──────────────────────────────────────────

  async moveInstances(targetDir: string): Promise<{ success: boolean; error?: string }> {
    if (this.moving || this.movingDataDir) return { success: false, error: 'Verschiebung läuft bereits.' }
    this.moving = true
    try {
      return await this.doMoveInstances(targetDir)
    } finally {
      this.moving = false
    }
  }

  private async doMoveInstances(targetDir: string): Promise<{ success: boolean; error?: string }> {
    const currentDir = this.getResourceDir()
    if (!path.isAbsolute(targetDir)) {
      return { success: false, error: 'Der Zielordner muss ein absoluter Pfad sein.' }
    }
    const resolvedTarget = path.resolve(targetDir)
    const validation = validateMigrationTarget(currentDir, resolvedTarget)
    if (!validation.ok) {
      const messages: Record<Exclude<MigrationValidation, { ok: true }>['error'], string> = {
        'already-current': 'Das ist bereits der aktuelle Speicherort.',
        nested: 'Der Zielordner darf nicht im aktuellen Speicherort liegen (oder umgekehrt).',
        empty: 'Bitte wähle einen Ordner.',
      }
      return { success: false, error: messages[validation.error] }
    }

    try {
      await fs.mkdir(resolvedTarget, { recursive: true })
      const targetStat = await fs.lstat(resolvedTarget)
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        return { success: false, error: 'Der Zielordner darf kein symbolischer Link oder eine Junction sein.' }
      }
      const currentStat = await fs.lstat(currentDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (currentStat && (!currentStat.isDirectory() || currentStat.isSymbolicLink())) {
        return { success: false, error: 'Der aktuelle Speicherort ist kein sicherer Ordner.' }
      }
      const targetEntries = await fs.readdir(resolvedTarget)
      if (targetEntries.length > 0) {
        return { success: false, error: 'Der Zielordner muss leer sein.' }
      }
      const testPath = path.join(resolvedTarget, `.myftb-write-test-${crypto.randomUUID()}`)
      await fs.writeFile(testPath, 'test', { flag: 'wx', mode: 0o600 })
      await fs.rm(testPath)
    } catch {
      return { success: false, error: 'Der Zielordner ist nicht beschreibbar.' }
    }

    let entries: string[]
    try {
      entries = await fs.readdir(currentDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = []
      else return { success: false, error: 'Der aktuelle Speicherort konnte nicht gelesen werden.' }
    }

    for (const entry of entries) {
      try {
        await fs.lstat(path.join(resolvedTarget, entry))
        return { success: false, error: `„${entry}“ existiert bereits im Zielordner.` }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { success: false, error: `Der Zielordner konnte nicht geprüft werden: „${entry}“.` }
        }
      }
    }

    const copied: string[] = []
    try {
      for (const entry of entries) {
        const destination = path.join(resolvedTarget, entry)
        try {
          await copyAndVerifyTree(path.join(currentDir, entry), destination)
          copied.push(entry)
        } catch (error) {
          await fs.rm(destination, { recursive: true, force: true }).catch(() => {})
          throw error
        }
      }
      const previousDir = this.config.installationDir
      this.config.installationDir = resolvedTarget
      try {
        await this.save()
      } catch (error) {
        this.config.installationDir = previousDir
        throw error
      }
    } catch (error) {
      for (const entry of copied) {
        await fs.rm(path.join(resolvedTarget, entry), { recursive: true, force: true }).catch(() => {})
      }
      logger.error('[ConfigService] Verified instance migration failed:', error)
      return { success: false, error: 'Die Daten konnten nicht vollständig kopiert und geprüft werden.' }
    }

    logger.info(
      `[ConfigService] Instances copied and verified: ${currentDir} -> ${resolvedTarget}; old data retained for rollback`,
    )
    return { success: true }
  }
}

export const configService = new ConfigService()
