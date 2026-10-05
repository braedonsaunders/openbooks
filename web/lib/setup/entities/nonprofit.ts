/**
 * Setup-registry nonprofit entities (restriction framework, interfund pairs,
 * functional mappings). Every mutation goes through the named engine command
 * carried on the descriptor itself: SetupEntity.command is the sole
 * discriminant the drawer, the CRUD refusal, and the command route honor.
 */
import type { SetupEntity } from '../types'

export const NONPROFIT_SETUP_ENTITIES: SetupEntity[] = [
  {
    // Restriction framework — one row per org naming the reporting basis.
    // The framework itself changes only through setFramework, which keeps the
    // posted-history guard: reason and actor travel with the command, never
    // as table columns a generic write could forge.
    key: 'nonprofit-frameworks',
    table: 'nonprofit_frameworks',
    actorCols: true,
    groupKey: 'accounting',
    iconKey: 'landmark',
    orgScoped: true,
    naturalKey: 'framework',
    orderBy: 'set_at',
    hasActive: false,
    rehomed: true, // lives as a section on the Nonprofit module
    featureKey: 'fundAccounting',
    command: { name: 'setFramework', permission: 'funds.manage', feature: 'fundAccounting' },
    // One row per org set by a reasoned command: no row stream can express
    // it, so import refuses by name and points at Nonprofit Setup.
    importVia: 'none',
    columns: [
      { key: 'framework', kind: 'badge', options: [
        { value: 'us_asc958', label: 'US ASC 958' },
        { value: 'ew_sorp_frs102', label: 'England and Wales Charities SORP (FRS 102)' },
      ] },
      { key: 'reason', kind: 'text' },
      { key: 'setAt', kind: 'date' },
    ],
    fields: [
      { key: 'framework', kind: 'select', required: true, options: [
        { value: 'us_asc958', label: 'US ASC 958' },
        { value: 'ew_sorp_frs102', label: 'England and Wales Charities SORP (FRS 102)' },
      ] },
    ],
  },
  {
    // Interfund pairs — directed due-to/due-from settlement accounts between
    // two funds. Fund pickers resolve through the org's fund segment values;
    // both funds and both accounts must belong to this organization, enforced
    // again by setFundPair at the service boundary.
    key: 'fund-pairs',
    table: 'fund_pairs',
    actorCols: true,
    groupKey: 'accounting',
    iconKey: 'landmark',
    orgScoped: true,
    orderBy: 'from_fund_id, to_fund_id',
    hasActive: true,
    rehomed: true, // lives as a section on the Nonprofit module
    featureKey: 'fundAccounting',
    command: { name: 'setFundPair', permission: 'funds.manage', feature: 'fundAccounting' },
    // Directed settlement pairs are reasoned commands, not importable rows.
    importVia: 'none',
    columns: [
      { key: 'fromFundId', kind: 'ref', ref: 'funds' },
      { key: 'toFundId', kind: 'ref', ref: 'funds' },
      { key: 'dueFromAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'dueToAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'fromFundId', kind: 'ref', ref: 'funds', required: true, lockedOnEdit: true },
      { key: 'toFundId', kind: 'ref', ref: 'funds', required: true, lockedOnEdit: true },
      { key: 'dueFromAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'dueToAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'isActive', kind: 'boolean' },
      { key: 'reason', kind: 'text', required: true },
    ],
  },
  {
    // Functional mappings — effective-dated department/project expense
    // classification. Exactly one subject per row (department or project);
    // prior windows close automatically and stay readable as history.
    key: 'functional-mappings',
    table: 'functional_mappings',
    actorCols: true,
    groupKey: 'accounting',
    iconKey: 'landmark',
    orgScoped: true,
    orderBy: 'effective_from',
    hasActive: false,
    rehomed: true, // lives as a section on the Nonprofit module
    featureKey: 'functionalExpenses',
    command: { name: 'setFunctionalMapping', permission: 'funds.manage', feature: 'functionalExpenses' },
    // Effective-dated classification windows close through the command, not
    // through row import.
    importVia: 'none',
    columns: [
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'projectId', kind: 'ref', ref: 'projects' },
      { key: 'function', kind: 'badge', options: [
        { value: 'program', label: 'Program' },
        { value: 'management_general', label: 'Management and general' },
        { value: 'fundraising', label: 'Fundraising' },
      ] },
      { key: 'programKey', kind: 'text' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
    ],
    fields: [
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'projectId', kind: 'ref', ref: 'projects' },
      { key: 'function', kind: 'select', required: true, options: [
        { value: 'program', label: 'Program' },
        { value: 'management_general', label: 'Management and general' },
        { value: 'fundraising', label: 'Fundraising' },
      ] },
      { key: 'programKey', kind: 'text' },
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'effectiveTo', kind: 'date' },
    ],
  },
]
