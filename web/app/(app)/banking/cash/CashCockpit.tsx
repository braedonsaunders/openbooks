'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
  SlidersHorizontal,
} from 'lucide-react'
import { Button, cn } from '@openbooks/ui'
import { money, moneyCompact } from '../../../../lib/format'
import type { CashPosition } from '../../../../lib/cash/cash-position'
import type { WeekRow } from '../../../../lib/cash/core'
import { StatTile, CockpitPanel } from '../../../../components/cockpit/ui'
import { CashWeekFlyout, type CategoryFlow } from '../../analytics/_ui/CashWeekFlyout'
import { CashflowConfigDrawer } from '../../analytics/_ui/CashflowConfigDrawer'

const HORIZONS = [4, 8, 12] as const

/**
 * Cash control center — whole-company liquidity. Fit-to-height app surface:
 * vitals up top, the weekly cash timeline (each week drills into what flows in
 * and out) filling the height, bank accounts beside it. Horizon + full forecast
 * configuration (AP selection rule + recurring categories) are in reach.
 * Every number is rolled through the shared engine, so it agrees with the
 * analytics forecast and the AP planner to the penny.
 */
export function CashCockpit({ data, canConfigure }: { data: CashPosition; canConfigure: boolean }) {
  const t = useTranslations('banking.cash')
  const router = useRouter()
  const [flyout, setFlyout] = useState<WeekRow | null>(null)
  const [showConfig, setShowConfig] = useState(false)

  const runway = data.runwayWeeks === null ? '∞' : t('weeks', { n: data.runwayWeeks.toFixed(1) })
  const runwayTone = data.runwayStatus === 'critical' ? 'negative' : data.runwayStatus === 'caution' ? 'warning' : 'positive'
  const lowestDate = new Date(data.lowestWeek + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

  const catFlowsFor = (w: WeekRow): CategoryFlow[] => {
    const wi = data.weeks.indexOf(w)
    return data.categories
      .map((c) => ({ name: c.name, direction: c.direction, amount: c.weekly[wi] ?? 0 }))
      .filter((c) => c.amount > 0)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* control row */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
          {HORIZONS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => router.push(`/banking/cash?horizon=${h}` as any)}
              className={cn('rounded-md px-3 py-1 text-sm font-medium transition-colors', h === data.horizonWeeks ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100' : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100')}
            >
              {t('weeks', { n: h })}
            </button>
          ))}
        </div>
        {canConfigure ? (
          <Button variant="outline" size="sm" onClick={() => setShowConfig(true)}>
            <SlidersHorizontal size={14} />
            {t('configure')}
          </Button>
        ) : null}
      </div>

      {/* Vitals */}
      <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile icon={Landmark} accent="indigo" label={t('stats.currentCash')} value={moneyCompact(data.startingCash)} tone={data.startingCash < 0 ? 'negative' : 'neutral'} />
        <StatTile icon={Wallet} accent="sky" label={t('stats.projectedEnd')} value={moneyCompact(data.projectedEnd)} sub={t('stats.netSub', { amount: moneyCompact(data.netChange) })} tone={data.netChange >= 0 ? 'positive' : 'negative'} />
        <StatTile icon={Route} accent="violet" label={t('stats.runway')} value={runway} sub={t(`status.${data.runwayStatus}`)} tone={runwayTone} />
        <StatTile icon={TriangleAlert} accent={data.lowestCash < 0 ? 'red' : 'amber'} label={t('stats.lowest')} value={moneyCompact(data.lowestCash)} sub={t('stats.lowestSub', { date: lowestDate })} tone={data.lowestCash < 0 ? 'negative' : 'neutral'} />
        <StatTile icon={ArrowLeftRight} accent={data.netChange >= 0 ? 'emerald' : 'red'} label={t('stats.netFlow')} value={moneyCompact(data.netChange)} tone={data.netChange >= 0 ? 'positive' : 'negative'} />
      </div>

      {data.lowestCash < 0 ? (
        <p className="flex shrink-0 items-start gap-2 rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-800 dark:bg-red-950/30 dark:text-red-300">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>{t('negativeAlert', { amount: money(data.lowestCash), date: lowestDate })}</span>
        </p>
      ) : null}

      {/* Timeline + bank accounts — fill remaining height, scroll internally */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3">
        <CockpitPanel title={t('panels.timeline')} icon={CalendarRange} hint={t('panels.timelineHint', { weeks: data.horizonWeeks })} bodyClassName="min-h-0 overflow-hidden p-0" className="min-h-0 lg:col-span-2">
          <div className="h-full overflow-y-auto">
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
                  <tr
                    key={w.weekStart}
                    onClick={() => setFlyout(w)}
                    className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30"
                  >
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

        <CockpitPanel title={t('panels.accounts')} icon={Building2} bodyClassName="min-h-0 overflow-hidden p-0" className="min-h-0">
          <div className="h-full overflow-y-auto">
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
                  <tr className="sticky bottom-0 border-t border-slate-200 bg-slate-50/90 backdrop-blur dark:border-slate-700 dark:bg-slate-800/60">
                    <td className="px-4 py-2.5 font-semibold text-slate-800 dark:text-slate-100">{t('totalCash')}</td>
                    <td className={cn('px-4 py-2.5 text-right font-bold tabular-nums', data.startingCash < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{money(data.startingCash)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        </CockpitPanel>
      </div>

      {flyout ? <CashWeekFlyout week={flyout} categoryFlows={catFlowsFor(flyout)} initialSide="ar" onClose={() => setFlyout(null)} /> : null}
      {showConfig ? (
        <CashflowConfigDrawer
          open
          onClose={() => setShowConfig(false)}
          title={t('configTitle')}
          description={t('configDescription')}
          weeklyApCap={data.apSettings.weeklyCap}
          restrictToSafe={data.apSettings.restrictToSafe ? 1 : 0}
          vendorOptions={data.vendorOptions}
          accountOptions={data.accountOptions}
          initialCategories={data.categories.map((c) => ({ id: c.id, name: c.name, direction: c.direction, method: c.method }))}
        />
      ) : null}
    </div>
  )
}
