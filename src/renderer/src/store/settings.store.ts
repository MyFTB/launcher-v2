/**
 * Settings store — renderer side.
 *
 * Manages the LauncherConfig that is persisted to disk by the main process.
 * Tracks a `dirty` flag so the UI can prompt "unsaved changes" if needed.
 *
 * Also exports useSystemInfo() — a hook that lazily fetches SystemInfoResult
 * once and memoises it for the lifetime of the component tree.
 *
 * Usage:
 *   const { config, update, save } = useSettingsStore()
 *   const sysInfo = useSystemInfo()
 */

import { create } from 'zustand'
import { useEffect, useRef, useState } from 'react'
import type { LauncherConfig, SystemInfoResult } from '@shared/types'
import { ipc } from '@renderer/ipc/client'

// ─── State & actions ─────────────────────────────────────────────────────────

interface SettingsState {
  config: LauncherConfig | null
  loading: boolean
  dirty: boolean

  /** Fetch the persisted config from the main process. */
  load(): Promise<void>
  /**
   * Persist the current config to disk.  Sends the full config object so the
   * main process can do a complete write; clears the dirty flag on success.
   */
  save(): Promise<void>
  /**
   * Merge a partial config into the in-memory state and mark dirty.
   * Does nothing if config hasn't been loaded yet.
   */
  update(partial: Partial<LauncherConfig>): void
  /** Open the launcher log directory in the OS file explorer. */
  openLogs(): Promise<void>
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  config: null,
  loading: false,
  dirty: false,

  async load() {
    set({ loading: true })
    try {
      const config = await ipc.config.get()
      set({ config, dirty: false })
    } finally {
      set({ loading: false })
    }
  },

  async save() {
    const { config } = get()
    if (config === null) return
    await ipc.config.save(config)
    set({ dirty: false })
  },

  update(partial: Partial<LauncherConfig>) {
    const { config } = get()
    if (config === null) return
    set({ config: { ...config, ...partial }, dirty: true })
  },

  async openLogs() {
    await ipc.config.openLogs()
  },
}))

// ─── useSystemInfo hook ───────────────────────────────────────────────────────

/**
 * Lazily fetches SystemInfoResult on the first render and memoises the result
 * for the lifetime of the component.  Returns null while the request is
 * in-flight.
 *
 * @example
 *   const sysInfo = useSystemInfo()
 *   if (!sysInfo) return <Spinner />
 *   return <p>{sysInfo.platform} — {sysInfo.totalMemoryMb} MB</p>
 */
export function useSystemInfo(): SystemInfoResult | null {
  const [info, setInfo] = useState<SystemInfoResult | null>(null)
  // Guard against calling ipc.system.info() more than once (StrictMode double
  // invocation, concurrent re-renders, etc.).
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true

    ipc.system.info().then(setInfo).catch((err: unknown) => {
      // Silently swallow — callers receive null and can handle gracefully.
      console.error('[useSystemInfo] failed to fetch system info', err)
    })
  }, [])

  return info
}
