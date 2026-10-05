/** Setup-registry descriptor types and pure helpers (split from registry.ts; pure moves only). */
import type { SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { featureEnabled, type FeatureState } from '@openbooks/engine/src/organization/feature-registry.ts'

export type SetupFieldKind =
  | 'text'
  | 'country'
  | 'textarea'
  | 'json'
  /** Named structured controls stored in one JSON object or array. */
  | 'object'
  | 'objectArray'
  /** ISO timestamp with an explicit UTC offset; preserved as entered. */
  | 'zonedDateTime'
  /** A jsonb array of free-text strings (e.g. job titles). Renders as the
   *  TagInput chip control — never as raw JSON — with type-ahead over the
   *  field's `ref` option source and free entry for values the list lacks. */
  | 'stringArray'
  | 'integer'
  | 'decimal'
  | 'percent'
  /**
   * A storage-minor-units amount entered as operator majors ("120.50",
   * never "12050"). The drawer converts through the sibling
   * `currencyField` (default `currency`) at save and display time; the
   * stored value keeps the exact minor-unit shape every write path takes
   * today, so commands, schemas and coercion are untouched.
   */
  | 'money'
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
   * A storage-minor-units amount rendered as operator majors. The column
   * reads the sibling `currencyField` for the code and formats through its
   * minor-unit precision.
   */
  | 'money'

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
 * - `payroll-protection-classes` — the packs' declared classes of protected
 *   order (creditor garnishment, support order), scoped per country like
 *   the treatments
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
  | 'payroll-protection-classes'
  | 'payroll-contribution-programs'
  | 'payroll-statutory-reporting-categories'

export interface SetupField {
  key: string
  /** Names declared by an approved policy are record data rather than catalog keys. */
  label?: string
  kind: SetupFieldKind
  /** Nested keys are stored verbatim, preserving the domain JSON contract. */
  fields?: SetupField[]
  /** Storage type for stringArray fields; defaults to jsonb. */
  arrayStorage?: 'jsonb' | 'text'
  required?: boolean
  /** Native form presentation; these options do not change storage or validation. */
  fullWidth?: boolean
  booleanStyle?: 'switch'
  /** Named structured rows keep their domain vocabulary in the shared editor. */
  itemTitleKey?: string
  itemTitleField?: string
  /** On addition only, initialize this integer field above the existing row numbers. */
  itemSequenceKey?: string
  addLabelKey?: string
  /** A boolean can preserve NULL as distinct from false. */
  nullable?: boolean
  /** Inapplicable controls clear their value in the shared form payload. */
  clearWhenHidden?: boolean
  /** Structured domain JSON omits inapplicable optional keys instead of sending null. */
  omitWhenHidden?: boolean
  /** Exact decimal scale declared by the native storage contract. */
  decimalScale?: number
  /** Sibling field holding the 3-letter currency code for `money` fields. */
  currencyField?: string
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
  /** Filter native reference choices by the live owning entity. */
  refScopeField?: string
  /**
   * Narrow an `accounts` ref to these account types, so the picker offers
   * only accounts the entity's write guard accepts. The guard stays the
   * enforcement; this only keeps refused choices out of the list.
   */
  refAccountTypes?: readonly string[]
  /** Natural keys / immutable columns: editable on create, read-only on edit. */
  lockedOnEdit?: boolean
  /** Column is NOT NULL with a DB default — when left blank, omit it (let the
   *  default apply) instead of writing null, which would violate the constraint. */
  keepDefault?: boolean
  /** decimal/integer default shown as placeholder text (message key). */
  defaultHintKey?: string
  /** Initial value for a new record; database defaults remain authoritative. */
  defaultValue?: string | number | boolean | Record<string, unknown> | unknown[]
  /** New reasons are deliberate input, rather than a replay of the stored explanation. */
  resetOnEdit?: boolean
  /** Persisted field managed by another visible control; omit it from drawers. */
  hidden?: boolean
  /** Presentation label for a rehomed, type-specific native form. */
  labelKey?: string
  /** Optional explanatory copy rendered directly beneath the control. */
  helpTextKey?: string
  /** Legal employment ownership remains available without multi-subsidiary management. */
  legalEmployer?: boolean
  /** Heading the drawer groups this field under (message key). Consecutive
   *  fields sharing a section render beneath one subheading. */
  sectionKey?: string
  /** Render only while another field in the same drawer holds one of these
   *  values — a setting that cannot apply to the record being edited (payroll
   *  protection on an earning) is noise, not a disabled control. The domain
   *  rule is still enforced by the table's CHECK constraints; this only keeps
   *  the form honest. */
  showWhen?: SetupFieldCondition
}

/** Whether a conditional field applies to the values currently in the form. */
export type SetupFieldCondition = { field: string; in: string[] } | { field: string; present: boolean } | { all: SetupFieldCondition[] }

function setupFieldValue(values: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(values, path)) return values[path]
  let value: unknown = values
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

export function setupFieldVisible(field: SetupField, values: Record<string, unknown>): boolean {
  if (field.hidden) return false
  function matches(condition: SetupFieldCondition): boolean {
    if ('all' in condition) return condition.all.every(matches)
    const value = setupFieldValue(values, condition.field)
    return 'present' in condition ? condition.present === (value != null && value !== '') : condition.in.includes(String(value ?? ''))
  }
  return !field.showWhen || matches(field.showWhen)
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
  const scope = String(setupFieldValue(values, scoped.scopeField) ?? '')
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
  /** Presentation label without changing the global field vocabulary. */
  labelKey?: string
  kind: SetupColumnKind
  ref?: SetupRefSource
  /** Optional value labels for enum-like list columns. */
  options?: SetupOption[]
  /** Replace `options` from a runtime registry on server surfaces. */
  optionsSource?: SetupDynamicOptionsSource
  /** Sibling field holding the 3-letter currency code for `money` columns. */
  currencyField?: string
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

/**
 * A setup entity whose writes go through a domain command instead of generic
 * CRUD. The name, permission, and feature are declaration-owned, never
 * request-controlled: the command route dispatches on the literal name, gates
 * the declared permission and feature server-side, and parses the body with
 * the command's own strict schema. Generic CRUD refuses command-owned
 * entities before body parsing with a remedy naming the command endpoint.
 */
export type SetupCommandName =
  | 'setFramework'
  | 'setFundPair'
  | 'setFunctionalMapping'
  | 'upsertChannelAccountMap'
  | 'upsertChannelLocation'
  | 'savePortalSettings'
  | 'recordChannelAdSpend'

export interface SetupCommandDescriptor {
  /** Exhaustive dispatch key — one literal per domain command, dispatched in the command route. */
  name: SetupCommandName
  /** Mutation grant the command endpoint enforces (least privilege per domain). */
  permission: 'funds.manage' | 'channels.manage' | 'documents.manage'
  /** Authoritative Company Settings → Features key enforced server-side. */
  feature: 'fundAccounting' | 'functionalExpenses' | 'salesChannels' | 'customerPortal'
}

/**
 * One card on a create drawer's first step. Choosing it pre-fills the form
 * with `values` (registry field keys), which in turn decides which
 * conditional fields and sections the form shows next.
 */
export interface SetupCreateChoice {
  key: string
  /** Message keys under `admin.setup`. */
  labelKey: string
  descriptionKey: string
  /** lucide icon key, mapped by the drawer. */
  iconKey: string
  values: Record<string, unknown>
}

export interface SetupEntity {
  /** Rehomed forms group the same registry fields into shared inspector sections. */
  formSections?: { titleKey: string; descriptionKey?: string; fields: string[] }[]
  /**
   * Open the create drawer on a choice of kinds instead of a blank form.
   * The chosen card pre-fills its values; the operator can go back and
   * choose again until the record is created. Editing never shows it.
   */
  createChooser?: { titleKey: string; descriptionKey: string; options: SetupCreateChoice[] }
  formDescriptionKey?: string
  drawerSize?: 'lg' | 'xl' | '2xl'
  /** Domain-owned aggregate endpoint. Generic row writes must refuse these
   * entities because child validation and audit evidence belong to the domain. */
  mutationPath?: string
  /** Aggregate endpoints receive only their declared create or update contract. */
  mutationCreateKeys?: readonly string[]
  mutationUpdateKeys?: readonly string[]
  /** The current server-loaded revision is included on aggregate updates. */
  mutationRevision?: { requestKey: string; rowColumn: string }
  /** URL slug, e.g. 'tax-codes'. */
  key: string
  /** DB table name. */
  table: string
  /** Optional collection title for a rehomed native presentation. */
  titleKey?: string
  /** Optional translation key for the singular record name used in drawers. */
  singularTitleKey?: string
  /** Optional guided creation using the same fields, validation and writer. */
  creationSteps?: { key: string; titleKey: string; descriptionKey: string; fields: string[] }[]
  /** Authorized operational links shown by the shared record drawer. */
  recordLinks?: { href: string; label: string }[]
  /** Server-only presentation of native record-owned collections. */
  recordChildren?: SetupEntity[]
  /** Continue creation in the owning record when child configuration is required. */
  createDestination?: { rowParam: string; tabKey?: string }
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
  /** Effective-dated history is replaced by creating a new version. */
  allowUpdate?: boolean
  allowDelete?: boolean
  dataSource?: 'extension-settings' | 'home-announcements'
  /** Documentation-center article slug — renders a "Learn more" link on the tab. */
  docSlug?: string
  /** Parent setup entity that owns this configuration surface. Nested entities
   *  remain available to the shared CRUD API but do not render as standalone
   *  setup-rail pages. */
  nestedUnder?: string
  /** Record-owned collections have no independent setup page. Multiple entries
   *  describe mutually exclusive owners, such as a plan OR a pay component. */
  parentRecords?: { entityKey: string; fieldKey: string; valueKey?: string }[]
  /** Re-homed onto an operational record/module (e.g. Inventory, Items,
   *  customer/project drawers). Still served by the shared CRUD API and
   *  embeddable via <SetupEntitySection>, but hidden from the setup rail and
   *  404s as a standalone /admin/setup page — it has one home elsewhere. */
  rehomed?: boolean
  /** Optional-feature gate (web/lib/features.ts key). When the feature is off,
   *  this entity is hidden from the setup rail and 404s as a standalone page. */
  featureKey?: string
  /** Any-of feature gate: the entity is available while ANY listed feature is
   *  on (e.g. labor costing serves Projects and Manufacturing alike).
   *  Exactly one of `featureKey` / `featureKeysAny` may be declared — never
   *  both. A descriptor declaring both, or naming an unknown key, fails
   *  closed through `resolveSetupEntityGate`. */
  featureKeysAny?: string[]
  /** Command ownership: when present, generic CRUD refuses this entity and
   *  writes go through the entity-addressed command endpoint instead. */
  command?: SetupCommandDescriptor
  /**
   * How the generic data import may write this entity. Absent means the
   * shared row writer (the same coercion, reference resolution, validators
   * and audit the interactive form shares). `'command'` routes every import
   * row through the entity's engine command, so effective dating, uniqueness
   * guards, audit evidence and the feature gate match the interactive path.
   * `'none'` excludes the entity from import with a named refusal — for
   * singleton or aggregate configuration no row stream can express, and for
   * sealed material that must never travel in a file. Every entity carrying
   * `command` or `mutationPath` declares one: the generic CRUD path refuses
   * both, so the import writer must not be the one path that allows them.
   */
  importVia?: 'command' | 'none'
  /** Additional permission required to create, edit, or delete this entity. */
  writePermission?: string
  /** Server-side validation for invariants that belong to one entity. */
  validateWrite?: SetupEntityValidationHook
  columns: SetupColumn[]
  fields: SetupField[]
  /** Enum dropdown filters rendered beside search. */
  filters?: SetupFilter[]
}

/**
 * The verdict of a setup entity's feature gate. `remedy` is the exact
 * operator instruction for a closed gate; null while the gate is open (and
 * for single-key gates, which keep their existing hide/redirect semantics).
 */
export interface SetupEntityGate {
  enabled: boolean
  remedy: string | null
}

/**
 * Operator remedy when neither Projects nor Manufacturing is enabled.
 * Turning features off preserves rows and history — this names the
 * switchboard that turns them back on.
 */
export const SETUP_PROJECTS_OR_MANUFACTURING_REMEDY =
  'Turn on Projects or Manufacturing in Company Settings → Features.'

/** Fallback remedy for a closed any-of gate over any other key set. */
const SETUP_GENERIC_FEATURE_REMEDY = 'Turn on the required feature in Company Settings → Features'

function setupAnyOfRemedy(keys: string[]): string {
  const members = new Set(keys)
  if (members.size === 2 && members.has('projects') && members.has('manufacturing')) {
    return SETUP_PROJECTS_OR_MANUFACTURING_REMEDY
  }
  return SETUP_GENERIC_FEATURE_REMEDY
}

/**
 * One authoritative feature-gate verdict for every setup consumer — the rail,
 * the standalone loader, the drawer slot, and the shared CRUD read/write
 * path. No caller reimplements the OR: a single-key gate follows its key, an
 * any-of gate passes while any member is on, and an ungated entity is always
 * on. Both keys declared, an empty member list, or an unknown key fails
 * closed (`featureEnabled` already refuses unknown keys; the descriptor
 * conflict is refused here so no caller can read it as open).
 */
export function resolveSetupEntityGate(
  entity: Pick<SetupEntity, 'featureKey' | 'featureKeysAny'>,
  features: FeatureState,
): SetupEntityGate {
  const single = entity.featureKey
  const anyOf = entity.featureKeysAny
  if (single && anyOf) return { enabled: false, remedy: SETUP_GENERIC_FEATURE_REMEDY }
  if (anyOf) {
    const enabled = anyOf.some((key) => featureEnabled(features, key))
    return enabled ? { enabled: true, remedy: null } : { enabled: false, remedy: setupAnyOfRemedy(anyOf) }
  }
  if (single) return { enabled: featureEnabled(features, single), remedy: null }
  return { enabled: true, remedy: null }
}

export interface SetupEntityValidationContext {
  entity: SetupEntity
  body: Record<string, unknown>
  orgId: string
  rowId?: string
  executor: SqlExecutor
}

export type SetupEntityValidationHook = (context: SetupEntityValidationContext) => Promise<string | null | void>

/** Remove server-only hooks before a descriptor crosses into a client component. */
export function setupEntityClientDescriptor(entity: SetupEntity): Omit<SetupEntity, 'validateWrite'> {
  const descriptor = { ...entity }
  delete descriptor.validateWrite
  delete descriptor.recordChildren
  return descriptor
}

/** Direct subsidiary anchor for generic row visibility and write authorization. */
export function setupEntitySubsidiaryField(entity: SetupEntity): SetupField | undefined {
  return entity.fields.find((field) => field.ref === 'subsidiaries')
}

/** Structured form references are loaded from the same catalog as top-level controls. */
export function setupReferenceSources(entity: SetupEntity): SetupRefSource[] {
  const sources = new Set<SetupRefSource>()
  for (const column of entity.columns) if (column.ref) sources.add(column.ref)
  function visit(fields: readonly SetupField[]) {
    for (const field of fields) {
      if (field.ref) sources.add(field.ref)
      if (field.fields) visit(field.fields)
    }
  }
  visit(entity.fields)
  return [...sources]
}

/** References whose target row carries the subsidiary ownership anchor. */
export function setupEntitySubsidiaryReferenceFields(entity: SetupEntity): SetupField[] {
  const references = entity.fields.filter((field) => ['equipment-units', 'worker-employments', 'benefit-plans', 'benefit-enrollment-configuration'].includes(field.ref ?? ''))
  return references.some((field) => field.ref === 'worker-employments') ? references.filter((field) => field.ref === 'worker-employments') : references
}

/**
 * Optional-module columns are not merely nullable database fields. Keep the
 * registry as the source of truth, then derive the UI/write descriptor so
 * every generic setup list, drawer, and CRUD write applies the same guard.
 * Turning a feature off hides optional controls and refuses new writes;
 * legal-employer ownership remains available and existing values stay on the row.
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
    (features.multiSubsidiary || entity.key === 'tax-registrations' || ('legalEmployer' in control && control.legalEmployer === true) || !isSubsidiaryControl(control))
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
  { key: 'sales', iconKey: 'tag' },
  { key: 'revenue', iconKey: 'trending-up' },
  { key: 'inventory', iconKey: 'package' },
  { key: 'workforce', iconKey: 'users' },
  { key: 'assets', iconKey: 'landmark' },
  { key: 'currency', iconKey: 'coins' },
  { key: 'agents', iconKey: 'sparkles' },
]
