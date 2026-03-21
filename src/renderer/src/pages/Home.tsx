import { useEffect, useState } from 'react'
import type { ModpackManifestReference, SystemInfoResult } from '@shared/types'
import { useNavigate } from 'react-router-dom'

function StatItem({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-text-muted uppercase tracking-wide">{label}</span>
      <span className="text-sm font-medium text-text-primary">{value}</span>
    </div>
  )
}

function RecentPackCard({ pack, onPlay }: { pack: ModpackManifestReference; onPlay: () => void }): JSX.Element {
  const [logoUrl, setLogoUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.packsGetLogo(pack.location, pack.name, pack.logo).then((url) => {
      if (!cancelled && url) setLogoUrl(url)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [pack.location, pack.name])

  return (
    <div className="card flex items-center gap-4 p-4 hover:border-border-focus transition-colors duration-150 group">
      <div className="w-14 h-14 rounded-lg bg-bg-elevated flex-shrink-0 overflow-hidden">
        {logoUrl ? (
          <img src={logoUrl} alt={pack.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <div className="w-6 h-6 rounded bg-bg-overlay" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary truncate">{pack.title}</p>
        <p className="text-xs text-text-muted">
          v{pack.version} · MC {pack.gameVersion}
        </p>
      </div>
      <button
        className="btn-primary px-4 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
        onClick={onPlay}
      >
        Spielen
      </button>
    </div>
  )
}

export default function Home(): JSX.Element {
  const navigate = useNavigate()
  const [username, setUsername] = useState<string>('Spieler')
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null) // null = still loading
  const [recentPacks, setRecentPacks] = useState<ModpackManifestReference[]>([])
  const [systemInfo, setSystemInfo] = useState<SystemInfoResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = window.electronAPI.on('auth:profiles-updated', (...args: unknown[]) => {
      const event = args[0] as { profiles: unknown[] }
      setIsLoggedIn(event.profiles.length > 0)
    })
    return unsub
  }, [])

  useEffect(() => {
    // Try to get username from localStorage first
    const stored = localStorage.getItem('lastUsername')
    if (stored) setUsername(stored)

    async function load(): Promise<void> {
      try {
        const [config, sysInfo] = await Promise.all([
          window.electronAPI.configGet(),
          window.electronAPI.systemInfo(),
        ])

        setSystemInfo(sysInfo)

        // Get selected profile username
        const selectedUuid = config.profileStore?.selectedProfileUuid
        const hasProfiles = (config.profileStore?.profiles?.length ?? 0) > 0
        setIsLoggedIn(hasProfiles)
        if (selectedUuid) {
          const profile = config.profileStore.profiles.find((p) => p.uuid === selectedUuid)
          if (profile?.lastKnownUsername) {
            setUsername(profile.lastKnownUsername)
            localStorage.setItem('lastUsername', profile.lastKnownUsername)
          }
        }

        // Resolve last played packs
        const lastPlayed = config.lastPlayedPacks ?? []
        if (lastPlayed.length > 0) {
          try {
            const installed = await window.electronAPI.packsGetRemote()
            const matched = lastPlayed
              .slice(0, 3)
              .map((name) => installed.find((p) => p.name === name))
              .filter((p): p is ModpackManifestReference => p !== undefined)
            setRecentPacks(matched)
          } catch {
            // Remote unavailable — skip recent packs
          }
        }
      } catch (err) {
        console.error('Home: load error', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [])

  function handlePlayPack(packName: string): void {
    window.electronAPI.launchStart(packName).catch(console.error)
    navigate('/installed')
  }

  const platformLabel = systemInfo
    ? { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[systemInfo.platform] ?? systemInfo.platform
    : '—'

  return (
    <div className="p-6 max-w-3xl mx-auto animate-fade-in">
      {/* Welcome heading */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-text-primary">
          Willkommen, <span className="text-accent">{username}</span>
        </h1>
        <p className="text-text-secondary mt-1">Starte dein Lieblings-Modpack oder entdecke Neues.</p>
      </div>

      {/* Not-authenticated banner */}
      {isLoggedIn === false && (
        <div className="mb-6 flex items-start gap-3 px-4 py-3.5 rounded-lg bg-amber-900/20 border border-amber-700/40 animate-fade-in">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-300">Nicht angemeldet</p>
            <p className="text-xs text-amber-400/80 mt-0.5">
              Melde dich mit deinem Microsoft-Konto an, um Modpacks zu spielen.
            </p>
          </div>
          <button
            className="btn-primary text-xs flex-shrink-0"
            onClick={() => navigate('/settings')}
          >
            Anmelden
          </button>
        </div>
      )}

      {/* Recently played */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-widest mb-3">
          Zuletzt gespielt
        </h2>
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card flex items-center gap-4 p-4 animate-pulse">
                <div className="w-14 h-14 rounded-lg bg-bg-elevated flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-bg-elevated rounded w-1/2" />
                  <div className="h-3 bg-bg-elevated rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : recentPacks.length > 0 ? (
          <div className="space-y-3">
            {recentPacks.map((pack) => (
              <RecentPackCard
                key={pack.name}
                pack={pack}
                onPlay={() => handlePlayPack(pack.name)}
              />
            ))}
          </div>
        ) : (
          <div className="card px-6 py-8 text-center">
            <p className="text-text-secondary text-sm">Noch keine Modpacks gespielt.</p>
            <button
              className="btn-primary mt-4"
              onClick={() => navigate('/available')}
            >
              Modpacks entdecken
            </button>
          </div>
        )}
      </section>

      {/* Quick stats */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-widest mb-3">
          Systeminfo
        </h2>
        <div className="card px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatItem label="Launcher" value={systemInfo?.launcherVersion ?? '—'} />
          <StatItem label="Plattform" value={platformLabel} />
          <StatItem label="Architektur" value={systemInfo?.arch ?? '—'} />
          <StatItem
            label="RAM gesamt"
            value={systemInfo ? `${Math.round(systemInfo.totalMemoryMb / 1024)} GB` : '—'}
          />
        </div>
      </section>

      {/* Community links */}
      <section>
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-widest mb-3">
          Community
        </h2>
        <div className="flex gap-3 flex-wrap">
          <button
            className="btn-secondary gap-2"
            onClick={() => window.electronAPI.systemOpenUrl('https://discord.gg/myftb')}
          >
            <DiscordIcon />
            Discord
          </button>
          <button
            className="btn-secondary gap-2"
            onClick={() => window.electronAPI.systemOpenUrl('https://myftb.de')}
          >
            <WebIcon />
            Website
          </button>
        </div>
      </section>
    </div>
  )
}

function DiscordIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.03.056a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  )
}

function WebIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}
