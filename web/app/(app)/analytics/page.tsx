import { getTranslations } from 'next-intl/server'
import { PageContainer } from '../../../components/page-layout'
import { requirePermission } from '../../../lib/authz'
import { AnalyticsHub, type AnalyticsGroup } from './AnalyticsHub'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.hub')
  return { title: t('title') }
}

export default async function AnalyticsPage() {
  const t = await getTranslations('analytics.hub')
  await requirePermission('reports.read')

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
        card('trueCost', '/analytics/true-cost', 'Coins'),
      ],
    },
    {
      key: 'operations',
      label: t('groups.operations'),
      accent: 'sky',
      cards: [
        card('cashflow', '/analytics/cashflow', 'Wallet'),
        card('utilization', '/analytics/utilization', 'Clock'),
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
