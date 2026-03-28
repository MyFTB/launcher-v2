/**
 * Modpack store — renderer side.
 *
 * Manages:
 *   - remotePacks   — the server-side list of available packs
 *   - installedPacks — packs present on disk (via 'install:get-installed')
 *   - recentPacks   — intersection of installedPacks and config.lastPlayedPacks
 *   - in-progress installation state (progress, pending feature selection)
 *
 * Push events from the main process ('install:progress', 'install:complete',
 * 'install:needs-features') are wired in initListeners().
 *
 * Usage:
 *   // App root — call once:
 *   useModpackStore.getState().initListeners()
 *
 *   // Fetch on mount:
 *   useModpackStore.getState().fetchRemote()
 *   useModpackStore.getState().fetchInstalled()
 */

import { create } from 'zustand'
import type {
  Feature,
  InstallCompleteEvent,
  InstallNeedsFeaturesEvent,
  InstallProgressEvent,
  ModpackManifestReference,
} from '@shared/types'
import { ipc, onEvent } from '@renderer/ipc/client'

// ─── State & actions ─────────────────────────────────────────────────────────

/** Lightweight shape returned by installGetInstalled — not a full manifest. */
type InstalledPackInfo = { name: string; version: string }

interface ModpackState {
  // ── Data ────────────────────────────────────────────────────────────────────
  remotePacks: ModpackManifestReference[]
  installedPacks: InstalledPackInfo[]
  /** Installed packs ordered by lastPlayedPacks config key. */
  recentPacks: InstalledPackInfo[]

  // ── Loading flags ───────────────────────────────────────────────────────────
  remoteLoading: boolean
  installedLoading: boolean

  // ── Install state ───────────────────────────────────────────────────────────
  installProgress: InstallProgressEvent | null
  /** True while an install is in-flight (before complete/cancel). */
  installPending: boolean
  /**
   * Set by 'install:needs-features' push event.  UI should present a feature
   * selection dialog, then call installPack() again with selectedFeatures.
   */
  pendingFeatures: Feature[] | null

  // ── Actions ─────────────────────────────────────────────────────────────────
  fetchRemote(): Promise<void>
  fetchInstalled(): Promise<void>
  /**
   * Derive recentPacks from the current installedPacks and the
   * lastPlayedPacks list stored in config.  Pass the raw lastPlayedPacks
   * array from the settings store whenever it changes.
   */
  fetchRecent(lastPlayedPacks: string[]): void
  installPack(reference: ModpackManifestReference, selectedFeatures?: string[]): Promise<void>
  cancelInstall(): Promise<void>
  deletePack(packName: string): Promise<void>
  initListeners(): void
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useModpackStore = create<ModpackState>()((set, get) => ({
  remotePacks: [],
  installedPacks: [],
  recentPacks: [],
  remoteLoading: false,
  installedLoading: false,
  installProgress: null,
  installPending: false,
  pendingFeatures: null,

  async fetchRemote() {
    set({ remoteLoading: true })
    try {
      const packs = await ipc.packs.getRemote()
      set({ remotePacks: packs })
    } finally {
      set({ remoteLoading: false })
    }
  },

  async fetchInstalled() {
    set({ installedLoading: true })
    try {
      // NOTE: 'install:get-installed' must be registered in the install service
      // on the main-process side before this call will resolve.
      const packs = await ipc.install.getInstalled()
      set({ installedPacks: packs })
    } finally {
      set({ installedLoading: false })
    }
  },

  fetchRecent(lastPlayedPacks: string[]) {
    const { installedPacks } = get()
    // Preserve the order defined by lastPlayedPacks (most recent first).
    const recent = lastPlayedPacks
      .map((name) => installedPacks.find((p) => p.name === name))
      .filter((p): p is InstalledPackInfo => p !== undefined)
    set({ recentPacks: recent })
  },

  async installPack(reference: ModpackManifestReference, selectedFeatures?: string[]) {
    // Clear any previous feature-selection prompt when the user confirms.
    set({ installPending: true, installProgress: null, pendingFeatures: null })
    try {
      await ipc.install.installModpack(reference, selectedFeatures)
      // Actual completion arrives via 'install:complete' push event.
    } catch (err) {
      // Surface early errors (e.g. network unreachable before first byte).
      set({ installPending: false })
      throw err
    }
  },

  async cancelInstall() {
    await ipc.install.cancel()
    set({ installPending: false, installProgress: null })
  },

  async deletePack(packName: string) {
    await ipc.launch.deletePack(packName)
    // Refresh installed list after deletion.
    await get().fetchInstalled()
  },

  initListeners() {
    // Installation progress ticker.
    onEvent('install:progress', (...args: unknown[]) => {
      const event = args[0] as InstallProgressEvent
      set({ installProgress: event })
    })

    // Installation finished (success or failure).
    onEvent('install:complete', (...args: unknown[]) => {
      const event = args[0] as InstallCompleteEvent
      set({ installPending: false, installProgress: null })
      if (event.success) {
        // Refresh installed list so the newly installed pack appears immediately.
        void get().fetchInstalled()
      }
    })

    // Main process discovered optional features; UI must prompt user.
    onEvent('install:needs-features', (...args: unknown[]) => {
      const event = args[0] as InstallNeedsFeaturesEvent
      // Pause the "pending" spinner until user confirms feature selection.
      set({ installPending: false, pendingFeatures: event.features })
    })
  },
}))
