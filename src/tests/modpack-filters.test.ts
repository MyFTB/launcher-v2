import { describe, expect, it } from 'vitest'
import {
  excludeInstalledPacks,
  filterPacksByMinecraftVersion,
  getMinecraftVersionOptions,
  isMinecraftVersionSelectionValid,
  mergeInstalledPacks,
} from '../renderer/src/utils/modpackFilters'

interface TestPack {
  name: string
  gameVersion: string
}

function pack(name: string, gameVersion: string): TestPack {
  return { name, gameVersion }
}

describe('mergeInstalledPacks', () => {
  const installed = {
    name: 'stoneblock4',
    title: 'FTB StoneBlock 4',
    version: 'old-version',
    gameVersion: '1.21.1',
    hasFeatures: false,
  }

  it('keeps a release-era installed pack visible without a local or remote location', () => {
    expect(mergeInstalledPacks([installed], [])).toEqual([installed])
  })

  it('attaches the trusted remote reference when an update is available', () => {
    const remote = {
      name: installed.name,
      title: installed.title,
      version: 'new-version',
      gameVersion: installed.gameVersion,
      location: 'stoneblock4.json',
    }

    expect(mergeInstalledPacks([installed], [remote])).toEqual([{
      ...installed,
      ...remote,
      updateReference: remote,
    }])
  })

  it('fills display metadata without exposing an update for the installed version', () => {
    const remote = {
      name: installed.name,
      title: installed.title,
      version: installed.version,
      gameVersion: installed.gameVersion,
      location: 'stoneblock4.json',
    }

    expect(mergeInstalledPacks([installed], [remote])).toEqual([{ ...installed, ...remote }])
  })
})

describe('excludeInstalledPacks', () => {
  it('excludes packs by exact installed name', () => {
    const remote = [pack('alpha', '1.21.1'), pack('Alpha', '1.20.1'), pack('beta', '1.19.4')]

    expect(excludeInstalledPacks(remote, new Set(['alpha']))).toEqual([
      pack('Alpha', '1.20.1'),
      pack('beta', '1.19.4'),
    ])
  })

  it('keeps duplicate available entries and does not mutate the source array', () => {
    const first = pack('duplicate', '1.21.1')
    const second = pack('duplicate', '1.21.1')
    const remote = Object.freeze([first, second, pack('installed', '1.20.1')])
    const snapshot = [...remote]

    const result = excludeInstalledPacks(remote, new Set(['installed']))

    expect(result).toEqual([first, second])
    expect(result).not.toBe(remote)
    expect(remote).toEqual(snapshot)
  })
})

describe('getMinecraftVersionOptions', () => {
  it('aggregates exact versions and counts displayed entries', () => {
    const packs = [
      pack('one', '1.21.1'),
      pack('two', '1.21.1'),
      pack('three', '1.21'),
      pack('four', '1.21.1'),
    ]

    expect(getMinecraftVersionOptions(packs)).toEqual([
      { value: '1.21.1', count: 3 },
      { value: '1.21', count: 1 },
    ])
  })

  it('sorts versions in deterministic numeric-aware descending order', () => {
    const packs = [
      pack('oldest', '1.7.10'),
      pack('newer', '1.21.2'),
      pack('old', '1.12.2'),
      pack('newest', '1.21.10'),
    ]

    expect(getMinecraftVersionOptions(packs).map((option) => option.value)).toEqual([
      '1.21.10',
      '1.21.2',
      '1.12.2',
      '1.7.10',
    ])
  })

  it('excludes blank versions while preserving exact non-blank strings', () => {
    const packs = [
      pack('empty', ''),
      pack('spaces', '   '),
      pack('exact', ' 1.21.1 '),
    ]

    expect(getMinecraftVersionOptions(packs)).toEqual([
      { value: ' 1.21.1 ', count: 1 },
    ])
  })

  it('counts duplicate pack entries and does not mutate frozen input', () => {
    const packs = Object.freeze([
      Object.freeze(pack('same', '1.20.1')),
      Object.freeze(pack('same', '1.20.1')),
      Object.freeze(pack('other', '1.19.4')),
    ])
    const snapshot = [...packs]

    expect(getMinecraftVersionOptions(packs)).toEqual([
      { value: '1.20.1', count: 2 },
      { value: '1.19.4', count: 1 },
    ])
    expect(packs).toEqual(snapshot)
  })

  it('returns no options for an empty collection', () => {
    expect(getMinecraftVersionOptions([])).toEqual([])
  })
})

describe('filterPacksByMinecraftVersion', () => {
  const packs = [
    pack('exact', '1.21'),
    pack('longer', '1.21.1'),
    pack('blank', ''),
  ]

  it('matches versions exactly without prefix matches', () => {
    expect(filterPacksByMinecraftVersion(packs, '1.21')).toEqual([pack('exact', '1.21')])
  })

  it('returns every entry, including blank versions, when all versions are selected', () => {
    const result = filterPacksByMinecraftVersion(packs, null)

    expect(result).toEqual(packs)
    expect(result).not.toBe(packs)
  })

  it('returns an empty array for an unknown version or empty collection', () => {
    expect(filterPacksByMinecraftVersion(packs, '1.18.2')).toEqual([])
    expect(filterPacksByMinecraftVersion([], '1.21')).toEqual([])
  })
})

describe('isMinecraftVersionSelectionValid', () => {
  const options = [{ value: '1.21.1', count: 2 }]

  it('always treats the all-version selection as valid', () => {
    expect(isMinecraftVersionSelectionValid(null, [])).toBe(true)
  })

  it('rejects stale selections after their final option disappears', () => {
    expect(isMinecraftVersionSelectionValid('1.21.1', options)).toBe(true)
    expect(isMinecraftVersionSelectionValid('1.21.1', [])).toBe(false)
    expect(isMinecraftVersionSelectionValid('1.20.1', options)).toBe(false)
  })
})
