import 'server-only'
import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import type { PageLayoutPrefs } from '@openbooks/schema'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { requirePermission } from '../../../lib/authz'
import { ANALYTICS_DASHBOARDS, ANALYTICS_GROUPS } from '../../../lib/analytics/dashboard-catalog'
import { analyticsDashboardAvailable } from '../../../lib/analytics/dashboard-access'
import type { AnalyticsGroup } from './AnalyticsHub'

export interface AnalyticsData { title: string; description: string; groups: AnalyticsGroup[]; initialLayout: PageLayoutPrefs }

export async function loadAnalytics(): Promise<AnalyticsData> {
  const authz = await requirePermission('reports.read')
  const [t, prefs] = await Promise.all([
    getTranslations('analytics.hub'),
    db.execute<{ layout: PageLayoutPrefs }>(sql`select layout from user_page_layouts where org_id = ${authz.user.orgId} and user_id = ${authz.user.id} and page = 'analytics' limit 1`),
  ])
  const available = await Promise.all(ANALYTICS_DASHBOARDS.map(async (dashboard) => await analyticsDashboardAvailable(authz, dashboard) ? dashboard : null))
  const groups: AnalyticsGroup[] = ANALYTICS_GROUPS.map((group) => ({ key: group, label: t(`sections.${group}`), cards: available.filter((dashboard) => dashboard?.group === group).map((dashboard) => {
    const feature = dashboard!.feature
    const pack = dashboard!.industries.length ? dashboard!.industries.map((industry) => t(`packs.${industry}`)).join(' · ') : t('base')
    return { slug: dashboard!.slug, href: `/analytics/${dashboard!.slug}`, title: t(`cards.${dashboard!.titleKey}Title`), desc: t(`cards.${dashboard!.titleKey}Desc`), icon: dashboard!.icon, pack: feature ? `${pack} · ${t(`capabilities.${feature}`)}` : pack, featureLabel: feature }
  }) }))
  return { title: t('title'), description: t('description'), groups, initialLayout: prefs.rows[0]?.layout ?? {} }
}

export function analyticsSpec(data: AnalyticsData): PageSpec {
  return page({ route: '/analytics', layout: 'bare', header: [], body: [frame('page-container', [widgetBlock('analytics-hub', { title: data.title, description: data.description, groups: data.groups, initialLayout: data.initialLayout })])] })
}
