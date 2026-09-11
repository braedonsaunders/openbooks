import { ModuleView } from '../../../../components/viewspec/module-view'
import { assistantConversationSpec, loadAssistantConversation } from './view'

export const dynamic = 'force-dynamic'


/** One deep-linkable assistant conversation. */
export default async function AssistantConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  // Optional: this route natively takes only `params`.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const sp = (await searchParams) ?? {}
  const data = await loadAssistantConversation(id)
  return <ModuleView spec={assistantConversationSpec(data)} data={data} searchParams={sp} trusted />
}
