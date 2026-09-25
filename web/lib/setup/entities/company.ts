/** Setup-registry company entities (split from registry.ts; pure moves only). */
import type { SetupEntity } from '../types'
import { CONSOLIDATION_METHODS, HOME_ANNOUNCEMENT_AUDIENCES, NCI_MEASUREMENTS } from '../options'

export const COMPANY_ENTITIES: SetupEntity[] = [
  {
    key: 'extension-settings', table: 'orgs', dataSource: 'extension-settings', groupKey: 'company', iconKey: 'box',
    orgScoped: true, hasActive: false, allowCreate: false, allowDelete: false,
    columns: [{ key: 'extensionKey', kind: 'code' }, { key: 'settingKey', kind: 'code' }, { key: 'name', kind: 'text' }, { key: 'value', kind: 'text' }],
    fields: [
      { key: 'extensionKey', kind: 'text', lockedOnEdit: true },
      { key: 'settingKey', kind: 'text', lockedOnEdit: true },
      { key: 'name', kind: 'text', lockedOnEdit: true },
      { key: 'description', kind: 'textarea', lockedOnEdit: true },
      { key: 'value', kind: 'json', required: true },
      { key: 'reason', kind: 'textarea', required: true },
    ],
  },
  // --- Company -------------------------------------------------------------
  // HR-15 begin: admin-authored home announcements (org settings JSON, not a
  // table) with audience scope and dates. Gated on homeAnnouncements.
  {
    key: 'home-announcements', table: 'orgs', dataSource: 'home-announcements', groupKey: 'company', iconKey: 'megaphone',
    orgScoped: true, hasActive: false, featureKey: 'homeAnnouncements',
    columns: [{ key: 'title', kind: 'text' }, { key: 'audience', kind: 'badge' }, { key: 'startsOn', kind: 'date' }],
    fields: [
      { key: 'title', kind: 'text', required: true },
      { key: 'body', kind: 'textarea' },
      { key: 'audience', kind: 'select', options: HOME_ANNOUNCEMENT_AUDIENCES, required: true, keepDefault: true },
      { key: 'startsOn', kind: 'date', required: true },
      { key: 'endsOn', kind: 'date' },
    ],
  },
  // HR-15 end
  {
    // Subsidiaries form the organization's legal-entity tree.
    // baseCurrency is the entity's functional currency: locked after create so
    // it cannot drift once books exist.
    key: 'subsidiaries',
    table: 'subsidiaries',
    // Subsidiary names are unique per org (subsidiaries_org_name), so the
    // name is the import identity: re-imports dedupe with a friendly refusal
    // instead of a raw unique-violation, and upserts cannot silently restate
    // the locked baseCurrency (buildRow skips lockedOnEdit fields on edit).
    naturalKey: 'name',
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
]
