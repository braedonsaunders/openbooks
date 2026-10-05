import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { loadChannelOrderDrawer } from '../order-detail'
import { guardChannelOrderScope } from '../../../../lib/channel-scope'
import { channelTabs, countChannelExceptions } from '../orders/view'

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
  eventEmptyTitle: string
  eventEmptyDescription: string
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

  const exceptionCount = await countChannelExceptions(orgId, authz.allowedSubsidiaryIds)

  const orderId = typeof sp.order === 'string' && isUuid(sp.order) ? sp.order : null
  const drawer = orderId && !(await guardChannelOrderScope(authz, orderId))
    ? await loadChannelOrderDrawer(orgId, orderId, canManage)
    : null

  return {
    title: t('exceptionsTitle'),
    description: t('exceptionsDescription'),
    tabs: channelTabs(t, 'exceptions', exceptionCount),
    currentParams: sp,
    emptyTitle: t('empty.exceptionsTitle'),
    emptyDescription: t('empty.exceptionsDescription'),
    eventEmptyTitle: t('empty.eventExceptionsTitle'),
    eventEmptyDescription: t('empty.eventExceptionsDescription'),
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
          ...(data.canManage ? [widget('channel-replay-all', {}), widget('channel-replay-all', { scope: 'events' })] : []),
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
      widgetBlock('entity-list-view', {
        recordType: 'channel_event_exception',
        sp: data.currentParams,
        emptyTitle: data.eventEmptyTitle,
        emptyDescription: data.eventEmptyDescription,
        drawer: null,
      }),
    ],
  })
}
