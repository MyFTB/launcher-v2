/**
 * Authentication store — renderer side.
 *
 * Manages the list of launcher profiles, the currently selected profile UUID,
 * and the transient login-flow state.  Push events from the main process
 * ('auth:profiles-updated', 'auth:login-error') are wired in initListeners().
 *
 * Usage:
 *   // App root — call once:
 *   useAuthStore.getState().initListeners()
 *
 *   // In components:
 *   const { loginState, startMicrosoftLogin } = useAuthStore()
 *   const profile = useSelectedProfile()
 *   const loggedIn  = useIsLoggedIn()
 */

import { create } from 'zustand'
import type { LauncherProfile, AuthProfilesUpdatedEvent, AuthLoginErrorEvent } from '@shared/types'
import { ipc, onEvent } from '@renderer/ipc/client'

// ─── State & actions ─────────────────────────────────────────────────────────

type LoginState = 'idle' | 'awaiting-browser' | 'success' | 'error'

interface AuthState {
  profiles: LauncherProfile[]
  selectedUuid: string | undefined
  loginState: LoginState
  loginError: string | null

  // Actions
  startMicrosoftLogin(): Promise<void>
  logout(): Promise<void>
  switchProfile(uuid: string): Promise<void>

  // Internal setter — invoked by push-event listener, not by UI code
  _setProfiles(profiles: LauncherProfile[], selectedUuid: string | undefined): void

  // Call once at app startup to subscribe to push events
  initListeners(): void
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState>()((set) => ({
  profiles: [],
  selectedUuid: undefined,
  loginState: 'idle',
  loginError: null,

  async startMicrosoftLogin() {
    set({ loginState: 'awaiting-browser', loginError: null })
    try {
      await ipc.auth.startMicrosoft()
      // Actual success/failure arrives via push events; we don't set 'success'
      // here because the OAuth round-trip is async and driven from main.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ loginState: 'error', loginError: message })
    }
  },

  async logout() {
    await ipc.auth.logout()
    // Main process will push an 'auth:profiles-updated' event with the new
    // (empty or reduced) profile list.
  },

  async switchProfile(uuid: string) {
    await ipc.auth.switchProfile(uuid)
    // Main process will push 'auth:profiles-updated' with the new selectedUuid.
  },

  _setProfiles(profiles: LauncherProfile[], selectedUuid: string | undefined) {
    set({ profiles, selectedUuid })
  },

  initListeners() {
    // 'auth:profiles-updated' — main pushes the full profile list after any
    // auth state change (login, logout, token refresh, switch).
    onEvent('auth:profiles-updated', (...args: unknown[]) => {
      const event = args[0] as AuthProfilesUpdatedEvent
      useAuthStore
        .getState()
        ._setProfiles(event.profiles, event.selectedUuid)

      // Transition loginState to 'success' if we were waiting for the browser.
      const current = useAuthStore.getState().loginState
      if (current === 'awaiting-browser') {
        set({ loginState: 'success' })
      }
    })

    // 'auth:login-error' — main pushes this when the OAuth flow fails.
    onEvent('auth:login-error', (...args: unknown[]) => {
      const event = args[0] as AuthLoginErrorEvent
      set({ loginState: 'error', loginError: event.error })
    })
  },
}))

// ─── Computed hooks ──────────────────────────────────────────────────────────

/**
 * Returns the currently selected LauncherProfile, or undefined when no
 * profile is selected / the store hasn't loaded yet.
 */
export function useSelectedProfile(): LauncherProfile | undefined {
  return useAuthStore((s) => s.profiles.find((p) => p.uuid === s.selectedUuid))
}

/**
 * Returns true when a profile is selected (i.e. the user is logged in).
 */
export function useIsLoggedIn(): boolean {
  return useAuthStore((s) => s.selectedUuid !== undefined)
}
