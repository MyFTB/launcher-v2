import { describe, it, expect } from 'vitest'

import {
  requiresJavaMajor,
  runtimeNameForMajor,
  inferRuntime,
  getRuntimePlatform,
  getRuntimeArchSuffix,
  javaHomeMatchesRequired,
} from '../main/services/java.service'

// ─── requiresJavaMajor ────────────────────────────────────────────────────────

describe('requiresJavaMajor', () => {
  it.each([
    ['1.7.10', 8],
    ['1.8.9', 8],
    ['1.12.2', 8],
    ['1.16.5', 8],
    ['1.17', 17],
    ['1.17.1', 17],
    ['1.18.2', 17],
    ['1.19.4', 17],
    ['1.20.1', 17],
    ['1.20.4', 17],
    ['1.21', 21],
    ['1.21.1', 21],
    ['1.22', 21],
  ] as const)('MC %s → Java %d', (version, expected) => {
    expect(requiresJavaMajor(version)).toBe(expected)
  })
})

// ─── runtimeNameForMajor ──────────────────────────────────────────────────────

describe('runtimeNameForMajor', () => {
  it('returns jre for Java 8', () => {
    expect(runtimeNameForMajor(8)).toBe('jre')
  })
  it('returns temurin_17 for Java 17', () => {
    expect(runtimeNameForMajor(17)).toBe('temurin_17')
  })
  it('returns temurin_21 for Java 21', () => {
    expect(runtimeNameForMajor(21)).toBe('temurin_21')
  })
})

// ─── inferRuntime ─────────────────────────────────────────────────────────────

describe('inferRuntime', () => {
  it.each([
    ['1.7.10', 'jre'],
    ['1.12.2', 'jre'],
    ['1.16.5', 'jre'],
    ['1.17', 'temurin_17'],
    ['1.20.1', 'temurin_17'],
    ['1.21', 'temurin_21'],
    ['1.21.1', 'temurin_21'],
  ])('MC %s → runtime %s', (version, expected) => {
    expect(inferRuntime(version)).toBe(expected)
  })
})

// ─── getRuntimePlatform ───────────────────────────────────────────────────────

describe('getRuntimePlatform', () => {
  it('returns a non-empty string', () => {
    const p = getRuntimePlatform()
    expect(p).toMatch(/^(windows|linux|macosx)$/)
  })

  it('never returns "osx" (correct token is "macosx")', () => {
    expect(getRuntimePlatform()).not.toBe('osx')
  })
})

// ─── getRuntimeArchSuffix ─────────────────────────────────────────────────────

describe('getRuntimeArchSuffix', () => {
  it('returns -x64 or empty string', () => {
    const suffix = getRuntimeArchSuffix()
    expect(['-x64', '']).toContain(suffix)
  })
})

// ─── javaHomeMatchesRequired ──────────────────────────────────────────────────

describe('javaHomeMatchesRequired', () => {
  // Java 8 paths
  it.each([
    'C:\\Program Files\\Zulu\\zulu-8.44.0.11',
    'C:\\Program Files\\Java\\jre1.8.0_422',
    '/usr/lib/jvm/java-8-openjdk-amd64',
    '/Library/Java/JavaVirtualMachines/jdk1.8.0_422.jdk',
  ])('recognises Java 8 path: %s', (javaHome) => {
    expect(javaHomeMatchesRequired(javaHome, 8)).toBe(true)
  })

  // Java 17 paths
  it.each([
    'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.12.7-hotspot',
    'C:\\Program Files\\Zulu\\zulu-17.52.17',
    '/usr/lib/jvm/java-17-openjdk-amd64',
  ])('recognises Java 17 path: %s', (javaHome) => {
    expect(javaHomeMatchesRequired(javaHome, 17)).toBe(true)
  })

  // Java 21 paths
  it.each([
    'C:\\Program Files\\Zulu\\zulu-21.36.17',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4.7-hotspot',
    '/usr/lib/jvm/java-21-openjdk-amd64',
  ])('recognises Java 21 path: %s', (javaHome) => {
    expect(javaHomeMatchesRequired(javaHome, 21)).toBe(true)
  })

  // Mismatches
  it('rejects zulu-21 when Java 8 is required', () => {
    expect(
      javaHomeMatchesRequired('C:\\Program Files\\Zulu\\zulu-21.36.17', 8),
    ).toBe(false)
  })

  it('rejects zulu-17 when Java 8 is required', () => {
    expect(
      javaHomeMatchesRequired('C:\\Program Files\\Zulu\\zulu-17.52.17', 8),
    ).toBe(false)
  })

  // Cross-version rejections (ensures static lookup doesn't match wrong version)
  it('rejects Java 21 path when Java 17 is required', () => {
    expect(javaHomeMatchesRequired('/usr/lib/jvm/java-21-openjdk-amd64', 17)).toBe(false)
  })

  it('rejects Java 17 path when Java 21 is required', () => {
    expect(javaHomeMatchesRequired('/usr/lib/jvm/java-17-openjdk-amd64', 21)).toBe(false)
  })
})
