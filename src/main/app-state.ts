import type { BrowserWindow, WebContents } from 'electron'

export type WindowRole = 'launcher' | 'console'

let mainWindow: BrowserWindow | null = null
let launchPackArg: string | null = null
const trustedWindows = new Map<number, { window: BrowserWindow; role: WindowRole }>()

export function registerTrustedWindow(window: BrowserWindow, role: WindowRole): void {
  const webContentsId = window.webContents.id
  trustedWindows.set(webContentsId, { window, role })
  window.once('closed', () => trustedWindows.delete(webContentsId))
}

export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window
  registerTrustedWindow(window, 'launcher')
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function getTrustedWindow(sender: WebContents): { window: BrowserWindow; role: WindowRole } | null {
  const entry = trustedWindows.get(sender.id)
  if (!entry || entry.window.isDestroyed() || entry.window.webContents !== sender) return null
  return entry
}

export function getTrustedWindows(role?: WindowRole): BrowserWindow[] {
  return [...trustedWindows.values()]
    .filter((entry) => !entry.window.isDestroyed() && (!role || entry.role === role))
    .map((entry) => entry.window)
}

export function setLaunchPackArg(pack: string | null): void {
  launchPackArg = pack
}

export function getLaunchPackArg(): string | null {
  return launchPackArg
}
