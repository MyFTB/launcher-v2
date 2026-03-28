import path from 'node:path'

export type MigrationValidation =
  | { ok: true }
  | { ok: false; error: 'already-current' | 'nested' | 'empty' }

/**
 * Validate that `target` is a legal migration destination given the `current` data dir.
 * Pure function - no I/O.
 *
 * The `platform` parameter controls case-folding only (win32 = case-insensitive).
 * Path resolution and separators always use the host OS via `path.resolve` / `path.sep`.
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
