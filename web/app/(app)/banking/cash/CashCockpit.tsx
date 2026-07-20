'use client'

import { useTranslations } from 'next-intl'
import {
  Landmark,
  Wallet,
  Route,
  TriangleAlert,
  ArrowLeftRight,
  CalendarRange,
  Building2,
  Clock,
} from 'lucide-react'
import { cn } from '@openbooks/ui'
import { money, moneyCompact } from '../../../../lib/format'
import type { CashPosition } from '../../../../lib/cash/cash-position'
import { StatTile, CockpitPanel } from '../../../../components/cockpit/ui'

/**
 * Cash control center — whole-company liquidity. Vitals across the top, the
 * weekly cash timeline (rolled through the shared engine, so it agrees with the
 * analytics forecast and the AP planner to the penny), and the bank-account
 * breakdown. Operational read: act on cash. Analytics/cashflow is the
 * analytical read: explain it.
 */
export function CashCockpit({ data }: { data: CashPosition }) {
  const t = useTranslations('banking.cash')

  const runway = data.runwayWeeks === null ? '∞' : t('weeks', { n: data.runwayWeeks.toFixed(1) })
  const runwayTone = data.runwayStatus === 'critical' ? 'negative' : data.runwayStatus === 'caution' ? 'warning' : 'positive'
  const lowestDate = new Date(data.lowestWeek + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

  return (
    <div className="space-y-5">
      {/* Vitals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile icon={Landmark} accent="indigo" label={t('stats.currentCash')} value={moneyCompact(data.startingCash)} tone={data.startingCash < 0 ? 'negative' : 'neutral'} />
        <StatTile
          icon={Wallet}
          accent="sky"
          label={t('stats.projectedEnd')}
          value={moneyCompact(data.projectedEnd)}
          sub={t('stats.netSub', { amount: moneyCompact(data.netChange) })}
          tone={data.netChange >= 0 ? 'positive' : 'negative'}
        />
        <StatTile icon={Route} accent="violet" label={t('stats.runway')} value={runway} sub={t(`status.${data.runwayStatus}`)} tone={runwayTone} />
        <StatTile
          icon={TriangleAlert}
          accent={data.lowestCash < 0 ? 'red' : 'amber'}
          label={t('stats.lowest')}
          value={moneyCompact(data.lowestCash)}
          sub={t('stats.lowestSub', { date: lowestDate })}
          tone={data.lowestCash < 0 ? 'negative' : 'neutral'}
        />
        <StatTile icon={ArrowLeftRight} accent={data.netChange >= 0 ? 'emerald' : 'red'} label={t('stats.netFlow')} value={moneyCompact(data.netChange)} tone={data.netChange >= 0 ? 'positive' : 'negative'} />
      </div>

      {data.lowestCash < 0 ? (
        <p className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-800 dark:bg-red-950/30 dark:text-red-300">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>{t('negativeAlert', { amount: money(data.lowestCash), date: lowestDate })}</span>
        </p>
      ) : null}

      {/* Timeline + bank accounts */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <CockpitPanel title={t('panels.timeline')} icon={CalendarRange} hint={t('panels.timelineHint', { weeks: data.horizonWeeks })} bodyClassName="p-0" className="lg:col-span-2">
          <div className="max-h-[26rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-slate-900">
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">{t('cols.week')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('cols.in')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('cols.out')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('cols.net')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('cols.ending')}</th>
                </tr>
              </thead>
              <tbody>
                {data.weeks.map((w) => (
                  <tr key={w.weekStart} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2.5 font-medium text-slate-700 dark:text-slate-200">{w.label}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{w.inflow > 0 ? moneyCompact(w.inflow) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">{w.outflow > 0 ? moneyCompact(w.outflow) : '—'}</td>
                    <td className={cn('px-3 py-2.5 text-right tabular-nums', w.net >= 0 ? 'text-slate-700 dark:text-slate-200' : 'text-red-600 dark:text-red-400')}>{moneyCompact(w.net)}</td>
                    <td className={cn('px-4 py-2.5 text-right font-bold tabular-nums', w.endingCash < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{moneyCompact(w.endingCash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CockpitPanel>

        <CockpitPanel title={t('panels.accounts')} icon={Building2} bodyClassName="p-0">
          {data.bankAccounts.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{t('noAccounts')}</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {data.bankAccounts.map((b) => (
                  <tr key={b.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">
                      {b.name}
                      {b.number ? <span className="ml-2 text-xs text-slate-400">{b.number}</span> : null}
                    </td>
                    <td className={cn('px-4 py-2.5 text-right font-medium tabular-nums', b.balance < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-200')}>{money(b.balance)}</td>
                  </tr>
                ))}
                <tr className="border-t border-slate-200 bg-slate-50/50 dark:border-slate-700 dark:bg-slate-800/30">
                  <td className="px-4 py-2.5 font-semibold text-slate-800 dark:text-slate-100">{t('totalCash')}</td>
                  <td className={cn('px-4 py-2.5 text-right font-bold tabular-nums', data.startingCash < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{money(data.startingCash)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </CockpitPanel>
      </div>

      {data.deferredBeyondHorizon > 0 ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <Clock size={14} className="mt-0.5 shrink-0" />
          <span>{t('deferralNote', { amount: money(data.deferredBeyondHorizon) })}</span>
        </p>
      ) : null}
    </div>
  )
}
