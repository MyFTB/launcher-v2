import { useState } from 'react'
import type { DataRecoveryAction, DataRecoveryState } from '@shared/types'

interface RecoveryModalProps {
  state: DataRecoveryState
  onResolved: () => void
}

export default function RecoveryModal({ state, onResolved }: RecoveryModalProps) {
  const [working, setWorking] = useState<DataRecoveryAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmFresh, setConfirmFresh] = useState(false)

  const run = async (action: DataRecoveryAction): Promise<void> => {
    if (action === 'fresh-start' && !confirmFresh) {
      setConfirmFresh(true)
      return
    }
    setWorking(action)
    setError(null)
    try {
      await window.electronAPI.configResolveRecovery(action)
      onResolved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Die Wiederherstellung ist fehlgeschlagen.')
      setWorking(null)
    }
  }

  const updateJournal = state.source === 'update-journal'
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
      <div className="card w-full max-w-xl p-6 shadow-2xl">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-300">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6" aria-hidden="true">
              <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="recovery-title" className="text-lg font-semibold text-text-primary">Daten müssen geprüft werden</h2>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              {state.message ?? 'Der Launcher hat einen beschädigten oder unvollständigen Datenzustand erkannt.'}
            </p>
            <p className="mt-2 text-xs text-text-muted">
              Der Launcher überschreibt die betroffenen Dateien nicht automatisch.
            </p>
            {state.brokenPath && (
              <p className="mt-3 break-all rounded bg-bg-elevated px-3 py-2 font-mono text-xs text-text-muted">
                {state.brokenPath}
              </p>
            )}
          </div>
        </div>

        {error && <p className="mt-4 rounded border border-red-700/50 bg-red-900/25 px-3 py-2 text-sm text-red-300" role="alert">{error}</p>}
        {confirmFresh && (
          <p className="mt-4 rounded border border-amber-600/50 bg-amber-900/20 px-3 py-2 text-sm text-amber-200">
            Wirklich mit einem neuen Datenzustand starten? Die beschädigten Dateien bleiben als Sicherung erhalten.
          </p>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          {!updateJournal && (
            <button
              type="button"
              className="btn-secondary"
              disabled={working !== null}
              onClick={() => void run('locate-data')}
            >
              Datenordner suchen
            </button>
          )}
          {state.backupAvailable && (
            <button
              type="button"
              className="btn-primary"
              disabled={working !== null}
              onClick={() => void run('restore-backup')}
            >
              {updateJournal ? 'Sicherung prüfen' : 'Sicherung wiederherstellen'}
            </button>
          )}
          {updateJournal ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={working !== null}
              onClick={() => void run('accept-current')}
            >
              Aktuelle Daten geprüft – fortfahren
            </button>
          ) : (
            <button
              type="button"
              className={confirmFresh ? 'btn-danger' : 'btn-ghost'}
              disabled={working !== null}
              onClick={() => void run('fresh-start')}
            >
              {confirmFresh ? 'Neuen Start bestätigen' : 'Explizit neu starten'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
