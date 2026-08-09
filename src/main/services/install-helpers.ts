export type ModLoader = 'forge' | 'neoforge' | 'fabric' | 'quilt' | 'vanilla'

export interface ModLoaderManifest {
  versionManifest: {
    id?: string
    libraries?: readonly { name: string }[]
  }
}

/**
 * Detect the mod loader from the manifest libraries, then from the version ID.
 */
export function detectModLoader(manifest: ModLoaderManifest): {
  loader: ModLoader
  libraryName: string | null
} {
  const libraries = manifest.versionManifest.libraries ?? []
  const versionId = manifest.versionManifest.id ?? ''

  for (const library of libraries) {
    if (
      library.name.includes('net.neoforged:neoforge:')
      || library.name.includes('net.neoforged:forge:')
    ) {
      return { loader: 'neoforge', libraryName: library.name }
    }
  }

  for (const library of libraries) {
    if (library.name.includes('net.minecraftforge:forge:')) {
      return { loader: 'forge', libraryName: library.name }
    }
  }

  const idMatch = versionId.match(/^(\d+\.\d+(?:\.\d+)?)-(?:(neoforge)|(forge))-(.+)$/)
  if (idMatch) {
    const [, mcVersion, neoToken, , forgeVersion] = idMatch
    if (neoToken) {
      return { loader: 'neoforge', libraryName: `net.neoforged:neoforge:${forgeVersion}` }
    }
    return {
      loader: 'forge',
      libraryName: `net.minecraftforge:forge:${mcVersion}-${forgeVersion}`,
    }
  }

  const neoShortMatch = versionId.match(/^neoforge-(.+)$/)
  if (neoShortMatch) {
    return {
      loader: 'neoforge',
      libraryName: `net.neoforged:neoforge:${neoShortMatch[1]}`,
    }
  }

  if (versionId.startsWith('fabric-loader-')) {
    return { loader: 'fabric', libraryName: versionId }
  }
  if (versionId.startsWith('quilt-loader-')) {
    return { loader: 'quilt', libraryName: versionId }
  }

  return { loader: 'vanilla', libraryName: null }
}

/** Extract the version portion from a Maven coordinate. */
export function extractMavenVersion(libraryName: string): string {
  const parts = libraryName.split(':')
  if (parts.length < 3) {
    throw new Error(`Cannot extract version from Maven coordinate: ${libraryName}`)
  }
  return parts[2]
}

/** Build the Forge coordinate shape required by @xmcl/installer. */
export function buildForgeEntry(
  mcversion: string,
  libraryName: string,
): { mcversion: string; version: string } {
  const mavenVersion = extractMavenVersion(libraryName)
  const minor = parseInt(mcversion.split('.')[1] ?? '0', 10)

  // Forge 1.7.x and 1.8.x expect only the build number.
  if (minor >= 7 && minor <= 8) {
    const prefix = `${mcversion}-`
    const suffix = `-${mcversion}`
    if (mavenVersion.startsWith(prefix) && mavenVersion.endsWith(suffix)) {
      return {
        mcversion,
        version: mavenVersion.slice(prefix.length, mavenVersion.length - suffix.length),
      }
    }
  }

  return { mcversion, version: mavenVersion }
}
