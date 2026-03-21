import { useEffect, useState, useCallback } from 'react'
import type {
  ModpackManifestReference,
  InstallProgressEvent,
  Feature,
} from '@shared/types'
import ModpackCard from '../components/ModpackCard'
import ProgressModal from '../components/ProgressModal'
import FeatureModal from '../components/FeatureModal'

export default function AvailablePacks(): JSX.Element {
  const [remotePacks, setRemotePacks] = useState<ModpackManifestReference[]>([])
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Installation state
  const [installingPack, setInstallingPack] = useState<ModpackManifestReference | null>(null)
  const [installProgress, setInstallProgress] = useState<InstallProgressEvent | null>(null)
  const [installResult, setInstallResult] = useState<{ success: boolean; error?: string } | null>(null)

  // Feature selection state
  const [pendingFeaturesPack, setPendingFeaturesPack] = useState<ModpackManifestReference | null>(null)
  const [pendingFeatures, setPendingFeatures] = useState<Feature[]>([])

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const [remote, installedNames] = await Promise.all([
          window.electronAPI.packsGetRemote(),
          window.electronAPI.installGetInstalled(),
        ])
        if (cancelled) return

        setRemotePacks(remote)
        setInstalledNames(new Set(installedNames))
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Fehler beim Laden der Modpacks')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Subscribe to install events
  useEffect(() => {
    const unsubProgress = window.electronAPI.on('install:progress', (...args: unknown[]) => {
      setInstallProgress(args[0] as InstallProgressEvent)
    })
    const unsubComplete = window.electronAPI.on('install:complete', (...args: unknown[]) => {
      const event = args[0] as { success: boolean; error?: string }
      if (event.success && installingPack) {
        // Refresh from disk so the installed set is authoritative
        window.electronAPI.installGetInstalled()
          .then((names) => setInstalledNames(new Set(names)))
          .catch(() => {})
      }
      setInstallProgress(null)
      setInstallResult(event)
    })
    const unsubFeatures = window.electronAPI.on('install:needs-features', (...args: unknown[]) => {
      const event = args[0] as { features: Feature[] }
      if (installingPack) {
        setPendingFeaturesPack(installingPack)
        setPendingFeatures(event.features)
        setInstallingPack(null)
        setInstallProgress(null)
      }
    })
    return () => {
      unsubProgress()
      unsubComplete()
      unsubFeatures()
    }
  }, [installingPack])

  const handleInstall = useCallback((pack: ModpackManifestReference) => {
    setInstallingPack(pack)
    setInstallProgress(null)
    window.electronAPI.installModpack(pack).catch((err) => {
      console.error('Install error', err)
      setInstallingPack(null)
      setInstallProgress(null)
    })
  }, [])

  const handleCancel = useCallback(() => {
    window.electronAPI.installCancel().catch(console.error)
    setInstallingPack(null)
    setInstallProgress(null)
    setInstallResult(null)
  }, [])

  const handleDismiss = useCallback(() => {
    setInstallingPack(null)
    setInstallResult(null)
  }, [])

  const handleFeatureConfirm = useCallback((selectedFeatures: string[]) => {
    if (!pendingFeaturesPack) return
    const pack = pendingFeaturesPack
    setPendingFeaturesPack(null)
    setPendingFeatures([])
    setInstallingPack(pack)
    window.electronAPI.installModpack(pack, selectedFeatures).catch((err) => {
      console.error('Install with features error', err)
      setInstallingPack(null)
      setInstallProgress(null)
    })
  }, [pendingFeaturesPack])

  const handleFeatureCancel = useCallback(() => {
    setPendingFeaturesPack(null)
    setPendingFeatures([])
  }, [])

  const filteredPacks = remotePacks.filter(
    (p) => !installedNames.has(p.name) &&
      p.title.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-6 animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Verfügbare Modpacks</h1>
        <p className="text-text-secondary mt-1 text-sm">
          Entdecke und installiere neue Modpacks.
        </p>
      </div>

      {/* Search bar */}
      <div className="mb-6">
        <div className="relative max-w-sm">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Modpack suchen..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9"
          />
        </div>
      </div>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-red-900/30 border border-red-700/50 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="card animate-pulse">
              <div className="aspect-square bg-bg-elevated rounded-t-xl" />
              <div className="p-3 space-y-2">
                <div className="h-4 bg-bg-elevated rounded w-3/4" />
                <div className="h-3 bg-bg-elevated rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredPacks.length === 0 ? (
        <div className="card px-6 py-16 text-center">
          <p className="text-text-secondary text-sm">
            {search ? `Kein Modpack gefunden für "${search}".` : 'Keine verfügbaren Modpacks.'}
          </p>
          {search && (
            <button className="btn-ghost mt-3" onClick={() => setSearch('')}>
              Suche löschen
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4">
          {filteredPacks.map((pack) => (
            <ModpackCard
              key={pack.name}
              manifest={pack}
              isInstalled={false}
              isRunning={false}
              onInstall={() => handleInstall(pack)}
            />
          ))}
        </div>
      )}

      {/* Progress modal */}
      {(installingPack || installResult) && (
        <ProgressModal
          progress={installProgress}
          packTitle={installingPack?.title ?? ''}
          result={installResult}
          onCancel={handleCancel}
          onDismiss={handleDismiss}
        />
      )}

      {/* Feature selection modal */}
      {pendingFeaturesPack && pendingFeatures.length > 0 && (
        <FeatureModal
          features={pendingFeatures}
          onConfirm={handleFeatureConfirm}
          onCancel={handleFeatureCancel}
        />
      )}
    </div>
  )
}
