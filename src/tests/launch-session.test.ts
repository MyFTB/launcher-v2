import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isCompletedLaunchState,
  type LaunchSession,
  type LaunchState,
  type PushChannel,
} from '../shared/types'

function createSession(id: string, state: LaunchState, startedAt: number): LaunchSession {
  return {
    id,
    packName: `pack-${id}`,
    packTitle: `Pack ${id}`,
    state,
    startedAt,
    updatedAt: startedAt,
  }
}

async function createLaunchStore(snapshot: Promise<LaunchSession[]>) {
  const listeners = new Map<PushChannel, (...args: unknown[]) => void>()
  const launchRemoveSession = vi.fn(async (_sessionId: string): Promise<void> => {})

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        launchGetSessions: () => snapshot,
        launchRemoveSession,
        on: (channel: PushChannel, listener: (...args: unknown[]) => void) => {
          listeners.set(channel, listener)
          return () => listeners.delete(channel)
        },
      },
    },
  })

  const { useLaunchStore } = await import('../renderer/src/store/launch.store')
  useLaunchStore.getState().initListeners()

  return {
    emit(channel: PushChannel, payload: unknown): void {
      const listener = listeners.get(channel)
      if (!listener) throw new Error(`Missing listener for ${channel}`)
      listener(payload)
    },
    launchRemoveSession,
    useLaunchStore,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  Reflect.deleteProperty(globalThis, 'window')
})

describe('launch-session completion policy', () => {
  it.each<LaunchState>(['closed', 'crashed'])('allows %s sessions to be removed', (state) => {
    expect(isCompletedLaunchState(state)).toBe(true)
  })

  it.each<LaunchState>(['launching', 'running'])('keeps %s sessions active', (state) => {
    expect(isCompletedLaunchState(state)).toBe(false)
  })
})

describe('launch-store session removal', () => {
  it('removes the selected session, selects the newest remainder, and forwards removal IPC', async () => {
    const store = await createLaunchStore(Promise.resolve([]))
    const older = createSession('older', 'closed', 1)
    const newer = createSession('newer', 'crashed', 2)

    store.emit('launch:state', { session: older })
    store.emit('launch:state', { session: newer })
    store.useLaunchStore.getState().selectSession(older.id)
    store.emit('launch:session-removed', { sessionId: older.id })

    expect(store.useLaunchStore.getState().sessions[older.id]).toBeUndefined()
    expect(store.useLaunchStore.getState().selectedSessionId).toBe(newer.id)

    await store.useLaunchStore.getState().removeSession(newer.id)
    expect(store.launchRemoveSession).toHaveBeenCalledWith(newer.id)
  })

  it('does not resurrect a removed session from a stale snapshot or state event', async () => {
    let resolveSnapshot!: (sessions: LaunchSession[]) => void
    const snapshot = new Promise<LaunchSession[]>((resolve) => { resolveSnapshot = resolve })
    const store = await createLaunchStore(snapshot)
    const removed = createSession('removed', 'closed', 1)

    store.emit('launch:state', { session: removed })
    store.emit('launch:session-removed', { sessionId: removed.id })
    resolveSnapshot([removed])
    await snapshot

    expect(store.useLaunchStore.getState().sessions[removed.id]).toBeUndefined()
    expect(store.useLaunchStore.getState().selectedSessionId).toBeNull()

    store.emit('launch:state', { session: { ...removed, updatedAt: 2 } })
    expect(store.useLaunchStore.getState().sessions[removed.id]).toBeUndefined()
  })
})
