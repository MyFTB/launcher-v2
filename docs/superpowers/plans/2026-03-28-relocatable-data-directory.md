# Relocatable Data Directory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to relocate all launcher data (config, logs, runtimes, cache, modpacks) to a directory of their choice via Settings, with automatic migration and app restart.

**Architecture:** A tiny pointer file (`datadir.json`) at a fixed OS-specific path tells Electron where userData lives, read synchronously before `app.whenReady()`. The Settings page exposes a "Change" button that triggers migration (recursive copy old → new), writes the pointer, and restarts the app.

**Tech Stack:** Electron `app.setPath()`, Node.js `fs` (sync for bootstrap, async for migration), IPC handler + React UI.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/pointer-file.ts` | CREATE | Pure `parseDataDirPointer(raw)` function — safe for vitest import |
| `src/main/bootstrap.ts` | CREATE | Sync read of `datadir.json` from fixed OS path, `writeDataDirPointer()`, `getBootstrapDir()` |
| `src/shared/migrate-validation.ts` | CREATE | Pure `validateMigrationTarget(current, target, platform)` — rejects same-dir, nested, empty |
| `src/main/index.ts` | MODIFY:1-15 | Call `readDataDirFromDisk()` + `app.setPath()` before service imports resolve |
| `src/main/services/config.service.ts` | MODIFY:add method | `migrateDataDir(target)` — validate, recursive copy, update pointer, return result |
| `src/main/ipc/channels.ts` | MODIFY:78 | Add `CONFIG_CHANGE_DATA_DIR` constant |
| `src/main/ipc/router.ts` | MODIFY:50-53 | Add handler: open picker → migrate → relaunch |
| `src/shared/types.ts` | MODIFY:199,270 | Add `dataDir` to `SystemInfoResult`, add `configChangeDataDir()` to `ElectronAPI` |
| `src/preload/index.ts` | MODIFY:44 | Expose `configChangeDataDir` |
| `src/renderer/src/ipc/client.ts` | MODIFY:163 | Add `changeDataDir()` to `config` namespace |
| `src/renderer/src/pages/Settings.tsx` | MODIFY:309 | Add "Speicherort (Datenverzeichnis)" section above install dir |
| `src/tests/bootstrap.test.ts` | CREATE | Tests for `parseDataDirPointer` |
| `src/tests/migrate-validation.test.ts` | CREATE | Tests for `validateMigrationTarget` |

---

### Task 1: Pointer-file parser (pure logic + test)

**Files:**
- Create: `src/shared/pointer-file.ts`
- Create: `src/tests/bootstrap.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/tests/bootstrap.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseDataDirPointer } from '../shared/pointer-file'

describe('parseDataDirPointer', () => {
  it('returns dataDir from valid JSON', () => {
    expect(parseDataDirPointer('{"dataDir":"D:\\\\Games\\\\MyFTB"}')).toBe('D:\\Games\\MyFTB')
  })

  it('handles forward-slash paths', () => {
    expect(parseDataDirPointer('{"dataDir":"/home/user/myftb"}')).toBe('/home/user/myftb')
  })

  it('returns null for empty dataDir', () => {
    expect(parseDataDirPointer('{"dataDir":""}')).toBeNull()
  })

  it('returns null for whitespace-only dataDir', () => {
    expect(parseDataDirPointer('{"dataDir":"   "}')).toBeNull()
  })

  it('returns null for missing dataDir key', () => {
    expect(parseDataDirPointer('{}')).toBeNull()
  })

  it('returns null for non-string dataDir', () => {
    expect(parseDataDirPointer('{"dataDir":42}')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseDataDirPointer('not json')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseDataDirPointer('')).toBeNull()
  })

  it('ignores extra keys', () => {
    expect(parseDataDirPointer('{"dataDir":"/data","version":2}')).toBe('/data')
  })
})
```

- [ ] **Step 2: Write the pointer-file module**

Create `src/shared/pointer-file.ts`:

```typescript
/**
 * Parse a datadir.json pointer file's content.
 * Returns the dataDir path string, or null if missing/invalid.
 *
 * Pure function — no I/O, no Electron imports. Safe for vitest.
 */
export function parseDataDirPointer(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { dataDir?: unknown }
    if (typeof parsed.dataDir === 'string' && parsed.dataDir.trim().length > 0) {
      return parsed.dataDir
    }
  } catch {
    // Corrupt or non-JSON content
  }
  return null
}
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run src/tests/bootstrap.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 4: Commit**

```bash
git add src/shared/pointer-file.ts src/tests/bootstrap.test.ts
git commit -m "feat(data-dir): add pointer-file parser with tests

Pure parseDataDirPointer() function for reading datadir.json content.
No Electron dependency - safe for vitest.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Bootstrap module (sync read + write)

**Files:**
- Create: `src/main/bootstrap.ts`

- [ ] **Step 1: Create the bootstrap module**

Create `src/main/bootstrap.ts`:

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseDataDirPointer } from '../shared/pointer-file'

/**
 * Platform-specific directory for the bootstrap pointer file.
 * This path is FIXED and never changes - it tells the app where userData lives.
 *
 * Windows:  %LOCALAPPDATA%\MyFTB Launcher\
 * macOS:    ~/Library/Application Support/MyFTB Launcher Bootstrap/
 * Linux:    ~/.local/share/MyFTB Launcher Bootstrap/
 */
export function getBootstrapDir(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'),
        'MyFTB Launcher',
      )
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'MyFTB Launcher Bootstrap')
    default:
      return path.join(os.homedir(), '.local', 'share', 'MyFTB Launcher Bootstrap')
  }
}

/** Full path to the pointer file. */
export function getPointerPath(): string {
  return path.join(getBootstrapDir(), 'datadir.json')
}

/**
 * Read the pointer file from disk (synchronous - runs before app.whenReady).
 * Returns the custom dataDir path, or null to use Electron's default.
 */
export function readDataDirFromDisk(): string | null {
  try {
    const raw = readFileSync(getPointerPath(), 'utf8')
    return parseDataDirPointer(raw)
  } catch {
    // File doesn't exist or unreadable - use default
    return null
  }
}

/**
 * Write a new dataDir to the pointer file.
 * Creates the bootstrap directory if it doesn't exist.
 */
export function writeDataDirPointer(dataDir: string): void {
  const dir = getBootstrapDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(getPointerPath(), JSON.stringify({ dataDir }, null, 2), 'utf8')
}
```

- [ ] **Step 2: Run lint + type-check**

Run: `npm run lint && npm run type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/bootstrap.ts
git commit -m "feat(data-dir): add bootstrap module for sync pointer-file I/O

Reads datadir.json before app.whenReady() to determine custom userData path.
Provides writeDataDirPointer() for use during migration.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Wire bootstrap into app startup

**Files:**
- Modify: `src/main/index.ts:1-15`

- [ ] **Step 1: Add bootstrap call after electron import**

In `src/main/index.ts`, insert the bootstrap call between line 2 (`import { app, ... }`) and line 3 (`import { join }`). The key constraint: `app.setPath('userData', ...)` must execute before any code calls `app.getPath('userData')`. All service modules use `app.getPath('userData')` only inside methods (not at module scope), so placing the call after the `app` import but before service imports is safe.

Replace lines 1-15 of `src/main/index.ts` with:

```typescript
import { setMaxListeners } from 'node:events'
import { app, BrowserWindow, shell } from 'electron'

// ── Bootstrap: custom data directory (must run before app.whenReady) ──
import { readDataDirFromDisk } from './bootstrap'
const customDataDir = readDataDirFromDisk()
if (customDataDir) {
  app.setPath('userData', customDataDir)
}

import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Undici (Node's built-in fetch) registers multiple abort listeners per concurrent
// request. Raise the default so the false-positive "memory leak" warning is
// suppressed without hiding real issues.
setMaxListeners(30)
import { registerIpcHandlers } from './ipc/router'
import { IpcChannels } from './ipc/channels'
import { configService } from './services/config.service'
import { launchService } from './services/launch.service'
import { setMainWindow, setLaunchPackArg, getLaunchPackArg, getMainWindow } from './app-state'
import { logger } from './logger'
```

**Important note for the implementer:** In bundled code (electron-vite), ES `import` statements are hoisted and all modules are evaluated before any top-level statements execute. However, `app.setPath()` MUST be called before `app.whenReady()` (which is on line 85). Since `configService.configPath` uses `app.getPath('userData')` only inside a getter (called in `load()` which runs after `whenReady`), the hoisted import order is safe. The `app.setPath()` call runs as a top-level statement before `app.whenReady()`.

- [ ] **Step 2: Run lint + type-check**

Run: `npm run lint && npm run type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(data-dir): wire bootstrap into app startup

Reads datadir.json before app.whenReady() and calls app.setPath('userData')
if a custom data directory is configured.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Migration validation (pure logic + test)

**Files:**
- Create: `src/shared/migrate-validation.ts`
- Create: `src/tests/migrate-validation.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/tests/migrate-validation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { validateMigrationTarget } from '../shared/migrate-validation'

describe('validateMigrationTarget', () => {
  it('rejects empty target', () => {
    expect(validateMigrationTarget('/old', '')).toEqual({ ok: false, error: 'empty' })
  })

  it('rejects whitespace-only target', () => {
    expect(validateMigrationTarget('/old', '   ')).toEqual({ ok: false, error: 'empty' })
  })

  it('rejects same directory (exact match)', () => {
    const r = validateMigrationTarget('/data', '/data')
    expect(r).toEqual({ ok: false, error: 'already-current' })
  })

  it('rejects same directory (case-insensitive on win32)', () => {
    const r = validateMigrationTarget('C:\\Data', 'c:\\data', 'win32')
    expect(r).toEqual({ ok: false, error: 'already-current' })
  })

  it('is case-sensitive on linux', () => {
    const r = validateMigrationTarget('/Data', '/data', 'linux')
    expect(r).toEqual({ ok: true })
  })

  it('rejects target inside current', () => {
    const r = validateMigrationTarget('/data', '/data/sub')
    expect(r).toEqual({ ok: false, error: 'nested' })
  })

  it('rejects current inside target', () => {
    const r = validateMigrationTarget('/data/sub', '/data')
    expect(r).toEqual({ ok: false, error: 'nested' })
  })

  it('does not falsely reject similar prefixes', () => {
    // /data-backup is NOT inside /data
    const r = validateMigrationTarget('/data', '/data-backup')
    expect(r).toEqual({ ok: true })
  })

  it('accepts valid different directory', () => {
    const r = validateMigrationTarget('/old', '/new')
    expect(r).toEqual({ ok: true })
  })

  it('accepts different drives on windows', () => {
    const r = validateMigrationTarget('C:\\old', 'D:\\new', 'win32')
    expect(r).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: Write the validation module**

Create `src/shared/migrate-validation.ts`:

```typescript
import path from 'node:path'

export type MigrationValidation =
  | { ok: true }
  | { ok: false; error: 'already-current' | 'nested' | 'empty' }

/**
 * Validate that `target` is a legal migration destination given the `current` data dir.
 * Pure function - no I/O. Optional `platform` param defaults to process.platform.
 */
export function validateMigrationTarget(
  current: string,
  target: string,
  platform: string = process.platform,
): MigrationValidation {
  if (!target || target.trim().length === 0) {
    return { ok: false, error: 'empty' }
  }

  const normalize = (p: string): string => {
    const resolved = path.resolve(p)
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  const normCurrent = normalize(current)
  const normTarget = normalize(target)

  if (normCurrent === normTarget) {
    return { ok: false, error: 'already-current' }
  }

  // Check nesting in either direction (append separator to avoid /data matching /data-backup)
  const sep = path.sep
  if (normTarget.startsWith(normCurrent + sep) || normCurrent.startsWith(normTarget + sep)) {
    return { ok: false, error: 'nested' }
  }

  return { ok: true }
}
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run src/tests/migrate-validation.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 4: Commit**

```bash
git add src/shared/migrate-validation.ts src/tests/migrate-validation.test.ts
git commit -m "feat(data-dir): add migration target validation with tests

Pure validateMigrationTarget() - rejects same dir, nested paths, empty target.
Case-insensitive comparison on Windows.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: ConfigService migration method

**Files:**
- Modify: `src/main/services/config.service.ts`

- [ ] **Step 1: Add imports at the top**

Add after line 5 (`import { logger } from '../logger'`), before the helpers section:

```typescript
import { writeDataDirPointer } from '../bootstrap'
import { validateMigrationTarget } from '../../shared/migrate-validation'
```

- [ ] **Step 2: Add migrateDataDir and recursiveCopy to ConfigService class**

Add these two methods after the `generateClientToken()` method (after line 190, before the closing `}` of the class):

```typescript
  // ── Data directory migration ─────────────────────────────────────────────

  /**
   * Migrate all launcher data from the current userData to a new directory.
   *
   * 1. Validates the target path
   * 2. Tests write access
   * 3. Recursively copies userData contents to target
   * 4. If installationDir pointed to old instances path, clears it so the fallback kicks in
   * 5. Writes the bootstrap pointer file
   *
   * Returns `{ success: true }` or `{ success: false, error: string }`.
   * Caller is responsible for restarting the app after success.
   */
  async migrateDataDir(targetDir: string): Promise<{ success: boolean; error?: string }> {
    const currentDir = app.getPath('userData')

    const validation = validateMigrationTarget(currentDir, targetDir)
    if (!validation.ok) {
      const messages: Record<string, string> = {
        'already-current': 'Das ist bereits der aktuelle Speicherort.',
        nested: 'Der Zielordner darf nicht innerhalb des aktuellen Speicherorts liegen (oder umgekehrt).',
        empty: 'Bitte waehle einen Ordner.',
      }
      return { success: false, error: messages[validation.error] }
    }

    // Ensure target exists and is writable
    try {
      await fs.mkdir(targetDir, { recursive: true })
      const testFile = path.join(targetDir, '.myftb-write-test')
      await fs.writeFile(testFile, 'test', 'utf8')
      await fs.unlink(testFile)
    } catch {
      return { success: false, error: 'Der Zielordner ist nicht beschreibbar.' }
    }

    // Recursive copy
    try {
      await this.recursiveCopy(currentDir, targetDir)
    } catch (err) {
      logger.error('[ConfigService] Migration copy failed:', err)
      return { success: false, error: 'Fehler beim Kopieren der Daten.' }
    }

    // If installationDir pointed to the old instances path, clear it
    // so getInstallDir() falls back to <newUserData>/instances
    const oldInstancesPath = path.join(currentDir, 'instances')
    if (
      this.config.installationDir &&
      path.resolve(this.config.installationDir) === path.resolve(oldInstancesPath)
    ) {
      this.config.installationDir = ''
      const newConfigPath = path.join(targetDir, 'config.json')
      await fs.writeFile(newConfigPath, JSON.stringify(this.config, null, 2), 'utf8')
    }

    // Write bootstrap pointer file
    try {
      writeDataDirPointer(targetDir)
    } catch (err) {
      logger.error('[ConfigService] Failed to write pointer file:', err)
      return { success: false, error: 'Fehler beim Schreiben der Konfiguration.' }
    }

    logger.info(`[ConfigService] Data directory migrated: ${currentDir} -> ${targetDir}`)
    return { success: true }
  }

  /** Recursively copy a directory tree, skipping Electron lock files. */
  private async recursiveCopy(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true })
    const entries = await fs.readdir(src, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'SingletonLock' || entry.name === 'lockfile') continue
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        await this.recursiveCopy(srcPath, destPath)
      } else {
        await fs.copyFile(srcPath, destPath)
      }
    }
  }
```

- [ ] **Step 3: Run lint + type-check**

Run: `npm run lint && npm run type-check`
Expected: PASS

- [ ] **Step 4: Run all tests**

Run: `npm run test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/config.service.ts
git commit -m "feat(data-dir): add migrateDataDir method to ConfigService

Validates target, recursively copies userData, clears installationDir
if it pointed to old instances path, writes bootstrap pointer file.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: IPC channel constant

**Files:**
- Modify: `src/main/ipc/channels.ts:78`

- [ ] **Step 1: Add the channel constant**

In `src/main/ipc/channels.ts`, add after line 78 (`CONFIG_OPEN_LOGS: 'config:open-logs',`):

```typescript
  /** Renderer->Main: Pick new data directory, migrate, and restart */
  CONFIG_CHANGE_DATA_DIR: 'config:change-data-dir',
```

- [ ] **Step 2: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/channels.ts
git commit -m "feat(data-dir): add CONFIG_CHANGE_DATA_DIR IPC channel

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: IPC handler

**Files:**
- Modify: `src/main/ipc/router.ts:50-53`

- [ ] **Step 1: Add the handler**

In `src/main/ipc/router.ts`, add after the `CONFIG_OPEN_LOGS` handler (after line 52: `shell.openPath(app.getPath('logs'))`):

```typescript
  ipcMain.handle(IpcChannels.CONFIG_CHANGE_DATA_DIR, async () => {
    const win = getMainWindow()
    if (!win) return { success: false, error: 'Kein Fenster vorhanden.' }

    const result = await dialog.showOpenDialog(win, {
      title: 'Speicherort fuer Launcher-Daten waehlen',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, error: 'cancelled' }
    }

    const migrationResult = await configService.migrateDataDir(result.filePaths[0])

    if (migrationResult.success) {
      setTimeout(() => {
        app.relaunch()
        app.quit()
      }, 500)
    }

    return migrationResult
  })
```

- [ ] **Step 2: Update SYSTEM_INFO handler to include dataDir**

In `src/main/ipc/router.ts`, update the `SYSTEM_INFO` handler (around line 55) to add `dataDir`:

Change:
```typescript
  ipcMain.handle(IpcChannels.SYSTEM_INFO, () => ({
    platform: process.platform,
    totalMemoryMb: Math.round(os.totalmem() / 1_048_576),
    arch: os.arch(),
    launcherVersion: app.getVersion()
  }))
```

To:
```typescript
  ipcMain.handle(IpcChannels.SYSTEM_INFO, () => ({
    platform: process.platform,
    totalMemoryMb: Math.round(os.totalmem() / 1_048_576),
    arch: os.arch(),
    launcherVersion: app.getVersion(),
    dataDir: app.getPath('userData'),
  }))
```

- [ ] **Step 3: Run lint + type-check**

Run: `npm run lint && npm run type-check`
Expected: PASS (or will fail if ElectronAPI/SystemInfoResult not yet updated — that's OK, Task 8 fixes it)

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/router.ts
git commit -m "feat(data-dir): add IPC handler for data directory change

Opens directory picker, runs migration via configService, relaunches
app on success. Also adds dataDir to SYSTEM_INFO response.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Type definitions + preload + IPC client

**Files:**
- Modify: `src/shared/types.ts:199-204,270`
- Modify: `src/preload/index.ts:44`
- Modify: `src/renderer/src/ipc/client.ts:163`

- [ ] **Step 1: Update SystemInfoResult**

In `src/shared/types.ts`, add `dataDir` to the `SystemInfoResult` interface (after line 203, `launcherVersion: string`):

```typescript
  /** Current userData directory path */
  dataDir: string
```

So the full interface becomes:
```typescript
export interface SystemInfoResult {
  platform: 'win32' | 'darwin' | 'linux'
  totalMemoryMb: number
  arch: string
  launcherVersion: string
  /** Current userData directory path */
  dataDir: string
}
```

- [ ] **Step 2: Update ElectronAPI interface**

In `src/shared/types.ts`, add after line 270 (`configOpenLogs(): Promise<void>`):

```typescript
  configChangeDataDir(): Promise<{ success: boolean; error?: string }>
```

- [ ] **Step 3: Update preload**

In `src/preload/index.ts`, add after line 44 (`configOpenLogs: () => ipcRenderer.invoke('config:open-logs'),`):

```typescript
  configChangeDataDir: () => ipcRenderer.invoke('config:change-data-dir'),
```

- [ ] **Step 4: Update IPC client**

In `src/renderer/src/ipc/client.ts`, add after line 163 (the `openLogs` method closing brace) and before the closing brace of the `config` namespace:

```typescript

    /** Pick a new data directory, migrate, and restart. */
    changeDataDir(): Promise<{ success: boolean; error?: string }> {
      return window.electronAPI.configChangeDataDir()
    },
```

- [ ] **Step 5: Run lint + type-check**

Run: `npm run lint && npm run type-check`
Expected: PASS

- [ ] **Step 6: Run all tests**

Run: `npm run test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/preload/index.ts src/renderer/src/ipc/client.ts
git commit -m "feat(data-dir): wire types, preload, and renderer IPC client

Adds configChangeDataDir to ElectronAPI and preload bridge.
Adds dataDir to SystemInfoResult for display in Settings.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Settings page UI

**Files:**
- Modify: `src/renderer/src/pages/Settings.tsx:115,176,309`

- [ ] **Step 1: Add state variables**

In `src/renderer/src/pages/Settings.tsx`, add after line 115 (`const formRef = useRef(form)`):

```typescript
  const [dataDirChanging, setDataDirChanging] = useState(false)
  const [dataDirError, setDataDirError] = useState<string | null>(null)
```

- [ ] **Step 2: Add handler function**

Add after `handlePickDir` (after line 176, `}, [])`):

```typescript
  const handleChangeDataDir = useCallback(async () => {
    setDataDirChanging(true)
    setDataDirError(null)
    try {
      const result = await window.electronAPI.configChangeDataDir()
      if (!result.success && result.error !== 'cancelled') {
        setDataDirError(result.error ?? 'Unbekannter Fehler')
      }
    } catch (err) {
      setDataDirError(err instanceof Error ? err.message : 'Fehler beim Verschieben')
    } finally {
      setDataDirChanging(false)
    }
  }, [])
```

- [ ] **Step 3: Add UI section**

In the JSX, insert a new section BEFORE the `{/* Install Directory */}` comment (before line 309). The new section should be:

```tsx
        {/* Data Directory */}
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            Speicherort (Datenverzeichnis)
          </label>
          <p className="text-xs text-text-muted mb-2">
            Hier werden Konfiguration, Logs, Java-Runtimes und der Cache gespeichert.
          </p>
          <div className="flex gap-2 items-center">
            <span className="input flex-1 text-text-secondary truncate cursor-default select-all">
              {systemInfo?.dataDir ?? '...'}
            </span>
            <button
              className="btn-secondary shrink-0"
              onClick={handleChangeDataDir}
              disabled={dataDirChanging}
            >
              {dataDirChanging ? 'Verschiebe...' : 'Aendern...'}
            </button>
          </div>
          {dataDirError && (
            <p className="text-xs text-red-400 mt-1">{dataDirError}</p>
          )}
        </div>
```

- [ ] **Step 4: Run lint + type-check**

Run: `npm run lint && npm run type-check`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `npm run test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/pages/Settings.tsx
git commit -m "feat(data-dir): add data directory section to Settings page

Shows current dataDir path with 'Aendern...' button that triggers
migration + app restart. Displays inline error messages.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run full check suite**

```bash
npm run lint && npm run type-check && npm run test
```

Expected: ALL PASS, 0 warnings

- [ ] **Step 2: Verify file structure**

Confirm these files exist:
- `src/shared/pointer-file.ts`
- `src/shared/migrate-validation.ts`
- `src/main/bootstrap.ts`
- `src/tests/bootstrap.test.ts`
- `src/tests/migrate-validation.test.ts`

- [ ] **Step 3: Manual smoke test**

1. Run `npm run dev`
2. Open Settings page
3. Verify "Speicherort (Datenverzeichnis)" section appears above "Installationsverzeichnis"
4. Verify it shows the current userData path (e.g. `C:\Users\...\AppData\Roaming\myftb-launcher`)
5. Click "Aendern..." - directory picker should open
6. Select a new empty directory - data should be copied and app should restart
7. After restart, Settings should show the new path
8. Verify config.json, logs etc. exist in the new location
9. To reset: delete `%LOCALAPPDATA%\MyFTB Launcher\datadir.json` and restart
