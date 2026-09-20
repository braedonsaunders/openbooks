import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { grid, heading, page, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { detectorSpecsForAgent } from '@openbooks/engine/src/agents/continuous-close-config.ts'
import { isContinuousCloseAgentKey } from '@openbooks/engine/src/continuous-close/continuous-close.ts'
import { requirePermission } from '../../../../../../lib/authz'
import { dateTime } from '../../../../../../lib/format'
import { getMoneyFormatter } from '../../../../../../lib/money-server'
import {
  getAgentsOverview,
  getSetupAgentNotification,
  listAgentNotificationTargets,
} from '../../../../../../lib/setup/agents'
import type { AgentPolicyForm } from './AgentPolicyForm'

/**
 * Per-pack policy — detectors on/off, thresholds, materiality, cadence,
 * analysis tier and finding routing for one agent pack. Split into a loader
 * and a spec.
 *
 * The page follows the Setup form pattern (the [entity] precedent): an
 * in-content heading, the shared `attention-list` warning when the module
 * switch is off, and ONE form island (`agents-policy-form`) rendering shared
 * Card sections with fields from the shared @openbooks/ui components
 * (SearchSelect single selects, TokenSelect add-and-remove lists for the
 * role/people routing). THE LOADER COMPUTES the header strings; the island's
 * section copy resolves inside via hooks on the existing `ai.agents.*` keys,
 * so no message key is invented.
 *
 * The island owns one draft and fires one `fetch` PUT of the FULL draft
 * against `/api/admin/setup/agents/[agentKey]` (the overview toggle
 * precedent — a partial save would reset untouched controls), and toasts +
 * `router.refresh()` on completion.
 *
 * Loader work: the `admin.setup.manage` gate, the agent-key whitelist (an
 * unrecognized key 404s, never a default pack), one `getAgentsOverview` call
 * for the pack's policy/run/count, the engine detector specs, the stored
 * routing, and the role/people targets. The feature flag travels hoisted
 * like the overview.
 */

type AgentPolicyFormProps = Parameters<typeof AgentPolicyForm>[0]

export interface AgentPolicyData {
  title: string
  backHref: string
  backLabel: string
  hasFeatureOff: boolean
  attentionItems: { tone: 'warning'; text: string; href: string }[]
  attentionAllClear: string
  statusLabel: AgentPolicyFormProps['statusLabel']
  statusEnabled: AgentPolicyFormProps['statusEnabled']
  description: AgentPolicyFormProps['description']
  runLine: AgentPolicyFormProps['runLine']
  currency: AgentPolicyFormProps['currency']
  pack: AgentPolicyFormProps['pack']
  specs: AgentPolicyFormProps['specs']
  notification: AgentPolicyFormProps['notification']
  roles: AgentPolicyFormProps['roles']
  users: AgentPolicyFormProps['users']
  usersTruncated: AgentPolicyFormProps['usersTruncated']
  featureEnabled: AgentPolicyFormProps['featureEnabled']
}

export async function loadAgentPolicy(agentKey: string): Promise<AgentPolicyData> {
  if (!isContinuousCloseAgentKey(agentKey)) notFound()
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin')
  const [rows, notification, targets, { currency }] = await Promise.all([
    getAgentsOverview(authz.user.orgId),
    getSetupAgentNotification(authz.user.orgId, agentKey),
    listAgentNotificationTargets(authz.user.orgId),
    getMoneyFormatter(authz.user.orgId),
  ])
  const row = rows.find((entry) => entry.agentKey === agentKey)
  if (!row) notFound()
  const featureEnabled = row.featureEnabled
  return {
    title: t(`setup.agents.packs.${agentKey}.title`),
    backHref: '/admin/setup/agents',
    backLabel: t('setup.agents.policy.backLabel'),
    hasFeatureOff: !featureEnabled,
    attentionItems: featureEnabled
      ? []
      : [{ tone: 'warning', text: t('setup.agents.overview.featureOff'), href: '/admin/setup/features' }],
    attentionAllClear: '',
    statusLabel: t(`setup.agents.overview.${row.policy.enabled ? 'enabled' : 'disabled'}`),
    statusEnabled: row.policy.enabled,
    description: t(`setup.agents.packs.${agentKey}.description`),
    runLine: row.lastRun
      ? `${t('setup.agents.overview.lastRun', {
          date: dateTime(row.lastRun.startedAt),
          status: t(`setup.agents.runStatuses.${row.lastRun.status}`),
        })} · ${t('setup.agents.overview.openFindings', { count: row.openFindings })}`
      : `${t('setup.agents.overview.neverRun')} · ${t('setup.agents.overview.openFindings', {
          count: row.openFindings,
        })}`,
    currency,
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
    featureEnabled,
  }
}

const f = ref<AgentPolicyData>()

export function agentPolicySpec(data: AgentPolicyData): PageSpec {
  return page({
    route: '/admin/setup/agents/[agentKey]',
    // Same shell rule as the overview: the setup workspace owns the chrome.
    layout: 'bare',
    header: [],
    body: [
      grid('space-y-4', [
        grid('flex items-start justify-between gap-3', [
          grid('min-w-0', [heading(2, f('title'), 'text-lg font-semibold text-slate-900 dark:text-slate-100')]),
          grid('flex shrink-0 items-center gap-2', [
            widgetBlock('link-button', {
              href: data.backHref,
              label: data.backLabel,
              variant: 'outline',
              size: 'sm',
            }),
          ]),
        ]),
        {
          ...widgetBlock('attention-list', {
            items: data.attentionItems,
            allClear: data.attentionAllClear,
          }),
          when: f('hasFeatureOff'),
        },
        widgetBlock('agents-policy-form', {
          statusLabel: data.statusLabel,
          statusEnabled: data.statusEnabled,
          description: data.description,
          runLine: data.runLine,
          currency: data.currency,
          pack: data.pack,
          specs: data.specs,
          notification: data.notification,
          roles: data.roles,
          users: data.users,
          usersTruncated: data.usersTruncated,
          featureEnabled: data.featureEnabled,
        }),
      ]),
    ],
  })
}
