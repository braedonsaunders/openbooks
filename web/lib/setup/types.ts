/** Setup-registry descriptor types and pure helpers (split from registry.ts; pure moves only). */
export type SetupFieldKind =
  | 'text'
  | 'country'
  | 'textarea'
  | 'json'
  /** A jsonb array of free-text strings (e.g. job titles). Renders as the
   *  TagInput chip control — never as raw JSON — with type-ahead over the
   *  field's `ref` option source and free entry for values the list lacks. */
  | 'stringArray'
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
  | 'badge'
  | 'percent'
  | 'ref'
  | 'date'
  | 'number'
  | 'boolean'

/**
 * Where a `ref`/`multiref`/`stringArray` field's options come from.
 * `'accounts'` = the org's postable accounts; `'job-titles'` = the distinct
 * free-text titles on the employee roster. Any other value is a setup entity
 * `key` (self-references allowed, e.g. a department's parent). The list page
 * resolves each declared source into `{ value, label }[]` and hands them to
 * the drawer.
 */
export type SetupRefSource = 'accounts' | (string & {})

/**
 * One select/badge/filter option. `labelKey` (under `admin.setup.options.*`)
 * for translated enum labels; `label` for declaration-carried literals — a
 * country pack's filing program types are statutory proper nouns resolved at
 * render time (web/lib/setup/dynamic-options.ts), never a message catalog.
 */
export interface SetupOption {
  value: string
  labelKey?: string
  label?: string
}

/** Resolve an option's display label — labelKey wins, then the literal. */
export const setupOptionLabel = (
  option: SetupOption,
  t: (key: string) => string,
): string => (option.labelKey ? t(option.labelKey) : (option.label ?? option.value))

/**
 * Options that come from a runtime registry rather than this pure module.
 * Server surfaces materialize them via `resolveDynamicSetupOptions`
 * (web/lib/setup/dynamic-options.ts); the statically declared options remain
 * as the fallback for any surface that has not resolved them.
 *
 * - `payroll-filing-countries`     — countries with a declared payroll pack
 * - `payroll-filing-program-types` — the packs' declared filing program types
 * - `payroll-component-countries`  — installable payroll packs, for the
 *   pay-component country picker (a component applies to a pack's employees)
 * - `payroll-deduction-treatments` — the packs' declared pre-tax treatments,
 *   resolved per country into `scopedOptions` (plus the cross-pack union as
 *   the flat `options` fallback)
 * - `payroll-contribution-programs` — the packs' declared contribution
 *   programs (engine/src/payroll/packs.ts), for the pay-component program
 *   exclusion picker. Cross-pack union; free entry covers the rest, and a
 *   key no pack declares is inert on runs.
 */
export type SetupDynamicOptionsSource =
  | 'payroll-filing-countries'
  | 'payroll-filing-program-types'
  | 'payroll-component-countries'
  | 'payroll-deduction-treatments'
  | 'payroll-contribution-programs'
  | 'payroll-statutory-reporting-categories'

export interface SetupField {
  key: string
  kind: SetupFieldKind
  /** Storage type for stringArray fields; defaults to jsonb. */
  arrayStorage?: 'jsonb' | 'text'
  required?: boolean
  /** Inclusive resource/domain bounds for integer and percent fields. */
  min?: number
  max?: number
  /** select options; labelKey is under `admin.setup.options.*`. */
  options?: SetupOption[]
  /** Replace `options` from a runtime registry on server surfaces. */
  optionsSource?: SetupDynamicOptionsSource
  /**
   * Per-value option lists for a select whose choices depend on another
   * field in the same drawer (pay-component treatments depend on the
   * component's country: the dialog renders the treatments THAT pack
   * declares, not a fixed list). Server surfaces fill `byValue` from the
   * runtime registry; `setupFieldOptions` picks the list for the live scope
   * value. The generic layer never names the scope field — it reads
   * `scopeField` from this declaration.
   */
  scopedOptions?: { scopeField: string; byValue: Record<string, SetupOption[]> }
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
  /** Persisted field managed by another visible control; omit it from drawers. */
  hidden?: boolean
  /** Optional explanatory copy rendered directly beneath the control. */
  helpTextKey?: string
  /** Heading the drawer groups this field under (message key). Consecutive
   *  fields sharing a section render beneath one subheading. */
  sectionKey?: string
  /** Render only while another field in the same drawer holds one of these
   *  values — a setting that cannot apply to the record being edited (payroll
   *  protection on an earning) is noise, not a disabled control. The domain
   *  rule is still enforced by the table's CHECK constraints; this only keeps
   *  the form honest. */
  showWhen?: { field: string; in: string[] }
}

/** Whether a conditional field applies to the values currently in the form. */
export function setupFieldVisible(field: SetupField, values: Record<string, unknown>): boolean {
  if (field.hidden) return false
  if (!field.showWhen) return true
  return field.showWhen.in.includes(String(values[field.showWhen.field] ?? ''))
}

/**
 * The select options that apply to the values currently in the form. A
 * field without `scopedOptions` offers its static `options`; a scoped field
 * offers the list for the live scope value (the component's country), the
 * cross-pack union when the scope is empty (a shared component applies to
 * every pack's employees, and the compute layer keys off the employee's
 * pack — so a foreign key is inert there rather than wrong), and the static
 * fallback when the scope names nothing declared. Render and write paths
 * both resolve through this, so the picker can never offer what the server
 * refuses.
 */
export function setupFieldOptions(field: SetupField, values: Record<string, unknown>): SetupOption[] {
  const scoped = field.scopedOptions
  if (!scoped) return field.options ?? []
  const scope = String(values[scoped.scopeField] ?? '')
  if (scope !== '') return scoped.byValue[scope] ?? field.options ?? []
  const seen = new Set<string>()
  const union: SetupOption[] = []
  for (const list of Object.values(scoped.byValue)) {
    for (const option of list) {
      if (!seen.has(option.value)) {
        seen.add(option.value)
        union.push(option)
      }
    }
  }
  return union.length > 0 ? union : (field.options ?? [])
}

export interface SetupColumn {
  key: string
  kind: SetupColumnKind
  ref?: SetupRefSource
  /** Optional value labels for enum-like list columns. */
  options?: SetupOption[]
  /** Replace `options` from a runtime registry on server surfaces. */
  optionsSource?: SetupDynamicOptionsSource
}

/** Enum list filter rendered above the table, bound to the `f_<key>` param. */
export interface SetupFilter {
  /** Column key (also the translation key under `admin.setup.fields`). */
  key: string
  options: SetupOption[]
  /** Replace `options` from a runtime registry on server surfaces. */
  optionsSource?: SetupDynamicOptionsSource
  /** Rows with a NULL value match every choice (shared/global records). */
  nullMatchesAll?: boolean
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
  /** Field key whose column carries the ref option value. Defaults to the
   *  idColumn (usually `id`); entities referenced by natural key (e.g.
   *  hrm-document-categories, stored as `key` on templates and retention
   *  schedules) declare it so pickers offer the stored value. The generic
   *  coercer accepts non-UUID input for refs to such entities. */
  refValue?: string
  /** ORDER BY column when there is no natural key. */
  orderBy?: string
  /** Whether the table has `is_active` (→ archive on delete instead of hard delete). */
  hasActive: boolean
  /** Shared/reference entities remain readable but cannot be mutated by tenant setup admins. */
  readOnly?: boolean
  /** Declaration-backed settings permit editing values but cannot be created/deleted here. */
  allowCreate?: boolean
  allowDelete?: boolean
  dataSource?: 'extension-settings' | 'home-announcements'
  /** Documentation-center article slug — renders a "Learn more" link on the tab. */
  docSlug?: string
  /** Parent setup entity that owns this configuration surface. Nested entities
   *  remain available to the shared CRUD API but do not render as standalone
   *  setup-rail pages. */
  nestedUnder?: string
  /** Re-homed onto an operational record/module (e.g. Inventory, Items,
   *  customer/project drawers). Still served by the shared CRUD API and
   *  embeddable via <SetupEntitySection>, but hidden from the setup rail and
   *  404s as a standalone /admin/setup page — it has one home elsewhere. */
  rehomed?: boolean
  /** The home a bookmarked /admin/setup/<key> redirects to, with the
   *  ?movedFrom notice. Required on every rehomed entry: a rehomed entity
   *  without a recorded home is a 404 with no way back. May carry the
   *  section address (e.g. '/admin/setup/payroll?tab=schedules'). */
  rehomedTo?: string
  /** Optional-feature gate (web/lib/features.ts key). When the feature is off,
   *  this entity is hidden from the setup rail and 404s as a standalone page. */
  featureKey?: string
  columns: SetupColumn[]
  fields: SetupField[]
  /** Enum dropdown filters rendered beside search. */
  filters?: SetupFilter[]
}

/** Direct subsidiary anchor for generic row visibility and write authorization. */
export function setupEntitySubsidiaryField(entity: SetupEntity): SetupField | undefined {
  return entity.fields.find((field) => field.ref === 'subsidiaries')
}

/** References whose target row carries the subsidiary ownership anchor. */
export function setupEntitySubsidiaryReferenceFields(entity: SetupEntity): SetupField[] {
  return entity.fields.filter((field) => field.ref === 'equipment-units')
}

/**
 * Optional-module columns are not merely nullable database fields. Keep the
 * registry as the source of truth, then derive the UI/write descriptor so
 * every generic setup list, drawer, and CRUD write applies the same guard.
 * Turning a feature off hides the control and refuses a new write; existing
 * values stay on the row.
 */
export function setupEntityForFeatureState(
  entity: SetupEntity,
  features: { multiSubsidiary: boolean; equipment?: boolean; fieldTickets?: boolean },
): SetupEntity {
  const equipmentOn = features.equipment !== false
  const fieldTicketsOn = features.fieldTickets !== false
  if (features.multiSubsidiary && equipmentOn && fieldTicketsOn) return entity
  const isSubsidiaryControl = (control: SetupField | SetupColumn) =>
    control.ref === 'subsidiaries' || control.key === 'subsidiaryIncludeChildren'
  const isEquipmentControl = (control: SetupField | SetupColumn) =>
    control.key === 'equipmentUnitId' || control.ref === 'equipment-units'
  const isFieldTicketControl = (control: SetupField | SetupColumn) =>
    control.key === 'showOnFieldTicket'
  const withoutEquipmentCharge = <T extends { options?: SetupOption[] }>(control: T): T => {
    if (equipmentOn || !control.options?.some((option) => option.value === 'equipment_charge')) {
      return control
    }
    return { ...control, options: control.options.filter((option) => option.value !== 'equipment_charge') }
  }
  const visible = (control: SetupField | SetupColumn) =>
    (features.multiSubsidiary || !isSubsidiaryControl(control))
    && (equipmentOn || !isEquipmentControl(control))
    && (fieldTicketsOn || !isFieldTicketControl(control))
  return {
    ...entity,
    columns: entity.columns.filter(visible).map(withoutEquipmentCharge),
    fields: entity.fields.filter(visible).map(withoutEquipmentCharge),
    filters: entity.filters?.map(withoutEquipmentCharge),
  }
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
  { key: 'projects', iconKey: 'briefcase' },
  { key: 'compliance', iconKey: 'shield' },
  { key: 'billing', iconKey: 'hash' },
  { key: 'revenue', iconKey: 'trending-up' },
  { key: 'inventory', iconKey: 'package' },
  { key: 'workforce', iconKey: 'users' },
  { key: 'assets', iconKey: 'landmark' },
  { key: 'currency', iconKey: 'coins' },
  { key: 'agents', iconKey: 'sparkles' },
]

