# Delete Modpack Confirmation Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-state confirmation modal for modpack deletion with progress, success/error feedback, running-pack guard, and lastPlayedPacks cleanup.

**Architecture:** Multi-state modal component (`DeleteConfirmModal`) following the existing `MigrationModal` pattern. The main-process handler returns `{ success, error? }` instead of `boolean`. The `ContextMenu` component gains `disabled`/`title` support. All IPC layers (types → preload → client) stay in sync.

**Tech Stack:** React, Zustand, Electron IPC, Vitest, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-11-delete-modpack-modal-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types.ts` | Modify | Change `launchDeletePack` return type |
| `src/preload/index.ts` | Modify | Align bridge type (no logic change) |
| `src/renderer/src/ipc/client.ts` | Modify | Align wrapper return type + JSDoc |
| `src/main/services/launch.service.ts` | Modify | Return `{ success, error? }`, cleanup lastPlayedPacks, German error |
| `src/tests/delete-pack-cleanup.test.ts` | Create | Test lastPlayedPacks + packConfigs cleanup logic |
| `src/renderer/src/components/ContextMenu.tsx` | Modify | Add `disabled`/`title` support to menu items |
| `src/renderer/src/components/DeleteConfirmModal.tsx` | Create | Multi-state delete confirmation modal |
| `src/renderer/src/pages/InstalledPacks.tsx` | Modify | Wire modal, disable delete when running, sync store |
| `src/renderer/src/store/modpack.store.ts` | Modify | Update `deletePack` to handle new return type |

---

### Task 1: Update IPC return type across the type chain

**Files:**
- Modify: `src/shared/types.ts:265`
- Modify: `src/preload/index.ts:35`
- Modify: `src/renderer/src/ipc/client.ts:121-123`

- [ ] **Step 1: Update `ElectronAPI.launchDeletePack` return type in shared types**

In `src/shared/types.ts`, change line 265:

```ts
// Before:
launchDeletePack(packName: string): Promise<boolean>

// After:
launchDeletePack(packName: string): Promise<{ success: boolean; error?: string }>
```

- [ ] **Step 2: Update the preload bridge type**

In `src/preload/index.ts`, no code change is needed — the bridge at line 35 already returns whatever `ipcRenderer.invoke` returns, and the type is inferred from the `ElectronAPI` interface. TypeScript will pick up the new return type automatically.

Verify by reading line 35:
```ts
launchDeletePack: (packName) => ipcRenderer.invoke('launch:delete-pack', { packName }),
```

This line satisfies the updated `ElectronAPI` interface without modification.

- [ ] **Step 3: Update the IPC client wrapper return type and JSDoc**

In `src/renderer/src/ipc/client.ts`, change lines 121-123:

```ts
// Before:
/** Delete an installed modpack; resolves true when the directory is gone. */
deletePack(packName: string): Promise<boolean> {
  return window.electronAPI.launchDeletePack(packName)
}

// After:
/** Delete an installed modpack and its config entries. */
deletePack(packName: string): Promise<{ success: boolean; error?: string }> {
  return window.electronAPI.launchDeletePack(packName)
}
```

- [ ] **Step 4: Run type-check to verify the chain compiles**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.json`

Expected: Type errors in `launch.service.ts` (still returns `boolean`), `InstalledPacks.tsx` (reads result as `boolean`), and `modpack.store.ts` (calls without handling new shape). These will be fixed in later tasks.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/renderer/src/ipc/client.ts
git commit -m "refactor: change launchDeletePack return type to { success, error? }

Updates the ElectronAPI interface and IPC client wrapper. The preload
bridge infers the new type from the interface automatically.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Update main-process handler

**Files:**
- Modify: `src/main/services/launch.service.ts:523-554`

- [ ] **Step 1: Rewrite `handleLaunchDeletePack` handler**

Replace the entire handler body at lines 525-553 in `src/main/services/launch.service.ts`:

```ts
private handleLaunchDeletePack(): void {
  ipcMain.handle(
    IpcChannels.LAUNCH_DELETE_PACK,
    async (_event, payload: LaunchDeletePayload): Promise<{ success: boolean; error?: string }> => {
      if (this.isRunning && this.currentPackName === payload.packName) {
        throw new Error('Das Modpack kann nicht geloescht werden, waehrend es laeuft.')
      }

      const instanceDir = await this.resolveInstanceDir(payload.packName)

      try {
        await fs.rm(instanceDir, { recursive: true, force: true })

        // Remove per-pack config and lastPlayedPacks entry
        const cfg = configService.get()
        const updates: Partial<LauncherConfig> = {}

        if (cfg.packConfigs?.[payload.packName]) {
          const { [payload.packName]: _removed, ...rest } = cfg.packConfigs
          updates.packConfigs = rest
        }

        if (cfg.lastPlayedPacks?.includes(payload.packName)) {
          updates.lastPlayedPacks = cfg.lastPlayedPacks.filter((n) => n !== payload.packName)
        }

        if (Object.keys(updates).length > 0) {
          configService.merge(updates)
          await configService.save()
        }

        logger.info(`[LaunchService] Pack deleted: "${payload.packName}"`)
        return { success: true }
      } catch (err) {
        logger.error(`[LaunchService] Failed to delete pack "${payload.packName}":`, err)
        return { success: false, error: 'Das Modpack konnte nicht geloescht werden.' }
      }
    },
  )
}
```

Note: You must add `LauncherConfig` to the import from `@shared/types` at the top of the file if it is not already imported.

- [ ] **Step 2: Verify the import for `LauncherConfig`**

Check the imports at the top of `launch.service.ts`. If `LauncherConfig` is not already imported from `@shared/types`, add it:

```ts
import type { LauncherConfig } from '@shared/types'
```

It may already be imported (the file uses `configService` which deals with `LauncherConfig`). Verify by searching the imports section.

- [ ] **Step 3: Run type-check on main process**

Run: `npx tsc --noEmit -p tsconfig.node.json`

Expected: This should now pass for `launch.service.ts`. Renderer errors remain (fixed in later tasks).

- [ ] **Step 4: Commit**

```bash
git add src/main/services/launch.service.ts
git commit -m "feat: return structured result from delete-pack handler

Return { success, error? } instead of boolean so the renderer can
display meaningful error feedback. Also cleans up lastPlayedPacks
and packConfigs entries on successful deletion. Thrown error for
running-pack guard is now in German for UI consistency.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Test lastPlayedPacks cleanup logic

**Files:**
- Create: `src/tests/delete-pack-cleanup.test.ts`

The cleanup logic in the handler uses pure data operations (array filter + object destructure). Extract and test that logic.

- [ ] **Step 1: Write the test file**

Create `src/tests/delete-pack-cleanup.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

/**
 * Pure extraction of the config cleanup logic from launch.service.ts
 * handleLaunchDeletePack. Given a config shape and a pack name to delete,
 * returns the partial update object (or null if no changes needed).
 */
function buildDeleteCleanup(
  packConfigs: Record<string, unknown> | undefined,
  lastPlayedPacks: string[] | undefined,
  packName: string,
): { packConfigs?: Record<string, unknown>; lastPlayedPacks?: string[] } | null {
  const updates: { packConfigs?: Record<string, unknown>; lastPlayedPacks?: string[] } = {}

  if (packConfigs?.[packName]) {
    const { [packName]: _removed, ...rest } = packConfigs
    updates.packConfigs = rest
  }

  if (lastPlayedPacks?.includes(packName)) {
    updates.lastPlayedPacks = lastPlayedPacks.filter((n) => n !== packName)
  }

  return Object.keys(updates).length > 0 ? updates : null
}

describe('delete-pack config cleanup', () => {
  describe('lastPlayedPacks', () => {
    it('removes the deleted pack from the list', () => {
      const result = buildDeleteCleanup(undefined, ['alpha', 'beta', 'gamma'], 'beta')
      expect(result).not.toBeNull()
      expect(result!.lastPlayedPacks).toEqual(['alpha', 'gamma'])
    })

    it('handles pack being the only entry', () => {
      const result = buildDeleteCleanup(undefined, ['solo'], 'solo')
      expect(result!.lastPlayedPacks).toEqual([])
    })

    it('handles pack appearing multiple times', () => {
      const result = buildDeleteCleanup(undefined, ['a', 'b', 'a'], 'a')
      expect(result!.lastPlayedPacks).toEqual(['b'])
    })

    it('returns null when pack is not in the list', () => {
      const result = buildDeleteCleanup(undefined, ['alpha', 'beta'], 'gamma')
      expect(result).toBeNull()
    })

    it('returns null when lastPlayedPacks is undefined', () => {
      const result = buildDeleteCleanup(undefined, undefined, 'anything')
      expect(result).toBeNull()
    })

    it('returns null when lastPlayedPacks is empty', () => {
      const result = buildDeleteCleanup(undefined, [], 'anything')
      expect(result).toBeNull()
    })
  })

  describe('packConfigs', () => {
    it('removes the deleted pack config entry', () => {
      const configs = { alpha: { maxMemory: 8192 }, beta: { minMemory: 1024 } }
      const result = buildDeleteCleanup(configs, undefined, 'alpha')
      expect(result).not.toBeNull()
      expect(result!.packConfigs).toEqual({ beta: { minMemory: 1024 } })
      expect('alpha' in result!.packConfigs!).toBe(false)
    })

    it('returns empty object when deleting the only entry', () => {
      const configs = { solo: { maxMemory: 4096 } }
      const result = buildDeleteCleanup(configs, undefined, 'solo')
      expect(result!.packConfigs).toEqual({})
    })

    it('returns null when pack has no config entry', () => {
      const configs = { other: { maxMemory: 4096 } }
      const result = buildDeleteCleanup(configs, undefined, 'notfound')
      expect(result).toBeNull()
    })

    it('returns null when packConfigs is undefined', () => {
      const result = buildDeleteCleanup(undefined, undefined, 'anything')
      expect(result).toBeNull()
    })
  })

  describe('both lastPlayedPacks and packConfigs', () => {
    it('cleans up both when pack exists in both', () => {
      const configs = { target: { maxMemory: 8192 }, other: {} }
      const result = buildDeleteCleanup(configs, ['target', 'other'], 'target')
      expect(result).not.toBeNull()
      expect(result!.packConfigs).toEqual({ other: {} })
      expect(result!.lastPlayedPacks).toEqual(['other'])
    })

    it('returns null when pack exists in neither', () => {
      const configs = { other: {} }
      const result = buildDeleteCleanup(configs, ['other'], 'ghost')
      expect(result).toBeNull()
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/tests/delete-pack-cleanup.test.ts`

Expected: All tests pass (the logic is pure functions, no Electron deps).

- [ ] **Step 3: Commit**

```bash
git add src/tests/delete-pack-cleanup.test.ts
git commit -m "test: add delete-pack config cleanup tests

Covers lastPlayedPacks filtering and packConfigs key removal logic
extracted from the launch.service.ts delete handler.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Add disabled/title support to ContextMenu

**Files:**
- Modify: `src/renderer/src/components/ContextMenu.tsx:3-7, 50-63`

- [ ] **Step 1: Update the `ContextMenuItem` interface**

In `src/renderer/src/components/ContextMenu.tsx`, change the interface at lines 3-7:

```ts
// Before:
interface ContextMenuItem {
  label: string
  action: () => void
  danger?: boolean
}

// After:
interface ContextMenuItem {
  label: string
  action: () => void
  danger?: boolean
  disabled?: boolean
  title?: string
}
```

- [ ] **Step 2: Update the button rendering to support disabled state**

Replace the `{items.map(...)}` block at lines 50-63:

```tsx
{items.map((item, index) => (
  <button
    key={index}
    className={`w-full text-left px-4 py-2 text-sm transition-[background-color,color,transform] duration-150 ${
      item.disabled
        ? 'opacity-50 cursor-not-allowed'
        : 'hover:bg-bg-overlay active:scale-[0.98]'
    } ${
      item.danger ? 'text-red-400' + (item.disabled ? '' : ' hover:text-red-300') : 'text-text-primary'
    }`}
    title={item.title}
    onClick={() => {
      if (item.disabled) return
      item.action()
      onClose()
    }}
  >
    {item.label}
  </button>
))}
```

Key changes:
- Disabled items get `opacity-50 cursor-not-allowed` instead of hover/active styles
- Hover color changes are suppressed when disabled (avoids visual contradiction)
- `onClick` early-returns when disabled
- `title` renders as native tooltip (useful for explaining why item is disabled)

- [ ] **Step 3: Run type-check**

Run: `npx tsc --noEmit -p tsconfig.json`

Expected: ContextMenu compiles. Renderer errors in InstalledPacks.tsx and modpack.store.ts remain.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ContextMenu.tsx
git commit -m "feat: add disabled and title support to ContextMenu items

Disabled items show reduced opacity, suppress hover styles, and
block click handlers. Title renders as a native tooltip.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Create DeleteConfirmModal component

**Files:**
- Create: `src/renderer/src/components/DeleteConfirmModal.tsx`

- [ ] **Step 1: Create the modal component**

Create `src/renderer/src/components/DeleteConfirmModal.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { ipc } from '../ipc/client'

type DeleteState = 'confirm' | 'deleting' | 'success' | 'error'

interface DeleteConfirmModalProps {
  packName: string
  packTitle: string
  onDismiss: (deleted: boolean) => void
}

export default function DeleteConfirmModal({ packName, packTitle, onDismiss }: DeleteConfirmModalProps) {
  const [state, setState] = useState<DeleteState>('confirm')
  const [errorMsg, setErrorMsg] = useState('')

  // Refs to avoid stale closures in the keydown listener (registered once via [])
  const stateRef = useRef(state)
  const onDismissRef = useRef(onDismiss)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { onDismissRef.current = onDismiss }, [onDismiss])

  // Keyboard handler: Escape dismisses in confirm/success/error, not during deleting
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      const s = stateRef.current
      if (s === 'deleting') return
      onDismissRef.current(s === 'success')
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleDelete = useCallback(async () => {
    setState('deleting')
    try {
      const result = await ipc.launch.deletePack(packName)
      if (result.success) {
        setState('success')
      } else {
        setErrorMsg(result.error ?? 'Das Modpack konnte nicht geloescht werden.')
        setState('error')
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unbekannter Fehler')
      setState('error')
    }
  }, [packName])

  // Backdrop click: dismiss in success/error only (not confirm or deleting)
  const handleBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (state === 'success') onDismiss(true)
    else if (state === 'error') onDismiss(false)
  }, [state, onDismiss])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={handleBackdropClick}
    >
      <div className="card w-full max-w-md mx-4 p-6 animate-slide-up shadow-2xl">
        {state === 'confirm' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-14 h-14 rounded-full bg-red-900/30 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-8 h-8 text-red-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-lg font-semibold text-text-primary">Modpack loeschen</h2>
              <p className="text-sm text-text-secondary mt-2 line-clamp-2">
                <span className="font-medium text-text-primary">{packTitle}</span>
              </p>
              <p className="text-sm text-text-secondary mt-2">
                Alle Welten, Einstellungen und Ressourcenpakete werden unwiderruflich geloescht.
              </p>
            </div>
            <div className="flex gap-3 mt-2">
              <button className="btn-secondary px-6" onClick={() => onDismiss(false)}>
                Abbrechen
              </button>
              <button className="btn-danger px-6" onClick={handleDelete}>
                Loeschen
              </button>
            </div>
          </div>
        )}

        {state === 'deleting' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-14 h-14 rounded-full bg-red-900/30 flex items-center justify-center">
              <span className="inline-block w-7 h-7 border-[3px] border-red-400 border-t-transparent rounded-full animate-spin" />
            </div>
            <div className="text-center">
              <h2 className="text-lg font-semibold text-text-primary">Wird geloescht...</h2>
              <p className="text-sm text-text-secondary mt-1 line-clamp-2">{packTitle}</p>
            </div>
            <div className="w-full">
              <div className="relative w-full h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                <div className="absolute h-full w-2/5 bg-red-400 rounded-full animate-[progressBar_1.5s_ease-in-out_infinite]" />
              </div>
            </div>
          </div>
        )}

        {state === 'success' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-8 h-8 text-accent">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-lg font-semibold text-text-primary">Modpack geloescht</h2>
              <p className="text-sm text-text-secondary mt-1 line-clamp-2">{packTitle}</p>
            </div>
            <button className="btn-primary mt-2 px-8" onClick={() => onDismiss(true)}>
              OK
            </button>
          </div>
        )}

        {state === 'error' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-14 h-14 rounded-full bg-red-900/30 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-8 h-8 text-red-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-lg font-semibold text-text-primary">Loeschen fehlgeschlagen</h2>
              <p className="text-sm text-red-400 mt-1">{errorMsg}</p>
            </div>
            <button className="btn-primary mt-2 px-8" onClick={() => onDismiss(false)}>
              OK
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify the component compiles**

Run: `npx tsc --noEmit -p tsconfig.json`

Expected: `DeleteConfirmModal.tsx` compiles. Errors in `InstalledPacks.tsx` and `modpack.store.ts` remain.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/DeleteConfirmModal.tsx
git commit -m "feat: create DeleteConfirmModal component

Multi-state modal (confirm/deleting/success/error) following the
MigrationModal pattern. Supports Escape key and backdrop click
with state-appropriate dismiss behavior.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Wire modal into InstalledPacks.tsx

**Files:**
- Modify: `src/renderer/src/pages/InstalledPacks.tsx`

- [ ] **Step 1: Add imports**

Add these imports at the top of `InstalledPacks.tsx` (after the existing imports):

```ts
import DeleteConfirmModal from '../components/DeleteConfirmModal'
import { useModpackStore } from '../store/modpack.store'
```

- [ ] **Step 2: Add deleteTarget state**

After line 27 (`const uploadTimeoutRef = ...`), add:

```ts
const [deleteTarget, setDeleteTarget] = useState<{ name: string; title: string } | null>(null)
```

- [ ] **Step 3: Replace handleDelete**

Replace the existing `handleDelete` callback at lines 164-169:

```ts
// Before:
const handleDelete = useCallback(async (packName: string) => {
  const ok = await window.electronAPI.launchDeletePack(packName)
  if (ok) {
    setPacks((prev) => prev.filter((p) => p.name !== packName))
  }
}, [])

// After:
const handleDelete = useCallback((packName: string) => {
  const pack = packs.find((p) => p.name === packName)
  setDeleteTarget({ name: packName, title: pack?.title ?? packName })
}, [packs])
```

- [ ] **Step 4: Add handleDeleteDismiss callback**

Add this right after `handleDelete`:

```ts
const handleDeleteDismiss = useCallback(async (deleted: boolean) => {
  if (deleted && deleteTarget) {
    setPacks((prev) => prev.filter((p) => p.name !== deleteTarget.name))
    await useModpackStore.getState().fetchInstalled()
  }
  setDeleteTarget(null)
}, [deleteTarget])
```

- [ ] **Step 5: Update context menu items — disable delete when pack is running**

In the `contextMenuItems` useMemo, change the "Loeschen" entry (currently the last item):

```ts
// Before:
{
  label: 'Löschen',
  danger: true,
  action: () => handleDelete(packName),
},

// After:
{
  label: 'Löschen',
  danger: true,
  disabled: runningPack === packName,
  title: runningPack === packName ? 'Modpack laeuft gerade' : undefined,
  action: () => handleDelete(packName),
},
```

Also update the `useMemo` dependency array to include `runningPack`:

```ts
// Before:
}, [contextMenu?.packName, packs, updateMap, handleUpdate, handleUploadCrash, handleDelete])

// After:
}, [contextMenu?.packName, packs, updateMap, runningPack, handleUpdate, handleUploadCrash, handleDelete])
```

- [ ] **Step 6: Add modal rendering**

Add the modal rendering before the closing `</div>` of the return statement, after the FeatureModal block (after line 366):

```tsx
{/* Delete confirmation modal */}
{deleteTarget && (
  <DeleteConfirmModal
    packName={deleteTarget.name}
    packTitle={deleteTarget.title}
    onDismiss={handleDeleteDismiss}
  />
)}
```

- [ ] **Step 7: Run type-check**

Run: `npx tsc --noEmit -p tsconfig.json`

Expected: `InstalledPacks.tsx` compiles. Only `modpack.store.ts` may still have an error.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/pages/InstalledPacks.tsx
git commit -m "feat: wire DeleteConfirmModal into InstalledPacks

Opens the modal on delete instead of calling IPC directly. Disables
the context menu delete option when the pack is running. Refreshes
the store after successful deletion.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Update modpack.store.ts deletePack

**Files:**
- Modify: `src/renderer/src/store/modpack.store.ts:134-138`

The `deletePack` method is called from the store interface and may be used by other components. Update it to handle the new return type.

- [ ] **Step 1: Update deletePack to handle new return type**

Replace lines 134-138:

```ts
// Before:
async deletePack(packName: string) {
  await ipc.launch.deletePack(packName)
  // Refresh installed list after deletion.
  await get().fetchInstalled()
},

// After:
async deletePack(packName: string) {
  const result = await ipc.launch.deletePack(packName)
  if (result.success) {
    await get().fetchInstalled()
  }
},
```

- [ ] **Step 2: Run full type-check**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.json`

Expected: No type errors in any file.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/modpack.store.ts
git commit -m "refactor: update store deletePack for new return type

Only refresh installed list when deletion was successful.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Final validation

- [ ] **Step 1: Run lint**

Run: `npm run lint`

Expected: 0 errors, 0 warnings.

- [ ] **Step 2: Run type-check**

Run: `npm run type-check`

Expected: No errors.

- [ ] **Step 3: Run all tests**

Run: `npm run test`

Expected: All tests pass, including the new `delete-pack-cleanup.test.ts`.

- [ ] **Step 4: Fix any issues found**

If lint or type-check surface issues, fix them and re-run until clean.

- [ ] **Step 5: Final commit (if needed)**

Only commit if fixes were needed in step 4.
