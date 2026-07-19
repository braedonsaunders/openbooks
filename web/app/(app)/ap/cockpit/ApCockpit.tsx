'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  Wallet,
  TriangleAlert,
  CalendarClock,
  Clock,
  Timer,
  ListOrdered,
  CalendarRange,
  Building2,
  ListChecks,
} from 'lucide-react'
import { money, moneyCompact } from '../../../../lib/format'
import type { ApPosition } from '../../../../lib/cash/ap-position'
import { StatTile, CockpitPanel, AgingBars, ScheduleBars } from '../../../../components/cockpit/ui'
import { PayRunPlanner } from './PayRunPlanner'

/**
 * Accounts-Payable control center. Vitals across the top, the pay-run planner
 * as the marquee (capacity-scheduled recommendation → /payments run builder),
 * aging + cash-out schedule beside it, and the vendor breakdown below. All off
 * the shared cash engine, so every number agrees with the analytics forecast.
 */
export function ApCockpit({ data }: { data: ApPosition }) {
  const t = useTranslations('ap.cockpit')

  const overduePct = data.outstanding > 0 ? Math.round((data.overdue / data.outstanding) * 100) : 0

  return (
    <div className="space-y-5">
      {/* Vitals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile icon={Wallet} accent="indigo" label={t('stats.openPayables')} value={moneyCompact(data.outstanding)} />
        <StatTile
          icon={TriangleAlert}
          accent="red"
          label={t('stats.overdue')}
          value={moneyCompact(data.overdue)}
          sub={t('stats.overdueSub', { count: data.overdueCount, pct: overduePct })}
          tone={data.overdue > 0 ? 'negative' : 'neutral'}
        />
        <StatTile icon={CalendarClock} accent="amber" label={t('stats.dueThisWeek')} value={moneyCompact(data.dueThisWeek)} tone="warning" />
        <StatTile icon={CalendarRange} accent="sky" label={t('stats.next30')} value={moneyCompact(data.dueNext30)} />
        <StatTile icon={Timer} accent="violet" label={t('stats.dpo')} value={t('stats.days', { n: data.dpo })} sub={t('stats.dpoSub')} />
      </div>

      {/* Pay-run planner + aging */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <CockpitPanel
          title={t('panels.payRun')}
          icon={ListChecks}
          hint={data.payPlan.scheduling ? t('panels.payRunHintScheduled') : t('panels.payRunHint')}
          bodyClassName="p-0"
          className="lg:col-span-2"
        >
          <PayRunPlanner
            recommended={data.payPlan.recommended.map((e) => ({
              id: e.id,
              docId: e.docId,
              docKind: e.docKind,
              partyName: e.partyName,
              amount: e.amount,
              dueDate: e.dueDate,
              daysOverdue: e.daysOverdue,
              method: e.method,
            }))}
            capacity={data.payPlan.capacity}
            startingCash={data.payPlan.startingCash}
            weeklyCap={data.payPlan.weeklyCap}
            restrictToSafe={data.payPlan.restrictToSafe}
            scheduling={data.payPlan.scheduling}
            deferredThisWeek={data.payPlan.deferredThisWeek}
            deferredBeyondHorizon={data.payPlan.deferredBeyondHorizon}
          />
        </CockpitPanel>

        <CockpitPanel
          title={t('panels.aging')}
          icon={ListOrdered}
          hint={`${moneyCompact(data.outstanding)} · ${data.summary.pctCurrent.toFixed(0)}% ${t('current')}`}
        >
          <AgingBars buckets={data.summary.buckets} accent="text-red-600 dark:text-red-400" />
        </CockpitPanel>
      </div>

      {/* Schedule + vendors */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <CockpitPanel title={t('panels.schedule')} icon={CalendarRange} hint={t('panels.scheduleHint', { weeks: data.horizonWeeks })}>
          <ScheduleBars weeks={data.weeks.map((w) => ({ label: w.label.split(' – ')[0]!, amount: w.amount }))} barClass="bg-red-400 dark:bg-red-500" />
        </CockpitPanel>

        <CockpitPanel title={t('panels.byVendor')} icon={Building2} bodyClassName="p-0">
          {data.byVendor.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{t('noPayables')}</p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">{t('vendor')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('overdueCol')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('openCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byVendor.slice(0, 12).map((v) => (
                    <tr key={v.partyId ?? v.partyName} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{v.partyName}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {v.overdue > 0 ? <span className="text-red-600 dark:text-red-400">{moneyCompact(v.overdue)}</span> : <span className="text-slate-300 dark:text-slate-600">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(v.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CockpitPanel>
      </div>

      {/* deferral note */}
      {data.payPlan.deferredBeyondHorizon > 0 ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <Clock size={14} className="mt-0.5 shrink-0" />
          <span>{t('deferralNote', { amount: money(data.payPlan.deferredBeyondHorizon) })}</span>
        </p>
      ) : null}

      <p className="text-center text-xs text-slate-400 dark:text-slate-500">
        {t('forecastLink.pre')}{' '}
        <Link href="/analytics/cashflow" className="text-teal-600 hover:underline dark:text-teal-400">{t('forecastLink.link')}</Link>
      </p>
    </div>
  )
}
