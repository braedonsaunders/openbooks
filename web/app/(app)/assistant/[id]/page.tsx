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

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One deep-linkable assistant conversation. */
export default async function AssistantConversationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const authz = await requirePermission('assistant.use')
  const { id } = await params
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
