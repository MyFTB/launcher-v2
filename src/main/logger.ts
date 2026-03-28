/**
 * MyFTB Launcher — file-based logger for the main process.
 *
 * Writes structured log lines to `{userData}/logs/launcher.log`.
 * The log directory must be provided once via `logger.init(logsDir)`, called
 * from `index.ts` after `app.whenReady()`.  Before `init()` is called all
 * writes are silently dropped (safe to call early).
 *
 * Call `logger.captureConsole()` immediately after `init()` to redirect the
 * global `console.*` methods into the log file.  This ensures that output
 * from third-party libraries (e.g. @xmcl/installer, electron-updater) that
 * use `console.*` directly is also persisted.
 *
 * In development mode (`NODE_ENV === 'development'`) output is also mirrored
 * to the original `console.*` methods so DevTools / terminal output keeps
 * working.
 *
 * No Electron imports — intentionally dependency-free so the module can be
 * imported in unit-test (Node.js) environments without mocking Electron.
 *
 * Usage (app startup):
 *   logger.init(app.getPath('logs'))
 *   logger.captureConsole()
 *
 * Usage (any service):
 *   import { logger } from '../logger'
 *   logger.info('[MyService] Starting…')
 *   logger.error('[MyService] Something failed:', err)
 */

import fs from 'node:fs'
import path from 'node:path'

// ─── Types ─────────────────────────────────────────────────────────────────────

type LogLevel = 'DEBUG' | 'INFO ' | 'WARN ' | 'ERROR'

// ─── Exported helpers ──────────────────────────────────────────────────────────

/**
 * Serialise a single log argument to a string.
 * Exported for unit testing.
 *
 * AggregateError is handled specially: its .message is always empty, so we
 * extract the first child error message and append a count of the remainder.
 */
export function formatLogArg(a: unknown): string {
  // AggregateError extends Error but has an empty .message — the real
  // information lives in .errors[].  Must be checked before instanceof Error.
  if (a instanceof AggregateError) {
    const base = a.stack ?? a.constructor.name
    if (a.errors.length === 0) return base
    const first = a.errors[0]
    const firstMsg = first instanceof Error
      ? (first.message || first.constructor.name)
      : String(first)
    const extra = a.errors.length > 1 ? ` (+${a.errors.length - 1} more)` : ''
    return `${base}\n  Caused by: ${firstMsg}${extra}`
  }
  if (a instanceof Error) {
    return a.stack ?? `${a.constructor.name}: ${a.message}`
  }
  if (typeof a === 'object' && a !== null) {
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  }
  return String(a)
}

// ─── Logger ────────────────────────────────────────────────────────────────────

class Logger {
  private logPath: string | null = null
  private sessionStartWritten = false
  private readonly isDev = process.env.NODE_ENV === 'development'

  /**
   * Original console methods captured at module load time — before any call
   * to captureConsole().  Used in dev-mode mirroring to avoid infinite recursion
   * after the global console has been overridden.
   */
  private readonly origConsole = {
    log:   console.log.bind(console),
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Maximum log file size in bytes before truncation (5 MB). */
  private static readonly MAX_LOG_SIZE = 5 * 1024 * 1024

  /**
   * Set the directory where `launcher.log` will be written.
   * Must be called once after `app.whenReady()`:
   *   logger.init(app.getPath('logs'))
   *
   * Truncates an existing log file if it exceeds MAX_LOG_SIZE.
   */
  init(logsDir: string): void {
    this.logPath = path.join(logsDir, 'launcher.log')

    // Truncate oversized log from previous sessions
    try {
      const stat = fs.statSync(this.logPath)
      if (stat.size > Logger.MAX_LOG_SIZE) {
        const buf = fs.readFileSync(this.logPath, 'utf8')
        // Keep only the last portion that fits within the limit
        const trimmed = buf.slice(buf.length - Logger.MAX_LOG_SIZE)
        // Start from the first full line to avoid a partial opening line
        const firstNewline = trimmed.indexOf('\n')
        fs.writeFileSync(this.logPath, firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed, 'utf8')
      }
    } catch {
      // File may not exist yet - that's fine
    }
  }

  /**
   * Redirect the global `console.*` methods so that any code — including
   * third-party libraries — that calls `console.error()` etc. is also
   * written to the log file.
   *
   * Call this once, immediately after `init()`.
   * The original methods are preserved in `origConsole` for dev-mode mirroring.
   */
  captureConsole(): void {
    console.log   = (...args: unknown[]) => this.info(...args)
    console.info  = (...args: unknown[]) => this.info(...args)
    console.warn  = (...args: unknown[]) => this.warn(...args)
    console.error = (...args: unknown[]) => this.error(...args)
    console.debug = (...args: unknown[]) => this.debug(...args)
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Append a single line to the log file (synchronous, best-effort). */
  private writeLine(line: string): void {
    if (!this.logPath) return

    try {
      if (!this.sessionStartWritten) {
        const sep = `\n--- session start ${new Date().toISOString()} ---\n`
        fs.appendFileSync(this.logPath, sep, 'utf8')
        this.sessionStartWritten = true
      }
      fs.appendFileSync(this.logPath, line + '\n', 'utf8')
    } catch {
      // Never let logging crash the app
    }
  }

  /** Serialise log arguments to a single string. */
  private formatArgs(args: unknown[]): string {
    return args.map(formatLogArg).join(' ')
  }

  private log(level: LogLevel, args: unknown[]): void {
    const ts = new Date().toISOString()
    const message = this.formatArgs(args)
    const line = `[${ts}] [${level}] ${message}`

    this.writeLine(line)

    // Use the saved originals to avoid infinite recursion when captureConsole()
    // has overridden the global console.
    if (this.isDev) {
      switch (level) {
        case 'ERROR':
          this.origConsole.error(...args)
          break
        case 'WARN ':
          this.origConsole.warn(...args)
          break
        case 'DEBUG':
          this.origConsole.debug(...args)
          break
        default:
          this.origConsole.log(...args)
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  debug(...args: unknown[]): void {
    this.log('DEBUG', args)
  }

  info(...args: unknown[]): void {
    this.log('INFO ', args)
  }

  warn(...args: unknown[]): void {
    this.log('WARN ', args)
  }

  error(...args: unknown[]): void {
    this.log('ERROR', args)
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────────

export const logger = new Logger()
