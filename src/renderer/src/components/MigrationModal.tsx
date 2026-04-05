import { useState, useEffect, useRef } from 'react'
import { ipc } from '../ipc/client'

type MoveState = 'picking' | 'moving' | 'success' | 'error'

interface MigrationModalProps {
  onDismiss: (moved: boolean) => void
}

export default function MigrationModal({ onDismiss }: MigrationModalProps) {
  const [state, setState] = useState<MoveState>('picking')
  const [errorMsg, setErrorMsg] = useState('')
  const onDismissRef = useRef(onDismiss)
  useEffect(() => { onDismissRef.current = onDismiss }, [onDismiss])

  const calledRef = useRef(false)
  useEffect(() => {
    if (calledRef.current) return
    calledRef.current = true

    ipc.config.pickDir().then(async (dir) => {
      if (!dir) {
        onDismissRef.current(false)
        return
      }
      setState('moving')
      const result = await ipc.config.moveInstances(dir)
      if (result.success) {
        setState('success')
      } else {
        setErrorMsg(result.error ?? 'Unbekannter Fehler')
        setState('error')
      }
    }).catch((err: unknown) => {
      setErrorMsg(err instanceof Error ? err.message : 'Fehler beim Verschieben')
      setState('error')
    })
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="card w-full max-w-md mx-4 p-6 animate-slide-up shadow-2xl">
        {state === 'picking' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-8 h-8 text-accent">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-lg font-semibold text-text-primary">Ordner waehlen</h2>
              <p className="text-sm text-text-secondary mt-1">
                Waehle den neuen Speicherort fuer deine Modpacks...
              </p>
            </div>
          </div>
        )}

        {state === 'moving' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center">
              <span className="inline-block w-7 h-7 border-[3px] border-accent border-t-transparent rounded-full animate-spin" />
            </div>
            <div className="text-center">
              <h2 className="text-lg font-semibold text-text-primary">Modpacks werden verschoben</h2>
              <p className="text-sm text-text-secondary mt-1">
                Bitte warte, bis der Vorgang abgeschlossen ist...
              </p>
            </div>
            <div className="w-full">
              <div className="relative w-full h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                <div className="absolute h-full w-2/5 bg-accent rounded-full animate-[progressBar_1.5s_ease-in-out_infinite]" />
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
              <h2 className="text-lg font-semibold text-text-primary">Speicherort geaendert</h2>
              <p className="text-sm text-text-secondary mt-1">
                Deine Modpacks wurden erfolgreich verschoben.
              </p>
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
              <h2 className="text-lg font-semibold text-text-primary">Verschieben fehlgeschlagen</h2>
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
