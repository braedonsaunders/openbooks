import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../../lib/authz'
import {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  listAgentRuns,
} from '../../../../../../lib/setup/agents'
import type { AgentsActivityWorkspace } from './AgentsActivityWorkspace'

/**
 * Agents activity — run envelopes across packs (status, duration, findings,
 * errors) with re-run and a link into findings. Split into a loader and a spec.
 *
 * The list renders inside ONE client island (`AgentsActivityWorkspace`): the
 * pack filter and show-more paging fire `fetch` GETs against
 * `/api/admin/setup/agents/activity`, re-run POSTs to the per-pack run route
 * (the overview run-now precedent), and the island toasts +
 * `router.refresh()` on completion. All copy resolves inside the island via
 * its existing hooks.
 *
 * Loader work: the `admin.setup.manage` gate plus one `listAgentRuns` call
 * for the first page; the pack filter options travel as the registry keys so
 * the island never hardcodes them.
 */

type AgentsActivityWorkspaceProps = Parameters<typeof AgentsActivityWorkspace>[0]

export interface AgentsActivityData {
  runs: AgentsActivityWorkspaceProps['runs']
  total: AgentsActivityWorkspaceProps['total']
  truncated: AgentsActivityWorkspaceProps['truncated']
  packs: AgentsActivityWorkspaceProps['packs']
}

export async function loadAgentsActivity(): Promise<AgentsActivityData> {
  const authz = await requirePermission('admin.setup.manage')
  const result = await listAgentRuns(authz.user.orgId, {})
  return {
    runs: result.runs,
    total: result.total,
    truncated: result.truncated,
    packs: [...CONTINUOUS_CLOSE_AGENT_KEYS],
  }
}

export function agentsActivitySpec(data: AgentsActivityData): PageSpec {
  return page({
    route: '/admin/setup/agents/activity',
    // Same shell rule as the sibling pages: the setup workspace owns the
    // chrome and the island owns its own spacing wrapper.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('agents-activity-workspace', {
        runs: data.runs,
        total: data.total,
        truncated: data.truncated,
        packs: data.packs,
      }),
    ],
  })
}
