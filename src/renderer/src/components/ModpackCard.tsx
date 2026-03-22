import { memo, useEffect, useState } from 'react'
import type { ModpackManifest, ModpackManifestReference } from '@shared/types'

interface ModpackCardProps {
  manifest: ModpackManifest | ModpackManifestReference
  isInstalled: boolean
  isRunning: boolean
  hasUpdate?: boolean
  isNew?: boolean
  onInstall?: () => void
  onPlay?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

function isFullManifest(m: ModpackManifest | ModpackManifestReference): m is ModpackManifest {
  return 'versionManifest' in m
}

function detectModLoader(manifest: ModpackManifest | ModpackManifestReference): string | null {
  if (!isFullManifest(manifest)) return null
  const libs = manifest.versionManifest?.libraries ?? []
  for (const lib of libs) {
    const name = lib.name ?? ''
    if (name.startsWith('net.neoforged')) return 'NeoForge'
    if (name.startsWith('net.minecraftforge')) return 'Forge'
  }
  return null
}

export default memo(function ModpackCard({
  manifest,
  isInstalled,
  isRunning,
  hasUpdate,
  isNew,
  onInstall,
  onPlay,
  onContextMenu,
}: ModpackCardProps) {
  const [logoUrl, setLogoUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .packsGetLogo(manifest.location, manifest.name, manifest.logo)
      .then((url) => {
        if (!cancelled && url) setLogoUrl(url)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [manifest.location, manifest.name, manifest.logo])

  const modLoader = detectModLoader(manifest)

  return (
    <div
      className="card-interactive relative flex flex-col overflow-hidden group cursor-pointer"
      onContextMenu={onContextMenu}
    >
      {/* Logo area */}
      <div className="relative w-full aspect-square bg-bg-elevated overflow-hidden">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={manifest.title}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <div className="w-14 h-14 rounded-xl bg-bg-overlay flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-7 h-7 text-text-muted">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
          </div>
        )}

        {/* Running pulse indicator */}
        {isRunning && (
          <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-bg-base/75 backdrop-blur-sm rounded-full px-2 py-1">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-xs font-medium text-accent">Läuft...</span>
          </div>
        )}

        {/* Update / New badges */}
        {hasUpdate && (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-semibold bg-amber-500/90 text-black backdrop-blur-sm">
            Update
          </div>
        )}
        {!hasUpdate && isNew && (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-semibold bg-accent/90 text-white backdrop-blur-sm">
            Neu
          </div>
        )}

        {/* Hover action overlay */}
        <div
          className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-[2px] transition-opacity duration-200 opacity-0 group-hover:opacity-100"
        >
          {isInstalled ? (
            <button
              className="btn-primary px-6 py-2.5 text-base font-semibold shadow-lg"
              onClick={(e) => {
                e.stopPropagation()
                onPlay?.()
              }}
              disabled={isRunning}
            >
              {isRunning ? 'Läuft...' : 'Spielen'}
            </button>
          ) : (
            <button
              className="btn-primary px-6 py-2.5 text-base font-semibold shadow-lg"
              onClick={(e) => {
                e.stopPropagation()
                onInstall?.()
              }}
            >
              Installieren
            </button>
          )}
        </div>
      </div>

      {/* Info area */}
      <div className="p-3 flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-text-primary leading-snug line-clamp-2">
            {manifest.title}
          </h3>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Game version badge */}
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-bg-overlay text-text-muted border border-border">
            {manifest.gameVersion}
          </span>

          {/* Mod loader badge */}
          {modLoader && (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs border ${
                modLoader === 'NeoForge'
                  ? 'bg-orange-900/30 text-orange-400 border-orange-700/40'
                  : 'bg-yellow-900/30 text-yellow-400 border-yellow-700/40'
              }`}
            >
              {modLoader}
            </span>
          )}
        </div>

        <span className="text-xs text-text-muted tabular-nums">v{manifest.version}</span>
      </div>
    </div>
  )
}, (prev, next) =>
  prev.manifest === next.manifest &&
  prev.isInstalled === next.isInstalled &&
  prev.isRunning === next.isRunning &&
  prev.hasUpdate === next.hasUpdate &&
  prev.isNew === next.isNew &&
  prev.onInstall === next.onInstall &&
  prev.onPlay === next.onPlay &&
  prev.onContextMenu === next.onContextMenu
)
