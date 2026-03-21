import { describe, it, expect } from 'vitest'
import type { FeatureCondition } from '@shared/types'

// ── Pure helper: feature condition evaluation (from install.service logic) ────

function evaluateCondition(condition: FeatureCondition, selectedFeatures: string[]): boolean {
  if (condition.if === 'requireAny') {
    return condition.features.some((f) => selectedFeatures.includes(f))
  }
  if (condition.if === 'requireAll') {
    return condition.features.every((f) => selectedFeatures.includes(f))
  }
  return false
}

function shouldDownloadTask(
  condition: FeatureCondition | undefined,
  selectedFeatures: string[]
): boolean {
  if (!condition) return true
  return evaluateCondition(condition, selectedFeatures)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('feature condition evaluation', () => {
  describe('requireAny', () => {
    it('returns true when at least one feature matches', () => {
      expect(evaluateCondition(
        { if: 'requireAny', features: ['optifine', 'shaders'] },
        ['optifine']
      )).toBe(true)
    })

    it('returns true when all features match', () => {
      expect(evaluateCondition(
        { if: 'requireAny', features: ['optifine', 'shaders'] },
        ['optifine', 'shaders']
      )).toBe(true)
    })

    it('returns false when no features match', () => {
      expect(evaluateCondition(
        { if: 'requireAny', features: ['optifine'] },
        ['shaders']
      )).toBe(false)
    })

    it('returns false with empty selectedFeatures', () => {
      expect(evaluateCondition(
        { if: 'requireAny', features: ['optifine'] },
        []
      )).toBe(false)
    })
  })

  describe('requireAll', () => {
    it('returns true when all features match', () => {
      expect(evaluateCondition(
        { if: 'requireAll', features: ['optifine', 'shaders'] },
        ['optifine', 'shaders', 'extra']
      )).toBe(true)
    })

    it('returns false when only some features match', () => {
      expect(evaluateCondition(
        { if: 'requireAll', features: ['optifine', 'shaders'] },
        ['optifine']
      )).toBe(false)
    })

    it('returns false with empty selectedFeatures', () => {
      expect(evaluateCondition(
        { if: 'requireAll', features: ['optifine'] },
        []
      )).toBe(false)
    })
  })

  describe('shouldDownloadTask', () => {
    it('downloads unconditionally when no condition is set', () => {
      expect(shouldDownloadTask(undefined, [])).toBe(true)
    })

    it('respects condition when present', () => {
      expect(shouldDownloadTask(
        { if: 'requireAny', features: ['optifine'] },
        []
      )).toBe(false)

      expect(shouldDownloadTask(
        { if: 'requireAny', features: ['optifine'] },
        ['optifine']
      )).toBe(true)
    })
  })
})
