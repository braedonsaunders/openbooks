import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import type { AnalyticsGroup } from './AnalyticsHub'

/**
 * The analytics hub, split into a loader and a spec.
 *
 * This page is a static launcher: no queries, no params, no pagination. The
 * only server work is the `reports.read` gate plus the projects/timeTracking
 * feature flags that add or remove two cards. Everything else is markup owned
 * by `AnalyticsHub` — a client component (live search filter, icon map,
 * accent map) that stays whole behind one widget, exactly as the cockpit
 * pages keep their bespoke panel bodies whole. Decomposing a search box and
 * an icon map into generic blocks would reimplement the component badly
 * rather than compose it.
 *
 * The loader resolves the card titles and descriptions through next-intl, so
 * the widget receives presentation-ready strings; the hub keeps its own
 * search-placeholder / no-matches / planned copy via `useTranslations`,
 * exactly as it does natively.
 */

export interface AnalyticsData {
  title: string
  description: string
  groups: AnalyticsGroup[]
}

export async function loadAnalytics(): Promise<AnalyticsData> {
  const t = await getTranslations('analytics.hub')
  const authz = await requirePermission('reports.read')
  const [projectsOn, timeOn] = await Promise.all([
    isFeatureEnabled(authz.user.orgId, 'projects'),
    isFeatureEnabled(authz.user.orgId, 'timeTracking'),
  ])

  const card = (key: string, href: string, icon: string, planned?: boolean): AnalyticsGroup['cards'][number] => ({
    href,
    title: t(`cards.${key}Title`),
    desc: t(`cards.${key}Desc`),
    icon,
    planned,
  })

  const groups: AnalyticsGroup[] = [
    {
      key: 'profitability',
      label: t('groups.profitability'),
      accent: 'teal',
      cards: [
        card('financialHealth', '/analytics/financial-health', 'Activity'),
        ...(projectsOn ? [card('trueCost', '/analytics/true-cost', 'Coins')] : []),
      ],
    },
    {
      key: 'operations',
      label: t('groups.operations'),
      accent: 'sky',
      cards: [
        card('cashflow', '/analytics/cashflow', 'Wallet'),
        ...(timeOn ? [card('utilization', '/analytics/utilization', 'Clock')] : []),
      ],
    },
    {
      key: 'relationships',
      label: t('groups.relationships'),
      accent: 'violet',
      cards: [
        card('customer', '/analytics/customer-intelligence', 'Users'),
        card('vendor', '/analytics/vendor-performance', 'Truck'),
      ],
    },
    {
      key: 'forensics',
      label: t('groups.forensics'),
      accent: 'amber',
      cards: [
        card('sentinel', '/analytics/sentinel', 'ShieldAlert'),
        card('spendVelocity', '/analytics/spend-velocity', 'Zap'),
      ],
    },
  ]

  return {
    title: t('title'),
    description: t('description'),
    groups,
  }
}

export function analyticsSpec(data: AnalyticsData): PageSpec {
  return page({
    route: '/analytics',
    // The hub owns its own shell (PageContainer) the way the setup workspace
    // owns its — ListPageLayout's sticky-header chrome would nest a second
    // shell around it, so header and body concatenate and the frame renders
    // the exact native shell.
    layout: 'bare',
    header: [],
    body: [
      frame('page-container', [
        widgetBlock('analytics-hub', {
          title: data.title,
          description: data.description,
          groups: data.groups,
        }),
      ]),
    ],
  })
}
