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
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { app } from 'electron'

import { Constants, fmt } from '../constants'
import { logger } from '../logger'
import type { ModpackManifest, InstallProgressEvent } from '../../shared/types'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape of the custom JRE index JSON at launcher.myftb.de/{runtime}.json */
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

/**
 * Returns the java[w.exe] binary path for a cached runtime, or null if not
 * yet downloaded.
 */
async function getCachedRuntimeBin(runtimeName: string): Promise<string | null> {
  const bin = process.platform === 'win32' ? 'javaw.exe' : 'java'
  const binPath = path.join(getRuntimesRoot(), runtimeName, 'bin', bin)
  try {
    await fs.access(binPath)
    return binPath
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
  const effectiveRuntime = manifest.runtime ?? inferRuntime(manifest.gameVersion)

  // Skip if already cached
  const cached = await getCachedRuntimeBin(effectiveRuntime)
  if (cached) {
    logger.info(`[JavaService] Runtime '${effectiveRuntime}' already cached, skipping download`)
    return { total, finished, failed }
  }

  const platform = getRuntimePlatform()
  const arch = getRuntimeArchSuffix()
  const runtimeIndexName = `${effectiveRuntime}-${platform}${arch}`
  const runtimeIndexUrl = fmt(Constants.runtimeIndex, runtimeIndexName)

  onProgress({ total, finished, failed, currentFile: 'JRE-Index wird geladen...' })

  const indexRes = await fetch(runtimeIndexUrl, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(Constants.connectTimeoutMs)]),
  })
  if (!indexRes.ok) {
    throw new Error(
      `Failed to fetch runtime index "${runtimeIndexName}": ` +
        `${indexRes.status} ${indexRes.statusText}`,
    )
  }
  const runtimeIndex = (await indexRes.json()) as RuntimeIndex

  const runtimeDir = path.join(getRuntimesRoot(), effectiveRuntime)
  await fs.mkdir(runtimeDir, { recursive: true })

  const objects = runtimeIndex.objects
  total += objects.length
  logger.info(`[JavaService] Downloading runtime '${effectiveRuntime}': ${objects.length} file(s)...`)

  onProgress({ total, finished, failed, currentFile: 'JRE wird installiert...' })

  for (const obj of objects) {
    signal.throwIfAborted()

    const dest = path.join(runtimeDir, obj.path)
    await fs.mkdir(path.dirname(dest), { recursive: true })

    try {
      const res = await fetch(obj.url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(Constants.socketTimeoutMs)]),
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${obj.url}`)
      }
      const fileHandle = await fs.open(dest, 'w')
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
      logger.warn(`[JavaService] Failed to download JRE file ${obj.path}:`, err)
      failed++
    }

    onProgress({ total, finished, failed, currentFile: obj.path })
  }

  // Make java binary executable on POSIX
  if (process.platform !== 'win32') {
    const javaBin = path.join(runtimeDir, 'bin', 'java')
    await fs.chmod(javaBin, 0o755).catch(() => {
      // Best-effort — binary path may differ across runtime distributions
    })
  }

  return { total, finished, failed }
}
