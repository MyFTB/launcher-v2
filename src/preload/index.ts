import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI, LauncherConfig } from '../shared/types'

/**
 * Exposes a typed ElectronAPI to the renderer via contextBridge.
 * The renderer accesses this as window.electronAPI.
 *
 * SECURITY: contextIsolation is always true. nodeIntegration is always false.
 * No raw ipcRenderer is exposed — only these explicitly typed methods.
 */
const api: ElectronAPI = {
  // ── Auth ──────────────────────────────────────────────────
  authStartMicrosoft: () => ipcRenderer.invoke('auth:start-microsoft'),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  authSwitchProfile: (uuid) => ipcRenderer.invoke('auth:switch-profile', { uuid }),

  // ── Packs ─────────────────────────────────────────────────
  packsGetRemote: () => ipcRenderer.invoke('packs:get-remote'),
  packsGetManifest: (location) => ipcRenderer.invoke('packs:get-manifest', { location }),
  packsGetPosts: () => ipcRenderer.invoke('packs:get-posts'),
  packsReload: () => ipcRenderer.invoke('packs:reload'),
  packsGetLogo: (location, name, logo) => ipcRenderer.invoke('packs:get-logo', { location, name, logo }),

  // ── Install ───────────────────────────────────────────────
  installModpack: (reference, selectedFeatures) =>
    ipcRenderer.invoke('install:modpack', { reference, selectedFeatures }),
  installCancel: () => ipcRenderer.invoke('install:cancel'),
  installGetInstalled: () => ipcRenderer.invoke('install:get-installed'),

  // ── Launch ────────────────────────────────────────────────
  launchStart: (packName) => ipcRenderer.invoke('launch:start', { packName }),
  launchKill: () => ipcRenderer.invoke('launch:kill'),
  launchGetLog: () => ipcRenderer.invoke('launch:get-log'),
  launchOpenFolder: (packName) => ipcRenderer.invoke('launch:open-folder', { packName }),
  launchDeletePack: (packName) => ipcRenderer.invoke('launch:delete-pack', { packName }),
  launchCreateShortcut: (packName) => ipcRenderer.invoke('launch:create-shortcut', { packName }),
  launchUploadCrash: (packName) => ipcRenderer.invoke('launch:upload-crash', { packName }),
  launchUploadLog: () => ipcRenderer.invoke('launch:upload-log'),

  // ── Config ────────────────────────────────────────────────
  configGet: () => ipcRenderer.invoke('config:get'),
  configSave: (config: Partial<LauncherConfig>) => ipcRenderer.invoke('config:save', config),
  configPickDir: () => ipcRenderer.invoke('config:pick-dir'),
  configOpenLogs: () => ipcRenderer.invoke('config:open-logs'),

  // ── System ────────────────────────────────────────────────
  systemInfo: () => ipcRenderer.invoke('system:info'),
  systemOpenUrl: (url) => ipcRenderer.invoke('system:open-url', { url }),

  // ── Updates ───────────────────────────────────────────────────
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.send('update:install'),

  // ── Window controls ───────────────────────────────────────
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  windowOpenConsole: () => ipcRenderer.invoke('window:open-console'),

  // ── Push event subscription ───────────────────────────────
  on: (channel, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      listener(...args)
    ipcRenderer.on(channel, wrapped)
    // Returns an unsubscribe function
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
