import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type {
  ProgressInfo,
  UpdateDownloadedEvent as UpdaterDownloadedEvent,
  UpdateInfo,
} from 'electron-updater'
import { CancellationToken } from 'builder-util-runtime'

import type { UpdateChannel } from '../../shared/types'
import { assertUpdateChannel } from '../../shared/validation'
import { compareUpdateVersions, isSupportedUpdateVersion } from '../../shared/version'
import { IpcChannels } from '../ipc/channels'
import { IpcError, noPayload, requireObject, secureHandle } from '../ipc/security'
import { getMainWindow } from '../app-state'
import { atomicWriteFile, configService } from './config.service'
import { logger } from '../logger'

interface UpdateCandidate {
  version: string
  channel: UpdateChannel
  downloadedFile?: string
}

interface UpdateJournal {
  version: 1
  sourceVersion: string
  targetVersion: string
  channel: UpdateChannel
  downloadedFile?: string
  configChecksum: string
  createdAt: string
}

function parseUpdateJournal(value: unknown): UpdateJournal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid update journal')
  const record = value as Record<string, unknown>
  if (
    record.version !== 1
    || typeof record.sourceVersion !== 'string'
    || !isSupportedUpdateVersion(record.sourceVersion)
    || typeof record.targetVersion !== 'string'
    || !isSupportedUpdateVersion(record.targetVersion)
    || (record.channel !== 'stable' && record.channel !== 'experimental')
    || typeof record.configChecksum !== 'string'
    || !/^[0-9a-f]{64}$/i.test(record.configChecksum)
    || typeof record.createdAt !== 'string'
    || !Number.isFinite(Date.parse(record.createdAt))
    || (record.downloadedFile !== undefined
      && (typeof record.downloadedFile !== 'string' || record.downloadedFile.length > 4_096 || !path.isAbsolute(record.downloadedFile)))
  ) throw new Error('Invalid update journal')
  return record as unknown as UpdateJournal
}

class UpdateService {
  private selectedChannel: UpdateChannel = 'stable'
  private available: UpdateCandidate | null = null
  private downloaded: UpdateCandidate | null = null
  private downloadCancellation: CancellationToken | null = null
  private downloadOperation: Promise<void> | null = null
  private downloadContext: { channel: UpdateChannel; generation: number } | null = null
  private checkOperation: Promise<void> | null = null
  private checkContext: { channel: UpdateChannel; generation: number } | null = null
  private channelGeneration = 0
  private initialized = false
  private handlersRegistered = false

  isBusy(): boolean {
    return this.downloadOperation !== null || this.checkOperation !== null
  }

  private assertDataDirStable(): void {
    if (configService.isDataDirMigrationActive()) {
      throw new IpcError('CONFLICT', 'Während der Datenmigration sind keine Update-Aktionen möglich.')
    }
  }

  private get journalPath(): string {
    return path.join(app.getPath('userData'), 'update-journal.json')
  }

  private configure(channel: UpdateChannel): void {
    this.selectedChannel = channel
    autoUpdater.channel = channel === 'experimental' ? 'experimental' : 'latest'
    autoUpdater.allowPrerelease = channel === 'experimental'
    autoUpdater.allowDowngrade = false
  }

  private check(): Promise<void> {
    this.assertDataDirStable()
    if (this.checkOperation) return this.checkOperation
    const context = { channel: this.selectedChannel, generation: this.channelGeneration }
    this.checkContext = context
    const operation = autoUpdater.checkForUpdates().then(() => undefined)
    this.checkOperation = operation
    void operation.finally(() => {
      if (this.checkOperation === operation) this.checkOperation = null
      if (this.checkContext === context) this.checkContext = null
    }).catch(() => {})
    return operation
  }

  private async configChecksum(): Promise<string> {
    try {
      const contents = await fs.readFile(configService.getConfigPath())
      return crypto.createHash('sha256').update(contents).digest('hex')
    } catch {
      return crypto.createHash('sha256').update(JSON.stringify(configService.get())).digest('hex')
    }
  }

  private async hasConfigBackup(): Promise<boolean> {
    try {
      await fs.access(configService.getBackupPath())
      return true
    } catch {
      return false
    }
  }

  private async recoverUpdateJournal(): Promise<void> {
    try {
      const stat = await fs.lstat(this.journalPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
        throw new Error('Update journal is not a safe regular file')
      }
      const raw = await fs.readFile(this.journalPath, 'utf8')
      const journal = parseUpdateJournal(JSON.parse(raw) as unknown)
      const checksum = await this.configChecksum()
      if (app.getVersion() === journal.targetVersion && checksum === journal.configChecksum) {
        await fs.rm(this.journalPath, { force: true })
        logger.info('[UpdateService] Successful update journal cleared')
        return
      }
      configService.setExternalRecovery({
        status: 'needs-recovery',
        source: 'update-journal',
        message: 'Ein Launcher-Update wurde nicht vollständig bestätigt. Deine Daten wurden nicht überschrieben.',
        brokenPath: this.journalPath,
        backupAvailable: await this.hasConfigBackup(),
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        configService.setExternalRecovery({
          status: 'needs-recovery',
          source: 'update-journal',
          message: 'Das Update-Protokoll ist beschädigt. Bitte prüfe die Daten vor dem Fortfahren.',
          brokenPath: this.journalPath,
          backupAvailable: await this.hasConfigBackup(),
        })
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.configure(configService.get().updateChannel ?? 'stable')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = logger
    await this.recoverUpdateJournal()
    this.initialized = true
  }

  async clearRecoveryJournal(): Promise<void> {
    await fs.rm(this.journalPath, { force: true })
  }

  registerHandlers(): void {
    if (!this.initialized) throw new Error('UpdateService must be initialized before IPC registration')
    if (this.handlersRegistered) return
    this.handlersRegistered = true

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      const context = this.checkContext
      if (!context || context.generation !== this.channelGeneration || context.channel !== this.selectedChannel) return
      if (!isSupportedUpdateVersion(info.version)) {
        logger.warn('[UpdateService] Updater returned an invalid version')
        return
      }
      if (compareUpdateVersions(info.version, app.getVersion()) <= 0) {
        logger.warn(`[UpdateService] Ignored non-newer ${context.channel} candidate ${info.version}`)
        this.available = null
        getMainWindow()?.webContents.send(IpcChannels.UPDATE_NOT_AVAILABLE)
        return
      }
      this.available = { version: info.version, channel: context.channel }
      this.downloaded = null
      getMainWindow()?.webContents.send(IpcChannels.UPDATE_AVAILABLE, {
        version: info.version,
        releaseNotes: info.releaseNotes ?? null,
        releaseDate: info.releaseDate,
        channel: context.channel,
      })
    })
    autoUpdater.on('update-not-available', () => {
      const context = this.checkContext
      if (!context || context.generation !== this.channelGeneration || context.channel !== this.selectedChannel) return
      this.available = null
      getMainWindow()?.webContents.send(IpcChannels.UPDATE_NOT_AVAILABLE)
    })
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      const context = this.downloadContext
      if (!context || context.generation !== this.channelGeneration || context.channel !== this.selectedChannel) return
      getMainWindow()?.webContents.send(IpcChannels.UPDATE_PROGRESS, {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      })
    })
    autoUpdater.on('update-downloaded', (info: UpdaterDownloadedEvent) => {
      const context = this.downloadContext
      if (!context || context.generation !== this.channelGeneration || context.channel !== this.selectedChannel) {
        logger.warn('[UpdateService] Ignored a downloaded candidate from a superseded channel')
        return
      }
      if (!isSupportedUpdateVersion(info.version) || !this.available || this.available.version !== info.version) {
        logger.warn('[UpdateService] Ignored a downloaded candidate that does not match the checked update')
        return
      }
      this.downloaded = {
        version: info.version,
        channel: context.channel,
        downloadedFile: info.downloadedFile,
      }
      getMainWindow()?.webContents.send(IpcChannels.UPDATE_DOWNLOADED, {
        version: info.version,
        channel: context.channel,
      })
    })
    autoUpdater.on('error', (error: Error) => {
      logger.warn('[UpdateService] Updater error:', error)
      getMainWindow()?.webContents.send(IpcChannels.UPDATE_ERROR, {
        message: 'Das Launcher-Update ist fehlgeschlagen. Details stehen im Launcher-Log.',
      })
    })

    secureHandle(IpcChannels.UPDATE_CHECK, { validate: noPayload }, () => this.check())
    secureHandle(IpcChannels.UPDATE_DOWNLOAD, { validate: noPayload }, async () => {
      this.assertDataDirStable()
      if (this.downloadOperation) throw new IpcError('CONFLICT', 'Ein Update wird bereits heruntergeladen.')
      if (!this.available || this.available.channel !== this.selectedChannel) {
        throw new IpcError('CONFLICT', 'Für den gewählten Kanal ist kein passendes Update verfügbar.')
      }
      const cancellation = new CancellationToken()
      const context = { channel: this.selectedChannel, generation: this.channelGeneration }
      this.downloadCancellation = cancellation
      this.downloadContext = context
      const operation = autoUpdater.downloadUpdate(cancellation).then(() => undefined)
      this.downloadOperation = operation
      try {
        await operation
      } finally {
        if (this.downloadCancellation === cancellation) this.downloadCancellation = null
        if (this.downloadContext === context) this.downloadContext = null
        if (this.downloadOperation === operation) this.downloadOperation = null
      }
    })
    secureHandle(IpcChannels.UPDATE_INSTALL, { validate: noPayload }, async () => {
      this.assertDataDirStable()
      const candidate = this.downloaded
      if (!candidate || candidate.channel !== this.selectedChannel) {
        throw new IpcError('CONFLICT', 'Das geladene Update gehört nicht zum aktuell gewählten Kanal.')
      }
      if (candidate.downloadedFile) {
        const stat = await fs.lstat(candidate.downloadedFile).catch(() => null)
        if (!stat?.isFile() || stat.isSymbolicLink()) {
          throw new IpcError('IO_ERROR', 'Die geladene Update-Datei ist nicht mehr verfügbar.')
        }
      }
      await configService.flush()
      const journal: UpdateJournal = {
        version: 1,
        sourceVersion: app.getVersion(),
        targetVersion: candidate.version,
        channel: candidate.channel,
        ...(candidate.downloadedFile ? { downloadedFile: candidate.downloadedFile } : {}),
        configChecksum: await this.configChecksum(),
        createdAt: new Date().toISOString(),
      }
      await atomicWriteFile(this.journalPath, `${JSON.stringify(journal, null, 2)}\n`)
      logger.info(`[UpdateService] Installing confirmed ${candidate.channel} update ${candidate.version}`)
      autoUpdater.quitAndInstall(false, true)
    })
    secureHandle(
      IpcChannels.UPDATE_SET_CHANNEL,
      {
        validate: (value): { channel: UpdateChannel } => {
          const payload = requireObject(value)
          return { channel: assertUpdateChannel(payload.channel) }
        },
      },
      async (_event, { channel }) => {
        this.assertDataDirStable()
        if (channel === this.selectedChannel) return
        this.channelGeneration++
        this.available = null
        this.downloaded = null
        this.downloadCancellation?.cancel()
        await this.downloadOperation?.catch(() => {})
        await this.checkOperation?.catch(() => {})
        configService.merge({ updateChannel: channel })
        await configService.save()
        this.configure(channel)
        logger.info(`[UpdateService] Subscribed to ${channel}; downgrades remain disabled`)
        await this.check()
      },
    )

    if (app.isPackaged) {
      setTimeout(() => {
        void this.check().catch((error: unknown) => {
          logger.warn('[UpdateService] Automatic update check failed:', error)
        })
      }, 5_000)
    }
  }
}

export const updateService = new UpdateService()
