/**
 * API URLs and compile-time constants.
 * Ported from Constants.java — keep values in sync with the backend.
 */
export const Constants = {
  // ── Modpack server (packs.myftb.de) ─────────────────────────
  /** Object download: %s = hash/path from FileTask.location */
  launcherObjects: 'https://packs.myftb.de/packs/objects/%s',
  /** Pack list: %s = pack key */
  packList: 'https://packs.myftb.de/packs/packages.php?key=%s',
  /** Pack manifest: %s = reference.location */
  packManifest: 'https://packs.myftb.de/packs/%s',

  // ── Launcher metadata ────────────────────────────────────────
  /** Custom JRE index: %s = runtime identifier (e.g. 'runtime-linux') */
  runtimeIndex: 'https://launcher.myftb.de/%s.json',
  /** Pack logo fallback: %s = location without extension + '.png' */
  packLogoImage: 'https://launcher.myftb.de/images/%s',

  // ── Minecraft ────────────────────────────────────────────────
  versionManifestListUrl:
    'https://launchermeta.mojang.com/mc/game/version_manifest.json',
  minecraftResources: 'https://resources.download.minecraft.net/%s',

  // ── MyFTB services ───────────────────────────────────────────
  /** Hastebin-compatible paste endpoint */
  pasteTarget: 'https://paste.myftb.de',
  postsApi: 'https://myftb.de/api/posts',

  // ── Microsoft OAuth ──────────────────────────────────────────
  microsoftLoginClientId: 'e9b5325d-45dd-4f9b-b989-a4e23fa2e62b',
  microsoftOAuthScope: 'XboxLive.signin offline_access',
  microsoftOAuthRedirectPort: 25585,

  // ── Misc ─────────────────────────────────────────────────────
  connectTimeoutMs: 30_000,
  socketTimeoutMs: 90_000,
  discordAppId: '571102332771893268',
  logMaxLines: 10_000,
  /** How many recent packs to remember */
  recentPacksMax: 3,
  /** Image cache TTL in ms (3 days) */
  imageCacheTtlMs: 3 * 24 * 60 * 60 * 1000,
} as const

/** Replace %s placeholder with a value (mirrors Java String.format with single arg) */
export function fmt(template: string, ...args: string[]): string {
  let result = template
  for (const arg of args) {
    result = result.replace('%s', arg)
  }
  return result
}
