import { useEffect, useState } from 'react'
import type { WindowMaximizedEvent } from '@shared/types'

function MinimizeIcon() {
  return <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3" stroke="currentColor"><path d="M2 8.5h8" /></svg>
}
function MaximizeIcon() {
  return <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor"><rect x="2.5" y="2.5" width="7" height="7" /></svg>
}
function RestoreIcon() {
  return <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor"><path d="M4 3h5v5M3 4v5h5" /></svg>
}
function CloseIcon() {
  return <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3" stroke="currentColor"><path d="m2.5 2.5 7 7m0-7-7 7" /></svg>
}

export default function TitleBar({ title = 'MyFTB Launcher' }: { title?: string } = {}) {
  const platform = window.electronAPI.platform
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (platform === 'darwin') return
    void window.electronAPI.windowIsMaximized().then(setMaximized).catch(() => {})
    return window.electronAPI.on('window:maximized-changed', (...args: unknown[]) => {
      const event = args[0] as WindowMaximizedEvent
      setMaximized(!!event?.maximized)
    })
  }, [platform])

  if (platform === 'darwin') {
    return (
      <header className="drag-region relative flex h-8 shrink-0 items-center justify-center border-b border-border bg-bg-base px-20 select-none">
        <span className="truncate text-xs font-medium text-text-muted">{title}</span>
      </header>
    )
  }

  const baseFocus = 'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent'
  return (
    <header className="drag-region flex h-8 shrink-0 items-center border-b border-border bg-bg-base select-none">
      <span className="min-w-0 flex-1 truncate px-3 text-xs font-medium text-text-muted">{title}</span>

      {platform === 'win32' ? (
        <div className="no-drag flex h-full items-stretch" role="group" aria-label="Fenstersteuerung">
          <button
            type="button"
            aria-label="Fenster minimieren"
            title="Minimieren"
            className={`flex h-8 w-12 items-center justify-center text-text-secondary hover:bg-bg-overlay hover:text-text-primary ${baseFocus}`}
            onClick={() => window.electronAPI.windowMinimize()}
          >
            <MinimizeIcon />
          </button>
          <button
            type="button"
            aria-label={maximized ? 'Fenster wiederherstellen' : 'Fenster maximieren'}
            title={maximized ? 'Wiederherstellen' : 'Maximieren'}
            className={`flex h-8 w-12 items-center justify-center text-text-secondary hover:bg-bg-overlay hover:text-text-primary ${baseFocus}`}
            onClick={() => window.electronAPI.windowMaximize()}
          >
            {maximized ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
          <button
            type="button"
            aria-label="Fenster schließen"
            title="Schließen"
            className={`flex h-8 w-12 items-center justify-center text-text-secondary hover:bg-[#c42b1c] hover:text-white ${baseFocus}`}
            onClick={() => window.electronAPI.windowClose()}
          >
            <CloseIcon />
          </button>
        </div>
      ) : (
        <div className="no-drag flex h-full items-center gap-0.5 pr-1" role="group" aria-label="Fenstersteuerung">
          <button
            type="button"
            aria-label="Fenster minimieren"
            title="Minimieren"
            className={`flex h-8 w-8 items-center justify-center rounded-sm hover:bg-bg-overlay ${baseFocus}`}
            onClick={() => window.electronAPI.windowMinimize()}
          >
            <span className="h-3 w-3 rounded-full bg-amber-400" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={maximized ? 'Fenster wiederherstellen' : 'Fenster maximieren'}
            title={maximized ? 'Wiederherstellen' : 'Maximieren'}
            className={`flex h-8 w-8 items-center justify-center rounded-sm hover:bg-bg-overlay ${baseFocus}`}
            onClick={() => window.electronAPI.windowMaximize()}
          >
            <span className="h-3 w-3 rounded-full bg-emerald-400" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Fenster schließen"
            title="Schließen"
            className={`flex h-8 w-8 items-center justify-center rounded-sm hover:bg-bg-overlay ${baseFocus}`}
            onClick={() => window.electronAPI.windowClose()}
          >
            <span className="h-3 w-3 rounded-full bg-red-400" aria-hidden="true" />
          </button>
        </div>
      )}
    </header>
  )
}
