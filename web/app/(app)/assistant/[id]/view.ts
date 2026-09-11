import 'server-only'

import { redirect } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { getOrgAiConfig } from '../../../../lib/assistant/ai-config'
import { getModel } from '../../../../lib/assistant/client'
import {
  listConversations,
  ownsConversation,
  recentMessages,
} from '../../../../lib/ai-conversations'

/**
 * One deep-linkable assistant conversation, split into a loader and a spec.
 *
 * The same degenerate case as the sibling `/assistant` view.ts: a fully
 * client-side workbench (`'use client'` — sidebar, streaming thread,
 * composer, every fetch) with zero server-rendered content. The LOADER
 * reproduces the native `page.tsx` verbatim — `assistant.use` gate, UUID
 * shape check, owner check with redirect, sidebar list, the last-30 message
 * window, the model-configured check — and the spec places the whole app
 * through the `assistant-app` widget, exactly as a studio (CardStudio,
 * ViewStudio) or the SQL console is placed: the spec composes pages, it does
 * not reimplement domain components.
 *
 * The native component is NOT copied. `AssistantApp` stays where it is
 * (`web/components/assistant/assistant-app.tsx`, also rendered by the
 * `/assistant` sibling route) and the registry entry
 * renders it directly with loader-resolved props.
 *
 * Visibility note: `listConversations` and `recentMessages` both filter by
 * owner in SQL (ai-conversations.ts), so the sidebar AND the thread — the
 * only server data on the page — are already reader-scoped before they
 * reach the spec. No counts travel through props.
 */

/** Loader-resolved, presentation-ready props for the `assistant-app` widget. */
export interface AssistantConversationData {
  conversations: { id: string; title: string; updatedAt: string }[]
  /** Route param — the owned conversation id, never a bare/foreign id: the
   *  loader redirects those to /assistant before any data resolves. */
  activeId: string
  initialMessages: {
    id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    data: { parts?: unknown[] } | null
  }[]
  canWrite: boolean
  aiEnabled: boolean
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function loadAssistantConversation(id: string): Promise<AssistantConversationData> {
  // Native page.tsx, verbatim: permission first, then the UUID shape check +
  // owner check (redirect, not a body — see the registry entry §4), then the
  // sidebar + thread window + model config in parallel. No search params:
  // like loadDocArticle(slug), the loader takes only the segment param.
  const authz = await requirePermission('assistant.use')
  if (!UUID_RE.test(id) || !(await ownsConversation(authz, id, 'assistant'))) {
    redirect('/assistant')
  }
  const [conversations, messages, aiConfig] = await Promise.all([
    listConversations(authz, 'assistant'),
    recentMessages(authz, id),
    getOrgAiConfig(authz.user.orgId),
  ])
  return {
    conversations,
    activeId: id,
    initialMessages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      data: (m.data ?? null) as { parts?: unknown[] } | null,
    })),
    canWrite: can(authz, 'assistant.write'),
    aiEnabled: getModel(aiConfig, 'smart') !== null,
  }
}

export function assistantConversationSpec(data: AssistantConversationData): PageSpec {
  return page({
    route: '/assistant/[id]',
    // Bare: the app owns its own full-height flex column (the native root
    // is `flex h-full min-h-0 flex-1` under the app shell's <main>), so no
    // ListPageLayout chrome may wrap it. Same call as the /assistant spec.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('assistant-app', {
        conversations: data.conversations,
        activeId: data.activeId,
        initialMessages: data.initialMessages,
        canWrite: data.canWrite,
        aiEnabled: data.aiEnabled,
      }),
    ],
  })
}
