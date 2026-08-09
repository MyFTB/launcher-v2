export class PackOperationConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackOperationConflictError'
  }
}

class PackOperationService {
  private readonly launches = new Map<string, string>()
  private readonly mutations = new Map<string, string>()
  private readonly readers = new Map<string, Map<string, number>>()

  /** Use a cross-platform key so case-insensitive filesystems cannot alias packs. */
  private key(packName: string): string {
    return packName.normalize('NFC').toLocaleLowerCase('en-US')
  }

  reserveLaunch(packName: string, owner: string): void {
    const key = this.key(packName)
    const existingLaunch = this.launches.get(key)
    if (existingLaunch && existingLaunch !== owner) {
      throw new PackOperationConflictError(`„${packName}“ wird bereits gestartet oder läuft.`)
    }
    const mutation = this.mutations.get(key)
    if (mutation && mutation !== owner) {
      throw new PackOperationConflictError(`„${packName}“ wird gerade installiert oder repariert.`)
    }
    this.launches.set(key, owner)
  }

  releaseLaunch(packName: string, owner: string): void {
    const key = this.key(packName)
    if (this.launches.get(key) === owner) this.launches.delete(key)
  }

  beginRead(packName: string, owner: string): void {
    const key = this.key(packName)
    const mutation = this.mutations.get(key)
    if (mutation && mutation !== owner) {
      throw new PackOperationConflictError(`„${packName}“ wird gerade verändert.`)
    }
    const owners = this.readers.get(key) ?? new Map<string, number>()
    owners.set(owner, (owners.get(owner) ?? 0) + 1)
    this.readers.set(key, owners)
  }

  endRead(packName: string, owner: string): void {
    const key = this.key(packName)
    const owners = this.readers.get(key)
    if (!owners) return
    const count = owners.get(owner) ?? 0
    if (count <= 1) owners.delete(owner)
    else owners.set(owner, count - 1)
    if (owners.size === 0) this.readers.delete(key)
  }

  beginMutation(packName: string, owner: string): void {
    const key = this.key(packName)
    const launch = this.launches.get(key)
    if (launch && launch !== owner) {
      throw new PackOperationConflictError(`„${packName}“ läuft und kann nicht verändert werden.`)
    }
    const mutation = this.mutations.get(key)
    if (mutation && mutation !== owner) {
      throw new PackOperationConflictError(`„${packName}“ wird bereits verändert.`)
    }
    const readers = this.readers.get(key)
    if (readers && [...readers.keys()].some((reader) => reader !== owner)) {
      throw new PackOperationConflictError(`„${packName}“ wird gerade geprüft.`)
    }
    this.mutations.set(key, owner)
  }

  endMutation(packName: string, owner: string): void {
    const key = this.key(packName)
    if (this.mutations.get(key) === owner) this.mutations.delete(key)
  }

  isRunning(packName: string): boolean {
    return this.launches.has(this.key(packName))
  }

  isMutating(packName: string): boolean {
    return this.mutations.has(this.key(packName))
  }

  isReading(packName: string): boolean {
    return this.readers.has(this.key(packName))
  }
}

export const packOperationService = new PackOperationService()
