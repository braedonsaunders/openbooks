import 'server-only'

import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { getAuthz, assertCan } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../lib/features'
import { SETUP_ENTITY_BY_KEY } from '../../../../lib/setup/registry'
import { groupTabs } from '../../../../components/module-home/group-tabs'

/**
 * Nonprofit setup — the re-homed restriction framework, interfund pairs, and
 * functional mappings. The inventory stock-location precedent: each section
 * is the shared registry-backed surface mounted under the module's base
 * path with its own namespaced drawer key, never a second settings store.
 * Framework and pair writes are commands (setFramework, setFundPair) and
 * mappings use the landed mapping command — a generic setup write must never
 * bypass the domain refusal, so every section here resolves through the
 * command route.
 */

export interface NonprofitSetupData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof groupTabs>>
  showFramework: boolean
  showPairs: boolean
  showMappings: boolean
  frameworkHint: string
  pairsHint: string
  mappingsHint: string
}

export async function loadNonprofitSetup(): Promise<NonprofitSetupData> {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'nonprofit')
  // Reading setup requires funds.read unconditionally: admin.setup.manage
  // never substitutes, and every reader sees every section whose governing
  // feature is on. Mutations stay behind funds.manage, derived from each
  // descriptor's command marker by the shared command route.
  assertCan(authz, 'funds.read')
  const t = await getTranslations('nonprofit')
  const tabs = await groupTabs('nonprofit', '/nonprofit/setup', { orgId })

  // Registry lookups happen in the loader: a section renders only when its
  // entry is registered and its governing feature is on, otherwise the spec
  // falls back to the sibling sections exactly as the native setup rail does.
  const [frameworkOn, pairsOn, mappingsOn] = await Promise.all([
    isFeatureEnabled(orgId, 'fundAccounting'),
    isFeatureEnabled(orgId, 'fundAccounting'),
    isFeatureEnabled(orgId, 'functionalExpenses'),
  ])
  const showFramework = frameworkOn && SETUP_ENTITY_BY_KEY.get('nonprofit-frameworks') !== undefined
  const showPairs = pairsOn && SETUP_ENTITY_BY_KEY.get('fund-pairs') !== undefined
  const showMappings = mappingsOn && SETUP_ENTITY_BY_KEY.get('functional-mappings') !== undefined

  return {
    title: t('setup.title'),
    description: `${t('setup.description')} ${t('setup.grantsHint')}`,
    tabs,
    showFramework,
    showPairs,
    showMappings,
    frameworkHint: t('setup.frameworkHint'),
    pairsHint: t('setup.pairsHint'),
    mappingsHint: t('setup.mappingsHint'),
  }
}

const f = ref<NonprofitSetupData>()

export function nonprofitSetupSpec(data: NonprofitSetupData): PageSpec {
  return page({
    route: '/nonprofit/setup',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      {
        ...widgetBlock('setup-section', {
          entityKey: 'nonprofit-frameworks',
          basePath: '/nonprofit/setup',
          sp: { section: 'framework' },
          rowParam: 'frow',
        }),
        when: f('showFramework'),
      },
      {
        ...widgetBlock('setup-section', {
          entityKey: 'fund-pairs',
          basePath: '/nonprofit/setup',
          sp: { section: 'pairs' },
          rowParam: 'prow',
        }),
        when: f('showPairs'),
      },
      {
        ...widgetBlock('setup-section', {
          entityKey: 'functional-mappings',
          basePath: '/nonprofit/setup',
          sp: { section: 'mappings' },
          rowParam: 'mrow',
        }),
        when: f('showMappings'),
      },
    ],
  })
}
