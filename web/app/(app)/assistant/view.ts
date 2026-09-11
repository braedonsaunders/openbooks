import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { getOrgAiConfig } from '../../../lib/assistant/ai-config'
import { getModel } from '../../../lib/assistant/client'
import { listConversations } from '../../../lib/ai-conversations'

/**
 * The assistant new-chat page, split into a loader and a spec.
 *
 * This page is the degenerate case of the brief's vocabulary: a fully
 * client-side workbench (`'use client'` — sidebar, streaming thread,
 * composer, every fetch) with zero server-rendered content. The LOADER
 * reproduces the native `page.tsx` verbatim — `assistant.use` gate, sidebar
 * list, the model-configured check, the `?q=` prompt — and the spec places
 * the whole app through the `assistant-app` widget, exactly as a studio
 * (CardStudio, ViewStudio) or the SQL console is placed: the spec composes
 * pages, it does not reimplement domain components.
 *
 * The native component is NOT copied. `AssistantApp` stays where it is
 * (`web/components/assistant/assistant-app.tsx`, also owned by the `[id]`
 * sibling route) and the registry entry renders it
 * directly with loader-resolved props.
 *
 * Visibility note: `listConversations` filters by owner in SQL
 * (ai-conversations.ts), so the sidebar — the only server data on the
 * page — is already reader-scoped before it reaches the spec. No counts
 * travel through props.
 */

/** Loader-resolved, presentation-ready props for the `assistant-app` widget. */
export interface AssistantData {
  conversations: { id: string; title: string; updatedAt: string }[]
  canWrite: boolean
  aiEnabled: boolean
  initialPrompt?: string
}

export async function loadAssistant(
  sp: Record<string, string | string[] | undefined>,
): Promise<AssistantData> {
  // Native page.tsx, verbatim: permission first, then sidebar + config + ?q=.
  const authz = await requirePermission('assistant.use')
  const [conversations, aiConfig] = await Promise.all([
    listConversations(authz, 'assistant'),
    getOrgAiConfig(authz.user.orgId),
  ])
  const q = sp.q
  return {
    conversations,
    canWrite: can(authz, 'assistant.write'),
    aiEnabled: getModel(aiConfig, 'smart') !== null,
    // Single-valued ?q= only; an array (or absent) prompt is no prompt.
    ...(typeof q === 'string' ? { initialPrompt: q } : {}),
  }
}

export function assistantSpec(data: AssistantData): PageSpec {
  return page({
    route: '/assistant',
    // Bare: the app owns its own full-height flex column (the native root
    // is `flex h-full min-h-0 flex-1` under the app shell's <main>), so no
    // ListPageLayout chrome may wrap it.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('assistant-app', {
        conversations: data.conversations,
        activeId: null,
        initialMessages: [],
        canWrite: data.canWrite,
        aiEnabled: data.aiEnabled,
        // Omitted when absent: passing `undefined` would arrive as an
        // explicit prop the component treats the same, but a missing key
        // keeps the two render paths' props objects identical.
        ...(data.initialPrompt !== undefined ? { initialPrompt: data.initialPrompt } : {}),
      }),
    ],
  })
}
