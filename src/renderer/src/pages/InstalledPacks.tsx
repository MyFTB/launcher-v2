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

export default function InstalledPacks() {
  const navigate = useNavigate()
  const [packs, setPacks] = useState<ModpackManifestReference[]>([])
  const [updateMap, setUpdateMap] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [launchState, setLaunchState] = useState<LaunchState | null>(null)
  const [runningPack, setRunningPack] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const uploadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadPacks = useCallback(async (bustCache = false) => {
    try {
      if (bustCache) await window.electronAPI.packsReload()
      const [remote, installed] = await Promise.all([
        window.electronAPI.packsGetRemote(),
        window.electronAPI.installGetInstalled(),
      ])

      const installedSet = new Set(installed.map((p) => p.name))
      const installedVersions = Object.fromEntries(installed.map((p) => [p.name, p.version]))
      const filtered = remote.filter((p) => installedSet.has(p.name))
      const updates: Record<string, boolean> = {}
      for (const p of filtered) {
        updates[p.name] = installedVersions[p.name] !== p.version
      }

      setPacks(filtered)
      setUpdateMap(updates)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Laden der installierten Modpacks')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadPacks().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [loadPacks])

  const handleReload = useCallback(async () => {
    setReloading(true)
    setError(null)
    await loadPacks(true)
    setReloading(false)
  }, [loadPacks])

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
    } catch {
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
  const updateCount = Object.values(updateMap).filter(Boolean).length

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
          {updateCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <span className="text-xs font-medium text-amber-400">
                {updateCount} Update{updateCount !== 1 ? 's' : ''} verfügbar
              </span>
            </div>
          )}
          {isGameRunning && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent/10 border border-accent/30">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
              <span className="text-xs font-medium text-accent">
                {launchState === 'launching' ? 'Startet...' : 'Läuft...'}
              </span>
            </div>
          )}
          <button
            className="btn-ghost text-xs flex items-center gap-1.5"
            onClick={handleReload}
            disabled={reloading || loading}
            title="Liste aktualisieren"
          >
            <svg
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              className={`w-4 h-4 ${reloading ? 'animate-spin' : ''}`}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {reloading ? 'Laden...' : 'Aktualisieren'}
          </button>
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
          <div className="w-12 h-12 rounded-xl bg-bg-elevated flex items-center justify-center mx-auto mb-3">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6 text-text-muted">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          </div>
          <p className="text-sm font-medium text-text-secondary">Noch keine Modpacks installiert.</p>
          <p className="text-xs text-text-muted mt-1">Entdecke verfügbare Modpacks und installiere dein erstes.</p>
          <button
            className="btn-primary mt-4"
            onClick={() => navigate('/available')}
          >
            Modpacks entdecken
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4">
          {packs.map((pack, i) => (
            <div key={pack.name} className="animate-slide-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms`, animationFillMode: 'backwards' }}>
            <ModpackCard
              manifest={pack}
              isInstalled={true}
              isRunning={runningPack === pack.name}
              hasUpdate={updateMap[pack.name]}
              onPlay={() => handlePlay(pack.name)}
              onContextMenu={(e) => handleContextMenu(e, pack.name)}
            />
            </div>
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
