import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { isCompletedLaunchState, type LaunchState } from '@shared/types'
import { useLaunchStore } from '../store/launch.store'

function stateLabel(state: LaunchState): string {
  switch (state) {
    case 'launching': return 'Startet'
    case 'running': return 'Läuft'
    case 'crashed': return 'Abgestürzt'
    case 'closed': return 'Beendet'
  }
}

function lineClass(line: string): string {
  if (/\b(ERROR|FATAL|Exception|Caused by:)\b/i.test(line)) return 'text-red-300'
  if (/\b(WARN|WARNING)\b/i.test(line)) return 'text-amber-300'
  if (/\b(DEBUG|TRACE)\b/i.test(line)) return 'text-text-muted'
  return 'text-text-secondary'
}

const LogLine = memo(function LogLine({ line }: { line: string }) {
  return (
    <div className={`px-3 py-0.5 whitespace-pre-wrap break-words ${lineClass(line)}`}>
      {line || ' '}
    </div>
  )
})

export default function Console() {
  const sessions = useLaunchStore((state) => state.sessions)
  const selectedSessionId = useLaunchStore((state) => state.selectedSessionId)
  const selectSession = useLaunchStore((state) => state.selectSession)
  const fetchLog = useLaunchStore((state) => state.fetchLog)
  const kill = useLaunchStore((state) => state.kill)
  const removeSession = useLaunchStore((state) => state.removeSession)
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [removingSessionIds, setRemovingSessionIds] = useState<ReadonlySet<string>>(() => new Set())
  const removingSessionIdsRef = useRef(new Set<string>())
  const viewportRef = useRef<HTMLDivElement>(null)

  const ordered = useMemo(
    () => Object.values(sessions).sort((a, b) => b.startedAt - a.startedAt),
    [sessions],
  )
  const selected = (selectedSessionId ? sessions[selectedSessionId] : undefined) ?? ordered[0]

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('session')
    if (requested && sessions[requested]) selectSession(requested)
  }, [sessions, selectSession])

  useEffect(() => {
    if (!selected || selected.logLines.length > 0) return
    void fetchLog(selected.id).catch(() => {})
  }, [selected?.id, selected?.logLines.length, fetchLog])

  const visibleLines = useMemo(() => {
    const lines = selected?.logLines ?? []
    if (!query.trim()) return lines
    const normalized = query.toLocaleLowerCase('de-DE')
    return lines.filter((line) => line.toLocaleLowerCase('de-DE').includes(normalized))
  }, [selected?.logLines, query])

  useEffect(() => {
    if (!follow || !viewportRef.current) return
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight
  }, [visibleLines.length, follow, selected?.id])

  const showMessage = (value: string): void => {
    setMessage(value)
    setTimeout(() => setMessage(null), 4_000)
  }

  const handleRemoveSession = async (sessionId: string): Promise<void> => {
    if (removingSessionIdsRef.current.has(sessionId)) return
    removingSessionIdsRef.current.add(sessionId)
    setRemovingSessionIds(new Set(removingSessionIdsRef.current))
    try {
      await removeSession(sessionId)
    } catch (error) {
      showMessage(error instanceof Error
        ? error.message
        : 'Der Konsolen-Tab konnte nicht geschlossen werden. Bitte versuche es erneut.')
    } finally {
      removingSessionIdsRef.current.delete(sessionId)
      setRemovingSessionIds(new Set(removingSessionIdsRef.current))
    }
  }

  const handleUpload = async (): Promise<void> => {
    if (!selected) return
    try {
      const url = await window.electronAPI.launchUploadLog(selected.id)
      await navigator.clipboard.writeText(url).catch(() => {})
      showMessage('Log hochgeladen. Der Link wurde kopiert.')
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Der Log konnte nicht hochgeladen werden.')
    }
  }

  const handleCopy = async (): Promise<void> => {
    if (!selected) return
    await navigator.clipboard.writeText(selected.logLines.join('\n'))
    showMessage('Log kopiert.')
  }

  const active = selected?.state === 'running' || selected?.state === 'launching'

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-surface" aria-label="Minecraft-Konsolen">
      <div
        className="flex min-h-10 items-end gap-1 overflow-x-auto border-b border-border bg-bg-elevated px-2 pt-1"
        role="tablist"
        aria-label="Start-Sitzungen"
      >
        {ordered.length === 0 ? (
          <span className="px-2 pb-2 text-xs text-text-muted">Keine Start-Sitzung</span>
        ) : ordered.map((session) => {
          const isSelected = session.id === selected?.id
          const isActive = session.state === 'running' || session.state === 'launching'
          const canRemove = isCompletedLaunchState(session.state)
          const isRemoving = removingSessionIds.has(session.id)
          return (
            <div
              key={session.id}
              role="presentation"
              className={`flex min-w-36 max-w-56 items-stretch overflow-hidden rounded-t-md border text-xs transition-colors ${
                isSelected
                  ? 'border-border border-b-bg-surface bg-bg-surface text-text-primary'
                  : 'border-transparent text-text-muted hover:bg-bg-overlay hover:text-text-secondary'
              }`}
            >
              <button
                type="button"
                onClick={() => selectSession(session.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                aria-selected={isSelected}
                role="tab"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${
                  isActive ? 'bg-accent' : session.state === 'crashed' ? 'bg-red-400' : 'bg-text-muted/50'
                }`} />
                <span className="min-w-0 flex-1 truncate">{session.packTitle}</span>
              </button>
              {canRemove && (
                <button
                  type="button"
                  className="flex w-8 shrink-0 items-center justify-center text-text-muted transition-colors hover:bg-bg-overlay hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-wait disabled:opacity-50"
                  onClick={() => void handleRemoveSession(session.id)}
                  disabled={isRemoving}
                  aria-label={`Konsolen-Tab „${session.packTitle}“ schließen`}
                  title="Tab schließen"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex min-h-10 items-center gap-2 border-b border-border px-3 py-1.5">
        {selected ? (
          <>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              active ? 'bg-accent/10 text-accent' : selected.state === 'crashed' ? 'bg-red-900/30 text-red-300' : 'bg-bg-overlay text-text-muted'
            }`}>
              {stateLabel(selected.state)}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
              {selected.packName}{selected.pid ? ` · PID ${selected.pid}` : ''}
            </span>
            <label className="relative">
              <span className="sr-only">Log durchsuchen</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Log durchsuchen…"
                className="input h-7 w-48 text-xs"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-text-muted">
              <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
              Folgen
            </label>
            <button type="button" className="btn-ghost text-xs" onClick={handleCopy}>Kopieren</button>
            <button type="button" className="btn-ghost text-xs" onClick={handleUpload}>Hochladen</button>
            {active && (
              <button
                type="button"
                className="btn-danger text-xs"
                onClick={() => kill(selected.id).catch((error: unknown) => showMessage(error instanceof Error ? error.message : 'Beenden fehlgeschlagen.'))}
              >
                Beenden
              </button>
            )}
          </>
        ) : (
          <span className="text-xs text-text-muted">Starte ein Modpack, um die Konsole zu öffnen.</span>
        )}
      </div>

      {message && (
        <div className="border-b border-border bg-bg-elevated px-3 py-2 text-xs text-text-secondary" role="status">
          {message}
        </div>
      )}

      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto bg-[#101310] py-2 font-mono text-xs leading-5"
        onScroll={(event) => {
          const target = event.currentTarget
          if (target.scrollHeight - target.scrollTop - target.clientHeight > 48) setFollow(false)
        }}
      >
        {!selected ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-text-muted">
            Noch keine Konsolenausgabe.
          </div>
        ) : visibleLines.length === 0 ? (
          <div className="px-4 py-8 text-center text-text-muted">
            {query ? 'Keine Treffer.' : 'Warte auf Konsolenausgabe…'}
          </div>
        ) : (
          visibleLines.map((line, index) => <LogLine key={`${index}-${line.slice(0, 24)}`} line={line} />)
        )}
      </div>
    </section>
  )
}
