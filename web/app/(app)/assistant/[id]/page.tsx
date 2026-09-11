import {
} from '../../../../lib/ai-conversations'
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
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={assistantConversationSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
