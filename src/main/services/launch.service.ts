import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { app, shell } from 'electron'
import { launch as xmclLaunch } from '@xmcl/core'

import { IpcChannels } from '../ipc/channels'
import { IpcError, noPayload, requireObject, secureHandle } from '../ipc/security'
import { Constants, fmt } from '../constants'
import { getTrustedWindows } from '../app-state'
import { configService, atomicWriteFile } from './config.service'
import { getSelectedProfile } from './auth.service'
import { installService } from './install.service'
import { resolveJavaPath } from './java.service'
import { discordService } from './discord.service'
import { packOperationService, PackOperationConflictError } from './pack-operation.service'
import { logger, redactSensitiveLogData } from '../logger'
import { assertContainedNoLinks, readSafeRegularFile } from '../filesystem-safety'
import { fetchWithRetry, readJsonResponseLimited } from '../fetch-retry'
import { isCompletedLaunchState } from '../../shared/types'
import type {
  LaunchCreateShortcutPayload,
  LaunchDeletePayload,
  LaunchLogEvent,
  LaunchOpenFolderPayload,
  LaunchSession,
  LaunchSessionRemovedEvent,
  LaunchStartPayload,
  LaunchStartResult,
  LaunchStateEvent,
  LauncherConfig,
  ModpackManifestReference,
} from '../../shared/types'
import {
  assertPackName,
  assertSessionId,
  filterSafeRemoteJvmArgs,
  validateModpackReference,
} from '../../shared/validation'

export function buildChildEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  if (process.platform !== 'linux') return { ...env }
  const cleaned = { ...env }
  delete cleaned.LD_PRELOAD
  const libraryPath = env.LD_LIBRARY_PATH
  if (libraryPath) {
    const filtered = libraryPath
      .split(':')
      .filter((entry) => {
        const lower = entry.toLowerCase()
        return !lower.includes('electron')
          && !lower.includes('/app.asar')
          && !lower.includes('/chrome')
          && !lower.includes('/chromium')
      })
      .join(':')
    if (filtered) cleaned.LD_LIBRARY_PATH = filtered
    else delete cleaned.LD_LIBRARY_PATH
  }
  return cleaned
}

class Log4jParser {
  private buffer = ''

  feed(rawLine: string): string[] {
    if (this.buffer) {
      this.buffer += `\n${rawLine}`
      if (rawLine.includes('</log4j:Event>')) {
        const formatted = this.formatEvent(this.buffer)
        this.buffer = ''
        return [formatted]
      }
      return []
    }
    if (rawLine.includes('<log4j:Event')) {
      if (rawLine.includes('</log4j:Event>')) return [this.formatEvent(rawLine)]
      this.buffer = rawLine
      return []
    }
    return [rawLine]
  }

  private formatEvent(xml: string): string {
    const level = xml.match(/level="([^"]+)"/)?.[1] ?? 'INFO'
    const thread = xml.match(/thread="([^"]+)"/)?.[1] ?? 'main'
    const timestamp = xml.match(/(?:timeMillis|timestamp)="(\d+)"/)?.[1]
    const message = (
      xml.match(/<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Message>/)?.[1]
      ?? xml.match(/<log4j:Message>([\s\S]*?)<\/log4j:Message>/)?.[1]
      ?? xml
    ).trim()
    const time = timestamp
      ? (() => {
          const date = new Date(Number(timestamp))
          return `[${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}] `
        })()
      : ''
    return `${time}[${thread}/${level}]: ${message}`
  }
}

async function uploadToPaste(text: string): Promise<string> {
  if (Buffer.byteLength(text, 'utf8') > 10 * 1024 * 1024) {
    throw new IpcError('INVALID_PAYLOAD', 'Der Log ist zu groß zum Hochladen.')
  }
  const redacted = redactSensitiveLogData(text)
  const response = await fetch(`${Constants.pasteTarget}/documents`, {
    method: 'POST',
    body: Buffer.from(redacted, 'utf8'), // codeql[js/file-access-to-http] explicit user-requested diagnostic upload to a fixed HTTPS endpoint
    signal: AbortSignal.timeout(Constants.connectTimeoutMs),
  })
  if (!response.ok) throw new Error(`Log-Upload fehlgeschlagen (HTTP ${response.status}).`)
  const json = await response.json() as { key?: unknown }
  if (typeof json.key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(json.key)) {
    throw new Error('Der Log-Dienst hat eine ungültige Antwort gesendet.')
  }
  return `${Constants.pasteTarget}/${json.key}`
}

async function fetchRemoteReference(packName: string): Promise<ModpackManifestReference | null> {
  try {
    const response = await fetchWithRetry(fmt(Constants.packList, configService.get().packKey), {
      timeoutMs: Constants.connectTimeoutMs,
    })
    if (!response.ok) return null
    const body = await readJsonResponseLimited(response, 10 * 1024 * 1024)
    const raw = Array.isArray(body)
      ? body
      : typeof body === 'object' && body !== null && Array.isArray((body as { packages?: unknown }).packages)
        ? (body as { packages: unknown[] }).packages
        : []
    for (const item of raw) {
      try {
        const reference = validateModpackReference(item)
        if (reference.name === packName) return reference
      } catch {
        // Ignore malformed remote entries.
      }
    }
  } catch {
    // Offline launch intentionally continues from the local manifest.
  }
  return null
}

function sendToTrustedWindows(channel: string, payload: unknown): void {
  for (const window of getTrustedWindows()) window.webContents.send(channel, payload)
}

class CircularLineBuffer {
  private readonly lines: Array<string | undefined>
  private start = 0
  private size = 0

  constructor(private readonly capacity: number) {
    this.lines = new Array(capacity)
  }

  push(line: string): void {
    if (this.capacity <= 0) return
    if (this.size < this.capacity) {
      this.lines[(this.start + this.size) % this.capacity] = line
      this.size++
      return
    }
    this.lines[this.start] = line
    this.start = (this.start + 1) % this.capacity
  }

  getText(): string {
    const output = new Array<string>(this.size)
    for (let index = 0; index < this.size; index++) {
      output[index] = this.lines[(this.start + index) % this.capacity] ?? ''
    }
    return output.join('\n')
  }
}

interface InternalLaunchSession {
  data: LaunchSession
  child?: ChildProcess
  preparationAbort?: AbortController
  readers: ReadlineInterface[]
  log: CircularLineBuffer
}

function cloneSession(session: LaunchSession): LaunchSession {
  return { ...session }
}

const execFileAsync = promisify(execFile)

async function getProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    let identity: string
    if (process.platform === 'linux') {
      const [stat, executable] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
        fs.realpath(`/proc/${pid}/exe`),
      ])
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
      const startTicks = fields[19]
      if (!startTicks) return null
      identity = `${startTicks}\0${executable}`
    } else if (process.platform === 'darwin') {
      const result = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], {
        encoding: 'utf8',
        timeout: 3_000,
        maxBuffer: 64 * 1024,
      })
      identity = result.stdout.trim()
    } else if (process.platform === 'win32') {
      const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object CreationDate,ExecutablePath | ConvertTo-Json -Compress)`
      const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      })
      identity = result.stdout.trim()
    } else {
      return null
    }
    return identity ? createHash('sha256').update(identity).digest('hex') : null
  } catch {
    return null
  }
}

async function getProcessIdentityWithRetry(pid: number): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const identity = await getProcessIdentity(pid)
    if (identity) return identity
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
  }
  return null
}

class LaunchService {
  private readonly sessions = new Map<string, InternalLaunchSession>()
  private registryPoll: ReturnType<typeof setInterval> | null = null
  private persistenceQueue: Promise<void> = Promise.resolve()

  private get registryPath(): string {
    return path.join(app.getPath('userData'), 'launch-sessions.json')
  }

  async initialize(): Promise<void> {
    try {
      const registryContents = await readSafeRegularFile(this.registryPath, {
        maxBytes: 1024 * 1024,
        label: 'Start-Sitzungsregister',
      })
      const raw = JSON.parse(registryContents.toString('utf8')) as unknown
      if (Array.isArray(raw)) {
        const restoredPids = new Set<number>()
        for (const candidate of raw.slice(0, 20)) {
          if (typeof candidate !== 'object' || candidate === null) continue
          const record = candidate as Partial<LaunchSession>
          try {
            const id = assertSessionId(record.id)
            const packName = assertPackName(record.packName)
            if (
              typeof record.pid !== 'number'
              || restoredPids.has(record.pid)
              || typeof record.processIdentity !== 'string'
              || !/^[0-9a-f]{64}$/i.test(record.processIdentity)
            ) continue
            const currentIdentity = await getProcessIdentity(record.pid)
            if (!currentIdentity || currentIdentity !== record.processIdentity) continue
            const now = Date.now()
            const data: LaunchSession = {
              id,
              packName,
              packTitle: typeof record.packTitle === 'string' ? record.packTitle.slice(0, 256) : packName,
              pid: record.pid,
              processIdentity: record.processIdentity,
              state: 'running',
              startedAt: typeof record.startedAt === 'number' ? record.startedAt : now,
              updatedAt: now,
              detached: true,
            }
            packOperationService.reserveLaunch(packName, `launch:${id}`)
            restoredPids.add(record.pid)
            this.sessions.set(id, { data, readers: [], log: new CircularLineBuffer(Constants.logMaxLines) })
            discordService.setPlaying(id, data.packTitle, data.startedAt)
          } catch {
            // Ignore malformed registry entries.
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('[LaunchService] Launch-session registry was invalid and has been rebuilt')
      }
    }
    await this.persistRegistry()
    this.registryPoll = setInterval(() => {
      void this.reconcileDetachedProcesses().catch((error: unknown) => {
        logger.warn('[LaunchService] Detached-session reconciliation failed:', error)
      })
    }, 10_000)
    this.registryPoll.unref?.()
  }

  registerHandlers(): void {
    secureHandle(
      IpcChannels.LAUNCH_START,
      {
        validate: (value): LaunchStartPayload => {
          const payload = requireObject(value)
          return { packName: assertPackName(payload.packName) }
        },
      },
      async (_event, payload): Promise<LaunchStartResult> => ({
        session: await this.start(payload.packName),
      }),
    )
    secureHandle(
      IpcChannels.LAUNCH_KILL,
      {
        roles: ['launcher', 'console'],
        validate: (value) => ({ sessionId: assertSessionId(requireObject(value).sessionId) }),
      },
      (_event, { sessionId }) => this.kill(sessionId),
    )
    secureHandle(
      IpcChannels.LAUNCH_REMOVE_SESSION,
      {
        roles: ['launcher', 'console'],
        validate: (value) => ({ sessionId: assertSessionId(requireObject(value).sessionId) }),
      },
      (_event, { sessionId }) => this.removeSession(sessionId),
    )
    secureHandle(
      IpcChannels.LAUNCH_GET_SESSIONS,
      { roles: ['launcher', 'console'], validate: noPayload },
      () => this.listSessions(),
    )
    secureHandle(
      IpcChannels.LAUNCH_GET_LOG,
      {
        roles: ['launcher', 'console'],
        validate: (value) => ({ sessionId: assertSessionId(requireObject(value).sessionId) }),
      },
      (_event, { sessionId }) => this.getLog(sessionId),
    )
    secureHandle(
      IpcChannels.LAUNCH_OPEN_FOLDER,
      { validate: this.packPayload },
      async (_event, payload: LaunchOpenFolderPayload) => {
        await shell.openPath(await this.resolveInstanceDir(payload.packName, false))
      },
    )
    secureHandle(
      IpcChannels.LAUNCH_DELETE_PACK,
      { validate: this.packPayload },
      (_event, payload: LaunchDeletePayload) => this.deletePack(payload.packName),
    )
    secureHandle(
      IpcChannels.LAUNCH_CREATE_SHORTCUT,
      { validate: this.packPayload },
      (_event, payload: LaunchCreateShortcutPayload) => this.createShortcut(payload.packName),
    )
    secureHandle(
      IpcChannels.LAUNCH_UPLOAD_CRASH,
      { validate: this.packPayload },
      (_event, payload) => this.uploadCrash(payload.packName),
    )
    secureHandle(
      IpcChannels.LAUNCH_UPLOAD_LOG,
      {
        roles: ['launcher', 'console'],
        validate: (value) => ({ sessionId: assertSessionId(requireObject(value).sessionId) }),
      },
      async (_event, { sessionId }) => {
        const log = this.getLog(sessionId)
        if (!log) throw new IpcError('NOT_FOUND', 'Für diese Sitzung ist kein Log verfügbar.')
        return uploadToPaste(log)
      },
    )
  }

  private readonly packPayload = (value: unknown): { packName: string } => ({
    packName: assertPackName(requireObject(value).packName),
  })

  isPackActive(packName: string): boolean {
    return packOperationService.isRunning(packName)
  }

  hasActiveSessions(): boolean {
    return [...this.sessions.values()].some(({ data }) => data.state === 'launching' || data.state === 'running')
  }

  private reserve(packName: string): InternalLaunchSession {
    this.pruneInactiveSessions()
    const now = Date.now()
    const id = randomUUID()
    try {
      packOperationService.reserveLaunch(packName, `launch:${id}`)
    } catch (error) {
      if (error instanceof PackOperationConflictError) throw new IpcError('CONFLICT', error.message)
      throw error
    }
    const session: InternalLaunchSession = {
      data: {
        id,
        packName,
        packTitle: packName,
        state: 'launching',
        startedAt: now,
        updatedAt: now,
      },
      preparationAbort: new AbortController(),
      readers: [],
      log: new CircularLineBuffer(Constants.logMaxLines),
    }
    this.sessions.set(id, session)
    this.publishState(session)
    return session
  }

  private async start(packName: string): Promise<LaunchSession> {
    if (configService.isStorageMigrationActive()) {
      throw new IpcError('CONFLICT', 'Während der Datenmigration kann Minecraft nicht gestartet werden.')
    }
    const session = this.reserve(packName)
    const signal = session.preparationAbort!.signal
    let spawned = false
    try {
      signal.throwIfAborted()
      const profile = await getSelectedProfile()
      signal.throwIfAborted()
      let manifest = await installService.getManifestByName(packName)
      if (!manifest) throw new IpcError('NOT_FOUND', `„${packName}“ ist nicht installiert.`)
      session.data.packTitle = manifest.title
      this.publishState(session)

      const remote = await fetchRemoteReference(packName)
      signal.throwIfAborted()
      if (remote && remote.version !== manifest.version) {
        const result = await installService.installModpack(remote, undefined, `launch:${session.data.id}`)
        signal.throwIfAborted()
        if (result.success) manifest = await installService.getManifestByName(packName) ?? manifest
        else logger.warn(`[LaunchService] Auto-update failed; keeping valid local manifest for ${packName}`)
      }

      const instanceDir = await this.resolveInstanceDir(packName, false)
      signal.throwIfAborted()
      const config = configService.get()
      const override = config.packConfigs[packName] ?? {}
      const minMemory = override.minMemory ?? config.minMemory
      const maxMemory = override.maxMemory ?? config.maxMemory
      const jvmArgs = override.jvmArgs ?? config.jvmArgs
      const extraJVMArgs = jvmArgs.trim() ? jvmArgs.trim().split(/\s+/) : []
      if (manifest.launch) {
        const key = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
        const remoteArgs = manifest.launch[key] ?? manifest.launch.flags ?? []
        const filtered = filterSafeRemoteJvmArgs(remoteArgs)
        if (filtered.length !== remoteArgs.length) logger.warn(`[LaunchService] Blocked unsafe remote JVM arguments for ${packName}`)
        extraJVMArgs.push(...filtered)
      }
      const javaPath = await resolveJavaPath(manifest)
      const launchOptions = {
        gamePath: instanceDir,
        resourcePath: configService.getResourceDir(),
        version: manifest.versionManifest.id,
        accessToken: profile.minecraftAccessToken,
        gameProfile: { id: profile.uuid.replace(/-/g, ''), name: profile.lastKnownUsername },
        userType: 'msa' as unknown as 'mojang',
        minMemory,
        maxMemory,
        extraJVMArgs,
        resolution: { width: config.gameWidth, height: config.gameHeight },
        javaPath,
        launcherName: 'MyFTBLauncher',
        launcherBrand: 'MyFTBLauncher',
        extraExecOption: { detached: true, env: buildChildEnv() },
      }

      // Deliberately do not log generated arguments: they contain access tokens.
      const child = await xmclLaunch(launchOptions)
      spawned = true
      session.child = child
      session.preparationAbort = undefined
      session.data.pid = child.pid
      session.data.state = 'running'
      this.attachOutput(session, child.stdout)
      this.attachOutput(session, child.stderr)
      child.once('close', (exitCode) => this.handleExit(session.data.id, exitCode ?? -1))
      if (child.exitCode !== null) {
        this.handleExit(session.data.id, child.exitCode)
        throw new IpcError('INTERNAL', 'Minecraft wurde direkt nach dem Start beendet.')
      }
      if (signal.aborted) {
        child.kill()
        throw signal.reason ?? new DOMException('Start abgebrochen', 'AbortError')
      }
      if (!child.pid) {
        child.kill('SIGKILL')
        throw new IpcError('INTERNAL', 'Für den Minecraft-Prozess wurde keine Prozess-ID zurückgegeben.')
      }
      session.data.processIdentity = await getProcessIdentityWithRetry(child.pid) ?? undefined
      if (!session.data.processIdentity) {
        child.kill('SIGKILL')
        throw new IpcError(
          'IO_ERROR',
          'Die Minecraft-Prozessidentität konnte nicht sicher ermittelt werden. Der Start wurde abgebrochen.',
        )
      }
      if (session.data.state !== 'running') {
        throw new IpcError('INTERNAL', 'Minecraft wurde während der Startvorbereitung beendet.')
      }
      session.data.updatedAt = Date.now()
      this.publishState(session)
      await this.persistRegistry().catch((error: unknown) => {
        logger.warn('[LaunchService] Running session could not be persisted safely:', error)
      })
      discordService.setPlaying(session.data.id, manifest.title, session.data.startedAt)

      configService.merge({
        lastPlayedPacks: [
          packName,
          ...config.lastPlayedPacks.filter((entry) => entry !== packName),
        ].slice(0, Constants.recentPacksMax),
      })
      void configService.save().catch((error: unknown) => {
        logger.warn('[LaunchService] Recent-pack update could not be saved:', error)
      })
      logger.info(`[LaunchService] Started ${packName} (session ${session.data.id}, PID ${child.pid ?? 'unknown'})`)
      return cloneSession(session.data)
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError'
      session.preparationAbort = undefined
      if (spawned) throw error
      session.data.state = cancelled ? 'closed' : 'crashed'
      session.data.exitCode = cancelled ? 0 : -1
      session.data.error = cancelled ? 'Der Start wurde abgebrochen.' : error instanceof Error ? error.message : 'Der Start ist fehlgeschlagen.'
      session.data.updatedAt = Date.now()
      packOperationService.releaseLaunch(packName, `launch:${session.data.id}`)
      const failureLine = cancelled
        ? 'Der Minecraft-Start wurde abgebrochen.'
        : 'Der Minecraft-Start ist vor dem Prozessstart fehlgeschlagen. Details stehen im Launcher-Log.'
      session.log.push(failureLine)
      sendToTrustedWindows(IpcChannels.LAUNCH_LOG, {
        sessionId: session.data.id,
        packName,
        line: failureLine,
      } satisfies LaunchLogEvent)
      this.publishState(session)
      await this.persistRegistry()
      throw error
    }
  }

  private attachOutput(session: InternalLaunchSession, stream: NodeJS.ReadableStream | null): void {
    if (!stream) return
    const parser = new Log4jParser()
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    session.readers.push(reader)
    reader.on('line', (rawLine) => {
      for (const line of parser.feed(rawLine)) {
        session.log.push(line)
        const event: LaunchLogEvent = {
          sessionId: session.data.id,
          packName: session.data.packName,
          line,
        }
        sendToTrustedWindows(IpcChannels.LAUNCH_LOG, event)
      }
    })
  }

  private handleExit(sessionId: string, exitCode: number): void {
    const session = this.sessions.get(sessionId)
    if (!session || (!session.child && (session.data.state === 'closed' || session.data.state === 'crashed'))) return
    for (const reader of session.readers) reader.close()
    session.readers = []
    session.child = undefined
    session.preparationAbort = undefined
    session.data.state = exitCode === 0 ? 'closed' : 'crashed'
    session.data.exitCode = exitCode
    session.data.updatedAt = Date.now()
    session.data.detached = false
    packOperationService.releaseLaunch(session.data.packName, `launch:${sessionId}`)
    session.log.push(`\nProcess exited with code ${exitCode}`)
    sendToTrustedWindows(IpcChannels.LAUNCH_LOG, {
      sessionId,
      packName: session.data.packName,
      line: `\nProcess exited with code ${exitCode}`,
    } satisfies LaunchLogEvent)
    this.publishState(session)
    discordService.clearPlaying(sessionId)
    void this.persistRegistry()
  }

  private publishState(session: InternalLaunchSession): void {
    session.data.updatedAt = Date.now()
    sendToTrustedWindows(IpcChannels.LAUNCH_STATE, {
      session: cloneSession(session.data),
    } satisfies LaunchStateEvent)
  }

  private listSessions(): LaunchSession[] {
    return [...this.sessions.values()]
      .map((session) => cloneSession(session.data))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  private getLog(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    if (!session) throw new IpcError('NOT_FOUND', 'Die Start-Sitzung wurde nicht gefunden.')
    return session.log.getText()
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new IpcError('NOT_FOUND', 'Die Start-Sitzung wurde nicht gefunden.')
    if (!isCompletedLaunchState(session.data.state)) {
      throw new IpcError('CONFLICT', 'Eine laufende Minecraft-Sitzung muss zuerst beendet werden.')
    }
    this.dropSession(sessionId)
  }

  private dropSession(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return
    sendToTrustedWindows(IpcChannels.LAUNCH_SESSION_REMOVED, {
      sessionId,
    } satisfies LaunchSessionRemovedEvent)
  }

  private async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || (session.data.state !== 'running' && session.data.state !== 'launching')) {
      throw new IpcError('NOT_FOUND', 'Diese Minecraft-Sitzung läuft nicht mehr.')
    }
    if (session.data.state === 'launching') session.preparationAbort?.abort(new DOMException('Start abgebrochen', 'AbortError'))
    if (session.child) {
      session.child.kill()
      return
    }
    if (session.data.pid) {
      const pid = session.data.pid
      const identity = await getProcessIdentity(pid)
      if (!identity || identity !== session.data.processIdentity) {
        this.handleExit(sessionId, -1)
        throw new IpcError('NOT_FOUND', 'Der ursprüngliche Minecraft-Prozess läuft nicht mehr.')
      }
      try { process.kill(pid) } catch {
        throw new IpcError('IO_ERROR', 'Der getrennte Minecraft-Prozess konnte nicht beendet werden.')
      }
      void this.reconcileKilledProcess(sessionId, pid)
    }
  }

  async detachAll(): Promise<void> {
    if (this.registryPoll) clearInterval(this.registryPoll)
    this.registryPoll = null
    for (const session of this.sessions.values()) {
      if (!session.child) continue
      session.data.detached = true
      session.child.unref()
      session.child = undefined
      for (const reader of session.readers) reader.close()
      session.readers = []
    }
    await this.persistRegistry()
  }

  private async reconcileKilledProcess(sessionId: string, pid: number): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const session = this.sessions.get(sessionId)
      if (!session || session.data.pid !== pid || session.data.state !== 'running') return
      const identity = await getProcessIdentity(pid)
      if (!identity || identity !== session.data.processIdentity) {
        this.handleExit(sessionId, -1)
        return
      }
    }

    const session = this.sessions.get(sessionId)
    if (!session || session.data.pid !== pid || session.data.state !== 'running') return
    const identity = await getProcessIdentity(pid)
    if (!identity || identity !== session.data.processIdentity) {
      this.handleExit(sessionId, -1)
      return
    }
    try {
      process.kill(pid, 'SIGKILL')
      logger.warn(`[LaunchService] Forced termination after graceful timeout for session ${sessionId}`)
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const currentIdentity = await getProcessIdentity(pid)
        if (!currentIdentity || currentIdentity !== session.data.processIdentity) {
          this.handleExit(sessionId, -1)
          return
        }
      }
      session.data.error = 'Die Beendigung wurde angefordert; der Prozess läuft noch.'
      this.publishState(session)
    } catch (error) {
      session.data.error = 'Der Minecraft-Prozess konnte nicht beendet werden. Bitte versuche es erneut.'
      this.publishState(session)
      logger.warn(`[LaunchService] Forced termination failed for session ${sessionId}:`, error)
    }
  }

  private async reconcileDetachedProcesses(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (!session.data.detached || !session.data.pid || session.data.state !== 'running') continue
      const identity = await getProcessIdentity(session.data.pid)
      if (!identity || identity !== session.data.processIdentity) this.handleExit(session.data.id, -1)
    }
  }

  private persistRegistry(): Promise<void> {
    const snapshot = this.listSessions().filter((session) => (
      session.state === 'running'
      && typeof session.pid === 'number'
      && typeof session.processIdentity === 'string'
    ))
    const operation = this.persistenceQueue.then(() => atomicWriteFile(
      this.registryPath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
    ))
    this.persistenceQueue = operation.catch(() => {})
    return operation
  }

  private pruneInactiveSessions(): void {
    const inactive = [...this.sessions.values()]
      .filter((session) => session.data.state === 'closed' || session.data.state === 'crashed')
      .sort((left, right) => right.data.updatedAt - left.data.updatedAt)
    for (const session of inactive.slice(Constants.launchSessionHistoryMax)) {
      this.dropSession(session.data.id)
    }
  }

  private async resolveInstanceDir(packName: string, create: boolean): Promise<string> {
    const directory = await configService.getInstanceDir(packName, create)
    try {
      const stat = await fs.lstat(directory)
      if (stat.isSymbolicLink()) throw new IpcError('INVALID_PAYLOAD', 'Symbolische Instanzpfade sind nicht erlaubt.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) throw new IpcError('NOT_FOUND', 'Der Instanzordner wurde nicht gefunden.')
    }
    return directory
  }

  private async deletePack(packName: string): Promise<{ success: boolean; error?: string }> {
    if (configService.isStorageMigrationActive()) {
      return { success: false, error: 'Während der Datenmigration können Modpacks nicht gelöscht werden.' }
    }
    const owner = `delete:${randomUUID()}`
    try {
      packOperationService.beginMutation(packName, owner)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error
          ? error.message
          : 'Das Modpack kann gerade nicht gelöscht werden.',
      }
    }
    try {
      const directory = await this.resolveInstanceDir(packName, false)
      await fs.rm(directory, { recursive: true, force: true })
      const config = configService.get()
      const updates: Partial<LauncherConfig> = {}
      if (config.packConfigs[packName]) {
        const { [packName]: _removed, ...remaining } = config.packConfigs
        updates.packConfigs = remaining
      }
      if (config.lastPlayedPacks.includes(packName)) {
        updates.lastPlayedPacks = config.lastPlayedPacks.filter((entry) => entry !== packName)
      }
      if (Object.keys(updates).length) {
        configService.merge(updates)
        await configService.save()
      }
      return { success: true }
    } catch (error) {
      logger.warn(`[LaunchService] Pack deletion failed for ${packName}:`, error)
      return { success: false, error: 'Das Modpack konnte nicht gelöscht werden.' }
    } finally {
      packOperationService.endMutation(packName, owner)
    }
  }

  private async createShortcut(packName: string): Promise<void> {
    const executablePath = app.getPath('exe')
    const desktopPath = app.getPath('desktop')
    if (process.platform === 'win32') {
      const shortcutPath = path.join(desktopPath, `${packName}.lnk`)
      const instanceDir = await this.resolveInstanceDir(packName, false)
      let iconPath = executablePath
      for (const candidate of [path.join(instanceDir, 'pack.ico'), path.join(instanceDir, 'pack.png')]) {
        try { await fs.access(candidate); iconPath = candidate; break } catch { /* next */ }
      }
      if (!shell.writeShortcutLink(shortcutPath, 'create', {
        target: executablePath,
        args: `--pack "${packName}"`,
        icon: iconPath,
        iconIndex: 0,
      })) throw new Error('Die Windows-Verknüpfung konnte nicht erstellt werden.')
    } else if (process.platform === 'linux') {
      const instanceDir = await this.resolveInstanceDir(packName, false)
      let icon = executablePath
      for (const candidate of [path.join(instanceDir, 'pack.png'), path.join(instanceDir, 'pack.svg')]) {
        try { await fs.access(candidate); icon = candidate; break } catch { /* next */ }
      }
      const contents = [
        '[Desktop Entry]',
        'Type=Application',
        'Version=1.0',
        `Name=MyFTB – ${packName}`,
        `Exec=${executablePath} --pack "${packName}"`,
        `Icon=${icon}`,
        'Terminal=false',
        'Categories=Game;',
      ].join('\n')
      const shortcut = path.join(desktopPath, `${packName}.desktop`)
      await fs.writeFile(shortcut, contents, { encoding: 'utf8', mode: 0o755 })
    }
  }

  private async uploadCrash(packName: string): Promise<string> {
    const instanceDir = await this.resolveInstanceDir(packName, false)
    const crashDir = path.join(instanceDir, 'crash-reports')
    await assertContainedNoLinks(instanceDir, crashDir, { includeLeaf: true, label: 'Absturzberichtspfad' })
    const crashDirStat = await fs.lstat(crashDir)
    if (!crashDirStat.isDirectory() || crashDirStat.isSymbolicLink()) {
      throw new IpcError('INVALID_PAYLOAD', 'Der Absturzberichtspfad ist nicht sicher.')
    }
    const entries = await fs.readdir(crashDir, { withFileTypes: true })
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.txt'))
      .map(async (entry) => {
        const filePath = path.join(crashDir, entry.name)
        const stat = await fs.lstat(filePath)
        if (!stat.isFile() || stat.isSymbolicLink()) return null
        return { filePath, mtime: stat.mtimeMs }
      }))
    const latest = candidates
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((a, b) => b.mtime - a.mtime)[0]
    if (!latest) throw new IpcError('NOT_FOUND', 'Kein Absturzbericht wurde gefunden.')
    const report = await readSafeRegularFile(latest.filePath, {
      maxBytes: 10 * 1024 * 1024,
      label: 'Absturzbericht',
    })
    return uploadToPaste(report.toString('utf8'))
  }
}

export const launchService = new LaunchService()
