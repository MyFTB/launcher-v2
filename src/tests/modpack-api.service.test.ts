import { describe, it, expect } from 'vitest'
import type { ModpackManifestReference } from '@shared/types'

// ── Pure helper: the unwrap logic extracted from modpack-api.service ──────────

function unwrapPackList(
  body: { packages?: ModpackManifestReference[] } | ModpackManifestReference[]
): ModpackManifestReference[] {
  return Array.isArray(body)
    ? body
    : (body as { packages?: ModpackManifestReference[] }).packages ?? []
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('modpack-api: pack list response parsing', () => {
  const samplePack: ModpackManifestReference = {
    name: 'testpack',
    title: 'Test Pack',
    version: '1.0.0',
    location: 'testpack.json',
    gameVersion: '1.20.1',
  }

  it('unwraps IndexModel { packages: [...] } correctly', () => {
    const response = { minimumVersion: 1, packages: [samplePack] }
    expect(unwrapPackList(response)).toEqual([samplePack])
  })

  it('passes through a bare array unchanged', () => {
    const response = [samplePack]
    expect(unwrapPackList(response)).toEqual([samplePack])
  })

  it('returns [] when packages key is missing', () => {
    const response = { minimumVersion: 1 }
    expect(unwrapPackList(response)).toEqual([])
  })

  it('returns [] when packages is explicitly undefined', () => {
    const response = { packages: undefined }
    expect(unwrapPackList(response)).toEqual([])
  })

  it('returns [] for an empty packages array', () => {
    const response = { minimumVersion: 1, packages: [] }
    expect(unwrapPackList(response)).toEqual([])
  })

  it('preserves all pack fields', () => {
    const fullPack: ModpackManifestReference = {
      name: 'mypack',
      title: 'My Pack',
      version: '2.1.0',
      location: 'mypack.json',
      gameVersion: '1.21.0',
      logo: 'mypack.png',
    }
    const result = unwrapPackList({ packages: [fullPack] })
    expect(result[0]).toMatchObject(fullPack)
  })
})
