import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadChannelPosting, channelPostingSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Channels → Posting — how each channel turns storefront orders into
 * accounting. The form writes a new effective-dated policy; orders already
 * posted keep their documents.
 */
export default async function ChannelPostingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadChannelPosting()
  return <ModuleView spec={channelPostingSpec(data)} data={data} searchParams={sp} trusted />
}
