/**
 * openbooks Setup registry — one descriptor per configurable entity. Powers a
 * generic list view (admin/setup/[entity]/page.tsx), a generic create/edit
 * drawer (SetupDrawer.tsx), and a generic CRUD API (api/admin/setup/[entity]).
 * Adding a new configuration surface = adding one entry here.
 *
 * This module is intentionally PURE (no db/server imports) so it can be shared
 * by the server list page, the client drawer, and the API route. Labels are
 * next-intl message keys under the `admin.setup` namespace, resolved at each
 * render site — never translated here. Column/field `key`s are camelCase; the
 * API maps them to snake_case db columns via `toSnake`.
 *
 * SECURITY: column identifiers used to build SQL come ONLY from this registry
 * (never from request bodies). Values are always bound as parameters. That is
 * what makes the generic API safe — see api/admin/setup/[entity]/route.ts.
 */

export type SetupFieldKind =
  | 'text'
  | 'textarea'
  | 'integer'
  | 'decimal'
  | 'percent'
  | 'boolean'
  | 'date'
  | 'select'
  | 'ref'
  | 'multiref'

export type SetupColumnKind =
  | 'text'
  | 'code'
  | 'badge-active'
  | 'percent'
  | 'ref'
  | 'date'
  | 'number'
  | 'boolean'

/**
 * Where a `ref`/`multiref` field's options come from. `'accounts'` = the org's
 * postable accounts. Any other value is a setup entity `key` (self-references
 * allowed, e.g. a department's parent). The list page resolves each declared
 * source into `{ value, label }[]` and hands them to the drawer.
 */
export type SetupRefSource = 'accounts' | (string & {})

export interface SetupField {
  key: string
  kind: SetupFieldKind
  required?: boolean
  /** select options; labelKey is under `admin.setup.options.*`. */
  options?: { value: string; labelKey: string }[]
  /** ref / multiref option source. */
  ref?: SetupRefSource
  /** Natural keys / immutable columns: editable on create, read-only on edit. */
  lockedOnEdit?: boolean
  /** Column is NOT NULL with a DB default — when left blank, omit it (let the
   *  default apply) instead of writing null, which would violate the constraint. */
  keepDefault?: boolean
  /** decimal/integer default shown as placeholder text (message key). */
  defaultHintKey?: string
}

export interface SetupColumn {
  key: string
  kind: SetupColumnKind
  ref?: SetupRefSource
}

export interface SetupEntity {
  /** URL slug, e.g. 'tax-codes'. */
  key: string
  /** DB table name. */
  table: string
  /** Section this tab lives under (SETUP_GROUPS key). */
  groupKey: string
  /** lucide icon key (mapped in SetupNav). */
  iconKey: string
  /** All entities are org-scoped except `currencies` (a shared reference table). */
  orgScoped: boolean
  /** Primary-key column used to address a row (PATCH/DELETE). Defaults to 'id';
   *  `currencies` is keyed by its text `code`. */
  idColumn?: string
  /** True when the table carries the created_at/created_by/updated_at/updated_by
   *  quartet (stamped on write). */
  actorCols?: boolean
  /** Column that must be unique per org and is used for default ordering. */
  naturalKey?: string
  /** ORDER BY column when there is no natural key. */
  orderBy?: string
  /** Whether the table has `is_active` (→ archive on delete instead of hard delete). */
  hasActive: boolean
  columns: SetupColumn[]
  fields: SetupField[]
}

export interface SetupGroup {
  key: string
  iconKey: string
}

// Section order in the left rail. `company` holds the single (special-cased)
// Company & Accounting settings tab; the rest are registry-driven.
export const SETUP_GROUPS: SetupGroup[] = [
  { key: 'company', iconKey: 'building' },
  { key: 'taxes', iconKey: 'receipt' },
  { key: 'dimensions', iconKey: 'layers' },
  { key: 'billing', iconKey: 'hash' },
  { key: 'workforce', iconKey: 'users' },
  { key: 'assets', iconKey: 'landmark' },
  { key: 'currency', iconKey: 'coins' },
]

const APPLIES_TO = [
  { value: 'sales', labelKey: 'options.appliesTo.sales' },
  { value: 'purchases', labelKey: 'options.appliesTo.purchases' },
  { value: 'both', labelKey: 'options.appliesTo.both' },
]

const TAX_BASIS = [
  { value: 'net', labelKey: 'options.basis.net' },
  { value: 'tax', labelKey: 'options.basis.tax' },
]

const TAX_SIGN = [
  { value: '1', labelKey: 'options.sign.positive' },
  { value: '-1', labelKey: 'options.sign.negative' },
]

const DEPRECIATION_METHODS = [
  { value: 'straight_line', labelKey: 'options.method.straightLine' },
  { value: 'declining_balance', labelKey: 'options.method.decliningBalance' },
  { value: 'double_declining', labelKey: 'options.method.doubleDeclining' },
]

const BURDEN_METHODS = [
  { value: 'live', labelKey: 'options.burdenMethod.live' },
  { value: 'standard', labelKey: 'options.burdenMethod.standard' },
]

export const SETUP_ENTITIES: SetupEntity[] = [
  // --- Taxes ---------------------------------------------------------------
  {
    key: 'tax-codes',
    table: 'tax_codes',
    actorCols: true,
    groupKey: 'taxes',
    iconKey: 'receipt',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'appliesTo', kind: 'text' },
      { key: 'recoverablePercent', kind: 'percent' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'country', kind: 'text' },
      { key: 'region', kind: 'text' },
      { key: 'appliesTo', kind: 'select', options: APPLIES_TO, keepDefault: true },
      { key: 'collectedAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'paidAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'recoverablePercent', kind: 'percent', keepDefault: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'tax-rates',
    table: 'tax_rates',
    actorCols: true,
    groupKey: 'taxes',
    iconKey: 'percent',
    orgScoped: true,
    orderBy: 'effective_from desc',
    hasActive: false,
    columns: [
      { key: 'taxCodeId', kind: 'ref', ref: 'tax-codes' },
      { key: 'ratePercent', kind: 'percent' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
    ],
    fields: [
      { key: 'taxCodeId', kind: 'ref', ref: 'tax-codes', required: true },
      { key: 'ratePercent', kind: 'percent', required: true },
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'effectiveTo', kind: 'date' },
    ],
  },
  {
    key: 'tax-groups',
    table: 'tax_groups',
    groupKey: 'taxes',
    iconKey: 'layers',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'members', kind: 'multiref', ref: 'tax-codes' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'tax-report-lines',
    table: 'tax_report_lines',
    actorCols: true,
    groupKey: 'taxes',
    iconKey: 'file',
    orgScoped: true,
    orderBy: 'report_code, line_code',
    hasActive: false,
    columns: [
      { key: 'reportCode', kind: 'code' },
      { key: 'lineCode', kind: 'code' },
      { key: 'label', kind: 'text' },
      { key: 'basis', kind: 'text' },
    ],
    fields: [
      { key: 'reportCode', kind: 'text', required: true },
      { key: 'lineCode', kind: 'text', required: true },
      { key: 'label', kind: 'text', required: true },
      { key: 'taxCodeId', kind: 'ref', ref: 'tax-codes' },
      { key: 'basis', kind: 'select', required: true, options: TAX_BASIS },
      { key: 'sign', kind: 'select', options: TAX_SIGN },
    ],
  },

  // --- Dimensions ----------------------------------------------------------
  {
    key: 'classes',
    table: 'classes',
    actorCols: true,
    groupKey: 'dimensions',
    iconKey: 'tag',
    orgScoped: true,
    naturalKey: 'code',
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'parentId', kind: 'ref', ref: 'classes' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text' },
      { key: 'name', kind: 'text', required: true },
      { key: 'parentId', kind: 'ref', ref: 'classes' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'departments',
    table: 'departments',
    actorCols: true,
    groupKey: 'dimensions',
    iconKey: 'building',
    orgScoped: true,
    naturalKey: 'code',
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'parentId', kind: 'ref', ref: 'departments' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text' },
      { key: 'name', kind: 'text', required: true },
      { key: 'parentId', kind: 'ref', ref: 'departments' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'locations',
    table: 'locations',
    actorCols: true,
    groupKey: 'dimensions',
    iconKey: 'map-pin',
    orgScoped: true,
    naturalKey: 'code',
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'parentId', kind: 'ref', ref: 'locations' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text' },
      { key: 'name', kind: 'text', required: true },
      { key: 'parentId', kind: 'ref', ref: 'locations' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Account Groups — a reporting classification of the CoA (rule + pin). The
    // `match` jsonb rule + membership pins are managed elsewhere; this surface
    // manages the group's identity (name, colour, order, active).
    key: 'account-groups',
    table: 'account_groups',
    actorCols: true,
    groupKey: 'dimensions',
    iconKey: 'layers',
    orgScoped: true,
    orderBy: 'dimension, sort_order, name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'dimension', kind: 'code' },
      { key: 'sortOrder', kind: 'number' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'key', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'dimension', kind: 'text', required: true },
      { key: 'color', kind: 'text' },
      { key: 'sortOrder', kind: 'integer', keepDefault: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },

  // --- Billing & numbering -------------------------------------------------
  {
    key: 'payment-terms',
    table: 'payment_terms',
    groupKey: 'billing',
    iconKey: 'calendar',
    orgScoped: true,
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'netDays', kind: 'number' },
      { key: 'discountDays', kind: 'number' },
      { key: 'discountPercent', kind: 'percent' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'netDays', kind: 'integer', required: true },
      { key: 'discountDays', kind: 'integer' },
      { key: 'discountPercent', kind: 'percent' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'number-sequences',
    table: 'number_sequences',
    actorCols: true,
    groupKey: 'billing',
    iconKey: 'hash',
    orgScoped: true,
    naturalKey: 'documentKind',
    orderBy: 'document_kind',
    hasActive: false,
    columns: [
      { key: 'documentKind', kind: 'code' },
      { key: 'prefix', kind: 'code' },
      { key: 'nextNumber', kind: 'number' },
      { key: 'padding', kind: 'number' },
      { key: 'gapless', kind: 'boolean' },
    ],
    fields: [
      { key: 'documentKind', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'prefix', kind: 'text', keepDefault: true },
      { key: 'nextNumber', kind: 'integer', required: true },
      { key: 'padding', kind: 'integer', required: true },
      { key: 'gapless', kind: 'boolean' },
    ],
  },

  // --- Workforce -----------------------------------------------------------
  {
    key: 'time-types',
    table: 'time_types',
    groupKey: 'workforce',
    iconKey: 'timer',
    orgScoped: true,
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'costMultiplier', kind: 'number' },
      { key: 'isBillableDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'costMultiplier', kind: 'decimal', keepDefault: true },
      { key: 'isBillableDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'worker-comp-groups',
    table: 'worker_comp_groups',
    groupKey: 'workforce',
    iconKey: 'shield',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'ratePercent', kind: 'percent' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'ratePercent', kind: 'percent' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'labor-burden-rates',
    table: 'labor_burden_rates',
    actorCols: true,
    groupKey: 'workforce',
    iconKey: 'percent',
    orgScoped: true,
    orderBy: 'effective_from desc',
    hasActive: false,
    columns: [
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'category', kind: 'text' },
      { key: 'method', kind: 'text' },
      { key: 'ratePercent', kind: 'percent' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
    ],
    fields: [
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'category', kind: 'text' },
      { key: 'method', kind: 'select', options: BURDEN_METHODS },
      { key: 'ratePercent', kind: 'percent', required: true },
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'effectiveTo', kind: 'date' },
    ],
  },

  // --- Assets --------------------------------------------------------------
  {
    key: 'asset-categories',
    table: 'asset_categories',
    actorCols: true,
    groupKey: 'assets',
    iconKey: 'landmark',
    orgScoped: true,
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'defaultMethod', kind: 'text' },
      { key: 'defaultLifeMonths', kind: 'number' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'assetAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'accumulatedDepreciationAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'depreciationExpenseAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'gainLossAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'defaultMethod', kind: 'select', options: DEPRECIATION_METHODS },
      { key: 'defaultLifeMonths', kind: 'integer' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },

  // --- Currency ------------------------------------------------------------
  {
    key: 'currencies',
    table: 'currencies',
    idColumn: 'code',
    groupKey: 'currency',
    iconKey: 'coins',
    orgScoped: false,
    naturalKey: 'code',
    orderBy: 'code',
    hasActive: false,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'minorUnits', kind: 'number' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'minorUnits', kind: 'integer', required: true },
    ],
  },
]

export const SETUP_ENTITY_BY_KEY = new Map(SETUP_ENTITIES.map((e) => [e.key, e]))

/** Entities grouped by section, in registry order — drives the left rail. */
export function setupEntitiesByGroup(): Map<string, SetupEntity[]> {
  const byGroup = new Map<string, SetupEntity[]>()
  for (const g of SETUP_GROUPS) byGroup.set(g.key, [])
  for (const e of SETUP_ENTITIES) {
    const list = byGroup.get(e.groupKey)
    if (list) list.push(e)
  }
  return byGroup
}

/** camelCase field key → snake_case db column. */
export function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

/** snake_case db column → camelCase. */
export function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}
