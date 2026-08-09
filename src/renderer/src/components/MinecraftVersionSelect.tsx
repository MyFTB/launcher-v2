import type { MinecraftVersionOption } from '../utils/modpackFilters'

interface MinecraftVersionSelectProps {
  id: string
  value: string | null
  options: readonly MinecraftVersionOption[]
  totalCount: number
  onChange: (value: string | null) => void
  disabled?: boolean
  loading?: boolean
  className?: string
}

export default function MinecraftVersionSelect({
  id,
  value,
  options,
  totalCount,
  onChange,
  disabled = false,
  loading = false,
  className = '',
}: MinecraftVersionSelectProps) {
  const isDisabled = disabled || loading

  return (
    <div className={`w-full lg:max-w-xs ${className}`.trim()}>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-text-secondary">
        Minecraft-Version
        {loading && <span className="ms-2 font-normal text-text-muted">Wird geladen…</span>}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value ?? ''}
          onChange={(event) => onChange(event.currentTarget.value || null)}
          disabled={isDisabled}
          aria-busy={loading || undefined}
          className="input appearance-none pr-10 [color-scheme:dark] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-base disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="">Alle Versionen ({totalCount})</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value} ({option.count})
            </option>
          ))}
        </select>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          aria-hidden="true"
          focusable="false"
          className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted ${isDisabled ? 'opacity-50' : ''}`}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m6 8 4 4 4-4" />
        </svg>
      </div>
    </div>
  )
}
