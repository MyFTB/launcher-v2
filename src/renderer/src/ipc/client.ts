/**
 * IPC client — renderer side.
 *
 * Single import path for every IPC call:
 *   import { ipc, onEvent } from '@renderer/ipc/client'
 *
 * All methods are thin typed wrappers around window.electronAPI.
 * The ElectronAPI interface (declared in @shared/types) is the source of truth
 * for the exact signatures exposed by preload.ts.
 *
 * NOTE: `install.getInstalled` maps to the channel 'install:get-installed'.
 * The corresponding handler must be registered in the install service on the
 * main-process side before this call will resolve.
 */

import type {
  LauncherConfig,
  LauncherProfile,
  ModpackManifest,
  ModpackManifestReference,
  Post,
  SystemInfoResult,
} from '@shared/types'

// ─── Grouped namespace object ────────────────────────────────────────────────

export const ipc = {
  // ── Auth ───────────────────────────────────────────────────────────────────
  auth: {
    /** Start the Microsoft OAuth flow. Main opens the browser; push events
     *  ('auth:profiles-updated' / 'auth:login-error') carry the result. */
    startMicrosoft(): Promise<void> {
      return window.electronAPI.authStartMicrosoft()
    },

    /** Log out the currently selected profile. */
    logout(): Promise<void> {
      return window.electronAPI.authLogout()
    },

    /** Switch the active profile to the given UUID. */
    switchProfile(uuid: string): Promise<void> {
      return window.electronAPI.authSwitchProfile(uuid)
    },
  },

  // ── Packs ──────────────────────────────────────────────────────────────────
  packs: {
    /** Fetch the remote list of available modpacks. */
    getRemote(): Promise<ModpackManifestReference[]> {
      return window.electronAPI.packsGetRemote()
    },

    /** Fetch the full manifest for a specific pack. */
    getManifest(location: string): Promise<ModpackManifest> {
      return window.electronAPI.packsGetManifest(location)
    },

    /** Fetch blog posts from myftb.de. */
    getPosts(): Promise<Post[]> {
      return window.electronAPI.packsGetPosts()
    },

    /** Fetch the pack logo as a base64 data URL, or null if unavailable. */
    getLogo(location: string, name: string, logo?: string): Promise<string | null> {
      return window.electronAPI.packsGetLogo(location, name, logo)
    },
  },

  // ── Install ────────────────────────────────────────────────────────────────
  install: {
    /** Begin installing a modpack. If the pack has optional features and none
     *  are provided, the main process emits 'install:needs-features' before
     *  starting the download; the renderer should re-call with selectedFeatures. */
    installModpack(
      reference: ModpackManifestReference,
      selectedFeatures?: string[],
    ): Promise<void> {
      return window.electronAPI.installModpack(reference, selectedFeatures)
    },

    /** Cancel the in-progress installation. */
    cancel(): Promise<void> {
      return window.electronAPI.installCancel()
    },

    /**
     * Get the list of installed modpack manifests.
     *
     * NOTE: This call maps to the channel 'install:get-installed'.
     * A handler for that channel must be registered in the install service on
     * the main-process side (e.g. ipcMain.handle('install:get-installed', ...)).
     */
    getInstalled(): Promise<{ name: string; version: string }[]> {
      return window.electronAPI.installGetInstalled()
    },
  },

  // ── Launch ─────────────────────────────────────────────────────────────────
  launch: {
    /** Launch the named modpack. Push events carry state and log lines. */
    start(packName: string): Promise<void> {
      return window.electronAPI.launchStart(packName)
    },

    /** Send SIGTERM / TerminateProcess to the running Minecraft process. */
    kill(): Promise<void> {
      return window.electronAPI.launchKill()
    },

    /** Return the current in-memory log buffer as a single string. */
    getLog(): Promise<string> {
      return window.electronAPI.launchGetLog()
    },

    /** Open the modpack instance directory in the OS file explorer. */
    openFolder(packName: string): Promise<void> {
      return window.electronAPI.launchOpenFolder(packName)
    },

    /** Delete an installed modpack; resolves true when the directory is gone. */
    deletePack(packName: string): Promise<boolean> {
      return window.electronAPI.launchDeletePack(packName)
    },

    /** Create a desktop / start-menu shortcut for the given pack. */
    createShortcut(packName: string): Promise<void> {
      return window.electronAPI.launchCreateShortcut(packName)
    },

    /** Upload the latest crash report to a paste service; resolves with URL. */
    uploadCrash(packName: string): Promise<string> {
      return window.electronAPI.launchUploadCrash(packName)
    },

    /** Upload the current log to a paste service; resolves with URL. */
    uploadLog(): Promise<string> {
      return window.electronAPI.launchUploadLog()
    },
  },

  // ── Config ─────────────────────────────────────────────────────────────────
  config: {
    /** Fetch the persisted launcher config from disk. */
    get(): Promise<LauncherConfig> {
      return window.electronAPI.configGet()
    },

    /** Persist a partial config update (deep-merged on the main side). */
    save(config: Partial<LauncherConfig>): Promise<void> {
      return window.electronAPI.configSave(config)
    },

    /** Open an OS directory-picker dialog; resolves with the chosen path or
     *  null if the user cancelled. */
    pickDir(): Promise<string | null> {
      return window.electronAPI.configPickDir()
    },

    /** Open the directory that contains the launcher log files. */
    openLogs(): Promise<void> {
      return window.electronAPI.configOpenLogs()
    },

    /** Move modpack instances to a new directory. */
    moveInstances(targetDir: string): Promise<{ success: boolean; error?: string }> {
      return window.electronAPI.configMoveInstances(targetDir)
    },
  },

  // ── System ─────────────────────────────────────────────────────────────────
  system: {
    /** Return static system information (platform, memory, arch, version). */
    info(): Promise<SystemInfoResult> {
      return window.electronAPI.systemInfo()
    },

    /** Open the given URL in the default OS browser. */
    openUrl(url: string): Promise<void> {
      return window.electronAPI.systemOpenUrl(url)
    },
  },
} as const

// ─── Push-event helper ───────────────────────────────────────────────────────

/**
 * Subscribe to a push event emitted by the main process.
 *
 * @param channel  The IPC channel name (use IpcChannels constants where
 *                 possible to avoid typos).
 * @param cb       Listener invoked each time the event arrives.
 * @returns        An unsubscribe function — call it to remove the listener
 *                 (e.g. in a useEffect cleanup or store teardown).
 *
 * @example
 *   const off = onEvent('auth:profiles-updated', (profiles, selectedUuid) => { ... })
 *   // later:
 *   off()
 */
export function onEvent(
  channel: string,
  cb: (...args: unknown[]) => void,
): () => void {
  return window.electronAPI.on(channel, cb)
}

// Re-export profile type so consumers don't need a separate import for the
// most common use-case (reading profile data in the auth store).
export type { LauncherProfile }
