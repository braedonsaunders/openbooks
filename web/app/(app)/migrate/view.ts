import 'server-only'

import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { page, pageHeader, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { db } from '@openbooks/engine/platform/database'
import { can, requirePermission } from '../../../lib/authz'
import { accessDeniedHref } from '../../../lib/gate-targets'
import { getOrgAiConfig } from '../../../lib/assistant/ai-config'
import { getModel } from '../../../lib/assistant/client'
import { listConversations, ownsConversation, recentMessages } from '../../../lib/ai-conversations'
import { isUuid } from '../../../lib/list-params'
import { loadMigrationJourney, type MigrationJourney } from '../../../lib/migration/journey'
import { MIGRATION_WORKSPACE_HREF } from '../../../lib/migration/links'
import type { CutoverAccountChoice } from '../../../components/migration/migration-cutover'

/**
 * The guided migration cutover: the checklist every path works through,
 * with or without the assistant. Migration is organization-wide setup
 * work, so the page needs the setup permission with unrestricted
 * subsidiary access. The opening-balance draft needs the import and
 * posting permissions; its card names the missing permission with the
 * remedy instead of hiding the work.
 */

export interface MigrationCutoverData {
  title: string
  description: string
  journey: MigrationJourney
  accounts: CutoverAccountChoice[]
  canDraftOpening: boolean
  canImport: boolean
  aiEnabled: boolean
}

async function chartPostingAccounts(orgId: string): Promise<CutoverAccountChoice[]> {
  const rows = (await db.execute<{ id: string; number: string | null; name: string }>(sql`
    select id, number, name from accounts
     where org_id = ${orgId} and is_active and not is_summary
     order by number nulls last, name`)).rows
  return rows.map((row) => ({ id: row.id, number: row.number, name: row.name }))
}

export async function loadMigrationCutover(): Promise<MigrationCutoverData> {
  const authz = await requirePermission('admin.setup.manage')
  if (authz.allowedSubsidiaryIds !== null) redirect(accessDeniedHref({ permission: 'admin.setup.manage' }))
  const t = await getTranslations('sync.migrationAssistant')
  const [journey, aiConfig, accounts] = await Promise.all([
    loadMigrationJourney(authz.user.orgId),
    getOrgAiConfig(authz.user.orgId),
    chartPostingAccounts(authz.user.orgId),
  ])
  return {
    title: t('cutover.title'),
    description: t('cutover.description'),
    journey,
    accounts,
    canDraftOpening: can(authz, 'gl.post') && can(authz, 'data.import'),
    canImport: can(authz, 'data.import'),
    aiEnabled: can(authz, 'assistant.use') && getModel(aiConfig, 'smart') !== null,
  }
}

export function migrationCutoverSpec(data: MigrationCutoverData): PageSpec {
  return page({
    route: '/migrate',
    layout: 'list',
    header: [
      pageHeader({
        title: data.title,
        description: data.description,
      }),
    ],
    body: [widgetBlock('migration-cutover', {
      journey: data.journey,
      accounts: data.accounts,
      canDraftOpening: data.canDraftOpening,
      canImport: data.canImport,
      aiEnabled: data.aiEnabled,
    })],
  })
}

/**
 * The migration assistant conversation beside the measured migration plan,
 * now an optional helper reached from the guided cutover. New conversations
 * start at /migrate/assistant; deep-linkable threads stay at /migrate/[id].
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

export function migrationWorkspaceSpec(route: string, data: MigrationWorkspaceData): PageSpec {
  return page({
    route,
    // Bare: the workspace owns its full-height flex column, like the assistant.
    layout: 'bare',
    header: [],
    body: [widgetBlock('migration-workspace', { ...data })],
  })
}
