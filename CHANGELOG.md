# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0-alpha.1] — 2026-03-22

Initial alpha release of the rewritten launcher (v2).

### Added
- Microsoft OAuth 2.0 authentication with multi-account support
- Browse, install, and launch modpacks from the MyFTB pack library
- Forge and NeoForge support via `@xmcl/core` + `@xmcl/installer`
- Optional feature selection per modpack
- Discord Rich Presence via `@xhayper/discord-rpc`
- Auto-updater via `electron-updater` with in-app update banner
- In-app console drawer with crash/log upload to paste.myftb.de
- Custom frameless title bar with window controls
- Collapsible sidebar navigation with new-pack badge
- Dark theme with custom Tailwind design tokens (MyFTB green accent)
- Outfit Variable font (bundled, works offline)
- `myftb://pack/<name>` deep-link / URL scheme support
- Single-instance lock with second-instance forwarding
- Cross-platform: Windows (NSIS), macOS (DMG), Linux (AppImage + deb)
- GitHub Actions CI (build + type-check + lint + test on all platforms)
- GitHub Actions release workflow (publish to GitHub Releases on `v*` tag)
- Dependabot for npm and GitHub Actions updates
- CodeQL security scanning

[Unreleased]: https://github.com/MyFTB/launcher-v2/compare/v2.0.0-alpha.1...HEAD
[2.0.0-alpha.1]: https://github.com/MyFTB/launcher-v2/releases/tag/v2.0.0-alpha.1
