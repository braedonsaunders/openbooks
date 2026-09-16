import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { defaultContinuousClosePolicy } from '@openbooks/engine/src/continuous-close.ts'
import { detectorSpecsForAgent } from '@openbooks/engine/src/continuous-close-config.ts'
import { requirePermission } from '../../../../../../lib/authz'
import { agentPackMetas, getAgentsOverview } from '../../../../../../lib/setup/agents'
import type { AgentsLibraryWorkspace } from './AgentsLibraryWorkspace'

/**
 * Agents library — the catalog of packs the engine registry ships: what each
 * reads, what it proposes, what it needs (feature + permissions), and its
 * detector list, with install/enable from here. Split into a loader and a spec.
 *
 * The install flow round-trips the FULL default policy (the overview toggle
 * precedent): enabling is one PUT of the policy the engine would default to,
 * so install and configure share the same command and audit shape. All copy
 * resolves inside the island via its existing hooks.
 *
 * Loader work: the `admin.setup.manage` gate, one `getAgentsOverview` call
 * for install state, and the pure `agentPackMetas()` join for detectors and
 * required permissions. The feature flag travels hoisted like the overview.
 */

type AgentsLibraryWorkspaceProps = Parameters<typeof AgentsLibraryWorkspace>[0]

export interface AgentsLibraryData {
  packs: AgentsLibraryWorkspaceProps['packs']
  featureEnabled: AgentsLibraryWorkspaceProps['featureEnabled']
}

export async function loadAgentsLibrary(): Promise<AgentsLibraryData> {
  const authz = await requirePermission('admin.setup.manage')
  const [rows, metas] = await Promise.all([getAgentsOverview(authz.user.orgId), agentPackMetas()])
  const enabledByKey = new Map(rows.map((row) => [row.agentKey, row.policy]))
  // Install and configure share one command: an unconfigured pack installs by
  // PUTing the engine default policy with enabled flipped on.
  const packs = metas.map((meta) => ({
    agentKey: meta.agentKey,
    enabled: enabledByKey.get(meta.agentKey)?.enabled ?? false,
    policy: enabledByKey.get(meta.agentKey) ?? defaultContinuousClosePolicy(meta.agentKey),
    readPermissions: meta.readPermissions,
    detectors: detectorSpecsForAgent(meta.agentKey).map((spec) => ({
      detectorKey: spec.detectorKey,
      supportsMateriality: spec.supportsMateriality,
    })),
  }))
  return {
    packs,
    featureEnabled: rows[0]?.featureEnabled ?? false,
  }
}

export function agentsLibrarySpec(data: AgentsLibraryData): PageSpec {
  return page({
    route: '/admin/setup/agents/library',
    // Same shell rule as the overview: the setup workspace owns the chrome
    // and the island owns its own spacing wrapper.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('agents-library-workspace', {
        packs: data.packs,
        featureEnabled: data.featureEnabled,
      }),
    ],
  })
}
