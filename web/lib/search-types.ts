/**
 * Global search wire types, shared by the server (lib/search.ts and its
 * companion sources) and the header search component.
 */

export const SEARCH_RECORD_TYPES = [
  'transaction',
  'contact',
  'account',
  'item',
  'project',
  'asset',
  'equipment',
  'opportunity',
  'activity',
  'subscription',
  'timesheet',
  'record',
  'file',
  'dashboard',
  'location',
  'warehouse',
] as const

export const SEARCH_CATALOG_TYPES = ['report', 'setting', 'help'] as const

export type SearchRecordType = (typeof SEARCH_RECORD_TYPES)[number]
export type SearchCatalogType = (typeof SEARCH_CATALOG_TYPES)[number]
export type SearchType = SearchRecordType | SearchCatalogType

/**
 * A small label beside a hit. The server sends a stable value and the client
 * renders it through the message catalog, so a badge reads in the reader's
 * language: a party's role, or a document's lifecycle status.
 */
export type SearchBadge =
  | { kind: 'role'; value: 'customer' | 'vendor' | 'employee' }
  | { kind: 'status'; value: string }

export interface SearchHit {
  id: string
  type: SearchType
  title: string
  subtitle?: string
  href: string
  iconKey: string
  badge?: SearchBadge
  amount?: string
}

export interface SearchGroup {
  type: SearchType
  labelKey: string
  hits: SearchHit[]
}

export interface SearchResponse {
  q: string
  groups: SearchGroup[]
  total: number
}

/**
 * What the browser remembers about a recently opened result: its type and
 * id, never its title or amounts. The server resolves every reference again
 * under the reader's current permissions, so a renamed record shows its new
 * name and a record the reader can no longer see is simply absent.
 */
export interface RecentRef {
  type: SearchType
  id: string
}

export const RECENT_LIMIT = 8
