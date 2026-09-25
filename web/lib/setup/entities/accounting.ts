/** Setup-registry accounting entities (split from registry.ts; pure moves only). */
import type { SetupEntity } from '../types'

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
    // platform shard registers the key; until then the key string resolves
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
    // only add an unlabelled `fields.mode` key (F-coord-008).
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
]
