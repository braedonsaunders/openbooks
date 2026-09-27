import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { salesOrderScope } from '@openbooks/engine/src/sales/backorders.ts'
import { getFulfillmentDocument, type FulfillmentKind } from '@openbooks/engine/src/sales/fulfillment.ts'
import type { FulfillmentDrawerData, NewPickListData } from '../app/(app)/_fulfillment/types'
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

  const [headerDefs, customRow, carriers] = await Promise.all([
    loadFieldDefs('documents', kind),
    db.execute<{ custom: Record<string, unknown> | null }>(sql`
      select custom from documents where org_id = ${orgId} and id = ${document.id}`),
    kind === 'shipment' && document.status === 'draft' ? listActiveCarriers(orgId) : Promise.resolve([]),
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
    closeHref: closeHref ?? FULFILLMENT_DRAWER_ROUTE[kind].base,
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
  const [resolved, today] = await Promise.all([
    resolveFormLayout({
      orgId,
      userId: authz.user.id,
      recordType: 'pick_list',
      userRoles: authz.user.roles.map(({ key }) => key),
      headerDefs: [],
      lineDefs: [],
      explicitLayoutId: formLayoutId,
    }),
    businessToday(orgId),
  ])
  return {
    salesOrder: { id: scope.id, number: order.document_number, customerName: order.party_name },
    layout: resolved.layout,
    today,
    closeHref,
  }
}
