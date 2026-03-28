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
  writeFileSync(getPointerPath(), JSON.stringify({ dataDir }, null, 2) + '\n', 'utf8')
}
