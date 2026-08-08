import type {
  ChangeFeaturesResult,
  DataDirMigrationResult,
  DataRecoveryAction,
  DataRecoveryState,
  InstallResult,
  InstalledPackSummary,
  LaunchSession,
  LaunchStartResult,
  ModpackManifest,
  ModpackManifestReference,
  PackFeaturesResult,
  Post,
  PushChannel,
  RendererConfig,
  RendererConfigPatch,
  SystemInfoResult,
  UpdateChannel,
  VerifyPackResult,
} from '@shared/types'

export const ipc = {
  auth: {
    startMicrosoft: (): Promise<void> => window.electronAPI.authStartMicrosoft(),
    logout: (): Promise<void> => window.electronAPI.authLogout(),
    switchProfile: (uuid: string): Promise<void> => window.electronAPI.authSwitchProfile(uuid),
  },
  packs: {
    getRemote: (): Promise<ModpackManifestReference[]> => window.electronAPI.packsGetRemote(),
    getManifest: (location: string): Promise<ModpackManifest | null> => window.electronAPI.packsGetManifest(location),
    getPosts: (): Promise<Post[]> => window.electronAPI.packsGetPosts(),
    getLogo: (location: string, name: string, logo?: string): Promise<string | null> => (
      window.electronAPI.packsGetLogo(location, name, logo)
    ),
    reload: (): Promise<void> => window.electronAPI.packsReload(),
  },
  install: {
    installModpack: (
      reference: ModpackManifestReference,
      selectedFeatures?: string[],
    ): Promise<InstallResult> => window.electronAPI.installModpack(reference, selectedFeatures),
    cancel: (): Promise<void> => window.electronAPI.installCancel(),
    getInstalled: (): Promise<InstalledPackSummary[]> => (
      window.electronAPI.installGetInstalled()
    ),
    getPackFeatures: (packName: string): Promise<PackFeaturesResult> => (
      window.electronAPI.installGetPackFeatures(packName)
    ),
    changeFeatures: (packName: string, selectedFeatures: string[]): Promise<ChangeFeaturesResult> => (
      window.electronAPI.installChangeFeatures(packName, selectedFeatures)
    ),
    verifyPack: (packName: string): Promise<VerifyPackResult> => window.electronAPI.installVerifyPack(packName),
    repairPack: (packName: string): Promise<InstallResult> => window.electronAPI.installRepairPack(packName),
    retryFailed: (packName: string): Promise<InstallResult> => window.electronAPI.installRetryFailed(packName),
  },
  launch: {
    start: (packName: string): Promise<LaunchStartResult> => window.electronAPI.launchStart(packName),
    kill: (sessionId: string): Promise<void> => window.electronAPI.launchKill(sessionId),
    getSessions: (): Promise<LaunchSession[]> => window.electronAPI.launchGetSessions(),
    getLog: (sessionId: string): Promise<string> => window.electronAPI.launchGetLog(sessionId),
    openFolder: (packName: string): Promise<void> => window.electronAPI.launchOpenFolder(packName),
    deletePack: (packName: string): Promise<{ success: boolean; error?: string }> => (
      window.electronAPI.launchDeletePack(packName)
    ),
    createShortcut: (packName: string): Promise<void> => window.electronAPI.launchCreateShortcut(packName),
    uploadCrash: (packName: string): Promise<string> => window.electronAPI.launchUploadCrash(packName),
    uploadLog: (sessionId: string): Promise<string> => window.electronAPI.launchUploadLog(sessionId),
  },
  config: {
    get: (): Promise<RendererConfig> => window.electronAPI.configGet(),
    save: (config: RendererConfigPatch): Promise<void> => window.electronAPI.configSave(config),
    pickDir: (): Promise<string | null> => window.electronAPI.configPickDir(),
    openLogs: (): Promise<void> => window.electronAPI.configOpenLogs(),
    changeDataDir: (): Promise<DataDirMigrationResult> => window.electronAPI.configChangeDataDir(),
    moveInstances: (targetDir: string): Promise<{ success: boolean; error?: string }> => (
      window.electronAPI.configMoveInstances(targetDir)
    ),
    getRecovery: (): Promise<DataRecoveryState> => window.electronAPI.configGetRecovery(),
    resolveRecovery: (action: DataRecoveryAction, dataDir?: string): Promise<void> => (
      window.electronAPI.configResolveRecovery(action, dataDir)
    ),
  },
  system: {
    info: (): Promise<SystemInfoResult> => window.electronAPI.systemInfo(),
    openUrl: (url: string): Promise<void> => window.electronAPI.systemOpenUrl(url),
  },
  update: {
    check: (): Promise<void> => window.electronAPI.updateCheck(),
    download: (): Promise<void> => window.electronAPI.updateDownload(),
    install: (): Promise<void> => window.electronAPI.updateInstall(),
    setChannel: (channel: UpdateChannel): Promise<void> => window.electronAPI.updateSetChannel(channel),
  },
  window: {
    isMaximized: (): Promise<boolean> => window.electronAPI.windowIsMaximized(),
    openConsole: (sessionId?: string): Promise<void> => window.electronAPI.windowOpenConsole(sessionId),
  },
} as const

export function onEvent(
  channel: PushChannel,
  callback: (...args: unknown[]) => void,
): () => void {
  return window.electronAPI.on(channel, callback)
}

export type { AuthProfileSummary as LauncherProfile } from '@shared/types'
