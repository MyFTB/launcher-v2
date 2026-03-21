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
    // installForge for 1.7.x constructs: {mc}-{version}-{mc} → 1.7.10-10.13.4.1614-1.7.10 ✓
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
