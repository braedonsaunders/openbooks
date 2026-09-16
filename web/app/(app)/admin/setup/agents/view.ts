import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { getAgentsOverview } from '../../../../../lib/setup/agents'
import type { AgentsOverviewWorkspace } from './AgentsOverviewWorkspace'

/**
 * Agents overview — every pack from the engine registry with its enabled
 * switch, cadence, last run, open findings, run-now and a link to its policy
 * page. Split into a loader and a spec.
 *
 * The native surface renders inside ONE client island
 * (`AgentsOverviewWorkspace`): the switches own `useState` (switch state,
 * pending key, running key), fire `fetch` mutations against
 * `/api/admin/setup/agents/*`, and toast + `router.refresh()` on completion —
 * the FeaturesWorkspace precedent. All copy resolves inside the island via
 * its existing hooks, so no message key can be invented here.
 *
 * Loader work: the `admin.setup.manage` gate plus one `getAgentsOverview`
 * call. The Continuous Close feature flag travels hoisted (every row carries
 * the same value) so the island can fence the switches without re-deriving.
 */

type AgentsOverviewWorkspaceProps = Parameters<typeof AgentsOverviewWorkspace>[0]

export interface AgentsOverviewData {
  rows: AgentsOverviewWorkspaceProps['rows']
  featureEnabled: AgentsOverviewWorkspaceProps['featureEnabled']
}

export async function loadAgentsOverview(): Promise<AgentsOverviewData> {
  const authz = await requirePermission('admin.setup.manage')
  const rows = await getAgentsOverview(authz.user.orgId)
  return {
    rows: rows.map((row) => ({
      agentKey: row.agentKey,
      policy: row.policy,
      lastRun: row.lastRun,
      openFindings: row.openFindings,
    })),
    featureEnabled: rows[0]?.featureEnabled ?? false,
  }
}

export function agentsOverviewSpec(data: AgentsOverviewData): PageSpec {
  return page({
    route: '/admin/setup/agents',
    // The setup workspace renders its own shell around every setup page, so
    // a second page layout would nest the chrome. And the `space-y-8`
    // wrapper belongs to the island itself — the spec must NOT place it too
    // (the Features `max-w-4xl`-wrapper precedent).
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('agents-overview-workspace', {
        rows: data.rows,
        featureEnabled: data.featureEnabled,
      }),
    ],
  })
}
