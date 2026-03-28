import { describe, it, expect } from 'vitest'
import type { ModpackManifestReference } from '@shared/types'

/**
 * Pure extraction of the response-unwrap logic from fetchRemoteReference()
 * in launch.service.ts. The API may return either a flat array or
 * a wrapper object { packages: [...] }.
 */
function resolvePackReference(
  list: ModpackManifestReference[] | { packages?: ModpackManifestReference[] },
  packName: string,
): ModpackManifestReference | null {
  const data = Array.isArray(list) ? list : list.packages ?? []
  return data.find((r) => r.name === packName) ?? null
}

const samplePack: ModpackManifestReference = {
  name: 'skyblock',
  title: 'SkyBlock',
  version: '1.0.0',
  location: 'skyblock/manifest.json',
  gameVersion: '1.20.1',
}

const otherPack: ModpackManifestReference = {
  name: 'creative',
  title: 'Creative Plus',
  version: '2.1.0',
  location: 'creative/manifest.json',
  gameVersion: '1.19.4',
}

describe('fetchRemoteReference response unwrap', () => {
  describe('flat array input', () => {
    it('finds the correct pack by name', () => {
      const result = resolvePackReference([samplePack, otherPack], 'skyblock')
      expect(result).toEqual(samplePack)
    })

    it('returns null when pack is not in the list', () => {
      const result = resolvePackReference([otherPack], 'skyblock')
      expect(result).toBeNull()
    })

    it('returns null for an empty array', () => {
      const result = resolvePackReference([], 'skyblock')
      expect(result).toBeNull()
    })
  })

  describe('wrapped { packages: [...] } input', () => {
    it('finds the correct pack by name', () => {
      const result = resolvePackReference(
        { packages: [samplePack, otherPack] },
        'creative',
      )
      expect(result).toEqual(otherPack)
    })

    it('returns null when pack is not in the list', () => {
      const result = resolvePackReference(
        { packages: [otherPack] },
        'skyblock',
      )
      expect(result).toBeNull()
    })
  })

  describe('edge cases', () => {
    it('returns null when packages is undefined', () => {
      const result = resolvePackReference(
        { packages: undefined },
        'skyblock',
      )
      expect(result).toBeNull()
    })

    it('returns null for empty wrapper object', () => {
      const result = resolvePackReference({} as { packages?: ModpackManifestReference[] }, 'skyblock')
      expect(result).toBeNull()
    })
  })
})
