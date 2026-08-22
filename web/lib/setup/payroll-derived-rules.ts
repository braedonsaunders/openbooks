import type { SetupEntity } from './registry'

/**
 * Setup-registry descriptors for derived earnings rules (and the trades list
 * their employee-scope filter picks from).
 *
 * These live in their own module only so the entries can be reviewed as one
 * change; they are ordinary registry entities and MUST be spread into
 * SETUP_ENTITIES in registry.ts — that is what wires the generic CRUD API
 * (api/admin/setup/[entity]) and the ref-option loader. See
 * .local/handoff-derived-earnings.md.
 */

const DERIVED_TRIGGERS = [
  { value: 'time_entry', labelKey: 'options.derivedTrigger.timeEntry' },
  { value: 'distinct_day', labelKey: 'options.derivedTrigger.distinctDay' },
  { value: 'distinct_project_day', labelKey: 'options.derivedTrigger.distinctProjectDay' },
  { value: 'night_stayed', labelKey: 'options.derivedTrigger.nightStayed' },
  { value: 'month_end', labelKey: 'options.derivedTrigger.monthEnd' },
  { value: 'equipment_charge', labelKey: 'options.derivedTrigger.equipmentCharge' },
]

const DERIVED_QUANTITY_MODES = [
  { value: 'count', labelKey: 'options.derivedQuantity.count' },
  { value: 'sum_hours', labelKey: 'options.derivedQuantity.sumHours' },
  { value: 'count_nights', labelKey: 'options.derivedQuantity.countNights' },
  { value: 'sum_quantity', labelKey: 'options.derivedQuantity.sumQuantity' },
  { value: 'sum_bill_amount', labelKey: 'options.derivedQuantity.sumBillAmount' },
]

const DERIVED_RATE_MODES = [
  { value: 'fixed_per_unit', labelKey: 'options.derivedRate.fixedPerUnit' },
  { value: 'percent_of_gross', labelKey: 'options.derivedRate.percentOfGross' },
  { value: 'percent_of_quantity', labelKey: 'options.derivedRate.percentOfQuantity' },
  { value: 'rate_card', labelKey: 'options.derivedRate.rateCard' },
]

const DERIVED_COSTING_MODES = [
  { value: 'source', labelKey: 'options.derivedCosting.source' },
  { value: 'first_project_of_day', labelKey: 'options.derivedCosting.firstProjectOfDay' },
  { value: 'none', labelKey: 'options.derivedCosting.none' },
]

export const PAY_DERIVED_RULES_ENTITY: SetupEntity = {
  key: 'pay-derived-rules',
  table: 'pay_derived_rules',
  groupKey: 'workforce',
  featureKey: 'payroll',
  rehomed: true, // subtab of the Payroll setup workspace, beside its preview
  iconKey: 'coins',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'code',
  orderBy: 'sequence, code',
  // Deliberately NOT `hasActive`: a money rule is created disabled and stays
  // visible until someone previews it and turns it on. Hiding inactive rows
  // the way archived setup records are hidden would make a new rule vanish the
  // moment it was saved.
  hasActive: false,
  columns: [
    { key: 'code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'componentId', kind: 'ref', ref: 'pay-components' },
    { key: 'trigger', kind: 'badge', options: DERIVED_TRIGGERS },
    { key: 'rateMode', kind: 'badge', options: DERIVED_RATE_MODES },
    { key: 'rateValue', kind: 'number' },
    { key: 'effectiveFrom', kind: 'date' },
    { key: 'isActive', kind: 'boolean' },
  ],
  filters: [
    { key: 'trigger', options: DERIVED_TRIGGERS },
    { key: 'costingMode', options: DERIVED_COSTING_MODES },
  ],
  fields: [
    { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
    { key: 'name', kind: 'text', required: true },
    { key: 'componentId', kind: 'ref', ref: 'pay-components', required: true },
    { key: 'trigger', kind: 'select', required: true, options: DERIVED_TRIGGERS },
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date' },
    // Filters — every one optional, all ANDed.
    { key: 'timeTypeId', kind: 'ref', ref: 'time-types' },
    { key: 'projectId', kind: 'ref', ref: 'projects' },
    { key: 'departmentId', kind: 'ref', ref: 'departments' },
    // Charge-scope filters (the equipment_charge trigger). itemId is the one
    // that keeps "all excavators" a single reviewable row. equipmentUnitId and
    // the equipment_charge trigger are Features-gated: setupEntityForFeatureState
    // hides them and the CRUD route refuses a new write when Equipment is off.
    // Existing unit links and charge-trigger rules stay.
    { key: 'equipmentUnitId', kind: 'ref', ref: 'equipment-units', helpTextKey: 'fieldHelp.equipmentUnitId' },
    { key: 'itemId', kind: 'ref', ref: 'items', helpTextKey: 'fieldHelp.itemId' },
    { key: 'tradeId', kind: 'ref', ref: 'trades' },
    { key: 'jobTitle', kind: 'text' },
    { key: 'billableOnly', kind: 'boolean' },
    // Employee-scope title lists (jsonb text[]). Chip inputs with type-ahead
    // over the roster's real titles — empty means everyone; exclusions win.
    {
      key: 'includedJobTitles',
      kind: 'stringArray',
      ref: 'job-titles',
      helpTextKey: 'fieldHelp.includedJobTitles',
    },
    {
      key: 'excludedJobTitles',
      kind: 'stringArray',
      ref: 'job-titles',
      helpTextKey: 'fieldHelp.excludedJobTitles',
    },
    // Pricing.
    { key: 'quantityMode', kind: 'select', keepDefault: true, defaultValue: 'count', options: DERIVED_QUANTITY_MODES },
    { key: 'rateMode', kind: 'select', keepDefault: true, defaultValue: 'fixed_per_unit', options: DERIVED_RATE_MODES },
    { key: 'rateValue', kind: 'decimal' },
    { key: 'costingMode', kind: 'select', keepDefault: true, defaultValue: 'source', options: DERIVED_COSTING_MODES },
    { key: 'sequence', kind: 'integer', keepDefault: true },
    { key: 'isActive', kind: 'boolean' },
  ],
}

/**
 * Trades already drive real money (burden rates, worker-comp premiums) and are
 * now a derived-rule filter, but the list had no editable home — the
 * configurable-by-default rule says it needs one.
 */
export const TRADES_ENTITY: SetupEntity = {
  key: 'trades',
  table: 'trades',
  groupKey: 'workforce',
  featureKey: 'timeTracking',
  iconKey: 'users',
  orgScoped: true,
  naturalKey: 'name',
  hasActive: true,
  columns: [
    { key: 'name', kind: 'text' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'name', kind: 'text', required: true },
    { key: 'isActive', kind: 'boolean' },
  ],
}

export const PAY_DERIVED_RULE_ENTITIES: SetupEntity[] = [PAY_DERIVED_RULES_ENTITY, TRADES_ENTITY]
