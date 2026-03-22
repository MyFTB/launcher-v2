import type { InstallProgressEvent } from '@shared/types'

interface ProgressModalProps {
  progress: InstallProgressEvent | null
  packTitle: string
  result: { success: boolean; error?: string } | null
  onCancel: () => void
  onDismiss: () => void
}

export default function ProgressModal({ progress, packTitle, result, onCancel, onDismiss }: ProgressModalProps) {
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
                  <p className="text-sm text-text-secondary mt-1">Erfolgreich installiert!</p>
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
            <button className="btn-primary mt-2 px-8" onClick={onDismiss}>
              OK
            </button>
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
            <div className="w-full h-2 bg-bg-elevated rounded-full overflow-hidden mb-3">
              <div className="h-full bg-accent rounded-full animate-[progressBar_1.5s_ease-in-out_infinite]" style={{ width: '40%' }} />
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
