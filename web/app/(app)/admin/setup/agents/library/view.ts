import 'server-only'

import { getTranslations } from 'next-intl/server'
import { defaultContinuousClosePolicy } from '@openbooks/engine/src/continuous-close/continuous-close.ts'
import { detectorSpecsForAgent } from '@openbooks/engine/src/agents/continuous-close-config.ts'
import {
  field,
  grid,
  heading,
  page,
  ref,
  repeat,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../../lib/authz'
import { agentPackMetas, getAgentsOverview } from '../../../../../../lib/setup/agents'
import type { AgentsPackCard, AgentsPackCardDetector } from './AgentsPackCard'

/**
 * Agents library — the catalog of packs the engine registry ships: what each
 * reads, what it proposes, what it needs (feature + permissions), and its
 * detector list, with install/enable from here. Split into a loader and a spec.
 *
 * The grid follows the /apps/library marketplace precedent: `repeat` over an
 * `agents-pack-card` widget whose footer couples the pack key with the small
 * install island (or the configure link once installed). THE LOADER COMPUTES:
 * pack names, reads/proposes, every detector title/description and all labels
 * resolve here via `getTranslations`, so the spec binds and never formats.
 *
 * The install flow round-trips the FULL default policy (the overview toggle
 * precedent): enabling is one PUT of the policy the engine would default to,
 * so install and configure share the same command and audit shape.
 *
 * Loader work: the `admin.setup.manage` gate, one `getAgentsOverview` call
 * for install state, and the pure `agentPackMetas()` join for detectors and
 * required permissions. The feature flag travels hoisted like the overview.
 */

type AgentsPackCardProps = Parameters<typeof AgentsPackCard>[0]

export interface AgentsLibraryPack {
  id: string
  agentKey: string
  name: string
  description: string
  reads: string
  proposes: string
  installed: boolean
  installedLabel: string
  installLabel: string
  installPolicy: AgentsPackCardProps['installPolicy']
  featureEnabled: boolean
  permissions: string[]
  needsLabel: string
  moduleLine: string
  readsLabel: string
  proposesLabel: string
  checksTitle: string
  checksNote: string
  detectors: AgentsPackCardDetector[]
  configureHref: string
  configureLabel: string
}

export interface AgentsLibraryData {
  title: string
  description: string
  docHref: string
  learnMore: string
  backHref: string
  backLabel: string
  packs: AgentsLibraryPack[]
}

export async function loadAgentsLibrary(): Promise<AgentsLibraryData> {
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin')
  const [rows, metas] = await Promise.all([getAgentsOverview(authz.user.orgId), agentPackMetas()])
  const enabledByKey = new Map(rows.map((row) => [row.agentKey, row.policy]))
  const featureEnabled = rows[0]?.featureEnabled ?? false
  // Install and configure share one command: an unconfigured pack installs by
  // PUTing the engine default policy with enabled flipped on.
  const packs = metas.map((meta) => {
    const stored = enabledByKey.get(meta.agentKey)
    const policy = stored ?? defaultContinuousClosePolicy(meta.agentKey)
    const installed = stored?.enabled ?? false
    const activeDetectors = policy.detectors.filter((detector) => detector.enabled).length
    const detectors = detectorSpecsForAgent(meta.agentKey).map((spec) => ({
      detectorKey: spec.detectorKey,
      title: t(`ai.agents.detectors.${spec.detectorKey}.title`),
      description: t(`ai.agents.detectors.${spec.detectorKey}.description`),
    }))
    return {
      id: meta.agentKey,
      agentKey: meta.agentKey,
      name: t(`setup.agents.packs.${meta.agentKey}.title`),
      description: t(`setup.agents.packs.${meta.agentKey}.description`),
      reads: t(`setup.agents.packs.${meta.agentKey}.reads`),
      proposes: t(`setup.agents.packs.${meta.agentKey}.proposes`),
      installed,
      installedLabel: t('setup.agents.library.installed'),
      installLabel: t('setup.agents.library.install'),
      installPolicy: policy as unknown as Record<string, unknown>,
      featureEnabled,
      permissions: [...meta.readPermissions],
      needsLabel: t('setup.agents.library.needsLabel'),
      moduleLine: t('setup.agents.library.moduleRequires', {
        feature: t('features.continuousClose.title'),
      }),
      readsLabel: t('setup.agents.library.readsLabel'),
      proposesLabel: t('setup.agents.library.proposesLabel'),
      checksTitle: t('setup.agents.library.checksTitle', { count: detectors.length }),
      checksNote: t('setup.agents.library.checksNote', {
        count: activeDetectors,
        total: policy.detectors.length,
      }),
      detectors,
      configureHref: `/admin/setup/agents/${meta.agentKey}`,
      configureLabel: t('setup.agents.library.configure'),
    }
  })
  return {
    title: t('setup.agents.library.title'),
    description: t('setup.agents.library.description'),
    docHref: '/docs/setup-agents-group',
    learnMore: t('setup.agents.overview.guideLink'),
    backHref: '/admin/setup/agents',
    backLabel: t('setup.agents.nav.overview'),
    packs,
  }
}

const f = ref<AgentsLibraryData>()
const item = field

export function agentsLibrarySpec(data: AgentsLibraryData): PageSpec {
  return page({
    route: '/admin/setup/agents/library',
    // Same shell rule as the overview: the setup workspace owns the chrome.
    layout: 'bare',
    header: [],
    body: [
      grid('space-y-4', [
        grid('flex items-start justify-between gap-3', [
          grid('min-w-0', [
            heading(2, f('title'), 'text-lg font-semibold text-slate-900 dark:text-slate-100'),
            widgetBlock('setup-description', {
              description: f('description'),
              docHref: data.docHref,
              learnMore: data.learnMore,
            }),
          ]),
          grid('flex shrink-0 items-center gap-2', [
            widgetBlock('link-button', {
              href: data.backHref,
              label: data.backLabel,
              variant: 'outline',
              size: 'sm',
            }),
          ]),
        ]),
        repeat({
          items: f('packs'),
          itemKey: item('id'),
          className: 'grid grid-cols-1 gap-3 sm:grid-cols-2',
          unwrapped: true,
          blocks: [
            widgetBlock('agents-pack-card', {
              agentKey: item('agentKey'),
              name: item('name'),
              description: item('description'),
              reads: item('reads'),
              proposes: item('proposes'),
              installed: item('installed'),
              installedLabel: item('installedLabel'),
              installLabel: item('installLabel'),
              installPolicy: item('installPolicy'),
              featureEnabled: item('featureEnabled'),
              permissions: item('permissions'),
              needsLabel: item('needsLabel'),
              moduleLine: item('moduleLine'),
              readsLabel: item('readsLabel'),
              proposesLabel: item('proposesLabel'),
              checksTitle: item('checksTitle'),
              checksNote: item('checksNote'),
              detectors: item('detectors'),
              configureHref: item('configureHref'),
              configureLabel: item('configureLabel'),
            }),
          ],
        }),
      ]),
    ],
  })
}
