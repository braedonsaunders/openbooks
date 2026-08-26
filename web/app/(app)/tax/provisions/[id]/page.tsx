import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { Badge, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../../components/page-layout'
import { requirePermission, can } from '../../../../../lib/authz'
import { getMoneyFormatter } from '@/lib/money-server'
import { orgInfo } from '../../../../../lib/data'
import { getProvisionRun } from '@openbooks/engine/src/income-tax-provision.ts'
import { ProvisionPostButton } from './ProvisionPostButton'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  draft: 'secondary',
  posted: 'success',
  superseded: 'outline',
}

export default async function TaxProvisionDetail({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('reports.read')
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('tax.provisions')
  const org = await orgInfo()
  const { id } = await params
  const run = await getProvisionRun(authz.user.orgId, id)
  if (!run) notFound()
  const m = (v: string) => money(v, { currency: org?.base_currency })
  const payload = run.payload as {
    framework?: 'asc740' | 'ias12'
    pretaxBookIncome: string
    enactedRatePercent: string
    taxableIncome: string
    currentTax: string
    deferredExpense: string
    totalExpense: string
    balances: { dtaGross: string; dtlGross: string; valuationAllowance: string }
    rateReconciliation: { key: string; label: string; amount: string; percent: string | null }[]
  }
  const framework = payload.framework ?? 'asc740'
  const recon = payload.rateReconciliation ?? []
  const canPost = can(authz, 'reports.create') && run.status === 'draft'

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('detail.title', { year: run.fiscalYear, version: run.version })}
          back={{ href: '/tax/provisions', label: t('title') }}
          actions={
            <div className="flex items-center gap-2">
              <Badge variant="outline">{framework === 'ias12' ? 'IAS 12' : 'ASC 740'}</Badge>
              <Badge variant={STATUS_VARIANT[run.status] ?? 'secondary'}>{t(`status.${run.status}`)}</Badge>
              {canPost ? <ProvisionPostButton runId={run.id} /> : null}
            </div>
          }
        />
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Rate reconciliation — the ASC 740 headline disclosure */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">{t('detail.reconciliation')}</h2>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                <th className="py-1" />
                <th className="py-1 text-right">{t('detail.amount')}</th>
                <th className="py-1 text-right">{t('detail.percent')}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="text-slate-500 dark:text-slate-400">
                <td className="py-1.5">{t('detail.pretax')}</td>
                <td className="py-1.5 text-right tabular-nums">{m(payload.pretaxBookIncome)}</td>
                <td className="py-1.5 text-right tabular-nums text-slate-400">{payload.enactedRatePercent}%</td>
              </tr>
              {recon.map((step) => (
                <tr
                  key={step.key}
                  className={step.key === 'total' ? 'border-t border-slate-200 font-semibold dark:border-slate-700' : ''}
                >
                  <td className="py-1.5">{step.key === 'total' ? t('detail.total') : step.label}</td>
                  <td className="py-1.5 text-right tabular-nums">{m(step.amount)}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-400">
                    {step.percent != null ? `${step.percent}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
            <dt className="text-slate-500">{t('detail.taxableIncome')}</dt>
            <dd className="text-right tabular-nums">{m(payload.taxableIncome)}</dd>
            <dt className="text-slate-500">{t('detail.currentTax')}</dt>
            <dd className="text-right tabular-nums">{m(payload.currentTax)}</dd>
            <dt className="text-slate-500">{t('detail.deferredExpense')}</dt>
            <dd className="text-right tabular-nums">{m(payload.deferredExpense)}</dd>
            <dt className="text-slate-500">{t('detail.balances.dta')}</dt>
            <dd className="text-right tabular-nums">{m(payload.balances.dtaGross)}</dd>
            <dt className="text-slate-500">{t('detail.balances.dtl')}</dt>
            <dd className="text-right tabular-nums">{m(payload.balances.dtlGross)}</dd>
            <dt className="text-slate-500">{framework === 'ias12' ? t('detail.balances.vaIas12') : t('detail.balances.va')}</dt>
            <dd className="text-right tabular-nums">{m(payload.balances.valuationAllowance)}</dd>
          </dl>
        </section>

        {/* Measured temporary differences */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">{t('detail.differences')}</h2>
          {run.differences.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400 italic">{t('detail.noDifferences')}</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                  <th className="py-1">{t('detail.columns.item')}</th>
                  <th className="py-1 text-right">{t('detail.columns.bookBasis')}</th>
                  <th className="py-1 text-right">{t('detail.columns.taxBasis')}</th>
                  <th className="py-1 text-right">{t('detail.columns.difference')}</th>
                  <th className="py-1 text-right">{t('detail.columns.effect')}</th>
                </tr>
              </thead>
              <tbody>
                {run.differences.map((d) => (
                  <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5">
                      <span className="block">{d.description}</span>
                      <span className="text-xs text-slate-400">
                        {t(`categories.${d.category}`)} · {d.source === 'auto' ? t('detail.auto') : t('detail.manual')}
                      </span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{m(d.bookBasis)}</td>
                    <td className="py-1.5 text-right tabular-nums">{m(d.taxBasis)}</td>
                    <td className="py-1.5 text-right tabular-nums">{m(d.difference)}</td>
                    <td className="py-1.5 text-right tabular-nums">{m(d.taxEffect)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </ListPageLayout>
  )
}
