import fs from 'node:fs/promises'
import path from 'node:path'
import { app, safeStorage } from 'electron'

import type { LegacyCredential } from '../../shared/validation'
import { atomicWriteFile } from './config.service'
import { logger } from '../logger'

export interface AuthCredential {
  minecraftAccessToken: string
  oauthRefreshToken: string
}

interface CredentialFile {
  version: 1
  profiles: Record<string, AuthCredential>
}

class CredentialService {
  private credentials = new Map<string, AuthCredential>()
  private persistent = false
  private initialized = false
  private initialization: Promise<void> | null = null
  private writeQueue: Promise<void> = Promise.resolve()

  private get filePath(): string {
    return path.join(app.getPath('userData'), 'credentials.bin')
  }

  isPersistent(): boolean {
    return this.persistent
  }

  private detectPersistence(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform === 'linux') {
      try {
        return safeStorage.getSelectedStorageBackend() !== 'basic_text'
      } catch {
        return false
      }
    }
    return true
  }

  async initialize(legacyCredentials: LegacyCredential[] = []): Promise<void> {
    if (this.initialized) return
    if (this.initialization) return this.initialization
    const operation = this.doInitialize(legacyCredentials)
    this.initialization = operation
    try {
      await operation
      this.initialized = true
    } catch (error) {
      // Keep migrated credentials in memory; a later recovery action may retry
      // initialization and persistence with the still-intact legacy config.
      throw error
    } finally {
      if (Object.is(this.initialization, operation)) this.initialization = null
    }
  }

  private async doInitialize(legacyCredentials: LegacyCredential[]): Promise<void> {
    this.persistent = this.detectPersistence()
    this.credentials.clear()

    if (this.persistent) {
      try {
        const stat = await fs.lstat(this.filePath)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) {
          throw new Error('Credential store is not a safe regular file')
        }
        const encrypted = await fs.readFile(this.filePath)
        const decrypted = safeStorage.decryptString(encrypted)
        const parsed = JSON.parse(decrypted) as CredentialFile
        if (parsed.version !== 1 || typeof parsed.profiles !== 'object' || parsed.profiles === null) {
          throw new Error('Unsupported credential-store format')
        }
        for (const [uuid, credential] of Object.entries(parsed.profiles).slice(0, 50)) {
          if (
            credential
            && typeof credential.minecraftAccessToken === 'string'
            && credential.minecraftAccessToken.length <= 16_384
            && typeof credential.oauthRefreshToken === 'string'
            && credential.oauthRefreshToken.length <= 16_384
          ) {
            this.credentials.set(uuid, { ...credential })
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          const preservedPath = `${this.filePath}.unreadable-${Date.now()}`
          await fs.rename(this.filePath, preservedPath).catch(() => {})
          logger.warn('[CredentialService] Secure credential store could not be read and was quarantined; login may be required again')
        }
      }
    } else {
      logger.warn('[CredentialService] No secure OS keyring is available; credentials will be kept for this session only')
    }

    let migrated = false
    for (const legacy of legacyCredentials) {
      if (!this.credentials.has(legacy.uuid)) {
        this.credentials.set(legacy.uuid, {
          minecraftAccessToken: legacy.minecraftAccessToken,
          oauthRefreshToken: legacy.oauthRefreshToken,
        })
        migrated = true
      }
    }
    if (migrated && this.persistent) await this.persist()
  }

  async importLegacy(legacyCredentials: LegacyCredential[]): Promise<void> {
    if (!this.initialized) {
      await this.initialize(legacyCredentials)
      return
    }
    let changed = false
    for (const legacy of legacyCredentials) {
      if (this.credentials.has(legacy.uuid)) continue
      this.credentials.set(legacy.uuid, {
        minecraftAccessToken: legacy.minecraftAccessToken,
        oauthRefreshToken: legacy.oauthRefreshToken,
      })
      changed = true
    }
    if (changed || (legacyCredentials.length > 0 && this.persistent)) await this.persist()
  }

  get(uuid: string): AuthCredential | undefined {
    const credential = this.credentials.get(uuid)
    return credential ? { ...credential } : undefined
  }

  async set(uuid: string, credential: AuthCredential): Promise<void> {
    this.credentials.set(uuid, { ...credential })
    await this.persist()
  }

  async delete(uuid: string): Promise<void> {
    this.credentials.delete(uuid)
    await this.persist()
  }

  /** Wait until every encrypted-store write has settled. */
  async flush(): Promise<void> {
    await this.writeQueue
  }

  private persist(): Promise<void> {
    if (!this.persistent) return Promise.resolve()
    const profiles = Object.fromEntries(
      [...this.credentials.entries()].map(([uuid, credential]) => [uuid, { ...credential }]),
    )
    const snapshot: CredentialFile = { version: 1, profiles }
    const operation = this.writeQueue.then(async () => {
      const encrypted = safeStorage.encryptString(JSON.stringify(snapshot))
      await atomicWriteFile(this.filePath, encrypted)
    })
    this.writeQueue = operation.catch(() => {})
    return operation
  }
}

export const credentialService = new CredentialService()
