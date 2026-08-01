/**
 * Import/Export ("data-io") shared types — the ONE unified vocabulary that
 * flattens the three field systems in openbooks (Setup registry columns,
 * custom-record FormSection fields, and custom_field_defs on core tables) into
 * a single field model the mapping wizard, export form, and API all speak.
 *
 * PURE / client-safe: no db or server-only imports. The server registry
 * (./resources.ts) builds `DataResource`s that expose these shapes.
 */

export type ResourceFieldKind =
  | 'text'
  | 'long_text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multiselect'
  | 'reference'

/** A `reference` field points at another resource, matched by a human key. */
export interface ResourceRefTarget {
  /** Resource key of the referenced entity, e.g. 'accounts', 'tax-codes'. */
  resource: string
  /** The human column used to name the target in a file, e.g. 'number', 'code'. */
  by: string
}

/** One importable/exportable field, unified across all entity families. */
export interface ResourceField {
  /** Stable key: camelCase column (setup/master), field id (records). */
  key: string
  label: string
  kind: ResourceFieldKind
  required?: boolean
  /** For select/multiselect. */
  options?: { value: string; label: string }[]
  /** For `reference` fields. */
  ref?: ResourceRefTarget
  /** Stored in a `custom` jsonb / record data map rather than a core column. */
  custom?: boolean
  /** Repeating sublist section id (custom records only); values are row arrays. */
  section?: string
  /** Computed/immutable — included in export, ignored on import. */
  readOnly?: boolean
}

/** Client-safe metadata about a resource (drives pickers, nav, permissions). */
export interface ResourceDescriptor {
  key: string
  label: string
  /** 'Setup' | 'Master data' | 'Records' | 'Transactions'. */
  group: ResourceGroup
  iconKey: string
  readPermission: string
  writePermission: string
  supportsImport: boolean
  /** Field key used to match update-vs-insert on import (the natural key). */
  naturalKey?: string
  /** Transactions can optionally post to the ledger; this gates that step. */
  canPost?: boolean
  postPermission?: string
}

export type ResourceGroup = 'Setup' | 'Master data' | 'Property management' | 'Records' | 'Transactions'

export const RESOURCE_GROUP_ORDER: ResourceGroup[] = [
  'Setup',
  'Master data',
  'Property management',
  'Records',
  'Transactions',
]

export type ImportMode = 'insert' | 'upsert'

export type CellValue = string | number | boolean | null

/** A single row's error during preview/commit. */
export interface RowError {
  /** 1-based source row number (excluding the header row). */
  row: number
  message: string
  field?: string
}

/** Outcome of a write (commit) or a dry-run (preview). */
export interface WriteOutcome {
  created: number
  updated: number
  failed: number
  errors: RowError[]
}

export const EXPORT_FORMATS = ['csv', 'xlsx', 'json'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export const IMPORT_FORMATS = ['csv', 'xlsx', 'json'] as const
export type ImportFormat = (typeof IMPORT_FORMATS)[number]
