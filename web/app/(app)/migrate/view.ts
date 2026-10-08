import 'server-only'

import { redirect } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { accessDeniedHref } from '../../../lib/gate-targets'
import { getOrgAiConfig } from '../../../lib/assistant/ai-config'
import { getModel } from '../../../lib/assistant/client'
import { listConversations, ownsConversation, recentMessages } from '../../../lib/ai-conversations'
import { isUuid } from '../../../lib/list-params'
import { loadMigrationJourney, type MigrationJourney } from '../../../lib/migration/journey'
import { MIGRATION_WORKSPACE_HREF } from '../../../lib/migration/links'

/**
 * The migration workspace: a migration-scoped assistant conversation beside
 * the measured migration plan. Migration is organization-wide setup work, so
 * the page needs the setup permission with unrestricted subsidiary access;
 * the plan renders without an AI provider, and the conversation needs
 * assistant access.
 */

export interface MigrationWorkspaceData {
  conversations: { id: string; title: string; updatedAt: string }[]
  activeId: string | null
  initialMessages: { id: string; role: 'user' | 'assistant' | 'system'; content: string; data: { parts?: unknown[] } | null; createdAt: string }[]
  canWrite: boolean
  canConfigureAi: boolean
  aiEnabled: boolean
  canImport: boolean
  journey: MigrationJourney
  initialPrompt?: string
}

export async function loadMigrationWorkspace(sp: Record<string, string | string[] | undefined> = {}): Promise<MigrationWorkspaceData> {
  return migrationWorkspaceData(null, sp)
}

/** The workspace payload for a new conversation (`null`) or one owned migration conversation. */
export async function migrationWorkspaceData(
  conversationId: string | null,
  sp: Record<string, string | string[] | undefined> = {},
): Promise<MigrationWorkspaceData> {
  const authz = await requirePermission('admin.setup.manage')
  if (authz.allowedSubsidiaryIds !== null) redirect(accessDeniedHref({ permission: 'admin.setup.manage' }))
  const chat = can(authz, 'assistant.use')
  if (conversationId !== null && (!chat || !isUuid(conversationId) || !(await ownsConversation(authz, conversationId, 'migration')))) {
    redirect(MIGRATION_WORKSPACE_HREF)
  }
  const [conversations, messages, aiConfig, journey] = await Promise.all([
    chat ? listConversations(authz, 'migration') : Promise.resolve([]),
    conversationId ? recentMessages(authz, conversationId) : Promise.resolve([]),
    getOrgAiConfig(authz.user.orgId),
    loadMigrationJourney(authz.user.orgId),
  ])
  const q = sp.q
  return {
    conversations,
    activeId: conversationId,
    initialMessages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      data: (m.data ?? null) as { parts?: unknown[] } | null,
      createdAt: m.createdAt,
    })),
    canWrite: can(authz, 'assistant.write'),
    canConfigureAi: can(authz, 'admin.ai.manage'),
    aiEnabled: chat && getModel(aiConfig, 'smart') !== null,
    canImport: can(authz, 'data.import'),
    journey,
    ...(typeof q === 'string' && q.trim() ? { initialPrompt: q } : {}),
  }
}

export function migrationWorkspaceSpec(data: MigrationWorkspaceData): PageSpec {
  return page({
    route: '/migrate',
    // Bare: the workspace owns its full-height flex column, like the assistant.
    layout: 'bare',
    header: [],
    body: [widgetBlock('migration-workspace', { ...data })],
  })
}
