import { describe, it, expect } from 'vitest'

// ── Inline copies of helpers from install.service.ts ─────────────────────────

function extractMavenVersion(libraryName: string): string {
  const parts = libraryName.split(':')
  if (parts.length < 3) {
    throw new Error(`Cannot extract version from Maven coordinate: ${libraryName}`)
  }
  return parts[2]
}

function buildForgeEntry(
  mcversion: string,
  libraryName: string,
): { mcversion: string; version: string } {
  const mavenVersion = extractMavenVersion(libraryName)
  const minor = parseInt(mcversion.split('.')[1] ?? '0', 10)

  if (minor >= 7 && minor <= 8) {
    const prefix = `${mcversion}-`
    const suffix = `-${mcversion}`
    if (mavenVersion.startsWith(prefix) && mavenVersion.endsWith(suffix)) {
      return { mcversion, version: mavenVersion.slice(prefix.length, mavenVersion.length - suffix.length) }
    }
  }

  return { mcversion, version: mavenVersion }
}

interface Library { name: string }

interface FakeManifest {
  versionManifest: { id: string; libraries?: Library[] }
}

function detectModLoader(manifest: FakeManifest): { loader: string; libraryName: string | null } {
  const libraries = manifest.versionManifest.libraries ?? []
  const versionId = manifest.versionManifest.id ?? ''

  for (const lib of libraries) {
    if (lib.name.includes('net.neoforged:neoforge:') || lib.name.includes('net.neoforged:forge:')) {
      return { loader: 'neoforge', libraryName: lib.name }
    }
  }
  for (const lib of libraries) {
    if (lib.name.includes('net.minecraftforge:forge:')) {
      return { loader: 'forge', libraryName: lib.name }
    }
  }

  const idMatch = versionId.match(/^(\d+\.\d+(?:\.\d+)?)-(?:(neoforge)|(forge))-(.+)$/)
  if (idMatch) {
    const [, mcVersion, neoToken, , forgeVersion] = idMatch
    if (neoToken) {
      return { loader: 'neoforge', libraryName: `net.neoforged:neoforge:${forgeVersion}` }
    }
    return { loader: 'forge', libraryName: `net.minecraftforge:forge:${mcVersion}-${forgeVersion}` }
  }

  if (versionId.startsWith('fabric-loader-')) return { loader: 'fabric', libraryName: versionId }
  if (versionId.startsWith('quilt-loader-')) return { loader: 'quilt', libraryName: versionId }

  return { loader: 'vanilla', libraryName: null }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('extractMavenVersion', () => {
  it('extracts version from a standard Forge coordinate', () => {
    expect(extractMavenVersion('net.minecraftforge:forge:1.20.1-47.2.0')).toBe('1.20.1-47.2.0')
  })

  it('extracts version from a NeoForge coordinate', () => {
    expect(extractMavenVersion('net.neoforged:neoforge:21.1.0')).toBe('21.1.0')
  })

  it('throws when coordinate has fewer than 3 parts', () => {
    expect(() => extractMavenVersion('net.minecraftforge:forge')).toThrow(
      'Cannot extract version from Maven coordinate',
    )
  })
})

describe('buildForgeEntry', () => {
  it('modern Forge (1.20.1) — passes version as-is', () => {
    const entry = buildForgeEntry('1.20.1', 'net.minecraftforge:forge:1.20.1-47.2.0')
    expect(entry).toEqual({ mcversion: '1.20.1', version: '1.20.1-47.2.0' })
  })

  it('MC 1.7.10 — strips mcversion prefix+suffix to get bare build number', () => {
    const entry = buildForgeEntry('1.7.10', 'net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10')
    expect(entry).toEqual({ mcversion: '1.7.10', version: '10.13.4.1614' })
  })

  it('MC 1.8.9 — strips mcversion prefix+suffix to get bare build number', () => {
    const entry = buildForgeEntry('1.8.9', 'net.minecraftforge:forge:1.8.9-11.15.1.2318-1.8.9')
    expect(entry).toEqual({ mcversion: '1.8.9', version: '11.15.1.2318' })
  })

  it('MC 1.12.2 — passes version as-is (starts with mcversion, no -mc suffix)', () => {
    const entry = buildForgeEntry('1.12.2', 'net.minecraftforge:forge:1.12.2-14.23.5.2847')
    expect(entry).toEqual({ mcversion: '1.12.2', version: '1.12.2-14.23.5.2847' })
  })
})

describe('detectModLoader', () => {
  // ── Library-based detection ─────────────────────────────────────────────────
  it('detects Forge from net.minecraftforge:forge: library', () => {
    const m = { versionManifest: { id: '1.20.1-forge-47.2.0', libraries: [{ name: 'net.minecraftforge:forge:1.20.1-47.2.0' }] } }
    expect(detectModLoader(m)).toEqual({ loader: 'forge', libraryName: 'net.minecraftforge:forge:1.20.1-47.2.0' })
  })

  it('does NOT mistake net.minecraftforge:accesstransformers for Forge', () => {
    const m = {
      versionManifest: {
        id: '1.20.1-forge-47.2.0',
        libraries: [
          { name: 'net.minecraftforge:accesstransformers:8.0.4' },
          { name: 'net.minecraftforge:eventbus:6.0.5' },
          { name: 'net.minecraftforge:forge:1.20.1-47.2.0' },
        ],
      },
    }
    expect(detectModLoader(m)).toEqual({ loader: 'forge', libraryName: 'net.minecraftforge:forge:1.20.1-47.2.0' })
  })

  it('detects NeoForge (neoforge artifact)', () => {
    const m = { versionManifest: { id: '1.20.1-neoforge-47.1.0', libraries: [{ name: 'net.neoforged:neoforge:47.1.0' }] } }
    expect(detectModLoader(m)).toEqual({ loader: 'neoforge', libraryName: 'net.neoforged:neoforge:47.1.0' })
  })

  it('detects NeoForge (old forge artifact under net.neoforged)', () => {
    const m = { versionManifest: { id: '1.20.1-forge-47.1.0', libraries: [{ name: 'net.neoforged:forge:1.20.1-47.1.0' }] } }
    expect(detectModLoader(m)).toEqual({ loader: 'neoforge', libraryName: 'net.neoforged:forge:1.20.1-47.1.0' })
  })

  it('prefers NeoForge over Forge when both groups appear', () => {
    const m = {
      versionManifest: {
        id: '1.20.1-neoforge-47.2.0',
        libraries: [
          { name: 'net.minecraftforge:forge:1.20.1-47.2.0' },
          { name: 'net.neoforged:neoforge:47.2.0' },
        ],
      },
    }
    expect(detectModLoader(m).loader).toBe('neoforge')
  })

  it('falls back to vanilla when no known loader library is present and ID is plain', () => {
    const m = { versionManifest: { id: '1.20.1', libraries: [{ name: 'net.minecraftforge:accesstransformers:8.0.4' }] } }
    expect(detectModLoader(m)).toEqual({ loader: 'vanilla', libraryName: null })
  })

  // ── Version-ID fallback (libraries absent or empty) ─────────────────────────
  it('detects Forge from version ID when libraries array is absent', () => {
    const m = { versionManifest: { id: '1.20.1-forge-47.4.0' } }
    expect(detectModLoader(m)).toEqual({
      loader: 'forge',
      libraryName: 'net.minecraftforge:forge:1.20.1-47.4.0',
    })
  })

  it('detects Forge from version ID when libraries array is empty', () => {
    const m = { versionManifest: { id: '1.20.1-forge-47.4.0', libraries: [] } }
    expect(detectModLoader(m)).toEqual({
      loader: 'forge',
      libraryName: 'net.minecraftforge:forge:1.20.1-47.4.0',
    })
  })

  it('detects NeoForge from neoforge version ID when libraries are absent', () => {
    const m = { versionManifest: { id: '1.20.1-neoforge-47.1.0' } }
    expect(detectModLoader(m)).toEqual({
      loader: 'neoforge',
      libraryName: 'net.neoforged:neoforge:47.1.0',
    })
  })

  it('synthesised library name for ID-based Forge produces correct buildForgeEntry', () => {
    const m = { versionManifest: { id: '1.20.1-forge-47.4.0' } }
    const { libraryName } = detectModLoader(m)
    // The synthetic name must produce a buildForgeEntry that installForge can use
    const entry = buildForgeEntry('1.20.1', libraryName!)
    expect(entry).toEqual({ mcversion: '1.20.1', version: '1.20.1-47.4.0' })
  })
})
