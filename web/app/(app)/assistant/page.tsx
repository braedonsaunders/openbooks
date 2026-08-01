import { getTranslations } from 'next-intl/server'
import { AssistantApp } from '../../../components/assistant/assistant-app'
import { getModel } from '../../../lib/assistant/client'
import { getOrgAiConfig } from '../../../lib/assistant/ai-config'
import { can, requirePermission } from '../../../lib/authz'
import { listConversations } from '../../../lib/ai-conversations'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('assistant')
  return { title: t('title') }
}

/** New-chat view of the assistant, ported from beaconhs's assistant page. */
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const authz = await requirePermission('assistant.use')
  const [conversations, aiConfig, { q }] = await Promise.all([
    listConversations(authz, 'assistant'),
    getOrgAiConfig(authz.user.orgId),
    searchParams,
  ])
  return (
    <AssistantApp
      conversations={conversations}
      activeId={null}
      initialMessages={[]}
      canWrite={can(authz, 'assistant.write')}
      aiEnabled={getModel(aiConfig, 'smart') !== null}
      initialPrompt={typeof q === 'string' ? q : undefined}
    />
  )
}
