import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import type { ModpackManifestReference, InstallProgressEvent, InstallResult, Feature, ChangeFeaturesResult, PackFeaturesResult } from '@shared/types'
import ModpackCard from '../components/ModpackCard'
import MinecraftVersionSelect from '../components/MinecraftVersionSelect'
import ContextMenu from '../components/ContextMenu'
import PackSettingsModal from '../components/PackSettingsModal'
import ProgressModal from '../components/ProgressModal'
import FeatureModal from '../components/FeatureModal'
import DeleteConfirmModal from '../components/DeleteConfirmModal'
import { useNavigate } from 'react-router-dom'
import { useLaunchStore } from '../store/launch.store'
import { useModpackStore } from '../store/modpack.store'
import {
  filterPacksByMinecraftVersion,
  getMinecraftVersionOptions,
  isMinecraftVersionSelectionValid,
} from '../utils/modpackFilters'

interface ContextMenuState {
  x: number
  y: number
  packName: string
}

export default function InstalledPacks() {
  const navigate = useNavigate()
  const [packs, setPacks] = useState<ModpackManifestReference[]>([])
  const [updateMap, setUpdateMap] = useState<Record<string, boolean>>({})
  const [featuresMap, setFeaturesMap] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [packSettingsTarget, setPackSettingsTarget] = useState<string | null>(null)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const uploadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; title: string } | null>(null)

  // Feature-change (post-install reconfiguration) state
  const [changingFeaturesPack, setChangingFeaturesPack] = useState<string | null>(null)
  const [changingFeaturesData, setChangingFeaturesData] = useState<PackFeaturesResult | null>(null)
  const [changeFeaturesProgress, setChangeFeaturesProgress] = useState<InstallProgressEvent | null>(null)
  const [changeFeaturesResult, setChangeFeaturesResult] = useState<ChangeFeaturesResult | null>(null)
  const changingFeaturesPackRef = useRef(changingFeaturesPack)
  const changingFeaturesTitleRef = useRef<string>('')
  useEffect(() => {
    changingFeaturesPackRef.current = changingFeaturesPack
    if (changingFeaturesPack) {
      const pack = packs.find((p) => p.name === changingFeaturesPack)
      changingFeaturesTitleRef.current = pack?.title ?? changingFeaturesPack
    }
  }, [changingFeaturesPack, packs])

  // Every pack has independent launch state and logs.
  const launchSessions = useLaunchStore((s) => s.sessions)
  const storeLaunch = useLaunchStore((s) => s.launch)
  const activeSessions = useMemo(
    () => Object.values(launchSessions).filter((session) => session.state === 'running' || session.state === 'launching'),
    [launchSessions],
  )
  const activePackNames = useMemo(
    () => new Set(activeSessions.map((session) => session.packName)),
    [activeSessions],
  )

  // Update (install) progress state
  const [updatingPack, setUpdatingPack] = useState<ModpackManifestReference | null>(null)
  const [updateProgress, setUpdateProgress] = useState<InstallProgressEvent | null>(null)
  const [updateResult, setUpdateResult] = useState<InstallResult | null>(null)
  const [resultPack, setResultPack] = useState<ModpackManifestReference | null>(null)
  const [pendingFeaturesPack, setPendingFeaturesPack] = useState<ModpackManifestReference | null>(null)
  const [pendingFeatures, setPendingFeatures] = useState<Feature[]>([])
  const updatingPackRef = useRef(updatingPack)
  const updatingTitleRef = useRef<string>('')
  useEffect(() => {
    updatingPackRef.current = updatingPack
    if (updatingPack) updatingTitleRef.current = updatingPack.title
  }, [updatingPack])

  const loadPacks = useCallback(async (bustCache = false) => {
    try {
      if (bustCache) await window.electronAPI.packsReload()
      const [remote, installed] = await Promise.all([
        window.electronAPI.packsGetRemote(),
        window.electronAPI.installGetInstalled(),
      ])

      const remoteByName = new Map(remote.map((pack) => [pack.name, pack]))
      const filtered: ModpackManifestReference[] = installed.map((local) => ({
        name: local.name,
        title: local.title,
        version: local.version,
        location: local.location,
        gameVersion: local.gameVersion,
        ...(local.logo ? { logo: local.logo } : {}),
        ...(remoteByName.get(local.name) ?? {}),
      }))
      const updates: Record<string, boolean> = {}
      for (const local of installed) {
        const remotePack = remoteByName.get(local.name)
        updates[local.name] = !!remotePack && local.version !== remotePack.version
      }
      const features: Record<string, boolean> = {}
      for (const p of installed) {
        features[p.name] = p.hasFeatures
      }

      setPacks(filtered)
      setUpdateMap(updates)
      setFeaturesMap(features)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Laden der installierten Modpacks')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadPacks().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [loadPacks])

  useEffect(() => {
    const unsubProgress = window.electronAPI.on('install:progress', (...args: unknown[]) => {
      if (updatingPackRef.current) setUpdateProgress(args[0] as InstallProgressEvent)
    })
    const unsubComplete = window.electronAPI.on('install:complete', (...args: unknown[]) => {
      if (!updatingPackRef.current) return
      const event = args[0] as InstallResult
      if (event.packName !== updatingPackRef.current.name) return
      setResultPack(updatingPackRef.current)
      if (event.success) {
        loadPacks().catch(() => {})
      }
      setUpdateProgress(null)
      setUpdateResult(event)
      setUpdatingPack(null)
    })
    const unsubFeatures = window.electronAPI.on('install:needs-features', (...args: unknown[]) => {
      const event = args[0] as { features: Feature[] }
      if (updatingPackRef.current) {
        setPendingFeaturesPack(updatingPackRef.current)
        setPendingFeatures(event.features)
        setUpdatingPack(null)
        setUpdateProgress(null)
      }
    })
    const unsubChangeFeaturesProgress = window.electronAPI.on('install:features-change-progress', (...args: unknown[]) => {
      if (changingFeaturesPackRef.current) setChangeFeaturesProgress(args[0] as InstallProgressEvent)
    })
    const unsubChangeFeaturesComplete = window.electronAPI.on('install:features-change-complete', (...args: unknown[]) => {
      if (!changingFeaturesPackRef.current) return
      const event = args[0] as ChangeFeaturesResult
      if (event.success) {
        loadPacks().catch(() => {})
      }
      setChangeFeaturesProgress(null)
      setChangeFeaturesResult(event)
    })
    return () => {
      unsubProgress()
      unsubComplete()
      unsubFeatures()
      unsubChangeFeaturesProgress()
      unsubChangeFeaturesComplete()
    }
  }, [loadPacks])

  const handleReload = useCallback(async () => {
    setReloading(true)
    setError(null)
    await loadPacks(true)
    setReloading(false)
  }, [loadPacks])

  const handlePlay = useCallback((packName: string) => {
    storeLaunch(packName).catch((err) => {
      console.error('Launch error', err)
    })
  }, [storeLaunch])

  const presentInstallResult = useCallback((pack: ModpackManifestReference, result: InstallResult): void => {
    if (result.error === 'FEATURE_SELECTION_REQUIRED') return
    setResultPack(pack)
    setUpdateProgress(null)
    setUpdateResult(result)
    setUpdatingPack(null)
    if (result.success) void loadPacks()
  }, [loadPacks])

  const handleUpdate = useCallback(async (pack: ModpackManifestReference) => {
    setUpdatingPack(pack)
    setUpdateProgress(null)
    setUpdateResult(null)
    try {
      presentInstallResult(pack, await window.electronAPI.installModpack(pack, undefined))
    } catch (err) {
      console.error('Update error', err)
      presentInstallResult(pack, {
        success: false,
        packName: pack.name,
        failures: [],
        error: err instanceof Error ? err.message : 'Installation fehlgeschlagen.',
      })
    }
  }, [presentInstallResult])

  const handleUpdateCancel = useCallback(() => {
    window.electronAPI.installCancel().catch(console.error)
    setUpdatingPack(null)
    setUpdateProgress(null)
    setUpdateResult(null)
  }, [])

  const handleUpdateDismiss = useCallback(() => {
    setUpdateResult(null)
    setResultPack(null)
  }, [])

  const handleRetryFailed = useCallback(async () => {
    if (!resultPack) return
    const pack = resultPack
    setUpdatingPack(pack)
    setUpdateResult(null)
    setUpdateProgress(null)
    try {
      presentInstallResult(pack, await window.electronAPI.installRetryFailed(pack.name))
    } catch (caught) {
      presentInstallResult(pack, {
        success: false,
        packName: pack.name,
        failures: [],
        error: caught instanceof Error ? caught.message : 'Erneuter Versuch fehlgeschlagen.',
      })
    }
  }, [presentInstallResult, resultPack])

  const handleRepairFailed = useCallback(async () => {
    if (!resultPack) return
    const pack = resultPack
    setUpdatingPack(pack)
    setUpdateResult(null)
    setUpdateProgress(null)
    try {
      presentInstallResult(pack, await window.electronAPI.installRepairPack(pack.name))
    } catch (caught) {
      presentInstallResult(pack, {
        success: false,
        packName: pack.name,
        failures: [],
        error: caught instanceof Error ? caught.message : 'Reparatur fehlgeschlagen.',
      })
    }
  }, [presentInstallResult, resultPack])

  const handleFeatureConfirm = useCallback(async (selectedFeatures: string[]) => {
    if (!pendingFeaturesPack) return
    const pack = pendingFeaturesPack
    setPendingFeaturesPack(null)
    setPendingFeatures([])
    setUpdatingPack(pack)
    try {
      presentInstallResult(pack, await window.electronAPI.installModpack(pack, selectedFeatures))
    } catch (err) {
      console.error('Update with features error', err)
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

  const handleContextMenu = useCallback((e: React.MouseEvent, packName: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, packName })
  }, [])

  const handleDelete = useCallback((packName: string) => {
    const pack = packs.find((p) => p.name === packName)
    setDeleteTarget({ name: packName, title: pack?.title ?? packName })
  }, [packs])

  const handleDeleteDismiss = useCallback(async (deleted: boolean) => {
    if (deleted && deleteTarget) {
      setPacks((prev) => prev.filter((p) => p.name !== deleteTarget.name))
      await useModpackStore.getState().fetchInstalled()
    }
    setDeleteTarget(null)
  }, [deleteTarget])

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

  const handleContextMenuClose = useCallback(() => setContextMenu(null), [])

  const handleRepairPack = useCallback(async (pack: ModpackManifestReference) => {
    setUpdatingPack(pack)
    setResultPack(pack)
    setUpdateProgress(null)
    setUpdateResult(null)
    try {
      presentInstallResult(pack, await window.electronAPI.installRepairPack(pack.name))
    } catch (error) {
      presentInstallResult(pack, {
        success: false,
        packName: pack.name,
        failures: [],
        error: error instanceof Error ? error.message : 'Reparatur fehlgeschlagen.',
      })
    }
  }, [presentInstallResult])

  const handleChangeFeatures = useCallback(async (packName: string) => {
    try {
      const data = await window.electronAPI.installGetPackFeatures(packName)
      setChangingFeaturesPack(packName)
      setChangingFeaturesData(data)
    } catch (err) {
      console.error('Failed to get pack features', err)
    }
  }, [])

  const handleChangeFeaturesConfirm = useCallback((selectedFeatures: string[]) => {
    if (!changingFeaturesPack) return
    setChangingFeaturesData(null)
    setChangeFeaturesProgress({ total: 0, finished: 0, failed: 0 })
    setChangeFeaturesResult(null)
    window.electronAPI.installChangeFeatures(changingFeaturesPack, selectedFeatures).catch((err) => {
      console.error('Feature change error', err)
      setChangingFeaturesPack(null)
    })
  }, [changingFeaturesPack])

  const handleChangeFeaturesCancel = useCallback(() => {
    setChangingFeaturesPack(null)
    setChangingFeaturesData(null)
  }, [])

  const handleChangeFeaturesProgressCancel = useCallback(() => {
    window.electronAPI.installCancel().catch(console.error)
    setChangingFeaturesPack(null)
    setChangeFeaturesProgress(null)
    setChangeFeaturesResult(null)
  }, [])

  const handleChangeFeaturesResultDismiss = useCallback(() => {
    setChangeFeaturesResult(null)
    setChangingFeaturesPack(null)
  }, [])

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return []
    const { packName } = contextMenu
    const pack = packs.find((p) => p.name === packName)
    const hasUpdate = !!updateMap[packName]
    return [
      ...(hasUpdate && pack ? [{
        label: 'Aktualisieren',
        action: () => handleUpdate(pack),
      }] : []),
      {
        label: 'Einstellungen',
        action: () => setPackSettingsTarget(packName),
      },
      ...(pack ? [{
        label: 'Modpack reparieren',
        disabled: activePackNames.has(packName) || !!changingFeaturesPack || !!updatingPack,
        title: activePackNames.has(packName) ? 'Modpack läuft gerade' : undefined,
        action: () => handleRepairPack(pack),
      }] : []),
      ...(featuresMap[packName] ? [{
        label: 'Optionale Mods',
        disabled: activePackNames.has(packName) || !!changingFeaturesPack || !!updatingPack,
        title: activePackNames.has(packName) ? 'Modpack läuft gerade' : undefined,
        action: () => handleChangeFeatures(packName),
      }] : []),
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
        action: () => {
          const session = activeSessions.find((entry) => entry.packName === packName)
          window.dispatchEvent(new CustomEvent('open-console', { detail: session?.id }))
        },
      },
      {
        label: 'Löschen',
        danger: true,
        disabled: activePackNames.has(packName),
        title: activePackNames.has(packName) ? 'Modpack läuft gerade' : undefined,
        action: () => handleDelete(packName),
      },
    ]
  }, [contextMenu?.packName, packs, updateMap, featuresMap, activePackNames, activeSessions, changingFeaturesPack, updatingPack, handleUpdate, handleRepairPack, handleUploadCrash, handleDelete, handleChangeFeatures])

  const versionOptions = useMemo(
    () => getMinecraftVersionOptions(packs),
    [packs],
  )
  const filteredPacks = useMemo(
    () => filterPacksByMinecraftVersion(packs, selectedVersion),
    [packs, selectedVersion],
  )

  useEffect(() => {
    if (!isMinecraftVersionSelectionValid(selectedVersion, versionOptions)) {
      setSelectedVersion(null)
    }
  }, [selectedVersion, versionOptions])

  const isGameRunning = activeSessions.length > 0
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
                {activeSessions.length} aktiv
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
        </div>
      </div>

      <div className="mb-6">
        <MinecraftVersionSelect
          id="installed-minecraft-version"
          value={selectedVersion}
          options={versionOptions}
          totalCount={packs.length}
          onChange={setSelectedVersion}
          disabled={packs.length === 0}
          loading={loading || reloading}
        />
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
      ) : filteredPacks.length === 0 ? (
        <div className="card px-6 py-16 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-bg-elevated">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true" className="h-6 w-6 text-text-muted">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-text-secondary">Keine installierten Modpacks für diese Version.</p>
          <p className="mt-1 text-xs text-text-muted">Setze den Filter zurück, um alle installierten Modpacks zu sehen.</p>
          <button className="btn-ghost mt-4" onClick={() => setSelectedVersion(null)}>
            Filter zurücksetzen
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4">
          {filteredPacks.map((pack, i) => (
            <div key={pack.name} className="animate-slide-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms`, animationFillMode: 'backwards' }}>
            <ModpackCard
              manifest={pack}
              isInstalled={true}
              isRunning={activePackNames.has(pack.name)}
              hasUpdate={updateMap[pack.name]}
              onPlay={() => handlePlay(pack.name)}
              onUpdate={() => handleUpdate(pack)}
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
          items={contextMenuItems}
          onClose={handleContextMenuClose}
        />
      )}

      {/* Per-pack settings modal */}
      {packSettingsTarget && (
        <PackSettingsModal
          packName={packSettingsTarget}
          packTitle={packs.find((p) => p.name === packSettingsTarget)?.title ?? packSettingsTarget}
          onClose={() => setPackSettingsTarget(null)}
        />
      )}

      {/* Update progress modal */}
      {(updatingPack || updateResult) && (
        <ProgressModal
          progress={updateProgress}
          packTitle={updatingPack?.title ?? resultPack?.title ?? updatingTitleRef.current}
          result={updateResult}
          successText="Erfolgreich aktualisiert!"
          onCancel={handleUpdateCancel}
          onDismiss={handleUpdateDismiss}
          onRetry={handleRetryFailed}
          onRepair={handleRepairFailed}
          onOpenLogs={() => window.electronAPI.configOpenLogs()}
        />
      )}

      {/* Feature selection modal (triggered during update if pack has optional features) */}
      {pendingFeaturesPack && pendingFeatures.length > 0 && (
        <FeatureModal
          features={pendingFeatures}
          onConfirm={handleFeatureConfirm}
          onCancel={handleFeatureCancel}
        />
      )}

      {/* Post-install feature change: feature selection modal */}
      {changingFeaturesData && (
        <FeatureModal
          features={changingFeaturesData.features}
          initialSelection={changingFeaturesData.selected}
          confirmLabel="Übernehmen"
          onConfirm={handleChangeFeaturesConfirm}
          onCancel={handleChangeFeaturesCancel}
        />
      )}

      {/* Post-install feature change: progress modal */}
      {changingFeaturesPack && !changingFeaturesData && (changeFeaturesProgress || changeFeaturesResult) && (
        <ProgressModal
          progress={changeFeaturesProgress}
          packTitle={changingFeaturesTitleRef.current}
          result={changeFeaturesResult}
          successText="Features erfolgreich geändert!"
          onCancel={handleChangeFeaturesProgressCancel}
          onDismiss={handleChangeFeaturesResultDismiss}
        />
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <DeleteConfirmModal
          packName={deleteTarget.name}
          packTitle={deleteTarget.title}
          onDismiss={handleDeleteDismiss}
        />
      )}
    </div>
  )
}
