import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { page, pageHeader, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { loadChannelOrderDrawer } from '../order-detail'
import type { ChannelTab } from '../ChannelWidgets'

/**
 * Channel Orders: every storefront order with its posting status badge and
 * document link. Everyday depth is the list itself; the drawer shows the
 * normalized lines, tenders and posting outcome; Settings depth lives on the
 * Posting tab.
 */
export interface ChannelOrdersData {
  title: string
  description: string
  tabs: ChannelTab[]
  currentParams: Record<string, string | string[] | undefined>
  emptyTitle: string
  emptyDescription: string
  drawer: { widget: string; props: { drawer: unknown; closeHref: string } } | null
}

function channelTabs(t: (key: string) => string, active: 'orders' | 'exceptions' | 'posting', exceptionCount: number): ChannelTab[] {
  return [
    { href: '/channels/orders', label: t('tabs.orders'), active: active === 'orders' },
    { href: '/channels/exceptions', label: t('tabs.exceptions'), active: active === 'exceptions', count: exceptionCount },
    { href: '/channels/posting', label: t('tabs.posting'), active: active === 'posting' },
  ]
}

export async function loadChannelOrders(
  sp: Record<string, string | string[] | undefined>,
): Promise<ChannelOrdersData> {
  const authz = await requirePermission('channels.read')
  await requireFeatureEnabled(authz.user.orgId, 'salesChannels')
  const t = await getTranslations('channels')
  const orgId = authz.user.orgId
  const canManage = can(authz, 'channels.manage')

  const [exceptionCount] = await Promise.all([
    db.execute<{ count: string }>(
      sql`select count(*)::text as count from channel_orders where org_id = ${orgId} and posting_status = 'exception'`,
    ),
  ])

  const orderId = typeof sp.order === 'string' && isUuid(sp.order) ? sp.order : null
  const drawer = orderId ? await loadChannelOrderDrawer(orgId, orderId, canManage) : null

  return {
    title: t('title'),
    description: t('description'),
    tabs: channelTabs(t, 'orders', Number(exceptionCount.rows[0]?.count ?? '0')),
    currentParams: sp,
    emptyTitle: t('empty.ordersTitle'),
    emptyDescription: t('empty.ordersDescription'),
    drawer: drawer ? { widget: 'channel-order-drawer', props: { drawer, closeHref: '/channels/orders' } } : null,
  }
}

export function channelOrdersSpec(data: ChannelOrdersData): PageSpec {
  return page({
    route: '/channels/orders',
    layout: 'list',
    header: [
      pageHeader({
        title: data.title,
        description: data.description,
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'channel_order',
        sp: data.currentParams,
        emptyTitle: data.emptyTitle,
        emptyDescription: data.emptyDescription,
        drawer: data.drawer,
      }),
    ],
  })
}

export { channelTabs }
