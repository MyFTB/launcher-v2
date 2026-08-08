import { setMaxListeners } from 'node:events'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import {
  getBootstrapRecoveryState,
  readDataDirFromDisk,
} from './bootstrap'

// Chromium's GPU process is frequently blocklisted under WSLg and can leave
// Electron windows blank. This only affects the launcher UI; Minecraft keeps
// using its own graphics configuration and GPU normally.
const useWslSoftwareRendering = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME)
if (useWslSoftwareRendering) app.disableHardwareAcceleration()

const customDataDir = readDataDirFromDisk()
if (customDataDir) app.setPath('userData', customDataDir)

setMaxListeners(30)

import { registerIpcHandlers } from './ipc/router'
import { IpcChannels } from './ipc/channels'
import { configService } from './services/config.service'
import { credentialService } from './services/credential.service'
import { launchService } from './services/launch.service'
import { discordService } from './services/discord.service'
import { updateService } from './services/update.service'
import {
  getLaunchPackArg,
  getMainWindow,
  setLaunchPackArg,
  setMainWindow,
} from './app-state'
import { logger } from './logger'
import { assertPackName } from '../shared/validation'
import { hardenBrowserWindow, wireMaximizeEvents } from './security/window-security'

let initialPackArg: string | null = null
const packArgIndex = process.argv.findIndex((value) => value === '--pack' || value === '-p')
if (packArgIndex !== -1 && process.argv[packArgIndex + 1]) {
  try { initialPackArg = assertPackName(process.argv[packArgIndex + 1]) } catch { initialPackArg = null }
}
setLaunchPackArg(initialPackArg)

if (!app.requestSingleInstanceLock({ launchPackArg: initialPackArg })) {
  app.quit()
  process.exit(0)
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const mainWindow = new BrowserWindow({
    width: 1_100,
    height: 680,
    minWidth: 900,
    minHeight: 600,
    frame: isMac,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
    ...(isMac ? {
      titleBarStyle: 'hidden' as const,
      trafficLightPosition: { x: 14, y: 14 },
    } : {}),
  })

  setMainWindow(mainWindow)
  hardenBrowserWindow(mainWindow)
  wireMaximizeEvents(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (pendingDeepLink) {
      handlePendingDeepLink(pendingDeepLink)
      pendingDeepLink = null
    }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('de.myftb.launcher')
  logger.init(app.getPath('logs'))
  logger.captureConsole()
  logger.info(`[Launcher] Starting v${app.getVersion()} on ${process.platform} ${process.arch}`)
  if (useWslSoftwareRendering) logger.info('[Launcher] WSL detected; Electron hardware acceleration is disabled')

  // Registering a protocol from an unpackaged Electron process is unreliable
  // and invokes xdg-settings on Linux. Packaged builds register it normally.
  if (!is.dev && !app.setAsDefaultProtocolClient('myftb')) {
    logger.warn('[Launcher] The myftb protocol handler could not be registered')
  }
  app.on('browser-window-created', (_event, window) => optimizer.watchWindowShortcuts(window))

  await configService.load()
  const recoveredConfigFromBackup = configService.getRecoveryState().status === 'recovered-backup'
    && configService.getRecoveryState().source === 'config'
  const bootstrapRecovery = getBootstrapRecoveryState()
  if (bootstrapRecovery.status !== 'ok') configService.setExternalRecovery(bootstrapRecovery)

  // Validate an update journal before startup migrations mutate config.json.
  await updateService.initialize()

  const legacyCredentials = configService.takeLegacyCredentials()
  let credentialMigrationSucceeded = true
  try {
    await credentialService.initialize(legacyCredentials)
  } catch (error) {
    credentialMigrationSucceeded = false
    logger.error('[Launcher] Credentials could not be migrated safely:', error)
    configService.setExternalRecovery({
      status: 'needs-recovery',
      source: 'config',
      message: 'Die Zugangsdaten konnten nicht sicher gespeichert werden. Die vorhandene Konfiguration wurde nicht überschrieben.',
      brokenPath: configService.getConfigPath(),
      backupAvailable: true,
    })
  }
  if (credentialMigrationSucceeded
    && (legacyCredentials.length > 0 || recoveredConfigFromBackup)
    && configService.getRecoveryState().status !== 'needs-recovery') {
    // Persist the sanitized config only after credentials were safely migrated.
    try {
      await configService.save()
    } catch (error) {
      logger.error('[Launcher] Recovered configuration could not be saved:', error)
      configService.setExternalRecovery({
        status: 'needs-recovery',
        source: 'config',
        message: 'Die wiederhergestellte Konfiguration konnte nicht sicher gespeichert werden.',
        brokenPath: configService.getConfigPath(),
        backupAvailable: true,
      })
    }
  }
  await configService.generateClientToken().catch((error: unknown) => {
    logger.warn('[Launcher] Client token could not be persisted:', error)
  })
  await launchService.initialize()

  logger.info(`[Launcher] userData: ${app.getPath('userData')}`)
  logger.info(`[Launcher] resources: ${configService.getResourceDir()} | instances: ${configService.getInstancesDir()}`)

  await registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let shutdownPrepared = false
let shutdownPreparation: Promise<void> | null = null
app.on('before-quit', (event) => {
  discordService.destroy()
  if (shutdownPrepared) return
  event.preventDefault()
  if (shutdownPreparation) return
  shutdownPreparation = launchService.detachAll()
    .catch((error: unknown) => {
      logger.warn('[Launcher] Launch-session registry could not be flushed:', error)
    })
    .then(() => {
      shutdownPrepared = true
      app.quit()
    })
})

app.on('second-instance', (_event, commandLine, _workingDirectory, additionalData) => {
  const window = getMainWindow()
  if (window) {
    if (window.isMinimized()) window.restore()
    window.focus()
  }

  const deepLink = commandLine.find((argument) => argument.startsWith('myftb://'))
  if (deepLink) {
    handleDeepLink(deepLink)
    return
  }
  const requested = (additionalData as { launchPackArg?: unknown }).launchPackArg
  if (typeof requested === 'string') {
    try {
      const packName = assertPackName(requested)
      getMainWindow()?.webContents.send(IpcChannels.LAUNCH_PACK, packName)
    } catch {
      logger.warn('[Launcher] Rejected invalid second-instance pack argument')
    }
  }
})

let pendingDeepLink: string | null = null
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (getMainWindow()) handleDeepLink(url)
  else pendingDeepLink = url
})

export function parseDeepLinkPackName(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'myftb:') return null
    const raw = parsed.hostname === 'pack'
      ? parsed.pathname.replace(/^\//, '')
      : parsed.pathname.startsWith('/pack/')
        ? parsed.pathname.slice('/pack/'.length)
        : ''
    return raw ? assertPackName(decodeURIComponent(raw)) : null
  } catch {
    return null
  }
}

function handleDeepLink(url: string): void {
  if (!configService.get().allowWebstart) {
    logger.warn('[Launcher] Ignored myftb link because Webstart is disabled')
    return
  }
  const packName = parseDeepLinkPackName(url)
  if (packName) getMainWindow()?.webContents.send(IpcChannels.LAUNCH_PACK, packName)
}

function handlePendingDeepLink(url: string): void {
  if (!configService.get().allowWebstart) return
  const packName = parseDeepLinkPackName(url)
  if (packName && !getLaunchPackArg()) setLaunchPackArg(packName)
}
