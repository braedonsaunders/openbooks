/**
 * Transaction form + record list customization — shared type model.
 *
 * This package is the single source of truth for the SHAPE of a customized
 * form layout (FormLayoutConfig) and a saved list view (ListViewConfig), plus
 * the catalog of customizable record types and their fields (the registry).
 * It is framework-agnostic (no React, no db) so the schema layer stores it,
 * the engine validates it, and the web layer renders from it.
 *
 * The value store for custom fields remains custom_field_defs + each table's
 * `custom` jsonb (see web/lib/custom-fields). This package does NOT duplicate
 * that registry — it references custom fields by their stable `cf_<key>`.
 */

/** Stable record-type key: a document kind or an entity key. e.g. 'vendor_bill'. */
export type RecordTypeKey = string

/** A built-in field key (snake_case, matches the data model) or `cf_<customKey>`. */
export type FieldKey = string

/** Where a field lives on a transaction form. */
export type FieldLevel = 'header' | 'line'

/**
 * The structural kind of a field — drives the input the renderer draws, the
 * LineGrid column type, and the operators a list filter supports.
 */
export type FieldKind =
  | 'text'
  | 'long_text'
  | 'number'
  | 'currency'
  | 'date'
  | 'boolean'
  | 'select'
  | 'multi_select'
  | 'entity_ref'
  | 'dimension'
  | 'amount'
  | 'tax'
  | 'status'

/* ------------------------------------------------------------------ */
/* Form layout (transaction form customization)                       */
/* ------------------------------------------------------------------ */

/** Placement of one field in a form layout. */
export interface HeaderFieldPlacement {
  /** Built-in field key or `cf_<customKey>`. */
  key: FieldKey
  /** Hidden when false. Default true. */
  visible: boolean
  /** Override the default label (null/undefined = use the registry default). */
  labelOverride?: string | null
  /**
   * Force-required on this form. Only honoured when the registry marks the
   * field `requiredOverridable`. System-required fields are always required
   * regardless of this flag.
   */
  required?: boolean | null
  /**
   * Width in a 4-column header grid (1–4). null/undefined = 1. source platform custom
   * forms control field width/positioning; this reproduces the existing layout.
   */
  colSpan?: number | null
}

/** An ordered, optionally-labelled group of header fields (source platform "tab"). */
export interface HeaderGroup {
  /** Stable id within this layout. */
  id: string
  /** Optional group label; empty = unlabeled group. */
  label?: string | null
  fields: HeaderFieldPlacement[]
}

/** Placement of one line column. */
export interface LineColumnPlacement {
  key: FieldKey
  visible: boolean
  /** CSS grid track (e.g. 'minmax(200px,2fr)', '120px'). null = kind default. */
  width?: string | null
  labelOverride?: string | null
}

/** A lifecycle or utility action rendered in a transaction flyout header. */
export interface FormActionPlacement {
  key: string
  visible: boolean
}

/**
 * Placement of one tab on a record flyout.
 *
 * A record cockpit's tabs are as much a layout decision as its fields, so they
 * are customized the same way: hide the ones a company doesn't use, reorder to
 * match how it works, rename to its vocabulary, and add tabs of its own.
 *
 * Two kinds exist. A BUILT-IN tab (`key` matches the record type's registered
 * tab) renders the product panel behind it — the designer can hide, rename and
 * reorder it, but never author its contents. A CUSTOM tab (`key` starts with
 * `tab_`) is authored here and renders the header groups listed in `groupIds`,
 * which is how a company puts its own fields on their own tab instead of at the
 * bottom of Overview.
 */
export interface FormTabPlacement {
  /** Registered built-in tab key, or `tab_<slug>` for an author-created tab. */
  key: string
  /** Hidden when false. Default true. */
  visible: boolean
  /** Override the default label (null/undefined = registry default). */
  labelOverride?: string | null
  /**
   * Header group ids rendered on this tab. Only meaningful for custom tabs;
   * built-in tabs render their product panel.
   */
  groupIds?: string[]
}

/** Prefix that marks an author-created tab. */
export const CUSTOM_TAB_PREFIX = 'tab_'

export function isCustomTabKey(key: string) {
  return key.startsWith(CUSTOM_TAB_PREFIX)
}

export interface FormLayoutConfig {
  schemaVersion: 1
  /** One-time marker for the baseline-form visibility defaults applied by the
   * tenant provisioner. It prevents later user choices from being reset. */
  defaultVisibilityVersion?: 1
  /** One-time marker for the current built-in placement defaults applied to
   * the tenant-owned baseline form. Named custom forms are never reset. */
  defaultLayoutVersion?: 1
  recordType: RecordTypeKey
  header: { groups: HeaderGroup[] }
  lines: { columns: LineColumnPlacement[] }
  /** Ordered flyout actions. Runtime permissions/status still decide whether
   * an enabled action is currently available. */
  actions: FormActionPlacement[]
  /**
   * Ordered flyout tabs. Absent on record types without a tabbed cockpit, and
   * on layouts saved before tabs became customizable — the renderer falls back
   * to the registry order in both cases.
   */
  tabs?: FormTabPlacement[]
}

/* ------------------------------------------------------------------ */
/* List view (record list customization)                              */
/* ------------------------------------------------------------------ */

export type FilterOperator =
  | 'eq'
  | 'ne'
  | 'in'
  | 'not_in'
  | 'gte'
  | 'lte'
  | 'between'
  | 'contains'
  | 'is_set'
  | 'is_not_set'

/** One structured filter clause in a saved view. */
export interface FilterClause {
  key: FieldKey
  operator: FilterOperator
  /** Single value (eq/ne/gte/lte/contains/entity_ref) or array (in/not_in). */
  value?: string | string[] | null
  /** Upper bound for `between`. */
  to?: string | null
}

export interface ListColumnPlacement {
  key: FieldKey
  visible: boolean
  width?: number | null
  labelOverride?: string | null
}

export interface ListViewConfig {
  schemaVersion: 1
  recordType: RecordTypeKey
  columns: ListColumnPlacement[]
  filters: FilterClause[]
  sort?: { column: string; dir: 'asc' | 'desc' } | null
  perPage?: number | null
}

/* ------------------------------------------------------------------ */
/* Registry — the catalog of customizable record types & fields      */
/* ------------------------------------------------------------------ */

export interface FieldMeta {
  key: FieldKey
  /** next-intl message key (relative to root) for the default label. */
  labelKey: string
  level: FieldLevel
  kind: FieldKind
  /** System-required (cannot be turned off). */
  required?: boolean
  /** Cannot be hidden, reordered, or renamed (e.g. the record id column). */
  locked?: boolean
  /** The form designer may toggle `required` for this field. */
  requiredOverridable?: boolean
}

export type ListColumnKind =
  | 'text'
  | 'amount'
  | 'date'
  | 'status'
  | 'reference'
  | 'custom'
  | 'actions'

export interface ListColumnMeta {
  key: FieldKey
  labelKey: string
  kind: ListColumnKind
  sortable?: boolean
  /** Sort key the web query builder maps to a whitelisted SQL fragment. */
  sortKey?: string
  locked?: boolean
  /** Hidden in the seeded default view (still available to add in the designer). */
  defaultHidden?: boolean
  /** Default column width (px) when the view doesn't specify one. */
  defaultWidth?: number
}

export type ListFilterKind =
  | 'select'
  | 'multi_select'
  | 'entity_ref'
  | 'date'
  | 'boolean'
  | 'text'

export interface ListFilterOption {
  value: string
  /** i18n key for the label (relative to root). Omit → render `value`. */
  labelKey?: string
}

export interface ListFilterMeta {
  key: FieldKey
  labelKey: string
  kind: ListFilterKind
  operators: readonly FilterOperator[]
  /** For select/multi_select: the static option set. */
  options?: ListFilterOption[]
  /** For entity_ref: which picker source (resolved by web). */
  entitySource?: string
}

/**
 * A tab the record's flyout can draw. `featureKey` ties a tab to an optional
 * feature: the designer still lists it (so configuration is discoverable), but
 * the renderer hides it while the feature is off — a layout choice can never
 * turn a gated capability back on.
 */
export interface FormTabMeta {
  key: string
  labelKey: string
  /** Cannot be hidden or reordered away (the record's primary tab). */
  locked?: boolean
  /** Feature gate this tab belongs to, if any. */
  featureKey?: string
}

export interface RecordTypeMeta {
  key: RecordTypeKey
  labelKey: string
  /** 'transaction' forms have header + lines; 'entity' forms have header only. */
  category: 'transaction' | 'entity'
  headerFields: FieldMeta[]
  lineFields: FieldMeta[]
  listColumns: ListColumnMeta[]
  listFilters: ListFilterMeta[]
  /**
   * Whether this record type has a customizable transaction FORM (header/line
   * layout). Defaults to true. Set false for record types whose list views are
   * customizable but whose editor is a bespoke flyout (e.g. payments), so the
   * customization admin shows only the list-view designer.
   */
  supportsForms?: boolean
  /**
   * The table whose `custom` jsonb + custom_field_defs back this record type's
   * custom fields. Defaults to 'documents' (transactions). Entity record types
   * point at their own table (e.g. 'projects'). Custom-field defs for entity
   * tables use a null `target_kind`; documents defs use the record type as kind.
   */
  customFieldTable?: string
  /**
   * The table backing LINE custom fields, or null for header-only record types
   * (all 'entity' types, plus payments/transfer). Defaults to 'document_lines'.
   */
  customFieldLineTable?: string | null
  /**
   * Tabs this record's flyout draws, in default order. Record types without a
   * tabbed cockpit omit this.
   */
  tabs?: FormTabMeta[]
}

export const DEFAULT_PER_PAGE = 25
