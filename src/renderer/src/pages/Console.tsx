import { useEffect, useRef, useState, useCallback } from 'react'
import type { LaunchState } from '@shared/types'

interface LogLine {
  id: number
  text: string
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'OTHER'
}

let lineCounter = 0

function classifyLine(text: string): LogLine['level'] {
  // Formatted lines: [HH:MM:SS] [thread/LEVEL]: message
  const levelTag = text.match(/\[[\w\s]+\/(FATAL|ERROR|WARN|INFO|DEBUG|TRACE)\]/i)?.[1]?.toUpperCase()
  if (levelTag) {
    if (levelTag === 'FATAL' || levelTag === 'ERROR') return 'ERROR'
    if (levelTag === 'WARN') return 'WARN'
    if (levelTag === 'INFO') return 'INFO'
    if (levelTag === 'DEBUG' || levelTag === 'TRACE') return 'DEBUG'
  }
  // Fallback for plain-text lines (launcher output, JVM messages, etc.)
  const upper = text.toUpperCase()
  if (upper.includes('EXCEPTION') || upper.includes('FATAL')) return 'ERROR'
  if (upper.includes('WARN')) return 'WARN'
  return 'OTHER'
}

function levelClass(level: LogLine['level']): string {
  switch (level) {
    case 'ERROR': return 'text-red-400'
    case 'WARN':  return 'text-yellow-400'
    case 'INFO':  return 'text-green-400'
    case 'DEBUG': return 'text-text-muted'
    default:      return 'text-text-secondary'
  }
}

export default function Console(): JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [launchState, setLaunchState] = useState<LaunchState | null>(null)
  const [uploadUrl, setUploadUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const appendLines = useCallback((raw: string) => {
    const newLines = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((text): LogLine => ({ id: lineCounter++, text, level: classifyLine(text) }))
    if (newLines.length === 0) return
    setLines((prev) => {
      // Keep max 5000 lines to avoid memory bloat
      const combined = [...prev, ...newLines]
      return combined.length > 5000 ? combined.slice(combined.length - 5000) : combined
    })
  }, [])

  // Load initial log on mount
  useEffect(() => {
    let cancelled = false
    window.electronAPI.launchGetLog().then((log) => {
      if (!cancelled && log) appendLines(log)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [appendLines])

  // Subscribe to live log lines
  useEffect(() => {
    const unsubLog = window.electronAPI.on('launch:log', (...args: unknown[]) => {
      const event = args[0] as { line: string }
      if (event?.line) appendLines(event.line)
    })
    const unsubState = window.electronAPI.on('launch:state', (...args: unknown[]) => {
      const event = args[0] as { state: LaunchState }
      setLaunchState(event.state)
    })
    return () => {
      unsubLog()
      unsubState()
    }
  }, [appendLines])

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  const handleUpload = useCallback(async () => {
    setUploading(true)
    setUploadError(null)
    setUploadUrl(null)
    try {
      const url = await window.electronAPI.launchUploadLog()
      setUploadUrl(url)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload fehlgeschlagen')
    } finally {
      setUploading(false)
    }
  }, [])

  const handleKill = useCallback(() => {
    window.electronAPI.launchKill().catch(console.error)
  }, [])

  const isRunning = launchState === 'running' || launchState === 'launching'

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-bg-surface border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-text-primary">Konsole</h1>
          {launchState && (
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                launchState === 'running'
                  ? 'bg-accent/10 text-accent'
                  : launchState === 'launching'
                  ? 'bg-yellow-500/10 text-yellow-400'
                  : launchState === 'crashed'
                  ? 'bg-red-900/30 text-red-400'
                  : 'bg-bg-overlay text-text-muted'
              }`}
            >
              {launchState === 'running'
                ? 'Läuft'
                : launchState === 'launching'
                ? 'Startet...'
                : launchState === 'crashed'
                ? 'Abgestürzt'
                : 'Beendet'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Auto-scroll toggle */}
          <label className="flex items-center gap-2 cursor-pointer text-xs text-text-secondary select-none">
            <input
              type="checkbox"
              className="w-3.5 h-3.5 rounded border-border bg-bg-elevated accent-accent"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-Scroll
          </label>

          {/* Clear */}
          <button
            className="btn-ghost text-xs py-1.5 px-2.5"
            onClick={() => setLines([])}
          >
            Leeren
          </button>

          {/* Upload log */}
          <button
            className="btn-secondary text-xs py-1.5"
            onClick={handleUpload}
            disabled={uploading || lines.length === 0}
          >
            {uploading ? 'Lädt...' : 'Log hochladen'}
          </button>

          {/* Kill button — only when running */}
          {isRunning && (
            <button className="btn-danger text-xs py-1.5" onClick={handleKill}>
              Minecraft beenden
            </button>
          )}
        </div>
      </div>

      {/* Upload result / error */}
      {(uploadUrl || uploadError) && (
        <div
          className={`px-4 py-2 text-xs flex items-center justify-between gap-3 flex-shrink-0 ${
            uploadError
              ? 'bg-red-900/20 text-red-400 border-b border-red-700/30'
              : 'bg-accent/5 text-accent border-b border-accent/20'
          }`}
        >
          <span className="truncate">{uploadError ?? uploadUrl}</span>
          {uploadUrl && (
            <button
              className="flex-shrink-0 underline hover:no-underline"
              onClick={() => window.electronAPI.systemOpenUrl(uploadUrl)}
            >
              Öffnen
            </button>
          )}
          <button
            className="flex-shrink-0 text-text-muted hover:text-text-primary"
            onClick={() => { setUploadUrl(null); setUploadError(null) }}
          >
            ×
          </button>
        </div>
      )}

      {/* Log viewer */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-bg-base font-mono text-xs p-4 space-y-px"
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
          if (!atBottom && autoScroll) setAutoScroll(false)
        }}
      >
        {lines.length === 0 ? (
          <p className="text-text-muted py-4">Kein Log-Output vorhanden.</p>
        ) : (
          lines.map((line) => (
            <div key={line.id} className={`leading-5 break-all whitespace-pre-wrap ${levelClass(line.level)}`}>
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
