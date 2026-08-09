# MyFTB Launcher v2 — Copilot Instructions

Cross-platform Electron app (Windows/macOS/Linux) for discovering, installing, and launching Minecraft modpacks from myftb.de.

## Toolchain

Use Node.js `24.18.1` and npm `12.0.2`. Select Node with `.nvmrc`, then install dependencies with:

```bash
nvm use
npm install --global npm@12.0.2
npm ci --strict-peer-deps
npm run prepare:electron
```

Electron 43 downloads its binary on demand. Run the preparation script after each clean install.

## Commands

```bash
npm run dev               # Start electron-vite with HMR
npm run build             # Build the production app in out/
npm run test              # Run all tests once
npm run test:watch        # Run tests in watch mode
npm run lint              # Run ESLint with no warnings
npm run type-check        # Check the main and renderer tsconfigs
npm run package           # Build and package with electron-builder
npm run prepare:electron  # Download the locked Electron binary
npm run audit:production  # Audit runtime dependencies
npm run audit:full        # Audit all dependencies
```

Run a single test file:
```bash
npm run test -- src/tests/auth-profiles.test.ts
```

Run tests matching a name pattern:
```bash
npm run test -- -t "isLoggedIn"
```

## Dependency policy

Use stable releases for direct dependencies, tools, and GitHub Actions. Do not add direct prerelease versions.

Keep these compatibility holds:

- `electron-vite@5` supports Vite through version 7. Do not upgrade to Vite 8 yet.
- `@vitejs/plugin-react@6` requires Vite 8. Keep plugin-react on version 5.
- `typescript-eslint@8.66` supports TypeScript below 6.1. Keep TypeScript at `6.0.3`.
- Keep Node types on version 24 for Node 24 and Electron 43.
- Use Undici 8 for launcher HTTP. Use the `undici-xmcl` Undici 7 alias only for XMCL.

The XMCL 6.3.1 package metadata is invalid. Keep its narrow overrides and npm patches until a verified stable XMCL release replaces them.

Regenerate the lockfile with npm `12.0.2`. Verify changes with `npm ci --strict-peer-deps`, `npm ls --all`, and both audit scripts.

## Architecture

Three Electron processes with strict boundaries:

```
src/main/       — Node.js main process (file system, Minecraft launch, auth)
src/preload/    — Bridge: exposes window.electronAPI via contextBridge
src/renderer/   — React UI (no direct Node access)
src/shared/     — Shared types and pure runtime validation
src/tests/      — Vitest tests (pure logic only, no Electron/DOM)
```

### IPC Flow

Every renderer→main call travels the same path:

```
Component/Store
  → ipc.auth.startMicrosoft()          (src/renderer/src/ipc/client.ts)
  → window.electronAPI.authStartMicrosoft()  (typed by ElectronAPI interface)
  → ipcRenderer.invoke('auth:start-microsoft')
  → ipcMain.handle() in router.ts
  → authService.registerHandlers()
```

Main→renderer push events go the other way:
```
service → win.webContents.send(IpcChannels.AUTH_PROFILES_UPDATED, payload)
store   → onEvent('auth:profiles-updated', cb)   (returns unsubscribe fn)
```

### Service Pattern

Every service is a singleton class with a `registerHandlers()` method called from `src/main/ipc/router.ts`:

```ts
class AuthService {
  registerHandlers(): void {
    ipcMain.handle(IpcChannels.AUTH_START_MICROSOFT, async () => { ... })
  }
}
export const authService = new AuthService()
```

`src/main/app-state.ts` holds shared mutable references (`mainWindow`, `launchPackArg`) to break circular imports between `index.ts` and services.

### Renderer State (Zustand)

Stores live in `src/renderer/src/store/`. Each store:
- Calls `ipc.*` methods (never `window.electronAPI` directly)
- Wires push-event listeners in an `initListeners()` method called once at app startup
- Exports computed hooks alongside the store (`useSelectedProfile`, `useIsLoggedIn`)
- Prefixes internal setters with `_` (e.g. `_setProfiles`) to signal they're not for UI code

## Key Conventions

### Channel names
All IPC channel names are defined as constants in `src/main/ipc/channels.ts` using `namespace:action` format (`auth:start-microsoft`, `install:progress`). Always use `IpcChannels.*` constants — never raw strings.

### Source of truth for types
`src/shared/types.ts` is the single source of truth for all data shapes (modpack manifests, config, profiles, IPC payloads, `ElectronAPI` interface). Changes to IPC signatures must be reflected here.

### Path aliases
| Alias | Resolves to | Available in |
|---|---|---|
| `@shared` | `src/shared` | main, preload, renderer |
| `@renderer` | `src/renderer/src` | renderer only |

### Tailwind design tokens
The app uses a custom dark theme — always use semantic tokens, not raw hex:

| Token | Value |
|---|---|
| `bg-bg-base` | `#1a1a1a` (window background) |
| `bg-bg-surface` | `#242424` (cards, panels) |
| `bg-bg-elevated` | `#2e2e2e` (raised elements) |
| `bg-bg-overlay` | `#383838` (hover states) |
| `text-text-primary` | `#e8e8e8` |
| `text-text-secondary` | `#9a9a9a` |
| `text-text-muted` | `#606060` |
| `accent` | `#83da38` (MyFTB green) |
| `border` | `#3a3a3a` |
| `border-focus` | `#83da38` |

Font family: `font-sans` → Outfit Variable.

### API endpoints & CORS
The `packs.myftb.de` backend has **no CORS headers** — all HTTP requests to these endpoints must be made in the **main process** (Node.js fetch), never from the renderer.

| Endpoint | Purpose |
|---|---|
| `https://packs.myftb.de/packs/packages.php?key={key}` | Remote pack list |
| `https://packs.myftb.de/packs/{path}` | Pack manifest / files |
| `https://packs.myftb.de/packs/objects/{hash}` | Pack file objects |
| `https://launcher.myftb.de/{platform}.json` | JRE runtime index |
| `https://myftb.de/api/posts` | Blog posts |
| `https://paste.myftb.de` | Log/crash upload |

Microsoft Azure OAuth Client ID: `e9b5325d-45dd-4f9b-b989-a4e23fa2e62b`

### Minecraft mod loader support
`@xmcl/core` + `@xmcl/installer` handle all Minecraft operations in Node.js. Both Forge (`net.minecraftforge`) and NeoForge (`net.neoforged`) are supported by `@xmcl` — the old Java launcher only supported Forge.

**`installForge` version string quirk (MC 1.7.x / 1.8.x)**  
`installForge` internally calls `getForgeArtifactVersion()` which constructs the download URL differently by MC version:
- **MC 1.7.x / 1.8.x** → URL template is `{mcversion}-{version}-{mcversion}`, so `version` must be the bare build number only (e.g., `10.13.4.1614`)
- **Modern MC** → `version` is the full Maven artifact version (e.g., `1.20.1-47.2.0`)

The pack manifest stores the full Maven coordinate (e.g., `net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10`). For 1.7.x/1.8.x you must strip the `{mcversion}-` prefix and `-{mcversion}` suffix before passing to `installForge`. This logic lives in `buildForgeEntry()` in `src/main/services/install-helpers.ts`. Do not call `getForgeVersionList` — it does HTML scraping and is unreliable; always construct the entry directly from manifest data.

**`AggregateError` from `@xmcl`**  
Download/validation failures from `@xmcl/file-transfer` are thrown as `AggregateError`. Its `.message` is empty — always fall back to `err.constructor.name` when surfacing errors from `@xmcl` operations.

### Security rules
- `contextIsolation: true`, `nodeIntegration: false` are invariants — never change them.
- The raw `ipcRenderer` is never exposed to the renderer; only the explicit `ElectronAPI` methods.
- `systemOpenUrl` enforces a domain allowlist (`myftb.de`, `minecraft.net`, `microsoft.com`, `live.com`) — maintain this when adding new outbound links.

### Custom title bar
Windows and Linux use frameless launcher windows. Linux also sets `roundedCorners: false` to preserve square corners on Electron 43. macOS keeps its native frame and hidden title bar. Window controls route through the validated window IPC channels.

### Testing conventions
- Tests live in `src/tests/` and are pure TypeScript (Node environment, no browser globals).
- Tests cover isolated logic extracted from services or components — not Electron APIs or React rendering.
- Import from vitest explicitly: `import { describe, it, expect } from 'vitest'` (globals are disabled).
- `@shared` alias is available in tests (configured in `vitest.config.ts`).

**Standing rule:** Always write or extend a test in `src/tests/` whenever a bug is fixed or new functionality is added. A runtime bug (`remotePacks.filter is not a function`) slipped through because there were no tests for pack-list parsing — this rule exists to prevent that pattern. Test files follow `src/tests/<service-or-feature>.test.ts` naming.

### Logging conventions
All main-process code uses `src/main/logger.ts`. Import with `import { logger } from '../logger'`.

**Standing rule:** Every main-process code path that handles user-triggered actions, config changes, errors, or significant state transitions **must** have a `logger.*` call. Use the right level:
- `logger.info` — user action completed, config saved, service started/stopped
- `logger.warn` — recoverable error, unexpected-but-handled condition
- `logger.error` — unrecoverable error, caught exception
- `logger.debug` — internal state useful only for debugging (e.g. intermediate values)

When adding or modifying any main-process service method, always ask: "Would I want to see this in the log file when debugging a user's issue?" If yes, add the log line.

**Logger strings must use ASCII-only characters.** No em dashes (`—`), en dashes (`–`), ellipsis (`…`), curly quotes, or other Unicode. Use `' - '`, `'...'`, and straight quotes instead. Non-ASCII bytes in the log file are garbled on Windows when viewed with non-UTF-8 tools.

### Deep links & single instance
The `myftb://pack/<name>` URL scheme auto-launches a pack. A single-instance lock is enforced; a second launch focuses the existing window and forwards the `--pack` argument or deep link via `internal:launch-pack` push event.
