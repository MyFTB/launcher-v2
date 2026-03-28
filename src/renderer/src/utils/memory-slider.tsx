// ─── Memory slider constants & helpers ───────────────────────────────────────

export const MINECRAFT_MIN_MB = 1024
export const RAM_CAP_RATIO = 0.75
export const RAM_STEP_MB = 1024

export function computeMaxMemoryMb(totalRamMb: number | undefined): number {
  if (!totalRamMb) return 16384
  return Math.max(MINECRAFT_MIN_MB, Math.floor((totalRamMb * RAM_CAP_RATIO) / 1024) * 1024)
}

export function buildLandmarks(maxMb: number): number[] {
  const pts: number[] = [MINECRAFT_MIN_MB]
  for (let gb = 4; gb * 1024 <= maxMb; gb *= 2) pts.push(gb * 1024)
  if (pts[pts.length - 1] !== maxMb) pts.push(maxMb)
  return pts
}

export function memLabel(mb: number): string {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`
}

export function clampMemory(mb: number, lo: number, hi: number): number {
  return Math.round(Math.max(lo, Math.min(hi, mb)) / RAM_STEP_MB) * RAM_STEP_MB
}

export function ThumbLabel({ value, min, max }: { value: number; min: number; max: number }) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100
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
