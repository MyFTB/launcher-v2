import { memo, useEffect, useState, useCallback, useRef, useMemo, KeyboardEvent } from 'react'
import type { LauncherConfig, SystemInfoResult, LauncherProfile } from '@shared/types'
import LoginModal from '../components/LoginModal'
import MicrosoftIcon from '../components/icons/MicrosoftIcon'
import { MINECRAFT_MIN_MB, RAM_STEP_MB, computeMaxMemoryMb, buildLandmarks, memLabel, clampMemory, ThumbLabel } from '../utils/memory-slider'

// ─── PackKey chip input ────────────────────────────────────────────────────────

function PackKeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const keys = value.split(',').map((k) => k.trim()).filter(Boolean)
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const addKey = (raw: string) => {
    const trimmed = raw.trim().replace(/,/g, '')
    if (!trimmed || keys.includes(trimmed)) return
    onChange([...keys, trimmed].join(','))
    setInput('')
  }

  const removeKey = (k: string) => {
    onChange(keys.filter((x) => x !== k).join(','))
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addKey(input)
    } else if (e.key === 'Backspace' && input === '' && keys.length > 0) {
      removeKey(keys[keys.length - 1])
    }
  }

  return (
    <div
      className="input flex flex-wrap gap-1.5 min-h-9.5 h-auto cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {keys.map((k) => (
        <span
          key={k}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent/20 border border-accent/40 text-xs text-accent font-mono"
        >
          {k}
          <button
            type="button"
            className="text-accent/60 hover:text-accent leading-none"
            onClick={(e) => { e.stopPropagation(); removeKey(k) }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        className="flex-1 min-w-30 bg-transparent outline-none text-sm text-text-primary placeholder:text-text-muted"
        placeholder={keys.length === 0 ? 'Zugangscode eingeben…' : 'Weiteren Schlüssel hinzufügen…'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (input.trim()) addKey(input) }}
      />
    </div>
  )
}

interface FormState {
  packKey: string
  jvmArgs: string
  maxMemory: number
  minMemory: number
  gameWidth: number
  gameHeight: number
  allowWebstart: boolean
  updateChannel: 'stable' | 'experimental'
}

function formFromConfig(c: LauncherConfig): FormState {
  return {
    packKey: c.packKey ?? '',
    jvmArgs: c.jvmArgs ?? '',
    maxMemory: c.maxMemory ?? 4096,
    minMemory: c.minMemory ?? 2048,
    gameWidth: c.gameWidth ?? 854,
    gameHeight: c.gameHeight ?? 480,
    allowWebstart: c.allowWebstart ?? true,
    updateChannel: c.updateChannel ?? 'stable',
  }
}

export default function Settings() {
  const [form, setForm] = useState<FormState>({
    packKey: '',
    jvmArgs: '',
    maxMemory: 4096,
    minMemory: 2048,
    gameWidth: 854,
    gameHeight: 480,
    allowWebstart: true,
    updateChannel: 'stable',
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
  const saveSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const formRef = useRef(form)
  useEffect(() => { formRef.current = form }, [form])

  const [dataDirChanging, setDataDirChanging] = useState(false)
  const [dataDirError, setDataDirError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (saveSuccessTimeoutRef.current) clearTimeout(saveSuccessTimeoutRef.current)
    }
  }, [])

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

  const isDirty = useMemo(
    () => original !== null && JSON.stringify(form) !== JSON.stringify(original),
    [form, original]
  )

  const handleChangeDataDir = useCallback(async () => {
    setDataDirChanging(true)
    setDataDirError(null)
    try {
      const result = await window.electronAPI.configChangeDataDir()
      if (!result.success && result.error !== 'cancelled') {
        setDataDirError(result.error ?? 'Unbekannter Fehler')
      }
    } catch (err) {
      setDataDirError(err instanceof Error ? err.message : 'Fehler beim Verschieben')
    } finally {
      setDataDirChanging(false)
    }
  }, [])

  const handleSave = useCallback(async () => {
    const snapshot = formRef.current
    setSaving(true)
    setError(null)
    try {
      await window.electronAPI.configSave(snapshot)
      setOriginal(snapshot)
      setSaveSuccess(true)
      if (saveSuccessTimeoutRef.current) clearTimeout(saveSuccessTimeoutRef.current)
      saveSuccessTimeoutRef.current = setTimeout(() => setSaveSuccess(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Speichern')
    } finally {
      setSaving(false)
    }
  }, [])

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const maxMemoryMb = computeMaxMemoryMb(systemInfo?.totalMemoryMb)
  const memoryLandmarks = useMemo(() => buildLandmarks(maxMemoryMb), [maxMemoryMb])

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
    <div className="animate-fade-in flex flex-col min-h-full">
      <div className="p-6 max-w-2xl mx-auto w-full flex-1">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary tracking-tight">Einstellungen</h1>
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
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-[background-color,border-color,transform] duration-150 ${
                    isSelected
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border bg-bg-elevated cursor-pointer hover:bg-bg-overlay hover:border-border-focus/30 active:scale-[0.99]'
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
                      className="btn-ghost text-xs text-red-400 hover:text-red-300 shrink-0"
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

        {/* Pack Keys */}
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            Pack Keys
          </label>
          <PackKeyInput value={form.packKey} onChange={(v) => update('packKey', v)} />
          <p className="text-xs text-text-muted mt-1">
            Zugangscodes für private Modpacks. Enter oder Komma zum Hinzufügen, Backspace zum Entfernen.
          </p>
        </div>

        {/* Data Directory */}
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            Speicherort
          </label>
          <p className="text-xs text-text-muted mb-2">
            Hier werden Modpacks, Konfiguration, Logs, Java-Runtimes und der Cache gespeichert.
          </p>
          <div className="flex gap-2 items-center">
            <span className="input flex-1 text-text-secondary truncate cursor-default select-all">
              {systemInfo?.dataDir ?? '...'}
            </span>
            <button
              className="btn-secondary shrink-0"
              onClick={handleChangeDataDir}
              disabled={dataDirChanging}
            >
              {dataDirChanging ? 'Verschiebe...' : 'Ändern...'}
            </button>
          </div>
          {dataDirError && (
            <p className="text-xs text-red-400 mt-1">{dataDirError}</p>
          )}
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
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none shrink-0 ${
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
          <div className="flex items-center justify-between border-b border-border pb-2 mb-3">
            <span className="text-xs font-semibold text-text-primary">
              Arbeitsspeicher
            </span>
            {systemInfo && (
              <span className="text-xs text-text-muted">
                System: <span className="text-text-secondary font-medium">{Math.round(systemInfo.totalMemoryMb / 1024)} GB</span>
                {' '}— max. <span className="text-accent font-medium">{memLabel(maxMemoryMb)}</span> empfohlen
              </span>
            )}
          </div>

          {/* Max Memory */}
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-text-secondary">
              Maximaler Arbeitsspeicher
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={MINECRAFT_MIN_MB}
                max={maxMemoryMb}
                step={RAM_STEP_MB}
                className="w-20 text-right bg-transparent text-sm font-semibold text-accent border-b border-accent/40 focus:border-accent focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={form.maxMemory}
                onChange={(e) => {
                  const mb = clampMemory(parseInt(e.target.value) || MINECRAFT_MIN_MB, MINECRAFT_MIN_MB, maxMemoryMb)
                  update('maxMemory', mb)
                }}
              />
              <span className="text-sm text-text-secondary">MB</span>
            </div>
          </div>
          <ThumbLabel value={form.maxMemory} min={MINECRAFT_MIN_MB} max={maxMemoryMb} />
          <input
            type="range"
            min={MINECRAFT_MIN_MB}
            max={maxMemoryMb}
            step={RAM_STEP_MB}
            value={form.maxMemory}
            className="w-full accent-accent cursor-pointer"
            onChange={(e) => update('maxMemory', parseInt(e.target.value))}
          />
          <div className="flex justify-between text-xs text-text-muted mt-1">
            {memoryLandmarks.map((v) => (
              <span key={v}>{memLabel(v)}</span>
            ))}
          </div>
        </div>

        {/* Min Memory */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-text-secondary">
              Minimaler Arbeitsspeicher
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={MINECRAFT_MIN_MB}
                max={maxMemoryMb}
                step={RAM_STEP_MB}
                className="w-20 text-right bg-transparent text-sm font-semibold text-accent border-b border-accent/40 focus:border-accent focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={form.minMemory}
                onChange={(e) => {
                  const mb = clampMemory(parseInt(e.target.value) || MINECRAFT_MIN_MB, MINECRAFT_MIN_MB, maxMemoryMb)
                  update('minMemory', mb)
                }}
              />
              <span className="text-sm text-text-secondary">MB</span>
            </div>
          </div>
          <p className={`text-xs text-yellow-400 mb-1.5 transition-opacity duration-200 ${form.minMemory > form.maxMemory ? 'opacity-100' : 'opacity-0'}`}>
            ⚠ Minimaler Arbeitsspeicher ist größer als der maximale.
          </p>
          <ThumbLabel value={form.minMemory} min={MINECRAFT_MIN_MB} max={maxMemoryMb} />
          <input
            type="range"
            min={MINECRAFT_MIN_MB}
            max={maxMemoryMb}
            step={RAM_STEP_MB}
            value={form.minMemory}
            className="w-full accent-accent cursor-pointer"
            onChange={(e) => update('minMemory', parseInt(e.target.value))}
          />
          <div className="flex justify-between text-xs text-text-muted mt-1">
            {memoryLandmarks.map((v) => (
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
      <div className="card px-5 py-4 mb-6 flex justify-between">
        <div className="text-left">
          <span className="text-xs text-text-muted">Launcher</span>
          <p className="text-sm font-medium text-text-primary mt-0.5">{systemInfo?.launcherVersion ?? '—'}</p>
        </div>
        <div className="text-center">
          <span className="text-xs text-text-muted">Plattform</span>
          <p className="text-sm font-medium text-text-primary mt-0.5">{platformLabel}</p>
        </div>
        <div className="text-right">
          <span className="text-xs text-text-muted">Architektur</span>
          <p className="text-sm font-medium text-text-primary mt-0.5">{systemInfo?.arch ?? '—'}</p>
        </div>
      </div>

      {/* Update channel */}
      <div className="card px-5 py-4 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <label className="text-xs font-medium text-text-secondary">Update-Kanal</label>
            <p className="text-xs text-text-muted mt-0.5">
              Experimentell enthält Vorabversionen und kann instabil sein.
            </p>
          </div>
          <div className="flex items-center gap-1 bg-bg-base rounded-lg p-1 shrink-0">
            {(['stable', 'experimental'] as const).map((ch) => (
              <button
                key={ch}
                onClick={() => {
                  update('updateChannel', ch)
                  window.electronAPI.updateSetChannel(ch)
                }}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors duration-150 ${
                  form.updateChannel === ch
                    ? 'bg-bg-elevated text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {ch === 'stable' ? 'Stabil' : 'Experimentell'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Log button */}
      <div className="flex items-center justify-end pb-4">
        <button
          className="btn-ghost text-xs"
          onClick={() => window.electronAPI.configOpenLogs()}
        >
          Log-Ordner öffnen
        </button>
      </div>

      {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
    </div>

    {/* Discord-style floating save pill */}
    <div className="sticky bottom-0 flex justify-center pb-5 pointer-events-none">
      <div
        className={`pointer-events-auto flex items-center gap-4 px-5 py-2.5 rounded-2xl bg-bg-elevated border border-border shadow-2xl transition-all duration-200 ${
          isDirty ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
        }`}
      >
        <span className="text-sm text-text-secondary whitespace-nowrap">
          Nicht gespeicherte Änderungen
        </span>
        <div className="flex items-center gap-2">
          {saveSuccess && (
            <span className="text-xs text-accent animate-fade-in">✓ Gespeichert</span>
          )}
          <button
            className="btn-ghost text-sm"
            disabled={saving}
            onClick={() => original && setForm(original)}
          >
            Zurücksetzen
          </button>
          <button className="btn-primary" disabled={saving || form.minMemory > form.maxMemory} onClick={handleSave}>
            {saving ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  </div>
)
}

const PlayerAvatar = memo(function PlayerAvatar({ uuid, username }: { uuid: string; username: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className="w-8 h-8 rounded shrink-0 bg-bg-overlay flex items-center justify-center text-xs font-bold text-text-secondary select-none">
        {username.charAt(0).toUpperCase()}
      </div>
    )
  }
  return (
    <img
      src={`https://mc-heads.net/avatar/${uuid}/32`}
      alt={username}
      className="w-8 h-8 rounded shrink-0"
      width="32"
      height="32"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
})

