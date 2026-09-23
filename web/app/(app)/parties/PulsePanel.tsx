'use client'

import {
  Building,
  Clock,
  FileText,
  Mail,
  Phone,
  Receipt,
  TrendingUp,
  Briefcase,
  ShieldAlert,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  Badge,
  Card,
  cn,
} from '@openbooks/ui'
import { useMoney } from '@/components/money-provider'
import type { CustomerPulseData } from '../../../lib/customer-pulse'

/**
 * Pulse — the live state of one commercial relationship on its own record.
 *
 * Everything here is READ-ONLY and computed by lib/customer-pulse from the
 * canonical subsystems (open-items for aging, cash/core for DSO, the project
 * financial reader for delivery), so no figure on this panel is a second
 * opinion about a number the rest of the product already owns.
 *
 * Money runs through the org/record money formatter, never a hardcoded
 * locale: the same amount must read identically here and on the invoice it
 * came from.
 */
/**
 * Placeholder for a pulse section the caller's permissions omit. The section
 * is absent from the payload (never nulled with data-shaped defaults), so the
 * panel names the missing access instead of rendering zeros.
 */
function RestrictedCard({ title, className }: { title: string; className?: string }) {
  const t = useTranslations('crm.pulse')
  return (
    <Card className={className ?? 'p-4'}>
      <div className="text-xs font-medium text-slate-500">{title}</div>
      <div className="mt-1 flex items-center gap-1.5 text-sm text-slate-400">
        <ShieldAlert className="h-4 w-4 shrink-0" />
        {t('restrictedNotice')}
      </div>
    </Card>
  )
}

export function PulsePanel({ data }: { data: CustomerPulseData }) {
  const { party, sections, aging, credit, paymentMetrics, pipeline, projects, timeline } = data
  const t = useTranslations('crm.pulse')
  const tc = useTranslations('common')
  const { money } = useMoney(party.currency)
  // An empty timeline means "nothing recorded" only when the caller may see
  // at least one timeline-carrying section; otherwise entries were withheld
  // for access and the panel must say so instead of reporting no activity.
  const timelineWithheld = timeline.length === 0 && !sections.ar && !sections.crm
  // Document statuses have their own catalog; anything it does not name keeps
  // the stored value rather than rendering a raw message key.
  const statusLabel = (value: string) =>
    tc.has(`status.${value}` as never) ? tc(`status.${value}` as never) : value.replace(/_/g, ' ')

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {party.displayName}
            </h2>
            {party.isOnHold && (
              <Badge variant="destructive" className="flex items-center gap-1">
                <ShieldAlert className="h-3.5 w-3.5" />
                {t('creditHold')}
              </Badge>
            )}
            <Badge variant="outline">{party.currency}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            {party.email && (
              <span className="flex items-center gap-1">
                <Mail className="h-3.5 w-3.5 text-slate-400" />
                {party.email}
              </span>
            )}
            {party.phone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3.5 w-3.5 text-slate-400" />
                {party.phone}
              </span>
            )}
            {party.paymentTermsName && (
              <span className="flex items-center gap-1 font-medium text-slate-700 dark:text-slate-300">
                <Clock className="h-3.5 w-3.5 text-slate-400" />
                {t('terms', { terms: party.paymentTermsName })}
              </span>
            )}
            {party.subsidiaryName && (
              <span className="flex items-center gap-1">
                <Building className="h-3.5 w-3.5 text-slate-400" />
                {party.subsidiaryName}
              </span>
            )}
          </div>
        </div>

        {party.holdReason && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
            <span className="font-semibold">{t('holdReason')}</span> {party.holdReason}
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {aging && credit && paymentMetrics ? (
          <>
        <Card className="p-4">
          <div className="text-xs font-medium text-slate-500">{t('openReceivables')}</div>
          <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
            {money(aging.totalOpen)}
          </div>
          <div className="mt-2 text-xs">
            {aging.totalOverdue > 0 ? (
              <span className="font-semibold text-rose-600 dark:text-rose-400">
                {t('overdue', { amount: money(aging.totalOverdue) })}
              </span>
            ) : (
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                {t('allCurrent')}
              </span>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-xs font-medium text-slate-500">{t('dso')}</div>
          <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
            {paymentMetrics.dso} <span className="text-sm font-normal text-slate-500">{t('days')}</span>
          </div>
          <div className="mt-2 text-xs text-slate-500">
            {paymentMetrics.partyAvgDaysToPay !== null
              ? t('customerAvg', { customer: paymentMetrics.partyAvgDaysToPay, org: paymentMetrics.orgAvgDaysToPay })
              : t('orgBenchmark', { org: paymentMetrics.orgAvgDaysToPay })}
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-xs font-medium text-slate-500">{t('creditHeadroom')}</div>
          <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
            {credit.remainingCredit !== null ? (
              money(credit.remainingCredit)
            ) : (
              <span className="font-normal text-slate-500">{t('noLimit')}</span>
            )}
          </div>
          <div className="mt-2 text-xs text-slate-500">
            {credit.creditLimit !== null
              ? t('limitUsed', {
                  limit: money(credit.creditLimit),
                  percent: Math.round(credit.creditUtilizationPercent || 0),
                })
              : t('unrestricted')}
          </div>
        </Card>
          </>
        ) : (
          <>
            <RestrictedCard title={t('openReceivables')} />
            <RestrictedCard title={t('dso')} />
            <RestrictedCard title={t('creditHeadroom')} />
          </>
        )}
        {pipeline ? (
        <Card className="p-4">
          <div className="text-xs font-medium text-slate-500">{t('pipelineValue')}</div>
          <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
            {money(pipeline.projectedPipeline)}
          </div>
          <div className="mt-2 text-xs text-slate-500">
            {pipeline.winRatePercent !== null ? (
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                {t('winRate', { percent: pipeline.winRatePercent, won: pipeline.wonOpportunities })}
              </span>
            ) : (
              t('openDeals', { count: pipeline.openOpportunities })
            )}
          </div>
        </Card>
        ) : (
          <RestrictedCard title={t('pipelineValue')} />
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {aging && credit ? (
          <>
        <Card className="p-5 lg:col-span-2">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{t('agingTitle')}</h3>
          <p className="mt-0.5 text-xs text-slate-500">{t('agingDescription')}</p>

          <div className="mt-4 grid grid-cols-5 gap-2 border-t border-slate-100 pt-3 text-center dark:border-slate-800">
            <div className="rounded-lg bg-emerald-50/60 p-2.5 dark:bg-emerald-950/20">
              <div className="text-[11px] font-medium text-slate-500">{t('bucketCurrent')}</div>
              <div className="mt-1 text-sm font-bold text-emerald-700 dark:text-emerald-300">
                {money(aging.current)}
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-900">
              <div className="text-[11px] font-medium text-slate-500">{t('bucket1To30')}</div>
              <div className="mt-1 text-sm font-bold text-slate-800 dark:text-slate-200">
                {money(aging.days1To30)}
              </div>
            </div>
            <div className="rounded-lg bg-amber-50/60 p-2.5 dark:bg-amber-950/20">
              <div className="text-[11px] font-medium text-slate-500">{t('bucket31To60')}</div>
              <div className="mt-1 text-sm font-bold text-amber-700 dark:text-amber-300">
                {money(aging.days31To60)}
              </div>
            </div>
            <div className="rounded-lg bg-orange-50/60 p-2.5 dark:bg-orange-950/20">
              <div className="text-[11px] font-medium text-slate-500">{t('bucket61To90')}</div>
              <div className="mt-1 text-sm font-bold text-orange-700 dark:text-orange-300">
                {money(aging.days61To90)}
              </div>
            </div>
            <div className="rounded-lg bg-rose-50/60 p-2.5 dark:bg-rose-950/20">
              <div className="text-[11px] font-medium text-slate-500">{t('bucket90Plus')}</div>
              <div className="mt-1 text-sm font-bold text-rose-700 dark:text-rose-300">
                {money(aging.days90Plus)}
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{t('creditTitle')}</h3>
          <p className="mt-0.5 text-xs text-slate-500">{t('creditDescription')}</p>

          <div className="mt-4 space-y-2.5 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
            <div className="flex justify-between">
              <span className="text-slate-500">{t('creditLimit')}</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {credit.creditLimit !== null ? money(credit.creditLimit) : tc('labels.none')}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">{t('openInvoices')}</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {money(credit.openArBalance)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">{t('unbilledOrders')}</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {money(credit.unbilledOrdersBalance)}
              </span>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-2 font-bold dark:border-slate-800">
              <span>{t('headroom')}</span>
              <span
                className={cn(
                  credit.remainingCredit !== null && credit.remainingCredit <= 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-emerald-600 dark:text-emerald-400',
                )}
              >
                {credit.remainingCredit !== null ? money(credit.remainingCredit) : t('uncapped')}
              </span>
            </div>
          </div>
        </Card>
          </>
        ) : (
          <>
            <RestrictedCard title={t('agingTitle')} className="p-5 lg:col-span-2" />
            <RestrictedCard title={t('creditTitle')} className="p-5" />
          </>
        )}
      </div>

      {projects ? (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{t('projectsTitle')}</h3>
            <Badge variant="outline">
              {t('projectsCount', { active: projects.activeCount, total: projects.totalCount })}
            </Badge>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4 border-t border-slate-100 pt-3 text-center dark:border-slate-800">
            <div>
              <div className="text-xs text-slate-500">{t('contractBudget')}</div>
              <div className="mt-1 text-base font-bold text-slate-900 dark:text-slate-100">
                {money(projects.totalContractValue)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">{t('billedToDate')}</div>
              <div className="mt-1 text-base font-bold text-emerald-600 dark:text-emerald-400">
                {money(projects.totalBilled)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">{t('billedProgress')}</div>
              <div className="mt-1 text-base font-bold text-slate-900 dark:text-slate-100">
                {projects.totalContractValue > 0
                  ? `${Math.round((projects.totalBilled / projects.totalContractValue) * 100)}%`
                  : '—'}
              </div>
            </div>
          </div>
        </Card>
      ) : sections.projects ? null : (
        <RestrictedCard title={t('projectsTitle')} className="p-5" />
      )}

      <Card className="p-5">
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{t('timelineTitle')}</h3>
        <p className="mt-0.5 text-xs text-slate-500">{t('timelineDescription')}</p>

        <div className="mt-4 divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
          {timeline.map((item) => {
            let icon = <FileText className="h-4 w-4 text-blue-500" />
            if (item.type === 'activity') icon = <Clock className="h-4 w-4 text-indigo-500" />
            else if (item.type === 'estimate') icon = <Briefcase className="h-4 w-4 text-amber-500" />
            else if (item.type === 'sales_order') icon = <TrendingUp className="h-4 w-4 text-cyan-500" />
            else if (item.type === 'invoice') icon = <FileText className="h-4 w-4 text-rose-500" />
            else if (item.type === 'payment') icon = <Receipt className="h-4 w-4 text-emerald-500" />

            return (
              <div key={item.id} className="flex items-start justify-between py-3 text-xs">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-full bg-slate-100 p-1.5 dark:bg-slate-800">
                    {icon}
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      {item.title}
                    </div>
                    {item.description && (
                      <p className="mt-0.5 line-clamp-1 text-slate-500">
                        {item.description}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 text-right">
                  {item.amount !== undefined && (
                    <span className="font-bold text-slate-900 dark:text-slate-100">
                      {money(item.amount, { currency: item.currency || party.currency })}
                    </span>
                  )}
                  {item.status && (
                    <Badge variant="secondary" className="text-[10px] uppercase">
                      {statusLabel(item.status)}
                    </Badge>
                  )}
                  <span className="w-20 text-slate-400">
                    {item.timestamp.slice(0, 10)}
                  </span>
                </div>
              </div>
            )
          })}

          {timeline.length === 0 && (
            <div className="py-8 text-center text-xs text-slate-400">
              {timelineWithheld ? t('restrictedNotice') : t('timelineEmpty')}
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
