import { useEffect, useState, useCallback } from 'react'
import type { LauncherConfig, SystemInfoResult, LauncherProfile } from '@shared/types'
import LoginModal from '../components/LoginModal'

const MEMORY_PRESETS = [1024, 2048, 3072, 4096, 6144, 8192, 10240, 12288, 16384]

function memLabel(mb: number): string {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`
}

interface FormState {
  packKey: string
  installationDir: string
  jvmArgs: string
  maxMemory: number
  minMemory: number
  gameWidth: number
  gameHeight: number
  allowWebstart: boolean
}

function formFromConfig(c: LauncherConfig): FormState {
  return {
    packKey: c.packKey ?? '',
    installationDir: c.installationDir ?? '',
    jvmArgs: c.jvmArgs ?? '',
    maxMemory: c.maxMemory ?? 4096,
    minMemory: c.minMemory ?? 2048,
    gameWidth: c.gameWidth ?? 854,
    gameHeight: c.gameHeight ?? 480,
    allowWebstart: c.allowWebstart ?? true,
  }
}

export default function Settings(): JSX.Element {
  const [form, setForm] = useState<FormState>({
    packKey: '',
    installationDir: '',
    jvmArgs: '',
    maxMemory: 4096,
    minMemory: 2048,
    gameWidth: 854,
    gameHeight: 480,
    allowWebstart: true,
  })
  const [original, setOriginal] = useState<FormState | null>(null)
  const [systemInfo, setSystemInfo] = useState<SystemInfoResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<LauncherProfile[]>([])
  const [selectedUuid, setSelectedUuid] = useState<string | undefined>(undefined)
  const [showLogin, setShowLogin] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const [config, sysInfo] = await Promise.all([
          window.electronAPI.configGet(),
          window.electronAPI.systemInfo(),
        ])
        if (cancelled) return
        const f = formFromConfig(config)
        setForm(f)
        setOriginal(f)
        setSystemInfo(sysInfo)
        setProfiles(config.profileStore.profiles)
        setSelectedUuid(config.profileStore.selectedProfileUuid)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Fehler beim Laden')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Keep profile state in sync when login/logout/switch happens
  useEffect(() => {
    const unsub = window.electronAPI.on('auth:profiles-updated', (...args: unknown[]) => {
      const event = args[0] as { profiles: LauncherProfile[]; selectedUuid?: string }
      setProfiles(event.profiles)
      setSelectedUuid(event.selectedUuid)
    })
    return unsub
  }, [])

  const handleLogout = useCallback(async () => {
    await window.electronAPI.authLogout().catch(console.error)
  }, [])

  const handleSwitchProfile = useCallback(async (uuid: string) => {
    await window.electronAPI.authSwitchProfile(uuid).catch(console.error)
  }, [])

  const isDirty = original !== null && JSON.stringify(form) !== JSON.stringify(original)

  const handlePickDir = useCallback(async () => {
    const dir = await window.electronAPI.configPickDir()
    if (dir) setForm((prev) => ({ ...prev, installationDir: dir }))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      await window.electronAPI.configSave(form)
      setOriginal(form)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Speichern')
    } finally {
      setSaving(false)
    }
  }, [form])

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const maxMemorySliderValue = MEMORY_PRESETS.indexOf(form.maxMemory) !== -1
    ? MEMORY_PRESETS.indexOf(form.maxMemory)
    : MEMORY_PRESETS.findIndex((v) => v >= form.maxMemory)

  const minMemorySliderValue = MEMORY_PRESETS.indexOf(form.minMemory) !== -1
    ? MEMORY_PRESETS.indexOf(form.minMemory)
    : MEMORY_PRESETS.findIndex((v) => v >= form.minMemory)

  const platformLabel = systemInfo
    ? { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[systemInfo.platform] ?? systemInfo.platform
    : '—'

  if (loading) {
    return (
      <div className="p-6 max-w-2xl mx-auto animate-fade-in">
        <div className="mb-6">
          <div className="h-8 bg-bg-elevated rounded w-48 animate-pulse mb-2" />
          <div className="h-4 bg-bg-elevated rounded w-64 animate-pulse" />
        </div>
        <div className="card p-6 space-y-4 animate-pulse">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="h-3 bg-bg-elevated rounded w-24" />
              <div className="h-9 bg-bg-elevated rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-2xl mx-auto animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Einstellungen</h1>
        <p className="text-text-secondary mt-1 text-sm">Konfiguriere den Launcher nach deinen Wünschen.</p>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/30 border border-red-700/50 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Account section */}
      <div className="card p-6 mb-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-primary border-b border-border pb-3">
          Account
        </h2>

        {profiles.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-text-secondary">Nicht angemeldet.</p>
            <button className="btn-primary" onClick={() => setShowLogin(true)}>
              <MicrosoftIcon />
              Mit Microsoft anmelden
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {profiles.map((p) => {
              const isSelected = p.uuid === selectedUuid
              return (
                <div
                  key={p.uuid}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${
                    isSelected
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border bg-bg-elevated cursor-pointer hover:border-border-focus/30'
                  }`}
                  onClick={() => !isSelected && handleSwitchProfile(p.uuid)}
                >
                  <PlayerAvatar uuid={p.uuid} username={p.lastKnownUsername} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{p.lastKnownUsername}</p>
                    {isSelected && (
                      <p className="text-xs text-accent">Aktiver Account</p>
                    )}
                  </div>
                  {isSelected && (
                    <button
                      className="btn-ghost text-xs text-red-400 hover:text-red-300 flex-shrink-0"
                      onClick={(e) => { e.stopPropagation(); handleLogout() }}
                    >
                      Abmelden
                    </button>
                  )}
                </div>
              )
            })}
            <button className="btn-ghost text-xs" onClick={() => setShowLogin(true)}>
              + Account hinzufügen
            </button>
          </div>
        )}
      </div>

      {/* Launcher settings */}
      <div className="card p-6 mb-5 space-y-5">
        <h2 className="text-sm font-semibold text-text-primary border-b border-border pb-3">
          Launcher
        </h2>

        {/* Pack Key */}
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            Pack Key
          </label>
          <input
            type="text"
            className="input"
            placeholder="Dein Pack-Zugangscode"
            value={form.packKey}
            onChange={(e) => update('packKey', e.target.value)}
          />
          <p className="text-xs text-text-muted mt-1">
            Ermöglicht den Zugriff auf private Modpacks.
          </p>
        </div>

        {/* Install Directory */}
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            Installationsverzeichnis
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              className="input flex-1"
              placeholder="Ordner wählen..."
              value={form.installationDir}
              onChange={(e) => update('installationDir', e.target.value)}
            />
            <button className="btn-secondary flex-shrink-0" onClick={handlePickDir}>
              Durchsuchen
            </button>
          </div>
        </div>

        {/* Allow Webstart */}
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-text-primary">Webstart erlauben</span>
            <p className="text-xs text-text-muted mt-0.5">
              Erlaubt das Starten von Modpacks über myftb:// Links.
            </p>
          </div>
          <button
            type="button"
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none flex-shrink-0 ${
              form.allowWebstart ? 'bg-accent' : 'bg-bg-overlay'
            }`}
            onClick={() => update('allowWebstart', !form.allowWebstart)}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
                form.allowWebstart ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* JVM settings */}
      <div className="card p-6 mb-5 space-y-5">
        <h2 className="text-sm font-semibold text-text-primary border-b border-border pb-3">
          Java &amp; Arbeitsspeicher
        </h2>

        {/* JVM Args */}
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            Zusätzliche JVM-Argumente
          </label>
          <input
            type="text"
            className="input font-mono text-xs"
            placeholder="-XX:+UseG1GC -Xss1m"
            value={form.jvmArgs}
            onChange={(e) => update('jvmArgs', e.target.value)}
          />
        </div>

        {/* Max Memory */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-text-secondary">
              Maximaler Arbeitsspeicher
            </label>
            <span className="text-sm font-semibold text-accent">{memLabel(form.maxMemory)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={MEMORY_PRESETS.length - 1}
            step={1}
            value={maxMemorySliderValue >= 0 ? maxMemorySliderValue : 3}
            className="w-full accent-accent cursor-pointer"
            onChange={(e) => update('maxMemory', MEMORY_PRESETS[parseInt(e.target.value)])}
          />
          <div className="flex justify-between text-xs text-text-muted mt-1">
            {MEMORY_PRESETS.filter((_, i) => i % 2 === 0).map((v) => (
              <span key={v}>{memLabel(v)}</span>
            ))}
          </div>
          {systemInfo && (
            <p className="text-xs text-text-muted mt-1">
              System: {Math.round(systemInfo.totalMemoryMb / 1024)} GB verfügbar
            </p>
          )}
        </div>

        {/* Min Memory */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-text-secondary">
              Minimaler Arbeitsspeicher
            </label>
            <span className="text-sm font-semibold text-accent">{memLabel(form.minMemory)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={MEMORY_PRESETS.length - 1}
            step={1}
            value={minMemorySliderValue >= 0 ? minMemorySliderValue : 1}
            className="w-full accent-accent cursor-pointer"
            onChange={(e) => update('minMemory', MEMORY_PRESETS[parseInt(e.target.value)])}
          />
          <div className="flex justify-between text-xs text-text-muted mt-1">
            {MEMORY_PRESETS.filter((_, i) => i % 2 === 0).map((v) => (
              <span key={v}>{memLabel(v)}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Game window settings */}
      <div className="card p-6 mb-5 space-y-5">
        <h2 className="text-sm font-semibold text-text-primary border-b border-border pb-3">
          Spielfenster
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Breite (px)
            </label>
            <input
              type="number"
              className="input"
              min={640}
              max={7680}
              value={form.gameWidth}
              onChange={(e) => update('gameWidth', parseInt(e.target.value) || 854)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Höhe (px)
            </label>
            <input
              type="number"
              className="input"
              min={480}
              max={4320}
              value={form.gameHeight}
              onChange={(e) => update('gameHeight', parseInt(e.target.value) || 480)}
            />
          </div>
        </div>
      </div>

      {/* System info */}
      <div className="card px-5 py-4 mb-6 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <span className="text-xs text-text-muted uppercase tracking-wide">Launcher</span>
          <p className="text-sm font-medium text-text-primary mt-0.5">{systemInfo?.launcherVersion ?? '—'}</p>
        </div>
        <div>
          <span className="text-xs text-text-muted uppercase tracking-wide">Plattform</span>
          <p className="text-sm font-medium text-text-primary mt-0.5">{platformLabel}</p>
        </div>
        <div>
          <span className="text-xs text-text-muted uppercase tracking-wide">Architektur</span>
          <p className="text-sm font-medium text-text-primary mt-0.5">{systemInfo?.arch ?? '—'}</p>
        </div>
        <div>
          <span className="text-xs text-text-muted uppercase tracking-wide">RAM gesamt</span>
          <p className="text-sm font-medium text-text-primary mt-0.5">
            {systemInfo ? `${Math.round(systemInfo.totalMemoryMb / 1024)} GB` : '—'}
          </p>
        </div>
      </div>

      {/* Save button */}
      <div className="flex items-center justify-between">
        <button
          className="btn-ghost text-xs"
          onClick={() => window.electronAPI.configOpenLogs()}
        >
          Log-Ordner öffnen
        </button>
        <div className="flex items-center gap-3">
          {saveSuccess && (
            <span className="text-xs text-accent animate-fade-in">Gespeichert</span>
          )}
          <button
            className="btn-primary"
            disabled={!isDirty || saving}
            onClick={handleSave}
          >
            {saving ? 'Speichern...' : 'Speichern'}
          </button>
        </div>
      </div>

      {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
    </div>
  )
}

function PlayerAvatar({ uuid, username }: { uuid: string; username: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className="w-8 h-8 rounded flex-shrink-0 bg-bg-overlay flex items-center justify-center text-xs font-bold text-text-secondary select-none">
        {username.charAt(0).toUpperCase()}
      </div>
    )
  }
  return (
    <img
      src={`https://mc-heads.net/avatar/${uuid}/32`}
      alt={username}
      className="w-8 h-8 rounded flex-shrink-0"
      onError={() => setFailed(true)}
    />
  )
}

function MicrosoftIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 21 21" className="w-4 h-4 flex-shrink-0" fill="none">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#00a4ef" />
      <rect x="1" y="11" width="9" height="9" fill="#7fba00" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  )
}
