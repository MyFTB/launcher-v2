import { describe, it, expect } from 'vitest'
import type { LauncherProfile, LauncherProfileStore } from '../shared/types'

// ── Pure helpers mirroring the Settings.tsx profile display logic ─────────────

function getActiveProfile(store: LauncherProfileStore): LauncherProfile | undefined {
  return store.profiles.find((p) => p.uuid === store.selectedProfileUuid)
}

function isLoggedIn(store: LauncherProfileStore): boolean {
  return store.profiles.length > 0
}

function playerAvatarUrl(uuid: string): string {
  return `https://mc-heads.net/avatar/${uuid}/32`
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const mockProfile: LauncherProfile = {
  provider: 'microsoft',
  uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  lastKnownUsername: 'TestUser',
  minecraftAccessToken: 'mc-token-abc',
  oauthRefreshToken: 'oauth-refresh-xyz',
}

const mockProfile2: LauncherProfile = {
  provider: 'microsoft',
  uuid: 'ffffffff-0000-1111-2222-333333333333',
  lastKnownUsername: 'SecondUser',
  minecraftAccessToken: 'mc-token-def',
  oauthRefreshToken: 'oauth-refresh-uvw',
}

describe('auth profile state helpers', () => {
  it('isLoggedIn returns false for empty profile store', () => {
    expect(isLoggedIn({ profiles: [], selectedProfileUuid: undefined })).toBe(false)
  })

  it('isLoggedIn returns true when a profile exists', () => {
    expect(isLoggedIn({ profiles: [mockProfile], selectedProfileUuid: mockProfile.uuid })).toBe(true)
  })

  it('getActiveProfile returns undefined for empty store', () => {
    expect(getActiveProfile({ profiles: [], selectedProfileUuid: undefined })).toBeUndefined()
  })

  it('getActiveProfile returns the selected profile', () => {
    const store: LauncherProfileStore = {
      profiles: [mockProfile, mockProfile2],
      selectedProfileUuid: mockProfile.uuid,
    }
    expect(getActiveProfile(store)).toEqual(mockProfile)
  })

  it('getActiveProfile returns undefined when selectedUuid does not match any profile', () => {
    const store: LauncherProfileStore = {
      profiles: [mockProfile],
      selectedProfileUuid: 'nonexistent-uuid',
    }
    expect(getActiveProfile(store)).toBeUndefined()
  })

  it('playerAvatarUrl builds correct avatar URL for a given UUID', () => {
    const url = playerAvatarUrl(mockProfile.uuid)
    expect(url).toBe(`https://mc-heads.net/avatar/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/32`)
    expect(url.startsWith('https://mc-heads.net/avatar/')).toBe(true)
  })
})
