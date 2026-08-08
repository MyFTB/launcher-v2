import fs from 'node:fs/promises'
import path from 'node:path'

import { ValidationError } from '../shared/validation'

/**
 * Verify that a managed path is contained by `root` and that no existing path
 * component is a symbolic link or junction. Missing suffix components are safe
 * because descendants cannot exist until their first missing parent is created.
 */
export async function assertContainedNoLinks(
  root: string,
  target: string,
  options: { includeLeaf?: boolean; label?: string } = {},
): Promise<void> {
  const label = options.label ?? 'Dateipfad'
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ValidationError(`${label} verlässt den erlaubten Ordner.`)
  }

  const rootStat = await fs.lstat(resolvedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ValidationError(`${label}: Der Stammordner ist kein sicherer Ordner.`)
  }

  const parts = relative.split(path.sep)
  const checkedParts = options.includeLeaf ? parts : parts.slice(0, -1)
  let current = resolvedRoot
  for (let index = 0; index < checkedParts.length; index++) {
    current = path.join(current, checkedParts[index])
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) {
        throw new ValidationError(`${label} enthält einen symbolischen Link oder eine Junction.`)
      }
      if (index < checkedParts.length - 1 && !stat.isDirectory()) {
        throw new ValidationError(`${label} enthält einen ungültigen Elternpfad.`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

/** Validate a managed download destination and its resumable sidecar files. */
export async function assertSafeDownloadDestination(root: string, target: string, label?: string): Promise<void> {
  await assertContainedNoLinks(root, target, { includeLeaf: true, label })
  await assertContainedNoLinks(root, `${target}.part`, { includeLeaf: true, label })
  await assertContainedNoLinks(root, `${target}.part.json`, { includeLeaf: true, label })
}
