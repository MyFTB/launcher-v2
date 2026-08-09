import type { InstalledPackSummary, ModpackManifestReference } from '@shared/types'

export interface MinecraftVersionOption {
  value: string
  count: number
}

export type InstalledPackView = InstalledPackSummary & {
  /** Trusted package-list reference used for an available update. */
  updateReference?: ModpackManifestReference
}

/**
 * Combine local installed metadata with trusted package-list references.
 * A release-era local manifest may have no location; it still remains visible,
 * while update actions are exposed only when a matching remote reference exists.
 */
export function mergeInstalledPacks(
  installed: readonly InstalledPackSummary[],
  remote: readonly ModpackManifestReference[],
): InstalledPackView[] {
  const remoteByName = new Map(remote.map((pack) => [pack.name, pack]))
  return installed.map((local) => {
    const reference = remoteByName.get(local.name)
    return {
      ...local,
      ...(reference ?? {}),
      ...(reference && reference.version !== local.version
        ? { updateReference: reference }
        : {}),
    }
  })
}

const minecraftVersionCollator = new Intl.Collator('en-US', {
  numeric: true,
  sensitivity: 'variant',
  usage: 'sort',
})

function compareVersionsDescending(a: string, b: string): number {
  const collatorResult = minecraftVersionCollator.compare(b, a)
  if (collatorResult !== 0) return collatorResult

  // Preserve deterministic ordering when the collator considers two exact
  // strings equivalent.
  if (a === b) return 0
  return a < b ? 1 : -1
}

export function excludeInstalledPacks<T extends Pick<ModpackManifestReference, 'name'>>(
  remotePacks: readonly T[],
  installedNames: ReadonlySet<string>,
): T[] {
  return remotePacks.filter((pack) => !installedNames.has(pack.name))
}

export function getMinecraftVersionOptions<
  T extends Pick<ModpackManifestReference, 'gameVersion'>,
>(packs: readonly T[]): MinecraftVersionOption[] {
  const counts = new Map<string, number>()

  for (const pack of packs) {
    if (pack.gameVersion.trim() === '') continue
    counts.set(pack.gameVersion, (counts.get(pack.gameVersion) ?? 0) + 1)
  }

  return Array.from(counts, ([value, count]) => ({ value, count }))
    .sort((a, b) => compareVersionsDescending(a.value, b.value))
}

export function filterPacksByMinecraftVersion<
  T extends Pick<ModpackManifestReference, 'gameVersion'>,
>(packs: readonly T[], selectedVersion: string | null): T[] {
  if (selectedVersion === null) return [...packs]
  return packs.filter((pack) => pack.gameVersion === selectedVersion)
}

export function isMinecraftVersionSelectionValid(
  selectedVersion: string | null,
  options: readonly MinecraftVersionOption[],
): boolean {
  return selectedVersion === null || options.some((option) => option.value === selectedVersion)
}
