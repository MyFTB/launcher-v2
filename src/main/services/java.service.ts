// ============================================================
// MyFTB Launcher v2 — Java Service
// Handles Java version detection, system Java discovery,
// and bundled JRE downloads for the Minecraft launcher.
//
// Runtime identifiers on launcher.myftb.de:
//   Java 8  → "jre"        e.g. jre-windows-x64.json
//   Java 17 → "temurin_17" e.g. temurin_17-windows-x64.json
//   Java 21 → "temurin_21" e.g. temurin_21-windows-x64.json
//
// Platform tokens : windows | linux | macosx
// Arch suffix     : -x64 (64-bit) | "" (32-bit Windows only)
//
// All downloaded runtimes are cached globally in:
//   {userData}/runtimes/{runtimeName}/
// and shared across all modpack instances.
// ============================================================

import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'

import { Constants, fmt } from '../constants'
import { logger } from '../logger'
import type { ModpackManifest, InstallProgressEvent } from '../../shared/types'
import { assertSafeRelativePath, requireHttpsUrl, ValidationError } from '../../shared/validation'
import { fetchWithRetry, detectHashAlgorithm, readJsonResponseLimited } from '../fetch-retry'
import { downloadFile, isStrongHash, normalizeHash } from '../download-manager'
import { assertContainedNoLinks, assertSafeDownloadDestination } from '../filesystem-safety'
import { atomicWriteFile } from './config.service'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape of the custom JRE index JSON at launcher.myftb.de/{runtime}.json */
const execFileAsync = promisify(execFile)

interface RuntimeIndex {
  objects: Array<{
    path: string
    url: string
    hash: string
  }>
}

export interface EnsureRuntimeCounters {
  total: number
  finished: number
  failed: number
}

// ─── Pure helpers (testable without Electron) ─────────────────────────────────

/**
 * Maps a Minecraft version string to the minimum required Java major version.
 *
 *   MC < 1.17        → 8   (LaunchWrapper / old Forge require Java 8)
 *   MC 1.17 – 1.20.x → 17
 *   MC 1.21+         → 21
 */
export function requiresJavaMajor(gameVersion: string): 8 | 17 | 21 {
  const parts = gameVersion.split('.')
  const minor = parseInt(parts[1] ?? '0', 10)
  if (minor >= 21) return 21
  if (minor >= 17) return 17
  return 8
}

/**
 * Maps a Java major version to the runtime index name prefix used on
 * launcher.myftb.de. Result is combined with platform + arch to form
 * the full index name, e.g. "jre-windows-x64".
 */
export function runtimeNameForMajor(major: 8 | 17 | 21): string {
  if (major === 8) return 'jre'
  if (major === 17) return 'temurin_17'
  return 'temurin_21'
}

/**
 * Infers the runtime index name prefix from a Minecraft version string.
 * Used when manifest.runtime is absent (old packs that predate the field).
 */
export function inferRuntime(gameVersion: string): string {
  return runtimeNameForMajor(requiresJavaMajor(gameVersion))
}

/**
 * Returns the platform token used in runtime index names.
 * Note: macOS is "macosx", not "osx".
 */
export function getRuntimePlatform(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'macosx'
    default:
      return 'linux'
  }
}

/**
 * Returns the architecture suffix used in runtime index names.
 * 64-bit → '-x64'; 32-bit → '' (32-bit exists for Windows only).
 */
export function getRuntimeArchSuffix(): string {
  return process.arch.includes('64') ? '-x64' : ''
}

/**
 * Heuristically checks whether a JAVA_HOME path matches the required
 * Java major version by looking for the version number in the directory name.
 *
 * Examples that match major=8  : zulu-8, jdk1.8, jre8, java-8-openjdk
 * Examples that match major=17 : zulu-17, jdk-17, temurin-17, java-17
 * Examples that FAIL            : zulu-21 when required=8
 */
export function javaHomeMatchesRequired(javaHome: string, required: 8 | 17 | 21): boolean {
  const dir = path.basename(javaHome).toLowerCase()
  // Java 8 uses "1.8" convention as well as bare "8" after a separator
  if (required === 8) {
    return /(^|[-_.])8([-._]|$)|\bjre?8\b|\bjdk8\b/.test(dir)
  }
  // Use a static pattern per version to avoid dynamic RegExp construction
  const VERSION_PATTERNS: Record<17 | 21, RegExp> = { 17: /\b17\b/, 21: /\b21\b/ }
  return VERSION_PATTERNS[required].test(dir)
}

// ─── System Java discovery ────────────────────────────────────────────────────

/**
 * Scan a parent directory for Java installations matching a name prefix.
 * Returns absolute paths to java[.exe] binaries sorted newest-first
 * (by descending directory name – works for versioned dir names like zulu-8.44).
 */
export async function scanJavaDir(
  parent: string,
  prefix: string,
  /** Relative path from the installation root to the java binary dir */
  subPath: string,
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(parent)
  } catch {
    return []
  }

  const bin = process.platform === 'win32' ? 'java.exe' : 'java'
  const results: string[] = []

  for (const entry of entries.sort().reverse()) {
    if (!entry.toLowerCase().startsWith(prefix.toLowerCase())) continue
    const javaBin = path.join(parent, entry, subPath, bin)
    try {
      await fs.access(javaBin)
      results.push(path.join(parent, entry))
    } catch {
      // Not accessible — skip
    }
  }
  return results
}

/** Collect candidate Java installation roots for the required major version. */
async function collectSystemJavaCandidates(required: 8 | 17 | 21): Promise<string[]> {
  const candidates: string[] = []
  const version = String(required)

  if (process.platform === 'win32') {
    const roots = [
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\BellSoft\\LibericaJRE',
      'C:\\Program Files\\Java',
    ]
    for (const root of roots) {
      const dirs = await scanJavaDir(root, '', path.join('bin'))
      for (const dir of dirs) {
        if (javaHomeMatchesRequired(dir, required)) {
          candidates.push(dir)
        }
      }
    }
  } else if (process.platform === 'darwin') {
    const roots = [
      '/Library/Java/JavaVirtualMachines',
      `${process.env.HOME}/Library/Java/JavaVirtualMachines`,
    ]
    for (const root of roots) {
      const dirs = await scanJavaDir(root, '', path.join('Contents', 'Home', 'bin'))
      for (const dir of dirs) {
        const home = path.join(dir, 'Contents', 'Home')
        if (javaHomeMatchesRequired(dir, required)) {
          candidates.push(home)
        }
      }
    }
  } else {
    // Linux
    const roots = [
      '/usr/lib/jvm',
      '/usr/java',
      '/opt/java',
      '/opt/jdk',
    ]
    for (const root of roots) {
      const dirs = await scanJavaDir(root, `java-${version}`, path.join('bin'))
      candidates.push(...dirs)
      const dirs2 = await scanJavaDir(root, `jre-${version}`, path.join('bin'))
      candidates.push(...dirs2)
      const dirs3 = await scanJavaDir(root, `temurin-${version}`, path.join('bin'))
      candidates.push(...dirs3)
      const dirs4 = await scanJavaDir(root, `zulu-${version}`, path.join('bin'))
      candidates.push(...dirs4)
    }
  }

  return candidates
}

/** Try to find a system Java installation for the required major version. */
export async function findSystemJava(required: 8 | 17 | 21): Promise<string | null> {
  const candidates = await collectSystemJavaCandidates(required)
  if (candidates.length > 0) {
    const bin = process.platform === 'win32' ? 'javaw.exe' : 'java'
    return path.join(candidates[0], 'bin', bin)
  }
  return null
}

// ─── Runtime directory helpers ────────────────────────────────────────────────

/**
 * Root directory where downloaded runtimes are cached globally.
 * Structure: {userData}/runtimes/{runtimeName}/
 */
function getRuntimesRoot(): string {
  return path.join(app.getPath('userData'), 'runtimes')
}

/** Marker file written after a JRE runtime downloads completely. */
const RUNTIME_COMPLETE_MARKER = '.complete'

async function recoverRuntimeArtifacts(runtimeName: string): Promise<void> {
  validateRuntimeName(runtimeName)
  const root = getRuntimesRoot()
  await fs.mkdir(root, { recursive: true })
  const rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ValidationError('Der JRE-Stammordner ist kein sicherer Ordner.')
  }
  const runtimeDir = path.join(root, runtimeName)
  const prefix = `${runtimeName}.rollback-`
  const candidates = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => path.join(root, entry.name))
  let runtimeExists = false
  try {
    const stat = await fs.lstat(runtimeDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ValidationError('Der JRE-Laufzeitpfad ist kein sicherer Ordner.')
    }
    runtimeExists = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!runtimeExists) {
    for (const candidate of candidates) {
      const stat = await fs.lstat(candidate).catch(() => null)
      if (!stat?.isDirectory() || stat.isSymbolicLink()) continue
      try {
        await fs.rename(candidate, runtimeDir)
        runtimeExists = true
        break
      } catch {
        // Try another valid rollback generation.
      }
    }
  }
  if (runtimeExists) {
    await Promise.all(candidates.map((candidate) => fs.rm(candidate, { recursive: true, force: true }).catch(() => {})))
  }
}

/**
 * Returns the java[w.exe] binary path for a cached runtime, or null if not
 * yet downloaded or if the previous download was incomplete.
 */
async function getCachedRuntimeBin(runtimeName: string): Promise<string | null> {
  await recoverRuntimeArtifacts(runtimeName)
  const runtimeDir = path.join(getRuntimesRoot(), runtimeName)
  const bin = process.platform === 'win32' ? 'javaw.exe' : 'java'
  const binPath = path.join(runtimeDir, 'bin', bin)
  try {
    const marker = JSON.parse(await fs.readFile(path.join(runtimeDir, RUNTIME_COMPLETE_MARKER), 'utf8')) as unknown
    if (
      typeof marker !== 'object'
      || marker === null
      || (marker as { version?: unknown }).version !== 1
      || (marker as { runtime?: unknown }).runtime !== runtimeName
    ) return null
    const stat = await fs.stat(binPath)
    return stat.isFile() && stat.size > 0 ? binPath : null
  } catch {
    return null
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve the java binary to use for launching a pack.
 *
 * Priority:
 *   1. Cached bundled runtime for the effective runtime name
 *      (manifest.runtime if set, else inferred from game version)
 *   2. System Java installation matching the required version
 *   3. JAVA_HOME if it matches the required version (with warning)
 *   4. JAVA_HOME regardless (with warning — may crash)
 *   5. Bare "java" / "java.exe" on PATH (last resort, with warning)
 */
export async function resolveJavaPath(manifest: ModpackManifest): Promise<string> {
  const required = requiresJavaMajor(manifest.gameVersion)
  const effectiveRuntime = manifest.runtime ?? inferRuntime(manifest.gameVersion)

  // 1. Cached bundled runtime
  const cached = await getCachedRuntimeBin(effectiveRuntime)
  if (cached) {
    return cached
  }

  // 2. System installation (directory scan)
  const systemJava = await findSystemJava(required)
  if (systemJava) {
    return systemJava
  }

  // 3-4. JAVA_HOME fallback
  if (process.env.JAVA_HOME) {
    const bin = process.platform === 'win32' ? 'java.exe' : 'java'
    const javaHomeBin = path.join(process.env.JAVA_HOME, 'bin', bin)
    if (javaHomeMatchesRequired(process.env.JAVA_HOME, required)) {
      logger.warn(
        `[JavaService] No bundled runtime found; using JAVA_HOME (${process.env.JAVA_HOME})`,
      )
      return javaHomeBin
    }
    logger.warn(
      `[JavaService] JAVA_HOME does not match required Java ${required}. ` +
        `Minecraft may crash. JAVA_HOME=${process.env.JAVA_HOME}`,
    )
    return javaHomeBin
  }

  // 5. Bare PATH fallback
  logger.warn(
    `[JavaService] No Java ${required} found. Falling back to system PATH. ` +
      `Minecraft will likely crash if the system Java major version is wrong.`,
  )
  return process.platform === 'win32' ? 'java.exe' : 'java'
}

const runtimeFlights = new Map<string, Promise<void>>()

async function runtimeFileMatches(filePath: string, expected: string): Promise<boolean> {
  try {
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

function validateRuntimeName(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value) || value === '.' || value === '..') {
    throw new ValidationError('Der Runtime-Name ist ungültig.')
  }
  return value
}

/**
 * Ensure the appropriate JRE is downloaded and ready.
 *
 * - If `manifest.runtime` is set, that name is used directly.
 * - If absent, the runtime is inferred from the Minecraft game version.
 * - Already-downloaded runtimes are skipped (cached in {userData}/runtimes/).
 *
 * Progress events are emitted via `onProgress`; pass `base` counters so the
 * caller can combine them with other install step totals.
 *
 * Returns the updated counters after download.
 */
export async function ensureRuntime(
  manifest: ModpackManifest,
  signal: AbortSignal,
  base: EnsureRuntimeCounters,
  onProgress: (event: InstallProgressEvent) => void,
): Promise<EnsureRuntimeCounters> {
  let { total, finished, failed } = base
  const effectiveRuntime = validateRuntimeName(manifest.runtime ?? inferRuntime(manifest.gameVersion))
  if (await getCachedRuntimeBin(effectiveRuntime)) return { total, finished, failed }

  const existing = runtimeFlights.get(effectiveRuntime)
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason ?? new DOMException('Abgebrochen', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
      existing.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
    return { total, finished, failed }
  }

  const operation = (async (): Promise<void> => {
    const runtimeIndexName = `${effectiveRuntime}-${getRuntimePlatform()}${getRuntimeArchSuffix()}`
    const runtimeIndexUrl = fmt(Constants.runtimeIndex, runtimeIndexName)
    onProgress({ total, finished, failed, currentFile: 'JRE-Index wird geladen...' })
    const indexResponse = await fetchWithRetry(runtimeIndexUrl, {
      signal,
      timeoutMs: Constants.connectTimeoutMs,
    })
    if (!indexResponse.ok) throw new Error(`JRE-Index konnte nicht geladen werden (HTTP ${indexResponse.status}).`)
    const rawIndex = await readJsonResponseLimited(indexResponse, 50 * 1024 * 1024) as RuntimeIndex
    if (!rawIndex || !Array.isArray(rawIndex.objects) || rawIndex.objects.length > 20_000) {
      throw new ValidationError('Der JRE-Index ist ungültig.')
    }

    const seen = new Set<string>()
    const objects = rawIndex.objects.map((object) => {
      const objectPath = assertSafeRelativePath(object.path, 'JRE-Objektpfad')
      if (seen.has(objectPath)) throw new ValidationError('Der JRE-Index enthält doppelte Objektpfade.')
      seen.add(objectPath)
      const hash = normalizeHash(object.hash)
      if (!/^[0-9a-f]+$/.test(hash) || !isStrongHash(hash)) {
        throw new ValidationError('Der JRE-Index enthält keine starke SHA-256/SHA-512-Prüfsumme.')
      }
      return {
        path: objectPath,
        url: requireHttpsUrl(object.url, 'JRE-Download'),
        hash,
      }
    })
    const indexDigest = crypto.createHash('sha256').update(JSON.stringify(objects)).digest('hex')
    total += objects.length
    onProgress({ total, finished, failed, currentFile: 'JRE wird installiert...' })

    const runtimesRoot = getRuntimesRoot()
    await fs.mkdir(runtimesRoot, { recursive: true })
    const runtimeDir = path.join(runtimesRoot, effectiveRuntime)
    const stagingDir = `${runtimeDir}.staging`
    const stagingStatePath = path.join(stagingDir, '.myftb-runtime-staging.json')
    await assertContainedNoLinks(runtimesRoot, stagingDir, { includeLeaf: true, label: 'JRE-Stagingpfad' })
    let reusableStaging = false
    try {
      const stagingStat = await fs.lstat(stagingDir)
      if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
        throw new ValidationError('Der JRE-Stagingpfad ist kein sicherer Ordner.')
      }
      const stateStat = await fs.lstat(stagingStatePath)
      if (!stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.size > 16 * 1024) {
        throw new Error('Invalid runtime staging state')
      }
      const state = JSON.parse(await fs.readFile(stagingStatePath, 'utf8')) as {
        version?: unknown
        indexDigest?: unknown
        createdAt?: unknown
      }
      reusableStaging = state.version === 1
        && state.indexDigest === indexDigest
        && typeof state.createdAt === 'number'
        && Date.now() - state.createdAt < 7 * 24 * 60 * 60 * 1_000
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`[JavaService] Discarding incompatible runtime staging for '${effectiveRuntime}'`)
      }
    }
    if (!reusableStaging) {
      await fs.rm(stagingDir, { recursive: true, force: true })
    }
    await fs.mkdir(stagingDir, { recursive: true })
    await assertContainedNoLinks(runtimesRoot, stagingDir, { includeLeaf: true, label: 'JRE-Stagingpfad' })
    if (!reusableStaging) {
      await atomicWriteFile(stagingStatePath, `${JSON.stringify({
        version: 1,
        indexDigest,
        createdAt: Date.now(),
      })}\n`)
    }

    let queueIndex = 0
    const failures: string[] = []
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = queueIndex++
        if (index >= objects.length) return
        const object = objects[index]
        signal.throwIfAborted()
        const destination = path.resolve(stagingDir, object.path)
        if (!destination.startsWith(path.resolve(stagingDir) + path.sep)) {
          throw new ValidationError('Ein JRE-Objekt verlässt den Stagingordner.')
        }
        await assertSafeDownloadDestination(runtimesRoot, destination, 'JRE-Objektpfad')
        try {
          if (!await runtimeFileMatches(destination, object.hash)) {
            await downloadFile({
              url: object.url,
              target: destination,
              hash: object.hash,
              signal,
              requireStrongHash: true,
              taskName: object.path,
            })
          }
          finished++
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error
          failed++
          failures.push(`${object.path}: ${error instanceof Error ? error.message : 'Download fehlgeschlagen'}`)
        }
        onProgress({ total, finished, failed, currentFile: object.path })
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, objects.length) }, () => worker()))
    if (failures.length) throw new Error(`${failures.length} JRE-Datei(en) konnten nicht sicher geladen werden.`)

    const javaBinary = path.join(stagingDir, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java')
    const validationBinary = path.join(stagingDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    for (const binary of new Set([javaBinary, validationBinary])) {
      const javaStat = await fs.stat(binary)
      if (!javaStat.isFile() || javaStat.size === 0) throw new Error('Die geladene JRE enthält keine gültige Java-Datei.')
      if (process.platform !== 'win32') await fs.chmod(binary, 0o755)
    }
    await execFileAsync(validationBinary, ['-version'], { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 })
    await fs.rm(stagingStatePath, { force: true })
    await atomicWriteFile(
      path.join(stagingDir, RUNTIME_COMPLETE_MARKER),
      `${JSON.stringify({ version: 1, runtime: effectiveRuntime, indexDigest })}\n`,
    )

    const backup = `${runtimeDir}.rollback-${process.pid}-${crypto.randomUUID()}`
    let hadPrevious = false
    try {
      try { await fs.rename(runtimeDir, backup); hadPrevious = true } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await fs.rename(stagingDir, runtimeDir)
      if (hadPrevious) await fs.rm(backup, { recursive: true, force: true })
    } catch (error) {
      if (hadPrevious) await fs.rename(backup, runtimeDir).catch(() => {})
      throw error
    }
    logger.info(`[JavaService] Runtime '${effectiveRuntime}' committed successfully`)
  })()

  runtimeFlights.set(effectiveRuntime, operation)
  try {
    await operation
    return { total, finished, failed }
  } finally {
    if (runtimeFlights.get(effectiveRuntime) === operation) runtimeFlights.delete(effectiveRuntime)
  }
}
