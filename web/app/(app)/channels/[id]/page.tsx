import { ModuleView } from '../../../../components/viewspec/module-view'
import { assertWorkspaceChannel, channelWorkspaceSpec, loadChannelWorkspace, resolveWorkspaceTab } from './view'

export const dynamic = 'force-dynamic'

/**
 * Channel workspace — health, deliveries, and settings for one storefront
 * connection. Tab content reads the org-scoped channel endpoints, so every
 * tenant sees only its own deliveries and mappings.
 */
export default async function ChannelWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  await assertWorkspaceChannel(id)
  const sp = await searchParams
  const data = await loadChannelWorkspace()
  return <ModuleView spec={channelWorkspaceSpec(id, resolveWorkspaceTab(sp.tab), sp)} data={data} searchParams={sp} trusted />
}
