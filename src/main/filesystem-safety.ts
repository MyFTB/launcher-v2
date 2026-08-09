import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { ValidationError } from '../shared/validation'

interface SafeRegularFileOptions {
  maxBytes?: number
  label?: string
}

const OPEN_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
const READ_CHUNK_BYTES = 64 * 1024

function unsafeRegularFile(options: SafeRegularFileOptions): ValidationError {
  return new ValidationError(`${options.label ?? 'Datei'} ist keine sichere reguläre Datei.`)
}

function validateOpenedFile(
  descriptorStat: { dev: number; ino: number; size: number; isFile(): boolean },
  pathStat: { dev: number; ino: number; isFile(): boolean; isSymbolicLink(): boolean },
  options: SafeRegularFileOptions,
): void {
  if (
    !descriptorStat.isFile()
    || !pathStat.isFile()
    || pathStat.isSymbolicLink()
    || descriptorStat.dev !== pathStat.dev
    || descriptorStat.ino !== pathStat.ino
    || (options.maxBytes !== undefined && descriptorStat.size > options.maxBytes)
  ) throw unsafeRegularFile(options)
}

/** Open and validate one regular file without reopening its path after validation. The caller owns the handle. */
export async function openSafeRegularFile(
  filePath: string,
  options: SafeRegularFileOptions = {},
): Promise<Awaited<ReturnType<typeof fs.open>>> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | OPEN_NOFOLLOW)
    const [descriptorStat, pathStat] = await Promise.all([handle.stat(), fs.lstat(filePath)])
    validateOpenedFile(descriptorStat, pathStat, options)
    return handle
  } catch (error) {
    await handle?.close().catch(() => {})
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw unsafeRegularFile(options)
    throw error
  }
}

/** Read a size-bounded regular file through the descriptor that was validated. */
export async function readSafeRegularFile(
  filePath: string,
  options: SafeRegularFileOptions & { maxBytes: number },
): Promise<Buffer> {
  const handle = await openSafeRegularFile(filePath, options)
  try {
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, options.maxBytes - total + 1))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) return Buffer.concat(chunks, total)
      total += bytesRead
      if (total > options.maxBytes) throw unsafeRegularFile(options)
      chunks.push(chunk.subarray(0, bytesRead))
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Synchronous counterpart used by bootstrap before Electron is ready. */
export function readSafeRegularFileSync(
  filePath: string,
  options: SafeRegularFileOptions & { maxBytes: number },
): Buffer {
  let descriptor: number | undefined
  try {
    descriptor = openSync(filePath, fsConstants.O_RDONLY | OPEN_NOFOLLOW)
    validateOpenedFile(fstatSync(descriptor), lstatSync(filePath), options)

    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, options.maxBytes - total + 1))
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null)
      if (bytesRead === 0) return Buffer.concat(chunks, total)
      total += bytesRead
      if (total > options.maxBytes) throw unsafeRegularFile(options)
      chunks.push(chunk.subarray(0, bytesRead))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw unsafeRegularFile(options)
    throw error
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

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
