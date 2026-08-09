import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type {
  ModpackManifestReference,
  InstallProgressEvent,
  InstallResult,
  Feature,
} from '@shared/types'
import ModpackCard from '../components/ModpackCard'
import MinecraftVersionSelect from '../components/MinecraftVersionSelect'
import ProgressModal from '../components/ProgressModal'
import FeatureModal from '../components/FeatureModal'
import {
  getKnownPacks,
  saveKnownPacks,
  getStoredNewPacks,
  saveStoredNewPacks,
  clearStoredNewPacks,
  dispatchNewPackCount,
} from '../utils/packBadge'
import {
  excludeInstalledPacks,
  filterPacksByMinecraftVersion,
  getMinecraftVersionOptions,
  isMinecraftVersionSelectionValid,
} from '../utils/modpackFilters'

export default function AvailablePacks() {
  const [remotePacks, setRemotePacks] = useState<ModpackManifestReference[]>([])
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set())
  const [newPackNames, setNewPackNames] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Installation state
  const [installingPack, setInstallingPack] = useState<ModpackManifestReference | null>(null)
  const [installProgress, setInstallProgress] = useState<InstallProgressEvent | null>(null)
  const [installResult, setInstallResult] = useState<InstallResult | null>(null)
  const [resultPack, setResultPack] = useState<ModpackManifestReference | null>(null)

  // Feature selection state
  const [pendingFeaturesPack, setPendingFeaturesPack] = useState<ModpackManifestReference | null>(null)
  const [pendingFeatures, setPendingFeatures] = useState<Feature[]>([])

  const loadPacks = useCallback(async (bustCache = false) => {
    try {
      if (bustCache) await window.electronAPI.packsReload()
      const [remote, installed] = await Promise.all([
        window.electronAPI.packsGetRemote(),
        window.electronAPI.installGetInstalled(),
      ])

      const remoteNames = remote.map((p) => p.name)
      const remoteSet = new Set(remoteNames)
      const known = getKnownPacks()

      // New packs = in current list but not in last-seen list.
      // Skip on very first run (empty known = seed silently).
      const newOnes = known.size === 0
        ? new Set<string>()
        : new Set(remoteNames.filter((n) => !known.has(n)))

      // Always replace knownPacks with the current list so removed packs don't
      // stay "known" and can be flagged as new again if they reappear.
      saveKnownPacks(remoteNames)

      // Persist for sidebar startup badge; merge + drop departed packs.
      const stored = getStoredNewPacks()
      for (const n of newOnes) stored.add(n)
      const pruned = new Set([...stored].filter((n) => remoteSet.has(n)))
      saveStoredNewPacks(Array.from(pruned))
      dispatchNewPackCount(pruned.size)

      setRemotePacks(remote)
      setInstalledNames(new Set(installed.map((p) => p.name)))
      setNewPackNames(pruned)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Laden der Modpacks')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadPacks().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [loadPacks])

  // On unmount: user has seen the new packs — clear the persistent badge.
  useEffect(() => {
    return () => {
      clearStoredNewPacks()
      dispatchNewPackCount(0)
    }
  }, [])

  const handleReload = useCallback(async () => {
    setReloading(true)
    setError(null)
    await loadPacks(true)
    setReloading(false)
  }, [loadPacks])

  // Subscribe to install events
  const installingPackRef = useRef(installingPack)
  useEffect(() => {
    installingPackRef.current = installingPack
  }, [installingPack])

  useEffect(() => {
    const unsubProgress = window.electronAPI.on('install:progress', (...args: unknown[]) => {
      setInstallProgress(args[0] as InstallProgressEvent)
    })
    const unsubComplete = window.electronAPI.on('install:complete', (...args: unknown[]) => {
      const event = args[0] as InstallResult
      if (!installingPackRef.current || event.packName !== installingPackRef.current.name) return
      setResultPack(installingPackRef.current)
      if (event.success && installingPackRef.current) {
        window.electronAPI.installGetInstalled()
          .then((infos) => setInstalledNames(new Set(infos.map((p) => p.name))))
          .catch(() => {})
      }
      setInstallProgress(null)
      setInstallResult(event)
    })
    const unsubFeatures = window.electronAPI.on('install:needs-features', (...args: unknown[]) => {
      const event = args[0] as { features: Feature[] }
      if (installingPackRef.current) {
        setPendingFeaturesPack(installingPackRef.current)
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
  }, [])

  const presentInstallResult = useCallback((pack: ModpackManifestReference, result: InstallResult): void => {
    if (result.error === 'FEATURE_SELECTION_REQUIRED') return
    setResultPack(pack)
    setInstallProgress(null)
    setInstallResult(result)
    if (result.success) {
      void window.electronAPI.installGetInstalled()
        .then((infos) => setInstalledNames(new Set(infos.map((item) => item.name))))
        .catch(() => {})
    }
  }, [])

  const handleInstall = useCallback(async (pack: ModpackManifestReference) => {
    setInstallingPack(pack)
    setInstallProgress(null)
    setInstallResult(null)
    try {
      presentInstallResult(pack, await window.electronAPI.installModpack(pack))
    } catch (err) {
      console.error('Install error', err)
      presentInstallResult(pack, {
        success: false,
        packName: pack.name,
        failures: [],
        error: err instanceof Error ? err.message : 'Installation fehlgeschlagen.',
      })
    }
  }, [presentInstallResult])

  const handleCancel = useCallback(() => {
    window.electronAPI.installCancel().catch(console.error)
    setInstallingPack(null)
    setInstallProgress(null)
    setInstallResult(null)
    setResultPack(null)
  }, [])

  const handleDismiss = useCallback(() => {
    setInstallingPack(null)
    setInstallResult(null)
    setResultPack(null)
  }, [])

  const handleRetry = useCallback(async () => {
    if (!resultPack) return
    setInstallingPack(resultPack)
    setInstallResult(null)
    try {
      presentInstallResult(resultPack, await window.electronAPI.installRetryFailed(resultPack.name))
    } catch (error) {
      presentInstallResult(resultPack, {
        success: false,
        packName: resultPack.name,
        failures: [],
        error: error instanceof Error ? error.message : 'Erneuter Versuch fehlgeschlagen.',
      })
    }
  }, [presentInstallResult, resultPack])

  const handleRepair = useCallback(async () => {
    if (!resultPack) return
    setInstallingPack(resultPack)
    setInstallResult(null)
    try {
      presentInstallResult(resultPack, await window.electronAPI.installRepairPack(resultPack.name))
    } catch (error) {
      presentInstallResult(resultPack, {
        success: false,
        packName: resultPack.name,
        failures: [],
        error: error instanceof Error ? error.message : 'Reparatur fehlgeschlagen.',
      })
    }
  }, [presentInstallResult, resultPack])

  const handleFeatureConfirm = useCallback(async (selectedFeatures: string[]) => {
    if (!pendingFeaturesPack) return
    const pack = pendingFeaturesPack
    setPendingFeaturesPack(null)
    setPendingFeatures([])
    setInstallingPack(pack)
    try {
      presentInstallResult(pack, await window.electronAPI.installModpack(pack, selectedFeatures))
    } catch (err) {
      console.error('Install with features error', err)
      presentInstallResult(pack, {
        success: false,
        packName: pack.name,
        failures: [],
        error: err instanceof Error ? err.message : 'Installation fehlgeschlagen.',
      })
    }
  }, [pendingFeaturesPack, presentInstallResult])

  const handleFeatureCancel = useCallback(() => {
    setPendingFeaturesPack(null)
    setPendingFeatures([])
  }, [])

  const availablePacks = useMemo(
    () => excludeInstalledPacks(remotePacks, installedNames),
    [remotePacks, installedNames],
  )
  const versionOptions = useMemo(
    () => getMinecraftVersionOptions(availablePacks),
    [availablePacks],
  )

  useEffect(() => {
    if (!isMinecraftVersionSelectionValid(selectedVersion, versionOptions)) {
      setSelectedVersion(null)
    }
  }, [selectedVersion, versionOptions])

  const filteredPacks = useMemo(() => {
    const normalizedSearch = search.toLowerCase()
    return filterPacksByMinecraftVersion(availablePacks, selectedVersion)
      .filter((pack) => pack.title.toLowerCase().includes(normalizedSearch))
      .sort((a, b) => {
        const aNew = newPackNames.has(a.name)
        const bNew = newPackNames.has(b.name)
        if (aNew === bNew) return 0
        return aNew ? -1 : 1
      })
  }, [availablePacks, search, selectedVersion, newPackNames])

  const resetFilters = useCallback(() => {
    setSearch('')
    setSelectedVersion(null)
  }, [])

  return (
    <div className="p-6 animate-fade-in">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">Verfügbare Modpacks</h1>
          <p className="text-text-secondary mt-1 text-sm">
            Entdecke und installiere neue Modpacks.
          </p>
        </div>
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
      </div>

      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end">
        <div className="w-full lg:max-w-md">
          <label htmlFor="available-pack-search" className="mb-1.5 block text-xs font-medium text-text-secondary">
            Modpack suchen
          </label>
          <div className="relative">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              id="available-pack-search"
              type="search"
              placeholder="Modpack suchen..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              disabled={loading || reloading || availablePacks.length === 0}
              className="input pl-9 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
        </div>
        <MinecraftVersionSelect
          id="available-minecraft-version"
          value={selectedVersion}
          options={versionOptions}
          totalCount={availablePacks.length}
          onChange={setSelectedVersion}
          disabled={availablePacks.length === 0}
          loading={loading || reloading}
        />
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
      ) : remotePacks.length === 0 ? (
        <div className="card px-6 py-16 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-bg-elevated">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true" className="h-6 w-6 text-text-muted">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          </div>
          <p className="text-sm font-medium text-text-secondary">Keine Modpacks verfügbar.</p>
          <p className="mt-1 text-xs text-text-muted">Prüfe deine Verbindung oder versuche es später erneut.</p>
        </div>
      ) : availablePacks.length === 0 ? (
        <div className="card px-6 py-16 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-bg-elevated">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true" className="h-6 w-6 text-text-muted">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          </div>
          <p className="text-sm font-medium text-text-secondary">Alle verfügbaren Modpacks sind bereits installiert.</p>
          <p className="mt-1 text-xs text-text-muted">Neue Modpacks erscheinen hier, sobald sie verfügbar sind.</p>
        </div>
      ) : filteredPacks.length === 0 ? (
        <div className="card px-6 py-16 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-bg-elevated">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true" className="h-6 w-6 text-text-muted">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-text-secondary">Keine passenden Modpacks gefunden.</p>
          <p className="mt-1 text-xs text-text-muted">Passe die Suche oder die Minecraft-Version an.</p>
          <button className="btn-ghost mt-4" onClick={resetFilters}>
            Filter zurücksetzen
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4">
          {filteredPacks.map((pack, i) => (
            <div key={pack.name} className="animate-slide-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms`, animationFillMode: 'backwards' }}>
            <ModpackCard
              manifest={pack}
              isInstalled={false}
              isRunning={false}
              isNew={newPackNames.has(pack.name)}
              onInstall={() => handleInstall(pack)}
            />
            </div>
          ))}
        </div>
      )}

      {/* Progress modal */}
      {(installingPack || installResult) && (
        <ProgressModal
          progress={installProgress}
          packTitle={installingPack?.title ?? resultPack?.title ?? ''}
          result={installResult}
          onCancel={handleCancel}
          onDismiss={handleDismiss}
          onRetry={handleRetry}
          onRepair={handleRepair}
          onOpenLogs={() => window.electronAPI.configOpenLogs()}
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
