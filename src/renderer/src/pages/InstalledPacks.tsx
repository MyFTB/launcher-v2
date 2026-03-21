import { useEffect, useState, useCallback, useRef } from 'react'
import type { ModpackManifestReference, LaunchState } from '@shared/types'
import ModpackCard from '../components/ModpackCard'
import ContextMenu from '../components/ContextMenu'
import { useNavigate } from 'react-router-dom'

interface ContextMenuState {
  x: number
  y: number
  packName: string
}

export default function InstalledPacks(): JSX.Element {
  const navigate = useNavigate()
  const [packs, setPacks] = useState<ModpackManifestReference[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [launchState, setLaunchState] = useState<LaunchState | null>(null)
  const [runningPack, setRunningPack] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const uploadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const [remote, installedNames] = await Promise.all([
          window.electronAPI.packsGetRemote(),
          window.electronAPI.installGetInstalled(),
        ])
        if (cancelled) return

        const installedSet = new Set(installedNames)
        const installed = remote.filter((p) => installedSet.has(p.name))
        setPacks(installed)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Fehler beim Laden der installierten Modpacks')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Subscribe to launch state events
  useEffect(() => {
    const unsub = window.electronAPI.on('launch:state', (...args: unknown[]) => {
      const event = args[0] as { state: LaunchState; packName?: string }
      setLaunchState(event.state)
      if (event.state === 'running' || event.state === 'launching') {
        if (event.packName) setRunningPack(event.packName)
      } else if (event.state === 'closed' || event.state === 'crashed') {
        setRunningPack(null)
      }
    })
    return unsub
  }, [])

  const handlePlay = useCallback((packName: string) => {
    setRunningPack(packName)
    setLaunchState('launching')
    window.electronAPI.launchStart(packName).catch((err) => {
      console.error('Launch error', err)
      setRunningPack(null)
      setLaunchState(null)
    })
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, packName: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, packName })
  }, [])

  const handleDelete = useCallback(async (packName: string) => {
    const ok = await window.electronAPI.launchDeletePack(packName)
    if (ok) {
      setPacks((prev) => prev.filter((p) => p.name !== packName))
    }
  }, [])

  const handleUploadCrash = useCallback(async (packName: string) => {
    try {
      const url = await window.electronAPI.launchUploadCrash(packName)
      setUploadMessage(`Crashbericht hochgeladen: ${url}`)
      if (uploadTimeoutRef.current) clearTimeout(uploadTimeoutRef.current)
      uploadTimeoutRef.current = setTimeout(() => setUploadMessage(null), 8000)
    } catch (err) {
      setUploadMessage('Fehler beim Hochladen des Crashberichts.')
      uploadTimeoutRef.current = setTimeout(() => setUploadMessage(null), 4000)
    }
  }, [])

  function buildContextMenuItems(packName: string): Array<{ label: string; action: () => void; danger?: boolean }> {
    return [
      {
        label: 'Ordner öffnen',
        action: () => window.electronAPI.launchOpenFolder(packName),
      },
      {
        label: 'Desktop-Verknüpfung',
        action: () => window.electronAPI.launchCreateShortcut(packName),
      },
      {
        label: 'Crashbericht hochladen',
        action: () => handleUploadCrash(packName),
      },
      {
        label: 'Konsole anzeigen',
        action: () => window.dispatchEvent(new CustomEvent('open-console')),
      },
      {
        label: 'Löschen',
        danger: true,
        action: () => handleDelete(packName),
      },
    ]
  }

  const isGameRunning = launchState === 'running' || launchState === 'launching'

  return (
    <div className="p-6 animate-fade-in">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Installierte Modpacks</h1>
          <p className="text-text-secondary mt-1 text-sm">
            Deine installierten Modpacks.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isGameRunning && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent/10 border border-accent/30">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
              <span className="text-xs font-medium text-accent">
                {launchState === 'launching' ? 'Startet...' : 'Läuft...'}
              </span>
            </div>
          )}
          <button
            className="btn-ghost text-xs"
            onClick={() => window.dispatchEvent(new CustomEvent('open-console'))}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Konsole
          </button>
        </div>
      </div>

      {/* Upload message toast */}
      {uploadMessage && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-bg-elevated border border-border text-sm text-text-primary animate-fade-in">
          {uploadMessage}
        </div>
      )}

      {error && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-red-900/30 border border-red-700/50 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card animate-pulse">
              <div className="aspect-square bg-bg-elevated rounded-t-xl" />
              <div className="p-3 space-y-2">
                <div className="h-4 bg-bg-elevated rounded w-3/4" />
                <div className="h-3 bg-bg-elevated rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : packs.length === 0 ? (
        <div className="card px-6 py-16 text-center">
          <p className="text-text-secondary text-sm">Keine Modpacks installiert.</p>
          <button
            className="btn-primary mt-4"
            onClick={() => navigate('/available')}
          >
            Modpacks entdecken
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4">
          {packs.map((pack) => (
            <ModpackCard
              key={pack.name}
              manifest={pack}
              isInstalled={true}
              isRunning={runningPack === pack.name}
              onPlay={() => handlePlay(pack.name)}
              onContextMenu={(e) => handleContextMenu(e, pack.name)}
            />
          ))}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextMenuItems(contextMenu.packName)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
