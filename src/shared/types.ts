// ============================================================
// MyFTB Launcher v2 — shared data and IPC contracts
// ============================================================

// ─── Modpacks ───────────────────────────────────────────────────────────────

export interface ModpackManifestReference {
  name: string
  title: string
  version: string
  location: string
  gameVersion: string
  logo?: string
}

export interface FeatureCondition {
  if: 'requireAny' | 'requireAll'
  features: string[]
}

export interface FileTask {
  /** Strong hexadecimal digest. SHA-256 is required for external hosts. */
  hash: string
  location: string
  to: string
  userFile: boolean
  when?: FeatureCondition
}

export interface Feature {
  name: string
  description: string
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
  downloads?: { artifact?: MinecraftLibraryArtifact }
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
  launch?: Record<string, string[]>
  runtime?: string
  features?: Feature[]
  tasks?: FileTask[]
}

// ─── Authentication ─────────────────────────────────────────────────────────

export type AuthProvider = 'microsoft'

/** Renderer-safe account metadata. Tokens are stored only in the main process. */
export interface AuthProfileSummary {
  provider: AuthProvider
  uuid: string
  lastKnownUsername: string
  minecraftTokenExpiresAt?: number
  lastAuthenticatedAt?: number
}

/** Compatibility name used by existing renderer components. It never has tokens. */
export type LauncherProfile = AuthProfileSummary

export interface AuthenticatedProfile extends AuthProfileSummary {
  minecraftAccessToken: string
  oauthRefreshToken: string
}

export interface LauncherProfileStore {
  profiles: AuthProfileSummary[]
  selectedProfileUuid?: string
}

// ─── Configuration and recovery ─────────────────────────────────────────────

export type UpdateChannel = 'stable' | 'experimental'
export const CONFIG_VERSION = 2

export interface PackConfig {
  minMemory?: number
  maxMemory?: number
  jvmArgs?: string
}

export interface LauncherConfig {
  version: number
  /** Random UUID identifying this launcher installation. Main-process only. */
  clientToken: string
  jvmArgs: string
  maxMemory: number
  minMemory: number
  gameWidth: number
  gameHeight: number
  packKey: string
  installationDir: string
  allowWebstart: boolean
  lastPlayedPacks: string[]
  autoConfigs: Record<string, string>
  packConfigs: Record<string, PackConfig>
  profileStore: LauncherProfileStore
  updateChannel: UpdateChannel
}

/** The renderer may only mutate user-editable settings. */
export type RendererConfigPatch = Partial<Pick<
  LauncherConfig,
  | 'jvmArgs'
  | 'maxMemory'
  | 'minMemory'
  | 'gameWidth'
  | 'gameHeight'
  | 'packKey'
  | 'allowWebstart'
  | 'packConfigs'
>>

/** Renderer-facing config. It intentionally contains no credentials/client token. */
export type RendererConfig = Omit<LauncherConfig, 'clientToken'>

export const DEFAULT_CONFIG: LauncherConfig = {
  version: CONFIG_VERSION,
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

export type DataRecoveryStatus = 'ok' | 'recovered-backup' | 'needs-recovery'
export interface DataRecoveryState {
  status: DataRecoveryStatus
  source?: 'config' | 'pointer' | 'update-journal'
  message?: string
  brokenPath?: string
  backupAvailable?: boolean
}

export type DataRecoveryAction = 'restore-backup' | 'locate-data' | 'fresh-start' | 'accept-current'

// ─── Structured IPC errors ──────────────────────────────────────────────────

export type IpcErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_PAYLOAD'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CANCELLED'
  | 'NETWORK_TEMPORARY'
  | 'AUTH_REJECTED'
  | 'RECOVERY_REQUIRED'
  | 'IO_ERROR'
  | 'INTERNAL'

export interface IpcErrorDto {
  code: IpcErrorCode
  message: string
}

export type IpcResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: IpcErrorDto }

// ─── Authentication IPC ─────────────────────────────────────────────────────

export interface AuthSwitchProfilePayload { uuid: string }
export interface AuthProfilesUpdatedEvent {
  profiles: AuthProfileSummary[]
  selectedUuid?: string
}
export interface AuthLoginErrorEvent {
  error: string
  code?: IpcErrorCode
}

// ─── Packs IPC ──────────────────────────────────────────────────────────────

export interface PacksGetManifestPayload { location: string }
export interface PacksGetLogoPayload { location: string; name: string; logo?: string }
export interface PacksGetLogoResult { dataUrl: string | null }

// ─── Installation and downloads ─────────────────────────────────────────────

export type DownloadFailureKind =
  | 'dns'
  | 'tls'
  | 'connection'
  | 'timeout'
  | 'http'
  | 'checksum'
  | 'cancelled'
  | 'permission'
  | 'disk'
  | 'invalid-source'
  | 'unknown'

export interface DownloadFailure {
  task: string
  url?: string
  host?: string
  kind: DownloadFailureKind
  message: string
  retryable: boolean
  attempts: number
  bytesReceived?: number
  status?: number
}

export interface InstallModpackPayload {
  reference: ModpackManifestReference
  selectedFeatures?: string[]
}
export interface InstallProgressEvent {
  operationId?: string
  packName?: string
  total: number
  finished: number
  failed: number
  currentFile?: string
}
export interface InstalledPackSummary extends ModpackManifestReference {
  hasFeatures: boolean
}

export interface InstallResult {
  success: boolean
  packName: string
  operationId?: string
  failures: DownloadFailure[]
  error?: string
  cancelled?: boolean
}
export interface InstallCompleteEvent extends InstallResult {}
export interface InstallNeedsFeaturesEvent { features: Feature[] }
export interface PackFeaturesResult { features: Feature[]; selected: string[] }
export interface ChangeFeaturesPayload { packName: string; selectedFeatures: string[] }
export interface ChangeFeaturesResult { success: boolean; error?: string }
export interface VerifyPackPayload { packName: string }
export interface VerifyPackResult {
  packName: string
  valid: boolean
  missing: string[]
  corrupt: string[]
}
export interface RepairPackPayload { packName: string }
export interface RetryFailedPayload { packName: string }

// ─── Launch sessions ────────────────────────────────────────────────────────

export type LaunchState = 'launching' | 'running' | 'closed' | 'crashed'
export interface LaunchSession {
  id: string
  packName: string
  packTitle: string
  pid?: number
  /** Hash of OS process start metadata; prevents unsafe PID-reuse restoration. */
  processIdentity?: string
  state: LaunchState
  startedAt: number
  updatedAt: number
  exitCode?: number
  detached?: boolean
  error?: string
}
export interface LaunchStartPayload { packName: string }
export interface LaunchStartResult { session: LaunchSession }
export interface LaunchSessionPayload { sessionId: string }
export interface LaunchStateEvent { session: LaunchSession }
export interface LaunchLogEvent { sessionId: string; packName: string; line: string }
export interface LaunchConsoleSelectEvent { sessionId: string }
export interface LaunchSessionRemovedEvent { sessionId: string }
export interface LaunchOpenFolderPayload { packName: string }
export interface LaunchDeletePayload { packName: string }
export interface LaunchCreateShortcutPayload { packName: string }

// ─── Configuration/system IPC ───────────────────────────────────────────────

export interface ConfigPickDirResult { directory: string | null }
export interface DataDirMigrationResult {
  success: boolean
  error?: string
  cancelled?: boolean
}
export interface ConfigResolveRecoveryPayload {
  action: DataRecoveryAction
  dataDir?: string
}

export interface SystemInfoResult {
  platform: 'win32' | 'darwin' | 'linux'
  totalMemoryMb: number
  arch: string
  launcherVersion: string
  appId: string
  dataDir: string
  installDir: string
  instancesDir: string
  cacheDir: string
  runtimesDir: string
  pointerPath: string
  configPath: string
  configBackupPath: string
  secureCredentialPersistence: boolean
}

export interface UploadLogResult { url: string }

// ─── Updates ────────────────────────────────────────────────────────────────

export interface UpdateAvailableEvent {
  version: string
  releaseNotes: string | null
  releaseDate: string
  channel: UpdateChannel
}
export interface UpdateProgressEvent {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}
export interface UpdateDownloadedEvent { version: string; channel: UpdateChannel }
export interface UpdateErrorEvent { message: string }

// ─── Posts ──────────────────────────────────────────────────────────────────

export interface Post {
  title: string
  url: string
  excerpt?: string
  date?: string
  image?: string
  tags?: string
  category?: string
}

// ─── Window and push events ─────────────────────────────────────────────────

export interface WindowMaximizedEvent { maximized: boolean }

export type PushChannel =
  | 'auth:profiles-updated'
  | 'auth:login-error'
  | 'install:progress'
  | 'install:complete'
  | 'install:needs-features'
  | 'install:features-change-progress'
  | 'install:features-change-complete'
  | 'launch:state'
  | 'launch:log'
  | 'launch:console-select'
  | 'launch:session-removed'
  | 'internal:welcome-message'
  | 'internal:launch-pack'
  | 'update:available'
  | 'update:not-available'
  | 'update:progress'
  | 'update:downloaded'
  | 'update:error'
  | 'window:maximized-changed'

// ─── Electron API exposed by preload ────────────────────────────────────────

export interface ElectronAPI {
  readonly platform: 'win32' | 'darwin' | 'linux'

  authStartMicrosoft(): Promise<void>
  authLogout(): Promise<void>
  authSwitchProfile(uuid: string): Promise<void>

  packsGetRemote(): Promise<ModpackManifestReference[]>
  packsGetManifest(location: string): Promise<ModpackManifest | null>
  packsGetPosts(): Promise<Post[]>
  packsGetLogo(location: string, name: string, logo?: string): Promise<string | null>
  packsReload(): Promise<void>

  installModpack(reference: ModpackManifestReference, selectedFeatures?: string[]): Promise<InstallResult>
  installCancel(): Promise<void>
  installGetInstalled(): Promise<InstalledPackSummary[]>
  installGetPackFeatures(packName: string): Promise<PackFeaturesResult>
  installChangeFeatures(packName: string, selectedFeatures: string[]): Promise<ChangeFeaturesResult>
  installVerifyPack(packName: string): Promise<VerifyPackResult>
  installRepairPack(packName: string): Promise<InstallResult>
  installRetryFailed(packName: string): Promise<InstallResult>

  launchStart(packName: string): Promise<LaunchStartResult>
  launchKill(sessionId: string): Promise<void>
  launchGetSessions(): Promise<LaunchSession[]>
  launchGetLog(sessionId: string): Promise<string>
  launchOpenFolder(packName: string): Promise<void>
  launchDeletePack(packName: string): Promise<{ success: boolean; error?: string }>
  launchCreateShortcut(packName: string): Promise<void>
  launchUploadCrash(packName: string): Promise<string>
  launchUploadLog(sessionId: string): Promise<string>

  configGet(): Promise<RendererConfig>
  configSave(config: RendererConfigPatch): Promise<void>
  configPickDir(): Promise<string | null>
  configOpenLogs(): Promise<void>
  configChangeDataDir(): Promise<DataDirMigrationResult>
  configMoveInstances(targetDir: string): Promise<{ success: boolean; error?: string }>
  configGetRecovery(): Promise<DataRecoveryState>
  configResolveRecovery(action: DataRecoveryAction, dataDir?: string): Promise<void>

  systemInfo(): Promise<SystemInfoResult>
  systemOpenUrl(url: string): Promise<void>

  windowMinimize(): void
  windowMaximize(): void
  windowClose(): void
  windowIsMaximized(): Promise<boolean>
  windowOpenConsole(sessionId?: string): Promise<void>

  updateCheck(): Promise<void>
  updateDownload(): Promise<void>
  updateInstall(): Promise<void>
  updateSetChannel(channel: UpdateChannel): Promise<void>

  on(channel: PushChannel, listener: (...args: unknown[]) => void): () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
