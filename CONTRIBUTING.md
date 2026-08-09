# Contributing to MyFTB Launcher

## Development setup

Use Node.js `24.18.1` and npm `12.0.2`.

```bash
git clone https://github.com/MyFTB/launcher-v2.git
cd launcher-v2
nvm use
npm install --global npm@12.0.2
npm ci --strict-peer-deps
npm run prepare:electron
npm run dev
```

Use `npm ci`, not `npm install`, for a clean checkout. Electron 43 downloads its binary through the explicit preparation command.

## Before you open a pull request

Run the complete check set from a clean install:

```bash
npm ci --strict-peer-deps
npm ls --all
npm outdated
npm run audit:production
npm run audit:full
npm run lint
npm run type-check
npm run test
npm run build
npm run package -- --dir --publish never
```

`npm outdated` can report only the documented compatibility holds. These holds cover Vite 8, plugin-react 6, TypeScript 7, Node 26 types, and the XMCL Undici alias.

Use the manual release dry-run workflow when a change affects packaging. It builds unsigned NSIS, DMG, AppImage, and deb files without publishing a release.

## Code conventions

### Architecture boundaries

The codebase has three Electron processes with strict boundaries:

- **`src/main/`** contains Node.js and Electron code. Do not import React or DOM APIs.
- **`src/renderer/`** contains React code. Do not access Node.js or Electron directly.
- **`src/preload/`** exposes the approved `contextBridge` API.
- **`src/shared/`** contains shared types and pure runtime validation.

Keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` for renderer windows.

### IPC

- Define channel names in `src/main/ipc/channels.ts`.
- Add new IPC methods to `ElectronAPI` in `src/shared/types.ts`.
- Call IPC through `src/renderer/src/ipc/client.ts`.
- Do not expose `ipcRenderer` to the renderer.

### Styling

- Use semantic Tailwind tokens such as `bg-bg-surface` and `text-accent`.
- Use the bundled Outfit Variable font through `font-sans`.
- Do not add remote font imports.

### Testing

- Put tests in `src/tests/`.
- Extract Electron-independent logic into pure production helpers.
- Add or extend a test for each bug fix and logic change.
- Import Vitest APIs explicitly.

```ts
import { describe, expect, it } from 'vitest'
```

### Dependencies

Use stable releases for direct dependencies, development tools, and GitHub Actions. Do not add prerelease versions.

Keep these compatibility boundaries until their parent tools support the next major versions:

- `electron-vite@5` with Vite 7
- `@vitejs/plugin-react@5` with Vite 7
- TypeScript `6.0.3` with `typescript-eslint@8.66`
- Node 24 types with Node 24 and Electron 43
- Undici 8 for launcher HTTP and Undici 7 for XMCL

Do not add blanket dependency overrides. The current XMCL overrides and npm patches repair published 6.3.1 metadata only. Remove them after a verified stable XMCL release makes them unnecessary.

Regenerate `package-lock.json` with npm `12.0.2`. Run a clean `npm ci --strict-peer-deps` after each dependency change.

### Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat: add pack search filter
fix: reject an invalid manifest version
chore: upgrade Electron 42 to 43
docs: update the setup guide
```

## API endpoints

The `packs.myftb.de` backend has no CORS headers. Make all requests to this domain in the main process.

## Reporting security issues

Do not open a public issue for a security vulnerability. Follow [SECURITY.md](.github/SECURITY.md).

## License

Contributions use the project [GPL-3.0 license](LICENSE).
