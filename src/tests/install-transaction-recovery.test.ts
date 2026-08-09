import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { recoverInterruptedTransactions } from '../main/services/install.service'

const sha256 = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex')

async function writeFile(filePath: string, contents: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents)
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('interrupted install transaction recovery', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  async function createInstance(): Promise<{ instanceDir: string; stagingDir: string }> {
    const instanceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myftb-install-recovery-'))
    roots.push(instanceDir)
    const stagingDir = path.join(instanceDir, '.myftb-staging', 'transaction')
    await fs.mkdir(stagingDir, { recursive: true })
    return { instanceDir, stagingDir }
  }

  it('removes an uncommitted first-install file and keeps the pack uninstalled', async () => {
    const { instanceDir, stagingDir } = await createInstance()
    const newFile = Buffer.from('new managed file')
    const manifest = Buffer.from('{"name":"Pack","version":"2"}\n')
    const features = Buffer.from('[]\n')
    await writeFile(path.join(instanceDir, 'mods', 'new.jar'), newFile)
    await writeFile(path.join(stagingDir, '.transaction.json'), JSON.stringify({
      version: 1,
      kind: 'managed',
      marker: 'manifest.json',
      newMarkerHash: sha256(manifest),
      newAuxiliaryHash: sha256(features),
      previousMarkerHash: null,
      previousMarkerPresent: false,
      previousAuxiliaryPresent: false,
      targets: [{ path: 'mods/new.jar', hadOriginal: false, newHash: sha256(newFile) }],
      removed: [],
    }))

    await recoverInterruptedTransactions(instanceDir)

    expect(await exists(path.join(instanceDir, 'mods', 'new.jar'))).toBe(false)
    expect(await exists(path.join(instanceDir, 'manifest.json'))).toBe(false)
    expect(await exists(stagingDir)).toBe(false)
  })

  it('restores replaced and stale files plus the previous metadata', async () => {
    const { instanceDir, stagingDir } = await createInstance()
    const oldManifest = Buffer.from('{"name":"Pack","version":"1"}\n')
    const newManifest = Buffer.from('{"name":"Pack","version":"2"}\n')
    const oldFeatures = Buffer.from('["old"]\n')
    const newFeatures = Buffer.from('["new"]\n')
    const oldFile = Buffer.from('old file')
    const newFile = Buffer.from('new file')
    const staleFile = Buffer.from('stale file')

    await writeFile(path.join(instanceDir, 'manifest.json'), oldManifest)
    await writeFile(path.join(instanceDir, 'selected-features.json'), newFeatures)
    await writeFile(path.join(instanceDir, 'mods', 'current.jar'), newFile)
    await writeFile(path.join(stagingDir, 'rollback', 'replaced', 'mods', 'current.jar'), oldFile)
    await writeFile(path.join(stagingDir, 'rollback', 'stale', 'mods', 'old.jar'), staleFile)
    await writeFile(path.join(stagingDir, '.transaction.previous-marker'), oldManifest)
    await writeFile(path.join(stagingDir, '.transaction.previous-auxiliary'), oldFeatures)
    await writeFile(path.join(stagingDir, '.transaction.json'), JSON.stringify({
      version: 1,
      kind: 'managed',
      marker: 'manifest.json',
      newMarkerHash: sha256(newManifest),
      newAuxiliaryHash: sha256(newFeatures),
      previousMarkerHash: sha256(oldManifest),
      previousMarkerPresent: true,
      previousAuxiliaryPresent: true,
      targets: [{ path: 'mods/current.jar', hadOriginal: true, newHash: sha256(newFile) }],
      removed: ['mods/old.jar'],
    }))

    await recoverInterruptedTransactions(instanceDir)

    await expect(fs.readFile(path.join(instanceDir, 'mods', 'current.jar'))).resolves.toEqual(oldFile)
    await expect(fs.readFile(path.join(instanceDir, 'mods', 'old.jar'))).resolves.toEqual(staleFile)
    await expect(fs.readFile(path.join(instanceDir, 'manifest.json'))).resolves.toEqual(oldManifest)
    await expect(fs.readFile(path.join(instanceDir, 'selected-features.json'))).resolves.toEqual(oldFeatures)
    expect(await exists(stagingDir)).toBe(false)
  })

  it('finalizes a completed repair even when its manifest did not change', async () => {
    const { instanceDir, stagingDir } = await createInstance()
    const manifest = Buffer.from('{"name":"Pack","version":"1"}\n')
    const features = Buffer.from('[]\n')
    const corruptFile = Buffer.from('corrupt')
    const repairedFile = Buffer.from('repaired')

    await writeFile(path.join(instanceDir, 'manifest.json'), manifest)
    await writeFile(path.join(instanceDir, 'selected-features.json'), features)
    await writeFile(path.join(instanceDir, 'mods', 'file.jar'), repairedFile)
    await writeFile(path.join(stagingDir, 'rollback', 'replaced', 'mods', 'file.jar'), corruptFile)
    await writeFile(path.join(stagingDir, '.transaction.previous-marker'), manifest)
    await writeFile(path.join(stagingDir, '.transaction.previous-auxiliary'), features)
    await writeFile(path.join(stagingDir, '.transaction.json'), JSON.stringify({
      version: 1,
      kind: 'managed',
      marker: 'manifest.json',
      newMarkerHash: sha256(manifest),
      newAuxiliaryHash: sha256(features),
      previousMarkerHash: sha256(manifest),
      previousMarkerPresent: true,
      previousAuxiliaryPresent: true,
      targets: [{ path: 'mods/file.jar', hadOriginal: true, newHash: sha256(repairedFile) }],
      removed: [],
    }))

    await recoverInterruptedTransactions(instanceDir)

    await expect(fs.readFile(path.join(instanceDir, 'mods', 'file.jar'))).resolves.toEqual(repairedFile)
    expect(await exists(stagingDir)).toBe(false)
  })

  it('preserves both copies and stops when a live file changed after the crash', async () => {
    const { instanceDir, stagingDir } = await createInstance()
    const oldManifest = Buffer.from('{"name":"Pack","version":"1"}\n')
    const newManifest = Buffer.from('{"name":"Pack","version":"2"}\n')
    const features = Buffer.from('[]\n')
    const oldFile = Buffer.from('old')
    const expectedNewFile = Buffer.from('expected new')
    const userChange = Buffer.from('changed after crash')

    await writeFile(path.join(instanceDir, 'manifest.json'), oldManifest)
    await writeFile(path.join(instanceDir, 'selected-features.json'), features)
    await writeFile(path.join(instanceDir, 'mods', 'file.jar'), userChange)
    const backupPath = path.join(stagingDir, 'rollback', 'replaced', 'mods', 'file.jar')
    await writeFile(backupPath, oldFile)
    await writeFile(path.join(stagingDir, '.transaction.previous-marker'), oldManifest)
    await writeFile(path.join(stagingDir, '.transaction.previous-auxiliary'), features)
    await writeFile(path.join(stagingDir, '.transaction.json'), JSON.stringify({
      version: 1,
      kind: 'managed',
      marker: 'manifest.json',
      newMarkerHash: sha256(newManifest),
      newAuxiliaryHash: sha256(features),
      previousMarkerHash: sha256(oldManifest),
      previousMarkerPresent: true,
      previousAuxiliaryPresent: true,
      targets: [{ path: 'mods/file.jar', hadOriginal: true, newHash: sha256(expectedNewFile) }],
      removed: [],
    }))

    await expect(recoverInterruptedTransactions(instanceDir)).rejects.toThrow(/verändert/)
    await expect(fs.readFile(path.join(instanceDir, 'mods', 'file.jar'))).resolves.toEqual(userChange)
    await expect(fs.readFile(backupPath)).resolves.toEqual(oldFile)
    expect(await exists(stagingDir)).toBe(true)
  })

  it('rejects a symlinked rollback backup without following or restoring it', async () => {
    const { instanceDir, stagingDir } = await createInstance()
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'myftb-install-recovery-outside-'))
    roots.push(outside)
    const oldManifest = Buffer.from('{"name":"Pack","version":"1"}\n')
    const newManifest = Buffer.from('{"name":"Pack","version":"2"}\n')
    const features = Buffer.from('[]\n')
    const newFile = Buffer.from('new')
    const sentinel = path.join(outside, 'sentinel.txt')
    await writeFile(sentinel, 'outside')

    await writeFile(path.join(instanceDir, 'manifest.json'), oldManifest)
    await writeFile(path.join(instanceDir, 'selected-features.json'), features)
    await writeFile(path.join(instanceDir, 'mods', 'file.jar'), newFile)
    const backupPath = path.join(stagingDir, 'rollback', 'replaced', 'mods', 'file.jar')
    await fs.mkdir(path.dirname(backupPath), { recursive: true })
    await fs.symlink(outside, backupPath, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(path.join(stagingDir, '.transaction.previous-marker'), oldManifest)
    await writeFile(path.join(stagingDir, '.transaction.previous-auxiliary'), features)
    await writeFile(path.join(stagingDir, '.transaction.json'), JSON.stringify({
      version: 1,
      kind: 'managed',
      marker: 'manifest.json',
      newMarkerHash: sha256(newManifest),
      newAuxiliaryHash: sha256(features),
      previousMarkerHash: sha256(oldManifest),
      previousMarkerPresent: true,
      previousAuxiliaryPresent: true,
      targets: [{ path: 'mods/file.jar', hadOriginal: true, newHash: sha256(newFile) }],
      removed: [],
    }))

    await expect(recoverInterruptedTransactions(instanceDir)).rejects.toThrow(/Link|Junction|sicher/)
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('outside')
    expect(await exists(backupPath)).toBe(true)
  })
})
