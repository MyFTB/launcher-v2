import { useState, useEffect, useRef, useCallback } from 'react'
import { ipc } from '../ipc/client'

type DeleteState = 'confirm' | 'deleting' | 'success' | 'error'

interface DeleteConfirmModalProps {
  packName: string
  packTitle: string
  onDismiss: (deleted: boolean) => void
}

export default function DeleteConfirmModal({ packName, packTitle, onDismiss }: DeleteConfirmModalProps) {
  const [state, setState] = useState<DeleteState>('confirm')
  const [errorMsg, setErrorMsg] = useState('')

  // Refs to avoid stale closures in the keydown listener (registered once via [])
  const stateRef = useRef(state)
  const onDismissRef = useRef(onDismiss)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { onDismissRef.current = onDismiss }, [onDismiss])

  // Keyboard handler: Escape dismisses in confirm/success/error, not during deleting
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      const s = stateRef.current
      if (s === 'deleting') return
      onDismissRef.current(s === 'success')
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleDelete = useCallback(async () => {
    setState('deleting')
    try {
      const result = await ipc.launch.deletePack(packName)
      if (result.success) {
        setState('success')
      } else {
        setErrorMsg(result.error ?? 'Das Modpack konnte nicht gelöscht werden.')
        setState('error')
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unbekannter Fehler')
      setState('error')
    }
  }, [packName])

  // Backdrop click: dismiss in success/error only (not confirm or deleting)
  const handleBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (state === 'success') onDismiss(true)
    else if (state === 'error') onDismiss(false)
  }, [state, onDismiss])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={handleBackdropClick}
    >
      <div className="card w-full max-w-md mx-4 p-6 animate-slide-up shadow-2xl">
        {state === 'confirm' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-14 h-14 rounded-full bg-red-900/30 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-8 h-8 text-red-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-lg font-semibold text-text-primary">Modpack löschen</h2>
              <p className="text-sm text-text-secondary mt-2 line-clamp-2">
                <span className="font-medium text-text-primary">{packTitle}</span>
              </p>
              <p className="text-sm text-text-secondary mt-2">
                Alle Welten, Einstellungen und Ressourcenpakete werden unwiderruflich gelöscht.
              </p>
            </div>
            <div className="flex gap-3 mt-2">
              <button className="btn-secondary px-6" onClick={() => onDismiss(false)}>
                Abbrechen
              </button>
              <button className="btn-danger px-6" onClick={handleDelete}>
                Löschen
              </button>
            </div>
          </div>
        )}

        {state === 'deleting' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-14 h-14 rounded-full bg-red-900/30 flex items-center justify-center">
              <span className="inline-block w-7 h-7 border-[3px] border-red-400 border-t-transparent rounded-full animate-spin" />
            </div>
            <div className="text-center">
              <h2 className="text-lg font-semibold text-text-primary">Wird gelöscht...</h2>
              <p className="text-sm text-text-secondary mt-1 line-clamp-2">{packTitle}</p>
            </div>
            <div className="w-full">
              <div className="relative w-full h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                <div className="absolute h-full w-2/5 bg-red-400 rounded-full animate-[progressBar_1.5s_ease-in-out_infinite]" />
              </div>
            </div>
          </div>
        )}

        {state === 'success' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-8 h-8 text-accent">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-lg font-semibold text-text-primary">Modpack gelöscht</h2>
              <p className="text-sm text-text-secondary mt-1 line-clamp-2">{packTitle}</p>
            </div>
            <button className="btn-primary mt-2 px-8" onClick={() => onDismiss(true)}>
              OK
            </button>
          </div>
        )}

        {state === 'error' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-14 h-14 rounded-full bg-red-900/30 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-8 h-8 text-red-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-lg font-semibold text-text-primary">Löschen fehlgeschlagen</h2>
              <p className="text-sm text-red-400 mt-1">{errorMsg}</p>
            </div>
            <button className="btn-primary mt-2 px-8" onClick={() => onDismiss(false)}>
              OK
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
