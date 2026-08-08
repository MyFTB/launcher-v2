import type { BrowserWindow } from 'electron'
import { shell } from 'electron'

import { IpcChannels } from '../ipc/channels'
import { isTrustedRendererUrl } from '../ipc/security'
import { isAllowedExternalUrl } from './url-policy'
import { logger } from '../logger'

export function hardenBrowserWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url)
    } else {
      logger.warn('[WindowSecurity] Blocked window-open request')
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return
    event.preventDefault()
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    else logger.warn('[WindowSecurity] Blocked renderer navigation')
  })

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
    logger.warn('[WindowSecurity] Blocked webview attachment')
  })
}

export function wireMaximizeEvents(window: BrowserWindow): void {
  const publish = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(IpcChannels.WINDOW_MAXIMIZED_CHANGED, {
        maximized: window.isMaximized(),
      })
    }
  }
  window.on('maximize', publish)
  window.on('unmaximize', publish)
  window.on('restore', publish)
}
