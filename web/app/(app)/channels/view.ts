import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'

/**
 * The home console owns ListPageLayout and PageHeader because connection
 * management permissions arrive with the API payload. The spec delegates to
 * that shared shell without nesting a second scroll container. Channel writes
 * stay guarded by their API permissions.
 */

export type ChannelsHomeData = Record<string, never>

export async function loadChannelsHome(): Promise<ChannelsHomeData> {
  const authz = await requirePermission('channels.read')
  await requireFeatureEnabled(authz.user.orgId, 'salesChannels')
  return {}
}

export function channelsHomeSpec(): PageSpec {
  return page({
    route: '/channels',
    layout: 'bare',
    header: [],
    body: [widgetBlock('channels-console')],
  })
}
