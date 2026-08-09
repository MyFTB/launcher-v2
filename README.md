<div align="center">
  <img src="src/renderer/src/assets/logo.svg" alt="MyFTB Launcher Logo" width="80" />
  <h1>MyFTB Launcher</h1>
  <p>The official launcher for <a href="https://myftb.de">myftb.de</a> Minecraft modpacks.</p>

  [![Build](https://github.com/MyFTB/launcher-v2/actions/workflows/build.yml/badge.svg)](https://github.com/MyFTB/launcher-v2/actions/workflows/build.yml)
  [![Release](https://img.shields.io/github/v/release/MyFTB/launcher-v2?include_prereleases)](https://github.com/MyFTB/launcher-v2/releases/latest)
  [![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
  [![Discord](https://img.shields.io/discord/190163175633584130?label=Discord&logo=discord&logoColor=white)](https://discord.gg/myftb)
</div>

---

## Features

- 🗂 **Browse and install** modpacks from the MyFTB pack library
- 🚀 **One-click launch** for Forge, NeoForge, Fabric, and Quilt
- 🔐 **Microsoft authentication** through OAuth 2.0
- 🔄 **Automatic updates** for stable and experimental channels
- 🎮 **Discord Rich Presence** for the active modpack
- 🖥 **Cross-platform support** for Windows, macOS, and Linux
- ⚡ **Optional features** for each modpack
- 📋 **In-app console** with live logs and crash upload

## Installation

Download the latest installer from [Releases](https://github.com/MyFTB/launcher-v2/releases/latest):

| Platform | File |
|---|---|
| Windows | `MyFTB-Launcher-Setup-x.x.x.exe` |
| macOS (Intel) | `MyFTB-Launcher-x.x.x-x64.dmg` |
| macOS (Apple Silicon) | `MyFTB-Launcher-x.x.x-arm64.dmg` |
| Linux | `MyFTB-Launcher-x.x.x.AppImage` or `.deb` |

Official Windows and macOS releases use the signing and notarization release workflow. Local and dry-run packages are unsigned.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) `24.18.1` or a newer Node 24 LTS patch
- The npm version bundled with Node.js (`11.16.0` or newer)
- [Git](https://git-scm.com/)

The `.nvmrc` file selects the tested Node.js version. Use its bundled npm; no separate npm upgrade is required.

### Setup

```bash
git clone https://github.com/MyFTB/launcher-v2.git
cd launcher-v2
nvm use
npm ci --strict-peer-deps
npm run prepare:electron
```

Electron 42 and later download their binary on demand. Run `npm run prepare:electron` after each clean install.

### Commands

```bash
npm run dev             # Start the app with hot reload
npm run build           # Build the production app in out/
npm run test            # Run all tests
npm run lint            # Run ESLint
npm run type-check      # Check main and renderer TypeScript
npm run package         # Build and create installers
npm run audit:production
npm run audit:full
```

### Dependency policy

Direct dependencies, development tools, and GitHub Actions use stable releases only. Do not add prerelease versions to these lists.

Stable parent packages can require transitive prereleases. Lockfile changes must explain each new transitive prerelease.

The current compatibility holds are intentional:

- `electron-vite@5` supports Vite through version 7, so Vite 8 remains held.
- `@vitejs/plugin-react@6` requires Vite 8, so plugin-react remains on version 5.
- `typescript-eslint@8.66` supports TypeScript below 6.1, so TypeScript 7 remains held.
- Node types remain on version 24 to match Node 24 and Electron 43.
- XMCL uses the `undici-xmcl` alias on Undici 7. Launcher HTTP uses Undici 8.

These holds are the only expected direct results from `npm outdated`. The XMCL 6.3.1 release has invalid workspace and entrypoint metadata. Narrow overrides and the version-checked postinstall repair fix that release until XMCL publishes a corrected stable version.

### Project structure

```text
src/
├── main/          # Electron main process
│   ├── ipc/       # IPC channels, validation, and routing
│   └── services/  # Authentication, install, launch, Discord, and updates
├── preload/       # Typed contextBridge API
├── renderer/      # React UI with Vite and Tailwind CSS
├── shared/        # Shared types and pure runtime validation
└── tests/         # Vitest tests for pure and Node logic
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.

## License

The project uses the [GNU General Public License v3.0](LICENSE).
