import 'server-only'

import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { getTranslations } from 'next-intl/server'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { loadShipmentShipping } from '../../../../lib/fulfillment-drawer-data'
import type { ShippingAccountOption } from '../../_fulfillment/types'

/**
 * Bulk label buying, split into a loader and a spec like the shipments
 * page. Draft shipments without a label are selected here — the universal
 * record list owns no multi-select — then priced under one buying rule and
 * bought in one step with a merged PDF for the printer.
 *
 * The loader gates on orders.fulfill first and the shipping hub second
 * before it reads anything; buying itself re-checks shipping.manage on its
 * route.
 */

export interface BulkBuyData {
  title: string
  description: string
  accounts: ShippingAccountOption[]
  canBuy: boolean
  currentParams: Record<string, string | string[] | undefined>
}

export async function loadBulkBuy(
  sp: Record<string, string | string[] | undefined> = {},
): Promise<BulkBuyData> {
  const authz = await requirePermission('orders.fulfill')
  await requireFeatureEnabled(authz.user.orgId, 'shippingHub')
  const t = await getTranslations('fulfillment')
  const shipping = await loadShipmentShipping(authz, authz.user.orgId)
  return {
    title: t('shipping.bulk.title'),
    description: t('shipping.bulk.description'),
    accounts: shipping.accounts,
    canBuy: shipping.canBuy,
    currentParams: sp,
  }
}

const f = ref<BulkBuyData>()

export function bulkBuySpec(data: BulkBuyData): PageSpec {
  return page({
    route: '/shipments/labels',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      widgetBlock('shipping-bulk-buy', {
        accounts: data.accounts,
        canBuy: data.canBuy,
      }),
    ],
  })
}
