import { describe, it, expect } from 'vitest'

/**
 * Pure extraction of the config cleanup logic from launch.service.ts
 * handleLaunchDeletePack. Given a config shape and a pack name to delete,
 * returns the partial update object (or null if no changes needed).
 */
function buildDeleteCleanup(
  packConfigs: Record<string, unknown> | undefined,
  lastPlayedPacks: string[] | undefined,
  packName: string,
): { packConfigs?: Record<string, unknown>; lastPlayedPacks?: string[] } | null {
  const updates: { packConfigs?: Record<string, unknown>; lastPlayedPacks?: string[] } = {}

  if (packConfigs?.[packName]) {
    const { [packName]: _removed, ...rest } = packConfigs
    updates.packConfigs = rest
  }

  if (lastPlayedPacks?.includes(packName)) {
    updates.lastPlayedPacks = lastPlayedPacks.filter((n) => n !== packName)
  }

  return Object.keys(updates).length > 0 ? updates : null
}

describe('delete-pack config cleanup', () => {
  describe('lastPlayedPacks', () => {
    it('removes the deleted pack from the list', () => {
      const result = buildDeleteCleanup(undefined, ['alpha', 'beta', 'gamma'], 'beta')
      expect(result).not.toBeNull()
      expect(result!.lastPlayedPacks).toEqual(['alpha', 'gamma'])
    })

    it('handles pack being the only entry', () => {
      const result = buildDeleteCleanup(undefined, ['solo'], 'solo')
      expect(result!.lastPlayedPacks).toEqual([])
    })

    it('handles pack appearing multiple times', () => {
      const result = buildDeleteCleanup(undefined, ['a', 'b', 'a'], 'a')
      expect(result!.lastPlayedPacks).toEqual(['b'])
    })

    it('returns null when pack is not in the list', () => {
      const result = buildDeleteCleanup(undefined, ['alpha', 'beta'], 'gamma')
      expect(result).toBeNull()
    })

    it('returns null when lastPlayedPacks is undefined', () => {
      const result = buildDeleteCleanup(undefined, undefined, 'anything')
      expect(result).toBeNull()
    })

    it('returns null when lastPlayedPacks is empty', () => {
      const result = buildDeleteCleanup(undefined, [], 'anything')
      expect(result).toBeNull()
    })
  })

  describe('packConfigs', () => {
    it('removes the deleted pack config entry', () => {
      const configs = { alpha: { maxMemory: 8192 }, beta: { minMemory: 1024 } }
      const result = buildDeleteCleanup(configs, undefined, 'alpha')
      expect(result).not.toBeNull()
      expect(result!.packConfigs).toEqual({ beta: { minMemory: 1024 } })
      expect('alpha' in result!.packConfigs!).toBe(false)
    })

    it('returns empty object when deleting the only entry', () => {
      const configs = { solo: { maxMemory: 4096 } }
      const result = buildDeleteCleanup(configs, undefined, 'solo')
      expect(result!.packConfigs).toEqual({})
    })

    it('returns null when pack has no config entry', () => {
      const configs = { other: { maxMemory: 4096 } }
      const result = buildDeleteCleanup(configs, undefined, 'notfound')
      expect(result).toBeNull()
    })

    it('returns null when packConfigs is undefined', () => {
      const result = buildDeleteCleanup(undefined, undefined, 'anything')
      expect(result).toBeNull()
    })
  })

  describe('both lastPlayedPacks and packConfigs', () => {
    it('cleans up both when pack exists in both', () => {
      const configs = { target: { maxMemory: 8192 }, other: {} }
      const result = buildDeleteCleanup(configs, ['target', 'other'], 'target')
      expect(result).not.toBeNull()
      expect(result!.packConfigs).toEqual({ other: {} })
      expect(result!.lastPlayedPacks).toEqual(['other'])
    })

    it('returns null when pack exists in neither', () => {
      const configs = { other: {} }
      const result = buildDeleteCleanup(configs, ['other'], 'ghost')
      expect(result).toBeNull()
    })
  })
})
