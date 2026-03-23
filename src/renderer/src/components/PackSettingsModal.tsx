import { useEffect, useState } from 'react'
import type { LauncherConfig, PackConfig } from '@shared/types'

// ─── Shared slider helpers (mirrors Settings.tsx) ────────────────────────────

const MINECRAFT_MIN_MB = 1024
const RAM_CAP_RATIO    = 0.75
const RAM_STEP_MB      = 1024

function computeMaxMemoryMb(totalRamMb: number | undefined): number {
  if (!totalRamMb) return 16384
  return Math.max(MINECRAFT_MIN_MB, Math.floor((totalRamMb * RAM_CAP_RATIO) / 1024) * 1024)
}

function buildLandmarks(maxMb: number): number[] {
  const pts: number[] = [MINECRAFT_MIN_MB]
  for (let gb = 4; gb * 1024 <= maxMb; gb *= 2) pts.push(gb * 1024)
  if (pts[pts.length - 1] !== maxMb) pts.push(maxMb)
  return pts
}

function memLabel(mb: number): string {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`
}

function clampMemory(mb: number, lo: number, hi: number): number {
  return Math.round(Math.max(lo, Math.min(hi, mb)) / RAM_STEP_MB) * RAM_STEP_MB
}

function ThumbLabel({ value, min, max }: { value: number; min: number; max: number }) {
  const pct    = max === min ? 0 : ((value - min) / (max - min)) * 100
  const offset = 8 - pct * 0.16
  return (
    <div className="relative h-5">
      <span
        style={{ left: `calc(${pct}% + ${offset}px)` }}
        className="absolute -translate-x-1/2 text-xs font-semibold text-accent"
      >
        {value} MB
      </span>
    </div>
  )
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface PackSettingsModalProps {
  packName: string
  packTitle: string
  onClose: () => void
}

// ─── Modal ───────────────────────────────────────────────────────────────────

export default function PackSettingsModal({ packName, packTitle, onClose }: PackSettingsModalProps) {
  const [globalConfig, setGlobalConfig] = useState<LauncherConfig | null>(null)
  const [totalRamMb, setTotalRamMb]     = useState<number | undefined>(undefined)
  const [loading, setLoading]           = useState(true)
  const [saving, setSaving]             = useState(false)

  // Form values — initialised from pack override, else global defaults
  const [maxMemory, setMaxMemory] = useState(4096)
  const [minMemory, setMinMemory] = useState(2048)
  const [jvmArgs,   setJvmArgs]   = useState('')

  // Whether the pack currently has a stored override
  const [hasOverride, setHasOverride] = useState(false)
  // Set to true only when the user explicitly clicks "Standardwerte verwenden";
  // cleared again as soon as they edit any field.
  const [removeOnSave, setRemoveOnSave] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      const [config, sysInfo] = await Promise.all([
        window.electronAPI.configGet(),
        window.electronAPI.systemInfo(),
      ])
      if (cancelled) return

      setGlobalConfig(config)
      setTotalRamMb(sysInfo.totalMemoryMb)

      const override = config.packConfigs?.[packName]
      if (override) {
        setMaxMemory(override.maxMemory ?? config.maxMemory)
        setMinMemory(override.minMemory ?? config.minMemory)
        setJvmArgs(override.jvmArgs   ?? config.jvmArgs)
        setHasOverride(true)
      } else {
        setMaxMemory(config.maxMemory)
        setMinMemory(config.minMemory)
        setJvmArgs(config.jvmArgs)
        setHasOverride(false)
      }
      setLoading(false)
    }
    load().catch(console.error)
    return () => { cancelled = true }
  }, [packName])

  const maxMemoryMb    = computeMaxMemoryMb(totalRamMb)
  const memoryLandmarks = buildLandmarks(maxMemoryMb)

  const handleSave = async (): Promise<void> => {
    if (!globalConfig) return
    setSaving(true)
    try {
      if (removeOnSave) {
        const { [packName]: _removed, ...rest } = globalConfig.packConfigs ?? {}
        await window.electronAPI.configSave({ packConfigs: rest })
      } else {
        const override: PackConfig = { minMemory, maxMemory, jvmArgs }
        const updated = { ...globalConfig.packConfigs, [packName]: override }
        await window.electronAPI.configSave({ packConfigs: updated })
      }
      onClose()
    } catch (err) {
      console.error('Failed to save pack settings:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = (): void => {
    if (!globalConfig) return
    setMaxMemory(globalConfig.maxMemory)
    setMinMemory(globalConfig.minMemory)
    setJvmArgs(globalConfig.jvmArgs)
    setHasOverride(false)
    setRemoveOnSave(true)
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Pack-Einstellungen</h2>
            <p className="text-xs text-text-muted mt-0.5 truncate max-w-xs">{packTitle}</p>
          </div>
          <button
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-elevated transition-colors"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-6 h-6 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            </div>
          ) : (
            <>
              {/* Override notice */}
              {hasOverride && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/25 text-xs text-accent">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5 shrink-0">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Dieses Pack hat eigene Einstellungen.
                </div>
              )}
              {!hasOverride && globalConfig && (
                <p className="text-xs text-text-muted">
                  Momentan werden die globalen Standardwerte verwendet. Ändere die Werte unten, um Pack-spezifische Einstellungen festzulegen.
                </p>
              )}

              {/* JVM Args */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  Zusätzliche JVM-Argumente
                </label>
                <input
                  type="text"
                  className="input font-mono text-xs"
                  placeholder="-XX:+UseG1GC -Xss1m"
                  value={jvmArgs}
                  onChange={(e) => { setRemoveOnSave(false); setJvmArgs(e.target.value) }}
                />
                {globalConfig && jvmArgs !== globalConfig.jvmArgs && (
                  <p className="text-xs text-text-muted mt-1">
                    Global: <span className="font-mono text-text-secondary">{globalConfig.jvmArgs || '(leer)'}</span>
                  </p>
                )}
              </div>

              {/* Max Memory */}
              <div>
                <div className="flex items-center justify-between border-b border-border pb-2 mb-3">
                  <span className="text-xs font-semibold text-text-primary">Arbeitsspeicher</span>
                  {totalRamMb && (
                    <span className="text-xs text-text-muted">
                      System: <span className="text-text-secondary font-medium">{Math.round(totalRamMb / 1024)} GB</span>
                      {' '}— max. <span className="text-accent font-medium">{memLabel(maxMemoryMb)}</span> empfohlen
                    </span>
                  )}
                </div>

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
                      value={maxMemory}
                      onChange={(e) => { setRemoveOnSave(false); setMaxMemory(clampMemory(parseInt(e.target.value) || MINECRAFT_MIN_MB, MINECRAFT_MIN_MB, maxMemoryMb)) }}
                    />
                    <span className="text-sm text-text-secondary">MB</span>
                  </div>
                </div>
                <ThumbLabel value={maxMemory} min={MINECRAFT_MIN_MB} max={maxMemoryMb} />
                <input
                  type="range"
                  min={MINECRAFT_MIN_MB}
                  max={maxMemoryMb}
                  step={RAM_STEP_MB}
                  value={maxMemory}
                  className="w-full accent-accent cursor-pointer"
                  onChange={(e) => { setRemoveOnSave(false); setMaxMemory(parseInt(e.target.value)) }}
                />
                <div className="flex justify-between text-xs text-text-muted mt-1">
                  {memoryLandmarks.map((v) => <span key={v}>{memLabel(v)}</span>)}
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
                      value={minMemory}
                      onChange={(e) => { setRemoveOnSave(false); setMinMemory(clampMemory(parseInt(e.target.value) || MINECRAFT_MIN_MB, MINECRAFT_MIN_MB, maxMemoryMb)) }}
                    />
                    <span className="text-sm text-text-secondary">MB</span>
                  </div>
                </div>
                <p className={`text-xs text-yellow-400 mb-1.5 transition-opacity duration-200 ${minMemory > maxMemory ? 'opacity-100' : 'opacity-0'}`}>
                  ⚠ Minimaler Arbeitsspeicher ist größer als der maximale.
                </p>
                <ThumbLabel value={minMemory} min={MINECRAFT_MIN_MB} max={maxMemoryMb} />
                <input
                  type="range"
                  min={MINECRAFT_MIN_MB}
                  max={maxMemoryMb}
                  step={RAM_STEP_MB}
                  value={minMemory}
                  className="w-full accent-accent cursor-pointer"
                  onChange={(e) => { setRemoveOnSave(false); setMinMemory(parseInt(e.target.value)) }}
                />
                <div className="flex justify-between text-xs text-text-muted mt-1">
                  {memoryLandmarks.map((v) => <span key={v}>{memLabel(v)}</span>)}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && (
          <div className="flex items-center justify-between px-5 py-4 border-t border-border gap-3">
            {/* Reset button — only shown when there's an active override */}
            {hasOverride ? (
              <button
                className="text-xs text-text-muted hover:text-red-400 transition-colors"
                onClick={handleReset}
                disabled={saving}
              >
                Standardwerte verwenden
              </button>
            ) : (
              <span />
            )}

            <div className="flex gap-2">
              <button className="btn-ghost text-sm" onClick={onClose} disabled={saving}>
                Abbrechen
              </button>
              <button
                className="btn-primary text-sm"
                onClick={handleSave}
                disabled={saving || loading}
              >
                {saving ? 'Speichern…' : 'Speichern'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
