import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildChildEnv } from '../main/services/launch.service'

describe('buildChildEnv', () => {
  const originalPlatform = process.platform

  function setPlatform(p: string): void {
    Object.defineProperty(process, 'platform', { value: p, writable: true })
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true })
  })

  describe('on Linux', () => {
    beforeEach(() => setPlatform('linux'))

    it('removes LD_PRELOAD entirely', () => {
      const env = {
        HOME: '/home/user',
        LD_PRELOAD: '/opt/electron/libcrash.so',
        PATH: '/usr/bin',
      }
      const result = buildChildEnv(env)
      expect(result.LD_PRELOAD).toBeUndefined()
      expect(result.HOME).toBe('/home/user')
      expect(result.PATH).toBe('/usr/bin')
    })

    it('strips Electron-related paths from LD_LIBRARY_PATH', () => {
      const env = {
        LD_LIBRARY_PATH:
          '/opt/MyFTB Launcher/electron:/usr/lib:/usr/lib/x86_64-linux-gnu',
      }
      const result = buildChildEnv(env)
      expect(result.LD_LIBRARY_PATH).toBe('/usr/lib:/usr/lib/x86_64-linux-gnu')
    })

    it('strips Chrome/Chromium paths from LD_LIBRARY_PATH', () => {
      const env = {
        LD_LIBRARY_PATH:
          '/opt/google/chrome/lib:/usr/lib:/snap/chromium/current/lib',
      }
      const result = buildChildEnv(env)
      expect(result.LD_LIBRARY_PATH).toBe('/usr/lib')
    })

    it('strips app.asar paths from LD_LIBRARY_PATH', () => {
      const env = {
        LD_LIBRARY_PATH:
          '/tmp/.mount_MyFTB/resources/app.asar:/usr/lib',
      }
      const result = buildChildEnv(env)
      expect(result.LD_LIBRARY_PATH).toBe('/usr/lib')
    })

    it('deletes LD_LIBRARY_PATH entirely when all entries are Electron-related', () => {
      const env = {
        LD_LIBRARY_PATH: '/opt/electron/lib',
      }
      const result = buildChildEnv(env)
      expect(result.LD_LIBRARY_PATH).toBeUndefined()
    })

    it('leaves LD_LIBRARY_PATH unchanged when no Electron paths present', () => {
      const env = {
        LD_LIBRARY_PATH: '/usr/lib:/usr/local/lib:/opt/java/lib',
      }
      const result = buildChildEnv(env)
      expect(result.LD_LIBRARY_PATH).toBe('/usr/lib:/usr/local/lib:/opt/java/lib')
    })

    it('handles missing LD_LIBRARY_PATH gracefully', () => {
      const env = { HOME: '/home/user' }
      const result = buildChildEnv(env)
      expect(result.LD_LIBRARY_PATH).toBeUndefined()
      expect(result.HOME).toBe('/home/user')
    })

    it('does not mutate the input env object', () => {
      const env = {
        LD_PRELOAD: '/opt/electron/libcrash.so',
        LD_LIBRARY_PATH: '/opt/electron:/usr/lib',
      }
      const envCopy = { ...env }
      buildChildEnv(env)
      expect(env).toEqual(envCopy)
    })
  })

  describe('on non-Linux platforms', () => {
    it('returns env unchanged on Windows', () => {
      setPlatform('win32')
      const env = {
        LD_PRELOAD: '/some/lib.so',
        LD_LIBRARY_PATH: '/some/electron/path:/usr/lib',
        PATH: 'C:\\Windows',
      }
      const result = buildChildEnv(env)
      expect(result.LD_PRELOAD).toBe('/some/lib.so')
      expect(result.LD_LIBRARY_PATH).toBe('/some/electron/path:/usr/lib')
    })

    it('returns env unchanged on macOS', () => {
      setPlatform('darwin')
      const env = {
        LD_PRELOAD: '/some/lib.so',
        DYLD_LIBRARY_PATH: '/usr/local/lib',
      }
      const result = buildChildEnv(env)
      expect(result.LD_PRELOAD).toBe('/some/lib.so')
    })
  })
})
