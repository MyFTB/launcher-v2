import { useState, useEffect, useRef } from 'react'
import type {
  UpdateAvailableEvent,
  UpdateProgressEvent,
  UpdateDownloadedEvent,
  UpdateErrorEvent,
} from '@shared/types'

type UpdateState =
  | { status: 'idle' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number; bytesPerSecond: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

function formatSpeed(bps: number): string {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`
  return `${Math.round(bps / 1024)} KB/s`
}

export default function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  const [dismissed, setDismissed] = useState(false)
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    const unsubAvailable = window.electronAPI.on('update:available', (...args: unknown[]) => {
      const event = args[0] as UpdateAvailableEvent
      setState({ status: 'available', version: event.version })
      setDismissed(false)
    })

    const unsubProgress = window.electronAPI.on('update:progress', (...args: unknown[]) => {
      const event = args[0] as UpdateProgressEvent
      setState({ status: 'downloading', percent: event.percent, bytesPerSecond: event.bytesPerSecond })
    })

    const unsubDownloaded = window.electronAPI.on('update:downloaded', (...args: unknown[]) => {
      const event = args[0] as UpdateDownloadedEvent
      setState({ status: 'downloaded', version: event.version })
      setDismissed(false)
    })

    const unsubError = window.electronAPI.on('update:error', (...args: unknown[]) => {
      const event = args[0] as UpdateErrorEvent
      setState({ status: 'error', message: event.message })
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current)
      errorTimeoutRef.current = setTimeout(() => setState({ status: 'idle' }), 6000)
    })

    return () => {
      unsubAvailable()
      unsubProgress()
      unsubDownloaded()
      unsubError()
    }
  }, [])

  const visible = !dismissed && state.status !== 'idle'

  return (
    <div
      className={`overflow-hidden transition-all duration-300 ease-in-out ${
        visible ? 'max-h-12' : 'max-h-0'
      }`}
    >
      {state.status === 'available' && (
        <div className="flex items-center justify-between gap-4 px-4 py-2 bg-bg-elevated border-b border-accent/25 text-sm no-drag">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
            <span className="text-text-secondary">
              Version <span className="font-semibold text-text-primary">{state.version}</span> verfügbar
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn-primary h-7 px-3 text-xs"
              onClick={() => window.electronAPI.updateDownload()}
            >
              Herunterladen
            </button>
            <button
              className="p-1 rounded text-text-muted hover:text-text-primary transition-colors"
              onClick={() => setDismissed(true)}
              title="Schließen"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {state.status === 'downloading' && (
        <div className="flex items-center gap-3 px-4 py-2 bg-bg-elevated border-b border-border no-drag">
          <span className="text-xs text-text-secondary shrink-0">
            Update {Math.round(state.percent)}%
          </span>
          <div className="flex-1 h-1 bg-bg-overlay rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300"
              style={{ width: `${state.percent}%` }}
            />
          </div>
          <span className="text-xs text-text-muted shrink-0">
            {formatSpeed(state.bytesPerSecond)}
          </span>
        </div>
      )}

      {state.status === 'downloaded' && (
        <div className="flex items-center justify-between gap-4 px-4 py-2 bg-accent/10 border-b border-accent/30 text-sm no-drag">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-4 h-4 text-accent shrink-0">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-text-secondary">
              Version <span className="font-semibold text-text-primary">{state.version}</span> bereit zur Installation
            </span>
          </div>
          <button
            className="btn-primary h-7 px-3 text-xs"
            onClick={() => window.electronAPI.updateInstall()}
          >
            Neu starten &amp; installieren
          </button>
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-900/20 border-b border-red-700/30 text-sm no-drag">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4 text-red-400 shrink-0">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-red-400 text-xs">Update-Fehler: {state.message}</span>
        </div>
      )}
    </div>
  )
}
