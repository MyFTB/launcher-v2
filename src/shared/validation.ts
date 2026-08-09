import path from 'node:path'

import {
  CONFIG_VERSION,
  type AuthProfileSummary,
  type AuthSwitchProfilePayload,
  type FileTask,
  type LauncherConfig,
  type ModpackManifest,
  type ModpackManifestReference,
  type PackConfig,
  type RendererConfigPatch,
  type UpdateChannel,
} from './types'

export class ValidationError extends Error {
  readonly code = 'INVALID_PAYLOAD' as const

  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export interface LegacyCredential {
  uuid: string
  minecraftAccessToken: string
  oauthRefreshToken: string
}

export interface ParsedLauncherConfig {
  config: LauncherConfig
  legacyCredentials: LegacyCredential[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PACK_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,127}$/u
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{128})$/i
const FORBIDDEN_JVM_ARGUMENTS = [
  /^@/,
  /^-javaagent(?::|=|$)/i,
  /^-agentlib(?::|=|$)/i,
  /^-agentpath(?::|=|$)/i,
  /^-xrun/i,
  /^-xbootclasspath(?::|=|\/|$)/i,
  /^-(?:cp|classpath)(?:=|$)/i,
  /^--(?:class-path|module-path|upgrade-module-path|patch-module)(?:=|$)/i,
  /^-d(?:java\.library\.path|java\.system\.class\.loader|org\.lwjgl\.librarypath|jna\.(?:boot\.)?library\.path|netty\.native\.workdir|sun\.boot\.library\.path)=/i,
  /^-xx:flags=/i,
  /^-xx:onerror=/i,
  /^-xx:onoutofmemoryerror=/i,
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value)
    : fallback
}

function boundedString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' && value.length <= maxLength ? value : fallback
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length <= maxLength)
    .slice(0, maxItems)
}

function stringRecord(value: unknown, maxEntries = 1_000): Record<string, string> {
  if (!isRecord(value)) return {}
  const entries = Object.entries(value)
    .filter(([key, entry]) => key.length <= 256 && typeof entry === 'string' && entry.length <= 8_192)
    .slice(0, maxEntries) as Array<[string, string]>
  return Object.fromEntries(entries)
}

function packConfigRecord(value: unknown): Record<string, PackConfig> {
  if (!isRecord(value)) return {}
  const output: Record<string, PackConfig> = {}
  for (const [packName, raw] of Object.entries(value).slice(0, 1_000)) {
    if (!isRecord(raw)) continue
    try {
      assertPackName(packName)
    } catch {
      continue
    }
    const item: PackConfig = {}
    if (raw.minMemory !== undefined) item.minMemory = finiteNumber(raw.minMemory, 2_048, 512, 262_144)
    if (raw.maxMemory !== undefined) item.maxMemory = finiteNumber(raw.maxMemory, 4_096, 512, 262_144)
    if (raw.jvmArgs !== undefined) item.jvmArgs = validateJvmArgumentString(raw.jvmArgs)
    output[packName] = item
  }
  return output
}

function validateRendererPackConfigs(value: unknown): Record<string, PackConfig> {
  if (!isRecord(value) || Object.keys(value).length > 1_000) {
    throw new ValidationError('Die Modpack-Einstellungen sind ungültig.')
  }
  const output: Record<string, PackConfig> = {}
  for (const [rawPackName, raw] of Object.entries(value)) {
    const packName = assertPackName(rawPackName)
    if (!isRecord(raw)) throw new ValidationError(`Die Einstellungen für „${packName}“ sind ungültig.`)
    const allowed = new Set(['minMemory', 'maxMemory', 'jvmArgs'])
    if (Object.keys(raw).some((key) => !allowed.has(key))) {
      throw new ValidationError(`Die Einstellungen für „${packName}“ enthalten unbekannte Felder.`)
    }
    const item: PackConfig = {}
    if ('minMemory' in raw) item.minMemory = requireNumber(raw.minMemory, 'minMemory', 512, 262_144)
    if ('maxMemory' in raw) item.maxMemory = requireNumber(raw.maxMemory, 'maxMemory', 512, 262_144)
    if ('jvmArgs' in raw) item.jvmArgs = validateJvmArgumentString(raw.jvmArgs)
    if (item.minMemory !== undefined && item.maxMemory !== undefined && item.minMemory > item.maxMemory) {
      throw new ValidationError(`Der minimale Arbeitsspeicher für „${packName}“ ist größer als der maximale.`)
    }
    output[packName] = item
  }
  return output
}

function parseProfile(value: unknown): AuthProfileSummary | null {
  if (!isRecord(value)) return null
  if (value.provider !== 'microsoft' || typeof value.uuid !== 'string' || !UUID_RE.test(value.uuid)) {
    return null
  }
  if (typeof value.lastKnownUsername !== 'string' || value.lastKnownUsername.length < 1 || value.lastKnownUsername.length > 64) {
    return null
  }
  return {
    provider: 'microsoft',
    uuid: value.uuid.toLowerCase(),
    lastKnownUsername: value.lastKnownUsername,
    ...(typeof value.minecraftTokenExpiresAt === 'number' && Number.isFinite(value.minecraftTokenExpiresAt)
      ? { minecraftTokenExpiresAt: value.minecraftTokenExpiresAt }
      : {}),
    ...(typeof value.lastAuthenticatedAt === 'number' && Number.isFinite(value.lastAuthenticatedAt)
      ? { lastAuthenticatedAt: value.lastAuthenticatedAt }
      : {}),
  }
}

/** Parse, validate, migrate, and strip unknown/sensitive fields from persisted config. */
export function parseLauncherConfig(value: unknown, defaults: LauncherConfig): ParsedLauncherConfig {
  if (!isRecord(value)) throw new ValidationError('config.json enthält kein gültiges Objekt.')
  if (
    value.version !== undefined
    && (!Number.isSafeInteger(value.version) || (value.version as number) < 1 || (value.version as number) > CONFIG_VERSION)
  ) {
    throw new ValidationError('config.json wurde von einer nicht unterstützten Launcher-Version erstellt.')
  }

  const rawProfileStore = isRecord(value.profileStore) ? value.profileStore : {}
  const rawProfiles = Array.isArray(rawProfileStore.profiles) ? rawProfileStore.profiles : []
  const profiles: AuthProfileSummary[] = []
  const legacyCredentials: LegacyCredential[] = []

  for (const raw of rawProfiles.slice(0, 50)) {
    const profile = parseProfile(raw)
    if (!profile || profiles.some((entry) => entry.uuid === profile.uuid)) continue
    profiles.push(profile)
    if (
      isRecord(raw)
      && typeof raw.minecraftAccessToken === 'string'
      && raw.minecraftAccessToken.length > 0
      && typeof raw.oauthRefreshToken === 'string'
      && raw.oauthRefreshToken.length > 0
    ) {
      legacyCredentials.push({
        uuid: profile.uuid,
        minecraftAccessToken: raw.minecraftAccessToken,
        oauthRefreshToken: raw.oauthRefreshToken,
      })
    }
  }

  const selectedCandidate = rawProfileStore.selectedProfileUuid
  const selected = typeof selectedCandidate === 'string'
    && profiles.some((profile) => profile.uuid === selectedCandidate.toLowerCase())
    ? selectedCandidate.toLowerCase()
    : profiles[0]?.uuid

  const channel: UpdateChannel = value.updateChannel === 'experimental' ? 'experimental' : 'stable'
  const installationDir = boundedString(value.installationDir, defaults.installationDir, 4_096)
  if (installationDir && !path.isAbsolute(installationDir)) {
    throw new ValidationError('Der konfigurierte Installationsordner muss ein absoluter Pfad sein.')
  }
  const config: LauncherConfig = {
    version: CONFIG_VERSION,
    clientToken: boundedString(value.clientToken, defaults.clientToken, 128),
    jvmArgs: validateJvmArgumentString(value.jvmArgs ?? defaults.jvmArgs),
    maxMemory: finiteNumber(value.maxMemory, defaults.maxMemory, 512, 262_144),
    minMemory: finiteNumber(value.minMemory, defaults.minMemory, 512, 262_144),
    gameWidth: finiteNumber(value.gameWidth, defaults.gameWidth, 640, 7_680),
    gameHeight: finiteNumber(value.gameHeight, defaults.gameHeight, 480, 4_320),
    packKey: boundedString(value.packKey, defaults.packKey, 4_096),
    installationDir,
    allowWebstart: typeof value.allowWebstart === 'boolean' ? value.allowWebstart : defaults.allowWebstart,
    lastPlayedPacks: stringArray(value.lastPlayedPacks, 3, 128).filter((name) => {
      try { assertPackName(name); return true } catch { return false }
    }),
    autoConfigs: stringRecord(value.autoConfigs),
    packConfigs: packConfigRecord(value.packConfigs),
    profileStore: { profiles, selectedProfileUuid: selected },
    updateChannel: channel,
  }

  if (config.minMemory > config.maxMemory) config.minMemory = config.maxMemory
  return { config, legacyCredentials }
}

export function validateRendererConfigPatch(value: unknown): RendererConfigPatch {
  if (!isRecord(value)) throw new ValidationError('Die Einstellungen sind ungültig.')
  const allowed = new Set([
    'jvmArgs', 'maxMemory', 'minMemory', 'gameWidth', 'gameHeight',
    'packKey', 'allowWebstart', 'packConfigs',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ValidationError(`Die Einstellung „${key}“ darf nicht geändert werden.`)
  }

  const patch: RendererConfigPatch = {}
  if ('jvmArgs' in value) patch.jvmArgs = validateJvmArgumentString(value.jvmArgs)
  if ('maxMemory' in value) patch.maxMemory = requireNumber(value.maxMemory, 'maxMemory', 512, 262_144)
  if ('minMemory' in value) patch.minMemory = requireNumber(value.minMemory, 'minMemory', 512, 262_144)
  if ('gameWidth' in value) patch.gameWidth = requireNumber(value.gameWidth, 'gameWidth', 640, 7_680)
  if ('gameHeight' in value) patch.gameHeight = requireNumber(value.gameHeight, 'gameHeight', 480, 4_320)
  if ('packKey' in value) patch.packKey = requireString(value.packKey, 'packKey', 4_096)
  if ('allowWebstart' in value) {
    if (typeof value.allowWebstart !== 'boolean') throw new ValidationError('allowWebstart muss ein Wahrheitswert sein.')
    patch.allowWebstart = value.allowWebstart
  }
  if ('packConfigs' in value) patch.packConfigs = validateRendererPackConfigs(value.packConfigs)
  if (patch.minMemory !== undefined && patch.maxMemory !== undefined && patch.minMemory > patch.maxMemory) {
    throw new ValidationError('Der minimale Arbeitsspeicher darf nicht größer als der maximale sein.')
  }
  return patch
}

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ValidationError(`${name} ist ungültig.`)
  }
  return value
}

function requireNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${name} liegt außerhalb des erlaubten Bereichs.`)
  }
  return Math.round(value)
}

export function assertUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ValidationError('Die Profil-ID ist ungültig.')
  }
  return value.toLowerCase()
}

export function validateAuthSwitchProfilePayload(value: unknown): AuthSwitchProfilePayload {
  if (!isRecord(value)) throw new ValidationError('Die Account-Auswahl ist ungültig.')
  return { uuid: assertUuid(value.uuid) }
}

export function assertSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) {
    throw new ValidationError('Die Sitzungs-ID ist ungültig.')
  }
  return value.toLowerCase()
}

export function assertUpdateChannel(value: unknown): UpdateChannel {
  if (value !== 'stable' && value !== 'experimental') {
    throw new ValidationError('Der Update-Kanal ist ungültig.')
  }
  return value
}

export function assertPackName(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('Der Modpack-Name ist ungültig.')
  const name = value.trim().normalize('NFC')
  if (!PACK_NAME_RE.test(name) || name === '.' || name === '..' || /[. ]$/.test(name)) {
    throw new ValidationError('Der Modpack-Name enthält unzulässige Zeichen.')
  }
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
  if (reserved.test(name)) throw new ValidationError('Der Modpack-Name ist auf diesem System reserviert.')
  return name
}

export function assertSafeRelativePath(value: unknown, label = 'Dateipfad'): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096 || value.includes('\0')) {
    throw new ValidationError(`${label} ist ungültig.`)
  }
  const normalized = value.replace(/\\/g, '/').normalize('NFC')
  const parts = normalized.split('/')
  if (
    path.posix.isAbsolute(normalized)
    || parts.some((part) => (
      part === ''
      || part === '.'
      || part === '..'
      || /[<>:"|?*\u0000-\u001f]/.test(part)
      || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    ))
  ) {
    throw new ValidationError(`${label} verlässt den erlaubten Ordner oder enthält unzulässige Pfadteile.`)
  }
  return normalized
}

export function assertManifestLocation(value: unknown): string {
  const location = assertSafeRelativePath(value, 'Manifest-Pfad')
  if (!/^[\p{L}\p{N}._/-]{1,512}$/u.test(location)) {
    throw new ValidationError('Der Manifest-Pfad enthält unzulässige Zeichen.')
  }
  return location
}

export function validateModpackReference(value: unknown): ModpackManifestReference {
  if (!isRecord(value)) throw new ValidationError('Die Modpack-Referenz ist ungültig.')
  const name = assertPackName(value.name)
  const title = requireString(value.title, 'title', 256)
  const version = requireString(value.version, 'version', 128)
  const gameVersion = requireString(value.gameVersion, 'gameVersion', 128)
  const location = assertManifestLocation(value.location)
  const logo = value.logo == null ? undefined : requireHttpsUrl(value.logo, 'logo')
  return { name, title, version, gameVersion, location, ...(logo ? { logo } : {}) }
}

export function validateFileTask(value: unknown): FileTask {
  if (!isRecord(value)) throw new ValidationError('Eine Download-Aufgabe ist ungültig.')
  if (typeof value.hash !== 'string' || !HASH_RE.test(value.hash.trim())) {
    throw new ValidationError('Eine Download-Aufgabe enthält keinen gültigen Hash.')
  }
  const location = typeof value.location === 'string' && /^https?:\/\//i.test(value.location)
    ? requireHttpsUrl(value.location, 'Download-URL')
    : assertSafeRelativePath(value.location, 'Objektpfad')
  const to = assertSafeRelativePath(value.to, 'Zielpfad')
  const userFile = value.userFile == null ? false : value.userFile
  if (typeof userFile !== 'boolean') throw new ValidationError('userFile ist ungültig.')

  let when: FileTask['when']
  if (value.when !== undefined) {
    if (
      !isRecord(value.when)
      || (value.when.if !== 'requireAny' && value.when.if !== 'requireAll')
      || !Array.isArray(value.when.features)
      || value.when.features.length > 200
      || value.when.features.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 128)
    ) {
      throw new ValidationError('Eine Download-Aufgabe enthält eine ungültige Feature-Bedingung.')
    }
    when = { if: value.when.if, features: [...new Set(value.when.features as string[])] }
  }

  return {
    hash: value.hash.trim().toLowerCase(),
    location,
    to,
    userFile,
    ...(when ? { when } : {}),
  }
}

function validateFeatures(value: unknown): ModpackManifest['features'] {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length > 200) {
    throw new ValidationError('Die Modpack-Features sind ungültig.')
  }
  const names = new Set<string>()
  return value.map((raw) => {
    if (!isRecord(raw)) throw new ValidationError('Ein Modpack-Feature ist ungültig.')
    const name = requireString(raw.name, 'Feature-Name', 128)
    if (!name || names.has(name)) throw new ValidationError('Feature-Namen müssen eindeutig sein.')
    names.add(name)
    const description = requireString(raw.description, 'Feature-Beschreibung', 2_048)
    if (raw.default !== undefined && typeof raw.default !== 'boolean') {
      throw new ValidationError('Der Standardwert eines Features ist ungültig.')
    }
    return { name, description, ...(typeof raw.default === 'boolean' ? { default: raw.default } : {}) }
  })
}

function validateLaunchFlags(value: unknown): ModpackManifest['launch'] {
  if (value == null) return undefined
  if (!isRecord(value) || Object.keys(value).length > 8) {
    throw new ValidationError('Die JVM-Startparameter des Modpacks sind ungültig.')
  }
  const launch: Record<string, string[]> = {}
  for (const [platform, rawArgs] of Object.entries(value)) {
    if (!['windows', 'osx', 'linux', 'flags'].includes(platform) || !Array.isArray(rawArgs) || rawArgs.length > 256) {
      throw new ValidationError('Die JVM-Startparameter des Modpacks sind ungültig.')
    }
    if (rawArgs.some((arg) => typeof arg !== 'string' || arg.length > 4_096 || /[\r\n\0]/.test(arg))) {
      throw new ValidationError('Ein JVM-Startparameter des Modpacks ist ungültig.')
    }
    launch[platform] = rawArgs as string[]
  }
  return launch
}

function hasDuplicateOrNestedPath(paths: string[]): boolean {
  const normalized = paths.map((entry) => entry.normalize('NFC'))
  const pathSet = new Set(normalized)
  if (pathSet.size !== normalized.length) return true
  for (const entry of normalized) {
    let separator = entry.indexOf('/')
    while (separator !== -1) {
      if (pathSet.has(entry.slice(0, separator))) return true
      separator = entry.indexOf('/', separator + 1)
    }
  }
  return false
}

export function validateModpackManifest(value: unknown, referenceLocation?: string): ModpackManifest {
  if (!isRecord(value)) throw new ValidationError('Das Modpack-Manifest ist ungültig.')
  const reference = validateModpackReference(
    referenceLocation === undefined
      ? value
      : { ...value, location: assertManifestLocation(referenceLocation) },
  )
  if (!isRecord(value.versionManifest)) {
    throw new ValidationError('Das Modpack-Manifest enthält kein gültiges Versionsmanifest.')
  }
  const versionId = requireString(value.versionManifest.id, 'Versions-ID', 256)
  if (!versionId || /[\\/\0]/.test(versionId) || versionId === '.' || versionId === '..') {
    throw new ValidationError('Die Versions-ID ist ungültig.')
  }
  const tasks = value.tasks == null
    ? undefined
    : Array.isArray(value.tasks) && value.tasks.length <= 100_000
      ? value.tasks.map(validateFileTask)
      : (() => { throw new ValidationError('Die Download-Aufgaben sind ungültig.') })()
  if (tasks && hasDuplicateOrNestedPath(tasks.map((task) => task.to))) {
    throw new ValidationError('Download-Zielpfade müssen eindeutig sein und dürfen sich nicht überlappen.')
  }
  const features = validateFeatures(value.features)
  const launch = validateLaunchFlags(value.launch)
  const runtime = value.runtime == null ? undefined : requireString(value.runtime, 'Runtime', 128)
  if (runtime !== undefined && (!runtime || !/^[A-Za-z0-9._-]+$/.test(runtime))) {
    throw new ValidationError('Der Runtime-Name ist ungültig.')
  }
  const {
    logo: _rawLogo,
    tasks: _rawTasks,
    features: _rawFeatures,
    launch: _rawLaunch,
    runtime: _rawRuntime,
    versionManifest: _rawVersionManifest,
    ...additionalFields
  } = value
  return {
    ...additionalFields,
    ...reference,
    versionManifest: { ...value.versionManifest, id: versionId },
    ...(tasks !== undefined ? { tasks } : {}),
    ...(features !== undefined ? { features } : {}),
    ...(launch !== undefined ? { launch } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
  }
}

export function requireHttpsUrl(value: unknown, label = 'URL'): string {
  if (typeof value !== 'string' || value.length > 4_096) throw new ValidationError(`${label} ist ungültig.`)
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new ValidationError(`${label} ist ungültig.`) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new ValidationError(`${label} muss eine HTTPS-Adresse ohne Zugangsdaten sein.`)
  }
  return parsed.toString()
}

export function validateJvmArgumentString(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8_192 || /[\r\n\0]/.test(value)) {
    throw new ValidationError('Die JVM-Argumente sind ungültig.')
  }
  for (const token of value.trim().split(/\s+/).filter(Boolean)) {
    if (FORBIDDEN_JVM_ARGUMENTS.some((pattern) => pattern.test(token))) {
      throw new ValidationError(`Das JVM-Argument „${token.split('=')[0]}“ ist aus Sicherheitsgründen nicht erlaubt.`)
    }
  }
  return value
}

export function filterSafeRemoteJvmArgs(args: string[]): string[] {
  return args.filter((arg) => !FORBIDDEN_JVM_ARGUMENTS.some((pattern) => pattern.test(arg)))
}
