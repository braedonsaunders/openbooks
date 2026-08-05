import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { payrollRemittanceSummary } from '@openbooks/engine/src/payroll-remittance.ts'
import { ListPageLayout } from '../../../../components/page-layout'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { RemittancesView } from './RemittancesView'

export const dynamic = 'force-dynamic'

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Default period: the previous calendar month (the PD7A rhythm). */
function previousMonth(): { from: string; to: string } {
  const now = new Date()
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) }
}

export default async function PayrollRemittancesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('payroll.read')
  await requireFeatureEnabled(authz.user.orgId, 'payroll')
  const t = await getTranslations('payroll.remittances')
  const sp = await searchParams
  const defaults = previousMonth()
  const from = DATE.test(pickString(sp.from) ?? '') ? (pickString(sp.from) as string) : defaults.from
  const to = DATE.test(pickString(sp.to) ?? '') ? (pickString(sp.to) as string) : defaults.to

  const groups = await payrollRemittanceSummary(authz.user.orgId, { from, to })

  const moduleTabs = await groupTabs('payroll', '/payroll/remittances')

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={<ModuleHomeTabs tabs={moduleTabs} />}
        />
      }
    >
      <RemittancesView
        groups={groups}
        from={from}
        to={to}
        canCreate={can(authz, 'payroll.run')}
      />
      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
        {t('apNote')} <Link className="underline" href={'/ap/bills' as never}>{t('apLink')}</Link>
      </p>
    </ListPageLayout>
  )
}
