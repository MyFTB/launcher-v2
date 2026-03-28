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
      return parsed.dataDir.trim()
    }
  } catch {
    // Corrupt or non-JSON content
  }
  return null
}
