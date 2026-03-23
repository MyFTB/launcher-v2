import { setMaxListeners } from 'node:events'
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Undici (Node's built-in fetch) registers multiple abort listeners per concurrent
// request. Raise the default so the false-positive "memory leak" warning is
// suppressed without hiding real issues.
setMaxListeners(30)
import { registerIpcHandlers } from './ipc/router'
import { configService } from './services/config.service'
import { setMainWindow, setLaunchPackArg, getMainWindow } from './app-state'
import { logger } from './logger'

// ── CLI: --pack <name> ───────────────────────────────────────
let _initialPackArg: string | null = null
const packArgIdx = process.argv.indexOf('--pack')
if (packArgIdx !== -1 && process.argv[packArgIdx + 1]) {
  _initialPackArg = process.argv[packArgIdx + 1]
} else {
  const shortArgIdx = process.argv.indexOf('-p')
  if (shortArgIdx !== -1 && process.argv[shortArgIdx + 1]) {
    _initialPackArg = process.argv[shortArgIdx + 1]
  }
}
setLaunchPackArg(_initialPackArg)

// ── Single-instance lock ─────────────────────────────────────
if (!app.requestSingleInstanceLock({ launchPackArg: _initialPackArg })) {
  app.quit()
  process.exit(0)
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 680,
    minWidth: 900,
    minHeight: 600,
    frame: false,        // Custom title bar in renderer
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false      // needed for preload to use Node APIs
    },
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 14 }  // macOS traffic lights
  })

  setMainWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Load renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── App lifecycle ────────────────────────────────────────────

app.whenReady().then(async () => {
  // Set app user model id for Windows notifications
  electronApp.setAppUserModelId('de.myftb.launcher')

  // Initialise file logger — must happen after app is ready so getPath('logs') works
  logger.init(app.getPath('logs'))
  logger.captureConsole()  // redirect global console so third-party libs are also logged
  logger.info(`[Launcher] Starting up - v${app.getVersion()} | ${process.platform} ${process.arch}`)

  // Register myftb:// deep-link protocol (webstart)
  app.setAsDefaultProtocolClient('myftb')

  // Short-circuit dev mode keyboard shortcuts
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Load config first
  await configService.load()
  const _cfg = configService.get()
  logger.info(
    `[Launcher] installDir: ${configService.getInstallDir()} | mem: ${_cfg.minMemory}-${_cfg.maxMemory} MB`
  )

  // Register all IPC handlers
  registerIpcHandlers()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Second instance (Windows/Linux deep link or duplicate launch)
app.on('second-instance', (_event, commandLine, _workingDirectory, additionalData) => {
  const win = getMainWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }

  const deepLink = commandLine.find((arg) => arg.startsWith('myftb://'))
  if (deepLink) {
    logger.info(`[Launcher] Second instance: deep link received - ${deepLink}`)
    handleDeepLink(deepLink)
  } else if ((additionalData as { launchPackArg?: string }).launchPackArg) {
    const packName = (additionalData as { launchPackArg: string }).launchPackArg
    logger.info(`[Launcher] Second instance: forwarding pack launch for "${packName}"`)
    getMainWindow()?.webContents.send('internal:launch-pack', packName)
  }
})

// macOS deep link
app.on('open-url', (_event, url) => {
  handleDeepLink(url)
})

function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'pack' || parsed.pathname.startsWith('/pack/')) {
      const packName = parsed.hostname === 'pack'
        ? parsed.pathname.replace(/^\//, '')
        : parsed.pathname.replace('/pack/', '')
      logger.info(`[Launcher] Deep link: launching pack "${packName}"`)
      getMainWindow()?.webContents.send('internal:launch-pack', packName)
    }
  } catch {
    // ignore malformed URLs
  }
}
