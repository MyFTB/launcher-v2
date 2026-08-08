const VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function isSupportedUpdateVersion(value: string): boolean {
  return VERSION_RE.test(value)
}

/** Compare two validated SemVer-like updater versions without adding a runtime dependency. */
export function compareUpdateVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; prerelease: string[] } => {
    if (!isSupportedUpdateVersion(value)) throw new Error('Invalid update version')
    const withoutBuild = value.split('+', 1)[0]
    const separator = withoutBuild.indexOf('-')
    const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator)
    const prerelease = separator === -1 ? '' : withoutBuild.slice(separator + 1)
    return { core: core.split('.').map(Number), prerelease: prerelease ? prerelease.split('.') : [] }
  }

  const leftVersion = parse(left)
  const rightVersion = parse(right)
  for (let index = 0; index < 3; index++) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] > rightVersion.core[index] ? 1 : -1
    }
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    if (leftVersion.prerelease.length === rightVersion.prerelease.length) return 0
    return leftVersion.prerelease.length === 0 ? 1 : -1
  }

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < length; index++) {
    const leftPart = leftVersion.prerelease[index]
    const rightPart = rightVersion.prerelease[index]
    if (leftPart === rightPart) continue
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1
    if (leftNumber !== null) return -1
    if (rightNumber !== null) return 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}
