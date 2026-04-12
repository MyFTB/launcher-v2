import path from 'node:path'
import fs from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { setMaxListeners } from 'node:events'
import { ipcMain } from 'electron'

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
import { fetchWithRetry, createHashingStream, detectHashAlgorithm } from '../fetch-retry'

import { IpcChannels } from '../ipc/channels'
import { Constants, fmt } from '../constants'
import { configService } from './config.service'
import { getMainWindow } from '../app-state'
import { ensureRuntime, resolveJavaPath } from './java.service'
import { logger } from '../logger'
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
  ChangeFeaturesPayload,
  ChangeFeaturesResult,
  PackFeaturesResult,
} from '../../shared/types'

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
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as string[]
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
  await fs.writeFile(filePath, JSON.stringify(selectedFeatures, null, 2), 'utf8')
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

// ─── Service ─────────────────────────────────────────────────────────────────

class InstallService {
  /** AbortController for the currently running install, or null when idle. */
  private currentAbort: AbortController | null = null

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  registerHandlers(): void {
    ipcMain.handle(IpcChannels.INSTALL_MODPACK, (_event, payload: InstallModpackPayload) => {
      return this.handleInstallModpack(payload)
    })

    ipcMain.handle(IpcChannels.INSTALL_CANCEL, () => {
      this.handleInstallCancel()
    })

    ipcMain.handle(IpcChannels.INSTALL_GET_INSTALLED, async () => {
      const packs = await this.getInstalledPacks()
      return packs.map((p) => ({
        name: p.name,
        version: p.version,
        hasFeatures: Array.isArray(p.features) && p.features.length > 0,
      }))
    })

    ipcMain.handle(IpcChannels.INSTALL_GET_PACK_FEATURES, async (_event, payload: { packName: string }) => {
      return this.handleGetPackFeatures(payload.packName)
    })

    ipcMain.handle(IpcChannels.INSTALL_CHANGE_FEATURES, (_event, payload: ChangeFeaturesPayload) => {
      return this.handleChangeFeatures(payload)
    })
  }

  // ── IPC handlers ──────────────────────────────────────────────────────────

  private async handleInstallModpack(payload: InstallModpackPayload): Promise<void> {
    // Busy guard — reject at handler level so the IPC rejection reaches the renderer
    if (this.currentAbort) {
      throw new Error('Eine Installation laeuft bereits')
    }

    const { reference, selectedFeatures } = payload

    // 1. Fetch full manifest
    const manifestUrl = fmt(Constants.packManifest, reference.location)
    logger.info(`[InstallService] Install requested: ${reference.name} v${reference.version} (MC ${reference.gameVersion})`)
    const manifestRes = await fetch(manifestUrl, {
      signal: AbortSignal.timeout(Constants.connectTimeoutMs),
    })
    if (!manifestRes.ok) {
      throw new Error(`Failed to fetch manifest: ${manifestRes.status} ${manifestRes.statusText}`)
    }
    const manifest: ModpackManifest = await manifestRes.json() as ModpackManifest

    // 2. Feature gate — if pack has features and no selection provided, ask renderer
    if (manifest.features && manifest.features.length > 0 && !selectedFeatures) {
      logger.info(`[InstallService] Awaiting feature selection for ${manifest.name} (${manifest.features.length} feature(s))`)
      const event: InstallNeedsFeaturesEvent = { features: manifest.features }
      pushEvent(IpcChannels.INSTALL_NEEDS_FEATURES, event)
      return
    }

    const features = selectedFeatures ?? []

    // 3. Kick off the actual install in the background so the IPC handle returns
    //    quickly (progress is pushed via events).
    this.runInstall(manifest, features).catch((err: unknown) => {
      logger.error('[InstallService] Unhandled install error:', err)
    })
  }

  private handleInstallCancel(): void {
    if (this.currentAbort) {
      this.currentAbort.abort()
      this.currentAbort = null
    }
  }

  private async handleGetPackFeatures(packName: string): Promise<PackFeaturesResult> {
    const manifest = await this.getManifestByName(packName)
    if (!manifest) {
      throw new Error(`Manifest fuer "${packName}" nicht gefunden`)
    }
    if (!manifest.features || manifest.features.length === 0) {
      throw new Error(`Pack "${packName}" hat keine optionalen Features`)
    }
    const instancesDir = await configService.getSaveSubDir('instances')
    const instanceDir = path.join(instancesDir, packName)
    const selected = await readSelectedFeatures(instanceDir, manifest)
    return { features: manifest.features, selected }
  }

  private async handleChangeFeatures(payload: ChangeFeaturesPayload): Promise<void> {
    // Busy guard — reject at handler level so the IPC rejection reaches the renderer
    if (this.currentAbort) {
      throw new Error('Eine Installation laeuft bereits')
    }

    const { packName, selectedFeatures } = payload
    logger.info(`[InstallService] Feature change requested for "${packName}" with features: [${selectedFeatures.join(', ')}]`)

    this.runChangeFeatures(packName, selectedFeatures).catch((err: unknown) => {
      logger.error('[InstallService] Unhandled feature change error:', err)
    })
  }

  // ── Install flow ──────────────────────────────────────────────────────────

  private async runInstall(manifest: ModpackManifest, selectedFeatures: string[]): Promise<void> {
    // Defensive: callers must check the busy guard, but abort a stale controller if one slipped through
    if (this.currentAbort) {
      this.currentAbort.abort()
    }
    const abort = new AbortController()
    setMaxListeners(0, abort.signal)
    this.currentAbort = abort
    const { signal } = abort

    const featuresStr = selectedFeatures.length > 0 ? selectedFeatures.join(', ') : 'none'
    logger.info(`[InstallService] Starting install: ${manifest.name} v${manifest.version} | MC ${manifest.gameVersion} | features: [${featuresStr}]`)

    try {
      await this.doInstall(manifest, selectedFeatures, signal)
      logger.info(`[InstallService] Install complete: ${manifest.name} v${manifest.version}`)
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        logger.info(`[InstallService] Install cancelled: ${manifest.name}`)
        const complete: InstallCompleteEvent = { success: false, error: 'Installation abgebrochen' }
        pushEvent(IpcChannels.INSTALL_COMPLETE, complete)
      } else {
        logger.error('[InstallService] Install failed:', err)
        const complete: InstallCompleteEvent = { success: false, error: formatInstallError(err) }
        pushEvent(IpcChannels.INSTALL_COMPLETE, complete)
      }
    } finally {
      if (this.currentAbort === abort) {
        this.currentAbort = null
      }
    }
  }

  private async doInstall(
    manifest: ModpackManifest,
    selectedFeatures: string[],
    signal: AbortSignal,
  ): Promise<void> {
    // ── a. Prepare instance directory ────────────────────────────────────────
    const instancesDir = await configService.getSaveSubDir('instances')
    const instanceDir = path.join(instancesDir, manifest.name)
    await fs.mkdir(instanceDir, { recursive: true })

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

    // ── f. Download modpack file tasks ────────────────────────────────────────
    const tasks = (manifest.tasks ?? []).filter((task) =>
      evaluateCondition(task.when, selectedFeatures),
    )

    const total = tasks.length
    let finished = 0
    let failed = 0

    logger.info(`[InstallService] Downloading ${total} modpack file(s)...`)

    // Also read old manifest to clean up removed files
    const manifestFilePath = path.join(instanceDir, 'manifest.json')
    let oldManifest: ModpackManifest | null = null
    try {
      const raw = await fs.readFile(manifestFilePath, 'utf8')
      oldManifest = JSON.parse(raw) as ModpackManifest
    } catch {
      // No previous manifest — first install
    }

    const isUpdate = oldManifest !== null
    logger.info(
      `[InstallService] ${isUpdate ? `Updating ${manifest.name} (${oldManifest!.version} -> ${manifest.version})` : `First install of ${manifest.name} v${manifest.version}`} - ${tasks.length} file(s)`,
    )

    pushEvent(IpcChannels.INSTALL_PROGRESS, {
      total,
      finished,
      failed,
      currentFile: undefined,
    } satisfies InstallProgressEvent)

    // Download concurrently with a small concurrency cap
    const CONCURRENCY = 8
    let queueIndex = 0

    const downloadWorker = async (): Promise<void> => {
      while (queueIndex < tasks.length) {
        const task = tasks[queueIndex++]

        signal.throwIfAborted()

        const url = task.location.startsWith('http')
          ? task.location
          : fmt(Constants.launcherObjects, task.location)

        const targetPath = path.resolve(instanceDir, task.to)

        if (!isPathWithinDir(instanceDir, task.to)) {
          throw new Error(`Pack manifest contains unsafe file path: ${task.to}`)
        }

        // Skip user files that already exist on disk
        if (task.userFile) {
          try {
            await fs.access(targetPath)
            finished++
            pushEvent(IpcChannels.INSTALL_PROGRESS, {
              total,
              finished,
              failed,
              currentFile: task.to,
            } satisfies InstallProgressEvent)
            continue
          } catch {
            // File does not exist — fall through and download it
          }
        }

        try {
          await fs.mkdir(path.dirname(targetPath), { recursive: true })
          const res = await fetchWithRetry(url, { signal })
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
          }
          const { stream: hasher, digest } = createHashingStream(detectHashAlgorithm(task.hash))
          const fileHandle = await fs.open(targetPath, 'w')
          try {
            await pipeline(
              Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
              hasher,
              fileHandle.createWriteStream(),
            )
          } finally {
            await fileHandle.close()
          }
          if (task.hash) {
            const actualHash = digest()
            if (actualHash !== task.hash) {
              await fs.unlink(targetPath).catch(() => {})
              throw new Error(`Hash mismatch for ${task.to}: expected ${task.hash}, got ${actualHash}`)
            }
          }
          finished++
        } catch (err: unknown) {
          if ((err as Error).name === 'AbortError') throw err
          logger.warn(`[InstallService] Failed to download ${url}:`, err)
          failed++
        }

        pushEvent(IpcChannels.INSTALL_PROGRESS, {
          total,
          finished,
          failed,
          currentFile: task.to,
        } satisfies InstallProgressEvent)
      }
    }

    const workers: Promise<void>[] = []
    for (let i = 0; i < Math.min(CONCURRENCY, tasks.length); i++) {
      workers.push(downloadWorker())
    }
    await Promise.all(workers)

    logger.info(`[InstallService] File downloads done: ${finished}/${total} succeeded, ${failed} failed`)

    signal.throwIfAborted()

    // Remove files from old manifest that are no longer present in the current one.
    // When selectedFeatures is empty (auto-update), skip old tasks that have a
    // feature condition to avoid deleting the user's previously selected feature files.
    if (oldManifest?.tasks) {
      const currentToPaths = new Set(tasks.map((t) => t.to))
      const isAutoUpdate = selectedFeatures.length === 0
      let staleCount = 0
      for (const oldTask of oldManifest.tasks) {
        if (isAutoUpdate && oldTask.when) continue
        if (!currentToPaths.has(oldTask.to)) {
          const stale = path.join(instanceDir, oldTask.to)
          await fs.unlink(stale).catch(() => {
            // Ignore — file may already be gone
          })
          staleCount++
        }
      }
      if (staleCount > 0) {
        logger.info(`[InstallService] Removed ${staleCount} stale file(s) from previous version`)
      }
    }

    // ── f. Save manifest ──────────────────────────────────────────────────────
    // CodeQL[js/http-to-file-access]: pack manifest from trusted packs.myftb.de, intentionally persisted to track installed state
    await fs.writeFile(manifestFilePath, JSON.stringify(manifest, null, 2), 'utf8')

    // Persist user's feature selection for post-install reconfiguration
    await writeSelectedFeatures(instanceDir, selectedFeatures)

    signal.throwIfAborted()

    // ── Complete ──────────────────────────────────────────────────────────────
    const success = failed === 0
    const complete: InstallCompleteEvent = { success, error: success ? undefined : `${failed} Datei(en) konnten nicht heruntergeladen werden` }
    pushEvent(IpcChannels.INSTALL_COMPLETE, complete)
  }

  // ── Feature change flow ──────────────────────────────────────────────────

  private async runChangeFeatures(packName: string, newSelection: string[]): Promise<void> {
    const abort = new AbortController()
    setMaxListeners(0, abort.signal)
    this.currentAbort = abort
    const { signal } = abort

    try {
      // 1. Read manifest
      const manifest = await this.getManifestByName(packName)
      if (!manifest) {
        const result: ChangeFeaturesResult = { success: false, error: `Manifest fuer "${packName}" nicht gefunden` }
        pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE, result)
        return
      }

      const instancesDir = await configService.getSaveSubDir('instances')
      const instanceDir = path.join(instancesDir, packName)

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
        return
      }

      // 4. Download new files
      const total = toDownload.length + toDelete.length
      let finished = 0
      let failed = 0

      pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_PROGRESS, {
        total,
        finished,
        failed,
        currentFile: undefined,
      } satisfies InstallProgressEvent)

      const CONCURRENCY = 8
      let queueIndex = 0

      const downloadWorker = async (): Promise<void> => {
        while (queueIndex < toDownload.length) {
          const task = toDownload[queueIndex++]

          signal.throwIfAborted()

          const url = task.location.startsWith('http')
            ? task.location
            : fmt(Constants.launcherObjects, task.location)

          const targetPath = path.resolve(instanceDir, task.to)

          if (!isPathWithinDir(instanceDir, task.to)) {
            throw new Error(`Pack manifest contains unsafe file path: ${task.to}`)
          }

          try {
            await fs.mkdir(path.dirname(targetPath), { recursive: true })
            const res = await fetchWithRetry(url, { signal })
            if (!res.ok) {
              throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
            }
            const { stream: hasher, digest } = createHashingStream(detectHashAlgorithm(task.hash))
            const fileHandle = await fs.open(targetPath, 'w')
            try {
              await pipeline(
                Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
                hasher,
                fileHandle.createWriteStream(),
              )
            } finally {
              await fileHandle.close()
            }
            if (task.hash) {
              const actualHash = digest()
              if (actualHash !== task.hash) {
                await fs.unlink(targetPath).catch(() => {})
                throw new Error(`Hash mismatch for ${task.to}: expected ${task.hash}, got ${actualHash}`)
              }
            }
            finished++
          } catch (err: unknown) {
            if ((err as Error).name === 'AbortError') throw err
            logger.warn(`[InstallService] Feature change: failed to download ${url}:`, err)
            failed++
          }

          pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_PROGRESS, {
            total,
            finished,
            failed,
            currentFile: task.to,
          } satisfies InstallProgressEvent)
        }
      }

      const workers: Promise<void>[] = []
      for (let i = 0; i < Math.min(CONCURRENCY, toDownload.length); i++) {
        workers.push(downloadWorker())
      }
      await Promise.all(workers)

      signal.throwIfAborted()

      // 5. Partial-failure check: if any downloads failed, preserve old state
      if (failed > 0) {
        logger.warn(`[InstallService] Feature change for "${packName}" had ${failed} failed download(s) - preserving old selection`)
        await writeSelectedFeatures(instanceDir, oldSelection)
        const result: ChangeFeaturesResult = { success: false, error: `${failed} Datei(en) konnten nicht heruntergeladen werden` }
        pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE, result)
        return
      }

      // 6. Delete deselected files (only after all downloads succeeded)
      for (const task of toDelete) {
        signal.throwIfAborted()
        const targetPath = path.resolve(instanceDir, task.to)
        if (isPathWithinDir(instanceDir, task.to)) {
          await fs.unlink(targetPath).catch(() => {
            // File may already be gone
          })
          finished++
          pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_PROGRESS, {
            total,
            finished,
            failed,
            currentFile: task.to,
          } satisfies InstallProgressEvent)
        }
      }

      // 7. Persist new selection
      await writeSelectedFeatures(instanceDir, newSelection)
      logger.info(`[InstallService] Feature change complete for "${packName}"`)
      const result: ChangeFeaturesResult = { success: true }
      pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE, result)
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        logger.info(`[InstallService] Feature change cancelled for "${packName}"`)
        const result: ChangeFeaturesResult = { success: false, error: 'Vorgang abgebrochen' }
        pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE, result)
      } else {
        logger.error(`[InstallService] Feature change failed for "${packName}":`, err)
        const result: ChangeFeaturesResult = { success: false, error: formatInstallError(err) }
        pushEvent(IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE, result)
      }
    } finally {
      if (this.currentAbort === abort) {
        this.currentAbort = null
      }
    }
  }

  // ── Public install API ────────────────────────────────────────────────────

  /**
   * Fetch a pack manifest and run the full install, awaiting completion.
   * Used for silent auto-updates triggered at launch time.
   * Returns true on success, false on failure.
   */
  async installModpack(reference: ModpackManifestReference): Promise<boolean> {
    // Busy guard — auto-update skips gracefully when another operation is running
    if (this.currentAbort) {
      logger.warn(`[InstallService] Auto-update skipped for "${reference.name}" - another install is in progress`)
      return false
    }

    const manifestUrl = fmt(Constants.packManifest, reference.location)
    logger.info(`[InstallService] Auto-update install started: ${reference.name} v${reference.version}`)
    let manifestRes: Response
    try {
      manifestRes = await fetch(manifestUrl, { signal: AbortSignal.timeout(Constants.connectTimeoutMs) })
    } catch (err) {
      logger.error(`[InstallService] Auto-update manifest fetch failed for "${reference.name}":`, err)
      return false
    }
    if (!manifestRes.ok) {
      logger.error(`[InstallService] Auto-update manifest returned ${manifestRes.status} for "${reference.name}"`)
      return false
    }
    const manifest: ModpackManifest = await manifestRes.json() as ModpackManifest
    try {
      // Read the user's saved feature selection so auto-update preserves it
      const instancesDir = await configService.getSaveSubDir('instances')
      const instanceDir = path.join(instancesDir, manifest.name)
      const savedFeatures = await readSelectedFeatures(instanceDir, manifest)
      await this.runInstall(manifest, savedFeatures)
      logger.info(`[InstallService] Auto-update complete: ${reference.name} v${reference.version}`)
      return true
    } catch (err) {
      logger.error(`[InstallService] Auto-update failed for "${reference.name}":`, err)
      return false
    }
  }

  // ── Public query API ──────────────────────────────────────────────────────

  /**
   * Scan the instances directory and return all installed pack manifests.
   */
  async getInstalledPacks(): Promise<ModpackManifest[]> {
    const instancesDir = await configService.getSaveSubDir('instances')
    let entries: string[]
    try {
      entries = await fs.readdir(instancesDir)
    } catch {
      return []
    }

    const manifests: ModpackManifest[] = []
    for (const entry of entries) {
      const manifestPath = path.join(instancesDir, entry, 'manifest.json')
      try {
        const raw = await fs.readFile(manifestPath, 'utf8')
        const parsed = JSON.parse(raw) as ModpackManifest
        manifests.push(parsed)
      } catch {
        // Not a valid instance directory — skip
      }
    }

    return manifests
  }

  /**
   * Read and return the manifest for a specific installed pack by name.
   * Returns `null` when not found or not readable.
   */
  async getManifestByName(name: string): Promise<ModpackManifest | null> {
    const instancesDir = await configService.getSaveSubDir('instances')
    const manifestPath = path.join(instancesDir, name, 'manifest.json')
    try {
      const raw = await fs.readFile(manifestPath, 'utf8')
      return JSON.parse(raw) as ModpackManifest
    } catch {
      return null
    }
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const installService = new InstallService()
