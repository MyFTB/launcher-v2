import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/types'

// ── Pure helper: deep merge (mirrors config.service logic) ────────────────────

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target }
  for (const key of Object.keys(source) as (keyof T)[]) {
    const srcVal = source[key]
    const tgtVal = target[key]
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object'
    ) {
      result[key] = deepMerge(tgtVal as object, srcVal as object) as T[keyof T]
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[keyof T]
    }
  }
  return result
}

// ── Memory heuristic ──────────────────────────────────────────────────────────

function detectDefaultMaxMemory(totalMemoryMb: number): number {
  if (totalMemoryMb >= 16000) return 8192
  if (totalMemoryMb >= 12000) return 6144
  if (totalMemoryMb >= 8000) return 4096
  return 4096
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('config service: deepMerge', () => {
  it('merges top-level fields', () => {
    const result = deepMerge(DEFAULT_CONFIG, { packKey: 'abc123' })
    expect(result.packKey).toBe('abc123')
  })

  it('preserves unset fields from target', () => {
    const result = deepMerge(DEFAULT_CONFIG, { packKey: 'abc' })
    expect(result.maxMemory).toBe(DEFAULT_CONFIG.maxMemory)
    expect(result.gameWidth).toBe(854)
  })

  it('deep-merges nested objects (profileStore)', () => {
    const result = deepMerge(DEFAULT_CONFIG, {
      profileStore: { selectedProfileUuid: 'uuid-123' }
    })
    expect(result.profileStore.selectedProfileUuid).toBe('uuid-123')
    expect(result.profileStore.profiles).toEqual([])
  })

  it('does not mutate target', () => {
    const target = { ...DEFAULT_CONFIG }
    deepMerge(target, { packKey: 'changed' })
    expect(target.packKey).toBe('')
  })

  it('overwrites arrays (lastPlayedPacks)', () => {
    const result = deepMerge(DEFAULT_CONFIG, { lastPlayedPacks: ['pack1', 'pack2'] })
    expect(result.lastPlayedPacks).toEqual(['pack1', 'pack2'])
  })
})

describe('config service: memory detection', () => {
  it('returns 8192 for >= 16 GB', () => {
    expect(detectDefaultMaxMemory(16384)).toBe(8192)
    expect(detectDefaultMaxMemory(32768)).toBe(8192)
  })

  it('returns 6144 for >= 12 GB', () => {
    expect(detectDefaultMaxMemory(12288)).toBe(6144)
    expect(detectDefaultMaxMemory(14000)).toBe(6144)
  })

  it('returns 4096 for >= 8 GB', () => {
    expect(detectDefaultMaxMemory(8192)).toBe(4096)
    expect(detectDefaultMaxMemory(11000)).toBe(4096)
  })

  it('returns 4096 for < 8 GB', () => {
    expect(detectDefaultMaxMemory(4096)).toBe(4096)
    expect(detectDefaultMaxMemory(2048)).toBe(4096)
  })
})
