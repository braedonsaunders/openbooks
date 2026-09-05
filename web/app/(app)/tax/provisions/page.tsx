import { getTranslations } from 'next-intl/server'
import { PageHeader, Badge } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission, can } from '../../../../lib/authz'
import { getMoneyFormatter } from '@/lib/money-server'
import { orgInfo } from '../../../../lib/data'
import { listProvisionRuns } from '@openbooks/engine/src/income-tax-provision.ts'
import { ProvisionComputeButton } from './ProvisionComputeButton'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  draft: 'secondary',
  posted: 'success',
  superseded: 'outline',
}

export default async function TaxProvisions() {
  const authz = await requirePermission('reports.read')
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('tax.provisions')
  const org = await orgInfo()
  const runs = await listProvisionRuns(authz.user.orgId, authz.allowedSubsidiaryIds)
  const m = (v: string) => money(v, { currency: org?.base_currency })

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={authz.allowedSubsidiaryIds === null && can(authz, 'reports.create') ? <ProvisionComputeButton /> : undefined}
        />
      }
    >
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <th className="px-4 py-2 font-medium">{t('columns.fiscalYear')}</th>
              <th className="px-4 py-2 font-medium">{t('columns.version')}</th>
              <th className="px-4 py-2 font-medium">{t('columns.status')}</th>
              <th className="px-4 py-2 font-medium text-right">{t('columns.totalExpense')}</th>
              <th className="px-4 py-2 font-medium text-right">{t('columns.effectiveRate')}</th>
              <th className="px-4 py-2 font-medium">{t('columns.created')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-400 italic">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              runs.map((run) => (
                <tr key={run.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-2.5">
                    <a className="font-medium text-teal-700 hover:underline dark:text-teal-300" href={`/tax/provisions/${run.id}`}>
                      FY{run.fiscalYear}
                    </a>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">v{run.version}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={STATUS_VARIANT[run.status] ?? 'secondary'}>{t(`status.${run.status}`)}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{m(run.totalExpense)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {run.effectiveRatePercent != null ? `${run.effectiveRatePercent}%` : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">
                    {String(run.createdAt).slice(0, 10)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </ListPageLayout>
  )
}
