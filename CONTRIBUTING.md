# Contributing to MyFTB Launcher

Thanks for your interest in contributing! Here is everything you need to get started.

## Development setup

```bash
git clone https://github.com/MyFTB/launcher-v2.git
cd launcher-v2
npm install
npm run dev
```

## Before you open a PR

Run these checks locally — they all run in CI too:

```bash
npm run type-check   # TypeScript
npm run lint         # ESLint (0 warnings allowed)
npm run test         # Vitest (102 tests)
npm run build        # Full production build
```

## Code conventions

### Architecture boundaries

The codebase has three Electron processes with hard boundaries:

- **`src/main/`** — Node.js only. No React, no DOM.
- **`src/renderer/`** — React only. No direct Node/Electron API access.
- **`src/preload/`** — Bridge only. Every renderer→main call goes through `contextBridge`.
- **`src/shared/`** — Pure types. No runtime code.

### IPC

- All channel names live in `src/main/ipc/channels.ts` — never use raw strings.
- New IPC methods must be added to the `ElectronAPI` interface in `src/shared/types.ts`.
- Renderer calls go through `src/renderer/src/ipc/client.ts`, never `window.electronAPI` directly.

### Styling

- Use semantic Tailwind tokens (`bg-bg-surface`, `text-accent`, etc.) — never raw hex values.
- Font: `font-sans` (Outfit Variable). No external Google Fonts imports — the font is bundled.

### Testing

- Tests live in `src/tests/` and are pure TypeScript (no Electron/DOM).
- **Always add or extend a test** when fixing a bug or adding logic to a service.
- Import explicitly from vitest: `import { describe, it, expect } from 'vitest'`.

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add pack search filter
fix: crash when manifest is missing gameVersion
chore: upgrade electron 41→42
docs: update contributing guide
```

## API endpoints

The `packs.myftb.de` backend has no CORS headers. All HTTP requests to that
domain **must** be made in the main process — never from the renderer.

## Reporting security issues

Please do **not** open a public issue for security vulnerabilities.
See [SECURITY.md](.github/SECURITY.md) for the responsible disclosure process.

## License

By contributing you agree that your contributions will be licensed under the
project's [GPL-3.0 license](LICENSE).
