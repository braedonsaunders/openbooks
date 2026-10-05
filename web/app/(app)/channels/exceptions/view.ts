import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { page, pageHeader, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { loadChannelOrderDrawer } from '../order-detail'
import { channelTabs } from '../orders/view'

/**
 * Channel Exceptions: the needs-attention queue. Each row names its cause
 * with the one-click remedy; fixing one offers to replay every order blocked
 * by the same cause. Nothing here posts until it is fixed.
 */
export interface ChannelExceptionsData {
  title: string
  description: string
  tabs: { href: string; label: string; active: boolean; count?: number }[]
  currentParams: Record<string, string | string[] | undefined>
  emptyTitle: string
  emptyDescription: string
  canManage: boolean
  drawer: { widget: string; props: { drawer: unknown; closeHref: string } } | null
}

export async function loadChannelExceptions(
  sp: Record<string, string | string[] | undefined>,
): Promise<ChannelExceptionsData> {
  const authz = await requirePermission('channels.read')
  await requireFeatureEnabled(authz.user.orgId, 'salesChannels')
  const t = await getTranslations('channels')
  const orgId = authz.user.orgId
  const canManage = can(authz, 'channels.manage')

  const count = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from channel_orders where org_id = ${orgId} and posting_status = 'exception'`,
  )

  const orderId = typeof sp.order === 'string' && isUuid(sp.order) ? sp.order : null
  const drawer = orderId ? await loadChannelOrderDrawer(orgId, orderId, canManage) : null

  return {
    title: t('exceptionsTitle'),
    description: t('exceptionsDescription'),
    tabs: channelTabs(t, 'exceptions', Number(count.rows[0]?.count ?? '0')),
    currentParams: sp,
    emptyTitle: t('empty.exceptionsTitle'),
    emptyDescription: t('empty.exceptionsDescription'),
    canManage,
    drawer: drawer ? { widget: 'channel-order-drawer', props: { drawer, closeHref: '/channels/exceptions' } } : null,
  }
}

export function channelExceptionsSpec(data: ChannelExceptionsData): PageSpec {
  return page({
    route: '/channels/exceptions',
    layout: 'list',
    header: [
      pageHeader({
        title: data.title,
        description: data.description,
        actions: [
          widget('module-home-tabs', { tabs: data.tabs }),
          ...(data.canManage ? [widget('channel-replay-all', {})] : []),
        ],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'channel_exception',
        sp: data.currentParams,
        emptyTitle: data.emptyTitle,
        emptyDescription: data.emptyDescription,
        drawer: data.drawer,
      }),
    ],
  })
}
