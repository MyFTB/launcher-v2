import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
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

/** Splits `text` into alternating plain/highlighted segments for a search `term`. */
function highlightMatches(text: string, term: string): ReactNode {
  if (!term) return text
  const lower = text.toLowerCase()
  const lowerTerm = term.toLowerCase()
  const nodes: ReactNode[] = []
  let cursor = 0
  let idx = lower.indexOf(lowerTerm, cursor)
  while (idx !== -1) {
    if (idx > cursor) nodes.push(text.slice(cursor, idx))
    nodes.push(
      <mark key={idx} className="bg-yellow-400 text-black rounded-sm px-px">
        {text.slice(idx, idx + term.length)}
      </mark>
    )
    cursor = idx + term.length
    idx = lower.indexOf(lowerTerm, cursor)
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

export default function Console() {
  const [lines, setLines] = useState<LogLine[]>([])
  const [filterText, setFilterText] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)
  const [launchState, setLaunchState] = useState<LaunchState | null>(null)
  const [uploadUrl, setUploadUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentMatchRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Prevents onScroll from disabling auto-scroll during programmatic scrolls
  const programmaticScrollRef = useRef(false)

  const filteredLines = useMemo(() => {
    if (!filterText.trim()) return lines
    const lower = filterText.toLowerCase()
    return lines.filter((l) => l.text.toLowerCase().includes(lower))
  }, [lines, filterText])

  // Reset match index when filter text changes
  useEffect(() => {
    setMatchIndex(0)
  }, [filterText])

  // Scroll current match into view when navigating
  useEffect(() => {
    if (filterText && currentMatchRef.current) {
      programmaticScrollRef.current = true
      currentMatchRef.current.scrollIntoView({ block: 'nearest' })
      requestAnimationFrame(() => { programmaticScrollRef.current = false })
    }
  }, [matchIndex, filterText, filteredLines])

  const appendLines = useCallback((raw: string) => {
    const newLines = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((text): LogLine => ({ id: lineCounter++, text, level: classifyLine(text) }))
    if (newLines.length === 0) return
    setLines((prev) => {
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

  // Subscribe to live log lines and state
  useEffect(() => {
    const unsubLog = window.electronAPI.on('launch:log', (...args: unknown[]) => {
      const event = args[0] as { line: string }
      if (event?.line) appendLines(event.line)
    })
    const unsubState = window.electronAPI.on('launch:state', (...args: unknown[]) => {
      const event = args[0] as { state: LaunchState }
      setLaunchState(event.state)
      // Clear log buffer when a new instance starts
      if (event.state === 'launching') {
        setLines([])
        setAutoScroll(true)
        setFilterText('')
      }
    })
    return () => {
      unsubLog()
      unsubState()
    }
  }, [appendLines])

  // Capture Ctrl+F / Cmd+F to focus the search input
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      programmaticScrollRef.current = true
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      requestAnimationFrame(() => { programmaticScrollRef.current = false })
    }
  }, [lines, autoScroll])

  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current) return
    programmaticScrollRef.current = true
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    requestAnimationFrame(() => { programmaticScrollRef.current = false })
    setAutoScroll(true)
  }, [])

  const navigateMatch = useCallback((dir: 1 | -1) => {
    setMatchIndex((i) => {
      if (filteredLines.length === 0) return 0
      return (i + dir + filteredLines.length) % filteredLines.length
    })
    setAutoScroll(false)
  }, [filteredLines.length])

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
  const safeMatchIndex = filteredLines.length > 0 ? Math.min(matchIndex, filteredLines.length - 1) : 0

  // Memoize line elements so onScroll (setAutoScroll) doesn't recreate 5000 elements per event
  const renderedLines = useMemo(() => {
    if (lines.length === 0) {
      return <p className="text-text-muted py-4">Kein Log-Output vorhanden.</p>
    }
    return lines.map((line) => {
      const isCurrentMatch = filterText.trim() ? filteredLines[safeMatchIndex]?.id === line.id : false
      return (
        <div
          key={line.id}
          ref={isCurrentMatch ? currentMatchRef : undefined}
          className={`leading-5 break-all whitespace-pre-wrap ${levelClass(line.level)} ${isCurrentMatch ? 'bg-bg-elevated -mx-4 px-4' : ''}`}
        >
          {filterText ? highlightMatches(line.text, filterText) : line.text}
        </div>
      )
    })
  }, [lines, filterText, filteredLines, safeMatchIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full">
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
          {/* Search / filter */}
          <div className="flex items-center gap-1">
            <div className="relative flex items-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="absolute left-2 w-3.5 h-3.5 text-text-muted pointer-events-none">
                <circle cx="11" cy="11" r="8" /><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    navigateMatch(e.shiftKey ? -1 : 1)
                  } else if (e.key === 'Escape') {
                    setFilterText('')
                  }
                }}
                placeholder="Suchen... (Enter)"
                className="pl-7 pr-6 py-1 text-xs bg-bg-elevated border border-border rounded focus:outline-none focus:border-border-focus text-text-primary placeholder-text-muted w-44"
              />
              {filterText && (
                <button
                  className="absolute right-1.5 text-text-muted hover:text-text-primary"
                  onClick={() => setFilterText('')}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3 h-3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Match count + navigation */}
            {filterText && (
              <>
                <span className="text-xs text-text-muted tabular-nums">
                  {filteredLines.length > 0 ? `${safeMatchIndex + 1}/${filteredLines.length}` : '0 Treffer'}
                </span>
                <button
                  className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay disabled:opacity-30 transition-colors"
                  onClick={() => navigateMatch(-1)}
                  disabled={filteredLines.length === 0}
                  title="Vorheriger Treffer (Shift+Enter)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                  </svg>
                </button>
                <button
                  className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay disabled:opacity-30 transition-colors"
                  onClick={() => navigateMatch(1)}
                  disabled={filteredLines.length === 0}
                  title="Nächster Treffer (Enter)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </>
            )}
          </div>

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

          {/* Kill button — visible when game is running */}
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
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto bg-bg-base font-mono text-xs p-4 pb-10 space-y-px"
          onScroll={(e) => {
            if (programmaticScrollRef.current) return
            const el = e.currentTarget
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
            setAutoScroll((prev) => prev === atBottom ? prev : atBottom)
          }}
        >
          {renderedLines}
        </div>

        {/* Scroll-to-bottom button — shown when not following */}
        {!autoScroll && !filterText && (
          <button
            className="absolute bottom-3 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full bg-bg-elevated border border-border text-xs text-text-secondary hover:text-text-primary hover:border-border-focus shadow-lg transition-all duration-150 flex items-center gap-1.5 whitespace-nowrap"
            onClick={scrollToBottom}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
            Zum Ende
          </button>
        )}
      </div>
    </div>
  )
}
