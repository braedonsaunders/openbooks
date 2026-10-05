import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadChannelExceptions, channelExceptionsSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Channels → Exceptions — the needs-attention queue. Each row names its
 * cause with the one-click remedy; nothing here posts until it is fixed.
 */
export default async function ChannelExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadChannelExceptions(sp)
  return <ModuleView spec={channelExceptionsSpec(data)} data={data} searchParams={sp} trusted />
}
