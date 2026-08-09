import type { ModpackManifestReference } from '@shared/types'

export interface MinecraftVersionOption {
  value: string
  count: number
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
