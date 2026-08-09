import { ValidationError } from '../../shared/validation'

const EXTERNAL_HOSTS = new Set([
  'myftb.de',
  'www.myftb.de',
  'minecraft.net',
  'www.minecraft.net',
  'account.microsoft.com',
  'login.live.com',
  'discord.gg',
])

const PACK_ASSET_HOSTS = new Set([
  'packs.myftb.de',
  'launcher.myftb.de',
])

function parseSecureUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

export function isAllowedExternalUrl(value: unknown): value is string {
  const url = parseSecureUrl(value)
  return !!url && EXTERNAL_HOSTS.has(url.hostname.toLowerCase())
}

export function assertAllowedExternalUrl(value: unknown): string {
  if (!isAllowedExternalUrl(value)) {
    throw new ValidationError('Diese externe Adresse ist nicht erlaubt.')
  }
  return value
}

export function isAllowedPackAssetUrl(value: unknown): value is string {
  const url = parseSecureUrl(value)
  return !!url && PACK_ASSET_HOSTS.has(url.hostname.toLowerCase())
}

export function assertAllowedPackAssetUrl(value: unknown): string {
  if (!isAllowedPackAssetUrl(value)) {
    throw new ValidationError('Die Bildadresse stammt nicht von einem erlaubten Pack-Server.')
  }
  return value
}
