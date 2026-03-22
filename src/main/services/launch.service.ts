// ============================================================
// MyFTB Launcher v2 — Launch Service
// Electron main-process Minecraft launch service.
// Replaces LaunchMinecraft.java using @xmcl/core.
// ============================================================

import path from 'node:path'
import fs from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { ChildProcess } from 'node:child_process'
import { setMaxListeners } from 'node:events'
import { ipcMain, shell, app, BrowserWindow } from 'electron'
import { launch as xmclLaunch } from '@xmcl/core'

import { IpcChannels } from '../ipc/channels'
import { Constants, fmt } from '../constants'
import { configService } from './config.service'
import { getSelectedProfile } from './auth.service'
import { installService } from './install.service'
import { resolveJavaPath } from './java.service'
import type {
  LaunchStartPayload,
  LaunchOpenFolderPayload,
  LaunchDeletePayload,
  LaunchCreateShortcutPayload,
  LaunchStateEvent,
  LaunchLogEvent,
  ModpackManifest,
  ModpackManifestReference,
  LauncherProfile,
} from '../../shared/types'

// ─── Discord service (optional — may not be present in all builds) ───────────

function getDiscordService(): {
  setRunningModpack(manifest: ModpackManifest | null): void
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./discord.service').discordService
  } catch {
    return null
  }
}

// ─── Log4j XML parser ────────────────────────────────────────────────────────

/**
 * Converts raw Minecraft log4j XML events to human-readable log lines.
 *
 * Minecraft pipes log4j XML events to stdout, e.g.:
 *   <log4j:Event logger="net.minecraft...." level="INFO" thread="main" timeMillis="...">
 *     <log4j:Message><![CDATA[Starting Minecraft]]></log4j:Message>
 *   </log4j:Event>
 *
 * Both single-line and multi-line events are handled. Non-XML lines pass through unchanged.
 */
class Log4jParser {
  private buffer = ''

  feed(rawLine: string): string[] {
    // Mid-event accumulation
    if (this.buffer.length > 0) {
      this.buffer += '\n' + rawLine
      if (rawLine.includes('</log4j:Event>')) {
        const formatted = this.formatEvent(this.buffer)
        this.buffer = ''
        return [formatted]
      }
      return []
    }

    if (rawLine.includes('<log4j:Event')) {
      if (rawLine.includes('</log4j:Event>')) {
        return [this.formatEvent(rawLine)]   // single-line event
      }
      this.buffer = rawLine                  // start of multi-line event
      return []
    }

    return [rawLine]                         // plain text — pass through
  }

  private formatEvent(xml: string): string {
    const level   = xml.match(/level="([^"]+)"/)?.[1]                  ?? 'INFO'
    const thread  = xml.match(/thread="([^"]+)"/)?.[1]                 ?? 'main'
    const msMatch = xml.match(/(?:timeMillis|timestamp)="(\d+)"/)
    const msgMatch =
      xml.match(/<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Message>/) ??
      xml.match(/<log4j:Message>([\s\S]*?)<\/log4j:Message>/)

    const message = (msgMatch?.[1] ?? xml).trim()

    let timeStr = ''
    if (msMatch) {
      const d = new Date(parseInt(msMatch[1]))
      timeStr = `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}] `
    }

    return `${timeStr}[${thread}/${level}]: ${message}`
  }
}

// ─── Paste upload helper ─────────────────────────────────────────────────────

/**
 * Upload raw text to paste.myftb.de (Hastebin-compatible).
 * Returns the full URL of the created paste.
 */
async function uploadToPaste(text: string): Promise<string> {
  const controller = new AbortController()
  setMaxListeners(0, controller.signal)
  const timer = setTimeout(() => controller.abort(), Constants.connectTimeoutMs)

  try {
    const response = await fetch(`${Constants.pasteTarget}/documents`, {
      method: 'POST',
      body: Buffer.from(text, 'utf-8'),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }

    const json = (await response.json()) as { key: string }
    return `${Constants.pasteTarget}/${json.key}`
  } finally {
    clearTimeout(timer)
  }
}

// ─── Fetch remote pack reference ─────────────────────────────────────────────

/**
 * Fetch the remote pack list and find a reference by pack name.
 * Returns null when the network is unavailable or the pack is not listed.
 */
async function fetchRemoteReference(
  packName: string,
): Promise<ModpackManifestReference | null> {
  const packKey = configService.get().packKey
  const url = fmt(Constants.packList, packKey)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Constants.connectTimeoutMs)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    const list = (await response.json()) as ModpackManifestReference[]
    return list.find((r) => r.name === packName) ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ─── Push-event helpers ───────────────────────────────────────────────────────

function sendToAllWindows(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
}

function sendState(event: LaunchStateEvent): void {
  sendToAllWindows(IpcChannels.LAUNCH_STATE, event)
}

function sendLogLine(event: LaunchLogEvent): void {
  sendToAllWindows(IpcChannels.LAUNCH_LOG, event)
}

// ─── Circular log buffer ─────────────────────────────────────────────────────

class CircularLineBuffer {
  private readonly cap: number
  private lines: string[] = []

  constructor(cap: number) {
    this.cap = cap
  }

  push(line: string): void {
    if (this.lines.length >= this.cap) {
      // Drop oldest entry (index 0) before appending new one.
      this.lines.shift()
    }
    this.lines.push(line)
  }

  getAll(): string[] {
    return this.lines.slice()
  }

  getText(): string {
    return this.lines.join('\n')
  }

  clear(): void {
    this.lines = []
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

class LaunchService {
  // ── State ──────────────────────────────────────────────────────────────────

  private isRunning = false
  private currentPackName: string | null = null
  private childProcess: ChildProcess | null = null
  private logBuffer = new CircularLineBuffer(Constants.logMaxLines)

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  registerHandlers(): void {
    this.handleLaunchStart()
    this.handleLaunchKill()
    this.handleLaunchGetLog()
    this.handleLaunchOpenFolder()
    this.handleLaunchDeletePack()
    this.handleLaunchCreateShortcut()
    this.handleLaunchUploadCrash()
    this.handleLaunchUploadLog()
  }

  // ── IPC: launch:start ──────────────────────────────────────────────────────

  private handleLaunchStart(): void {
    ipcMain.handle(
      IpcChannels.LAUNCH_START,
      async (_event, payload: LaunchStartPayload): Promise<void> => {
        const { packName } = payload

        if (this.isRunning) {
          throw new Error(`Minecraft is already running (${this.currentPackName ?? 'unknown'})`)
        }

        // ── 1. Auth ──────────────────────────────────────────────────────────
        let profile: LauncherProfile
        try {
          profile = await getSelectedProfile()
        } catch (err) {
          throw new Error(
            `No authenticated profile: ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        // ── 2. Load installed manifest ────────────────────────────────────────
        let manifest = await installService.getManifestByName(packName)
        if (!manifest) {
          throw new Error(`Pack "${packName}" is not installed`)
        }

        // ── 3. Outdated check / auto-update ───────────────────────────────────
        const remoteRef = await fetchRemoteReference(packName)
        if (remoteRef && remoteRef.version !== manifest.version) {
          console.info(
            `[LaunchService] Pack "${packName}" is outdated (local ${manifest.version} → remote ${remoteRef.version}), installing update…`,
          )
          const success = await installService.installModpack(remoteRef)
          if (!success) {
            throw new Error(`Auto-update of "${packName}" failed`)
          }
          // Re-load manifest after update so we have the latest version.
          const updated = await installService.getManifestByName(packName)
          if (updated) {
            manifest = updated
          }
        }

        // ── 4. Resolve paths ──────────────────────────────────────────────────
        const instanceDir = await this.resolveInstanceDir(packName)
        const minecraftDir = configService.getInstallDir()

        // ── 5. Build LaunchOption ─────────────────────────────────────────────
        const config = configService.get()

        // UUID without dashes (Minecraft auth expectation)
        const uuidNoDashes = profile.uuid.replace(/-/g, '')

        // Extra JVM args from config string
        const extraJVMArgs: string[] = config.jvmArgs
          ? config.jvmArgs
              .trim()
              .split(/\s+/)
              .filter((a) => a.length > 0)
          : []

        // Per-pack launch flags from manifest (keyed by 'flags' or platform)
        if (manifest.launch) {
          const platformKey = process.platform === 'win32'
            ? 'windows'
            : process.platform === 'darwin'
            ? 'osx'
            : 'linux'
          const platformFlags = manifest.launch[platformKey] ?? manifest.launch['flags'] ?? []
          extraJVMArgs.push(...platformFlags)
        }

        // Java binary path — resolved via java.service (bundled runtime, system scan, fallback)
        const javaPath = await resolveJavaPath(manifest)

        const launchOptions = {
          gamePath: instanceDir,
          resourcePath: minecraftDir,           // must be a plain string
          version: manifest.versionManifest.id,
          accessToken: profile.minecraftAccessToken,
          gameProfile: { id: uuidNoDashes, name: profile.lastKnownUsername },
          userType: 'msa' as const,
          minMemory: config.minMemory,
          maxMemory: config.maxMemory,
          extraJVMArgs,
          resolution: { width: config.gameWidth, height: config.gameHeight },
          javaPath,
          launcherName: 'MyFTBLauncher',
          launcherBrand: 'MyFTBLauncher',
        }

        // ── 6. Emit launching state ───────────────────────────────────────────
        sendState({ state: 'launching' })

        // ── 7. Start Minecraft ────────────────────────────────────────────────
        let child: ChildProcess
        try {
          child = await xmclLaunch(launchOptions)
        } catch (err) {
          sendState({ state: 'closed', exitCode: -1 })
          throw new Error(
            `Failed to launch Minecraft: ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        this.isRunning = true
        this.currentPackName = packName
        this.childProcess = child
        this.logBuffer.clear()

        // Discord presence
        try {
          getDiscordService()?.setRunningModpack(manifest)
        } catch {
          // Non-fatal
        }

        // ── 8. Pipe stdout / stderr ───────────────────────────────────────────
        const attachStream = (stream: NodeJS.ReadableStream | null): void => {
          if (!stream) return
          const parser = new Log4jParser()
          const rl = createInterface({ input: stream, crlfDelay: Infinity })
          rl.on('line', (rawLine) => {
            for (const line of parser.feed(rawLine)) {
              this.logBuffer.push(line)
              sendLogLine({ line })
            }
          })
        }

        attachStream(child.stdout)
        attachStream(child.stderr)

        // ── 9. Handle process exit ────────────────────────────────────────────
        child.on('close', (exitCode) => {
          const code = exitCode ?? -1
          const exitLine = `\nProcess exited with code ${code}`
          this.logBuffer.push(exitLine)
          sendLogLine({ line: exitLine })

          this.isRunning = false
          this.currentPackName = null
          this.childProcess = null

          const state = code === 0 ? 'closed' : 'crashed'
          sendState({ state, exitCode: code })

          // Clear Discord presence
          try {
            getDiscordService()?.setRunningModpack(null)
          } catch {
            // Non-fatal
          }
        })
      },
    )
  }

  // ── IPC: launch:kill ───────────────────────────────────────────────────────

  private handleLaunchKill(): void {
    ipcMain.handle(IpcChannels.LAUNCH_KILL, (): void => {
      if (this.childProcess && this.isRunning) {
        this.childProcess.kill()
      }
    })
  }

  // ── IPC: launch:get-log ────────────────────────────────────────────────────

  private handleLaunchGetLog(): void {
    ipcMain.handle(IpcChannels.LAUNCH_GET_LOG, (): string => {
      return this.logBuffer.getText()
    })
  }

  // ── IPC: launch:open-folder ────────────────────────────────────────────────

  private handleLaunchOpenFolder(): void {
    ipcMain.handle(
      IpcChannels.LAUNCH_OPEN_FOLDER,
      async (_event, payload: LaunchOpenFolderPayload): Promise<void> => {
        const instanceDir = await this.resolveInstanceDir(payload.packName)
        await shell.openPath(instanceDir)
      },
    )
  }

  // ── IPC: launch:delete-pack ────────────────────────────────────────────────

  private handleLaunchDeletePack(): void {
    ipcMain.handle(
      IpcChannels.LAUNCH_DELETE_PACK,
      async (_event, payload: LaunchDeletePayload): Promise<boolean> => {
        if (this.isRunning && this.currentPackName === payload.packName) {
          throw new Error(`Cannot delete "${payload.packName}" while it is running`)
        }

        const instanceDir = await this.resolveInstanceDir(payload.packName)

        try {
          await fs.rm(instanceDir, { recursive: true, force: true })
          return true
        } catch (err) {
          console.error(`[LaunchService] Failed to delete pack "${payload.packName}":`, err)
          return false
        }
      },
    )
  }

  // ── IPC: launch:create-shortcut ───────────────────────────────────────────

  private handleLaunchCreateShortcut(): void {
    ipcMain.handle(
      IpcChannels.LAUNCH_CREATE_SHORTCUT,
      async (_event, payload: LaunchCreateShortcutPayload): Promise<void> => {
        const { packName } = payload
        const executablePath = app.getPath('exe')
        const desktopPath = app.getPath('desktop')

        if (process.platform === 'win32') {
          // Windows: use Electron's built-in shell.writeShortcutLink()
          const shortcutPath = path.join(desktopPath, `${packName}.lnk`)

          // Attempt to find a pack icon inside the instance directory.
          const instanceDir = await this.resolveInstanceDir(packName)
          const iconCandidates = [
            path.join(instanceDir, 'pack.ico'),
            path.join(instanceDir, 'pack.png'),
          ]
          let iconPath = executablePath
          for (const candidate of iconCandidates) {
            try {
              await fs.access(candidate)
              iconPath = candidate
              break
            } catch {
              // Try next candidate
            }
          }

          const success = shell.writeShortcutLink(shortcutPath, 'create', {
            target: executablePath,
            args: `--pack "${packName}"`,
            icon: iconPath,
            iconIndex: 0,
          })

          if (!success) {
            throw new Error(`Failed to create Windows shortcut for "${packName}"`)
          }
        } else if (process.platform === 'linux') {
          // Linux: write a .desktop entry file
          const shortcutPath = path.join(desktopPath, `${packName}.desktop`)
          const instanceDir = await this.resolveInstanceDir(packName)

          // Use pack logo if available
          const iconCandidates = [
            path.join(instanceDir, 'pack.png'),
            path.join(instanceDir, 'pack.svg'),
          ]
          let iconLine = `Icon=${executablePath}`
          for (const candidate of iconCandidates) {
            try {
              await fs.access(candidate)
              iconLine = `Icon=${candidate}`
              break
            } catch {
              // Try next candidate
            }
          }

          const desktopEntry = [
            '[Desktop Entry]',
            'Type=Application',
            'Version=1.0',
            `Name=MyFTB – ${packName}`,
            `Comment=Launch the MyFTB modpack "${packName}"`,
            `Exec=${executablePath} --pack "${packName}"`,
            iconLine,
            'Terminal=false',
            'Categories=Game;',
          ].join('\n')

          await fs.writeFile(shortcutPath, desktopEntry, 'utf8')

          // Make the .desktop file executable so the desktop environment accepts it
          try {
            await fs.chmod(shortcutPath, 0o755)
          } catch {
            // chmod failure is non-fatal
          }
        }
        // macOS: no standard desktop shortcut format — skip silently
      },
    )
  }

  // ── IPC: launch:upload-crash ───────────────────────────────────────────────

  private handleLaunchUploadCrash(): void {
    ipcMain.handle(
      IpcChannels.LAUNCH_UPLOAD_CRASH,
      async (_event, payload: { packName: string }): Promise<string> => {
        const instanceDir = await this.resolveInstanceDir(payload.packName)
        const crashDir = path.join(instanceDir, 'crash-reports')

        // List .txt files in crash-reports, pick the most recently modified one.
        let entries: { name: string; mtime: number }[] = []
        try {
          const dirEntries = await fs.readdir(crashDir)
          const stats = await Promise.all(
            dirEntries
              .filter((f) => f.endsWith('.txt'))
              .map(async (f) => {
                const stat = await fs.stat(path.join(crashDir, f))
                return { name: f, mtime: stat.mtimeMs }
              }),
          )
          entries = stats
        } catch (err) {
          throw new Error(
            `Could not read crash-reports directory for "${payload.packName}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }

        if (entries.length === 0) {
          throw new Error(`No crash reports found for "${payload.packName}"`)
        }

        // Sort descending by mtime and pick the newest
        entries.sort((a, b) => b.mtime - a.mtime)
        const latestFile = path.join(crashDir, entries[0].name)

        let crashText: string
        try {
          crashText = await fs.readFile(latestFile, 'utf8')
        } catch (err) {
          throw new Error(
            `Failed to read crash report "${entries[0].name}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }

        return uploadToPaste(crashText)
      },
    )
  }

  // ── IPC: launch:upload-log ─────────────────────────────────────────────────

  private handleLaunchUploadLog(): void {
    ipcMain.handle(IpcChannels.LAUNCH_UPLOAD_LOG, async (): Promise<string> => {
      const logText = this.logBuffer.getText()
      if (!logText) {
        throw new Error('Log buffer is empty')
      }
      return uploadToPaste(logText)
    })
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Resolves the on-disk instance directory for a named pack.
   * Matches the path used by install.service: <installDir>/instances/<packName>
   */
  private async resolveInstanceDir(packName: string): Promise<string> {
    const instancesDir = await configService.getSaveSubDir('instances')
    return path.join(instancesDir, packName)
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────────

export const launchService = new LaunchService()
