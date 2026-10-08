/** Setup-registry company entities (split from registry.ts; pure moves only). */
import type { SetupEntity } from '../types'
import { HOME_ANNOUNCEMENT_AUDIENCES } from '../options'

export const COMPANY_ENTITIES: SetupEntity[] = [
  {
    // Settings declared by installed apps. Each app has its own page under
    // /admin/setup/apps/[appKey]; there is no combined standalone page.
    key: 'extension-settings', table: 'orgs', dataSource: 'extension-settings', groupKey: 'apps', iconKey: 'box',
    orgScoped: true, hasActive: false, allowCreate: false, allowDelete: false, rehomed: true,
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
]
