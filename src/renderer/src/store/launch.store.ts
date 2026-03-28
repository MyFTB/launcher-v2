/**
 * Launch store — renderer side.
 *
 * Tracks the lifecycle of a running Minecraft process, the log buffer, and
 * exposes actions that map 1-to-1 onto IPC calls.
 *
 * Push events from the main process ('launch:state', 'launch:log') are wired
 * in initListeners().
 *
 * Usage:
 *   // App root — call once:
 *   useLaunchStore.getState().initListeners()
 *
 *   // In components:
 *   const { launchState, isRunning, launch, kill } = useLaunchStore()
 */

import { create } from 'zustand'
import type { LaunchState, LaunchStateEvent, LaunchLogEvent } from '@shared/types'
import { ipc, onEvent } from '@renderer/ipc/client'

// ─── State & actions ─────────────────────────────────────────────────────────

interface LaunchStoreState {
  // ── Data ────────────────────────────────────────────────────────────────────
  /** Most-recent state emitted by the main process, null before first launch. */
  launchState: LaunchState | null
  /** Convenience boolean derived from launchState. */
  isRunning: boolean
  /** Rolling log lines from the Minecraft process (stdout + stderr). */
  logLines: string[]
  /** Pack name that is currently launching / has been launched. */
  currentPack: string | null

  // ── Actions ─────────────────────────────────────────────────────────────────
  launch(packName: string): Promise<void>
  kill(): Promise<void>
  /** Pull the full in-memory log buffer from main and replace logLines. */
  fetchLog(): Promise<void>
  openFolder(packName: string): Promise<void>
  createShortcut(packName: string): Promise<void>
  /** Upload the current log to a paste service; resolves with the URL. */
  uploadLog(): Promise<string>
  /** Upload the latest crash report for packName; resolves with the URL. */
  uploadCrash(packName: string): Promise<string>
  /** Subscribe to push events from the main process.  Call once at startup. */
  initListeners(): void
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useLaunchStore = create<LaunchStoreState>()((set) => ({
  launchState: null,
  isRunning: false,
  logLines: [],
  currentPack: null,

  async launch(packName: string) {
    set({ currentPack: packName, logLines: [] })
    try {
      await ipc.launch.start(packName)
      // Further state updates arrive via 'launch:state' push events.
    } catch (err) {
      set({ currentPack: null })
      throw err
    }
  },

  async kill() {
    await ipc.launch.kill()
  },

  async fetchLog() {
    const raw = await ipc.launch.getLog()
    // The main process returns a single string; split on newlines for display.
    set({ logLines: raw.split('\n') })
  },

  async openFolder(packName: string) {
    await ipc.launch.openFolder(packName)
  },

  async createShortcut(packName: string) {
    await ipc.launch.createShortcut(packName)
  },

  async uploadLog(): Promise<string> {
    return ipc.launch.uploadLog()
  },

  async uploadCrash(packName: string): Promise<string> {
    return ipc.launch.uploadCrash(packName)
  },

  initListeners() {
    // Minecraft process lifecycle state changes.
    onEvent('launch:state', (...args: unknown[]) => {
      const event = args[0] as LaunchStateEvent
      const running = event.state === 'launching' || event.state === 'running'
      set({
        launchState: event.state,
        isRunning: running,
        // Clear the running pack once the game closes/crashes so badges disappear.
        ...(!running && { currentPack: null }),
      })
    })

    // Individual log lines streamed from the Minecraft process.
    // Cap at 5 000 lines to prevent unbounded memory growth.
    onEvent('launch:log', (...args: unknown[]) => {
      const event = args[0] as LaunchLogEvent
      set((s) => {
        const next = [...s.logLines, event.line]
        return { logLines: next.length > 5000 ? next.slice(next.length - 5000) : next }
      })
    })
  },
}))
