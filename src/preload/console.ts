import { contextBridge, ipcRenderer } from 'electron'
import type { IpcResponse, PushChannel } from '../shared/types'

type IpcChannelMap = typeof import('../main/ipc/channels').IpcChannels
type ConsoleChannelKey =
  | 'LAUNCH_STATE'
  | 'LAUNCH_LOG'
  | 'LAUNCH_CONSOLE_SELECT'
  | 'LAUNCH_SESSION_REMOVED'
  | 'LAUNCH_GET_SESSIONS'
  | 'LAUNCH_GET_LOG'
  | 'LAUNCH_KILL'
  | 'LAUNCH_REMOVE_SESSION'
  | 'LAUNCH_UPLOAD_LOG'
  | 'WINDOW_MINIMIZE'
  | 'WINDOW_MAXIMIZE'
  | 'WINDOW_CLOSE'
  | 'WINDOW_IS_MAXIMIZED'
  | 'WINDOW_MAXIMIZED_CHANGED'

// Sandboxed Electron preloads cannot require sibling output chunks. Keep this
// restricted channel table local so Rollup emits console.js as one file.
const IpcChannels = {
  LAUNCH_STATE: 'launch:state',
  LAUNCH_LOG: 'launch:log',
  LAUNCH_CONSOLE_SELECT: 'launch:console-select',
  LAUNCH_SESSION_REMOVED: 'launch:session-removed',
  LAUNCH_GET_SESSIONS: 'launch:get-sessions',
  LAUNCH_GET_LOG: 'launch:get-log',
  LAUNCH_KILL: 'launch:kill',
  LAUNCH_REMOVE_SESSION: 'launch:remove-session',
  LAUNCH_UPLOAD_LOG: 'launch:upload-log',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  WINDOW_MAXIMIZED_CHANGED: 'window:maximized-changed',
} as const satisfies Pick<IpcChannelMap, ConsoleChannelKey>

const allowedEvents = new Set<PushChannel>([
  IpcChannels.LAUNCH_STATE,
  IpcChannels.LAUNCH_LOG,
  IpcChannels.LAUNCH_CONSOLE_SELECT,
  IpcChannels.LAUNCH_SESSION_REMOVED,
  IpcChannels.WINDOW_MAXIMIZED_CHANGED,
])

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const response = await ipcRenderer.invoke(channel, payload) as IpcResponse<T>
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
    throw new Error('Ungültige IPC-Antwort vom Hauptprozess.')
  }
  if (!response.ok) {
    const error = new Error(response.error.message) as Error & { code?: string }
    error.code = response.error.code
    throw error
  }
  return response.value
}

const consoleApi = Object.freeze({
  platform: process.platform,
  launchGetSessions: () => invoke(IpcChannels.LAUNCH_GET_SESSIONS),
  launchGetLog: (sessionId: string) => invoke(IpcChannels.LAUNCH_GET_LOG, { sessionId }),
  launchKill: (sessionId: string) => invoke(IpcChannels.LAUNCH_KILL, { sessionId }),
  launchRemoveSession: (sessionId: string) => invoke(IpcChannels.LAUNCH_REMOVE_SESSION, { sessionId }),
  launchUploadLog: (sessionId: string) => invoke(IpcChannels.LAUNCH_UPLOAD_LOG, { sessionId }),
  windowMinimize: () => ipcRenderer.send(IpcChannels.WINDOW_MINIMIZE),
  windowMaximize: () => ipcRenderer.send(IpcChannels.WINDOW_MAXIMIZE),
  windowClose: () => ipcRenderer.send(IpcChannels.WINDOW_CLOSE),
  windowIsMaximized: () => invoke(IpcChannels.WINDOW_IS_MAXIMIZED),
  on: (channel: PushChannel, listener: (...args: unknown[]) => void) => {
    if (!allowedEvents.has(channel)) throw new Error(`IPC-Ereigniskanal ist nicht erlaubt: ${channel}`)
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
})

contextBridge.exposeInMainWorld('electronAPI', consoleApi)
