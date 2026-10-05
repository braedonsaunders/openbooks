import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { salesOrderScope } from '@openbooks/engine/src/sales/backorders.ts'
import { getFulfillmentDocument, type FulfillmentKind } from '@openbooks/engine/src/sales/fulfillment.ts'
import type {
  FulfillmentDrawerData,
  NewPickListData,
  PackagePresetOption,
  ShippingAccountOption,
} from '../app/(app)/_fulfillment/types'
import type { CustomFieldDefClient } from '../components/custom-field-inputs'
import { can, guardSubsidiaryScope, type Authz } from './authz'
import { loadFieldDefs } from './custom-fields'
import { resolveFormLayout } from './customization/resolve'
import { isFeatureEnabled } from './features'
import { listActiveCarriers } from './fulfillment'
import { isUuid } from './list-params'

/** The list each fulfilment kind lives on, and the URL param its drawer reads. */
export const FULFILLMENT_DRAWER_ROUTE: Record<FulfillmentKind, { base: string; param: string }> = {
  pick_list: { base: '/picks', param: 'pick' },
  shipment: { base: '/shipments', param: 'shipment' },
}

/**
 * Loads a pick-list or shipment drawer for its own list page and for nested
 * record contexts. Null — the record reads as absent — without orders.fulfill,
 * while Fulfillment is off, for a malformed id, another kind, or a document
 * outside the caller's legal entities; the engine read applies the scope.
 */
export async function loadFulfillmentDrawerData({
  authz,
  kind,
  id,
  formLayoutId,
  closeHref,
}: {
  authz: Authz
  kind: FulfillmentKind
  id: string
  formLayoutId?: string
  closeHref?: string
}): Promise<FulfillmentDrawerData | null> {
  if (!can(authz, 'orders.fulfill')) return null
  const orgId = authz.user.orgId
  if (!(await isFeatureEnabled(orgId, 'fulfillment'))) return null
  if (!isUuid(id)) return null
  const document = await getFulfillmentDocument(db, orgId, id, authz.allowedSubsidiaryIds)
  if (!document || document.kind !== kind) return null

  const [headerDefs, customRow, carriers, barcodeScanningEnabled, shipping] = await Promise.all([
    loadFieldDefs('documents', kind),
    db.execute<{ custom: Record<string, unknown> | null }>(sql`
      select custom from documents where org_id = ${orgId} and id = ${document.id}`),
    kind === 'shipment' && document.status === 'draft' ? listActiveCarriers(orgId) : Promise.resolve([]),
    isFeatureEnabled(orgId, 'barcodeScanning'),
    kind === 'shipment' ? loadShipmentShipping(authz, orgId) : Promise.resolve({ enabled: false, canBuy: false, accounts: [], presets: [] }),
  ])
  const resolved = await resolveFormLayout({
    orgId,
    userId: authz.user.id,
    recordType: kind,
    userRoles: authz.user.roles.map(({ key }) => key),
    headerDefs,
    lineDefs: [],
    explicitLayoutId: formLayoutId,
  })
  return {
    document,
    layout: resolved.layout,
    headerDefs: headerDefs as CustomFieldDefClient[],
    custom: customRow.rows[0]?.custom ?? {},
    carriers,
    canManage: can(authz, 'orders.fulfill'),
    canPost: can(authz, 'items.post'),
    barcodeScanningEnabled,
    shippingHubEnabled: shipping.enabled,
    canBuyLabels: shipping.canBuy,
    shippingAccounts: shipping.accounts,
    packagePresets: shipping.presets,
    closeHref: closeHref ?? FULFILLMENT_DRAWER_ROUTE[kind].base,
  }
}

/**
 * Rate-shopping options for a shipment drawer: active carrier accounts and
 * package presets, read without secrets. Nothing loads while the hub is
 * off — the drawer keeps its manual carrier fields and no extra queries
 * run for pick lists either.
 */
async function loadShipmentShipping(
  authz: Authz,
  orgId: string,
): Promise<{ enabled: boolean; canBuy: boolean; accounts: ShippingAccountOption[]; presets: PackagePresetOption[] }> {
  const empty = { enabled: false, canBuy: false, accounts: [], presets: [] as PackagePresetOption[] }
  if (!(await isFeatureEnabled(orgId, 'shippingHub'))) return empty
  const [accounts, presets] = await Promise.all([
    db.execute<{ id: string; name: string; provider: string; mode: string; isDefault: boolean }>(sql`
      select id, name, provider, mode, is_default as "isDefault" from shipping_accounts
       where org_id = ${orgId} and status = 'active' order by is_default desc, name`),
    db.execute<{ id: string; name: string }>(sql`
      select id, name from package_presets where org_id = ${orgId} order by name`),
  ])
  return {
    enabled: true,
    canBuy: can(authz, 'shipping.manage'),
    accounts: accounts.rows,
    presets: presets.rows,
  }
}

/**
 * The create-pick-list drawer for one sales order: the order's number and
 * customer and the pick-list form layout. Null for an absent order, one of
 * another kind, or one outside the caller's legal entities — all read the
 * same. The pickable lines come from GET /api/picks/candidates, which
 * re-checks the same scope.
 */
export async function loadNewPickListData({
  authz,
  salesOrderId,
  formLayoutId,
  closeHref,
}: {
  authz: Authz
  salesOrderId: string
  formLayoutId?: string
  closeHref: string
}): Promise<NewPickListData | null> {
  if (!can(authz, 'orders.fulfill')) return null
  const orgId = authz.user.orgId
  if (!(await isFeatureEnabled(orgId, 'fulfillment'))) return null
  if (!isUuid(salesOrderId)) return null
  const scope = await salesOrderScope(db, orgId, salesOrderId)
  if (!scope || guardSubsidiaryScope(authz, scope.subsidiaryId)) return null
  const order = (await db.execute<{ document_number: string; party_name: string | null }>(sql`
    select d.document_number, p.display_name as party_name
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where d.org_id = ${orgId} and d.id = ${scope.id}`)).rows[0]
  if (!order) return null
  const headerDefs = await loadFieldDefs('documents', 'pick_list')
  const [resolved, today, barcodeScanningEnabled] = await Promise.all([
    resolveFormLayout({
      orgId,
      userId: authz.user.id,
      recordType: 'pick_list',
      userRoles: authz.user.roles.map(({ key }) => key),
      headerDefs,
      lineDefs: [],
      explicitLayoutId: formLayoutId,
    }),
    businessToday(orgId),
    isFeatureEnabled(orgId, 'barcodeScanning'),
  ])
  return {
    salesOrder: { id: scope.id, number: order.document_number, customerName: order.party_name },
    layout: resolved.layout,
    headerDefs: headerDefs as CustomFieldDefClient[],
    today,
    barcodeScanningEnabled,
    closeHref,
  }
}
