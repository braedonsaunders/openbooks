import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadConversations, conversationsSpec } from './view'
export const dynamic = 'force-dynamic'
export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadConversations(sp)
  return <ModuleView spec={conversationsSpec(data)} data={data} searchParams={sp} trusted />
}
