import { describe, expect, it } from 'vitest'

import { collectStaleManagedTasks } from '../main/services/install.service'
import {
  validateFileTask,
  validateModpackManifest,
  validateModpackReference,
  validatePersistedModpackManifest,
} from '../shared/validation'

const SHA1 = 'a'.repeat(40)
const SHA256 = 'b'.repeat(64)

function baseManifest(): Record<string, unknown> {
  return {
    name: 'Example Pack',
    title: 'Example Pack',
    version: '2026-08-08_12-00-00',
    gameVersion: '1.21.1',
    versionManifest: { id: '1.21.1' },
  }
}

function backendTask(index = 0): Record<string, unknown> {
  return {
    type: 'file',
    size: 42,
    hash: SHA1,
    location: `aa/bb/${SHA1}`,
    to: `mods/backend-${index}.jar`,
  }
}

interface SampledLiveManifestShape {
  location: string
  name: string
  title: string
  gameVersion: string
  runtime?: string
}

const sampledLiveManifestShapes: SampledLiveManifestShape[] = [
  { location: 'atm10.json', name: 'ATM10', title: 'All the Mods 10', gameVersion: '1.21.1', runtime: 'temurin_21' },
  { location: 'stoneblock4.json', name: 'stoneblock4', title: 'FTB StoneBlock 4', gameVersion: '1.21.1', runtime: 'temurin_21' },
  { location: 'vanilla.json', name: 'Vanilla', title: 'Vanilla', gameVersion: '1.21.8', runtime: 'temurin_21' },
  { location: 'stacia2expert.json', name: 'stacia2expert', title: 'Stacia 2 Expert', gameVersion: '1.19.2', runtime: 'temurin_17' },
  { location: 'ftbskies2.json', name: 'FTBSKIES2', title: 'FTB Skies 2', gameVersion: '1.21.1', runtime: 'temurin_21' },
  { location: 'stoneblock2.json', name: 'stoneblock2', title: 'FTB Stoneblock 2', gameVersion: '1.12.2' },
  { location: 'infinity-evolved-reloaded.json', name: 'infinity-evolved-reloaded', title: 'Infinity Evolved: Reloaded', gameVersion: '1.12.2' },
  { location: 'harvestblock.json', name: 'harvestblock', title: 'HarvestBlock', gameVersion: '1.12.2' },
]

describe('MyFTB backend manifest compatibility', () => {
  it('normalizes a null package logo as an omitted optional field', () => {
    const reference = validateModpackReference({
      name: 'ATM10',
      title: 'All the Mods 10',
      version: '1',
      gameVersion: '1.21.1',
      location: 'atm10.json',
      logo: null,
    })

    expect(reference).not.toHaveProperty('logo')
  })

  it.each(sampledLiveManifestShapes)(
    'normalizes the sampled $location shape using its package-list location',
    (sample) => {
      const raw = {
        name: sample.name,
        title: sample.title,
        version: '2026-08-08_12-00-00',
        gameVersion: sample.gameVersion,
        versionManifest: { id: sample.gameVersion },
        launch: { flags: ['-XX:+UseG1GC'] },
        features: sample.runtime
          ? []
          : [{ name: 'Optional Content', description: 'Installs optional content.', default: false }],
        tasks: [backendTask()],
        ...('runtime' in sample ? { runtime: sample.runtime } : {}),
        ...(sample.runtime ? { logo: `https://launcher.myftb.de/images/${sample.location}.png` } : {}),
      }

      const manifest = validateModpackManifest(raw, sample.location)

      expect(manifest.location).toBe(sample.location)
      expect(manifest.tasks).toEqual([{
        hash: SHA1,
        location: `aa/bb/${SHA1}`,
        to: 'mods/backend-0.jar',
        userFile: false,
      }])
    },
  )

  it.each([
    ['revelation.json', 'config/enderio/EnderIO.cfg', 'config/enderio/enderio.cfg'],
    ['stoneblock2.json', 'config/buildcraft/objects.cfg', 'config/Buildcraft/objects.cfg'],
    [
      'multiblockmadness.json',
      'resources/contenttweaker/blockstates/moltenBedrock.json',
      'resources/contenttweaker/blockstates/moltenbedrock.json',
    ],
  ])('accepts case-distinct task destinations from %s', (location, first, second) => {
    const manifest = validateModpackManifest({
      ...baseManifest(),
      tasks: [
        { ...backendTask(1), to: first },
        { ...backendTask(2), to: second },
      ],
    }, location)

    expect(manifest.tasks?.map((task) => task.to)).toEqual([first, second])
  })

  it('normalizes null optional manifest values as omitted', () => {
    const manifest = validateModpackManifest({
      ...baseManifest(),
      logo: null,
      tasks: null,
      features: null,
      launch: null,
      runtime: null,
    }, 'example.json')

    expect(manifest).not.toHaveProperty('logo')
    expect(manifest).not.toHaveProperty('tasks')
    expect(manifest).not.toHaveProperty('features')
    expect(manifest).not.toHaveProperty('launch')
    expect(manifest).not.toHaveProperty('runtime')
  })

  it('defaults omitted or null userFile to false and preserves explicit booleans', () => {
    expect(validateFileTask(backendTask()).userFile).toBe(false)
    expect(validateFileTask({ ...backendTask(), userFile: null }).userFile).toBe(false)
    expect(validateFileTask({ ...backendTask(), userFile: true }).userFile).toBe(true)
    expect(validateFileTask({ ...backendTask(), userFile: false }).userFile).toBe(false)
    expect(() => validateFileTask({ ...backendTask(), userFile: 0 })).toThrow(/userFile/)
  })

  it('uses the trusted package-list location instead of a conflicting manifest field', () => {
    const manifest = validateModpackManifest({
      ...baseManifest(),
      location: 'https://untrusted.example/other.json',
    }, 'catalog/example.json')

    expect(manifest.location).toBe('catalog/example.json')
  })

  it('keeps downloaded manifests strict when no trusted location is supplied', () => {
    expect(() => validateModpackManifest(baseManifest())).toThrow(/Manifest-Pfad/)
  })

  it('loads a release-era persisted manifest without a package-list location', () => {
    const manifest = validatePersistedModpackManifest({
      ...baseManifest(),
      logo: null,
      tasks: [backendTask()],
    })

    expect(manifest).not.toHaveProperty('location')
    expect(manifest).not.toHaveProperty('logo')
    expect(manifest.tasks).toEqual([{
      hash: SHA1,
      location: `aa/bb/${SHA1}`,
      to: 'mods/backend-0.jar',
      userFile: false,
    }])
  })

  it('keeps a valid location already persisted by a newer launcher', () => {
    const manifest = validatePersistedModpackManifest({
      ...baseManifest(),
      location: 'catalog/example.json',
    })
    expect(manifest.location).toBe('catalog/example.json')
  })

  it('does not hide an invalid explicit location behind legacy compatibility', () => {
    expect(() => validatePersistedModpackManifest({
      ...baseManifest(),
      location: '../escape.json',
    })).toThrow(/Manifest-Pfad/)
  })

  it('uses release-era tasks to remove renamed managed mods without removing user files', () => {
    const oldManifest = validatePersistedModpackManifest({
      ...baseManifest(),
      tasks: [
        { ...backendTask(1), to: 'mods/sodium-old.jar' },
        { ...backendTask(2), to: 'mods/user-added.jar', userFile: true },
      ],
    })
    const currentTasks = [{
      hash: SHA1,
      location: `aa/bb/${SHA1}`,
      to: 'mods/sodium-new.jar',
      userFile: false,
    }]

    expect(collectStaleManagedTasks(oldManifest, currentTasks).map((task) => task.to)).toEqual([
      'mods/sodium-old.jar',
    ])
  })

  it('retains manifest, task path, URL, hash, and version-manifest restrictions', () => {
    expect(() => validateModpackManifest(baseManifest(), '../example.json')).toThrow(/Manifest-Pfad/)
    expect(() => validateModpackManifest(baseManifest(), 'https://packs.myftb.de/example.json')).toThrow(/Manifest-Pfad/)
    expect(() => validateFileTask({ ...backendTask(), to: '../escape.jar' })).toThrow(/Zielpfad/)
    expect(() => validateFileTask({
      ...backendTask(),
      hash: SHA256,
      location: 'http://packs.myftb.de/packs/objects/file.jar',
    })).toThrow(/HTTPS/)
    expect(() => validateFileTask({ ...backendTask(), hash: `sha256:${SHA256}` })).toThrow(/Hash/)
    expect(() => validateModpackManifest({
      name: 'Example Pack',
      title: 'Example Pack',
      version: '1',
      gameVersion: '1.21.1',
    }, 'example.json')).toThrow(/Versionsmanifest/)
  })
})
