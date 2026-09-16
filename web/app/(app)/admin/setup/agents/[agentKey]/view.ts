import 'server-only'

import { notFound } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { detectorSpecsForAgent } from '@openbooks/engine/src/continuous-close-config.ts'
import { isContinuousCloseAgentKey } from '@openbooks/engine/src/continuous-close.ts'
import { requirePermission } from '../../../../../../lib/authz'
import {
  getAgentsOverview,
  getSetupAgentNotification,
  listAgentNotificationTargets,
} from '../../../../../../lib/setup/agents'
import type { AgentPolicyWorkspace } from './AgentPolicyWorkspace'

/**
 * Per-pack policy — detectors on/off, thresholds, materiality, cadence,
 * analysis tier and finding routing for one agent pack. Split into a loader
 * and a spec.
 *
 * The whole surface renders inside ONE client island (`AgentPolicyWorkspace`):
 * the draft owns `useState` (schedule fields, per-detector controls,
 * analysis, routing), fires one `fetch` PUT of the FULL draft against
 * `/api/admin/setup/agents/[agentKey]` (the overview toggle precedent — a
 * partial save would reset untouched controls), and toasts +
 * `router.refresh()` on completion. Detector/parameter/analysis copy reuses
 * the `ai.agents.*` keys the provider drawer reads, so both surfaces stay
 * worded alike. All copy resolves inside the island.
 *
 * Loader work: the `admin.setup.manage` gate, the agent-key whitelist (an
 * unrecognized key 404s, never a default pack), one `getAgentsOverview` call
 * for the pack's policy/run/count, the engine detector specs, the stored
 * routing, and the role/people targets. The feature flag travels hoisted
 * like the overview.
 */

type AgentPolicyWorkspaceProps = Parameters<typeof AgentPolicyWorkspace>[0]

export interface AgentPolicyData {
  pack: AgentPolicyWorkspaceProps['pack']
  specs: AgentPolicyWorkspaceProps['specs']
  notification: AgentPolicyWorkspaceProps['notification']
  roles: AgentPolicyWorkspaceProps['roles']
  users: AgentPolicyWorkspaceProps['users']
  usersTruncated: AgentPolicyWorkspaceProps['usersTruncated']
  featureEnabled: AgentPolicyWorkspaceProps['featureEnabled']
}

export async function loadAgentPolicy(agentKey: string): Promise<AgentPolicyData> {
  if (!isContinuousCloseAgentKey(agentKey)) notFound()
  const authz = await requirePermission('admin.setup.manage')
  const [rows, notification, targets] = await Promise.all([
    getAgentsOverview(authz.user.orgId),
    getSetupAgentNotification(authz.user.orgId, agentKey),
    listAgentNotificationTargets(authz.user.orgId),
  ])
  const row = rows.find((entry) => entry.agentKey === agentKey)
  if (!row) notFound()
  return {
    pack: {
      agentKey: row.agentKey,
      policy: row.policy,
      lastRun: row.lastRun,
      openFindings: row.openFindings,
    },
    specs: detectorSpecsForAgent(agentKey).map((spec) => ({
      detectorKey: spec.detectorKey,
      supportsMateriality: spec.supportsMateriality,
      parameters: spec.parameters.map((parameter) => ({ ...parameter })),
    })),
    notification,
    roles: targets.roles,
    users: targets.users,
    usersTruncated: targets.truncatedUsers,
    featureEnabled: row.featureEnabled,
  }
}

export function agentPolicySpec(data: AgentPolicyData): PageSpec {
  return page({
    route: '/admin/setup/agents/[agentKey]',
    // Same shell rule as the overview: the setup workspace owns the chrome
    // and the island owns its own spacing wrapper.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('agents-policy-workspace', {
        pack: data.pack,
        specs: data.specs,
        notification: data.notification,
        roles: data.roles,
        users: data.users,
        usersTruncated: data.usersTruncated,
        featureEnabled: data.featureEnabled,
      }),
    ],
  })
}
