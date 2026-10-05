import 'server-only'

import { notFound } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export type ChannelWorkspaceData = {
  channelId: string
  tab: ChannelWorkspaceTab
  sp: Record<string, string | string[] | undefined>
}

export async function loadChannelWorkspace(
  id: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<ChannelWorkspaceData> {
  await assertWorkspaceChannel(id)
  const authz = await requirePermission('channels.read')
  await requireFeatureEnabled(authz.user.orgId, 'salesChannels')
  return { channelId: id, tab: resolveWorkspaceTab(sp.tab), sp }
}

// Connector-contributed tabs ride the same `?tab=` slot under an
// `adapter:` prefix; the shell only links the keys the channel's adapter
// actually contributes, so other kinds never resolve them.
const WORKSPACE_TABS = ['overview', 'activity', 'settings', 'adapter:products', 'adapter:locations'] as const
export type ChannelWorkspaceTab = (typeof WORKSPACE_TABS)[number]

export function channelWorkspaceSpec(data: ChannelWorkspaceData): PageSpec {
  return page({
    route: '/channels/[id]',
    layout: 'bare',
    header: [],
    body: [widgetBlock('channel-workspace', { channelId: data.channelId, tab: data.tab, sp: data.sp })],
  })
}

export function resolveWorkspaceTab(tab: string | string[] | undefined): ChannelWorkspaceTab {
  const single = Array.isArray(tab) ? tab[0] : tab
  return (WORKSPACE_TABS as readonly string[]).includes(single ?? '') ? (single as ChannelWorkspaceTab) : 'overview'
}

export async function assertWorkspaceChannel(channelId: string): Promise<void> {
  if (!isUuid(channelId)) notFound()
}
