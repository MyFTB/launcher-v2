import { app, BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { is } from '@electron-toolkit/utils'

import type {
  ConfigResolveRecoveryPayload,
  DataRecoveryAction,
  RendererConfigPatch,
} from '../../shared/types'
import {
  assertSessionId,
  ValidationError,
  validateRendererConfigPatch,
} from '../../shared/validation'
import { IpcChannels } from './channels'
import { noPayload, requireObject, secureHandle, secureOn } from './security'
import { configService } from '../services/config.service'
import { credentialService } from '../services/credential.service'
import { authService } from '../services/auth.service'
import { modpackApiService } from '../services/modpack-api.service'
import { installService } from '../services/install.service'
import { launchService } from '../services/launch.service'
import { discordService } from '../services/discord.service'
import { updateService } from '../services/update.service'
import {
  getLaunchPackArg,
  getMainWindow,
  registerTrustedWindow,
} from '../app-state'
import {
  clearDataDirPointer,
  getPointerPath,
  writeDataDirPointer,
} from '../bootstrap'
import { assertAllowedExternalUrl } from '../security/url-policy'
import { hardenBrowserWindow, wireMaximizeEvents } from '../security/window-security'

function targetDirPayload(value: unknown): { targetDir: string } {
  const payload = requireObject(value)
  if (typeof payload.targetDir !== 'string' || payload.targetDir.length > 4_096) {
    throw new ValidationError('Der Zielordner ist ungültig.')
  }
  return { targetDir: payload.targetDir }
}

function recoveryPayload(value: unknown): ConfigResolveRecoveryPayload {
  const payload = requireObject(value)
  const actions: DataRecoveryAction[] = ['restore-backup', 'locate-data', 'fresh-start', 'accept-current']
  if (!actions.includes(payload.action as DataRecoveryAction)) {
    throw new ValidationError('Die Wiederherstellungsaktion ist ungültig.')
  }
  if (payload.dataDir !== undefined && typeof payload.dataDir !== 'string') {
    throw new ValidationError('Der Datenordner ist ungültig.')
  }
  return {
    action: payload.action as DataRecoveryAction,
    ...(typeof payload.dataDir === 'string' ? { dataDir: payload.dataDir } : {}),
  }
}

function optionalSessionPayload(value: unknown): { sessionId?: string } {
  const payload = value === undefined ? {} : requireObject(value)
  return payload.sessionId === undefined
    ? {}
    : { sessionId: assertSessionId(payload.sessionId) }
}

export async function registerIpcHandlers(): Promise<void> {
  await updateService.initialize()
  secureHandle(IpcChannels.RENDERER_ARRIVED, { validate: noPayload }, async () => {
    const window = getMainWindow()
    if (!window) return
    if (configService.isFirstStart()) {
      window.webContents.send(IpcChannels.WELCOME_MESSAGE, {
        installation_dir: configService.getResourceDir(),
      })
    }
    const packArg = getLaunchPackArg()
    if (packArg) window.webContents.send(IpcChannels.LAUNCH_PACK, packArg)
  })

  secureHandle(IpcChannels.CONFIG_GET, { validate: noPayload }, () => configService.getPublic())
  secureHandle(
    IpcChannels.CONFIG_SAVE,
    { validate: validateRendererConfigPatch },
    async (_event, patch: RendererConfigPatch) => {
      if (configService.isDataDirMigrationActive()) {
        throw new ValidationError('Während der Datenmigration können Einstellungen nicht gespeichert werden.')
      }
      configService.merge(patch)
      await configService.save()
    },
  )
  secureHandle(IpcChannels.CONFIG_PICK_DIR, { validate: noPayload }, async () => {
    const window = getMainWindow()
    const options: OpenDialogOptions = {
      title: 'Bitte wähle den Speicherort für installierte Modpacks',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })
  secureHandle(IpcChannels.CONFIG_OPEN_LOGS, { validate: noPayload }, async () => {
    await shell.openPath(app.getPath('logs'))
  })
  secureHandle(IpcChannels.CONFIG_CHANGE_DATA_DIR, { validate: noPayload }, async () => {
    const window = getMainWindow()
    const options: OpenDialogOptions = {
      title: 'Neuen Speicherort für Launcher-Daten wählen',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, cancelled: true }
    }
    if (installService.isBusy()) {
      return { success: false, error: 'Eine Installation oder Reparatur läuft noch.' }
    }
    if (launchService.hasActiveSessions()) {
      return { success: false, error: 'Beende alle laufenden Minecraft-Sitzungen vor der Datenmigration.' }
    }
    if (authService.isBusy()) {
      return { success: false, error: 'Eine Anmeldung oder Token-Aktualisierung läuft noch.' }
    }
    if (updateService.isBusy()) {
      return { success: false, error: 'Eine Update-Prüfung oder ein Download läuft noch.' }
    }

    // migrateDataDir reserves the data root synchronously before flushing the
    // external credential queue, so no new mutating operation can race the copy.
    const migration = await configService.migrateDataDir(
      result.filePaths[0],
      () => credentialService.flush(),
    )
    if (migration.success) {
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 400)
    }
    return migration
  })
  secureHandle(
    IpcChannels.CONFIG_MOVE_INSTANCES,
    { validate: targetDirPayload },
    async (_event, payload) => {
      if (installService.isBusy()) {
        return { success: false, error: 'Eine Installation oder Reparatur läuft noch.' }
      }
      if (launchService.hasActiveSessions()) {
        return { success: false, error: 'Beende alle laufenden Minecraft-Sitzungen vor dem Verschieben.' }
      }
      // moveInstances reserves the storage root synchronously before its first await.
      return configService.moveInstances(payload.targetDir)
    },
  )
  secureHandle(IpcChannels.CONFIG_GET_RECOVERY, { validate: noPayload }, () => (
    configService.getRecoveryState()
  ))
  secureHandle(
    IpcChannels.CONFIG_RESOLVE_RECOVERY,
    { validate: recoveryPayload },
    async (_event, payload) => {
      const state = configService.getRecoveryState()
      if (state.status !== 'needs-recovery') {
        throw new ValidationError('Es liegt kein wiederherzustellender Datenzustand vor.')
      }
      if (payload.action === 'accept-current') {
        if (state.source !== 'update-journal') {
          throw new ValidationError('Der aktuelle Zustand kann für diese Wiederherstellung nicht bestätigt werden.')
        }
        await updateService.clearRecoveryJournal()
        configService.acknowledgeExternalRecovery('update-journal')
        return
      }
      if (payload.action === 'locate-data') {
        if (state.source === 'update-journal') {
          throw new ValidationError('Der Datenordner kann während der Update-Prüfung nicht gewechselt werden.')
        }
        let target = payload.dataDir
        if (!target) {
          const parent = getMainWindow()
          const options: OpenDialogOptions = {
            title: 'Vorhandenen MyFTB-Datenordner auswählen',
            properties: ['openDirectory'],
          }
          const result = parent
            ? await dialog.showOpenDialog(parent, options)
            : await dialog.showOpenDialog(options)
          if (result.canceled) return
          target = result.filePaths[0]
        }
        const targetStat = await fs.lstat(target).catch(() => null)
        if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) {
          throw new ValidationError('Der ausgewählte Datenordner ist nicht vorhanden oder nicht sicher.')
        }
        const hasLauncherData = await Promise.any([
          fs.access(join(target, 'config.json')),
          fs.access(join(target, 'config.json.bak')),
        ]).then(() => true, () => false)
        if (!hasLauncherData) {
          throw new ValidationError('Im ausgewählten Ordner wurde keine Launcher-Konfiguration gefunden.')
        }
        writeDataDirPointer(target)
        app.relaunch()
        setImmediate(() => app.exit(0))
        return
      }
      if (state.source === 'pointer') {
        if (payload.action === 'fresh-start') {
          clearDataDirPointer()
          app.relaunch()
          setImmediate(() => app.exit(0))
          return
        }
        throw new ValidationError('Für den Datenzeiger ist keine gültige Sicherung verfügbar.')
      }
      await configService.resolveRecovery(payload.action)
      if (payload.action === 'restore-backup') {
        try {
          const legacyCredentials = configService.takeLegacyCredentials()
          await credentialService.importLegacy(legacyCredentials)
          await configService.save()
        } catch (error) {
          configService.setExternalRecovery(state)
          throw error
        }
      }
      if (state.source === 'update-journal') await updateService.clearRecoveryJournal()
      app.relaunch()
      setImmediate(() => app.exit(0))
    },
  )

  secureHandle(IpcChannels.SYSTEM_INFO, { validate: noPayload }, () => ({
    platform: process.platform as 'win32' | 'darwin' | 'linux',
    totalMemoryMb: Math.round(os.totalmem() / 1_048_576),
    arch: os.arch(),
    launcherVersion: app.getVersion(),
    appId: 'de.myftb.launcher',
    dataDir: app.getPath('userData'),
    installDir: configService.getResourceDir(),
    instancesDir: configService.getInstancesDir(),
    cacheDir: configService.getCacheDir(),
    runtimesDir: configService.getRuntimesDir(),
    pointerPath: getPointerPath(),
    configPath: configService.getConfigPath(),
    configBackupPath: configService.getBackupPath(),
    secureCredentialPersistence: credentialService.isPersistent(),
  }))
  secureHandle(
    IpcChannels.SYSTEM_OPEN_URL,
    {
      validate: (value) => {
        const payload = requireObject(value)
        return { url: assertAllowedExternalUrl(payload.url) }
      },
    },
    async (_event, payload) => shell.openExternal(payload.url),
  )

  let consoleWindow: BrowserWindow | null = null
  secureHandle(
    IpcChannels.WINDOW_OPEN_CONSOLE,
    { validate: optionalSessionPayload },
    (_event, payload) => {
      if (consoleWindow && !consoleWindow.isDestroyed()) {
        if (payload.sessionId) {
          consoleWindow.webContents.send(IpcChannels.LAUNCH_CONSOLE_SELECT, { sessionId: payload.sessionId })
        }
        consoleWindow.focus()
        return
      }
      const window = new BrowserWindow({
        width: 900,
        height: 580,
        minWidth: 600,
        minHeight: 300,
        frame: process.platform === 'darwin',
        ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const } : {}),
        backgroundColor: '#1a1a1a',
        title: 'Konsole — MyFTB Launcher',
        webPreferences: {
          preload: join(__dirname, '../preload/console.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
        show: false,
      })
      consoleWindow = window
      registerTrustedWindow(window, 'console')
      hardenBrowserWindow(window)
      wireMaximizeEvents(window)
      window.on('closed', () => { consoleWindow = null })
      window.on('ready-to-show', () => window.show())
      const query = new URLSearchParams({ standalone: '1' })
      if (payload.sessionId) query.set('session', payload.sessionId)
      if (is.dev && process.env.ELECTRON_RENDERER_URL) {
        window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${query.toString()}`)
      } else {
        window.loadFile(join(__dirname, '../renderer/index.html'), {
          query: Object.fromEntries(query.entries()),
        })
      }
    },
  )

  secureOn(IpcChannels.WINDOW_MINIMIZE, { roles: ['launcher', 'console'], validate: noPayload }, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  secureOn(IpcChannels.WINDOW_MAXIMIZE, { roles: ['launcher', 'console'], validate: noPayload }, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  secureOn(IpcChannels.WINDOW_CLOSE, { roles: ['launcher', 'console'], validate: noPayload }, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  secureHandle(
    IpcChannels.WINDOW_IS_MAXIMIZED,
    { roles: ['launcher', 'console'], validate: noPayload },
    (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false,
  )

  authService.registerHandlers()
  modpackApiService.registerHandlers()
  installService.registerHandlers()
  launchService.registerHandlers()
  discordService.init()
  updateService.registerHandlers()
}
