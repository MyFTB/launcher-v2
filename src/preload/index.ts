import { contextBridge, ipcRenderer } from 'electron'
import type {
  ElectronAPI,
  IpcResponse,
  PushChannel,
  RendererConfigPatch,
} from '../shared/types'
import { IpcChannels } from '../main/ipc/channels'

const ALLOWED_PUSH_CHANNELS = new Set<PushChannel>([
  IpcChannels.AUTH_PROFILES_UPDATED,
  IpcChannels.AUTH_LOGIN_ERROR,
  IpcChannels.INSTALL_PROGRESS,
  IpcChannels.INSTALL_COMPLETE,
  IpcChannels.INSTALL_NEEDS_FEATURES,
  IpcChannels.INSTALL_FEATURES_CHANGE_PROGRESS,
  IpcChannels.INSTALL_FEATURES_CHANGE_COMPLETE,
  IpcChannels.LAUNCH_STATE,
  IpcChannels.LAUNCH_LOG,
  IpcChannels.LAUNCH_CONSOLE_SELECT,
  IpcChannels.LAUNCH_SESSION_REMOVED,
  IpcChannels.WELCOME_MESSAGE,
  IpcChannels.LAUNCH_PACK,
  IpcChannels.UPDATE_AVAILABLE,
  IpcChannels.UPDATE_NOT_AVAILABLE,
  IpcChannels.UPDATE_PROGRESS,
  IpcChannels.UPDATE_DOWNLOADED,
  IpcChannels.UPDATE_ERROR,
  IpcChannels.WINDOW_MAXIMIZED_CHANGED,
])

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const response = await ipcRenderer.invoke(channel, payload) as IpcResponse<T>
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
    throw new Error('Ungültige IPC-Antwort vom Hauptprozess.')
  }
  if (!response.ok) {
    const error = new Error(response.error.message) as Error & { code?: string }
    error.name = 'IpcError'
    error.code = response.error.code
    throw error
  }
  return response.value
}

const api: ElectronAPI = {
  platform: process.platform as ElectronAPI['platform'],

  authStartMicrosoft: () => invoke(IpcChannels.AUTH_START_MICROSOFT),
  authLogout: () => invoke(IpcChannels.AUTH_LOGOUT),
  authSwitchProfile: (uuid) => invoke(IpcChannels.AUTH_SWITCH_PROFILE, { uuid }),

  packsGetRemote: () => invoke(IpcChannels.PACKS_GET_REMOTE),
  packsGetManifest: (location) => invoke(IpcChannels.PACKS_GET_MANIFEST, { location }),
  packsGetPosts: () => invoke(IpcChannels.PACKS_GET_POSTS),
  packsReload: () => invoke(IpcChannels.PACKS_RELOAD),
  packsGetLogo: (location, name, logo) => invoke(IpcChannels.PACKS_GET_LOGO, { location, name, logo }),

  installModpack: (reference, selectedFeatures) =>
    invoke(IpcChannels.INSTALL_MODPACK, { reference, selectedFeatures }),
  installCancel: () => invoke(IpcChannels.INSTALL_CANCEL),
  installGetInstalled: () => invoke(IpcChannels.INSTALL_GET_INSTALLED),
  installGetPackFeatures: (packName) => invoke(IpcChannels.INSTALL_GET_PACK_FEATURES, { packName }),
  installChangeFeatures: (packName, selectedFeatures) =>
    invoke(IpcChannels.INSTALL_CHANGE_FEATURES, { packName, selectedFeatures }),
  installVerifyPack: (packName) => invoke(IpcChannels.INSTALL_VERIFY_PACK, { packName }),
  installRepairPack: (packName) => invoke(IpcChannels.INSTALL_REPAIR_PACK, { packName }),
  installRetryFailed: (packName) => invoke(IpcChannels.INSTALL_RETRY_FAILED, { packName }),

  launchStart: (packName) => invoke(IpcChannels.LAUNCH_START, { packName }),
  launchKill: (sessionId) => invoke(IpcChannels.LAUNCH_KILL, { sessionId }),
  launchRemoveSession: (sessionId) => invoke(IpcChannels.LAUNCH_REMOVE_SESSION, { sessionId }),
  launchGetSessions: () => invoke(IpcChannels.LAUNCH_GET_SESSIONS),
  launchGetLog: (sessionId) => invoke(IpcChannels.LAUNCH_GET_LOG, { sessionId }),
  launchOpenFolder: (packName) => invoke(IpcChannels.LAUNCH_OPEN_FOLDER, { packName }),
  launchDeletePack: (packName) => invoke(IpcChannels.LAUNCH_DELETE_PACK, { packName }),
  launchCreateShortcut: (packName) => invoke(IpcChannels.LAUNCH_CREATE_SHORTCUT, { packName }),
  launchUploadCrash: (packName) => invoke(IpcChannels.LAUNCH_UPLOAD_CRASH, { packName }),
  launchUploadLog: (sessionId) => invoke(IpcChannels.LAUNCH_UPLOAD_LOG, { sessionId }),

  configGet: () => invoke(IpcChannels.CONFIG_GET),
  configSave: (config: RendererConfigPatch) => invoke(IpcChannels.CONFIG_SAVE, config),
  configPickDir: () => invoke(IpcChannels.CONFIG_PICK_DIR),
  configOpenLogs: () => invoke(IpcChannels.CONFIG_OPEN_LOGS),
  configChangeDataDir: () => invoke(IpcChannels.CONFIG_CHANGE_DATA_DIR),
  configMoveInstances: (targetDir) => invoke(IpcChannels.CONFIG_MOVE_INSTANCES, { targetDir }),
  configGetRecovery: () => invoke(IpcChannels.CONFIG_GET_RECOVERY),
  configResolveRecovery: (action, dataDir) =>
    invoke(IpcChannels.CONFIG_RESOLVE_RECOVERY, { action, dataDir }),

  systemInfo: () => invoke(IpcChannels.SYSTEM_INFO),
  systemOpenUrl: (url) => invoke(IpcChannels.SYSTEM_OPEN_URL, { url }),

  updateCheck: () => invoke(IpcChannels.UPDATE_CHECK),
  updateDownload: () => invoke(IpcChannels.UPDATE_DOWNLOAD),
  updateInstall: () => invoke(IpcChannels.UPDATE_INSTALL),
  updateSetChannel: (channel) => invoke(IpcChannels.UPDATE_SET_CHANNEL, { channel }),

  windowMinimize: () => ipcRenderer.send(IpcChannels.WINDOW_MINIMIZE),
  windowMaximize: () => ipcRenderer.send(IpcChannels.WINDOW_MAXIMIZE),
  windowClose: () => ipcRenderer.send(IpcChannels.WINDOW_CLOSE),
  windowIsMaximized: () => invoke(IpcChannels.WINDOW_IS_MAXIMIZED),
  windowOpenConsole: (sessionId) => invoke(IpcChannels.WINDOW_OPEN_CONSOLE, { sessionId }),

  on: (channel, listener) => {
    if (!ALLOWED_PUSH_CHANNELS.has(channel)) {
      throw new Error(`IPC-Ereigniskanal ist nicht erlaubt: ${channel}`)
    }
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
}

contextBridge.exposeInMainWorld('electronAPI', Object.freeze(api))

window.addEventListener('DOMContentLoaded', () => {
  void invoke(IpcChannels.RENDERER_ARRIVED).catch(() => {
    // Startup recovery UI will surface any main-process problem.
  })
})
