import { RECENT_LIMIT, SEARCH_CATALOG_TYPES, SEARCH_RECORD_TYPES, type RecentRef } from './search-types'

/**
 * The header search's memory of recently opened results. Only a reference
 * (type and id; for a page, its href) is kept, scoped to one user in one
 * organization, and the server resolves record references again on every
 * read. Titles, amounts and names are never stored in the browser.
 */
export type StoredRecent = RecentRef | { type: 'page'; id: string }

const KNOWN_TYPES = new Set<string>(['page', ...SEARCH_RECORD_TYPES, ...SEARCH_CATALOG_TYPES])

export function recentStorageKey(scope: string): string {
  return `openbooks.search.recent.v1:${scope}`
}

/** Read stored references, dropping anything that is not one. */
export function parseStoredRecents(raw: string | null): StoredRecent[] {
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is StoredRecent =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as StoredRecent).type === 'string' &&
      KNOWN_TYPES.has((entry as StoredRecent).type) &&
      typeof (entry as StoredRecent).id === 'string' &&
      (entry as StoredRecent).id.length > 0 &&
      (entry as StoredRecent).id.length <= 512,
    )
    .slice(0, RECENT_LIMIT)
}

/** Put `entry` first, without duplicates, keeping the most recent few. */
export function rememberRecent(list: readonly StoredRecent[], entry: StoredRecent): StoredRecent[] {
  return [entry, ...list.filter((existing) => existing.type !== entry.type || existing.id !== entry.id)].slice(0, RECENT_LIMIT)
}

export function readRecents(scope: string): StoredRecent[] {
  try {
    return parseStoredRecents(window.localStorage.getItem(recentStorageKey(scope)))
  } catch {
    return []
  }
}

export function writeRecents(scope: string, list: readonly StoredRecent[]): void {
  try {
    if (list.length === 0) window.localStorage.removeItem(recentStorageKey(scope))
    else window.localStorage.setItem(recentStorageKey(scope), JSON.stringify(list))
  } catch {
    // Storage can be unavailable (private mode, quota); recents are a
    // convenience and search works without them.
  }
}
