/** Setup-registry commerce entities: channel posting maps, channel locations, and the external-identity map. */
import type { SetupEntity } from '../types'
import { CHANNEL_ACCOUNT_ROLES } from '@openbooks/engine/commerce/contracts'

const ACCOUNT_ROLE_OPTIONS = (CHANNEL_ACCOUNT_ROLES as readonly string[]).map((value) => ({
  value,
  labelKey: `options.channelAccountRole.${value}`,
}))

export const COMMERCE_ENTITIES: SetupEntity[] = [
  {
    key: 'channel-account-maps',
    table: 'sales_channel_account_maps',
    singularTitleKey: 'entities.channel-account-maps.singular',
    actorCols: true,
    groupKey: 'billing',
    featureKey: 'salesChannels',
    writePermission: 'channels.manage',
    iconKey: 'layers',
    orgScoped: true,
    orderBy: 'role, key, effective_from desc',
    hasActive: false,
    rehomed: true,
    // Posting maps are effective-dated series, not standalone rows: writes
    // close the prior open row through the commerce engine, never raw CRUD.
    command: { name: 'upsertChannelAccountMap', permission: 'channels.manage', feature: 'salesChannels' },
    columns: [
      { key: 'role', kind: 'text' },
      { key: 'key', kind: 'text' },
      { key: 'accountId', kind: 'ref', ref: 'accounts' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
    ],
    fields: [
      { key: 'channelId', kind: 'ref', ref: 'sales-channels', required: true, lockedOnEdit: true },
      { key: 'role', kind: 'select', options: ACCOUNT_ROLE_OPTIONS, required: true, lockedOnEdit: true },
      { key: 'key', kind: 'text', lockedOnEdit: true },
      { key: 'accountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'effectiveFrom', kind: 'date', required: true },
    ],
  },
  {
    key: 'channel-locations',
    table: 'sales_channel_locations',
    singularTitleKey: 'entities.channel-locations.singular',
    actorCols: true,
    groupKey: 'billing',
    featureKey: 'salesChannels',
    writePermission: 'channels.manage',
    iconKey: 'layers',
    orgScoped: true,
    orderBy: 'external_name',
    hasActive: false,
    rehomed: true,
    // Re-syncing a storefront location refreshes its mapping in place through
    // the commerce engine, never a duplicate raw row.
    command: { name: 'upsertChannelLocation', permission: 'channels.manage', feature: 'salesChannels' },
    columns: [
      { key: 'externalLocationId', kind: 'code' },
      { key: 'externalName', kind: 'text' },
      { key: 'stockLocationId', kind: 'ref', ref: 'stock-locations' },
      { key: 'syncInventory', kind: 'boolean' },
      { key: 'fulfilsOrders', kind: 'boolean' },
    ],
    fields: [
      { key: 'channelId', kind: 'ref', ref: 'sales-channels', required: true, lockedOnEdit: true },
      { key: 'externalLocationId', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'externalName', kind: 'text', required: true },
      { key: 'stockLocationId', kind: 'ref', ref: 'stock-locations' },
      { key: 'syncInventory', kind: 'boolean', defaultValue: true },
      { key: 'fulfilsOrders', kind: 'boolean', defaultValue: true },
    ],
  },
  {
    key: 'external-links',
    table: 'external_links',
    singularTitleKey: 'entities.external-links.singular',
    actorCols: true,
    groupKey: 'billing',
    featureKeysAny: ['salesChannels', 'usageBilling'],
    writePermission: 'channels.manage',
    iconKey: 'layers',
    orgScoped: true,
    orderBy: 'external_id',
    hasActive: false,
    // Identity mappings are written by sync flows and unlinked through the
    // channel workspace (audited, with a reason): the drawer tabs read.
    allowCreate: false,
    allowDelete: false,
    readOnly: true,
    parentRecords: [
      { entityKey: 'items', fieldKey: 'nativeId' },
      { entityKey: 'customers', fieldKey: 'nativeId' },
    ],
    columns: [
      { key: 'provider', kind: 'text' },
      { key: 'objectType', kind: 'text' },
      { key: 'externalId', kind: 'code' },
      { key: 'externalAccount', kind: 'text' },
      { key: 'lastSyncedAt', kind: 'date' },
    ],
    fields: [
      { key: 'nativeId', kind: 'text', required: true },
    ],
  },
]
