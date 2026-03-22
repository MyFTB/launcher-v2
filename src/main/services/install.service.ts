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

import { IpcChannels } from '../ipc/channels'
import { Constants, fmt } from '../constants'
import { configService } from './config.service'
import { getMainWindow } from '../app-state'
import { ensureRuntime, resolveJavaPath } from './java.service'
import type {
  ModpackManifestReference,
  ModpackManifest,
  FileTask,
  FeatureCondition,
  InstallProgressEvent,
  InstallCompleteEvent,
  InstallNeedsFeaturesEvent,
  InstallModpackPayload,
} from '../../shared/types'

// ─── Types ───────────────────────────────────────────────────────────────────

type ModLoader = 'forge' | 'neoforge' | 'fabric' | 'quilt' | 'vanilla'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Evaluate a FileTask `when` condition against the currently selected features.
 * Returns `true` when the file should be downloaded.
 */
function evaluateCondition(
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
      return packs.map((p) => ({ name: p.name, version: p.version }))
    })
  }

  // ── IPC handlers ──────────────────────────────────────────────────────────

  private async handleInstallModpack(payload: InstallModpackPayload): Promise<void> {
    const { reference, selectedFeatures } = payload

    // 1. Fetch full manifest
    const manifestUrl = fmt(Constants.packManifest, reference.location)
    const manifestRes = await fetch(manifestUrl, {
      signal: AbortSignal.timeout(Constants.connectTimeoutMs),
    })
    if (!manifestRes.ok) {
      throw new Error(`Failed to fetch manifest: ${manifestRes.status} ${manifestRes.statusText}`)
    }
    const manifest: ModpackManifest = await manifestRes.json() as ModpackManifest

    // 2. Feature gate — if pack has features and no selection provided, ask renderer
    if (manifest.features && manifest.features.length > 0 && !selectedFeatures) {
      const event: InstallNeedsFeaturesEvent = { features: manifest.features }
      pushEvent(IpcChannels.INSTALL_NEEDS_FEATURES, event)
      return
    }

    const features = selectedFeatures ?? []

    // 3. Kick off the actual install in the background so the IPC handle returns
    //    quickly (progress is pushed via events).
    this.runInstall(manifest, features).catch((err: unknown) => {
      console.error('[InstallService] Unhandled install error:', err)
    })
  }

  private handleInstallCancel(): void {
    if (this.currentAbort) {
      this.currentAbort.abort()
      this.currentAbort = null
    }
  }

  // ── Install flow ──────────────────────────────────────────────────────────

  private async runInstall(manifest: ModpackManifest, selectedFeatures: string[]): Promise<void> {
    // Abort any previous install
    if (this.currentAbort) {
      this.currentAbort.abort()
    }
    const abort = new AbortController()
    setMaxListeners(0, abort.signal)
    this.currentAbort = abort
    const { signal } = abort

    try {
      await this.doInstall(manifest, selectedFeatures, signal)
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        const complete: InstallCompleteEvent = { success: false, error: 'Installation cancelled' }
        pushEvent(IpcChannels.INSTALL_COMPLETE, complete)
      } else {
        console.error('[InstallService] Install failed:', err)
        const message = err instanceof Error
          ? (err.message || err.constructor.name || 'Unknown error')
          : String(err) || 'Unknown error'
        const complete: InstallCompleteEvent = { success: false, error: message }
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

    // ── c. Install base Minecraft ────────────────────────────────────────────
    const minecraftDir = configService.getInstallDir()

    pushEvent(IpcChannels.INSTALL_PROGRESS, {
      total: 0,
      finished: 0,
      failed: 0,
      currentFile: `Fetching Minecraft version list…`,
    } satisfies InstallProgressEvent)

    signal.throwIfAborted()

    const versionList = await getVersionList()
    const targetVersion = versionList.versions.find((v) => v.id === manifest.gameVersion)
    if (!targetVersion) {
      throw new Error(`Minecraft version ${manifest.gameVersion} not found in version manifest`)
    }

    pushEvent(IpcChannels.INSTALL_PROGRESS, {
      total: 0,
      finished: 0,
      failed: 0,
      currentFile: `Installing Minecraft ${manifest.gameVersion}…`,
    } satisfies InstallProgressEvent)

    await installMinecraft(targetVersion, minecraftDir)

    signal.throwIfAborted()

    // ── d. Ensure JRE ────────────────────────────────────────────────────────
    // Must happen before the mod-loader install so that Java is available when
    // Forge / NeoForge post-processors run.
    pushEvent(IpcChannels.INSTALL_PROGRESS, {
      total: 0,
      finished: 0,
      failed: 0,
      currentFile: 'Preparing Java runtime…',
    } satisfies InstallProgressEvent)

    await ensureRuntime(
      manifest,
      signal,
      { total: 0, finished: 0, failed: 0 },
      (p) => pushEvent(IpcChannels.INSTALL_PROGRESS, p satisfies InstallProgressEvent),
    )

    signal.throwIfAborted()

    const javaPath = await resolveJavaPath(manifest)

    // ── e. Install mod loader ─────────────────────────────────────────────────
    if (loader === 'forge' && libraryName) {
      const forgeEntry = buildForgeEntry(manifest.gameVersion, libraryName)

      pushEvent(IpcChannels.INSTALL_PROGRESS, {
        total: 0,
        finished: 0,
        failed: 0,
        currentFile: `Installing Forge ${forgeEntry.version}…`,
      } satisfies InstallProgressEvent)

      await installForge(forgeEntry, minecraftDir, { java: javaPath })

      signal.throwIfAborted()
    } else if (loader === 'neoforge' && libraryName) {
      const neoforgeVersion = extractMavenVersion(libraryName)

      pushEvent(IpcChannels.INSTALL_PROGRESS, {
        total: 0,
        finished: 0,
        failed: 0,
        currentFile: `Installing NeoForge ${neoforgeVersion}…`,
      } satisfies InstallProgressEvent)

      await installNeoForged('neoforge', neoforgeVersion, minecraftDir, { java: javaPath })

      // installNeoForged creates the version JSON under the installer's own ID
      // (e.g. '1.21.1-neoforge-21.1.219'), but manifest.versionManifest.id may
      // use the short form (e.g. 'neoforge-21.1.219').  Write the pack's
      // versionManifest under its own ID so Version.parse and the launch service
      // can find it — same pattern as the Fabric handler below.
      const neoVersionId = manifest.versionManifest.id
      const neoVersionDir = path.join(minecraftDir, 'versions', neoVersionId)
      const neoVersionJsonPath = path.join(neoVersionDir, `${neoVersionId}.json`)
      const neoVersionJsonExists = await fs.access(neoVersionJsonPath).then(() => true).catch(() => false)
      if (!neoVersionJsonExists) {
        await fs.mkdir(neoVersionDir, { recursive: true })
        await fs.writeFile(neoVersionJsonPath, JSON.stringify(manifest.versionManifest), 'utf8')
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

      pushEvent(IpcChannels.INSTALL_PROGRESS, {
        total: 0,
        finished: 0,
        failed: 0,
        currentFile: `Installing ${loader === 'fabric' ? 'Fabric' : 'Quilt'} ${loaderVersion}…`,
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
      const versionJsonExists = await fs.access(versionJsonPath).then(() => true).catch(() => false)
      if (!versionJsonExists) {
        await fs.mkdir(versionDir, { recursive: true })
        await fs.writeFile(versionJsonPath, JSON.stringify(manifest.versionManifest), 'utf8')
      }

      signal.throwIfAborted()
    }

    // ── f. Install libraries + assets for the resolved version ────────────────
    // This covers Fabric/Quilt loader JARs and any libraries not yet on disk.
    // Forge/NeoForge handle their own libraries, but this is safe to run for all.
    pushEvent(IpcChannels.INSTALL_PROGRESS, {
      total: 0, finished: 0, failed: 0,
      currentFile: 'Installiere Bibliotheken…',
    } satisfies InstallProgressEvent)

    const resolvedVersion = await Version.parse(minecraftDir, manifest.versionManifest.id)
    await installResolvedLibraries(resolvedVersion.libraries, minecraftDir)
    await installAssets(resolvedVersion)

    signal.throwIfAborted()

    // ── f. Download modpack file tasks ────────────────────────────────────────
    const tasks = (manifest.tasks ?? []).filter((task) =>
      evaluateCondition(task.when, selectedFeatures),
    )

    let total = tasks.length
    let finished = 0
    let failed = 0

    // Also read old manifest to clean up removed files
    const manifestFilePath = path.join(instanceDir, 'manifest.json')
    let oldManifest: ModpackManifest | null = null
    try {
      const raw = await fs.readFile(manifestFilePath, 'utf8')
      oldManifest = JSON.parse(raw) as ModpackManifest
    } catch {
      // No previous manifest — first install
    }

    pushEvent(IpcChannels.INSTALL_PROGRESS, {
      total,
      finished,
      failed,
      currentFile: undefined,
    } satisfies InstallProgressEvent)

    // Download concurrently with a small concurrency cap
    const CONCURRENCY = 8
    const queue = [...tasks]

    async function downloadWorker(): Promise<void> {
      while (queue.length > 0) {
        const task = queue.shift()
        if (!task) break

        signal.throwIfAborted()

        const url = task.location.startsWith('http')
          ? task.location
          : fmt(Constants.launcherObjects, task.location)

        const targetPath = path.join(instanceDir, task.to)

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
          const res = await fetch(url, { signal })
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
          }
          const fileHandle = await fs.open(targetPath, 'w')
          try {
            await pipeline(
              Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
              fileHandle.createWriteStream(),
            )
          } finally {
            await fileHandle.close()
          }
          finished++
        } catch (err: unknown) {
          if ((err as Error).name === 'AbortError') throw err
          console.warn(`[InstallService] Failed to download ${url}:`, err)
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

    signal.throwIfAborted()

    // Remove files from old manifest that are no longer present in the current one
    if (oldManifest?.tasks) {
      const currentToPaths = new Set(tasks.map((t) => t.to))
      for (const oldTask of oldManifest.tasks) {
        if (!currentToPaths.has(oldTask.to)) {
          const stale = path.join(instanceDir, oldTask.to)
          await fs.unlink(stale).catch(() => {
            // Ignore — file may already be gone
          })
        }
      }
    }

    // ── f. Save manifest ──────────────────────────────────────────────────────
    await fs.writeFile(manifestFilePath, JSON.stringify(manifest, null, 2), 'utf8')

    signal.throwIfAborted()

    // ── Complete ──────────────────────────────────────────────────────────────
    const success = failed === 0
    const complete: InstallCompleteEvent = { success, error: success ? undefined : `${failed} file(s) failed to download` }
    pushEvent(IpcChannels.INSTALL_COMPLETE, complete)
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
