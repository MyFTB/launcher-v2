import { Client } from '@xhayper/discord-rpc'

import { Constants } from '../constants'
import { logger } from '../logger'

interface PlayingSession {
  sessionId: string
  packTitle: string
  startedAt: number
}

class DiscordService {
  private client: Client | null = null
  private ready = false
  private destroyed = false
  private sessions = new Map<string, PlayingSession>()
  private updateInterval: ReturnType<typeof setInterval> | null = null
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null

  registerHandlers(): void {
    // No renderer IPC.
  }

  init(): void {
    this.destroyed = false
    this.connect()
  }

  setPlaying(sessionId: string, packTitle: string, startedAt = Date.now()): void {
    this.sessions.set(sessionId, { sessionId, packTitle, startedAt })
    this.pushPresence()
  }

  clearPlaying(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.pushPresence()
  }

  setIdle(): void {
    this.sessions.clear()
    this.pushPresence()
  }

  destroy(): void {
    this.destroyed = true
    this.teardown()
  }

  private connect(): void {
    if (this.destroyed) return
    this.teardown()
    const client = new Client({ clientId: Constants.discordAppId, transport: { type: 'ipc' } })
    this.client = client
    client.on('ready', () => {
      if (this.client !== client || this.destroyed) return
      this.ready = true
      this.pushPresence()
      this.startUpdateLoop()
    })
    client.on('disconnected', () => {
      if (this.client !== client || this.destroyed) return
      this.ready = false
      this.stopUpdateLoop()
      this.scheduleReconnect(30_000)
    })
    client.login().catch(() => {
      if (this.client !== client || this.destroyed) return
      this.ready = false
      this.scheduleReconnect(60_000)
    })
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.destroyed) return
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout)
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      this.connect()
    }, delayMs)
  }

  private currentSession(): PlayingSession | undefined {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt)[0]
  }

  private pushPresence(): void {
    if (!this.client || !this.ready) return
    const session = this.currentSession()
    const activity = session
      ? {
          details: `Spielt ${session.packTitle}`,
          largeImageKey: 'myftb',
          startTimestamp: Math.floor(session.startedAt / 1_000),
        }
      : { details: 'Im Launcher', largeImageKey: 'myftb' }
    this.client.user?.setActivity(activity).catch((error: unknown) => {
      logger.warn('[DiscordService] Presence update failed:', error)
    })
  }

  private startUpdateLoop(): void {
    this.stopUpdateLoop()
    this.updateInterval = setInterval(() => this.pushPresence(), 15_000)
  }

  private stopUpdateLoop(): void {
    if (this.updateInterval) clearInterval(this.updateInterval)
    this.updateInterval = null
  }

  private teardown(): void {
    this.stopUpdateLoop()
    this.ready = false
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout)
    this.reconnectTimeout = null
    const client = this.client
    this.client = null
    if (client) {
      client.removeAllListeners()
      try { client.destroy() } catch { /* optional integration */ }
    }
  }
}

export const discordService = new DiscordService()
