import { useEffect, useRef, useState } from 'react'
import logoUrl from '../assets/logo.svg'

interface LoginModalProps {
  onClose: () => void
}

type LoginState = 'idle' | 'waiting' | 'error'

export default function LoginModal({ onClose }: LoginModalProps) {
  const [loginState, setLoginState] = useState<LoginState>('idle')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    const unsubProfiles = window.electronAPI.on('auth:profiles-updated', () => {
      onCloseRef.current()
    })
    const unsubError = window.electronAPI.on('auth:login-error', (...args: unknown[]) => {
      const event = args[0] as { error: string }
      setErrorMessage(event?.error ?? 'Unbekannter Fehler')
      setLoginState('error')
    })
    return () => {
      unsubProfiles()
      unsubError()
    }
  }, [])

  async function handleMicrosoftLogin(): Promise<void> {
    setLoginState('waiting')
    setErrorMessage('')
    try {
      await window.electronAPI.authStartMicrosoft()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Fehler beim Starten der Anmeldung')
      setLoginState('error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="card w-full max-w-sm mx-4 p-8 animate-slide-up shadow-2xl text-center">
        {/* App logo */}
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 rounded-2xl bg-accent/10 border border-accent/30 flex items-center justify-center">
            <img src={logoUrl} alt="MyFTB" className="w-10 h-10" draggable={false} />
          </div>
        </div>

        <h2 className="text-xl font-bold text-text-primary mb-1">MyFTB Launcher</h2>
        <p className="text-sm text-text-secondary mb-8">
          Melde dich mit deinem Microsoft-Konto an, um loszulegen.
        </p>

        {loginState === 'error' && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/30 border border-red-700/50 text-sm text-red-400 text-left">
            {errorMessage}
          </div>
        )}

        {loginState === 'waiting' ? (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <span className="inline-block w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              Warte auf Browser...
            </div>
            <p className="text-xs text-text-muted">
              Schließe den Browser-Tab nicht, bevor du dich angemeldet hast.
            </p>
          </div>
        ) : (
          <button
            className="btn-primary w-full justify-center text-base py-3"
            onClick={handleMicrosoftLogin}
          >
            <MicrosoftIcon />
            Mit Microsoft anmelden
          </button>
        )}
      </div>
    </div>
  )
}

function MicrosoftIcon() {
  return (
    <svg viewBox="0 0 21 21" className="w-4 h-4 shrink-0" fill="none">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#00a4ef" />
      <rect x="1" y="11" width="9" height="9" fill="#7fba00" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  )
}
