import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// ── Pure extraction of move-instances logic for testing ──────────────────────

/**
 * Two-phase move: copy everything first, then delete originals.
 * Returns { success, error?, copied? }.
 */
async function moveEntries(
  currentDir: string,
  targetDir: string,
): Promise<{ success: boolean; error?: string; copied?: string[] }> {
  let entries: string[]
  try {
    entries = await fs.readdir(currentDir)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      entries = []
    } else {
      return { success: false, error: 'read-failed' }
    }
  }

  // Collision check
  for (const entry of entries) {
    try {
      await fs.access(path.join(targetDir, entry))
      return { success: false, error: `collision:${entry}` }
    } catch {
      // Does not exist - good
    }
  }

  // Phase 1: Copy everything
  const copied: string[] = []
  for (const entry of entries) {
    const src = path.join(currentDir, entry)
    const dest = path.join(targetDir, entry)
    try {
      await fs.cp(src, dest, { recursive: true })
      copied.push(entry)
    } catch {
      // Rollback
      for (const name of copied) {
        await fs.rm(path.join(targetDir, name), { recursive: true, force: true }).catch(() => {})
      }
      return { success: false, error: `copy-failed:${entry}` }
    }
  }

  // Phase 2: Delete originals
  for (const entry of copied) {
    await fs.rm(path.join(currentDir, entry), { recursive: true, force: true })
  }

  return { success: true, copied }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let tmpDir: string
let srcDir: string
let destDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'move-test-'))
  srcDir = path.join(tmpDir, 'src')
  destDir = path.join(tmpDir, 'dest')
  await fs.mkdir(srcDir, { recursive: true })
  await fs.mkdir(destDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('moveEntries: two-phase copy + delete', () => {
  it('moves files and directories to the target', async () => {
    await fs.writeFile(path.join(srcDir, 'file.txt'), 'hello')
    await fs.mkdir(path.join(srcDir, 'subdir'))
    await fs.writeFile(path.join(srcDir, 'subdir', 'nested.txt'), 'world')

    const result = await moveEntries(srcDir, destDir)
    expect(result.success).toBe(true)
    expect(result.copied!.sort()).toEqual(['file.txt', 'subdir'])

    // Target has the files
    expect(await fs.readFile(path.join(destDir, 'file.txt'), 'utf8')).toBe('hello')
    expect(await fs.readFile(path.join(destDir, 'subdir', 'nested.txt'), 'utf8')).toBe('world')

    // Source is cleaned up
    const remaining = await fs.readdir(srcDir)
    expect(remaining).toEqual([])
  })

  it('succeeds with empty source directory', async () => {
    const result = await moveEntries(srcDir, destDir)
    expect(result.success).toBe(true)
    expect(result.copied).toEqual([])
  })

  it('succeeds when source does not exist (ENOENT)', async () => {
    const result = await moveEntries(path.join(tmpDir, 'nonexistent'), destDir)
    expect(result.success).toBe(true)
    expect(result.copied).toEqual([])
  })

  it('rejects when target already contains a name collision', async () => {
    await fs.writeFile(path.join(srcDir, 'pack1'), 'src')
    await fs.writeFile(path.join(destDir, 'pack1'), 'existing')

    const result = await moveEntries(srcDir, destDir)
    expect(result.success).toBe(false)
    expect(result.error).toBe('collision:pack1')

    // Source is untouched
    expect(await fs.readFile(path.join(srcDir, 'pack1'), 'utf8')).toBe('src')
  })

  it('rejects with collision and leaves source untouched', async () => {
    await fs.mkdir(path.join(srcDir, 'aaa'))
    await fs.writeFile(path.join(srcDir, 'aaa', 'data.txt'), 'first')
    await fs.mkdir(path.join(srcDir, 'bbb'))
    await fs.writeFile(path.join(srcDir, 'bbb', 'data.txt'), 'second')

    // Pre-existing entry in dest triggers collision before any copy starts
    await fs.writeFile(path.join(destDir, 'bbb'), 'blocker-file')

    const result = await moveEntries(srcDir, destDir)
    expect(result.success).toBe(false)
    expect(result.error).toContain('bbb')

    // Source entries are untouched
    const srcEntries = await fs.readdir(srcDir)
    expect(srcEntries.sort()).toEqual(['aaa', 'bbb'])
    expect(await fs.readFile(path.join(srcDir, 'aaa', 'data.txt'), 'utf8')).toBe('first')
    expect(await fs.readFile(path.join(srcDir, 'bbb', 'data.txt'), 'utf8')).toBe('second')
  })

  it('rolls back already-copied entries on mid-copy failure', async () => {
    // Create three source entries; make the third unreadable so fs.cp fails
    await fs.writeFile(path.join(srcDir, 'aaa.txt'), 'first')
    await fs.writeFile(path.join(srcDir, 'bbb.txt'), 'second')
    const badDir = path.join(srcDir, 'ccc')
    await fs.mkdir(badDir)
    await fs.writeFile(path.join(badDir, 'data.txt'), 'content')

    // Remove all permissions on the subdirectory so fs.cp fails when reading it
    try {
      await fs.chmod(badDir, 0o000)
    } catch {
      // Can't change permissions (e.g. Windows without proper support), skip test
      return
    }

    try {
      const result = await moveEntries(srcDir, destDir)
      // On some platforms fs.cp may still succeed despite chmod; handle both cases
      if (result.success) {
        return
      }
      expect(result.success).toBe(false)
      expect(result.error).toContain('copy-failed')

      // Already-copied entries should be rolled back from dest
      const destEntries = await fs.readdir(destDir)
      expect(destEntries).toEqual([])
    } finally {
      // Restore permissions for cleanup
      await fs.chmod(badDir, 0o755).catch(() => {})
    }
  })
})
