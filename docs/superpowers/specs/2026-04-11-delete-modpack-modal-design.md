# Delete Modpack Confirmation Modal — Design Spec

**Date:** 2026-04-11
**Status:** Approved

## Problem

Deleting a modpack from "Installierte Modpacks" provides zero user feedback:

- No confirmation dialog before an irreversible, destructive action
- No progress indicator during deletion (large packs = noticeable delay)
- No success or error feedback — the pack silently vanishes from the list
- Error messages from the main process are swallowed (`fs.rm` failures return `false`)

## Approach

Create a `DeleteConfirmModal` component following the existing `MigrationModal` multi-state pattern. The modal transitions through four states:

```
Context menu "Loeschen"
  -> confirm  (pack title, data-loss warning, Cancel / Loeschen buttons)
  -> deleting (red spinner + indeterminate progress bar, no dismiss)
  -> success  (green check, pack title, OK button)
  -> error    (red X, error message from main process, OK button)
```

Additionally fix the main-process handler to surface error messages, clean up `lastPlayedPacks`, and sync the Zustand store after deletion.

---

## Component: `DeleteConfirmModal`

**File:** `src/renderer/src/components/DeleteConfirmModal.tsx`

### Props

| Prop | Type | Purpose |
|------|------|---------|
| `packName` | `string` | Internal pack name (passed to IPC) |
| `packTitle` | `string` | Display title shown in the modal |
| `onDismiss` | `(deleted: boolean) => void` | Called when modal closes. `true` = deleted, `false` = cancelled/error |

### Internal state

```ts
type DeleteState = 'confirm' | 'deleting' | 'success' | 'error'
```

### Behavior

1. **Confirm state:** Trash icon (red tinted circle), pack title in bold, warning text about data loss (worlds, settings, resource packs). Two buttons: "Abbrechen" (`btn-secondary`) and "Loeschen" (`btn-danger`).
2. **Deleting state:** Calls `ipc.launch.deletePack(packName)` (typed client wrapper, NOT `window.electronAPI`). Shows red spinner + indeterminate progress bar (reuses existing `progressBar` keyframe with `bg-red-400`). No buttons — modal cannot be dismissed.
3. **Success state:** Green checkmark icon, "Modpack geloescht" heading, pack title. Single "OK" button (`btn-primary`). Calls `onDismiss(true)`.
4. **Error state:** Red X icon, "Loeschen fehlgeschlagen" heading, error message text from main process. Single "OK" button. Calls `onDismiss(false)`.

### IPC call pattern

```ts
import { ipc } from '../ipc/client'

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
```

### Keyboard and backdrop handling

- **Escape key:** Dismisses modal in `confirm`, `success`, `error` states. Does nothing during `deleting`. Escape calls `onDismiss(false)` in `confirm`/`error`, `onDismiss(true)` in `success`.
- **Backdrop click:** Dismisses in `success` and `error` states (same boolean mapping as Escape). Does nothing in `confirm` (prevents accidental dismiss of destructive action) or `deleting`. The backdrop `onClick` must check `e.target === e.currentTarget` to prevent card-interior clicks from triggering dismiss.
- Pattern: `useEffect` with `keydown` listener, same approach as `ContextMenu.tsx`. Use `useRef` for both `onDismiss` and `state` (same `onCloseRef` pattern from ContextMenu), since the `useEffect([], ...)` registers the listener once and both values change after mount.

### Visual design

- Backdrop: `bg-black/60 backdrop-blur-sm` (matches all existing modals)
- Card: `card` class, `max-w-md`, `p-6`, `animate-slide-up shadow-2xl`
- Icon circles: 56x56px `rounded-full`, red tint (`bg-red-900/30`) for confirm/deleting/error, green tint (`bg-accent/10`) for success
- All text uses semantic tokens (`text-text-primary`, `text-text-secondary`, `text-red-400`)
- Progress bar: `bg-red-400` (not accent green) to reinforce destructive context
- Pack title: add `line-clamp-2` to handle long titles gracefully

---

## Main Process Changes

### `launch.service.ts` — Return structured result instead of boolean

**Current:** Returns `Promise<boolean>` — `true` on success, `false` on failure (error message lost).

**New:** Return `Promise<{ success: boolean; error?: string }>` matching the `configMoveInstances` precedent.

```ts
// Before:
async (_event, payload: LaunchDeletePayload): Promise<boolean> => {
  // ...
  return true / return false
}

// After:
async (_event, payload: LaunchDeletePayload): Promise<{ success: boolean; error?: string }> => {
  // ... on success:
  return { success: true }
  // ... on failure (catch block):
  return { success: false, error: 'Das Modpack konnte nicht geloescht werden.' }
}
```

The catch block should always return a fixed German error string rather than surfacing raw `fs.rm` messages (`EPERM`, `EACCES`) which are not user-friendly. The detailed error is still logged via `logger.error`.

Still throw for the "running pack" case — that's a caller error, not an operation failure. However, change the thrown message to German for UI consistency: `'Das Modpack kann nicht geloescht werden, waehrend es laeuft.'` — since deep-link race conditions can cause this error to surface in the modal's catch block despite the context menu guard.

### `launch.service.ts` — Clean up `lastPlayedPacks`

After successful deletion, also remove the pack from `lastPlayedPacks` in config so the Home page's recent list doesn't show stale entries:

```ts
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
```

---

## IPC Type Changes

### `shared/types.ts`

Update `ElectronAPI.launchDeletePack` return type:

```ts
// Before:
launchDeletePack(packName: string): Promise<boolean>

// After:
launchDeletePack(packName: string): Promise<{ success: boolean; error?: string }>
```

### `preload/index.ts`

Update the bridge to match the new return type (no logic change, just type alignment).

### `renderer/src/ipc/client.ts`

Update `deletePack` wrapper return type to match.

---

## Changes to `InstalledPacks.tsx`

### New state

```ts
const [deleteTarget, setDeleteTarget] = useState<{ name: string; title: string } | null>(null)
```

### Modified `handleDelete`

Opens the modal instead of calling IPC directly:

```ts
const handleDelete = useCallback((packName: string) => {
  const pack = packs.find((p) => p.name === packName)
  setDeleteTarget({ name: packName, title: pack?.title ?? packName })
}, [packs])
```

### New `handleDeleteDismiss`

Requires adding `import { useModpackStore } from '../store/modpack.store'` to the file.

```ts
const handleDeleteDismiss = useCallback(async (deleted: boolean) => {
  if (deleted && deleteTarget) {
    setPacks((prev) => prev.filter((p) => p.name !== deleteTarget.name))
    // Refresh global store's installedPacks so any subscribed component stays current
    await useModpackStore.getState().fetchInstalled()
  }
  setDeleteTarget(null)
}, [deleteTarget])
```

### Context menu: disable "Loeschen" when pack is running

Mark the delete item as disabled when the target pack is the running pack. Note: `runningPack` must be added to the `contextMenuItems` `useMemo` dependency array so the disabled state recomputes if a pack starts running while the menu is open.

### Modal rendering

```tsx
{deleteTarget && (
  <DeleteConfirmModal
    packName={deleteTarget.name}
    packTitle={deleteTarget.title}
    onDismiss={handleDeleteDismiss}
  />
)}
```

---

## Changes to `ContextMenu.tsx`

Add `disabled` and `title` to `ContextMenuItem`:

```ts
interface ContextMenuItem {
  label: string
  action: () => void
  danger?: boolean
  disabled?: boolean
  title?: string
}
```

Disabled items: `opacity-50 cursor-not-allowed`, `title` renders as native tooltip, click does not fire `action()`. Disabled items also suppress hover styles — conditionally omit hover classes when `item.disabled` is true to avoid a visual contradiction (dimmed but brightening on hover).

---

## Files Changed

| File | Change |
|------|--------|
| `src/renderer/src/components/DeleteConfirmModal.tsx` | **New** — multi-state delete confirmation modal |
| `src/renderer/src/components/ContextMenu.tsx` | Add `disabled`/`title` support |
| `src/renderer/src/pages/InstalledPacks.tsx` | Wire modal state, disable delete when running, sync store |
| `src/renderer/src/store/modpack.store.ts` | Update `deletePack` to handle new `{ success, error? }` return type (or remove if now dead code) |
| `src/main/services/launch.service.ts` | Return `{ success, error? }`, clean up `lastPlayedPacks` |
| `src/shared/types.ts` | Update `launchDeletePack` return type |
| `src/preload/index.ts` | Align bridge type |
| `src/renderer/src/ipc/client.ts` | Align wrapper return type |

## Testing

The modal itself is a React component with `useState` — not suitable for the project's pure-TS test approach. No dedicated test file will be added for the modal.

The `lastPlayedPacks` cleanup logic (array filtering + `packConfigs` key removal) is pure config manipulation and **must** be covered by a test in `src/tests/` per the project's standing rule. Add a test file `src/tests/delete-pack-cleanup.test.ts` that validates:
- `lastPlayedPacks` is filtered to remove the deleted pack name
- `packConfigs` entry for the deleted pack is removed
- Config is unchanged when the deleted pack has no entries

The main-process IPC return type change should also be validated via the existing lint + type-check pipeline (`npm run lint && npm run type-check`).
