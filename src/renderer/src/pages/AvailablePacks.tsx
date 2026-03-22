import { useEffect, useState, useCallback } from 'react'
import type {
  ModpackManifestReference,
  InstallProgressEvent,
  Feature,
} from '@shared/types'
import ModpackCard from '../components/ModpackCard'
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

export default function AvailablePacks() {
  const [remotePacks, setRemotePacks] = useState<ModpackManifestReference[]>([])
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set())
  const [newPackNames, setNewPackNames] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Installation state
  const [installingPack, setInstallingPack] = useState<ModpackManifestReference | null>(null)
  const [installProgress, setInstallProgress] = useState<InstallProgressEvent | null>(null)
  const [installResult, setInstallResult] = useState<{ success: boolean; error?: string } | null>(null)

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
  useEffect(() => {
    const unsubProgress = window.electronAPI.on('install:progress', (...args: unknown[]) => {
      setInstallProgress(args[0] as InstallProgressEvent)
    })
    const unsubComplete = window.electronAPI.on('install:complete', (...args: unknown[]) => {
      const event = args[0] as { success: boolean; error?: string }
      if (event.success && installingPack) {
        window.electronAPI.installGetInstalled()
          .then((infos) => setInstalledNames(new Set(infos.map((p) => p.name))))
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

  const filteredPacks = remotePacks
    .filter(
      (p) => !installedNames.has(p.name) &&
        p.title.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      const aNew = newPackNames.has(a.name)
      const bNew = newPackNames.has(b.name)
      if (aNew === bNew) return 0
      return aNew ? -1 : 1
    })

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
          <div className="w-12 h-12 rounded-xl bg-bg-elevated flex items-center justify-center mx-auto mb-4">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6 text-text-muted">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-text-secondary">
            {search ? `Keine Ergebnisse für "${search}"` : 'Keine Modpacks verfügbar'}
          </p>
          <p className="text-xs text-text-muted mt-1">
            {search ? 'Überprüfe die Schreibweise oder passe den Suchbegriff an.' : 'Prüfe deine Verbindung oder versuche es später erneut.'}
          </p>
          {search && (
            <button className="btn-ghost mt-4" onClick={() => setSearch('')}>
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
              isNew={newPackNames.has(pack.name)}
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
