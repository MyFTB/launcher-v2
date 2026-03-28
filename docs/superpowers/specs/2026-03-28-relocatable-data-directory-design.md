# Relocatable Data Directory

**Date:** 2026-03-28
**Status:** Approved

## Problem

The launcher stores all application data (config, logs, runtimes, image cache, modpack instances) in Electron's default `userData` path (`%APPDATA%/myftb-launcher` on Windows). Users cannot choose where this data lives. This is a problem for users who want data on a specific drive (e.g., larger SSD, separate partition, or organizational preference).

The existing `installationDir` config only controls where modpack instances go -- config, logs, JRE runtimes, and image cache remain locked to the default OS path.

## Goal

Allow users to relocate ALL launcher data to a directory of their choice via the Settings page. On change, data is migrated automatically and the launcher restarts.

## Design

### Bootstrap: Pointer File

A tiny JSON file at a fixed, platform-specific OS path tells the launcher where its data lives. This file is read synchronously before `app.whenReady()` so `app.setPath('userData', ...)` can be called in time.

**Pointer file locations:**

| Platform | Path |
|----------|------|
| Windows  | `%LOCALAPPDATA%\MyFTB Launcher\datadir.json` |
| macOS    | `~/Library/Application Support/MyFTB Launcher Bootstrap/datadir.json` |
| Linux    | `~/.local/share/MyFTB Launcher Bootstrap/datadir.json` |

**File format:**

```json
{ "dataDir": "D:\\Games\\MyFTB" }
```

**Bootstrap logic (pseudocode):**

```
const bootstrapDir = platform-specific path (see table above)
const pointerPath = join(bootstrapDir, 'datadir.json')

try:
  content = fs.readFileSync(pointerPath, 'utf8')
  parsed = JSON.parse(content)
  if parsed.dataDir is a non-empty string:
    app.setPath('userData', parsed.dataDir)
catch:
  // File missing or invalid -- use Electron default
  // No action needed
```

This runs in the module scope of `index.ts`, before any async code.

### Settings UI

A new "Data Directory" section in the Settings page, placed near the top (above the existing installation directory section):

- **Label:** "Speicherort" (or "Data Directory")
- **Display:** Shows the current `app.getPath('userData')` path
- **Button:** "Aendern..." opens a native directory picker
- **On confirm:** Triggers migration flow (see below)

### Migration Flow

When the user selects a new data directory:

1. **Validate** the target directory:
   - Must be writable (try creating a temp file)
   - Must not be inside the current data directory (circular)
   - Must not be the same as the current directory
   - If non-empty, warn the user and ask for confirmation

2. **Write pointer file:** Write `datadir.json` to the bootstrap location with the new path.

3. **Copy data:** Recursively copy the entire current `userData` directory to the new location:
   - `config.json`
   - `logs/`
   - `runtimes/`
   - `cache/`
   - `instances/` (only if `installationDir` is empty, meaning instances live inside userData)

4. **Update config if needed:** If `installationDir` in config is empty (meaning instances default to `{userData}/instances`), it stays empty -- the new userData path will naturally resolve to `{newPath}/instances`. No config change needed.

   If `installationDir` explicitly pointed to the OLD `{userData}/instances` path, update it to be empty (so it falls back to the new default).

5. **Show restart dialog:** "Data directory changed. The launcher will restart to apply changes."

6. **Restart:** Call `app.relaunch()` then `app.quit()`.

7. **Cleanup (post-restart):** On next boot, after confirming the new location works, the old data directory can be left as-is. A future enhancement could offer to delete it, but this is out of scope.

### IPC Contract

**New channel:** `config:change-data-dir`

```typescript
// Renderer -> Main
IpcChannels.CONFIG_CHANGE_DATA_DIR = 'config:change-data-dir'

// ElectronAPI
configChangeDataDir(): Promise<{ success: boolean; error?: string }>
```

The handler:
1. Opens a directory picker dialog
2. Validates the selection
3. Performs migration
4. Writes pointer file
5. Returns success/error to renderer
6. If successful, triggers restart after a short delay (giving the renderer time to show feedback)

### Error Handling

| Scenario | Behavior |
|----------|----------|
| Pointer file missing/corrupt | Use Electron default -- silent fallback |
| Target dir not writable | Return error to renderer, show message |
| Copy fails mid-migration | Revert pointer file to old path, return error |
| Target dir is same as current | Return error "Already using this directory" |
| Disk full during copy | Revert pointer file, clean up partial copy, return error |

### Files Changed

| File | Change |
|------|--------|
| `src/main/index.ts` | Add bootstrap pointer-file read before `app.whenReady()` |
| `src/main/services/config.service.ts` | Add `migrateDataDir(newPath)` method |
| `src/main/ipc/channels.ts` | Add `CONFIG_CHANGE_DATA_DIR` channel constant |
| `src/main/ipc/router.ts` | Add handler: open picker, validate, migrate, restart |
| `src/shared/types.ts` | Add `configChangeDataDir()` to `ElectronAPI` interface |
| `src/preload/index.ts` | Expose `configChangeDataDir` via contextBridge |
| `src/renderer/src/pages/Settings.tsx` | Add data directory display + change button |
| `src/renderer/src/ipc/client.ts` | Add `config.changeDataDir()` client method |

### Out of Scope

- Portable mode (exe-adjacent data storage)
- Cleaning up old data directory after migration
- Per-category directory selection (e.g., separate runtimes path)
- First-launch directory picker (uses default, change later)

### Testing

- Unit test for bootstrap pointer-file parsing (valid JSON, missing file, corrupt file, empty dataDir)
- Unit test for migration validation (same dir, nested dir, non-writable)
- Manual test for full migration flow on Windows
