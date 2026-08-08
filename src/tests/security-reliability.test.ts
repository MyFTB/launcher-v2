import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Response } from 'undici'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../shared/types'
import { compareUpdateVersions, isSupportedUpdateVersion } from '../shared/version'
import {
  assertPackName,
  assertSafeRelativePath,
  assertUpdateChannel,
  parseLauncherConfig,
  validateAuthSwitchProfilePayload,
  validateRendererConfigPatch,
  validateJvmArgumentString,
  validateModpackManifest,
} from '../shared/validation'
import { isStrongHash, normalizeHash } from '../main/download-manager'
import {
  isRetryableNetworkError,
  isRetryableStatus,
  parseRetryAfter,
  readJsonResponseLimited,
} from '../main/fetch-retry'
import { redactSensitiveLogData } from '../main/logger'
import { packOperationService } from '../main/services/pack-operation.service'
import { resolveActiveTasks, resolveTaskPathCollisions } from '../main/services/install.service'
import { assertSafeDownloadDestination } from '../main/filesystem-safety'
import { isAllowedExternalUrl } from '../main/security/url-policy'

describe('validated account-switch contract', () => {
  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

  it('accepts the documented { uuid } payload', () => {
    expect(validateAuthSwitchProfilePayload({ uuid })).toEqual({ uuid })
  })

  it('rejects the former raw-string shape instead of coercing it to [object Object]', () => {
    expect(() => validateAuthSwitchProfilePayload(uuid)).toThrow(/Account-Auswahl/)
    expect(() => validateAuthSwitchProfilePayload({ uuid: '[object Object]' })).toThrow(/Profil-ID/)
  })

  it('rejects malformed UUIDs', () => {
    expect(() => validateAuthSwitchProfilePayload({ uuid: 'unknown' })).toThrow(/Profil-ID/)
  })
})

describe('config schema and credential migration', () => {
  it('extracts legacy plaintext credentials and strips them from config', () => {
    const parsed = parseLauncherConfig({
      ...DEFAULT_CONFIG,
      profileStore: {
        selectedProfileUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        profiles: [{
          provider: 'microsoft',
          uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          lastKnownUsername: 'TestUser',
          minecraftAccessToken: 'minecraft-secret',
          oauthRefreshToken: 'oauth-secret',
        }],
      },
    }, DEFAULT_CONFIG)

    expect(parsed.legacyCredentials).toEqual([{
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      minecraftAccessToken: 'minecraft-secret',
      oauthRefreshToken: 'oauth-secret',
    }])
    expect(parsed.config.profileStore.profiles[0]).not.toHaveProperty('minecraftAccessToken')
    expect(parsed.config.profileStore.profiles[0]).not.toHaveProperty('oauthRefreshToken')
  })

  it('rejects future config versions instead of silently downgrading their data', () => {
    expect(() => parseLauncherConfig({ ...DEFAULT_CONFIG, version: DEFAULT_CONFIG.version + 1 }, DEFAULT_CONFIG)).toThrow(/nicht unterstützten/)
  })

  it('rejects attempts to mutate main-process-only config', () => {
    expect(() => validateRendererConfigPatch({ clientToken: 'stolen' })).toThrow(/darf nicht geändert/)
    expect(() => validateRendererConfigPatch({ profileStore: { profiles: [] } })).toThrow(/darf nicht geändert/)
    expect(() => validateRendererConfigPatch({ updateChannel: 'experimental' })).toThrow(/darf nicht geändert/)
    expect(() => validateRendererConfigPatch({ packConfigs: [] })).toThrow(/Modpack-Einstellungen/)
    expect(() => validateRendererConfigPatch({ packConfigs: { Pack: { maxMemory: 'lots' } } })).toThrow(/maxMemory/)
    expect(() => validateRendererConfigPatch({ packConfigs: { Pack: { unknown: true } } })).toThrow(/unbekannte/)
  })

  it('rejects JVM agent, classpath, and native injection flags', () => {
    expect(() => validateJvmArgumentString('-javaagent:/tmp/evil.jar')).toThrow(/nicht erlaubt/)
    expect(() => validateJvmArgumentString('-Djava.library.path=/tmp/evil')).toThrow(/nicht erlaubt/)
    expect(() => validateJvmArgumentString('--module-path=/tmp/modules')).toThrow(/nicht erlaubt/)
    expect(() => validateJvmArgumentString('@downloaded-arguments.txt')).toThrow(/nicht erlaubt/)
    expect(() => validateJvmArgumentString('-XX:Flags=/tmp/remote.flags')).toThrow(/nicht erlaubt/)
    expect(() => validateJvmArgumentString('-Djava.system.class.loader=Evil')).toThrow(/nicht erlaubt/)
    expect(validateJvmArgumentString('-XX:+UseG1GC -Xss1m')).toBe('-XX:+UseG1GC -Xss1m')
  })
})

describe('path and update-channel validation', () => {
  it('rejects traversal and reserved pack names', () => {
    expect(() => assertPackName('../escape')).toThrow()
    expect(() => assertPackName('CON')).toThrow()
    expect(assertPackName('All the Mods 10')).toBe('All the Mods 10')
  })

  it('rejects platform aliases, traversal, and unsafe path components', () => {
    expect(() => assertSafeRelativePath('mods/../escape.jar')).toThrow()
    expect(() => assertSafeRelativePath('mods/./alias.jar')).toThrow()
    expect(() => assertSafeRelativePath('mods/file.jar.')).toThrow()
    expect(() => assertSafeRelativePath('mods/CON.txt')).toThrow()
    expect(() => assertSafeRelativePath('mods/file:stream')).toThrow()
    expect(assertSafeRelativePath('mods/example.jar')).toBe('mods/example.jar')
  })

  it('rejects exact duplicate and overlapping managed destinations', () => {
    const base = {
      name: 'Pack', title: 'Pack', version: '1', gameVersion: '1.20.1', location: 'pack.json',
      versionManifest: { id: '1.20.1' },
    }
    const task = (to: string) => ({ hash: 'a'.repeat(64), location: 'objects/file', to, userFile: false })
    expect(() => validateModpackManifest({ ...base, tasks: [task('mods/a.jar'), task('mods/a.jar')] })).toThrow(/eindeutig/)
    expect(() => validateModpackManifest({ ...base, tasks: [task('config'), task('config/settings.json')] })).toThrow(/überlappen/)
    expect(() => validateModpackManifest({
      ...base,
      tasks: [task('config'), task('config-backup'), task('config/settings.json')],
    })).toThrow(/überlappen/)
    expect(validateModpackManifest({ ...base, tasks: [task('mods/a.jar'), task('config/settings.json')] }).tasks).toHaveLength(2)
  })

  it('accepts backend case variants and resolves them safely for case-insensitive filesystems', () => {
    const base = {
      name: 'Pack', title: 'Pack', version: '1', gameVersion: '1.20.1', location: 'pack.json',
      versionManifest: { id: '1.20.1' },
    }
    const task = (to: string, hash: string) => ({ hash, location: `objects/${hash}`, to, userFile: false })
    const manifest = validateModpackManifest({
      ...base,
      tasks: [task('config/buildcraft/objects.cfg', 'a'.repeat(64)), task('config/Buildcraft/objects.cfg', 'b'.repeat(64))],
    })

    expect(resolveTaskPathCollisions(manifest.tasks ?? [], false)).toHaveLength(2)
    expect(resolveTaskPathCollisions(manifest.tasks ?? [], true)).toEqual([
      expect.objectContaining({ to: 'config/Buildcraft/objects.cfg', hash: 'b'.repeat(64) }),
    ])

    const nested = validateModpackManifest({
      ...base,
      tasks: [task('Config', 'a'.repeat(64)), task('config/settings.json', 'b'.repeat(64))],
    })
    expect(() => resolveTaskPathCollisions(nested.tasks ?? [], true)).toThrow(/überlappen/)

    const gated = validateModpackManifest({
      ...base,
      tasks: [
        { ...task('config/Variant.cfg', 'a'.repeat(64)), when: { if: 'requireAny', features: ['A'] } },
        { ...task('config/variant.cfg', 'b'.repeat(64)), when: { if: 'requireAny', features: ['B'] } },
      ],
    })
    expect(resolveActiveTasks(gated.tasks ?? [], ['A'], true)[0].hash).toBe('a'.repeat(64))
    expect(resolveActiveTasks(gated.tasks ?? [], ['B'], true)[0].hash).toBe('b'.repeat(64))
    expect(resolveActiveTasks(gated.tasks ?? [], ['A', 'B'], true)[0].hash).toBe('b'.repeat(64))
  })

  it('accepts only known update channels', () => {
    expect(assertUpdateChannel('stable')).toBe('stable')
    expect(assertUpdateChannel('experimental')).toBe('experimental')
    expect(() => assertUpdateChannel('nightly')).toThrow()
  })

  it('prevents stable subscription changes from downgrading an experimental binary', () => {
    expect(isSupportedUpdateVersion('2.3.0-beta.2')).toBe(true)
    expect(compareUpdateVersions('2.2.9', '2.3.0-beta.2')).toBeLessThan(0)
    expect(compareUpdateVersions('2.3.0', '2.3.0-beta.2')).toBeGreaterThan(0)
    expect(compareUpdateVersions('2.3.0-beta.10', '2.3.0-beta.2')).toBeGreaterThan(0)
    expect(() => compareUpdateVersions('not-a-version', '2.3.0')).toThrow()
  })

  it('allows exact trusted HTTPS hosts and rejects lookalikes or credentials', () => {
    expect(isAllowedExternalUrl('https://myftb.de/news')).toBe(true)
    expect(isAllowedExternalUrl('https://myftb.de.evil.example/news')).toBe(false)
    expect(isAllowedExternalUrl('https://user:password@myftb.de/news')).toBe(false)
    expect(isAllowedExternalUrl('http://myftb.de/news')).toBe(false)
  })
})

describe('download classification and secret redaction', () => {
  it('normalizes hashes and recognizes strong digests', () => {
    const digest = 'A'.repeat(64)
    expect(normalizeHash(`sha256:${digest}`)).toBe('a'.repeat(64))
    expect(isStrongHash(digest)).toBe(true)
    expect(isStrongHash('a'.repeat(40))).toBe(false)
  })

  it('classifies transient statuses/errors and Retry-After', () => {
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
    expect(isRetryableStatus(404)).toBe(false)
    expect(isRetryableNetworkError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isRetryableNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(true)
    expect(isRetryableNetworkError(Object.assign(new TypeError('certificate'), { cause: { code: 'CERT_HAS_EXPIRED' } }))).toBe(false)
    expect(parseRetryAfter('3', 0)).toBe(3_000)
  })

  it('bounds renderer-triggered JSON bodies and cancels oversized input', async () => {
    await expect(readJsonResponseLimited(new Response('{"ok":true}'), 64)).resolves.toEqual({ ok: true })
    await expect(readJsonResponseLimited(new Response(JSON.stringify({ value: 'x'.repeat(200) })), 32)).rejects.toThrow(/size limit/)
  })

  it('redacts tokens and pack keys before logging', () => {
    const redacted = redactSensitiveLogData(
      'Authorization: Bearer abc.def {"oauthRefreshToken":"secret","packKey":"private"} https://x.test/?key=value',
    )
    expect(redacted).not.toContain('abc.def')
    expect(redacted).not.toContain('secret')
    expect(redacted).not.toContain('private')
    expect(redacted).not.toContain('key=value')
  })
})

describe('symlink-safe managed destinations', () => {
  const temporaryDirectories: string[] = []
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
  })

  it('accepts missing contained paths but rejects a nested symlink escape', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myftb-safe-root-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'myftb-safe-outside-'))
    temporaryDirectories.push(root, outside)
    await fs.mkdir(path.join(root, 'stage'))
    await assertSafeDownloadDestination(root, path.join(root, 'stage', 'file.jar'))
    await fs.symlink(outside, path.join(root, 'stage', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(assertSafeDownloadDestination(root, path.join(root, 'stage', 'linked', 'file.jar'))).rejects.toThrow(/Link|Junction/)
  })
})

describe('pack operation coordination', () => {
  it('allows different packs but rejects duplicate same-pack launches', () => {
    packOperationService.reserveLaunch('Pack Alpha', 'launch:a')
    packOperationService.reserveLaunch('Pack Beta', 'launch:b')
    expect(() => packOperationService.reserveLaunch('Pack Alpha', 'launch:c')).toThrow(/bereits/)
    expect(() => packOperationService.reserveLaunch('pack alpha', 'launch:d')).toThrow(/bereits/)
    packOperationService.releaseLaunch('Pack Alpha', 'launch:a')
    packOperationService.releaseLaunch('Pack Beta', 'launch:b')
  })

  it('allows launch-owned updates and blocks unrelated mutations', () => {
    packOperationService.reserveLaunch('Pack Gamma', 'launch:g')
    packOperationService.beginMutation('Pack Gamma', 'launch:g')
    expect(() => packOperationService.beginMutation('Pack Gamma', 'repair:other')).toThrow(/läuft/)
    packOperationService.endMutation('Pack Gamma', 'launch:g')
    packOperationService.releaseLaunch('Pack Gamma', 'launch:g')
  })

  it('serializes pack reads with mutations and reference-counts nested reads', () => {
    packOperationService.beginRead('Pack Delta', 'read:a')
    packOperationService.beginRead('Pack Delta', 'read:a')
    expect(() => packOperationService.beginMutation('Pack Delta', 'install:b')).toThrow(/geprüft/)
    packOperationService.endRead('Pack Delta', 'read:a')
    expect(packOperationService.isReading('Pack Delta')).toBe(true)
    packOperationService.endRead('Pack Delta', 'read:a')

    packOperationService.beginMutation('Pack Delta', 'install:b')
    expect(() => packOperationService.beginRead('Pack Delta', 'read:c')).toThrow(/verändert/)
    packOperationService.beginRead('Pack Delta', 'install:b')
    packOperationService.endRead('Pack Delta', 'install:b')
    packOperationService.endMutation('Pack Delta', 'install:b')
  })
})
