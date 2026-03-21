export const KNOWN_PACKS_KEY = 'myftb:knownPacks'
export const NEW_PACKS_KEY = 'myftb:newPacks'

export function getKnownPacks(): Set<string> {
  try {
    const raw = localStorage.getItem(KNOWN_PACKS_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export function saveKnownPacks(names: string[]): void {
  try { localStorage.setItem(KNOWN_PACKS_KEY, JSON.stringify(names)) } catch {}
}

export function getStoredNewPacks(): Set<string> {
  try {
    const raw = localStorage.getItem(NEW_PACKS_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export function saveStoredNewPacks(names: string[]): void {
  try { localStorage.setItem(NEW_PACKS_KEY, JSON.stringify(names)) } catch {}
}

export function clearStoredNewPacks(): void {
  try { localStorage.removeItem(NEW_PACKS_KEY) } catch {}
}

export function dispatchNewPackCount(count: number): void {
  window.dispatchEvent(new CustomEvent('myftb:newpacks', { detail: { count } }))
}
