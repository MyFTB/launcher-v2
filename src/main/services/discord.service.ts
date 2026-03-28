import { Client } from '@xhayper/discord-rpc'

import { Constants } from '../constants'
import { logger } from '../logger'

// ─── Types ────────────────────────────────────────────────────────────────────

type PresenceState =
  | { kind: 'idle' }
  | { kind: 'playing'; packTitle: string; startTimestamp: number }

// ─── Service ─────────────────────────────────────────────────────────────────

class DiscordService {
  private client: Client | null = null
  private ready = false
  private currentState: PresenceState = { kind: 'idle' }

  /**
   * Interval handle for the periodic presence refresh (max every 15 s to
   * stay within Discord's RPC rate limit).
   */
  private updateInterval: ReturnType<typeof setInterval> | null = null

  /** Timeout handle for pending reconnect attempts, cleared in teardown. */
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Hook for IPC handler registration.  No IPC handlers are needed for the
   * Discord service; this method exists so the service follows the same
   * lifecycle contract as every other service (called by router.ts).
   */
  registerHandlers(): void {
    // No IPC handlers needed.
  }

  /**
   * Initialise the discord-rpc client and connect to Discord.
   * Connection errors are caught and logged so that a missing Discord
   * installation never prevents the launcher from starting.
   * Auto-reconnect is handled via the 'disconnected' event.
   */
  init(): void {
    this.connect()
  }

  // ── Public presence API ───────────────────────────────────────────────────

  /**
   * Set the Rich Presence to the launcher idle state.
   * Details: 'Im Launcher', no state line.
   */
  setIdle(): void {
    this.currentState = { kind: 'idle' }
    this.pushPresence()
  }

  /**
   * Set the Rich Presence to the playing state for the given modpack.
   * Details: 'Spielt <packTitle>', with a start timestamp.
   */
  setPlaying(packTitle: string): void {
    this.currentState = {
      kind: 'playing',
      packTitle,
      startTimestamp: Math.floor(Date.now() / 1000),
    }
    this.pushPresence()
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private connect(): void {
    // Tear down any previous client before creating a new one.
    this.teardown()

    const client = new Client({ clientId: Constants.discordAppId, transport: { type: 'ipc' } })
    this.client = client

    client.on('ready', () => {
      this.ready = true
      logger.info('[DiscordService] Connected to Discord.')
      this.pushPresence()
      this.startUpdateLoop()
    })

    // discord-rpc emits 'disconnected' when the pipe closes mid-session.
    client.on('disconnected', () => {
      logger.warn('[DiscordService] Disconnected from Discord; will attempt to reconnect.')
      this.ready = false
      this.stopUpdateLoop()
      // Wait 30 s before retrying so we don't spam reconnect attempts.
      this.reconnectTimeout = setTimeout(() => this.connect(), 30_000)
    })

    client
      .login()
      .catch((err: unknown) => {
        // Discord is likely not running — this is not a fatal error.
        logger.warn('[DiscordService] Could not connect to Discord:', err)
        this.ready = false
        // Retry after 60 s in case Discord is launched later.
        this.reconnectTimeout = setTimeout(() => this.connect(), 60_000)
      })
  }

  private teardown(): void {
    this.stopUpdateLoop()
    this.ready = false

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.client) {
      try {
        this.client.destroy()
      } catch {
        // Ignore errors during teardown.
      }
      this.client = null
    }
  }

  /**
   * Push the current presence state to Discord if the client is ready.
   */
  private pushPresence(): void {
    if (!this.client || !this.ready) return

    const state = this.currentState

    if (state.kind === 'idle') {
      this.client
        .user
        ?.setActivity({
          details: 'Im Launcher',
          largeImageKey: 'myftb',
        })
        .catch((err: unknown) => {
          logger.warn('[DiscordService] Failed to update presence (idle):', err)
        })
    } else {
      this.client
        .user
        ?.setActivity({
          details: 'Spielt ' + state.packTitle,
          largeImageKey: 'myftb',
          startTimestamp: state.startTimestamp,
        })
        .catch((err: unknown) => {
          logger.warn('[DiscordService] Failed to update presence (playing):', err)
        })
    }
  }

  /**
   * Start the periodic presence refresh loop (every 15 seconds).
   * Discord's RPC rate limit allows ~5 updates per 20 s; 15 s is a safe cadence.
   */
  private startUpdateLoop(): void {
    this.stopUpdateLoop()
    this.updateInterval = setInterval(() => {
      this.pushPresence()
    }, 15_000)
  }

  private stopUpdateLoop(): void {
    if (this.updateInterval !== null) {
      clearInterval(this.updateInterval)
      this.updateInterval = null
    }
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const discordService = new DiscordService()
