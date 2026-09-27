import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { mergeHref, pickString } from '../../../lib/list-params'
import { requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { loadFulfillmentDrawerData } from '../../../lib/fulfillment-drawer-data'
import { warehouseGroupTabs } from '../../../components/module-home/group-tabs'
import type { DrawerMode } from '../../../lib/drawer-mode'
import type { FulfillmentDrawerData } from '../_fulfillment/types'

/**
 * Shipments, split into a loader and a spec like the sales orders page.
 *
 * The list is the universal RecordListView placed through the
 * `record-list-view` slot; `?shipment=<id>` opens a shipment's drawer
 * (`&mode=edit` opens a draft on its carrier fields). Shipments are always
 * created from a released pick list, so the page has no New button of its
 * own.
 *
 * The loader gates on `orders.fulfill` first and the Fulfillment feature
 * second (a switched-off feature redirects to its Features explanation)
 * before it reads anything.
 */

const BASE = '/shipments'
const PARAM = 'shipment'

type Tabs = Awaited<ReturnType<typeof warehouseGroupTabs>>

export interface ShipmentsData {
  title: string
  description: string
  tabs: Tabs
  currentParams: Record<string, string | string[] | undefined>
  drawer: (FulfillmentDrawerData & { initialMode: DrawerMode }) | null
}

export async function loadShipments(sp: Record<string, string | string[] | undefined>): Promise<ShipmentsData> {
  const authz = await requirePermission('orders.fulfill')
  await requireFeatureEnabled(authz.user.orgId, 'fulfillment')
  const t = await getTranslations('fulfillment')
  const closeHref = mergeHref(BASE, sp, { [PARAM]: undefined, mode: undefined, form: undefined, transactionTab: undefined })
  const openId = pickString(sp[PARAM])
  const [tabs, drawer] = await Promise.all([
    warehouseGroupTabs(authz, BASE),
    openId
      ? loadFulfillmentDrawerData({ authz, kind: 'shipment', id: openId, formLayoutId: pickString(sp.form), closeHref })
      : null,
  ])
  return {
    title: t('shipment.listTitle'),
    description: t('shipment.listDescription'),
    tabs,
    currentParams: sp,
    drawer: drawer ? { ...drawer, initialMode: pickString(sp.mode) === 'edit' ? 'edit' : 'view' } : null,
  }
}

const f = ref<ShipmentsData>()

export function shipmentsSpec(data: ShipmentsData): PageSpec {
  return page({
    route: '/shipments',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      widgetBlock('record-list-view', {
        recordType: 'shipment',
        basePath: BASE,
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'shipment-drawer', props: { drawer: data.drawer } } : null,
        emptyAction: null,
      }),
    ],
  })
}
