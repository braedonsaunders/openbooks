import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'

export type ConnectData = Record<string, never>

/** Connect Shopify: the wizard owns its steps; the spec only hosts it. */
export async function loadConnect(): Promise<ConnectData> {
  const authz = await requirePermission('channels.manage')
  await requireFeatureEnabled(authz.user.orgId, 'salesChannels')
  return {}
}

export function connectSpec(): PageSpec {
  return page({
    route: '/channels/connect',
    layout: 'bare',
    header: [],
    body: [widgetBlock('shopify-connect')],
  })
}
