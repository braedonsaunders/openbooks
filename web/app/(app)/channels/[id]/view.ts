import 'server-only'

import { notFound } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export type ChannelWorkspaceData = Record<string, never>

export async function loadChannelWorkspace(): Promise<ChannelWorkspaceData> {
  const authz = await requirePermission('channels.read')
  await requireFeatureEnabled(authz.user.orgId, 'salesChannels')
  return {}
}

const WORKSPACE_TABS = ['overview', 'activity', 'settings'] as const
export type ChannelWorkspaceTab = (typeof WORKSPACE_TABS)[number]

export function channelWorkspaceSpec(
  channelId: string,
  tab: string,
  sp: Record<string, string | string[] | undefined>,
): PageSpec {
  return page({
    route: `/channels/${channelId}`,
    layout: 'bare',
    header: [],
    body: [widgetBlock('channel-workspace', { channelId, tab, sp })],
  })
}

export function resolveWorkspaceTab(tab: string | string[] | undefined): ChannelWorkspaceTab {
  const single = Array.isArray(tab) ? tab[0] : tab
  return (WORKSPACE_TABS as readonly string[]).includes(single ?? '') ? (single as ChannelWorkspaceTab) : 'overview'
}

export async function assertWorkspaceChannel(channelId: string): Promise<void> {
  if (!isUuid(channelId)) notFound()
}
