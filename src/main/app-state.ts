/**
 * Holds shared mutable app state that both index.ts and services need,
 * without creating circular imports.
 *
 * index.ts  →  app-state.ts  ←  services
 * index.ts  →  router.ts     →  services
 */
import type { BrowserWindow } from 'electron'

let _mainWindow: BrowserWindow | null = null
let _launchPackArg: string | null = null

export function setMainWindow(win: BrowserWindow): void {
  _mainWindow = win
}

export function getMainWindow(): BrowserWindow | null {
  return _mainWindow
}

export function setLaunchPackArg(pack: string | null): void {
  _launchPackArg = pack
}

export function getLaunchPackArg(): string | null {
  return _launchPackArg
}
