import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { DataRecoveryState } from '../shared/types'
import { parseDataDirPointer } from '../shared/pointer-file'
import { readSafeRegularFileSync } from './filesystem-safety'

let pointerRecovery: DataRecoveryState = { status: 'ok' }

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

export function getPointerPath(): string {
  return path.join(getBootstrapDir(), 'datadir.json')
}

export function getPointerBackupPath(): string {
  return `${getPointerPath()}.bak`
}

function validatePointerTarget(candidate: string | null): string | null {
  if (!candidate || !path.isAbsolute(candidate)) return null
  const resolved = path.resolve(candidate)
  try {
    const stat = lstatSync(resolved)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
  } catch {
    return null
  }
  return resolved
}

function readValidPointer(pointerPath: string): string | null {
  const raw = readSafeRegularFileSync(pointerPath, {
    maxBytes: 64 * 1024,
    label: 'Datenspeicherzeiger',
  }).toString('utf8')
  return validatePointerTarget(parseDataDirPointer(raw))
}

/**
 * Read the fixed bootstrap pointer before app.whenReady(). Invalid pointers are
 * reported to the recovery UI instead of being treated as a first launch.
 */
export function readDataDirFromDisk(): string | null {
  const pointerPath = getPointerPath()
  try {
    const target = readValidPointer(pointerPath)
    if (!target) throw new Error('Pointer target is invalid or unavailable')
    pointerRecovery = { status: 'ok' }
    return target
  } catch (error) {
    const primaryMissing = (error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(pointerPath)

    try {
      const backupTarget = readValidPointer(getPointerBackupPath())
      if (backupTarget) {
        const contents = `${JSON.stringify({ version: 1, dataDir: backupTarget }, null, 2)}\n`
        try {
          atomicWritePointer(pointerPath, contents)
          pointerRecovery = {
            status: 'recovered-backup',
            source: 'pointer',
            message: 'Der Datenspeicherort wurde aus der Sicherung wiederhergestellt.',
            brokenPath: pointerPath,
            backupAvailable: true,
          }
        } catch {
          pointerRecovery = {
            status: 'recovered-backup',
            source: 'pointer',
            message: 'Die Sicherung wurde verwendet, der beschädigte Datenzeiger konnte aber noch nicht repariert werden.',
            brokenPath: pointerPath,
            backupAvailable: true,
          }
        }
        return backupTarget
      }
    } catch {
      // Recovery state below retains the invalid primary for manual action.
    }

    if (primaryMissing && !existsSync(getPointerBackupPath())) {
      pointerRecovery = { status: 'ok' }
      return null
    }

    pointerRecovery = {
      status: 'needs-recovery',
      source: 'pointer',
      message: 'Der gespeicherte Datenordner ist nicht erreichbar. Der Launcher hat keine Daten überschrieben.',
      brokenPath: pointerPath,
      backupAvailable: false,
    }
    return null
  }
}

function atomicWritePointer(target: string, contents: string): void {
  const directory = path.dirname(target)
  mkdirSync(directory, { recursive: true })
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, contents, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, target)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

export function writeDataDirPointer(dataDir: string): void {
  const target = validatePointerTarget(dataDir)
  if (!target) throw new Error('Der ausgewählte Datenordner ist ungültig oder nicht erreichbar.')
  const contents = `${JSON.stringify({ version: 1, dataDir: target }, null, 2)}\n`
  // Commit the recovery copy first and the authoritative primary last. If the
  // second write fails, startup can still recover to the already-complete tree.
  atomicWritePointer(getPointerBackupPath(), contents)
  atomicWritePointer(getPointerPath(), contents)
  pointerRecovery = { status: 'ok' }
}

export function clearDataDirPointer(): void {
  rmSync(getPointerPath(), { force: true })
  rmSync(getPointerBackupPath(), { force: true })
  pointerRecovery = { status: 'ok' }
}

export function getBootstrapRecoveryState(): DataRecoveryState {
  return { ...pointerRecovery }
}
