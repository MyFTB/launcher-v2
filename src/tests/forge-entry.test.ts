import { describe, expect, it } from 'vitest'

import {
  buildForgeEntry,
  detectModLoader,
  extractMavenVersion,
} from '../main/services/install-helpers'


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

  // ── NeoForge short-form ID (no MC version prefix) ─────────────────────────
  it('detects NeoForge from short-form ID like neoforge-21.1.219', () => {
    const m = { versionManifest: { id: 'neoforge-21.1.219', libraries: [] } }
    expect(detectModLoader(m)).toEqual({
      loader: 'neoforge',
      libraryName: 'net.neoforged:neoforge:21.1.219',
    })
  })

  it('NeoForge short-form synthesises correct Maven coordinate', () => {
    const m = { versionManifest: { id: 'neoforge-21.4.42' } }
    const result = detectModLoader(m)
    expect(result.loader).toBe('neoforge')
    expect(result.libraryName).toBe('net.neoforged:neoforge:21.4.42')
  })

  it('NeoForge short-form without libraries array', () => {
    const m = { versionManifest: { id: 'neoforge-20.6.100' } }
    expect(detectModLoader(m)).toEqual({
      loader: 'neoforge',
      libraryName: 'net.neoforged:neoforge:20.6.100',
    })
  })

  it('detects Fabric and Quilt from their version ID prefixes', () => {
    expect(detectModLoader({ versionManifest: { id: 'fabric-loader-0.16.10-1.21.1' } }))
      .toEqual({ loader: 'fabric', libraryName: 'fabric-loader-0.16.10-1.21.1' })
    expect(detectModLoader({ versionManifest: { id: 'quilt-loader-0.27.1-1.21.1' } }))
      .toEqual({ loader: 'quilt', libraryName: 'quilt-loader-0.27.1-1.21.1' })
  })

  it('falls back to vanilla for an unknown or empty version ID', () => {
    expect(detectModLoader({ versionManifest: { id: '1.21.1' } }))
      .toEqual({ loader: 'vanilla', libraryName: null })
    expect(detectModLoader({ versionManifest: {} }))
      .toEqual({ loader: 'vanilla', libraryName: null })
  })
})
