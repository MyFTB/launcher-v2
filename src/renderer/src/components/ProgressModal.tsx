import { useState } from 'react'
import type { DownloadFailure, InstallProgressEvent } from '@shared/types'

interface ProgressModalProps {
  progress: InstallProgressEvent | null
  packTitle: string
  result: { success: boolean; error?: string; failures?: DownloadFailure[] } | null
  successText?: string
  onCancel: () => void
  onDismiss: () => void
  onRetry?: () => void
  onRepair?: () => void
  onOpenLogs?: () => void
}

export default function ProgressModal({
  progress,
  packTitle,
  result,
  successText = 'Erfolgreich installiert!',
  onCancel,
  onDismiss,
  onRetry,
  onRepair,
  onOpenLogs,
}: ProgressModalProps) {
  const [showDetails, setShowDetails] = useState(false)
  const percent =
    progress && progress.total > 0
      ? Math.round((progress.finished / progress.total) * 100)
      : 0

  const currentFile = progress?.currentFile ?? ''
  const truncatedFile =
    currentFile.length > 60 ? '...' + currentFile.slice(currentFile.length - 57) : currentFile

  // ── Result state ──────────────────────────────────────────────────────────
  if (result) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
        <div className="card w-full max-w-lg mx-4 p-6 animate-slide-up shadow-2xl">
          <div className="flex flex-col items-center gap-4 py-2">
            {result.success ? (
              <>
                <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-8 h-8 text-accent">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div className="text-center">
                  <h2 className="text-lg font-semibold text-text-primary">{packTitle}</h2>
                  <p className="text-sm text-text-secondary mt-1">{successText}</p>
                </div>
              </>
            ) : (
              <>
                <div className="w-14 h-14 rounded-full bg-red-900/30 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-8 h-8 text-red-400">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <div className="text-center">
                  <h2 className="text-lg font-semibold text-text-primary">{packTitle}</h2>
                  <p className="text-sm text-red-400 mt-1">{result.error ?? 'Installation fehlgeschlagen'}</p>
                </div>
              </>
            )}
            {!result.success && showDetails && (
              <div className="max-h-40 w-full overflow-auto rounded-md bg-bg-base p-3 text-left font-mono text-xs text-text-muted">
                {result.failures?.length ? result.failures.map((failure, index) => (
                  <p key={`${failure.task}-${index}`} className="mb-1 break-words">
                    {failure.task}: {failure.message} ({failure.kind}, Versuch {failure.attempts})
                  </p>
                )) : <p>{result.error ?? 'Keine weiteren Details verfügbar.'}</p>}
              </div>
            )}
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              {!result.success && onRetry && <button className="btn-primary" onClick={onRetry}>Erneut versuchen</button>}
              {!result.success && onRepair && <button className="btn-secondary" onClick={onRepair}>Modpack reparieren</button>}
              {!result.success && (
                <button className="btn-ghost" onClick={() => setShowDetails((value) => !value)}>
                  {showDetails ? 'Details ausblenden' : 'Details'}
                </button>
              )}
              {!result.success && onOpenLogs && <button className="btn-ghost" onClick={onOpenLogs}>Logs öffnen</button>}
              <button className={result.success ? 'btn-primary px-8' : 'btn-ghost'} onClick={onDismiss}>
                {result.success ? 'OK' : 'Schließen'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Progress state ────────────────────────────────────────────────────────
  const isPreparing = !progress || progress.total === 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="card w-full max-w-lg mx-4 p-6 animate-slide-up shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">{packTitle}</h2>
          {!isPreparing && (
            <span className="text-sm font-mono text-accent">{percent}%</span>
          )}
        </div>

        {isPreparing ? (
          /* Indeterminate phase — Minecraft/Forge install, version fetching, etc. */
          <div className="mb-5">
            <div className="relative w-full h-2 bg-bg-elevated rounded-full overflow-hidden mb-3">
              <div className="absolute h-full w-2/5 bg-accent rounded-full animate-[progressBar_1.5s_ease-in-out_infinite]" />
            </div>
            <p className="text-sm text-text-secondary truncate">
              {truncatedFile || 'Vorbereitung…'}
            </p>
          </div>
        ) : (
          /* Determinate phase — file task downloads */
          <>
            <div className="w-full h-2 bg-bg-elevated rounded-full overflow-hidden mb-3">
              <div
                className="h-full bg-accent rounded-full transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs text-text-muted mb-3">
              <span>{progress!.finished} von {progress!.total} Dateien</span>
              {progress!.failed > 0 && (
                <span className="text-red-400">{progress!.failed} fehlgeschlagen</span>
              )}
            </div>

            {truncatedFile && (
              <p className="text-xs text-text-muted font-mono bg-bg-elevated rounded px-3 py-1.5 mb-2 truncate">
                {truncatedFile}
              </p>
            )}
          </>
        )}

        <div className="flex justify-end mt-3">
          <button className="btn-danger" onClick={onCancel}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  )
}
