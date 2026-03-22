import { ipcMain, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo, ProgressInfo } from 'electron-updater'
import { IpcChannels } from '../ipc/channels'
import { getMainWindow } from '../app-state'

class UpdateService {
  private checking = false

  registerHandlers(): void {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = console

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      getMainWindow()?.webContents.send(IpcChannels.UPDATE_AVAILABLE, {
        version: info.version,
        releaseNotes: info.releaseNotes ?? null,
        releaseDate: info.releaseDate,
      })
    })

    autoUpdater.on('update-not-available', () => {
      getMainWindow()?.webContents.send(IpcChannels.UPDATE_NOT_AVAILABLE)
    })

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      getMainWindow()?.webContents.send(IpcChannels.UPDATE_PROGRESS, {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      })
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      getMainWindow()?.webContents.send(IpcChannels.UPDATE_DOWNLOADED, {
        version: info.version,
      })
    })

    autoUpdater.on('error', (err: Error) => {
      getMainWindow()?.webContents.send(IpcChannels.UPDATE_ERROR, {
        message: err.message,
      })
    })

    ipcMain.handle(IpcChannels.UPDATE_CHECK, async () => {
      if (this.checking) return
      this.checking = true
      try {
        await autoUpdater.checkForUpdates()
      } finally {
        this.checking = false
      }
    })

    ipcMain.handle(IpcChannels.UPDATE_DOWNLOAD, () => autoUpdater.downloadUpdate())

    ipcMain.on(IpcChannels.UPDATE_INSTALL, () => {
      autoUpdater.quitAndInstall(false, true)
    })

    // Auto-check 5 seconds after startup — only in packaged builds
    if (app.isPackaged) {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch((err: Error) => {
          console.warn('[updater] Auto-check failed:', err.message)
        })
      }, 5000)
    }
  }
}

export const updateService = new UpdateService()
