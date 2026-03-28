import { describe, it, expect } from 'vitest'
import {
  computeMaxMemoryMb,
  buildLandmarks,
  memLabel,
  clampMemory,
  MINECRAFT_MIN_MB,
  RAM_STEP_MB,
} from '../renderer/src/utils/memory-slider'

describe('computeMaxMemoryMb', () => {
  it('returns 16384 when totalRamMb is undefined', () => {
    expect(computeMaxMemoryMb(undefined)).toBe(16384)
  })

  it('returns 16384 when totalRamMb is 0 (falsy)', () => {
    expect(computeMaxMemoryMb(0)).toBe(16384)
  })

  it('caps at 75% of total RAM, floored to nearest 1024', () => {
    // 32768 * 0.75 = 24576 -> floor(24576/1024)*1024 = 24576
    expect(computeMaxMemoryMb(32768)).toBe(24576)
  })

  it('floors partial GB to nearest 1024', () => {
    // 16000 * 0.75 = 12000 -> floor(12000/1024)*1024 = 11264
    expect(computeMaxMemoryMb(16000)).toBe(11264)
  })

  it('never goes below MINECRAFT_MIN_MB', () => {
    // Very low RAM: 512 * 0.75 = 384 -> clamped to 1024
    expect(computeMaxMemoryMb(512)).toBe(MINECRAFT_MIN_MB)
  })

  it('handles typical 16 GB system', () => {
    // 16384 * 0.75 = 12288
    expect(computeMaxMemoryMb(16384)).toBe(12288)
  })
})

describe('buildLandmarks', () => {
  it('always starts with 1024', () => {
    expect(buildLandmarks(8192)[0]).toBe(1024)
  })

  it('always ends with maxMb', () => {
    const lm = buildLandmarks(12288)
    expect(lm[lm.length - 1]).toBe(12288)
  })

  it('includes powers of 2 (in GB) that fit within max', () => {
    // maxMb = 24576 (24 GB). Expect: 1024, 4096, 8192, 16384, 24576
    const lm = buildLandmarks(24576)
    expect(lm).toContain(4096)
    expect(lm).toContain(8192)
    expect(lm).toContain(16384)
  })

  it('does not duplicate maxMb if it equals a power-of-2 landmark', () => {
    // maxMb = 8192 (8 GB). Landmarks: 1024, 4096, 8192
    const lm = buildLandmarks(8192)
    expect(lm).toEqual([1024, 4096, 8192])
  })

  it('handles maxMb equal to MINECRAFT_MIN_MB', () => {
    const lm = buildLandmarks(1024)
    expect(lm).toEqual([1024])
  })
})

describe('memLabel', () => {
  it('shows GB for values >= 1024', () => {
    expect(memLabel(1024)).toBe('1 GB')
    expect(memLabel(4096)).toBe('4 GB')
    expect(memLabel(16384)).toBe('16 GB')
  })

  it('shows MB for values below 1024', () => {
    expect(memLabel(512)).toBe('512 MB')
    expect(memLabel(256)).toBe('256 MB')
  })

  it('shows fractional GB for non-round values', () => {
    expect(memLabel(1536)).toBe('1.5 GB')
  })
})

describe('clampMemory', () => {
  it('clamps value below lo up to lo (rounded to step)', () => {
    expect(clampMemory(256, 1024, 8192)).toBe(1024)
  })

  it('clamps value above hi down to hi (rounded to step)', () => {
    expect(clampMemory(99999, 1024, 8192)).toBe(8192)
  })

  it('rounds to nearest RAM_STEP_MB', () => {
    // 3000 clamped to [1024, 8192] = 3000, then round(3000/1024)*1024 = 3072
    expect(clampMemory(3000, 1024, 8192)).toBe(3072)
  })

  it('value already on step boundary stays unchanged', () => {
    expect(clampMemory(4096, 1024, 8192)).toBe(4096)
  })

  it('uses RAM_STEP_MB for rounding', () => {
    // Verify step size is 1024
    expect(RAM_STEP_MB).toBe(1024)
  })
})
