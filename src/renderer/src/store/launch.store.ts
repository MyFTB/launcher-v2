import { create } from 'zustand'
import type {
  LaunchConsoleSelectEvent,
  LaunchLogEvent,
  LaunchSession,
  LaunchSessionRemovedEvent,
  LaunchStartResult,
  LaunchStateEvent,
} from '@shared/types'
import { ipc, onEvent } from '@renderer/ipc/client'

const MAX_LOG_LINES = 10_000

export interface LaunchSessionView extends LaunchSession {
  logLines: string[]
}

interface LaunchStoreState {
  sessions: Record<string, LaunchSessionView>
  selectedSessionId: string | null
  launchError: string | null
  launch(packName: string): Promise<LaunchStartResult>
  kill(sessionId: string): Promise<void>
  fetchLog(sessionId: string): Promise<void>
  selectSession(sessionId: string): void
  openFolder(packName: string): Promise<void>
  deletePack(packName: string): Promise<{ success: boolean; error?: string }>
  createShortcut(packName: string): Promise<void>
  initListeners(): void
}

let listenersInitialized = false
let logFlushTimer: ReturnType<typeof setTimeout> | null = null
let pendingSelectionId: string | null = null
const pendingLogs = new Map<string, string[]>()

function flushLogs(): void {
  if (logFlushTimer) clearTimeout(logFlushTimer)
  logFlushTimer = null
  const batches = new Map(pendingLogs)
  pendingLogs.clear()
  useLaunchStore.setState((state) => {
    const sessions = { ...state.sessions }
    for (const [sessionId, lines] of batches) {
      const session = sessions[sessionId]
      if (!session) continue
      const combined = session.logLines.length + lines.length > MAX_LOG_LINES
        ? [...session.logLines, ...lines].slice(-MAX_LOG_LINES)
        : [...session.logLines, ...lines]
      sessions[sessionId] = { ...session, logLines: combined }
    }
    return { sessions }
  })
}

function mergeLogHistory(history: string[], current: string[]): string[] {
  if (current.length === 0) return history.slice(-MAX_LOG_LINES)
  if (history.length === 0) return current.slice(-MAX_LOG_LINES)
  if (current.length <= history.length && current.every((line, index) => line === history[index])) {
    return history.slice(-MAX_LOG_LINES)
  }
  const maximumOverlap = Math.min(history.length, current.length)
  for (let overlap = maximumOverlap; overlap > 0; overlap--) {
    let matches = true
    for (let index = 0; index < overlap; index++) {
      if (history[history.length - overlap + index] !== current[index]) {
        matches = false
        break
      }
    }
    if (matches) return [...history, ...current.slice(overlap)].slice(-MAX_LOG_LINES)
  }
  return [...history, ...current].slice(-MAX_LOG_LINES)
}

function queueLog(event: LaunchLogEvent): void {
  const lines = pendingLogs.get(event.sessionId) ?? []
  lines.push(event.line)
  pendingLogs.set(event.sessionId, lines)
  if (!logFlushTimer) logFlushTimer = setTimeout(flushLogs, 50)
}

export const useLaunchStore = create<LaunchStoreState>()((set, get) => ({
  sessions: {},
  selectedSessionId: null,
  launchError: null,

  async launch(packName) {
    set({ launchError: null })
    try {
      const result = await ipc.launch.start(packName)
      set((state) => ({
        sessions: {
          ...state.sessions,
          [result.session.id]: {
            ...result.session,
            logLines: state.sessions[result.session.id]?.logLines ?? [],
          },
        },
        selectedSessionId: result.session.id,
      }))
      return result
    } catch (error) {
      set({ launchError: error instanceof Error ? error.message : 'Der Start ist fehlgeschlagen.' })
      throw error
    }
  },

  async kill(sessionId) {
    await ipc.launch.kill(sessionId)
  },

  async fetchLog(sessionId) {
    flushLogs()
    const text = await ipc.launch.getLog(sessionId)
    const history = text ? text.split('\n').slice(-MAX_LOG_LINES) : []
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, logLines: mergeLogHistory(history, session.logLines) },
        },
      }
    })
  },

  selectSession(sessionId) {
    if (get().sessions[sessionId]) set({ selectedSessionId: sessionId })
  },

  openFolder: (packName) => ipc.launch.openFolder(packName),
  deletePack: (packName) => ipc.launch.deletePack(packName),
  createShortcut: (packName) => ipc.launch.createShortcut(packName),

  initListeners() {
    if (listenersInitialized) return
    listenersInitialized = true

    void ipc.launch.getSessions().then((snapshot) => {
      const requestedSelection = pendingSelectionId
      set((state) => {
        const sessions = { ...state.sessions }
        for (const session of snapshot) {
          const existing = sessions[session.id]
          if (existing && existing.updatedAt >= session.updatedAt) continue
          sessions[session.id] = {
            ...session,
            logLines: existing?.logLines ?? [],
          }
        }
        const selectedSessionId = requestedSelection && sessions[requestedSelection]
          ? requestedSelection
          : state.selectedSessionId
            ?? snapshot.find((session) => session.state === 'running' || session.state === 'launching')?.id
            ?? snapshot[0]?.id
            ?? null
        return { sessions, selectedSessionId }
      })
      if (
        requestedSelection
        && snapshot.some((session) => session.id === requestedSelection)
        && pendingSelectionId === requestedSelection
      ) pendingSelectionId = null
    }).catch((error: unknown) => {
      set({ launchError: error instanceof Error ? error.message : 'Sitzungen konnten nicht geladen werden.' })
    })

    onEvent('launch:state', (...args: unknown[]) => {
      const event = args[0] as LaunchStateEvent
      if (!event?.session?.id) return
      const requested = pendingSelectionId === event.session.id
      if (requested) pendingSelectionId = null
      set((state) => ({
        sessions: {
          ...state.sessions,
          [event.session.id]: {
            ...event.session,
            logLines: state.sessions[event.session.id]?.logLines ?? [],
          },
        },
        selectedSessionId: requested ? event.session.id : state.selectedSessionId ?? event.session.id,
      }))
    })

    onEvent('launch:log', (...args: unknown[]) => {
      const event = args[0] as LaunchLogEvent
      if (event?.sessionId && typeof event.line === 'string') queueLog(event)
    })

    onEvent('launch:console-select', (...args: unknown[]) => {
      const event = args[0] as LaunchConsoleSelectEvent
      if (!event?.sessionId) return
      if (!get().sessions[event.sessionId]) {
        pendingSelectionId = event.sessionId
        return
      }
      pendingSelectionId = null
      set({ selectedSessionId: event.sessionId })
      void get().fetchLog(event.sessionId).catch(() => {})
    })

    onEvent('launch:session-removed', (...args: unknown[]) => {
      const event = args[0] as LaunchSessionRemovedEvent
      if (!event?.sessionId) return
      set((state) => {
        if (!state.sessions[event.sessionId]) return state
        const { [event.sessionId]: _removed, ...sessions } = state.sessions
        const selectedSessionId = state.selectedSessionId === event.sessionId
          ? Object.values(sessions).sort((a, b) => b.startedAt - a.startedAt)[0]?.id ?? null
          : state.selectedSessionId
        return { sessions, selectedSessionId }
      })
    })
  },
}))

export function usePackLaunchSession(packName: string): LaunchSessionView | undefined {
  return useLaunchStore((state) => Object.values(state.sessions)
    .filter((session) => session.packName === packName)
    .sort((a, b) => b.startedAt - a.startedAt)[0])
}
