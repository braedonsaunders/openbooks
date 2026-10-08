/** Setup-registry accounting entities (split from registry.ts; pure moves only). */
import type { SetupEntity } from '../types'
import { CONSOLIDATION_METHODS, NCI_MEASUREMENTS } from '../options'

export const ACCOUNTING_ENTITIES: SetupEntity[] = [
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
  {
    // Allocation rules (Rules | Drivers | Runs) live on a custom ModuleView
    // workspace at /admin/setup/allocations, not on the generic CRUD page: a
    // rule version carries nested applicability/basis/target definitions the
    // generic drawer cannot express. This entry only puts the tab on the
    // setup rail under Accounting, gated by the `allocations` feature (the
    // platform registers the key; until then the key string resolves
    // closed). The static custom page takes precedence over the [entity]
    // dynamic route; readOnly with no create/delete refuses every generic
    // CRUD write so versioned rule config only changes through the
    // allocations API.
    key: 'allocations',
    table: 'allocation_rules',
    singularTitleKey: 'entities.allocations.singular',
    actorCols: true,
    groupKey: 'accounting',
    featureKey: 'allocations',
    iconKey: 'percent',
    orgScoped: true,
    naturalKey: 'key',
    hasActive: true,
    readOnly: true,
    allowCreate: false,
    allowDelete: false,
    // No `mode` column: the static custom page at /admin/setup/allocations
    // takes precedence over the generic [entity] route and renders its own
    // `rules.list.columns.mode` header, so a registry `mode` column would
    // only add an unlabelled `fields.mode` key.
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'key', kind: 'code' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'key', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'description', kind: 'textarea' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Intercompany pairs — the due-from/due-to account mapping used when a
    // transaction crosses two subsidiaries.
    key: 'intercompany-pairs',
    table: 'intercompany_pairs',
    actorCols: true,
    groupKey: 'accounting',
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
    groupKey: 'accounting',
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
]
