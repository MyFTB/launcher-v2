import { ipcMain, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo, ProgressInfo } from 'electron-updater'
import { IpcChannels } from '../ipc/channels'
import { getMainWindow } from '../app-state'
import { configService } from './config.service'
import { logger } from '../logger'

class UpdateService {
  private checking = false

  registerHandlers(): void {
    const channel = configService.get().updateChannel ?? 'stable'
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = logger
    autoUpdater.channel = channel === 'experimental' ? 'experimental' : 'latest'
    autoUpdater.allowPrerelease = channel === 'experimental'

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      logger.info(`[UpdateService] Update available: v${info.version}`)
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
      logger.info(`[UpdateService] Update downloaded: v${info.version}`)
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
      logger.info('[UpdateService] Applying update and restarting...')
      autoUpdater.quitAndInstall(false, true)
    })

    ipcMain.on(IpcChannels.UPDATE_SET_CHANNEL, (_event, ch: 'stable' | 'experimental') => {
      logger.info(`[UpdateService] Update channel changed to: ${ch}`)
      autoUpdater.channel = ch === 'experimental' ? 'experimental' : 'latest'
      autoUpdater.allowPrerelease = ch === 'experimental'
    })

    // Auto-check 5 seconds after startup — only in packaged builds
    if (app.isPackaged) {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch((err: Error) => {
          logger.warn('[updater] Auto-check failed:', err.message)
        })
      }, 5000)
    }
  }
}

export const updateService = new UpdateService()
