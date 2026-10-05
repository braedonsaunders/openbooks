/** Setup-registry revenue entities (split from registry.ts; pure moves only). */
import type { SetupEntity } from '../types'
import { RECOGNITION_METHODS, START_DATE_SOURCES, END_DATE_SOURCES } from '../options'
import { MAX_RECOGNITION_INITIAL_PERCENT, MAX_RECOGNITION_TERM_MONTHS, MIN_RECOGNITION_INITIAL_PERCENT, MIN_RECOGNITION_PERIOD_OFFSET, MIN_RECOGNITION_TERM_MONTHS } from '@openbooks/engine/src/revenue/recognition-limits.ts'

export const REVENUE_ENTITIES: SetupEntity[] = [
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
      { key: 'version', kind: 'number' },
      { key: 'isForecast', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      // Policy edits on a rule referenced by any obligation create a
      // successor version (same code, version + 1) instead of rewriting the
      // row; the version column shows which generation each row is.
      { key: 'method', kind: 'select', options: RECOGNITION_METHODS, required: true, helpTextKey: 'fieldHelp.recognitionRulePolicy' },
      { key: 'isForecast', kind: 'boolean' },
      { key: 'recognitionPeriods', kind: 'integer', min: MIN_RECOGNITION_TERM_MONTHS, max: MAX_RECOGNITION_TERM_MONTHS },
      { key: 'startDateSource', kind: 'select', options: START_DATE_SOURCES, keepDefault: true },
      { key: 'endDateSource', kind: 'select', options: END_DATE_SOURCES, keepDefault: true },
      { key: 'periodOffset', kind: 'integer', keepDefault: true, min: MIN_RECOGNITION_PERIOD_OFFSET, max: MAX_RECOGNITION_TERM_MONTHS },
      { key: 'startOffsetDays', kind: 'integer', keepDefault: true },
      { key: 'initialAmountPercent', kind: 'percent', keepDefault: true, min: Number(MIN_RECOGNITION_INITIAL_PERCENT), max: Number(MAX_RECOGNITION_INITIAL_PERCENT) },
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
  {
    // Contract cost policy — which acquisition costs capitalize, over what
    // benefit period, and into which accounts (ASC 340-40). Effective-dated:
    // a new row supersedes the old one, so a policy change never
    // reinterprets history.
    key: 'contract-cost-policy',
    table: 'contract_cost_policies',
    actorCols: true,
    // Supersession is by effective date (a new row ends the old one's
    // reign), so there is no active flag to toggle.
    hasActive: false,
    groupKey: 'revenue',
    featureKey: 'contractCosts',
    iconKey: 'trending-up',
    orgScoped: true,
    orderBy: 'effective_from desc',
    columns: [
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'basis', kind: 'text', labelKey: 'fields.contractCostBasisLabel' },
      { key: 'practicalExpedient', kind: 'boolean' },
      { key: 'assetAccountId', kind: 'ref', ref: 'accounts', labelKey: 'fields.contractCostAssetAccount' },
      { key: 'amortizationExpenseAccountId', kind: 'ref', ref: 'accounts' },
    ],
    fields: [
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'capitalizeCommissions', kind: 'boolean', defaultValue: true },
      { key: 'capitalizeFulfilment', kind: 'boolean' },
      {
        key: 'practicalExpedient', kind: 'boolean', defaultValue: true,
        helpTextKey: 'fieldHelp.contractCostPracticalExpedient',
      },
      {
        key: 'basis', kind: 'select', required: true, labelKey: 'fields.contractCostBasisLabel',
        options: [
          { value: 'contract_term', labelKey: 'options.contractCostBasis.contractTerm' },
          { value: 'customer_life', labelKey: 'options.contractCostBasis.customerLife' },
        ],
      },
      {
        key: 'customerLifeSource', kind: 'select',
        showWhen: { field: 'basis', in: ['customer_life'] },
        options: [
          { value: 'manual', labelKey: 'options.contractCostLifeSource.manual' },
          { value: 'derived', labelKey: 'options.contractCostLifeSource.derived' },
        ],
      },
      {
        key: 'customerLifeMonths', kind: 'integer', min: 1,
        showWhen: { field: 'customerLifeSource', in: ['manual'] },
      },
      {
        key: 'renewalCommensurateThresholdPercent', kind: 'percent',
        showWhen: { field: 'basis', in: ['customer_life'] },
        helpTextKey: 'fieldHelp.contractCostCommensurate',
      },
      { key: 'assetAccountId', kind: 'ref', ref: 'accounts', required: true, labelKey: 'fields.contractCostAssetAccount' },
      { key: 'amortizationExpenseAccountId', kind: 'ref', ref: 'accounts', required: true },
    ],
  },
]
