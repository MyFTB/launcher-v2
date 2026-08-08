import path from 'node:path'
import fs from 'node:fs/promises'
import crypto, { randomUUID } from 'node:crypto'
import { setMaxListeners } from 'node:events'

import {
  install as installMinecraft,
  getVersionList,
  installForge,
  installNeoForged,
  installFabric,
  installResolvedLibraries,
  installAssets,
} from '@xmcl/installer'
import { Version } from '@xmcl/core'

import { xmclDownloadDispatcher } from '../download-agent'
import { fetchWithRetry, detectHashAlgorithm, readJsonResponseLimited } from '../fetch-retry'
import { downloadFile, DownloadError, normalizeHash } from '../download-manager'

import { IpcChannels } from '../ipc/channels'
import { IpcError, noPayload, requireObject, secureHandle } from '../ipc/security'
import { Constants, fmt } from '../constants'
import { atomicWriteFile, configService } from './config.service'
import { getMainWindow } from '../app-state'
import { packOperationService, PackOperationConflictError } from './pack-operation.service'
import { ensureRuntime, resolveJavaPath } from './java.service'
import { logger } from '../logger'
import { assertContainedNoLinks, assertSafeDownloadDestination } from '../filesystem-safety'
import type {
  ModpackManifest,
  ModpackManifestReference,
  Feature,
  FeatureCondition,
  FileTask,
  InstallProgressEvent,
  InstallCompleteEvent,
  InstallNeedsFeaturesEvent,
  InstallModpackPayload,
  InstallResult,
  DownloadFailure,
  ChangeFeaturesPayload,
  ChangeFeaturesResult,
  PackFeaturesResult,
  VerifyPackResult,
} from '../../shared/types'
import {
  assertPackName,
  assertSafeRelativePath,
  validateModpackManifest,
  validateModpackReference,
  ValidationError,
} from '../../shared/validation'

// ─── Types ───────────────────────────────────────────────────────────────────

type ModLoader = 'forge' | 'neoforge' | 'fabric' | 'quilt' | 'vanilla'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true when `filePath` resolves to a location strictly inside `baseDir`.
 * Exported for unit testing; used to guard against path traversal in manifest tasks.
 */
export function isPathWithinDir(baseDir: string, filePath: string): boolean {
  const resolvedBase = path.resolve(baseDir)
  const resolvedTarget = path.resolve(baseDir, filePath)
  return resolvedTarget.startsWith(resolvedBase + path.sep)
}

/**
 * Evaluate a FileTask `when` condition against the currently selected features.
 * Returns `true` when the file should be downloaded.
 * Exported for unit testing.
 */
export function evaluateCondition(
  condition: FeatureCondition | undefined,
  selectedFeatures: string[],
): boolean {
  if (!condition) return true

  if (condition.if === 'requireAny') {
    return condition.features.some((f) => selectedFeatures.includes(f))
  }

  if (condition.if === 'requireAll') {
    return condition.features.every((f) => selectedFeatures.includes(f))
  }

  return true
}

/**
 * Infer which features are currently selected by checking which feature-gated
 * files exist on disk. Optimistic: assumes a feature is selected if evidence
 * for it exists. Exported for unit testing.
 */
export function inferSelectedFeatures(
  features: Feature[],
  tasks: FileTask[],
  existingFiles: Set<string>,
): string[] {
  const selected: string[] = []
  for (const feature of features) {
    const gatedTasks = tasks.filter(
      (t) => t.when && t.when.features.includes(feature.name),
    )
    if (gatedTasks.length === 0) {
      // Feature has no gated tasks — assume default
      if (feature.default) selected.push(feature.name)
      continue
    }
    // Optimistic: if any gated file exists, assume the feature was selected
    const anyExists = gatedTasks.some((t) => existingFiles.has(t.to))
    if (anyExists) {
      selected.push(feature.name)
    }
  }
  return selected
}

const SELECTED_FEATURES_FILE = 'selected-features.json'

/**
 * Read the persisted feature selection for an installed pack.
 * Falls back to disk inference for legacy installs without the file.
 */
async function readSelectedFeatures(
  instanceDir: string,
  manifest: ModpackManifest,
): Promise<string[]> {
  const filePath = path.join(instanceDir, SELECTED_FEATURES_FILE)
  try {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Invalid feature selection file')
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
    if (
      !Array.isArray(parsed)
      || parsed.length > 200
      || parsed.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 128)
    ) throw new Error('Invalid feature selection')
    const available = new Set((manifest.features ?? []).map((feature) => feature.name))
    return [...new Set(parsed as string[])].filter((feature) => available.has(feature))
  } catch {
    // No saved selection — infer from files on disk
  }

  if (!manifest.features || manifest.features.length === 0) return []

  const tasks = manifest.tasks ?? []
  const existingFiles = new Set<string>()
  for (const task of tasks) {
    if (!task.when) continue
    const targetPath = path.join(instanceDir, task.to)
    try {
      await fs.access(targetPath)
      existingFiles.add(task.to)
    } catch {
      // File does not exist
    }
  }

  return inferSelectedFeatures(manifest.features, tasks, existingFiles)
}

/**
 * Persist the user's feature selection to the instance directory.
 */
async function writeSelectedFeatures(
  instanceDir: string,
  selectedFeatures: string[],
): Promise<void> {
  const filePath = path.join(instanceDir, SELECTED_FEATURES_FILE)
  await atomicWriteFile(filePath, `${JSON.stringify(selectedFeatures, null, 2)}\n`)
}

/**
 * Detect the mod loader used by a modpack.
 *
 * Priority:
 *  1. versionManifest.libraries — checks net.neoforged / net.minecraftforge:forge specifically
 *  2. versionManifest.id — for packs whose versionManifest omits the libraries array entirely;
 *     the ID pattern "{mc}-forge-{ver}" or "{mc}-neoforge-{ver}" is always present.
 *  3. fabric-loader- / quilt-loader- ID prefix.
 *
 * Returns the loader type and the library name to pass to buildForgeEntry / installNeoForged.
 * For library-absent packs a synthetic coordinate is synthesised from the version ID.
 */
function detectModLoader(manifest: ModpackManifest): {
  loader: ModLoader
  libraryName: string | null
} {
  const libraries = manifest.versionManifest.libraries ?? []
  const versionId = manifest.versionManifest.id ?? ''

  // ── 1. Library scan (most reliable when libraries are present) ────────────
  for (const lib of libraries) {
    if (lib.name.includes('net.neoforged:neoforge:') || lib.name.includes('net.neoforged:forge:')) {
      return { loader: 'neoforge', libraryName: lib.name }
    }
  }

  for (const lib of libraries) {
    if (lib.name.includes('net.minecraftforge:forge:')) {
      return { loader: 'forge', libraryName: lib.name }
    }
  }

  // ── 2. Version ID fallback (handles packs with no libraries array) ────────
  // Patterns: "{mcVersion}-forge-{forgeVersion}"  e.g. 1.20.1-forge-47.4.0
  //           "{mcVersion}-neoforge-{forgeVersion}" e.g. 1.20.1-neoforge-47.1.0
  //           "neoforge-{forgeVersion}"             e.g. neoforge-21.1.219
  const idMatch = versionId.match(/^(\d+\.\d+(?:\.\d+)?)-(?:(neoforge)|(forge))-(.+)$/)
  if (idMatch) {
    const [, mcVersion, neoToken, , forgeVersion] = idMatch
    if (neoToken) {
      return { loader: 'neoforge', libraryName: `net.neoforged:neoforge:${forgeVersion}` }
    }
    // net.minecraftforge:forge:{mcVersion}-{forgeVersion} — modern format
    return { loader: 'forge', libraryName: `net.minecraftforge:forge:${mcVersion}-${forgeVersion}` }
  }

  // Short-form NeoForge ID with no MC-version prefix, e.g. "neoforge-21.1.219"
  const neoShortMatch = versionId.match(/^neoforge-(.+)$/)
  if (neoShortMatch) {
    return { loader: 'neoforge', libraryName: `net.neoforged:neoforge:${neoShortMatch[1]}` }
  }

  // ── 3. Fabric / Quilt by ID prefix ────────────────────────────────────────
  if (versionId.startsWith('fabric-loader-')) {
    return { loader: 'fabric', libraryName: versionId }
  }

  if (versionId.startsWith('quilt-loader-')) {
    return { loader: 'quilt', libraryName: versionId }
  }

  return { loader: 'vanilla', libraryName: null }
}

/**
 * Extract the version portion from a Maven coordinate string.
 * e.g. 'net.minecraftforge:forge:1.20.1-47.2.0' → '1.20.1-47.2.0'
 * e.g. 'net.neoforged:neoforge:21.1.0'           → '21.1.0'
 */
function extractMavenVersion(libraryName: string): string {
  const parts = libraryName.split(':')
  if (parts.length < 3) {
    throw new Error(`Cannot extract version from Maven coordinate: ${libraryName}`)
  }
  return parts[2]
}

/**
 * Build the forge entry `{ mcversion, version }` that @xmcl/installer's
 * `installForge` expects.
 *
 * `installForge` internally runs `getForgeArtifactVersion()` which behaves as:
 *   - MC 1.7.x / 1.8.x  →  `{mcversion}-{version}-{mcversion}`
 *   - version starts with mcversion  →  `version`
 *   - otherwise  →  `{mcversion}-{version}`
 *
 * The library name in the pack manifest stores the full Maven artifact version
 * (e.g. `1.7.10-10.13.4.1614-1.7.10`), but for 1.7.x/1.8.x installForge
 * expects only the bare build number (`10.13.4.1614`) in the `version` field.
 * For modern Forge the full Maven artifact version is used as-is.
 */
function buildForgeEntry(
  mcversion: string,
  libraryName: string,
): { mcversion: string; version: string } {
  const mavenVersion = extractMavenVersion(libraryName)
  const minor = parseInt(mcversion.split('.')[1] ?? '0', 10)

  // For MC 1.7.x/1.8.x the Maven artifact is '{mc}-{buildNum}-{mc}'.
  // Strip the wrapping mc-version so installForge gets just '{buildNum}'.
  if (minor >= 7 && minor <= 8) {
    const prefix = `${mcversion}-`
    const suffix = `-${mcversion}`
    if (mavenVersion.startsWith(prefix) && mavenVersion.endsWith(suffix)) {
      return { mcversion, version: mavenVersion.slice(prefix.length, mavenVersion.length - suffix.length) }
    }
  }

  return { mcversion, version: mavenVersion }
}

/**
 * Convert an unknown thrown value into a human-readable error string.
 *
 * `@xmcl/file-transfer` throws `AggregateError` for download failures.
 * Its own `.message` is always empty — the real information lives in
 * `err.errors[]`.  We extract the first meaningful child message so the
 * user sees something actionable instead of the bare constructor name.
 *
 * Exported for unit testing.
 */
export function formatInstallError(err: unknown): string {
  if (err instanceof AggregateError) {
    const childMessages = err.errors
      .map((e) => (e instanceof Error ? e.message || e.constructor.name : String(e)))
      .filter(Boolean)
    if (childMessages.length > 0) {
      // Show the first error; if there are more, append a count.
      const first = childMessages[0]
      return childMessages.length === 1 ? first : `${first} (+${childMessages.length - 1} more)`
    }
    return 'AggregateError'
  }
  if (err instanceof Error) {
    return err.message || err.constructor.name || 'Unknown error'
  }
  return String(err) || 'Unknown error'
}

/**
 * Send a push event to the renderer window (fire-and-forget).
 */
function pushEvent(channel: string, payload: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

class InstallTransactionError extends Error {
  constructor(readonly failures: DownloadFailure[], message = 'Nicht alle Dateien konnten geladen werden.') {
    super(message)
    this.name = 'InstallTransactionError'
  }
}

interface StagedTask {
  task: FileTask
  stagedPath: string
  targetPath: string
}

async function fileMatchesHash(filePath: string, expected: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    const hash = crypto.createHash(detectHashAlgorithm(normalizeHash(expected)))
    const handle = await fs.open(filePath, 'r')
    try {
      for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer)
    } finally {
      await handle.close().catch(() => {})
    }
    return hash.digest('hex').toLowerCase() === normalizeHash(expected)
  } catch {
    return false
  }
}

async function assertNoSymlinkEscape(root: string, relativePath: string): Promise<void> {
  if (!isPathWithinDir(root, relativePath)) throw new ValidationError('Ein Dateipfad verlässt den Instanzordner.')
  const components = relativePath.replace(/\\/g, '/').split('/').slice(0, -1)
  let current = path.resolve(root)
  for (const component of components) {
    current = path.join(current, component)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw new ValidationError('Symbolische Links in verwalteten Dateipfaden sind nicht erlaubt.')
      if (!stat.isDirectory()) throw new ValidationError('Ein verwalteter Elternpfad ist kein Ordner.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

function resolveTaskUrl(task: FileTask): string {
  return task.location.startsWith('http')
    ? task.location
    : fmt(Constants.launcherObjects, task.location)
}

async function prepareStagingDirectory(instanceDir: string, stagingDir: string): Promise<void> {
  await assertContainedNoLinks(instanceDir, stagingDir, { includeLeaf: true, label: 'Staging-Pfad' })
  await recoverStagingTransaction(instanceDir, stagingDir)
  await fs.mkdir(stagingDir, { recursive: true })
  await assertContainedNoLinks(instanceDir, stagingDir, { includeLeaf: true, label: 'Staging-Pfad' })
  const stat = await fs.lstat(stagingDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ValidationError('Der Staging-Pfad ist kein sicherer Ordner.')
  }
  // Verified downloads and their .part metadata may be resumed. A rollback
  // tree without a valid journal may contain the only intact copy of a file;
  // preserve it and stop instead of guessing that it is disposable.
  for (const name of ['rollback', 'rollback-features']) {
    if (await pathExists(path.join(stagingDir, name))) {
      throw new ValidationError('Ein unvollständiger Installations-Rollback muss zuerst wiederhergestellt werden.')
    }
  }
}

async function stageTasks(
  instanceDir: string,
  stagingDir: string,
  tasks: FileTask[],
  signal: AbortSignal,
  operationId: string,
  progressChannel: string,
): Promise<{ staged: StagedTask[]; failures: DownloadFailure[] }> {
  const staged: StagedTask[] = []
  const failures: DownloadFailure[] = []
  let finished = 0
  let queueIndex = 0
  const total = tasks.length

  const publish = (currentFile?: string): void => pushEvent(progressChannel, {
    operationId,
    total,
    finished,
    failed: failures.length,
    currentFile,
  } satisfies InstallProgressEvent)
  publish()

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = queueIndex++
      if (index >= tasks.length) return
      const task = tasks[index]
      signal.throwIfAborted()
      await assertNoSymlinkEscape(instanceDir, task.to)
      const targetPath = path.resolve(instanceDir, task.to)

      if (task.userFile) {
        try {
          await fs.access(targetPath)
          finished++
          publish(task.to)
          continue
        } catch {
          // A missing user file can be installed once, but never overwritten.
        }
      }

      const stagedPath = path.resolve(stagingDir, 'files', task.to)
      if (!isPathWithinDir(path.join(stagingDir, 'files'), task.to)) {
        throw new ValidationError('Ein Staging-Pfad ist ungültig.')
      }
      await assertSafeDownloadDestination(instanceDir, stagedPath, 'Download-Stagingpfad')
      try {
        if (!await fileMatchesHash(stagedPath, task.hash)) {
          const url = resolveTaskUrl(task)
          const external = new URL(url).hostname !== 'packs.myftb.de'
          await downloadFile({
            url,
            target: stagedPath,
            hash: task.hash,
            signal,
            requireStrongHash: external,
            taskName: task.to,
          })
        }
        staged.push({ task, stagedPath, targetPath })
        finished++
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        failures.push(error instanceof DownloadError
          ? error.failure
          : {
              task: task.to,
              kind: 'unknown',
              message: formatInstallError(error),
              retryable: false,
              attempts: 1,
            })
      }
      publish(task.to)
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, () => worker()))
  return { staged, failures }
}

async function readOptional(filePath: string, maxBytes: number, label: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
      throw new ValidationError(`${label} ist keine sichere reguläre Datei.`)
    }
    return await fs.readFile(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function restoreOptional(filePath: string, contents: Buffer | null): Promise<void> {
  if (contents === null) await fs.rm(filePath, { force: true })
  else await atomicWriteFile(filePath, contents)
}

interface InstallTransactionTarget {
  path: string
  hadOriginal: boolean
  newHash: string
}

interface InstallTransactionJournal {
  version: 1
  kind: 'managed' | 'features'
  marker: 'manifest.json' | typeof SELECTED_FEATURES_FILE
  newMarkerHash: string
  newAuxiliaryHash: string | null
  previousMarkerHash: string | null
  previousMarkerPresent: boolean
  previousAuxiliaryPresent: boolean
  targets: InstallTransactionTarget[]
  removed: string[]
}

const TRANSACTION_FILE = '.transaction.json'
const PREVIOUS_MARKER_FILE = '.transaction.previous-marker'
const PREVIOUS_AUXILIARY_FILE = '.transaction.previous-auxiliary'
const MAX_TRANSACTION_JOURNAL_BYTES = 64 * 1024 * 1024
const MAX_TRANSACTION_BACKUP_BYTES = 50 * 1024 * 1024

function bufferDigest(contents: Buffer | null): string | null {
  return contents === null ? null : crypto.createHash('sha256').update(contents).digest('hex')
}

async function fileDigestOrNull(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50 * 1024 * 1024) return null
    return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
  } catch {
    return null
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try { await fs.lstat(filePath); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function parseInstallTransaction(value: unknown): InstallTransactionJournal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Das Installationsprotokoll ist ungültig.')
  }
  const record = value as Record<string, unknown>
  const kind = record.kind
  const marker = record.marker
  const targets = record.targets
  const removed = record.removed
  if (
    record.version !== 1
    || (kind !== 'managed' && kind !== 'features')
    || (marker !== 'manifest.json' && marker !== SELECTED_FEATURES_FILE)
    || typeof record.newMarkerHash !== 'string'
    || !/^[0-9a-f]{64}$/i.test(record.newMarkerHash)
    || (record.newAuxiliaryHash !== null
      && (typeof record.newAuxiliaryHash !== 'string' || !/^[0-9a-f]{64}$/i.test(record.newAuxiliaryHash)))
    || (record.previousMarkerHash !== null
      && (typeof record.previousMarkerHash !== 'string' || !/^[0-9a-f]{64}$/i.test(record.previousMarkerHash)))
    || typeof record.previousMarkerPresent !== 'boolean'
    || typeof record.previousAuxiliaryPresent !== 'boolean'
    || (record.previousMarkerPresent !== (record.previousMarkerHash !== null))
    || (kind === 'managed' && (marker !== 'manifest.json' || record.newAuxiliaryHash === null))
    || (kind === 'features' && (marker !== SELECTED_FEATURES_FILE
      || record.newAuxiliaryHash !== null
      || record.previousAuxiliaryPresent))
    || !Array.isArray(targets)
    || targets.length > 100_000
    || !Array.isArray(removed)
    || removed.length > 100_000
  ) throw new ValidationError('Das Installationsprotokoll ist ungültig.')

  const parsedTargets = targets.map((target) => {
    if (typeof target !== 'object' || target === null || Array.isArray(target)) {
      throw new ValidationError('Das Installationsprotokoll enthält ein ungültiges Ziel.')
    }
    const item = target as Record<string, unknown>
    if (
      typeof item.hadOriginal !== 'boolean'
      || typeof item.newHash !== 'string'
      || !/^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{128})$/i.test(item.newHash)
    ) {
      throw new ValidationError('Das Installationsprotokoll enthält ein ungültiges Ziel.')
    }
    return {
      path: assertSafeRelativePath(item.path, 'Transaktionsziel'),
      hadOriginal: item.hadOriginal,
      newHash: normalizeHash(item.newHash),
    }
  })
  const parsedRemoved = removed.map((entry) => assertSafeRelativePath(entry, 'Bereinigungsziel'))
  const pathKey = (entry: string): string => entry.normalize('NFC').toLocaleLowerCase('en-US')
  const transactionPaths = [
    ...parsedTargets.map((target) => pathKey(target.path)),
    ...parsedRemoved.map(pathKey),
  ]
  const transactionPathSet = new Set(transactionPaths)
  if (transactionPathSet.size !== transactionPaths.length) {
    throw new ValidationError('Das Installationsprotokoll enthält doppelte oder überlappende Pfade.')
  }
  for (const entry of transactionPaths) {
    let separator = entry.indexOf('/')
    while (separator !== -1) {
      if (transactionPathSet.has(entry.slice(0, separator))) {
        throw new ValidationError('Das Installationsprotokoll enthält doppelte oder überlappende Pfade.')
      }
      separator = entry.indexOf('/', separator + 1)
    }
  }
  return {
    version: 1,
    kind,
    marker,
    newMarkerHash: record.newMarkerHash,
    newAuxiliaryHash: record.newAuxiliaryHash as string | null,
    previousMarkerHash: record.previousMarkerHash as string | null,
    previousMarkerPresent: record.previousMarkerPresent,
    previousAuxiliaryPresent: record.previousAuxiliaryPresent,
    targets: parsedTargets,
    removed: parsedRemoved,
  }
}

async function beginInstallTransaction(
  stagingDir: string,
  journal: InstallTransactionJournal,
  previousMarker: Buffer | null,
  previousAuxiliary: Buffer | null,
): Promise<void> {
  const markerBackup = path.join(stagingDir, PREVIOUS_MARKER_FILE)
  const auxiliaryBackup = path.join(stagingDir, PREVIOUS_AUXILIARY_FILE)
  const validatedJournal = parseInstallTransaction(journal)
  const serialized = `${JSON.stringify(validatedJournal, null, 2)}\n`
  if (Buffer.byteLength(serialized) > MAX_TRANSACTION_JOURNAL_BYTES) {
    throw new ValidationError('Das Installationsprotokoll überschreitet die erlaubte Größe.')
  }
  await fs.rm(path.join(stagingDir, TRANSACTION_FILE), { force: true })
  await restoreOptional(markerBackup, previousMarker)
  await restoreOptional(auxiliaryBackup, previousAuxiliary)
  await atomicWriteFile(path.join(stagingDir, TRANSACTION_FILE), serialized)
}

async function readTransactionBackup(stagingDir: string, name: string): Promise<Buffer> {
  const backupPath = path.join(stagingDir, name)
  await assertContainedNoLinks(stagingDir, backupPath, { includeLeaf: true, label: 'Transaktionssicherung' })
  const stat = await fs.lstat(backupPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSACTION_BACKUP_BYTES) {
    throw new ValidationError('Eine Transaktionssicherung ist nicht sicher.')
  }
  return fs.readFile(backupPath)
}

async function recoverStagingTransaction(instanceDir: string, stagingDir: string): Promise<void> {
  const journalPath = path.join(stagingDir, TRANSACTION_FILE)
  let journalStat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    journalStat = await fs.lstat(journalPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!journalStat.isFile() || journalStat.isSymbolicLink() || journalStat.size > MAX_TRANSACTION_JOURNAL_BYTES) {
    throw new ValidationError('Das unterbrochene Installationsprotokoll ist nicht sicher.')
  }
  const journal = parseInstallTransaction(JSON.parse(await fs.readFile(journalPath, 'utf8')) as unknown)
  const markerPath = path.join(instanceDir, journal.marker)
  const currentMarkerHash = await fileDigestOrNull(markerPath)
  const currentAuxiliaryHash = journal.kind === 'managed'
    ? await fileDigestOrNull(path.join(instanceDir, SELECTED_FEATURES_FILE))
    : null
  let targetsCommitted = true
  for (const target of journal.targets) {
    await assertNoSymlinkEscape(instanceDir, target.path)
    if (!await fileMatchesHash(path.resolve(instanceDir, target.path), target.newHash)) {
      targetsCommitted = false
      break
    }
  }
  let removalsCommitted = true
  if (targetsCommitted) {
    for (const relative of journal.removed) {
      await assertNoSymlinkEscape(instanceDir, relative)
      if (await pathExists(path.resolve(instanceDir, relative))) {
        removalsCommitted = false
        break
      }
    }
  }
  if (
    currentMarkerHash === journal.newMarkerHash
    && currentAuxiliaryHash === journal.newAuxiliaryHash
    && targetsCommitted
    && removalsCommitted
  ) {
    await fs.rm(stagingDir, { recursive: true, force: true })
    logger.info(`[InstallService] Completed interrupted ${journal.kind} transaction was finalized`)
    return
  }

  const rollbackRoot = path.join(stagingDir, journal.kind === 'managed' ? 'rollback' : 'rollback-features')
  const replacedRoot = path.join(rollbackRoot, 'replaced')
  for (const target of journal.targets) {
    await assertNoSymlinkEscape(instanceDir, target.path)
    const livePath = path.resolve(instanceDir, target.path)
    const backupPath = path.resolve(replacedRoot, target.path)
    await assertContainedNoLinks(stagingDir, backupPath, { includeLeaf: true, label: 'Rollback-Sicherung' })
    const backupExists = await pathExists(backupPath)
    const liveExists = await pathExists(livePath)
    if (backupExists) {
      const backupStat = await fs.lstat(backupPath)
      if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
        throw new ValidationError(`Die Rollback-Sicherung für „${target.path}“ ist keine sichere reguläre Datei.`)
      }
      if (liveExists && !await fileMatchesHash(livePath, target.newHash)) {
        throw new ValidationError(`Die Datei „${target.path}“ wurde nach dem Abbruch verändert; der Rollback wurde angehalten.`)
      }
      if (liveExists) await fs.rm(livePath, { force: true })
      await fs.mkdir(path.dirname(livePath), { recursive: true })
      await fs.rename(backupPath, livePath)
    } else if (!target.hadOriginal && liveExists) {
      if (!await fileMatchesHash(livePath, target.newHash)) {
        throw new ValidationError(`Die Datei „${target.path}“ wurde nach dem Abbruch verändert; der Rollback wurde angehalten.`)
      }
      await fs.rm(livePath, { force: true })
    }
  }

  const removedRoot = path.join(rollbackRoot, journal.kind === 'managed' ? 'stale' : 'removed')
  for (const relative of journal.removed) {
    await assertNoSymlinkEscape(instanceDir, relative)
    const backupPath = path.resolve(removedRoot, relative)
    await assertContainedNoLinks(stagingDir, backupPath, { includeLeaf: true, label: 'Rollback-Sicherung' })
    if (!await pathExists(backupPath)) continue
    const backupStat = await fs.lstat(backupPath)
    if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
      throw new ValidationError(`Die Rollback-Sicherung für „${relative}“ ist keine sichere reguläre Datei.`)
    }
    const livePath = path.resolve(instanceDir, relative)
    if (await pathExists(livePath)) {
      throw new ValidationError(`Der Pfad „${relative}“ wurde nach dem Abbruch neu angelegt; der Rollback wurde angehalten.`)
    }
    await fs.mkdir(path.dirname(livePath), { recursive: true })
    await fs.rename(backupPath, livePath)
  }

  const previousMarker = journal.previousMarkerPresent
    ? await readTransactionBackup(stagingDir, PREVIOUS_MARKER_FILE)
    : null
  await restoreOptional(markerPath, previousMarker)
  if (journal.kind === 'managed') {
    const previousFeatures = journal.previousAuxiliaryPresent
      ? await readTransactionBackup(stagingDir, PREVIOUS_AUXILIARY_FILE)
      : null
    await restoreOptional(path.join(instanceDir, SELECTED_FEATURES_FILE), previousFeatures)
  }
  await fs.rm(stagingDir, { recursive: true, force: true })
  logger.warn(`[InstallService] Rolled back interrupted ${journal.kind} transaction`)
}

const transactionRecoveryFlights = new Map<string, Promise<void>>()

async function performInterruptedTransactionRecovery(instanceDir: string): Promise<void> {
  const stagingRoot = path.join(instanceDir, '.myftb-staging')
  let entries: string[]
  try {
    const stat = await fs.lstat(stagingRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ValidationError('Der Transaktionsordner ist nicht sicher.')
    }
    entries = await fs.readdir(stagingRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const stagingDir = path.join(stagingRoot, entry)
    const stat = await fs.lstat(stagingDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ValidationError('Ein Transaktionspfad ist nicht sicher.')
    }
    await recoverStagingTransaction(instanceDir, stagingDir)
  }
}

/** Recover or finalize interrupted per-instance commits before using the pack. */
export async function recoverInterruptedTransactions(instanceDir: string): Promise<void> {
  const key = path.resolve(instanceDir).normalize('NFC').toLocaleLowerCase('en-US')
  const existing = transactionRecoveryFlights.get(key)
  if (existing) return existing
  const operation = performInterruptedTransactionRecovery(instanceDir)
  transactionRecoveryFlights.set(key, operation)
  try {
    await operation
  } finally {
    if (transactionRecoveryFlights.get(key) === operation) transactionRecoveryFlights.delete(key)
  }
}

async function commitFeatureTransaction(
  instanceDir: string,
  stagingDir: string,
  staged: StagedTask[],
  toDelete: FileTask[],
  newSelection: string[],
): Promise<void> {
  const rollbackDir = path.join(stagingDir, 'rollback-features')
  const selectionPath = path.join(instanceDir, SELECTED_FEATURES_FILE)
  const previousSelection = await readOptional(selectionPath, 64 * 1024, 'Die bisherige Feature-Auswahl')
  const newSelectionBytes = Buffer.from(`${JSON.stringify(newSelection, null, 2)}\n`)
  const targets: InstallTransactionTarget[] = []
  for (const item of staged) {
    targets.push({
      path: item.task.to,
      hadOriginal: await pathExists(item.targetPath),
      newHash: normalizeHash(item.task.hash),
    })
  }
  const removed = toDelete.filter((task) => !task.userFile).map((task) => task.to)
  await beginInstallTransaction(stagingDir, {
    version: 1,
    kind: 'features',
    marker: SELECTED_FEATURES_FILE,
    newMarkerHash: bufferDigest(newSelectionBytes)!,
    newAuxiliaryHash: null,
    previousMarkerHash: bufferDigest(previousSelection),
    previousMarkerPresent: previousSelection !== null,
    previousAuxiliaryPresent: false,
    targets,
    removed,
  }, previousSelection, null)

  const backups: Array<{ original: string; backup: string }> = []
  const committed: string[] = []
  const backup = async (target: string, relative: string): Promise<void> => {
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ValidationError('Ein verwaltetes Dateiziel ist keine sichere reguläre Datei.')
    }
    const backupPath = path.resolve(rollbackDir, relative)
    if (!isPathWithinDir(rollbackDir, relative)) throw new ValidationError('Feature-Rollback-Pfad ist ungültig.')
    await assertContainedNoLinks(instanceDir, backupPath, { includeLeaf: true, label: 'Feature-Rollback-Pfad' })
    await fs.mkdir(path.dirname(backupPath), { recursive: true })
    await fs.rename(target, backupPath)
    backups.push({ original: target, backup: backupPath })
  }
  try {
    for (const item of staged) {
      await assertNoSymlinkEscape(instanceDir, item.task.to)
      await fs.mkdir(path.dirname(item.targetPath), { recursive: true })
      await backup(item.targetPath, path.join('replaced', item.task.to))
      await fs.rename(item.stagedPath, item.targetPath)
      committed.push(item.targetPath)
    }
    for (const task of toDelete) {
      if (task.userFile) continue
      await assertNoSymlinkEscape(instanceDir, task.to)
      await backup(path.resolve(instanceDir, task.to), path.join('removed', task.to))
    }
    // The feature selection is the commit marker and is written last.
    await atomicWriteFile(selectionPath, newSelectionBytes)
  } catch (error) {
    for (const target of committed.reverse()) await fs.rm(target, { force: true }).catch(() => {})
    for (const item of backups.reverse()) {
      await fs.mkdir(path.dirname(item.original), { recursive: true }).catch(() => {})
      await fs.rename(item.backup, item.original).catch(() => {})
    }
    await restoreOptional(selectionPath, previousSelection).catch(() => {})
    throw error
  }
  await fs.rm(stagingDir, { recursive: true, force: true }).catch((error) => {
    logger.warn('[InstallService] Feature transaction committed; deferred staging cleanup:', error)
  })
}

async function commitManagedTransaction(
  instanceDir: string,
  stagingDir: string,
  staged: StagedTask[],
  manifest: ModpackManifest,
  selectedFeatures: string[],
  oldManifest: ModpackManifest | null,
  activeTasks: FileTask[] = manifest.tasks ?? [],
): Promise<void> {
  const rollbackDir = path.join(stagingDir, 'rollback')
  const manifestPath = path.join(instanceDir, 'manifest.json')
  const featuresPath = path.join(instanceDir, SELECTED_FEATURES_FILE)
  const previousManifest = await readOptional(manifestPath, 50 * 1024 * 1024, 'Das bisherige Manifest')
  const previousFeatures = await readOptional(featuresPath, 64 * 1024, 'Die bisherige Feature-Auswahl')
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  if (manifestBytes.length > 50 * 1024 * 1024) {
    throw new ValidationError('Das persistierte Modpack-Manifest überschreitet die erlaubte Größe.')
  }
  const featuresBytes = Buffer.from(`${JSON.stringify(selectedFeatures, null, 2)}\n`)
  const pathKey = (entry: string): string => entry.normalize('NFC').toLocaleLowerCase('en-US')
  const currentPaths = new Set(activeTasks.map((task) => pathKey(task.to)))
  const staleTasks = (oldManifest?.tasks ?? []).filter(
    (task) => !task.userFile && !currentPaths.has(pathKey(task.to)),
  )
  const targets: InstallTransactionTarget[] = []
  for (const item of staged) {
    targets.push({
      path: item.task.to,
      hadOriginal: await pathExists(item.targetPath),
      newHash: normalizeHash(item.task.hash),
    })
  }
  await beginInstallTransaction(stagingDir, {
    version: 1,
    kind: 'managed',
    marker: 'manifest.json',
    newMarkerHash: bufferDigest(manifestBytes)!,
    newAuxiliaryHash: bufferDigest(featuresBytes),
    previousMarkerHash: bufferDigest(previousManifest),
    previousMarkerPresent: previousManifest !== null,
    previousAuxiliaryPresent: previousFeatures !== null,
    targets,
    removed: staleTasks.map((task) => task.to),
  }, previousManifest, previousFeatures)

  const backups: Array<{ original: string; backup: string }> = []
  const committed: string[] = []
  const backupExisting = async (target: string, relative: string): Promise<void> => {
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ValidationError('Ein verwaltetes Dateiziel ist keine sichere reguläre Datei.')
    }
    const backup = path.resolve(rollbackDir, relative)
    if (!isPathWithinDir(rollbackDir, relative)) throw new ValidationError('Rollback-Pfad ist ungültig.')
    await assertContainedNoLinks(instanceDir, backup, { includeLeaf: true, label: 'Rollback-Pfad' })
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(target, backup)
    backups.push({ original: target, backup })
  }

  try {
    for (const item of staged) {
      await assertNoSymlinkEscape(instanceDir, item.task.to)
      await fs.mkdir(path.dirname(item.targetPath), { recursive: true })
      await backupExisting(item.targetPath, path.join('replaced', item.task.to))
      await fs.rename(item.stagedPath, item.targetPath)
      committed.push(item.targetPath)
    }

    for (const oldTask of staleTasks) {
      if (!isPathWithinDir(instanceDir, oldTask.to)) {
        throw new ValidationError('Das alte Manifest enthält einen unsicheren Bereinigungspfad.')
      }
      await assertNoSymlinkEscape(instanceDir, oldTask.to)
      await backupExisting(path.resolve(instanceDir, oldTask.to), path.join('stale', oldTask.to))
    }

    await atomicWriteFile(featuresPath, featuresBytes)
    // The manifest is the commit marker and is intentionally written last.
    await atomicWriteFile(manifestPath, manifestBytes)
  } catch (error) {
    for (const target of committed.reverse()) await fs.rm(target, { force: true }).catch(() => {})
    for (const item of backups.reverse()) {
      await fs.mkdir(path.dirname(item.original), { recursive: true }).catch(() => {})
      await fs.rename(item.backup, item.original).catch(() => {})
    }
    await restoreOptional(featuresPath, previousFeatures).catch(() => {})
    await restoreOptional(manifestPath, previousManifest).catch(() => {})
    throw error
  }
  await fs.rm(stagingDir, { recursive: true, force: true }).catch((error) => {
    logger.warn('[InstallService] Managed transaction committed; deferred staging cleanup:', error)
  })
}

// ─── Service ─────────────────────────────────────────────────────────────────

class InstallService {
  private currentAbort: AbortController | null = null
  private currentOperation: Promise<unknown> | null = null
  private pendingOperations = 0
  private readonly lastFailed = new Map<string, { reference: ModpackManifestReference; selectedFeatures?: string[] }>()

  isBusy(): boolean {
    return this.pendingOperations > 0 || this.currentAbort !== null || this.currentOperation !== null
  }

  registerHandlers(): void {
    const packPayload = (value: unknown): { packName: string } => ({
      packName: assertPackName(requireObject(value).packName),
    })
    secureHandle(
      IpcChannels.INSTALL_MODPACK,
      {
        validate: (value): InstallModpackPayload => {
          const payload = requireObject(value)
          const selectedFeatures = payload.selectedFeatures === undefined
            ? undefined
            : this.validateFeatures(payload.selectedFeatures)
          return { reference: validateModpackReference(payload.reference), selectedFeatures }
        },
      },
      (_event, payload) => this.installModpack(payload.reference, payload.selectedFeatures),
    )
    secureHandle(IpcChannels.INSTALL_CANCEL, { validate: noPayload }, () => this.handleInstallCancel())
    secureHandle(IpcChannels.INSTALL_GET_INSTALLED, { validate: noPayload }, async () => {
      const packs = await this.getInstalledPacks()
      return packs.map((pack) => ({
        name: pack.name,
        title: pack.title,
        version: pack.version,
        location: pack.location,
        gameVersion: pack.gameVersion,
        ...(pack.logo ? { logo: pack.logo } : {}),
        hasFeatures: Array.isArray(pack.features) && pack.features.length > 0,
      }))
    })
    secureHandle(
      IpcChannels.INSTALL_GET_PACK_FEATURES,
      { validate: packPayload },
      (_event, payload) => this.handleGetPackFeatures(payload.packName),
    )
    secureHandle(
      IpcChannels.INSTALL_CHANGE_FEATURES,
      {
        validate: (value): ChangeFeaturesPayload => {
          const payload = requireObject(value)
          return {
            packName: assertPackName(payload.packName),
            selectedFeatures: this.validateFeatures(payload.selectedFeatures),
          }
        },
      },
      (_event, payload) => this.handleChangeFeatures(payload),
    )
    secureHandle(
      IpcChannels.INSTALL_VERIFY_PACK,
      { validate: packPayload },
      (_event, payload) => this.verifyPack(payload.packName),
    )
    secureHandle(
      IpcChannels.INSTALL_REPAIR_PACK,
      { validate: packPayload },
      (_event, payload) => this.repairPack(payload.packName),
    )
    secureHandle(
      IpcChannels.INSTALL_RETRY_FAILED,
      { validate: packPayload },
      (_event, payload) => this.retryFailed(payload.packName),
    )
  }

  private validateFeatures(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 200 || value.some((entry) => typeof entry !== 'string' || entry.length > 128)) {
      throw new ValidationError('Die Feature-Auswahl ist ungültig.')
    }
    return [...new Set(value as string[])]
  }

  private async withPackRead<T>(
    packName: string,
    operation: (owner: string) => Promise<T>,
    owner = `read:${randomUUID()}`,
  ): Promise<T> {
    try {
      packOperationService.beginRead(packName, owner)
    } catch (error) {
      if (error instanceof PackOperationConflictError) throw new IpcError('CONFLICT', error.message)
      throw error
    }
    try {
      return await operation(owner)
    } finally {
      packOperationService.endRead(packName, owner)
    }
  }

  private async handleInstallCancel(): Promise<void> {
    const operation = this.currentOperation
    this.currentAbort?.abort()
    if (operation) await operation.catch(() => {})
  }

  private async handleGetPackFeatures(packName: string): Promise<PackFeaturesResult> {
    return this.withPackRead(packName, async (owner) => {
      const manifest = await this.getManifestByName(packName, owner)
      if (!manifest) {
        throw new Error(`Manifest fuer "${packName}" nicht gefunden`)
      }
      if (!manifest.features || manifest.features.length === 0) {
        throw new Error(`Pack "${packName}" hat keine optionalen Features`)
      }
      const instanceDir = await configService.getInstanceDir(packName, false)
      const selected = await readSelectedFeatures(instanceDir, manifest)
      return { features: manifest.features, selected }
    })
  }

  private async handleChangeFeatures(payload: ChangeFeaturesPayload): Promise<ChangeFeaturesResult> {
    if (configService.isStorageMigrationActive()) {
      throw new IpcError('CONFLICT', 'Während der Datenmigration können Modpacks nicht verändert werden.')
    }
    if (this.currentAbort) throw new IpcError('CONFLICT', 'Eine Installation oder Reparatur läuft bereits.')
    const owner = `features:${randomUUID()}`
    try {
      packOperationService.beginMutation(payload.packName, owner)
    } catch (error) {
      if (error instanceof PackOperationConflictError) throw new IpcError('CONFLICT', error.message)
      throw error
    }
    const operation = this.runChangeFeatures(payload.packName, payload.selectedFeatures, owner)
    this.currentOperation = operation
    try {
      return await operation
    } finally {
      packOperationService.endMutation(payload.packName, owner)
      if (this.currentOperation === operation) this.currentOperation = null
    }
  }

  // ── Install flow ──────────────────────────────────────────────────────────

  private async runInstall(
    manifest: ModpackManifest,
    selectedFeatures: string[],
    owner = `install:${randomUUID()}`,
  ): Promise<InstallResult> {
    if (this.currentAbort) throw new IpcError('CONFLICT', 'Eine Installation oder Reparatur läuft bereits.')
    try {
      packOperationService.beginMutation(manifest.name, owner)
    } catch (error) {
      if (error instanceof PackOperationConflictError) throw new IpcError('CONFLICT', error.message)
      throw error
    }

    const abort = new AbortController()
    setMaxListeners(0, abort.signal)
    this.currentAbort = abort
    const operationId = randomUUID()
    const operation = (async (): Promise<InstallResult> => {
      try {
        await this.doInstall(manifest, selectedFeatures, abort.signal, operationId)
        return { success: true, packName: manifest.name, operationId, failures: [] }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            success: false,
            packName: manifest.name,
            operationId,
            failures: [],
            cancelled: true,
            error: 'Installation abgebrochen',
          }
        }
        const failures = error instanceof InstallTransactionError ? error.failures : []
        return {
          success: false,
          packName: manifest.name,
          operationId,
          failures,
          error: formatInstallError(error),
        }
      }
    })()
    this.currentOperation = operation
    try {
      const result = await operation
      pushEvent(IpcChannels.INSTALL_COMPLETE, result satisfies InstallCompleteEvent)
      if (result.success) logger.info(`[InstallService] Install complete: ${manifest.name} v${manifest.version}`)
      else logger.warn(`[InstallService] Install failed for ${manifest.name}: ${result.error ?? 'unknown error'}`)
      return result
    } finally {
      packOperationService.endMutation(manifest.name, owner)
      if (this.currentAbort === abort) this.currentAbort = null
      if (this.currentOperation === operation) this.currentOperation = null
    }
  }

  private async doInstall(
    manifest: ModpackManifest,
    selectedFeatures: string[],
    signal: AbortSignal,
    operationId: string,
  ): Promise<void> {
    // ── a. Prepare instance directory ────────────────────────────────────────
    const instanceDir = await configService.getInstanceDir(manifest.name, true)
    await recoverInterruptedTransactions(instanceDir)

    // ── b. Detect mod loader ─────────────────────────────────────────────────
    const { loader, libraryName } = detectModLoader(manifest)
    logger.info(`[InstallService] Mod loader: ${loader}${libraryName ? ` (${libraryName})` : ''}`)

    // ── c. Install base Minecraft ────────────────────────────────────────────
    const minecraftDir = configService.getInstallDir()

    pushEvent(IpcChannels.INSTALL_PROGRESS, {
      total: 0,
      finished: 0,
      failed: 0,
      currentFile: 'Minecraft-Versionsliste wird geladen...',
    } satisfies InstallProgressEvent)

    signal.throwIfAborted()

    const versionList = await getVersionList()
    const targetVersion = versionList.versions.find((v) => v.id === manifest.gameVersion)
    if (!targetVersion) {
      throw new Error(`Minecraft version ${manifest.gameVersion} not found in version manifest`)
    }

    logger.info(`[InstallService] Installing Minecraft ${manifest.gameVersion}...`)

    pushEvent(IpcChannels.INSTALL_PROGRESS, {
      total: 0,
      finished: 0,
      failed: 0,
      currentFile: `Minecraft ${manifest.gameVersion} wird installiert...`,
    } satisfies InstallProgressEvent)

    await installMinecraft(targetVersion, minecraftDir, { dispatcher: xmclDownloadDispatcher })

    signal.throwIfAborted()

    // ── d. Ensure JRE ────────────────────────────────────────────────────────
    // Must happen before the mod-loader install so that Java is available when
    // Forge / NeoForge post-processors run.
    pushEvent(IpcChannels.INSTALL_PROGRESS, {
      total: 0,
      finished: 0,
      failed: 0,
      currentFile: 'Java-Laufzeitumgebung wird vorbereitet...',
    } satisfies InstallProgressEvent)

    await ensureRuntime(
      manifest,
      signal,
      { total: 0, finished: 0, failed: 0 },
      (p) => pushEvent(IpcChannels.INSTALL_PROGRESS, p satisfies InstallProgressEvent),
    )

    signal.throwIfAborted()

    const javaPath = await resolveJavaPath(manifest)
    logger.info(`[InstallService] Java resolved to: ${javaPath}`)

    // ── e. Install mod loader ─────────────────────────────────────────────────
    if (loader === 'forge' && libraryName) {
      const forgeEntry = buildForgeEntry(manifest.gameVersion, libraryName)

      logger.info(`[InstallService] Installing Forge ${forgeEntry.version}...`)
      pushEvent(IpcChannels.INSTALL_PROGRESS, {
        total: 0,
        finished: 0,
        failed: 0,
        currentFile: `Forge ${forgeEntry.version} wird installiert...`,
      } satisfies InstallProgressEvent)

      await installForge(forgeEntry, minecraftDir, { java: javaPath, dispatcher: xmclDownloadDispatcher })

      signal.throwIfAborted()
    } else if (loader === 'neoforge' && libraryName) {
      const neoforgeVersion = extractMavenVersion(libraryName)

      logger.info(`[InstallService] Installing NeoForge ${neoforgeVersion}...`)
      pushEvent(IpcChannels.INSTALL_PROGRESS, {
        total: 0,
        finished: 0,
        failed: 0,
        currentFile: `NeoForge ${neoforgeVersion} wird installiert...`,
      } satisfies InstallProgressEvent)

      await installNeoForged('neoforge', neoforgeVersion, minecraftDir, { java: javaPath, dispatcher: xmclDownloadDispatcher })

      // installNeoForged creates the version JSON under the installer's own ID
      // (e.g. '1.21.1-neoforge-21.1.219'), but manifest.versionManifest.id may
      // use the short form (e.g. 'neoforge-21.1.219').  Write the pack's
      // versionManifest under its own ID so Version.parse and the launch service
      // can find it — same pattern as the Fabric handler below.
      const neoVersionId = manifest.versionManifest.id
      const neoVersionDir = path.join(minecraftDir, 'versions', neoVersionId)
      const neoVersionJsonPath = path.join(neoVersionDir, `${neoVersionId}.json`)
      await fs.mkdir(neoVersionDir, { recursive: true })
      try {
        // CodeQL[js/http-to-file-access]: versionManifest from trusted packs.myftb.de, intentionally written to Minecraft dir
        await fs.writeFile(neoVersionJsonPath, JSON.stringify(manifest.versionManifest), { encoding: 'utf8', flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        // File already exists — keep it
      }

      signal.throwIfAborted()
    } else if (loader === 'fabric' || loader === 'quilt') {
      // For Fabric/Quilt, extract the loader version from the version manifest ID.
      // Format: 'fabric-loader-<loaderVersion>-<mcVersion>' or 'quilt-loader-<loaderVersion>-<mcVersion>'
      const versionId = manifest.versionManifest.id
      const parts = versionId.split('-')
      // parts[0]='fabric'/'quilt', parts[1]='loader', parts[2]=loaderVersion, parts[3..]=mcVersion
      const loaderVersion = parts[2]
      const mcVersion = parts.slice(3).join('-')

      logger.info(`[InstallService] Installing ${loader === 'fabric' ? 'Fabric' : 'Quilt'} loader ${loaderVersion} (MC ${mcVersion})...`)
      pushEvent(IpcChannels.INSTALL_PROGRESS, {
        total: 0,
        finished: 0,
        failed: 0,
        currentFile: `${loader === 'fabric' ? 'Fabric' : 'Quilt'} ${loaderVersion} wird installiert...`,
      } satisfies InstallProgressEvent)

      // installFabric writes the version JSON AND downloads the loader libraries
      await installFabric({
        minecraftVersion: mcVersion,
        version: loaderVersion,
        minecraft: minecraftDir,
      })

      // installFabric uses the ID format '<mcVersion>-fabric<loaderVersion>' (e.g. '1.21.8-fabric0.18.3')
      // but our manifest.versionManifest.id is 'fabric-loader-<loaderVersion>-<mcVersion>'.
      // Write the versionManifest under its original ID so the launch service can find it by that name.
      const versionDir = path.join(minecraftDir, 'versions', versionId)
      const versionJsonPath = path.join(versionDir, `${versionId}.json`)
      await fs.mkdir(versionDir, { recursive: true })
      try {
        // CodeQL[js/http-to-file-access]: versionManifest from trusted packs.myftb.de, intentionally written to Minecraft dir
        await fs.writeFile(versionJsonPath, JSON.stringify(manifest.versionManifest), { encoding: 'utf8', flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        // File already exists — keep it
      }

      signal.throwIfAborted()
    }

    // ── f. Install libraries + assets for the resolved version ────────────────
    // This covers Fabric/Quilt loader JARs and any libraries not yet on disk.
    // Forge/NeoForge handle their own libraries, but this is safe to run for all.
    logger.info('[InstallService] Installing libraries and assets...')
    pushEvent(IpcChannels.INSTALL_PROGRESS, {
      total: 0, finished: 0, failed: 0,
      currentFile: 'Installiere Bibliotheken...',
    } satisfies InstallProgressEvent)

    const resolvedVersion = await Version.parse(minecraftDir, manifest.versionManifest.id)
    await installResolvedLibraries(resolvedVersion.libraries, minecraftDir, { dispatcher: xmclDownloadDispatcher })
    await installAssets(resolvedVersion, { dispatcher: xmclDownloadDispatcher })

    signal.throwIfAborted()

    // ── f. Stage, verify, and atomically commit managed pack files ────────────
    const tasks = (manifest.tasks ?? []).filter((task) => evaluateCondition(task.when, selectedFeatures))
    const manifestPath = path.join(instanceDir, 'manifest.json')
    let oldManifest: ModpackManifest | null = null
    try {
      const stat = await fs.lstat(manifestPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50 * 1024 * 1024) {
        throw new ValidationError('Das alte Manifest ist kein sicheres Dateiziel.')
      }
      oldManifest = validateModpackManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown)
    } catch {
      // Missing/invalid manifests are never used as a cleanup authority.
    }

    const transactionKey = crypto
      .createHash('sha256')
      .update(`${manifest.name}\0${manifest.version}\0${selectedFeatures.slice().sort().join('\0')}`)
      .digest('hex')
      .slice(0, 24)
    const stagingDir = path.join(instanceDir, '.myftb-staging', transactionKey)
    await prepareStagingDirectory(instanceDir, stagingDir)
    const { staged, failures } = await stageTasks(
      instanceDir,
      stagingDir,
      tasks,
      signal,
      operationId,
      IpcChannels.INSTALL_PROGRESS,
    )
    signal.throwIfAborted()
    if (failures.length > 0) {
      // Keep safe partial files and metadata so Retry can resume them.
      throw new InstallTransactionError(failures)
    }
    await commitManagedTransaction(
      instanceDir,
      stagingDir,
      staged,
      manifest,
      selectedFeatures,
      oldManifest,
      tasks,
    )
    signal.throwIfAborted()
  }

  // ── Feature change flow ──────────────────────────────────────────────────

  private async runChangeFeatures(packName: string, newSelection: string[], owner: string): Promise<ChangeFeaturesResult> {
    const abort = new AbortController()
    setMaxListeners(0, abort.signal)
    this.currentAbort = abort
    const { signal } = abort

    try {
      // 1. Recover any interrupted commit, then read the installed manifest.
      const instanceDir = await configService.getInstanceDir(packName, false)
      await recoverInterruptedTransactions(instanceDir)
      const manifest = await this.getManifestByName(packName, owner)
      if (!manifest) {
        const result: ChangeFeaturesResult = { success: false, error: `Manifest fuer "${packName}" nicht gefunden` }
        pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE, result)
        return result
      }

      // 2. Read old selection
      const oldSelection = await readSelectedFeatures(instanceDir, manifest)

      // 3. Compute diff
      const tasks = manifest.tasks ?? []
      const toDownload: FileTask[] = []
      const toDelete: FileTask[] = []

      for (const task of tasks) {
        if (!task.when) continue
        const nowIncluded = evaluateCondition(task.when, newSelection)
        const wasIncluded = evaluateCondition(task.when, oldSelection)
        if (nowIncluded && !wasIncluded) toDownload.push(task)
        if (!nowIncluded && wasIncluded) toDelete.push(task)
      }

      logger.info(`[InstallService] Feature change diff for "${packName}": ${toDownload.length} to download, ${toDelete.length} to delete`)

      if (toDownload.length === 0 && toDelete.length === 0) {
        // No file changes needed — just persist the new selection
        await writeSelectedFeatures(instanceDir, newSelection)
        const result: ChangeFeaturesResult = { success: true }
        pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE, result)
        return result
      }

      // 4. Stage additions, then commit additions/removals and selection together.
      const transactionKey = crypto.createHash('sha256')
        .update(`features\0${packName}\0${newSelection.slice().sort().join('\0')}`)
        .digest('hex')
        .slice(0, 24)
      const stagingDir = path.join(instanceDir, '.myftb-staging', transactionKey)
      await prepareStagingDirectory(instanceDir, stagingDir)
      const { staged, failures } = await stageTasks(
        instanceDir,
        stagingDir,
        toDownload,
        signal,
        randomUUID(),
        IpcChannels.INSTALL_FEATURES_CHANGE_PROGRESS,
      )
      signal.throwIfAborted()
      if (failures.length > 0) {
        const result: ChangeFeaturesResult = {
          success: false,
          error: `${failures.length} Datei(en) konnten nicht heruntergeladen werden`,
        }
        pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE, result)
        return result
      }
      await commitFeatureTransaction(instanceDir, stagingDir, staged, toDelete, newSelection)
      logger.info(`[InstallService] Feature change complete for "${packName}"`)
      const result: ChangeFeaturesResult = { success: true }
      pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE, result)
      return result
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        logger.info(`[InstallService] Feature change cancelled for "${packName}"`)
        const result: ChangeFeaturesResult = { success: false, error: 'Vorgang abgebrochen' }
        pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE, result)
        return result
      } else {
        logger.error(`[InstallService] Feature change failed for "${packName}":`, err)
        const result: ChangeFeaturesResult = { success: false, error: formatInstallError(err) }
        pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE, result)
        return result
      }
    } finally {
      if (this.currentAbort === abort) {
        this.currentAbort = null
      }
    }
  }

  // ── Public install API ────────────────────────────────────────────────────

  /** Fetch, validate, install, and return the actual completed result. */
  async installModpack(
    referenceInput: ModpackManifestReference,
    selectedFeatures?: string[],
    owner?: string,
  ): Promise<InstallResult> {
    const reference = validateModpackReference(referenceInput)
    if (configService.isStorageMigrationActive()) {
      return {
        success: false,
        packName: reference.name,
        failures: [],
        error: 'Während der Datenmigration können keine Modpacks installiert werden.',
      }
    }
    this.pendingOperations++
    try {
      return await this.installModpackInternal(reference, selectedFeatures, owner)
    } finally {
      this.pendingOperations--
    }
  }

  private async installModpackInternal(
    reference: ModpackManifestReference,
    selectedFeatures?: string[],
    owner?: string,
  ): Promise<InstallResult> {
    if (this.currentAbort) {
      return {
        success: false,
        packName: reference.name,
        failures: [],
        error: 'Eine andere Installation oder Reparatur läuft bereits.',
      }
    }

    try {
      const response = await fetchWithRetry(fmt(Constants.packManifest, reference.location), {
        timeoutMs: Constants.connectTimeoutMs,
      })
      if (!response.ok) {
        return {
          success: false,
          packName: reference.name,
          failures: [],
          error: `Das Manifest konnte nicht geladen werden (HTTP ${response.status}).`,
        }
      }
      const manifest = validateModpackManifest(await readJsonResponseLimited(response, 50 * 1024 * 1024))
      if (manifest.name !== reference.name) throw new ValidationError('Manifest und Modpack-Referenz stimmen nicht überein.')

      let features = selectedFeatures
      if (manifest.features?.length && features === undefined) {
        const existing = await this.getManifestByName(manifest.name)
        if (!existing) {
          pushEvent(IpcChannels.INSTALL_NEEDS_FEATURES, {
            features: manifest.features,
          } satisfies InstallNeedsFeaturesEvent)
          return {
            success: false,
            packName: manifest.name,
            failures: [],
            error: 'FEATURE_SELECTION_REQUIRED',
          }
        }
        features = await readSelectedFeatures(await configService.getInstanceDir(manifest.name, false), existing)
      }

      const result = await this.runInstall(manifest, features ?? [], owner)
      if (!result.success) this.lastFailed.set(manifest.name, { reference, selectedFeatures: features })
      else this.lastFailed.delete(manifest.name)
      return result
    } catch (error) {
      const result: InstallResult = {
        success: false,
        packName: reference.name,
        failures: error instanceof DownloadError ? [error.failure] : [],
        error: formatInstallError(error),
      }
      this.lastFailed.set(reference.name, { reference, selectedFeatures })
      return result
    }
  }

  async verifyPack(packNameInput: string, owner?: string): Promise<VerifyPackResult> {
    const packName = assertPackName(packNameInput)
    return this.withPackRead(packName, async (readOwner) => {
      const manifest = await this.getManifestByName(packName, readOwner)
      if (!manifest) throw new IpcError('NOT_FOUND', 'Das installierte Manifest wurde nicht gefunden.')
      const instanceDir = await configService.getInstanceDir(packName, false)
      const selected = await readSelectedFeatures(instanceDir, manifest)
      const missing: string[] = []
      const corrupt: string[] = []
      for (const task of (manifest.tasks ?? []).filter((entry) => !entry.userFile && evaluateCondition(entry.when, selected))) {
        await assertNoSymlinkEscape(instanceDir, task.to)
        const target = path.resolve(instanceDir, task.to)
        try {
          await fs.access(target)
        } catch {
          missing.push(task.to)
          continue
        }
        if (!await fileMatchesHash(target, task.hash)) corrupt.push(task.to)
      }
      return { packName, valid: missing.length === 0 && corrupt.length === 0, missing, corrupt }
    }, owner)
  }

  async repairPack(packNameInput: string): Promise<InstallResult> {
    const packName = assertPackName(packNameInput)
    if (configService.isStorageMigrationActive()) {
      return {
        success: false,
        packName,
        failures: [],
        error: 'Während einer Speicherort-Migration können Modpacks nicht repariert werden.',
      }
    }
    this.pendingOperations++
    try {
      return await this.repairPackInternal(packName)
    } finally {
      this.pendingOperations--
    }
  }

  private async repairPackInternal(packName: string): Promise<InstallResult> {
    const owner = `repair:${randomUUID()}`
    try {
      packOperationService.beginMutation(packName, owner)
    } catch (error) {
      return {
        success: false,
        packName,
        failures: [],
        error: error instanceof Error ? error.message : 'Das Modpack kann gerade nicht repariert werden.',
      }
    }

    try {
      if (this.currentAbort) {
        return { success: false, packName, failures: [], error: 'Eine andere Installation oder Reparatur läuft bereits.' }
      }
      const instanceDir = await configService.getInstanceDir(packName, false)
      await recoverInterruptedTransactions(instanceDir)
      const manifest = await this.getManifestByName(packName, owner)
      if (!manifest) return { success: false, packName, failures: [], error: 'Das installierte Manifest wurde nicht gefunden.' }
      const verification = await this.verifyPack(packName, owner)
      if (verification.valid) return { success: true, packName, failures: [] }

      const abort = new AbortController()
      setMaxListeners(0, abort.signal)
      this.currentAbort = abort
      const operationId = randomUUID()
      const operation = (async (): Promise<InstallResult> => {
        try {
          const selected = await readSelectedFeatures(instanceDir, manifest)
          const invalid = new Set([...verification.missing, ...verification.corrupt])
          const tasks = (manifest.tasks ?? []).filter((task) => !task.userFile && invalid.has(task.to))
          const key = crypto.createHash('sha256').update(`repair\0${packName}\0${manifest.version}`).digest('hex').slice(0, 24)
          const stagingDir = path.join(instanceDir, '.myftb-staging', key)
          await prepareStagingDirectory(instanceDir, stagingDir)
          const { staged, failures } = await stageTasks(
            instanceDir,
            stagingDir,
            tasks,
            abort.signal,
            operationId,
            IpcChannels.INSTALL_PROGRESS,
          )
          if (failures.length) throw new InstallTransactionError(failures)
          await commitManagedTransaction(
            instanceDir,
            stagingDir,
            staged,
            manifest,
            selected,
            manifest,
            manifest.tasks ?? [],
          )
          return { success: true, packName, operationId, failures: [] }
        } catch (error) {
          return {
            success: false,
            packName,
            operationId,
            failures: error instanceof InstallTransactionError ? error.failures : [],
            cancelled: error instanceof Error && error.name === 'AbortError',
            error: formatInstallError(error),
          }
        }
      })()
      this.currentOperation = operation
      try {
        const result = await operation
        pushEvent(IpcChannels.INSTALL_COMPLETE, result satisfies InstallCompleteEvent)
        return result
      } finally {
        if (this.currentAbort === abort) this.currentAbort = null
        if (this.currentOperation === operation) this.currentOperation = null
      }
    } finally {
      packOperationService.endMutation(packName, owner)
    }
  }

  async retryFailed(packNameInput: string): Promise<InstallResult> {
    const packName = assertPackName(packNameInput)
    const request = this.lastFailed.get(packName)
    if (!request) return this.repairPack(packName)
    return this.installModpack(request.reference, request.selectedFeatures)
  }

  // ── Public query API ──────────────────────────────────────────────────────

  /**
   * Scan the instances directory and return all installed pack manifests.
   */
  async getInstalledPacks(): Promise<ModpackManifest[]> {
    const instancesDir = configService.getInstancesDir()
    let entries: string[]
    try {
      entries = await fs.readdir(instancesDir)
    } catch {
      return []
    }

    const manifests: ModpackManifest[] = []
    for (const entry of entries) {
      try {
        const packName = assertPackName(entry)
        await this.withPackRead(packName, async () => {
          const instanceDir = await configService.getInstanceDir(packName, false)
          const stat = await fs.lstat(instanceDir)
          if (stat.isSymbolicLink() || !stat.isDirectory()) return
          await recoverInterruptedTransactions(instanceDir)
          const manifestPath = path.join(instanceDir, 'manifest.json')
          const manifestStat = await fs.lstat(manifestPath)
          if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 50 * 1024 * 1024) return
          const parsed = validateModpackManifest(
            JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown,
          )
          if (parsed.name === packName) manifests.push(parsed)
        })
      } catch {
        // Busy, incomplete, malformed, or unsafe instance directories are omitted.
      }
    }

    return manifests
  }

  /**
   * Read and return the manifest for a specific installed pack by name.
   * Returns `null` when not found or not readable.
   */
  async getManifestByName(name: string, owner?: string): Promise<ModpackManifest | null> {
    try {
      const packName = assertPackName(name)
      return await this.withPackRead(packName, async () => {
        const instanceDir = await configService.getInstanceDir(packName, false)
        const stat = await fs.lstat(instanceDir)
        if (stat.isSymbolicLink() || !stat.isDirectory()) return null
        await recoverInterruptedTransactions(instanceDir)
        const manifestPath = path.join(instanceDir, 'manifest.json')
        const manifestStat = await fs.lstat(manifestPath)
        if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 50 * 1024 * 1024) return null
        const manifest = validateModpackManifest(
          JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown,
        )
        return manifest.name === packName ? manifest : null
      }, owner)
    } catch {
      return null
    }
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const installService = new InstallService()
