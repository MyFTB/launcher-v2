// ============================================================
// MyFTB Launcher v2 — Shared Types
// Used by both Electron main process and React renderer.
// ============================================================

// ─── Modpack ────────────────────────────────────────────────

export interface ModpackManifestReference {
  name: string
  title: string
  version: string
  location: string
  gameVersion: string
  logo?: string
}

export interface FeatureCondition {
  /** 'requireAny' | 'requireAll' */
  if: 'requireAny' | 'requireAll'
  features: string[]
}

export interface FileTask {
  hash: string
  location: string
  to: string
  userFile: boolean
  when?: FeatureCondition
}

export interface Feature {
  name: string
  description: string
  /** Whether this feature is selected by default */
  default?: boolean
}

export interface MinecraftLibraryArtifact {
  path: string
  sha1: string
  size: number
  url: string
}

export interface MinecraftLibrary {
  name: string
  downloads?: {
    artifact?: MinecraftLibraryArtifact
  }
  rules?: Array<{
    action: 'allow' | 'disallow'
    os?: { name: string }
  }>
}

export interface MinecraftVersionManifest {
  id: string
  type?: string
  mainClass?: string
  minecraftArguments?: string
  arguments?: {
    game?: (string | object)[]
    jvm?: (string | object)[]
  }
  libraries?: MinecraftLibrary[]
  assetIndex?: { id: string; sha1: string; size: number; url: string }
  assets?: string
  downloads?: {
    client?: { sha1: string; size: number; url: string }
  }
  inheritsFrom?: string
}

export interface ModpackManifest extends ModpackManifestReference {
  versionManifest: MinecraftVersionManifest
  /** Per-platform JVM/game launch args, keyed by platform or '*' */
  launch?: Record<string, string[]>
  /** Custom JRE identifier, fetched from launcher.myftb.de/{runtime}.json */
  runtime?: string
  features?: Feature[]
  tasks?: FileTask[]
}

// ─── Auth / Profiles ────────────────────────────────────────

export type AuthProvider = 'microsoft'

export interface LauncherProfile {
  provider: AuthProvider
  uuid: string
  lastKnownUsername: string
  /** Minecraft access token (short-lived) */
  minecraftAccessToken: string
  /** Microsoft OAuth refresh token (long-lived) */
  oauthRefreshToken: string
  /** Xbox user ID for skin/cape lookup */
  xuid?: string
}

export interface LauncherProfileStore {
  profiles: LauncherProfile[]
  selectedProfileUuid?: string
}

// ─── Launcher Config ─────────────────────────────────────────

/** Per-modpack memory and JVM argument overrides. Unset fields fall back to global config. */
export interface PackConfig {
  minMemory?: number
  maxMemory?: number
  jvmArgs?: string
}

export interface LauncherConfig {
  /** Random UUID identifying this client installation */
  clientToken: string
  /** Extra JVM arguments string */
  jvmArgs: string
  maxMemory: number
  minMemory: number
  gameWidth: number
  gameHeight: number
  /** Server pack key for authenticated pack lists */
  packKey: string
  /** Root directory where modpack instances are installed */
  installationDir: string
  /** Whether myftb:// deep-link / webstart is allowed */
  allowWebstart: boolean
  /** Up to 3 recently played pack names */
  lastPlayedPacks: string[]
  /** Key-value map for AutoConfig feature state */
  autoConfigs: Record<string, string>
  /** Per-pack memory and JVM argument overrides, keyed by pack name */
  packConfigs: Record<string, PackConfig>
  profileStore: LauncherProfileStore
  /** Update channel: stable = releases only, experimental = prereleases included */
  updateChannel: 'stable' | 'experimental'
}

export const DEFAULT_CONFIG: LauncherConfig = {
  clientToken: '',
  jvmArgs: '',
  maxMemory: 4096,
  minMemory: 2048,
  gameWidth: 854,
  gameHeight: 480,
  packKey: '',
  installationDir: '',
  allowWebstart: true,
  lastPlayedPacks: [],
  autoConfigs: {},
  packConfigs: {},
  profileStore: { profiles: [], selectedProfileUuid: undefined },
  updateChannel: 'stable',
}

// ─── IPC Payload Types ───────────────────────────────────────

// Auth
export interface AuthStartMicrosoftPayload { /* no input needed */ }
export interface AuthLogoutPayload { /* no input needed */ }
export interface AuthSwitchProfilePayload { uuid: string }
export interface AuthProfilesUpdatedEvent { profiles: LauncherProfile[]; selectedUuid?: string }
export interface AuthLoginErrorEvent { error: string }

// Packs
export interface PacksGetRemotePayload { /* no input needed */ }
export interface PacksGetManifestPayload { location: string }
export interface PacksGetLogoPayload { location: string; name: string; logo?: string }
export interface PacksGetLogoResult { dataUrl: string | null }

// Install
export interface InstallModpackPayload {
  reference: ModpackManifestReference
  selectedFeatures?: string[]
}
export interface InstallProgressEvent {
  total: number
  finished: number
  failed: number
  currentFile?: string
}
export interface InstallCompleteEvent { success: boolean; error?: string }
export interface InstallNeedsFeaturesEvent { features: Feature[] }

// Launch
export interface LaunchStartPayload { packName: string }
export interface LaunchOpenFolderPayload { packName: string }
export interface LaunchDeletePayload { packName: string }
export interface LaunchCreateShortcutPayload { packName: string }
export type LaunchState = 'launching' | 'running' | 'closed' | 'crashed'
export interface LaunchStateEvent { state: LaunchState; exitCode?: number }
export interface LaunchLogEvent { line: string }

// Config
export interface ConfigPickDirResult { directory: string | null }

// System info
export interface SystemInfoResult {
  platform: 'win32' | 'darwin' | 'linux'
  totalMemoryMb: number
  arch: string
  launcherVersion: string
}

// Paste / crash
export interface UploadLogResult { url: string }

// Updates
export interface UpdateAvailableEvent {
  version: string
  releaseNotes: string | null
  releaseDate: string
}
export interface UpdateProgressEvent {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}
export interface UpdateDownloadedEvent { version: string }
export interface UpdateErrorEvent { message: string }

// Posts (myftb.de blog)
export interface Post {
  title: string
  url: string
  excerpt?: string
  date?: string
  image?: string
  tags?: string
  category?: string
}

// ─── Electron API (exposed via preload) ──────────────────────

/** Shape of window.electronAPI exposed by preload.ts */
export interface ElectronAPI {
  // Auth
  authStartMicrosoft(): Promise<void>
  authLogout(): Promise<void>
  authSwitchProfile(uuid: string): Promise<void>

  // Packs
  packsGetRemote(): Promise<ModpackManifestReference[]>
  packsGetManifest(location: string): Promise<ModpackManifest>
  packsGetPosts(): Promise<Post[]>
  packsGetLogo(location: string, name: string, logo?: string): Promise<string | null>
  packsReload(): Promise<void>

  // Install
  installModpack(reference: ModpackManifestReference, selectedFeatures?: string[]): Promise<void>
  installCancel(): Promise<void>
  installGetInstalled(): Promise<{ name: string; version: string }[]>

  // Launch
  launchStart(packName: string): Promise<void>
  launchKill(): Promise<void>
  launchGetLog(): Promise<string>
  launchOpenFolder(packName: string): Promise<void>
  launchDeletePack(packName: string): Promise<boolean>
  launchCreateShortcut(packName: string): Promise<void>
  launchUploadCrash(packName: string): Promise<string>
  launchUploadLog(): Promise<string>

  // Config
  configGet(): Promise<LauncherConfig>
  configSave(config: Partial<LauncherConfig>): Promise<void>
  configPickDir(): Promise<string | null>
  configOpenLogs(): Promise<void>

  // System
  systemInfo(): Promise<SystemInfoResult>
  systemOpenUrl(url: string): Promise<void>

  // Window controls
  windowMinimize(): void
  windowMaximize(): void
  windowClose(): void
  windowOpenConsole(): Promise<void>

  // Updates
  updateCheck(): Promise<void>
  updateDownload(): Promise<void>
  updateInstall(): void
  updateSetChannel(channel: 'stable' | 'experimental'): void

  // Push event listeners (renderer side)
  on(channel: string, listener: (...args: unknown[]) => void): () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
