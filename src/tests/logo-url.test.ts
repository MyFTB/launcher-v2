import { describe, it, expect } from 'vitest'

// ── Pure helper: validate that a logo URL is safe to use as <img src> ─────────
//
// The IPC proxy (packsGetLogo) always returns a data: URI or null.
// A raw https:// URL must never reach <img src> because:
//  1. It violates the CSP img-src directive (only 'self' data: crafatar.com allowed)
//  2. It bypasses the main-process caching layer
//
// This mirrors the invariant enforced in ModpackCard.tsx and Home.tsx:
// logoUrl state is initialised to null and only set from packsGetLogo's return value.

function isSafeLogoUrl(url: string | null): boolean {
  if (url === null) return true          // null → show placeholder, fine
  return url.startsWith('data:image/')   // only data URIs are allowed as img src
}

// ── Pure helper: pick the correct fetch URL for a pack logo ───────────────────
//
// Mirrors the logic in modpack-api.service.ts handleGetLogo.
// Matches the old Java launcher's ModpackManifest.saveModpackLogo():
//   - logo present → use logo directly (it IS a full URL)
//   - logo absent  → https://launcher.myftb.de/images/<location>.png

const PACK_LOGO_IMAGE = 'https://launcher.myftb.de/images/%s'

function buildLogoFetchUrl(location: string, logo?: string): string {
  if (logo) return logo
  return PACK_LOGO_IMAGE.replace('%s', `${location.replace(/\.[^/.]+$/, '')}.png`)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('logo URL safety', () => {
  it('accepts null (show placeholder)', () => {
    expect(isSafeLogoUrl(null)).toBe(true)
  })

  it('accepts a data: URI returned by the IPC proxy', () => {
    expect(isSafeLogoUrl('data:image/png;base64,abc123==')).toBe(true)
  })

  it('rejects a raw https:// URL (would violate CSP)', () => {
    expect(isSafeLogoUrl('https://packs.myftb.de/packs/objects/58/bd/58bdd10de540315edd708ab43bc725c2b5ac1351')).toBe(false)
  })

  it('rejects a relative path', () => {
    expect(isSafeLogoUrl('logo.png')).toBe(false)
  })

  it('rejects a hash-only value from the manifest logo field', () => {
    expect(isSafeLogoUrl('58bdd10de540315edd708ab43bc725c2b5ac1351')).toBe(false)
  })
})

describe('buildLogoFetchUrl', () => {
  it('uses logo field directly when present (it is already a full URL)', () => {
    const logo = 'https://packs.myftb.de/packs/objects/58/bd/58bdd10de540315edd708ab43bc725c2b5ac1351'
    expect(buildLogoFetchUrl('direwolf-1-12.json', logo)).toBe(logo)
  })

  it('falls back to launcher.myftb.de/images when logo is absent', () => {
    expect(buildLogoFetchUrl('direwolf-1-12.json', undefined))
      .toBe('https://launcher.myftb.de/images/direwolf-1-12.png')
  })

  it('strips .json extension in fallback', () => {
    expect(buildLogoFetchUrl('somepack.json'))
      .toBe('https://launcher.myftb.de/images/somepack.png')
  })
})
