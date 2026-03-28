import { describe, it, expect } from 'vitest'
import type { FileTask } from '@shared/types'

/**
 * Pure extraction of the stale-detection logic from install.service.ts.
 * Given old manifest tasks, current destination paths, and selected features,
 * returns the old tasks that should be deleted (are "stale").
 */
function findStaleTasks(
  oldTasks: FileTask[],
  currentToPaths: Set<string>,
  selectedFeatures: string[],
): FileTask[] {
  const isAutoUpdate = selectedFeatures.length === 0
  const stale: FileTask[] = []
  for (const oldTask of oldTasks) {
    if (isAutoUpdate && oldTask.when) continue
    if (!currentToPaths.has(oldTask.to)) {
      stale.push(oldTask)
    }
  }
  return stale
}

function task(to: string, when?: FileTask['when']): FileTask {
  return { hash: 'abc', location: 'obj/abc', to, userFile: false, when }
}

describe('stale cleanup logic', () => {
  const featureCondition = { if: 'requireAny' as const, features: ['optifine'] }

  describe('auto-update (selectedFeatures is empty)', () => {
    it('skips old tasks that have a when condition', () => {
      const oldTasks = [
        task('mods/optifine.jar', featureCondition),
        task('mods/core.jar'),
      ]
      const currentToPaths = new Set<string>() // none current -> both would be stale

      const stale = findStaleTasks(oldTasks, currentToPaths, [])
      expect(stale).toEqual([task('mods/core.jar')])
    })

    it('marks old tasks without when conditions as stale when not in current', () => {
      const oldTasks = [
        task('mods/old-lib.jar'),
        task('config/old.cfg'),
      ]
      const currentToPaths = new Set(['mods/new-lib.jar'])

      const stale = findStaleTasks(oldTasks, currentToPaths, [])
      expect(stale).toHaveLength(2)
      expect(stale.map((t) => t.to)).toEqual(['mods/old-lib.jar', 'config/old.cfg'])
    })

    it('does not mark tasks still present in current manifest', () => {
      const oldTasks = [task('mods/kept.jar')]
      const currentToPaths = new Set(['mods/kept.jar'])

      const stale = findStaleTasks(oldTasks, currentToPaths, [])
      expect(stale).toHaveLength(0)
    })
  })

  describe('user-initiated install (selectedFeatures has values)', () => {
    it('includes old tasks with when conditions in the stale check', () => {
      const oldTasks = [
        task('mods/optifine.jar', featureCondition),
        task('mods/core.jar'),
      ]
      const currentToPaths = new Set<string>()

      const stale = findStaleTasks(oldTasks, currentToPaths, ['optifine'])
      expect(stale).toHaveLength(2)
      expect(stale.map((t) => t.to)).toContain('mods/optifine.jar')
      expect(stale.map((t) => t.to)).toContain('mods/core.jar')
    })

    it('does not mark current tasks as stale even with when conditions', () => {
      const oldTasks = [
        task('mods/optifine.jar', featureCondition),
      ]
      const currentToPaths = new Set(['mods/optifine.jar'])

      const stale = findStaleTasks(oldTasks, currentToPaths, ['optifine'])
      expect(stale).toHaveLength(0)
    })
  })

  describe('edge cases', () => {
    it('returns empty array when oldTasks is empty', () => {
      const stale = findStaleTasks([], new Set(['mods/a.jar']), [])
      expect(stale).toEqual([])
    })

    it('handles multiple conditional tasks during auto-update', () => {
      const cond1 = { if: 'requireAny' as const, features: ['optifine'] }
      const cond2 = { if: 'requireAll' as const, features: ['shaders', 'hd'] }
      const oldTasks = [
        task('mods/optifine.jar', cond1),
        task('mods/shaders-hd.jar', cond2),
        task('mods/base.jar'),
      ]
      const currentToPaths = new Set<string>()

      const stale = findStaleTasks(oldTasks, currentToPaths, [])
      // Only the unconditional task is stale during auto-update
      expect(stale).toHaveLength(1)
      expect(stale[0].to).toBe('mods/base.jar')
    })
  })
})
