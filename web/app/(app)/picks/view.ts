import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { mergeHref, pickString } from '../../../lib/list-params'
import { requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { loadFulfillmentDrawerData, loadNewPickListData } from '../../../lib/fulfillment-drawer-data'
import { warehouseGroupTabs } from '../../../components/module-home/group-tabs'
import type { FulfillmentDrawerData, NewPickListData } from '../_fulfillment/types'

/**
 * Pick lists, split into a loader and a spec like the sales orders page.
 *
 * The list is the universal RecordListView placed through the
 * `record-list-view` slot, which re-derives org, user and permissions from
 * the session. `?pick=<id>` opens a pick list's drawer; `?pickFrom=<order>`
 * opens the create form for an issued sales order (the sales-order drawer's
 * Create pick list action links here). Pick lists are always created from a
 * sales order, so the page has no New button of its own.
 *
 * The loader gates on `orders.fulfill` first and the Fulfillment feature
 * second (a switched-off feature redirects to its Features explanation)
 * before it reads anything.
 */

const BASE = '/picks'
const PARAM = 'pick'
const CREATE_PARAM = 'pickFrom'

type Tabs = Awaited<ReturnType<typeof warehouseGroupTabs>>

export interface PicksData {
  title: string
  description: string
  tabs: Tabs
  currentParams: Record<string, string | string[] | undefined>
  drawer: FulfillmentDrawerData | null
  createDrawer: NewPickListData | null
}

export async function loadPicks(sp: Record<string, string | string[] | undefined>): Promise<PicksData> {
  const authz = await requirePermission('orders.fulfill')
  await requireFeatureEnabled(authz.user.orgId, 'fulfillment')
  const t = await getTranslations('fulfillment')
  const closeHref = mergeHref(BASE, sp, { [PARAM]: undefined, [CREATE_PARAM]: undefined, form: undefined, transactionTab: undefined })
  const openId = pickString(sp[PARAM])
  const fromOrder = pickString(sp[CREATE_PARAM])
  const [tabs, drawer, createDrawer] = await Promise.all([
    warehouseGroupTabs(authz, BASE),
    openId
      ? loadFulfillmentDrawerData({ authz, kind: 'pick_list', id: openId, formLayoutId: pickString(sp.form), closeHref })
      : null,
    !openId && fromOrder
      ? loadNewPickListData({ authz, salesOrderId: fromOrder, formLayoutId: pickString(sp.form), closeHref })
      : null,
  ])
  return {
    title: t('pick.listTitle'),
    description: t('pick.listDescription'),
    tabs,
    currentParams: sp,
    drawer,
    createDrawer,
  }
}

const f = ref<PicksData>()

export function picksSpec(data: PicksData): PageSpec {
  return page({
    route: '/picks',
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
        recordType: 'pick_list',
        basePath: BASE,
        sp: data.currentParams,
        drawer: data.drawer
          ? { widget: 'pick-list-drawer', props: { drawer: data.drawer } }
          : data.createDrawer
            ? { widget: 'new-pick-list-drawer', props: { drawer: data.createDrawer } }
            : null,
        emptyAction: null,
      }),
    ],
  })
}
