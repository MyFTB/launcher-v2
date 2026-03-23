# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [2.1.0-beta.1] — 2026-03-23

### 🐛 Bug Fixes

- Clear running badge when Minecraft closes
- Increase font sizes and width in PackSettingsModal
- Persist running badge across tab switches
- Remove duplicate logger.info calls in install service
- Replace em dashes in index.ts logger strings with ASCII
- Replace non-ASCII en/em dashes and arrows in log strings
- Resolve pre-existing TS errors in launch.service.ts
- Resolve remaining pre-existing TS errors in main process
- Spawn Minecraft with detached:true so it survives launcher close
- Surface AggregateError details in install failure message
- Type-check script was checking solution file instead of node tsconfig
- Update button now updates only, does not launch game
- Use launch store when starting pack from home screen

### 📚 Documentation

- Require ASCII-only characters in logger strings
- Update CHANGELOG.md for v2.0.0 [skip ci]

### 🚀 Features

- Add explicit update action for outdated modpacks
- Add file-based logger with comprehensive service tracing
- Enable text selection in log viewer
- Keep Minecraft running when launcher is closed
- Per-pack RAM, JVM args overrides and settings modal
- Show install progress when updating a pack from InstalledPacks
## [2.0.0] — 2026-03-22

### ♻️ Refactoring

- Update Post interface and improve PostCard component

### 🎨 Design

- Apply redesign audit fixes
- Apply redesign audit improvements
- Use real SVG logo in sidebar

### 🐛 Bug Fixes

- NeoForge Installations
- Console UX overhaul + launch state + lastPlayedPacks
- Correct CI build errors

### 📚 Documentation

- Add open source repo files
- Fix Discord badge server ID in README

### 🚀 Features

- Add pack reload functionality and update pack management logic
- Auto-updater via electron-updater + GitHub Releases deployment
- Enhance Home component with account picker and profile management
- Enhance mod loader installation with Java path resolution and NeoForge ID handling
- Improve log upload UI
- Improve settings
- Pictures to news posts
- Refactor components for improved performance and maintainability
- Unified design system — cards, buttons, nav, context menu, settings
- Update ESLint configuration and improve component styles for better performance
- Update channel switching (stable / experimental)

