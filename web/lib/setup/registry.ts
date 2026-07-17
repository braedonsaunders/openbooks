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
  /** Initial value for a new record; database defaults remain authoritative. */
  defaultValue?: string | number | boolean
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
  /** Optional translation key for the singular record name used in drawers. */
  singularTitleKey?: string
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
  { key: 'accounting', iconKey: 'calendar' },
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

// Values match the tax_report_lines.basis enum (schema/src/tax.ts) and the tax
// return engine: tax_amount sums the tax collected/paid, taxable_base sums the
// base the tax applied to.
const TAX_BASIS = [
  { value: 'tax_amount', labelKey: 'options.basis.tax' },
  { value: 'taxable_base', labelKey: 'options.basis.net' },
]

const SUBMISSION_CHANNELS = [
  { value: 'print_pdf', labelKey: 'options.channel.printPdf' },
  { value: 'file_upload', labelKey: 'options.channel.fileUpload' },
  { value: 'efile_api', labelKey: 'options.channel.efileApi' },
  { value: 'portal_manual', labelKey: 'options.channel.portalManual' },
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

const FX_RATE_TYPES = [
  { value: 'spot', labelKey: 'options.fxRateType.spot' },
  { value: 'average', labelKey: 'options.fxRateType.average' },
  { value: 'historical', labelKey: 'options.fxRateType.historical' },
]

const CONSOLIDATED_RATE_SOURCES = [
  { value: 'derived', labelKey: 'options.rateSource.derived' },
  { value: 'manual', labelKey: 'options.rateSource.manual' },
]

export const SETUP_ENTITIES: SetupEntity[] = [
  // --- Company -------------------------------------------------------------
  {
    // Subsidiaries — the org's legal-entity tree (NetSuite OneWorld model).
    // baseCurrency is the entity's functional currency: locked after create so
    // it cannot drift once books exist.
    key: 'subsidiaries',
    table: 'subsidiaries',
    actorCols: true,
    groupKey: 'company',
    iconKey: 'building',
    orgScoped: true,
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'baseCurrency', kind: 'code' },
      { key: 'country', kind: 'code' },
      { key: 'parentId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'isElimination', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'legalName', kind: 'text' },
      { key: 'parentId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'baseCurrency', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'country', kind: 'text', required: true },
      { key: 'isElimination', kind: 'boolean' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Intercompany pairs — the due-from/due-to account mapping used when a
    // transaction crosses two subsidiaries.
    key: 'intercompany-pairs',
    table: 'intercompany_pairs',
    actorCols: true,
    groupKey: 'company',
    iconKey: 'layers',
    orgScoped: true,
    orderBy: 'created_at',
    hasActive: true,
    columns: [
      { key: 'fromSubsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'toSubsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'dueFromAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'dueToAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'fromSubsidiaryId', kind: 'ref', ref: 'subsidiaries', required: true },
      { key: 'toSubsidiaryId', kind: 'ref', ref: 'subsidiaries', required: true },
      { key: 'dueFromAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'dueToAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },

  // --- Accounting --------------------------------------------------------
  {
    // Every posting, close run, budget, and book-aware schedule belongs to an
    // accounting book. The API applies the single-active-primary invariant
    // atomically when these records are changed.
    key: 'accounting-books',
    table: 'accounting_books',
    singularTitleKey: 'entities.accounting-books.singular',
    actorCols: true,
    groupKey: 'accounting',
    iconKey: 'book-open',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'code', kind: 'code' },
      { key: 'isPrimary', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'isPrimary', kind: 'boolean' },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },

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
    // A configurable government return: openbooks computes the boxes from the
    // ledger, renders a facsimile, and routes filing to the jurisdiction's real
    // channel. New jurisdictions are data (a form + its boxes), not code.
    key: 'tax-return-forms',
    table: 'tax_return_forms',
    actorCols: true,
    groupKey: 'taxes',
    iconKey: 'file',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'country', kind: 'text' },
      { key: 'submissionChannel', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'country', kind: 'text' },
      { key: 'region', kind: 'text' },
      { key: 'submissionChannel', kind: 'select', options: SUBMISSION_CHANNELS, keepDefault: true },
      { key: 'watermark', kind: 'text' },
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
    orderBy: 'report_code, sequence, line_code',
    hasActive: false,
    columns: [
      { key: 'reportCode', kind: 'code' },
      { key: 'sequence', kind: 'number' },
      { key: 'lineCode', kind: 'code' },
      { key: 'label', kind: 'text' },
      { key: 'basis', kind: 'text' },
    ],
    fields: [
      { key: 'reportCode', kind: 'text', required: true },
      { key: 'lineCode', kind: 'text', required: true },
      { key: 'label', kind: 'text', required: true },
      { key: 'sequence', kind: 'integer', keepDefault: true },
      { key: 'taxCodeId', kind: 'ref', ref: 'tax-codes' },
      { key: 'basis', kind: 'select', options: TAX_BASIS },
      { key: 'sign', kind: 'select', options: TAX_SIGN },
      { key: 'formula', kind: 'text' },
      { key: 'pdfField', kind: 'text' },
    ],
  },

  // --- Dimensions ----------------------------------------------------------
  {
    key: 'segment-definitions',
    table: 'segment_definitions',
    actorCols: true,
    groupKey: 'dimensions',
    iconKey: 'layers',
    orgScoped: true,
    naturalKey: 'key',
    orderBy: 'sort_order, name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'key', kind: 'code' },
      { key: 'sourceKind', kind: 'text' },
      { key: 'showOnHeader', kind: 'boolean' },
      { key: 'showOnLines', kind: 'boolean' },
      { key: 'showInReports', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'key', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'pluralName', kind: 'text', required: true },
      { key: 'isHierarchical', kind: 'boolean' },
      { key: 'showOnHeader', kind: 'boolean', defaultValue: true },
      { key: 'showOnLines', kind: 'boolean', defaultValue: true },
      { key: 'showInReports', kind: 'boolean', defaultValue: true },
      { key: 'allowAccountRequirement', kind: 'boolean', defaultValue: true },
      { key: 'sortOrder', kind: 'integer', keepDefault: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'segment-values',
    table: 'segment_values',
    actorCols: true,
    groupKey: 'dimensions',
    iconKey: 'tag',
    orgScoped: true,
    orderBy: 'segment_id, name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'code', kind: 'code' },
      { key: 'segmentId', kind: 'ref', ref: 'segment-definitions' },
      { key: 'parentId', kind: 'ref', ref: 'segment-values' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'segmentId', kind: 'ref', ref: 'segment-definitions', required: true, lockedOnEdit: true },
      { key: 'code', kind: 'text' },
      { key: 'name', kind: 'text', required: true },
      { key: 'description', kind: 'textarea' },
      { key: 'parentId', kind: 'ref', ref: 'segment-values' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'subsidiaryIncludeChildren', kind: 'boolean', defaultValue: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
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
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text' },
      { key: 'name', kind: 'text', required: true },
      { key: 'parentId', kind: 'ref', ref: 'classes' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'subsidiaryIncludeChildren', kind: 'boolean' },
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
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text' },
      { key: 'name', kind: 'text', required: true },
      { key: 'parentId', kind: 'ref', ref: 'departments' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'subsidiaryIncludeChildren', kind: 'boolean' },
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
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text' },
      { key: 'name', kind: 'text', required: true },
      { key: 'parentId', kind: 'ref', ref: 'locations' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'subsidiaryIncludeChildren', kind: 'boolean' },
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
    orderBy: 'document_kind',
    hasActive: false,
    columns: [
      { key: 'documentKind', kind: 'code' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'prefix', kind: 'code' },
      { key: 'nextNumber', kind: 'number' },
      { key: 'padding', kind: 'number' },
      { key: 'gapless', kind: 'boolean' },
    ],
    fields: [
      { key: 'documentKind', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', lockedOnEdit: true },
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
    key: 'fx-rates',
    table: 'fx_rates',
    actorCols: true,
    groupKey: 'currency',
    iconKey: 'coins',
    orgScoped: true,
    orderBy: 'as_of desc',
    hasActive: false,
    columns: [
      { key: 'asOf', kind: 'date' },
      { key: 'fromCurrency', kind: 'code' },
      { key: 'toCurrency', kind: 'code' },
      { key: 'rateType', kind: 'text' },
      { key: 'rate', kind: 'number' },
      { key: 'source', kind: 'text' },
    ],
    fields: [
      { key: 'asOf', kind: 'date', required: true, lockedOnEdit: true },
      { key: 'fromCurrency', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'toCurrency', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'rateType', kind: 'select', required: true, options: FX_RATE_TYPES, lockedOnEdit: true },
      { key: 'rate', kind: 'decimal', required: true },
      { key: 'source', kind: 'text', lockedOnEdit: true, keepDefault: true },
    ],
  },
  {
    key: 'consolidated-fx-rates',
    table: 'consolidated_fx_rates',
    actorCols: true,
    groupKey: 'currency',
    iconKey: 'layers',
    orgScoped: true,
    orderBy: 'period_id desc',
    hasActive: false,
    columns: [
      { key: 'periodId', kind: 'ref', ref: 'accounting-periods' },
      { key: 'fromCurrency', kind: 'code' },
      { key: 'toCurrency', kind: 'code' },
      { key: 'currentRate', kind: 'number' },
      { key: 'averageRate', kind: 'number' },
      { key: 'historicalRate', kind: 'number' },
      { key: 'source', kind: 'text' },
    ],
    fields: [
      { key: 'periodId', kind: 'ref', ref: 'accounting-periods', required: true, lockedOnEdit: true },
      { key: 'fromCurrency', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'toCurrency', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'currentRate', kind: 'decimal', required: true },
      { key: 'averageRate', kind: 'decimal', required: true },
      { key: 'historicalRate', kind: 'decimal', required: true },
      { key: 'source', kind: 'select', required: true, options: CONSOLIDATED_RATE_SOURCES },
    ],
  },
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
