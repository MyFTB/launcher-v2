import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import os from 'os'
import { IpcChannels } from './channels'
import { configService } from '../services/config.service'
import { authService } from '../services/auth.service'
import { modpackApiService } from '../services/modpack-api.service'
import { installService } from '../services/install.service'
import { launchService } from '../services/launch.service'
import { discordService } from '../services/discord.service'
import { updateService } from '../services/update.service'
import { getMainWindow, getLaunchPackArg } from '../app-state'

export function registerIpcHandlers(): void {
  // ── Internal: Renderer ready ────────────────────────────────
  ipcMain.handle(IpcChannels.RENDERER_ARRIVED, async () => {
    const win = getMainWindow()
    if (!win) return

    if (configService.isFirstStart()) {
      win.webContents.send(IpcChannels.WELCOME_MESSAGE, {
        installation_dir: configService.getInstallDir()
      })
    }

    const packArg = getLaunchPackArg()
    if (packArg) {
      win.webContents.send(IpcChannels.LAUNCH_PACK, packArg)
    }
  })

  // ── Config ──────────────────────────────────────────────────
  ipcMain.handle(IpcChannels.CONFIG_GET, () => configService.get())

  ipcMain.handle(IpcChannels.CONFIG_SAVE, async (_e, partial) => {
    configService.merge(partial)
    await configService.save()
  })

  ipcMain.handle(IpcChannels.CONFIG_PICK_DIR, async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Bitte wähle den Speicherort für installierte Modpacks',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IpcChannels.CONFIG_OPEN_LOGS, () => {
    shell.openPath(app.getPath('logs'))
  })

  ipcMain.handle(IpcChannels.CONFIG_CHANGE_DATA_DIR, async () => {
    const win = getMainWindow()
    if (!win) return { success: false, error: 'Kein Fenster vorhanden.' }

    const result = await dialog.showOpenDialog(win, {
      title: 'Speicherort fuer Launcher-Daten waehlen',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, error: 'cancelled' }
    }

    const migrationResult = await configService.migrateDataDir(result.filePaths[0])

    if (migrationResult.success) {
      setTimeout(() => {
        app.relaunch()
        app.quit()
      }, 500)
    }

    return migrationResult
  })

  // ── System info ─────────────────────────────────────────────
  ipcMain.handle(IpcChannels.SYSTEM_INFO, () => ({
    platform: process.platform,
    totalMemoryMb: Math.round(os.totalmem() / 1_048_576),
    arch: os.arch(),
    launcherVersion: app.getVersion(),
    dataDir: app.getPath('userData'),
  }))

  ipcMain.handle(IpcChannels.SYSTEM_OPEN_URL, async (_e, { url }: { url: string }) => {
    const trusted = ['myftb.de', 'minecraft.net', 'microsoft.com', 'live.com', 'discord.gg']
    try {
      const { hostname, protocol } = new URL(url)
      const isSafeProtocol = protocol === 'https:' || protocol === 'http:'
      if (isSafeProtocol && trusted.some((d) => hostname === d || hostname.endsWith('.' + d))) {
        await shell.openExternal(url)
      }
    } catch {
      // ignore invalid URLs
    }
  })

  // ── Window controls ─────────────────────────────────────────
  // ── Console window ──────────────────────────────────────────
  let consoleWindow: BrowserWindow | null = null

  ipcMain.handle('window:open-console', () => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.focus()
      return
    }
    const win = new BrowserWindow({
      width: 900,
      height: 580,
      minWidth: 600,
      minHeight: 300,
      frame: false,
      backgroundColor: '#1a1a1a',
      title: 'Konsole — MyFTB Launcher',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
      show: false,
    })
    consoleWindow = win
    win.on('closed', () => { consoleWindow = null })
    win.on('ready-to-show', () => win.show())
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '?standalone=1')
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'), { query: { standalone: '1' } })
    }
  })

  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window:maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  // ── Services ────────────────────────────────────────────────
  authService.registerHandlers()
  modpackApiService.registerHandlers()
  installService.registerHandlers()
  launchService.registerHandlers()
  discordService.init()
  updateService.registerHandlers()
}
