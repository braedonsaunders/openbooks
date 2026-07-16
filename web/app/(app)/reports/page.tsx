import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { PageContainer } from '../../../components/page-layout'
import { getAuthz, can } from '../../../lib/authz'
import { ReportsHub, type HubGroup } from './ReportsHub'

export const dynamic = 'force-dynamic'

export default async function Reports() {
  const t = await getTranslations('reports')
  const authz = await getAuthz()
  const canCreate = !!authz && (can(authz, 'reports.create') || can(authz, '*'))

  const [saved, custom] = await Promise.all([
    db.execute(sql`select id, name, path, params from saved_reports order by created_at desc limit 12`) as Promise<{
      rows: { id: string; name: string; path: string; params: Record<string, string> }[]
    }>,
    db.execute(
      sql`select id, name, kind from report_definitions where coalesce(report_type, 'query') = 'query' order by updated_at desc limit 12`,
    ) as Promise<{
      rows: { id: string; name: string; kind: string }[]
    }>,
  ])

  const card = (key: string, href: string, icon: string) => ({
    href,
    title: t(`hub.cards.${key}Title`),
    desc: t(`hub.cards.${key}Description`),
    icon,
  })

  // AR/AP aging split into four distinct reports (side × summary/detail).
  const agingCard = (side: 'ar' | 'ap', view: 'summary' | 'detail') => ({
    href: `/reports/aging?side=${side}${view === 'detail' ? '&view=detail' : ''}`,
    title: `${side === 'ap' ? t('aging.payablesTitle') : t('aging.receivablesTitle')} · ${view === 'detail' ? t('aging.detail') : t('aging.summary')}`,
    desc: t('hub.cards.agingDescription'),
    icon: 'CalendarClock',
  })

  const groups: HubGroup[] = [
    {
      key: 'financial',
      label: t('hub.groups.financial'),
      accent: 'teal',
      cards: [
        card('pnl', '/reports/pnl', 'FileText'),
        card('balanceSheet', '/reports/balance-sheet', 'Scale'),
        card('cashFlow', '/reports/cash-flow', 'Waves'),
        card('trialBalance', '/reports/trial-balance', 'ClipboardList'),
      ],
    },
    {
      key: 'ledger',
      label: t('hub.groups.ledger'),
      accent: 'sky',
      cards: [card('generalLedger', '/reports/general-ledger', 'BookOpen'), card('journal', '/reports/journal', 'NotebookPen')],
    },
    {
      key: 'receivablesPayables',
      label: t('hub.groups.receivablesPayables'),
      accent: 'violet',
      cards: [
        agingCard('ar', 'summary'),
        agingCard('ar', 'detail'),
        agingCard('ap', 'summary'),
        agingCard('ap', 'detail'),
        card('registers', '/reports/registers?side=ar', 'Receipt'),
        card('receivables', '/reports/partners?kind=receivable', 'Wallet'),
        card('payables', '/reports/partners?kind=payable', 'Landmark'),
      ],
    },
    {
      key: 'orders',
      label: t('hub.groups.orders'),
      accent: 'teal',
      cards: [card('orders', '/reports/orders', 'ClipboardList')],
    },
    {
      key: 'budgeting',
      label: t('hub.groups.budgeting'),
      accent: 'amber',
      cards: [card('budget', '/reports/budget', 'Target')],
    },
    {
      key: 'projects',
      label: t('hub.groups.projects'),
      accent: 'sky',
      cards: [card('projectProfitability', '/reports/project-profitability', 'Coins')],
    },
    {
      key: 'custom',
      label: t('hub.groups.custom'),
      accent: 'slate',
      cards: [
        { href: '/reports/custom', title: t('hub.customStudio.title'), desc: t('hub.customStudio.description'), icon: 'Sparkles' },
        ...custom.rows.map((c) => ({
          href: `/reports/custom/run/${c.id}`,
          title: c.name,
          desc: c.kind === 'built_in' ? t('custom.kind.builtIn') : t('custom.kind.custom'),
          icon: 'Coins',
        })),
        ...saved.rows.map((s) => {
          const qs = new URLSearchParams(s.params ?? {}).toString()
          return { href: `${s.path}${qs ? `?${qs}` : ''}`, title: s.name, desc: t('hub.savedViews'), icon: 'Bookmark' }
        }),
      ],
    },
  ]

  return (
    <PageContainer>
      <ReportsHub title={t('hub.title')} description={t('hub.description')} groups={groups} canCreate={canCreate} />
    </PageContainer>
  )
}
