import { getTranslations } from 'next-intl/server'
import { PageContainer } from '../../../components/page-layout'
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { AnalyticsHub, type AnalyticsGroup } from './AnalyticsHub'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.hub')
  return { title: t('title') }
}

export default async function AnalyticsPage() {
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

  return (
    <PageContainer>
      <AnalyticsHub title={t('title')} description={t('description')} groups={groups} />
    </PageContainer>
  )
}
