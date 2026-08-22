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

import { PAY_DERIVED_RULE_ENTITIES } from './payroll-derived-rules'
import { PAYROLL_HOLIDAYS_ENTITY } from './payroll-holidays'

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
 */
export type SetupDynamicOptionsSource =
  | 'payroll-filing-countries'
  | 'payroll-filing-program-types'

export interface SetupField {
  key: string
  kind: SetupFieldKind
  required?: boolean
  /** select options; labelKey is under `admin.setup.options.*`. */
  options?: SetupOption[]
  /** Replace `options` from a runtime registry on server surfaces. */
  optionsSource?: SetupDynamicOptionsSource
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
  /** ORDER BY column when there is no natural key. */
  orderBy?: string
  /** Whether the table has `is_active` (→ archive on delete instead of hard delete). */
  hasActive: boolean
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
  /** Optional-feature gate (web/lib/features.ts key). When the feature is off,
   *  this entity is hidden from the setup rail and 404s as a standalone page. */
  featureKey?: string
  columns: SetupColumn[]
  fields: SetupField[]
  /** Enum dropdown filters rendered beside search. */
  filters?: SetupFilter[]
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
]

const APPLIES_TO = [
  { value: 'sales', labelKey: 'options.appliesTo.sales' },
  { value: 'purchases', labelKey: 'options.appliesTo.purchases' },
  { value: 'both', labelKey: 'options.appliesTo.both' },
]

const TAX_CALCULATION_TYPES = [
  { value: 'standard', labelKey: 'options.taxCalculationType.standard' },
  { value: 'withholding', labelKey: 'options.taxCalculationType.withholding' },
  { value: 'reverse_charge', labelKey: 'options.taxCalculationType.reverseCharge' },
]

// Values match the tax_report_lines.basis enum (schema/src/tax.ts) and the tax
// return engine: tax_amount sums the tax collected/paid, taxable_base sums the
// base the tax applied to.
const TAX_BASIS = [
  { value: 'tax_collected', labelKey: 'options.basis.collected' },
  { value: 'tax_paid', labelKey: 'options.basis.paid' },
  { value: 'tax_amount', labelKey: 'options.basis.tax' },
  { value: 'taxable_base', labelKey: 'options.basis.net' },
]

const SUBMISSION_CHANNELS = [
  { value: 'print_pdf', labelKey: 'options.channel.printPdf' },
  { value: 'file_upload', labelKey: 'options.channel.fileUpload' },
  { value: 'efile_api', labelKey: 'options.channel.efileApi' },
  { value: 'portal_manual', labelKey: 'options.channel.portalManual' },
]

const GOVERNMENT_FORMATS = [
  { value: 'portal_entry', labelKey: 'options.governmentFormat.portalEntry' },
  { value: 'certified_file', labelKey: 'options.governmentFormat.certifiedFile' },
  { value: 'api', labelKey: 'options.governmentFormat.api' },
  { value: 'paper', labelKey: 'options.governmentFormat.paper' },
]

const TAX_SIGN = [
  { value: '1', labelKey: 'options.sign.positive' },
  { value: '-1', labelKey: 'options.sign.negative' },
]

// Values match the tax_jurisdictions.level / tax_type enums (schema/src/tax.ts).
const JURISDICTION_LEVELS = [
  { value: 'country', labelKey: 'options.jurisdictionLevel.country' },
  { value: 'state', labelKey: 'options.jurisdictionLevel.state' },
  { value: 'county', labelKey: 'options.jurisdictionLevel.county' },
  { value: 'city', labelKey: 'options.jurisdictionLevel.city' },
  { value: 'special', labelKey: 'options.jurisdictionLevel.special' },
  { value: 'federal', labelKey: 'options.jurisdictionLevel.federal' },
]

const TAX_TYPES = [
  { value: 'vat', labelKey: 'options.taxType.vat' },
  { value: 'gst', labelKey: 'options.taxType.gst' },
  { value: 'hst', labelKey: 'options.taxType.hst' },
  { value: 'pst', labelKey: 'options.taxType.pst' },
  { value: 'qst', labelKey: 'options.taxType.qst' },
  { value: 'sales_use', labelKey: 'options.taxType.salesUse' },
  { value: 'consumption', labelKey: 'options.taxType.consumption' },
  { value: 'other', labelKey: 'options.taxType.other' },
]

// Values match the tax_registrations.filing_frequency enum (schema/src/tax.ts).
const FILING_FREQUENCIES = [
  { value: 'monthly', labelKey: 'options.filingFrequency.monthly' },
  { value: 'bimonthly', labelKey: 'options.filingFrequency.bimonthly' },
  { value: 'quarterly', labelKey: 'options.filingFrequency.quarterly' },
  { value: 'semiannual', labelKey: 'options.filingFrequency.semiannual' },
  { value: 'annual', labelKey: 'options.filingFrequency.annual' },
]

// Values match the tax_pool_classes.method enum (schema/src/tax-pools.ts).
const POOL_METHODS = [
  { value: 'declining', labelKey: 'options.poolMethod.declining' },
  { value: 'straight_line', labelKey: 'options.poolMethod.straightLine' },
]

const TAX_DEPRECIATION_MODELS = [
  { value: 'pool', labelKey: 'options.taxDepreciationModel.pool' },
  { value: 'macrs', labelKey: 'options.taxDepreciationModel.macrs' },
]

const MACRS_SYSTEMS = [
  { value: 'gds', labelKey: 'options.macrsSystem.gds' },
  { value: 'ads', labelKey: 'options.macrsSystem.ads' },
]

const MACRS_METHODS = [
  { value: '200_db', labelKey: 'options.macrsMethod.200db' },
  { value: '150_db', labelKey: 'options.macrsMethod.150db' },
  { value: 'straight_line', labelKey: 'options.macrsMethod.straightLine' },
]

const TAX_DEPRECIATION_CONVENTIONS = [
  { value: 'half_year', labelKey: 'options.taxDepreciationConvention.halfYear' },
  { value: 'mid_quarter', labelKey: 'options.taxDepreciationConvention.midQuarter' },
  { value: 'mid_month', labelKey: 'options.taxDepreciationConvention.midMonth' },
]

const DEPRECIATION_METHODS = [
  { value: 'straight_line', labelKey: 'options.method.straightLine' },
  { value: 'declining_balance', labelKey: 'options.method.decliningBalance' },
  { value: 'double_declining', labelKey: 'options.method.doubleDeclining' },
  { value: 'units_of_production', labelKey: 'options.method.unitsOfProduction' },
  { value: 'manual', labelKey: 'options.method.manual' },
]

const DEPRECIATION_CONVENTIONS = [
  { value: 'full_month', labelKey: 'options.convention.fullMonth' },
  { value: 'mid_month', labelKey: 'options.convention.midMonth' },
  { value: 'half_year', labelKey: 'options.convention.halfYear' },
]

const END_OF_LIFE = [
  { value: 'fully_depreciate', labelKey: 'options.endOfLife.fullyDepreciate' },
  { value: 'retain_balance', labelKey: 'options.endOfLife.retainBalance' },
]

export const OVERHEAD_RATE_KINDS = [
  { value: 'per_hour', labelKey: 'options.overheadRateKind.per_hour' },
  { value: 'percent', labelKey: 'options.overheadRateKind.percent' },
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

// --- Payroll ----------------------------------------------------------------

// Values match pay_schedules.frequency (schema/src/payroll.ts). Periods per
// year stays an explicit field so 53/27-period years can be configured.
const PAY_FREQUENCIES = [
  { value: 'weekly', labelKey: 'options.payFrequency.weekly' },
  { value: 'biweekly', labelKey: 'options.payFrequency.biweekly' },
  { value: 'semi_monthly', labelKey: 'options.payFrequency.semiMonthly' },
  { value: 'monthly', labelKey: 'options.payFrequency.monthly' },
]

const PAY_COMPONENT_KINDS = [
  { value: 'earning', labelKey: 'options.payComponentKind.earning' },
  { value: 'deduction', labelKey: 'options.payComponentKind.deduction' },
  { value: 'employer_contribution', labelKey: 'options.payComponentKind.employerContribution' },
]

const PAY_COMPONENT_COUNTRIES = [
  { value: 'CA', labelKey: 'options.payComponentCountry.CA' },
  { value: 'US', labelKey: 'options.payComponentCountry.US' },
]

const PAY_COMPONENT_BASES = [
  { value: 'fixed_amount', labelKey: 'options.payComponentBasis.fixedAmount' },
  { value: 'per_hour', labelKey: 'options.payComponentBasis.perHour' },
  { value: 'percent_of_gross', labelKey: 'options.payComponentBasis.percentOfGross' },
]

// Pre-tax treatment per the T4127 factors (F, U1, F2); 'none' = after-tax.
const PAY_TAX_TREATMENTS = [
  { value: 'none', labelKey: 'options.payTaxTreatment.none' },
  { value: 'pension_f', labelKey: 'options.payTaxTreatment.pensionF' },
  { value: 'union_dues', labelKey: 'options.payTaxTreatment.unionDues' },
  { value: 'alimony', labelKey: 'options.payTaxTreatment.alimony' },
]

// Protected-earnings base a garnishment/support order is measured against
// (Ontario Wages Act net wages, US CCPA disposable earnings, or plain gross).
const PAY_PROTECTION_BASES = [
  { value: 'none', labelKey: 'options.payProtectionBase.none' },
  { value: 'net_pay', labelKey: 'options.payProtectionBase.netPay' },
  { value: 'disposable_earnings', labelKey: 'options.payProtectionBase.disposableEarnings' },
  { value: 'gross', labelKey: 'options.payProtectionBase.gross' },
]

// The values of `protectionBase` that actually protect something — the
// percentage and priority only mean anything once a base is chosen.
const PAY_PROTECTED_BASES = ['net_pay', 'disposable_earnings', 'gross']

// Payroll filing identities: a CRA payroll program account (RP), a US federal
// EIN, or a state unemployment account (one per state, under an EIN).
// STATIC FALLBACK ONLY — server surfaces replace these with the pack
// registry's declared program types (`optionsSource:
// 'payroll-filing-program-types'`, resolved by resolveDynamicSetupOptions),
// so a registered third pack's program types appear without an edit here.
const PAYROLL_PROGRAM_TYPES = [
  { value: 'ca_rp', labelKey: 'options.payrollProgramType.caRp' },
  { value: 'us_ein', labelKey: 'options.payrollProgramType.usEin' },
  { value: 'us_state_sui', labelKey: 'options.payrollProgramType.usStateSui' },
]

// CRA remittance frequency the account is registered under.
const PAYROLL_REMITTER_TYPES = [
  { value: 'regular', labelKey: 'options.payrollRemitterType.regular' },
  { value: 'quarterly', labelKey: 'options.payrollRemitterType.quarterly' },
  { value: 'accelerated_1', labelKey: 'options.payrollRemitterType.accelerated1' },
  { value: 'accelerated_2', labelKey: 'options.payrollRemitterType.accelerated2' },
]

// Entitlement plans (pay banks). Balances are MONEY by default and displayed
// in hours at the effective wage — an hours-denominated bank silently revalues
// as wages rise. Values match schema/src/payroll-entitlements.ts.
const ENTITLEMENT_UNITS = [
  { value: 'money', labelKey: 'options.entitlementUnit.money' },
  { value: 'hours', labelKey: 'options.entitlementUnit.hours' },
]

const ENTITLEMENT_DIRECTIONS = [
  { value: 'accrue', labelKey: 'options.entitlementDirection.accrue' },
  { value: 'owe', labelKey: 'options.entitlementDirection.owe' },
]

const ENTITLEMENT_ACCRUAL_METHODS = [
  { value: 'percent_of_earnings', labelKey: 'options.entitlementAccrualMethod.percentOfEarnings' },
  { value: 'per_hour_worked', labelKey: 'options.entitlementAccrualMethod.perHourWorked' },
  { value: 'fixed_per_period', labelKey: 'options.entitlementAccrualMethod.fixedPerPeriod' },
  { value: 'manual', labelKey: 'options.entitlementAccrualMethod.manual' },
]

const ENTITLEMENT_CAP_BEHAVIORS = [
  { value: 'warn', labelKey: 'options.entitlementCapBehavior.warn' },
  { value: 'block', labelKey: 'options.entitlementCapBehavior.block' },
  { value: 'auto_payout', labelKey: 'options.entitlementCapBehavior.autoPayout' },
]

// --- Subcontractor compliance ----------------------------------------------

const COMPLIANCE_CATEGORIES = [
  { value: 'insurance', labelKey: 'options.complianceCategory.insurance' },
  { value: 'tax_form', labelKey: 'options.complianceCategory.taxForm' },
  { value: 'licence', labelKey: 'options.complianceCategory.licence' },
  { value: 'bond', labelKey: 'options.complianceCategory.bond' },
  { value: 'safety', labelKey: 'options.complianceCategory.safety' },
  { value: 'other', labelKey: 'options.complianceCategory.other' },
]

// What a lapse does. `block_bill` is strictly stronger than `block_payment`:
// evidence that stops a bill being recorded also stops its cash leaving.
const COMPLIANCE_ENFORCEMENT = [
  { value: 'advisory', labelKey: 'options.complianceEnforcement.advisory' },
  { value: 'warn', labelKey: 'options.complianceEnforcement.warn' },
  { value: 'block_payment', labelKey: 'options.complianceEnforcement.blockPayment' },
  { value: 'block_bill', labelKey: 'options.complianceEnforcement.blockBill' },
]

const LIEN_WAIVER_ENFORCEMENT = [
  { value: 'none', labelKey: 'options.lienWaiverEnforcement.none' },
  { value: 'warn', labelKey: 'options.lienWaiverEnforcement.warn' },
  { value: 'block', labelKey: 'options.lienWaiverEnforcement.block' },
]

export const LIEN_WAIVER_TYPES = [
  { value: 'conditional_progress', labelKey: 'options.lienWaiverType.conditionalProgress' },
  { value: 'unconditional_progress', labelKey: 'options.lienWaiverType.unconditionalProgress' },
  { value: 'conditional_final', labelKey: 'options.lienWaiverType.conditionalFinal' },
  { value: 'unconditional_final', labelKey: 'options.lienWaiverType.unconditionalFinal' },
]

const INFORMATION_RETURN_FORM_TYPES = [
  { value: '1099-NEC', labelKey: 'options.informationReturnForm.nec' },
  { value: '1099-MISC', labelKey: 'options.informationReturnForm.misc' },
  { value: 'T4A', labelKey: 'options.informationReturnForm.t4a' },
]

/** The class-level default adds "not reportable" to the real form types. */
const INFORMATION_RETURN_FORMS_OPTIONS = [
  { value: 'none', labelKey: 'options.informationReturnForm.none' },
  ...INFORMATION_RETURN_FORM_TYPES,
]

/**
 * Statutory boxes across all three forms, flattened for the box-rule picker.
 * Kept in sync with INFORMATION_RETURN_FORMS in
 * engine/src/information-returns.ts (asserted by registry.test.ts) — the boxes
 * are law, so they live in code; which ACCOUNT feeds which box is the org's
 * configuration and lives in the table.
 */
const INFORMATION_RETURN_BOXES = [
  { value: 'nec1', labelKey: 'options.informationReturnBox.nec1' },
  { value: 'nec2', labelKey: 'options.informationReturnBox.nec2' },
  { value: 'nec4', labelKey: 'options.informationReturnBox.nec4' },
  { value: 'misc1', labelKey: 'options.informationReturnBox.misc1' },
  { value: 'misc2', labelKey: 'options.informationReturnBox.misc2' },
  { value: 'misc3', labelKey: 'options.informationReturnBox.misc3' },
  { value: 'misc4', labelKey: 'options.informationReturnBox.misc4' },
  { value: 'misc5', labelKey: 'options.informationReturnBox.misc5' },
  { value: 'misc6', labelKey: 'options.informationReturnBox.misc6' },
  { value: 'misc8', labelKey: 'options.informationReturnBox.misc8' },
  { value: 'misc9', labelKey: 'options.informationReturnBox.misc9' },
  { value: 'misc10', labelKey: 'options.informationReturnBox.misc10' },
  { value: 'misc11', labelKey: 'options.informationReturnBox.misc11' },
  { value: 'misc12', labelKey: 'options.informationReturnBox.misc12' },
  { value: 'misc14', labelKey: 'options.informationReturnBox.misc14' },
  { value: 'misc15', labelKey: 'options.informationReturnBox.misc15' },
  { value: 't4a020', labelKey: 'options.informationReturnBox.t4a020' },
  { value: 't4a048', labelKey: 'options.informationReturnBox.t4a048' },
  { value: 't4a022', labelKey: 'options.informationReturnBox.t4a022' },
]

// Revenue recognition (ASC 606 / IFRS 15) — mirrors source platform ARM rule methods.
const RECOGNITION_METHODS = [
  { value: 'point_in_time', labelKey: 'options.recognitionMethod.pointInTime' },
  { value: 'straight_line_even', labelKey: 'options.recognitionMethod.straightLineEven' },
  { value: 'straight_line_prorate_first_last', labelKey: 'options.recognitionMethod.straightLineProrate' },
  { value: 'straight_line_daily', labelKey: 'options.recognitionMethod.straightLineDaily' },
  { value: 'percent_complete', labelKey: 'options.recognitionMethod.percentComplete' },
  { value: 'milestone', labelKey: 'options.recognitionMethod.milestone' },
  { value: 'usage', labelKey: 'options.recognitionMethod.usage' },
]

const START_DATE_SOURCES = [
  { value: 'obligation', labelKey: 'options.startDateSource.obligation' },
  { value: 'document', labelKey: 'options.startDateSource.document' },
  { value: 'fulfillment', labelKey: 'options.startDateSource.fulfillment' },
  { value: 'event', labelKey: 'options.startDateSource.event' },
  { value: 'contract', labelKey: 'options.startDateSource.contract' },
]

const END_DATE_SOURCES = [
  { value: 'term', labelKey: 'options.endDateSource.term' },
  { value: 'obligation', labelKey: 'options.endDateSource.obligation' },
  { value: 'contract', labelKey: 'options.endDateSource.contract' },
]

// Inventory costing — matches item_inventory_profiles + stock_locations enums.
const COSTING_METHODS = [
  { value: 'fifo', labelKey: 'options.costingMethod.fifo' },
  { value: 'moving_average', labelKey: 'options.costingMethod.movingAverage' },
  { value: 'standard', labelKey: 'options.costingMethod.standard' },
]

const INVENTORY_TRACKING = [
  { value: 'none', labelKey: 'options.tracking.none' },
  { value: 'lot', labelKey: 'options.tracking.lot' },
  { value: 'serial', labelKey: 'options.tracking.serial' },
]

const STOCK_LOCATION_KINDS = [
  { value: 'warehouse', labelKey: 'options.stockLocationKind.warehouse' },
  { value: 'zone', labelKey: 'options.stockLocationKind.zone' },
  { value: 'bin', labelKey: 'options.stockLocationKind.bin' },
  { value: 'staging', labelKey: 'options.stockLocationKind.staging' },
  { value: 'transit', labelKey: 'options.stockLocationKind.transit' },
  { value: 'quarantine', labelKey: 'options.stockLocationKind.quarantine' },
]

const CONSOLIDATION_METHODS = [
  { value: 'full', labelKey: 'options.consolidationMethod.full' },
  { value: 'proportionate', labelKey: 'options.consolidationMethod.proportionate' },
  { value: 'equity', labelKey: 'options.consolidationMethod.equity' },
]

const NCI_MEASUREMENTS = [
  { value: 'proportionate', labelKey: 'options.nciMeasurement.proportionate' },
  { value: 'fair_value', labelKey: 'options.nciMeasurement.fairValue' },
]

export const SETUP_ENTITIES: SetupEntity[] = [
  // --- Company -------------------------------------------------------------
  {
    // Subsidiaries form the organization's legal-entity tree.
    // baseCurrency is the entity's functional currency: locked after create so
    // it cannot drift once books exist.
    key: 'subsidiaries',
    table: 'subsidiaries',
    actorCols: true,
    groupKey: 'company',
    iconKey: 'building',
    featureKey: 'multiSubsidiary',
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
      { key: 'country', kind: 'country', required: true },
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
    featureKey: 'multiSubsidiary',
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
  {
    key: 'subsidiary-ownership-interests',
    table: 'subsidiary_ownership_interests',
    actorCols: true,
    groupKey: 'company',
    iconKey: 'percent',
    featureKey: 'multiSubsidiary',
    orgScoped: true,
    orderBy: 'subsidiary_id, effective_from desc',
    hasActive: true,
    docSlug: 'company-setup',
    columns: [
      { key: 'parentSubsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'method', kind: 'badge', options: CONSOLIDATION_METHODS },
      { key: 'ownershipPercent', kind: 'percent' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'parentSubsidiaryId', kind: 'ref', ref: 'subsidiaries', required: true, lockedOnEdit: true },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', required: true, lockedOnEdit: true },
      { key: 'effectiveFrom', kind: 'date', required: true, lockedOnEdit: true },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'ownershipPercent', kind: 'percent', required: true },
      { key: 'method', kind: 'select', options: CONSOLIDATION_METHODS, required: true, keepDefault: true },
      { key: 'acquisitionDate', kind: 'date', required: true },
      { key: 'acquisitionCost', kind: 'decimal', required: true, keepDefault: true },
      { key: 'fairValueNetAssets', kind: 'decimal', required: true, keepDefault: true },
      { key: 'acquisitionRate', kind: 'decimal', required: true, keepDefault: true },
      { key: 'nciMeasurement', kind: 'select', options: NCI_MEASUREMENTS, required: true, keepDefault: true },
      { key: 'nciFairValue', kind: 'decimal' },
      { key: 'investmentAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'equityIncomeAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'distributionAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'distributionIncomeAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'nciEquityAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'nciIncomeAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'goodwillAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'fairValueAdjustmentAccountId', kind: 'ref', ref: 'accounts' },
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
      { key: 'postsGl', kind: 'boolean', keepDefault: true },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },

  // --- Taxes ---------------------------------------------------------------
  {
    key: 'tax-jurisdictions',
    table: 'tax_jurisdictions',
    singularTitleKey: 'entities.tax-jurisdictions.singularTitle',
    actorCols: true,
    groupKey: 'taxes',
    iconKey: 'map-pin',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    docSlug: 'tax-jurisdictions-and-nexus',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'country', kind: 'text' },
      { key: 'level', kind: 'text' },
      { key: 'taxType', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'country', kind: 'country', required: true },
      { key: 'region', kind: 'text' },
      { key: 'level', kind: 'select', options: JURISDICTION_LEVELS, keepDefault: true },
      { key: 'taxType', kind: 'select', options: TAX_TYPES, keepDefault: true },
      { key: 'parentId', kind: 'ref', ref: 'tax-jurisdictions' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'tax-registrations',
    table: 'tax_registrations',
    singularTitleKey: 'entities.tax-registrations.singularTitle',
    actorCols: true,
    groupKey: 'taxes',
    iconKey: 'badge-check',
    orgScoped: true,
    hasActive: true,
    docSlug: 'tax-jurisdictions-and-nexus',
    columns: [
      { key: 'jurisdictionId', kind: 'ref', ref: 'tax-jurisdictions' },
      { key: 'registrationNumber', kind: 'text' },
      { key: 'filingFrequency', kind: 'text' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'jurisdictionId', kind: 'ref', ref: 'tax-jurisdictions', required: true },
      { key: 'registrationNumber', kind: 'text' },
      { key: 'filingFrequency', kind: 'select', options: FILING_FREQUENCIES, keepDefault: true },
      { key: 'returnFormCode', kind: 'text' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'tax-codes',
    table: 'tax_codes',
    singularTitleKey: 'entities.tax-codes.singularTitle',
    actorCols: true,
    groupKey: 'taxes',
    iconKey: 'receipt',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    docSlug: 'tax-configuration',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'appliesTo', kind: 'text' },
      { key: 'calculationType', kind: 'text' },
      { key: 'recoverablePercent', kind: 'percent' },
      { key: 'priceIncludesTax', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'jurisdictionId', kind: 'ref', ref: 'tax-jurisdictions' },
      { key: 'country', kind: 'country' },
      { key: 'region', kind: 'text' },
      { key: 'appliesTo', kind: 'select', options: APPLIES_TO, keepDefault: true },
      { key: 'calculationType', kind: 'select', options: TAX_CALCULATION_TYPES, keepDefault: true },
      { key: 'collectedAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'paidAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'withholdingAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'recoverablePercent', kind: 'percent', keepDefault: true },
      { key: 'priceIncludesTax', kind: 'boolean' },
      { key: 'compoundOnPrevious', kind: 'boolean' },
      { key: 'roundingScale', kind: 'integer', keepDefault: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'income-tax-rates',
    table: 'income_tax_rates',
    singularTitleKey: 'entities.income-tax-rates.singularTitle',
    actorCols: true,
    groupKey: 'taxes',
    iconKey: 'percent',
    orgScoped: true,
    hasActive: true,
    docSlug: 'tax-configuration',
    columns: [
      { key: 'jurisdiction', kind: 'text' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'ratePercent', kind: 'percent' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'jurisdiction', kind: 'text', required: true },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'ratePercent', kind: 'percent', required: true },
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'tax-rates',
    table: 'tax_rates',
    singularTitleKey: 'entities.tax-rates.singularTitle',
    actorCols: true,
    groupKey: 'taxes',
    iconKey: 'percent',
    orgScoped: true,
    orderBy: 'effective_from desc',
    hasActive: false,
    docSlug: 'tax-configuration',
    nestedUnder: 'tax-codes',
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
    docSlug: 'tax-configuration',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'priceIncludesTax', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'priceIncludesTax', kind: 'boolean' },
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
    docSlug: 'tax-returns-and-boxes',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'country', kind: 'text' },
      { key: 'submissionChannel', kind: 'text', options: SUBMISSION_CHANNELS },
      { key: 'officialPdfFileId', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'country', kind: 'country' },
      { key: 'region', kind: 'text' },
      { key: 'submissionChannel', kind: 'select', options: SUBMISSION_CHANNELS, keepDefault: true },
      { key: 'governmentFormat', kind: 'select', options: GOVERNMENT_FORMATS, keepDefault: true, hidden: true },
      { key: 'submissionUrl', kind: 'text' },
      { key: 'watermark', kind: 'text' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'tax-report-lines',
    table: 'tax_report_lines',
    singularTitleKey: 'entities.tax-report-lines.singularTitle',
    actorCols: true,
    groupKey: 'taxes',
    iconKey: 'file',
    orgScoped: true,
    orderBy: 'report_code, sequence, line_code',
    hasActive: false,
    docSlug: 'tax-returns-and-boxes',
    nestedUnder: 'tax-return-forms',
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
      {
        key: 'sourceKind',
        kind: 'badge',
        options: [
          { value: 'builtin', labelKey: 'options.sourceKind.builtin' },
          { value: 'custom', labelKey: 'options.sourceKind.custom' },
        ],
      },
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
    // Values live inside their owning segment's drawer (custom segments only);
    // built-in dimension values stay on the Classes/Departments/Locations tabs.
    nestedUnder: 'segment-definitions',
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
      { key: 'documentKind', kind: 'ref', ref: 'number-sequence-kinds' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'prefix', kind: 'code' },
      { key: 'nextNumber', kind: 'number' },
      { key: 'padding', kind: 'number' },
      { key: 'gapless', kind: 'boolean' },
    ],
    fields: [
      { key: 'documentKind', kind: 'ref', ref: 'number-sequence-kinds', required: true, lockedOnEdit: true },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', lockedOnEdit: true },
      { key: 'prefix', kind: 'text', keepDefault: true },
      { key: 'nextNumber', kind: 'integer', required: true, defaultValue: 1 },
      { key: 'padding', kind: 'integer', required: true, defaultValue: 5 },
      { key: 'gapless', kind: 'boolean', helpTextKey: 'fieldHelp.gapless' },
    ],
  },
  {
    key: 'item-rate-books',
    table: 'item_rate_books',
    rehomed: true, // lives as a tab on the Items catalog module
    actorCols: true,
    groupKey: 'billing',
    featureKey: 'projects',
    iconKey: 'tag',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    docSlug: 'item-rates',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'currency', kind: 'code' },
      { key: 'isDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'currency', kind: 'ref', ref: 'currencies', required: true },
      { key: 'isDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },
  {
    key: 'item-rate-book-assignments',
    table: 'item_rate_book_assignments',
    rehomed: true, // lives on the customer & project records as an override section
    actorCols: true,
    groupKey: 'billing',
    featureKey: 'projects',
    iconKey: 'tag',
    orgScoped: true,
    orderBy: 'project_id nulls last, customer_id nulls last, effective_from desc nulls last',
    hasActive: true,
    docSlug: 'item-rates',
    columns: [
      { key: 'rateBookId', kind: 'ref', ref: 'item-rate-books' },
      { key: 'customerId', kind: 'ref', ref: 'customers' },
      { key: 'projectId', kind: 'ref', ref: 'projects' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'dateBasis', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'rateBookId', kind: 'ref', ref: 'item-rate-books', required: true },
      { key: 'customerId', kind: 'ref', ref: 'customers' },
      { key: 'projectId', kind: 'ref', ref: 'projects' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'dateBasis', kind: 'select', required: true, defaultValue: 'usage_date', options: [
        { value: 'usage_date', labelKey: 'options.rateDateBasis.usageDate' },
        { value: 'project_start', labelKey: 'options.rateDateBasis.projectStart' },
      ] },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },

  // --- Revenue recognition -------------------------------------------------
  {
    // Recognition rules — the reusable ASC 606 / ARM recipe (method + date
    // sources + offsets + accounts) applied to a performance obligation.
    key: 'recognition-rules',
    table: 'recognition_rules',
    actorCols: true,
    groupKey: 'revenue',
    featureKey: 'revenueRecognition',
    iconKey: 'trending-up',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    docSlug: 'revenue-recognition',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'method', kind: 'text' },
      { key: 'isForecast', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'method', kind: 'select', options: RECOGNITION_METHODS, required: true },
      { key: 'isForecast', kind: 'boolean' },
      { key: 'recognitionPeriods', kind: 'integer' },
      { key: 'startDateSource', kind: 'select', options: START_DATE_SOURCES, keepDefault: true },
      { key: 'endDateSource', kind: 'select', options: END_DATE_SOURCES, keepDefault: true },
      { key: 'periodOffset', kind: 'integer', keepDefault: true },
      { key: 'startOffsetDays', kind: 'integer', keepDefault: true },
      { key: 'initialAmountPercent', kind: 'percent', keepDefault: true },
      { key: 'deferredAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'recognizedAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Fair-value / standalone selling prices — dated per item & currency, used
    // to allocate a bundle's transaction price across obligations (relative SSP).
    key: 'fair-value-prices',
    table: 'fair_value_prices',
    rehomed: true, // lives as a section on the item record (dated SSPs)
    actorCols: true,
    groupKey: 'revenue',
    featureKey: 'revenueRecognition',
    iconKey: 'coins',
    orgScoped: true,
    orderBy: 'item_id, effective_from desc',
    hasActive: true,
    docSlug: 'revenue-recognition',
    columns: [
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'currency', kind: 'code' },
      { key: 'unitPrice', kind: 'number' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'itemId', kind: 'ref', ref: 'items', required: true },
      { key: 'currency', kind: 'ref', ref: 'currencies', required: true },
      { key: 'unitPrice', kind: 'decimal', required: true },
      { key: 'lowValue', kind: 'decimal' },
      { key: 'highValue', kind: 'decimal' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },

  // --- Inventory -----------------------------------------------------------
  {
    // Stock locations — physical bins/zones under the `locations` dimension.
    key: 'stock-locations',
    table: 'stock_locations',
    rehomed: true, // lives as a tab on the Inventory module
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'inventory',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'location_id, code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'locationId', kind: 'ref', ref: 'locations' },
      { key: 'kind', kind: 'text' },
      { key: 'parentId', kind: 'ref', ref: 'stock-locations' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'locationId', kind: 'ref', ref: 'locations', required: true },
      { key: 'code', kind: 'text', required: true },
      { key: 'kind', kind: 'select', options: STOCK_LOCATION_KINDS, keepDefault: true },
      { key: 'parentId', kind: 'ref', ref: 'stock-locations' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Per-item costing profile — method, accounts, tracking, standard cost, and
    // reorder points. One per inventory item.
    key: 'item-inventory-profiles',
    table: 'item_inventory_profiles',
    rehomed: true, // lives as a Costing section on the item record
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'inventory',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'item_id',
    hasActive: false,
    columns: [
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'costingMethod', kind: 'text' },
      { key: 'tracking', kind: 'text' },
      { key: 'standardCost', kind: 'number' },
      { key: 'baseUnit', kind: 'text' },
    ],
    fields: [
      { key: 'itemId', kind: 'ref', ref: 'items', required: true, lockedOnEdit: true },
      { key: 'costingMethod', kind: 'select', options: COSTING_METHODS, keepDefault: true },
      { key: 'tracking', kind: 'select', options: INVENTORY_TRACKING, keepDefault: true },
      { key: 'assetAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'cogsAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'adjustmentAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'varianceAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'receivedNotBilledAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'standardCost', kind: 'decimal' },
      { key: 'baseUnit', kind: 'text', keepDefault: true },
      { key: 'reorderPoint', kind: 'decimal' },
      { key: 'preferredStockLevel', kind: 'decimal' },
    ],
  },
  {
    // Bill of materials — components consumed to build an assembly item.
    key: 'bom-components',
    table: 'bom_components',
    rehomed: true, // lives as a tab on the Inventory module
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'inventory',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'assembly_item_id, sort_order',
    hasActive: false,
    columns: [
      { key: 'assemblyItemId', kind: 'ref', ref: 'items' },
      { key: 'componentItemId', kind: 'ref', ref: 'items' },
      { key: 'quantityPer', kind: 'number' },
      { key: 'sortOrder', kind: 'number' },
    ],
    fields: [
      { key: 'assemblyItemId', kind: 'ref', ref: 'items', required: true },
      { key: 'componentItemId', kind: 'ref', ref: 'items', required: true },
      { key: 'quantityPer', kind: 'decimal', required: true },
      { key: 'sortOrder', kind: 'integer', keepDefault: true },
    ],
  },

  // --- Workforce -----------------------------------------------------------
  {
    key: 'time-types',
    table: 'time_types',
    groupKey: 'workforce',
    featureKey: 'timeTracking',
    iconKey: 'timer',
    orgScoped: true,
    // cost_multiplier / exclude_from_wages are direct inputs to gross earnings,
    // so the table carries the audit quartet and the generic route must stamp it.
    actorCols: true,
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      {
        key: 'classification',
        kind: 'badge',
        options: [
          { value: 'regular', labelKey: 'timeClassification.regular' },
          { value: 'overtime', labelKey: 'timeClassification.overtime' },
          { value: 'double_time', labelKey: 'timeClassification.doubleTime' },
          { value: 'other', labelKey: 'timeClassification.other' },
        ],
      },
      { key: 'costMultiplier', kind: 'number' },
      { key: 'billMultiplier', kind: 'number' },
      { key: 'isBillableDefault', kind: 'boolean' },
      { key: 'showOnFieldTicket', kind: 'boolean' },
      { key: 'excludeFromWages', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      {
        key: 'classification',
        kind: 'select',
        required: true,
        keepDefault: true,
        defaultValue: 'regular',
        options: [
          { value: 'regular', labelKey: 'timeClassification.regular' },
          { value: 'overtime', labelKey: 'timeClassification.overtime' },
          { value: 'double_time', labelKey: 'timeClassification.doubleTime' },
          { value: 'other', labelKey: 'timeClassification.other' },
        ],
      },
      { key: 'costMultiplier', kind: 'decimal', keepDefault: true },
      { key: 'billMultiplier', kind: 'decimal', keepDefault: true },
      { key: 'isBillableDefault', kind: 'boolean' },
      { key: 'showOnFieldTicket', kind: 'boolean' },
      { key: 'excludeFromWages', kind: 'boolean', helpTextKey: 'fieldHelp.excludeFromWages' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Payroll program / EIN / state-SUI accounts the employer files and remits
    // under. Employees are assigned one on their payroll profile; remittance
    // runs, PD7A worksheets, and the T4/W-2 returns all group by it.
    key: 'payroll-filing-accounts',
    table: 'payroll_filing_accounts',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'landmark',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'account_number',
    hasActive: true,
    columns: [
      { key: 'accountNumber', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'country', kind: 'badge', options: PAY_COMPONENT_COUNTRIES, optionsSource: 'payroll-filing-countries' },
      { key: 'programType', kind: 'badge', options: PAYROLL_PROGRAM_TYPES, optionsSource: 'payroll-filing-program-types' },
      { key: 'remitterType', kind: 'badge', options: PAYROLL_REMITTER_TYPES },
      { key: 'stateCode', kind: 'text' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'isDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    filters: [{ key: 'country', options: PAY_COMPONENT_COUNTRIES, optionsSource: 'payroll-filing-countries' }],
    fields: [
      { key: 'accountNumber', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      // Country and program type come from the DECLARED payroll packs at
      // render time (optionsSource) — the API validates against the same
      // declarations (filingAccountProblem), so a registered pack's program
      // types are offered and accepted with no edit to this file.
      { key: 'country', kind: 'select', required: true, options: PAY_COMPONENT_COUNTRIES, optionsSource: 'payroll-filing-countries' },
      { key: 'programType', kind: 'select', required: true, options: PAYROLL_PROGRAM_TYPES, optionsSource: 'payroll-filing-program-types' },
      { key: 'remitterType', kind: 'select', keepDefault: true, defaultValue: 'regular', options: PAYROLL_REMITTER_TYPES },
      // Required for, and only for, program types declared `requiresRegion`
      // (us_state_sui) — enforced by `filingAccountProblem` at the API
      // boundary, not by a DB check any more.
      { key: 'stateCode', kind: 'text', helpTextKey: 'fieldHelp.stateCode' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'isDefault', kind: 'boolean', helpTextKey: 'fieldHelp.filingAccountDefault' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  // Elections on the country pack's OPTIONAL statutory holidays, plus company
  // closures. Declared in ./payroll-holidays.ts; an ordinary registry entity.
  PAYROLL_HOLIDAYS_ENTITY,
  {
    key: 'pay-schedules',
    table: 'pay_schedules',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'calendar',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'frequency', kind: 'badge', options: PAY_FREQUENCIES },
      { key: 'periodsPerYear', kind: 'number' },
      { key: 'anchorPeriodEnd', kind: 'date' },
      { key: 'payDateOffsetDays', kind: 'number' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'frequency', kind: 'select', required: true, options: PAY_FREQUENCIES },
      { key: 'periodsPerYear', kind: 'integer', required: true },
      { key: 'anchorPeriodEnd', kind: 'date', required: true, helpTextKey: 'fieldHelp.payScheduleAnchor' },
      // Legal entity this calendar pays; empty = org-wide (root subsidiary).
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'payDateOffsetDays', kind: 'integer', keepDefault: true },
      { key: 'isDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'pay-components',
    table: 'pay_components',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'coins',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'code',
    orderBy: 'sequence, code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'kind', kind: 'badge', options: PAY_COMPONENT_KINDS },
      { key: 'country', kind: 'badge', options: PAY_COMPONENT_COUNTRIES },
      { key: 'basis', kind: 'badge', options: PAY_COMPONENT_BASES },
      { key: 'sequence', kind: 'number' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    // Country pack filter: a chosen country also shows shared (country-less)
    // components, since those apply to every pack's employees.
    filters: [
      { key: 'country', options: PAY_COMPONENT_COUNTRIES, nullMatchesAll: true },
      { key: 'kind', options: PAY_COMPONENT_KINDS },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'kind', kind: 'select', required: true, options: PAY_COMPONENT_KINDS },
      { key: 'country', kind: 'select', options: PAY_COMPONENT_COUNTRIES },
      { key: 'basis', kind: 'select', keepDefault: true, defaultValue: 'fixed_amount', options: PAY_COMPONENT_BASES },
      { key: 'value', kind: 'decimal' },
      { key: 'taxable', kind: 'boolean', defaultValue: true },
      { key: 'pensionable', kind: 'boolean', defaultValue: true },
      { key: 'insurable', kind: 'boolean', defaultValue: true },
      { key: 'vacationable', kind: 'boolean', defaultValue: true },
      { key: 'nonPeriodic', kind: 'boolean' },
      { key: 'taxTreatment', kind: 'select', keepDefault: true, defaultValue: 'none', options: PAY_TAX_TREATMENTS },
      // Deduction protection. Only money leaving the employee can be protected,
      // so the group hides on an earning or an employer contribution (the
      // pay_components CHECK constraint enforces the same rule).
      {
        key: 'protectionBase', kind: 'select', keepDefault: true, defaultValue: 'none',
        options: PAY_PROTECTION_BASES, sectionKey: 'sections.deductionProtection',
        showWhen: { field: 'kind', in: ['deduction'] },
        helpTextKey: 'fieldHelp.protectionBase',
      },
      {
        key: 'protectionMaxPercent', kind: 'percent', sectionKey: 'sections.deductionProtection',
        showWhen: { field: 'protectionBase', in: PAY_PROTECTED_BASES },
        helpTextKey: 'fieldHelp.protectionMaxPercent',
      },
      {
        key: 'protectionPriority', kind: 'integer', keepDefault: true, defaultValue: 100,
        sectionKey: 'sections.deductionProtection',
        showWhen: { field: 'protectionBase', in: PAY_PROTECTED_BASES },
        helpTextKey: 'fieldHelp.protectionPriority',
      },
      // Pool membership is a property of earnings AND deductions: it is what
      // keeps an allowance or a benefit outside the base an order is measured
      // against, without a line of code knowing what a coverall is.
      {
        key: 'includeInDisposableEarnings', kind: 'boolean', defaultValue: true,
        sectionKey: 'sections.deductionProtection',
        showWhen: { field: 'kind', in: ['earning', 'deduction'] },
        helpTextKey: 'fieldHelp.includeInDisposableEarnings',
      },
      // Basis caps: the hours cap only means something once the amount is
      // driven by hours; the money caps apply to every basis.
      {
        key: 'basisCapHoursPerPeriod', kind: 'decimal', sectionKey: 'sections.basisCaps',
        showWhen: { field: 'basis', in: ['per_hour', 'percent_of_gross'] },
        helpTextKey: 'fieldHelp.basisCapHoursPerPeriod',
      },
      {
        key: 'basisCapAmountPerPeriod', kind: 'decimal', sectionKey: 'sections.basisCaps',
        helpTextKey: 'fieldHelp.basisCapAmountPerPeriod',
      },
      {
        key: 'basisCapAmountPerYear', kind: 'decimal', sectionKey: 'sections.basisCaps',
        helpTextKey: 'fieldHelp.basisCapAmountPerYear',
      },
      { key: 'expenseAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'liabilityAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'remittancePartyId', kind: 'ref', ref: 'vendors' },
      { key: 'sequence', kind: 'integer', keepDefault: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Collective agreements (union/local + remittance vendor). Classifications
    // and fringes are agreement-scoped children that need a parent detail
    // surface to edit — they stay off the registry until that surface exists.
    key: 'union-agreements',
    table: 'union_agreements',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'users',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'unionName', kind: 'text' },
      { key: 'localNumber', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'unionName', kind: 'text' },
      { key: 'localNumber', kind: 'text' },
      { key: 'remittancePartyId', kind: 'ref', ref: 'vendors' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Pay banks: banked overtime, vacation, sick banks, and benefit recoup
    // while an employee is on leave (direction 'owe' — a NEGATIVE balance
    // repaid over time). The balance is SUM(entitlement_ledger); there is no
    // balance column anywhere and this surface never writes one.
    key: 'entitlement-plans',
    table: 'entitlement_plans',
    singularTitleKey: 'entities.entitlement-plans.singular',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'coins',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'direction', kind: 'badge', options: ENTITLEMENT_DIRECTIONS },
      { key: 'unit', kind: 'badge', options: ENTITLEMENT_UNITS },
      { key: 'accrualMethod', kind: 'badge', options: ENTITLEMENT_ACCRUAL_METHODS },
      { key: 'accrualValue', kind: 'number' },
      { key: 'capBehavior', kind: 'badge', options: ENTITLEMENT_CAP_BEHAVIORS },
      { key: 'liabilityAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    filters: [
      { key: 'direction', options: ENTITLEMENT_DIRECTIONS },
      { key: 'unit', options: ENTITLEMENT_UNITS },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      {
        key: 'unit', kind: 'select', required: true, keepDefault: true,
        defaultValue: 'money', options: ENTITLEMENT_UNITS,
        helpTextKey: 'fieldHelp.entitlementUnit',
      },
      {
        key: 'direction', kind: 'select', required: true, keepDefault: true,
        defaultValue: 'accrue', options: ENTITLEMENT_DIRECTIONS,
        helpTextKey: 'fieldHelp.entitlementDirection',
      },
      {
        key: 'accrualMethod', kind: 'select', required: true, keepDefault: true,
        defaultValue: 'manual', options: ENTITLEMENT_ACCRUAL_METHODS,
      },
      { key: 'accrualValue', kind: 'decimal', helpTextKey: 'fieldHelp.entitlementAccrualValue' },
      { key: 'accrualComponentId', kind: 'ref', ref: 'pay-components' },
      { key: 'payoutComponentId', kind: 'ref', ref: 'pay-components', helpTextKey: 'fieldHelp.entitlementPayoutComponent' },
      { key: 'liabilityAccountId', kind: 'ref', ref: 'accounts', helpTextKey: 'fieldHelp.entitlementLiabilityAccount' },
      {
        key: 'capBehavior', kind: 'select', keepDefault: true,
        defaultValue: 'warn', options: ENTITLEMENT_CAP_BEHAVIORS,
        helpTextKey: 'fieldHelp.entitlementCapBehavior',
      },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // The scoped ceilings. "Trades $4,000 / Foremen $5,000 / Supers $6,000" is
    // three rows here, resolved most-specific-wins exactly like a wage on
    // labor_cost_rates (employee > job title > trade > department >
    // subsidiary > plan default, latest effective_from within a scope).
    key: 'entitlement-plan-limits',
    table: 'entitlement_plan_limits',
    singularTitleKey: 'entities.entitlement-plan-limits.singular',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'gauge',
    orgScoped: true,
    actorCols: true,
    orderBy: 'effective_from desc',
    hasActive: true,
    columns: [
      { key: 'planId', kind: 'ref', ref: 'entitlement-plans' },
      { key: 'employeePartyId', kind: 'ref', ref: 'employees' },
      { key: 'jobTitle', kind: 'text' },
      { key: 'tradeId', kind: 'ref', ref: 'trades' },
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'maxBalance', kind: 'number' },
      { key: 'notifyBalance', kind: 'number' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'planId', kind: 'ref', ref: 'entitlement-plans', required: true },
      // Exactly one scope key, or none for the plan-wide default (enforced by
      // the entitlement_plan_limits_one_scope check constraint).
      { key: 'employeePartyId', kind: 'ref', ref: 'employees', helpTextKey: 'fieldHelp.entitlementScope' },
      { key: 'jobTitle', kind: 'text' },
      { key: 'tradeId', kind: 'ref', ref: 'trades' },
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'maxBalance', kind: 'decimal', helpTextKey: 'fieldHelp.entitlementMaxBalance' },
      { key: 'notifyBalance', kind: 'decimal', helpTextKey: 'fieldHelp.entitlementNotifyBalance' },
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Service-based schedules: benefits at 3 months, RRSP at a year, the
    // vacation ladder at 5/10/15/20/25/30 years. A tier targets EXACTLY one of
    // a plan (raising its accrual value) or a pay component (eligibility on).
    key: 'entitlement-service-tiers',
    table: 'entitlement_service_tiers',
    singularTitleKey: 'entities.entitlement-service-tiers.singular',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'calendar',
    orgScoped: true,
    actorCols: true,
    orderBy: 'after_months',
    hasActive: true,
    columns: [
      { key: 'afterMonths', kind: 'number' },
      { key: 'planId', kind: 'ref', ref: 'entitlement-plans' },
      { key: 'componentId', kind: 'ref', ref: 'pay-components' },
      { key: 'accrualValue', kind: 'number' },
      { key: 'eligible', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'afterMonths', kind: 'integer', required: true, helpTextKey: 'fieldHelp.entitlementAfterMonths' },
      { key: 'planId', kind: 'ref', ref: 'entitlement-plans', helpTextKey: 'fieldHelp.entitlementTierTarget' },
      { key: 'componentId', kind: 'ref', ref: 'pay-components' },
      { key: 'accrualValue', kind: 'decimal' },
      { key: 'eligible', kind: 'boolean' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  // Derived earnings rules (+ the trades list their employee filter picks
  // from). Declared in ./payroll-derived-rules.ts so the money-rule editor
  // could be reviewed as one change; ordinary registry entities otherwise.
  ...PAY_DERIVED_RULE_ENTITIES,
  {
    key: 'worker-comp-groups',
    table: 'worker_comp_groups',
    groupKey: 'workforce',
    featureKey: 'timeTracking',
    iconKey: 'shield',
    orgScoped: true,
    // rate_percent / max_assessable are payroll MONEY inputs, so the table now
    // carries the audit quartet and the generic route must stamp it — a rate
    // change that leaves no updated_at is invisible to payRunStaleness.
    actorCols: true,
    naturalKey: 'code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'ratePercent', kind: 'percent' },
      { key: 'maxAssessable', kind: 'number' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'ratePercent', kind: 'percent' },
      { key: 'maxAssessable', kind: 'decimal', helpTextKey: 'fieldHelp.maxAssessable' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'overhead-rates',
    table: 'overhead_rates',
    singularTitleKey: 'entities.overhead-rates.singular',
    actorCols: true,
    groupKey: 'projects',
    featureKey: 'projects',
    iconKey: 'percent',
    orgScoped: true,
    orderBy: 'effective_from desc',
    hasActive: false,
    columns: [
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'category', kind: 'text' },
      { key: 'ratePercent', kind: 'number' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
    ],
    fields: [
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'rateKind', kind: 'select', options: OVERHEAD_RATE_KINDS },
      { key: 'ratePercent', kind: 'decimal', required: true },
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
    featureKey: 'fixedAssets',
    iconKey: 'landmark',
    orgScoped: true,
    orderBy: 'name',
    hasActive: true,
    docSlug: 'fixed-assets-depreciation',
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
      { key: 'defaultDepreciationMethodId', kind: 'ref', ref: 'depreciation-methods' },
      { key: 'defaultConvention', kind: 'select', options: DEPRECIATION_CONVENTIONS, keepDefault: true },
      { key: 'defaultLifeMonths', kind: 'integer' },
      { key: 'taxAttributes', kind: 'json', keepDefault: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Configurable tax depreciation regimes (built-ins: ca_cca, uk_wda, au_pool,
    // nz_pool). Add a jurisdiction the engine doesn't ship, or shadow a built-in.
    key: 'tax-regimes',
    rehomed: true, // subtab of Fixed Assets & Depreciation setup
    table: 'tax_regimes',
    singularTitleKey: 'entities.tax-regimes.singularTitle',
    actorCols: true,
    groupKey: 'assets',
    featureKey: 'fixedAssets',
    iconKey: 'landmark',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    docSlug: 'setup-assets-group',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'countryCode', kind: 'text' },
      { key: 'calculationModel', kind: 'text' },
      { key: 'classAttribute', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'countryCode', kind: 'country' },
      { key: 'calculationModel', kind: 'select', options: TAX_DEPRECIATION_MODELS, keepDefault: true },
      { key: 'classAttribute', kind: 'text', keepDefault: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Configurable pool CLASSES per regime (rate, method, first-year fraction,
    // recapture/terminal behavior). Org rows override the built-in class table.
    key: 'tax-pool-classes',
    rehomed: true, // subtab of Fixed Assets & Depreciation setup
    table: 'tax_pool_classes',
    singularTitleKey: 'entities.tax-pool-classes.singularTitle',
    actorCols: true,
    groupKey: 'assets',
    featureKey: 'fixedAssets',
    iconKey: 'landmark',
    orgScoped: true,
    orderBy: 'regime, class_code',
    hasActive: true,
    docSlug: 'setup-assets-group',
    columns: [
      { key: 'regime', kind: 'text' },
      { key: 'classCode', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'rate', kind: 'number' },
      { key: 'method', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'regime', kind: 'text', required: true },
      { key: 'classCode', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'rate', kind: 'decimal', required: true },
      { key: 'method', kind: 'select', options: POOL_METHODS, keepDefault: true },
      { key: 'firstYearFraction', kind: 'decimal', keepDefault: true },
      { key: 'allowRecapture', kind: 'boolean', keepDefault: true },
      { key: 'allowTerminalLoss', kind: 'boolean', keepDefault: true },
      { key: 'costCap', kind: 'decimal' },
      { key: 'depreciationSystem', kind: 'select', options: MACRS_SYSTEMS },
      { key: 'macrsMethod', kind: 'select', options: MACRS_METHODS },
      { key: 'recoveryPeriodYears', kind: 'decimal' },
      { key: 'convention', kind: 'select', options: TAX_DEPRECIATION_CONVENTIONS },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Dated first-year rules per regime/class (half-year rule, AII, immediate
    // expensing) — legislatively volatile, so config not code.
    key: 'tax-first-year-rules',
    rehomed: true, // subtab of Fixed Assets & Depreciation setup
    table: 'tax_first_year_rules',
    singularTitleKey: 'entities.tax-first-year-rules.singularTitle',
    actorCols: true,
    groupKey: 'assets',
    featureKey: 'fixedAssets',
    iconKey: 'landmark',
    orgScoped: true,
    orderBy: 'regime, class_code',
    hasActive: false,
    docSlug: 'setup-assets-group',
    columns: [
      { key: 'regime', kind: 'text' },
      { key: 'classCode', kind: 'code' },
      { key: 'firstYearFraction', kind: 'number' },
      { key: 'acquiredFrom', kind: 'date' },
    ],
    fields: [
      { key: 'regime', kind: 'text', required: true },
      { key: 'classCode', kind: 'text' },
      { key: 'acquiredFrom', kind: 'date' },
      { key: 'acquiredTo', kind: 'date' },
      { key: 'firstYearFraction', kind: 'decimal', keepDefault: true },
      { key: 'enhancedMultiplier', kind: 'decimal' },
    ],
  },
  {
    // The depreciation formula builder — user-authored methods (formula over the
    // depreciation variable set: NB, OC, RV, AL, CP, …). Referenced by code from
    // an asset category's Default method.
    key: 'depreciation-methods',
    rehomed: true, // subtab of Fixed Assets & Depreciation setup
    table: 'depreciation_methods',
    actorCols: true,
    groupKey: 'assets',
    featureKey: 'fixedAssets',
    iconKey: 'landmark',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    docSlug: 'fixed-assets-depreciation',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'formula', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'formula', kind: 'textarea', required: true },
      { key: 'endOfLife', kind: 'select', options: END_OF_LIFE, keepDefault: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Multi-book: per-book, per-category depreciation policy (a tax/alternate book
    // runs a different method than the primary posting book).
    key: 'depreciation-book-policies',
    rehomed: true, // subtab of Fixed Assets & Depreciation setup
    table: 'depreciation_book_policies',
    actorCols: true,
    groupKey: 'assets',
    featureKey: 'fixedAssets',
    iconKey: 'landmark',
    orgScoped: true,
    orderBy: 'book_id, category_id',
    hasActive: false,
    docSlug: 'fixed-assets-depreciation',
    columns: [
      { key: 'bookId', kind: 'ref', ref: 'accounting-books' },
      { key: 'categoryId', kind: 'ref', ref: 'asset-categories' },
      { key: 'method', kind: 'text' },
      { key: 'lifeMonths', kind: 'number' },
    ],
    fields: [
      { key: 'bookId', kind: 'ref', ref: 'accounting-books', required: true },
      { key: 'categoryId', kind: 'ref', ref: 'asset-categories', required: true },
      { key: 'method', kind: 'select', options: DEPRECIATION_METHODS, keepDefault: true },
      { key: 'depreciationMethodId', kind: 'ref', ref: 'depreciation-methods' },
      { key: 'lifeMonths', kind: 'integer' },
      { key: 'ratePercent', kind: 'percent' },
      { key: 'unitsTotal', kind: 'decimal' },
      { key: 'convention', kind: 'select', options: DEPRECIATION_CONVENTIONS, keepDefault: true },
    ],
  },

  // --- Currency ------------------------------------------------------------
  {
    key: 'fx-rates',
    table: 'fx_rates',
    actorCols: true,
    groupKey: 'currency',
    iconKey: 'coins',
    featureKey: 'multiCurrency',
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
    featureKey: 'multiSubsidiary',
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
  // ── Subcontractor compliance ──────────────────────────────────────────
  // The policy layer of the compliance module. Nothing about what a
  // subcontractor must carry is hardcoded: the classes, the certificates, the
  // limits, and what a lapse does are all rows here.
  {
    key: 'compliance-classes',
    table: 'compliance_classes',
    singularTitleKey: 'entities.compliance-classes.singular',
    groupKey: 'compliance',
    iconKey: 'users',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'code',
    hasActive: true,
    featureKey: 'subcontractorCompliance',
    docSlug: 'subcontractor-compliance',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'lienWaiverEnforcement', kind: 'badge', options: LIEN_WAIVER_ENFORCEMENT },
      { key: 'defaultInformationReturn', kind: 'badge', options: INFORMATION_RETURN_FORMS_OPTIONS },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'description', kind: 'textarea' },
      {
        key: 'lienWaiverEnforcement',
        kind: 'select',
        options: LIEN_WAIVER_ENFORCEMENT,
        keepDefault: true,
        helpTextKey: 'fieldHelp.lienWaiverEnforcement',
      },
      {
        key: 'defaultLienWaiverType',
        kind: 'select',
        options: LIEN_WAIVER_TYPES,
        helpTextKey: 'fieldHelp.defaultLienWaiverType',
      },
      {
        key: 'defaultInformationReturn',
        kind: 'select',
        options: INFORMATION_RETURN_FORMS_OPTIONS,
        keepDefault: true,
        helpTextKey: 'fieldHelp.defaultInformationReturn',
      },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'compliance-requirements',
    table: 'compliance_requirements',
    singularTitleKey: 'entities.compliance-requirements.singular',
    groupKey: 'compliance',
    iconKey: 'shield',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'code',
    hasActive: true,
    featureKey: 'subcontractorCompliance',
    docSlug: 'subcontractor-compliance',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'category', kind: 'badge', options: COMPLIANCE_CATEGORIES },
      { key: 'classId', kind: 'ref', ref: 'compliance-classes' },
      { key: 'minCoverageAmount', kind: 'number' },
      { key: 'enforcement', kind: 'badge', options: COMPLIANCE_ENFORCEMENT },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'category', kind: 'select', options: COMPLIANCE_CATEGORIES, keepDefault: true },
      {
        key: 'classId',
        kind: 'ref',
        ref: 'compliance-classes',
        helpTextKey: 'fieldHelp.complianceRequirementClass',
      },
      {
        key: 'enforcement',
        kind: 'select',
        options: COMPLIANCE_ENFORCEMENT,
        keepDefault: true,
        helpTextKey: 'fieldHelp.complianceEnforcement',
      },
      { key: 'requiresExpiry', kind: 'boolean', defaultValue: true, helpTextKey: 'fieldHelp.requiresExpiry' },
      { key: 'graceDays', kind: 'integer', keepDefault: true, defaultHintKey: 'fieldHelp.graceDaysHint' },
      { key: 'expiryWarningDays', kind: 'integer', keepDefault: true, defaultHintKey: 'fieldHelp.expiryWarningDaysHint' },
      {
        key: 'minCoverageAmount',
        kind: 'decimal',
        helpTextKey: 'fieldHelp.minCoverageAmount',
      },
      { key: 'minAggregateAmount', kind: 'decimal' },
      { key: 'coverageCurrency', kind: 'text', helpTextKey: 'fieldHelp.coverageCurrency' },
      { key: 'requiresAdditionalInsured', kind: 'boolean' },
      { key: 'requiresWaiverOfSubrogation', kind: 'boolean' },
      { key: 'requiresPrimaryNoncontributory', kind: 'boolean' },
      {
        key: 'requiresVerification',
        kind: 'boolean',
        defaultValue: true,
        helpTextKey: 'fieldHelp.requiresVerification',
      },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Which 1099/T4A box an account's spend belongs in. Anything unmapped falls
    // to the vendor's default box, so an org that reports everything as
    // nonemployee compensation configures nothing here at all.
    key: 'information-return-box-rules',
    table: 'information_return_box_rules',
    singularTitleKey: 'entities.information-return-box-rules.singular',
    groupKey: 'compliance',
    iconKey: 'receipt',
    orgScoped: true,
    actorCols: true,
    orderBy: 'form_type, box',
    hasActive: true,
    featureKey: 'subcontractorCompliance',
    docSlug: 'subcontractor-compliance',
    columns: [
      { key: 'formType', kind: 'badge', options: INFORMATION_RETURN_FORM_TYPES },
      { key: 'box', kind: 'badge', options: INFORMATION_RETURN_BOXES },
      { key: 'accountId', kind: 'ref', ref: 'accounts' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'formType', kind: 'select', options: INFORMATION_RETURN_FORM_TYPES, required: true },
      {
        key: 'box',
        kind: 'select',
        options: INFORMATION_RETURN_BOXES,
        required: true,
        helpTextKey: 'fieldHelp.informationReturnBox',
      },
      { key: 'accountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'currencies',
    table: 'currencies',
    idColumn: 'code',
    groupKey: 'currency',
    iconKey: 'coins',
    featureKey: 'multiCurrency',
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
    if (e.nestedUnder || e.rehomed) continue
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
