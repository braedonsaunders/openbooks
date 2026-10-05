/** Setup-registry commerce entities: channel posting maps, channel locations, the external-identity map, and the customer portal. */
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
      { key: 'bufferQuantity', kind: 'number' },
      { key: 'stopSellingAtZero', kind: 'boolean' },
    ],
    fields: [
      { key: 'channelId', kind: 'ref', ref: 'sales-channels', required: true, lockedOnEdit: true },
      { key: 'externalLocationId', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'externalName', kind: 'text', required: true },
      { key: 'stockLocationId', kind: 'ref', ref: 'stock-locations' },
      { key: 'syncInventory', kind: 'boolean', defaultValue: true },
      { key: 'fulfilsOrders', kind: 'boolean', defaultValue: true },
      { key: 'bufferQuantity', kind: 'decimal' },
      { key: 'stopSellingAtZero', kind: 'boolean', defaultValue: true },
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
  {
    key: 'customer-portal',
    table: 'customer_portal_settings',
    actorCols: true,
    groupKey: 'billing',
    featureKey: 'customerPortal',
    iconKey: 'user-round',
    singularTitleKey: 'entities.customer-portal.singular',
    orderBy: 'effective_from',
    orgScoped: true,
    hasActive: false,
    columns: [
      { key: 'portalName', kind: 'text' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'returnWindowDays', kind: 'text' },
    ],
    // Effective-dated portal rules: every save opens a new effective row (or
    // rewrites today's), so past portal requests keep the rules they ran
    // under. Generic CRUD refuses command-owned entities; writes go through
    // the savePortalSettings command with its strict schema.
    command: { name: 'savePortalSettings', permission: 'documents.manage', feature: 'customerPortal' },
    formSections: [
      { titleKey: 'customerPortalSections.branding', fields: ['portalName', 'effectiveFrom'] },
      { titleKey: 'customerPortalSections.sections', fields: ['sectionsInvoices', 'sectionsPaymentMethods', 'sectionsSubscriptions', 'sectionsUsage', 'sectionsOrders', 'sectionsReturns', 'sectionsGiftCards'] },
      { titleKey: 'customerPortalSections.returns', fields: ['returnWindowDays', 'returnReasons', 'resolutionRefund', 'resolutionExchange', 'resolutionStoreCredit', 'storeCreditBonusPercent'] },
      { titleKey: 'customerPortalSections.saveOffers', fields: ['saveOffers'] },
    ],
    fields: [
      { key: 'portalName', labelKey: 'customerPortalFields.portalName', kind: 'text', required: true, fullWidth: true },
      { key: 'effectiveFrom', labelKey: 'customerPortalFields.effectiveFrom', kind: 'date', required: true, helpTextKey: 'customerPortalFields.effectiveFromHelp' },
      { key: 'sectionsInvoices', labelKey: 'customerPortalFields.sectionsInvoices', kind: 'boolean', defaultValue: true, booleanStyle: 'switch' },
      { key: 'sectionsPaymentMethods', labelKey: 'customerPortalFields.sectionsPaymentMethods', kind: 'boolean', defaultValue: true, booleanStyle: 'switch' },
      { key: 'sectionsSubscriptions', labelKey: 'customerPortalFields.sectionsSubscriptions', kind: 'boolean', defaultValue: true, booleanStyle: 'switch' },
      { key: 'sectionsUsage', labelKey: 'customerPortalFields.sectionsUsage', kind: 'boolean', defaultValue: true, booleanStyle: 'switch' },
      { key: 'sectionsOrders', labelKey: 'customerPortalFields.sectionsOrders', kind: 'boolean', defaultValue: true, booleanStyle: 'switch' },
      { key: 'sectionsReturns', labelKey: 'customerPortalFields.sectionsReturns', kind: 'boolean', defaultValue: true, booleanStyle: 'switch' },
      { key: 'sectionsGiftCards', labelKey: 'customerPortalFields.sectionsGiftCards', kind: 'boolean', defaultValue: true, booleanStyle: 'switch' },
      { key: 'returnWindowDays', labelKey: 'customerPortalFields.returnWindowDays', kind: 'integer', required: true, min: 0, max: 365, defaultValue: 30 },
      { key: 'returnReasons', labelKey: 'customerPortalFields.returnReasons', kind: 'stringArray', required: true, helpTextKey: 'customerPortalFields.returnReasonsHelp' },
      { key: 'resolutionRefund', labelKey: 'customerPortalFields.resolutionRefund', kind: 'boolean', defaultValue: true, booleanStyle: 'switch' },
      { key: 'resolutionExchange', labelKey: 'customerPortalFields.resolutionExchange', kind: 'boolean', defaultValue: true, booleanStyle: 'switch' },
      { key: 'resolutionStoreCredit', labelKey: 'customerPortalFields.resolutionStoreCredit', kind: 'boolean', defaultValue: true, booleanStyle: 'switch' },
      { key: 'storeCreditBonusPercent', labelKey: 'customerPortalFields.storeCreditBonusPercent', kind: 'percent', defaultValue: '0', helpTextKey: 'customerPortalFields.storeCreditBonusHelp' },
      { key: 'saveOffers', labelKey: 'customerPortalFields.saveOffers', kind: 'objectArray',
        helpTextKey: 'customerPortalFields.saveOffersHelp',
        itemTitleKey: 'customerPortalFields.saveOffer', itemTitleField: 'label', addLabelKey: 'customerPortalFields.addSaveOffer', fields: [
        { key: 'label', labelKey: 'customerPortalFields.offerLabel', kind: 'text', required: true },
        { key: 'kind', labelKey: 'customerPortalFields.offerKind', kind: 'select', required: true, options: [
          { value: 'pause', labelKey: 'options.portalOfferKind.pause' },
          { value: 'discount', labelKey: 'options.portalOfferKind.discount' },
        ] },
        { key: 'promotionCode', labelKey: 'customerPortalFields.promotionCode', kind: 'text' },
        { key: 'note', labelKey: 'customerPortalFields.note', kind: 'text' },
      ] },
    ],
  },
]
