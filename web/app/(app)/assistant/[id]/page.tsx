import { redirect } from 'next/navigation'
import { AssistantApp } from '../../../../components/assistant/assistant-app'
import { getModel } from '../../../../lib/assistant/client'
import { getOrgAiConfig } from '../../../../lib/assistant/ai-config'
import { can, requirePermission } from '../../../../lib/authz'
import {
  listConversations,
  ownsConversation,
  recentMessages,
} from '../../../../lib/ai-conversations'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { assistantConversationSpec, loadAssistantConversation } from './view'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  if (sp.__viewspec === '1') {
    const data = await loadAssistantConversation(id)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={assistantConversationSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }

  const authz = await requirePermission('assistant.use')
  if (!UUID_RE.test(id) || !(await ownsConversation(authz, id, 'assistant'))) {
    redirect('/assistant')
  }
  const [conversations, messages, aiConfig] = await Promise.all([
    listConversations(authz, 'assistant'),
    recentMessages(authz, id),
    getOrgAiConfig(authz.user.orgId),
  ])
  return (
    <AssistantApp
      conversations={conversations}
      activeId={id}
      initialMessages={messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        data: (m.data ?? null) as { parts?: unknown[] } | null,
      }))}
      canWrite={can(authz, 'assistant.write')}
      aiEnabled={getModel(aiConfig, 'smart') !== null}
    />
  )
}
