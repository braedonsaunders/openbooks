'use client'

import { useMoney } from '@/components/money-provider'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Wallet,
  TriangleAlert,
  CalendarClock,
  Timer,
  ListOrdered,
  CalendarRange,
  Building2,
  ListChecks,
  SlidersHorizontal,
} from 'lucide-react'
import type { ApPosition } from '../../../../lib/cash/ap-position'
import { StatTile, CockpitPanel, AgingBars, ScheduleBars } from '../../../../components/cockpit/ui'
import { CashWeekFlyout } from '../../analytics/_ui/CashWeekFlyout'
import { EntityDrawer } from '../../analytics/_ui/EntityDrawer'
import { ApSelectionConfigDrawer } from './ApSelectionConfigDrawer'
import { PayRunPlanner } from './PayRunPlanner'

/**
 * Accounts-Payable control center — fit-to-height app surface. Vitals up top,
 * the pay-run planner filling the height (capacity-scheduled recommendation →
 * /payments run builder), aging + cash-out schedule + vendor breakdown beside
 * it. The selection rule and recurring forecast flows are configured in a
 * flyout. All off the shared cash engine, so numbers agree with the forecast.
 */
export function ApCockpit({ data, canConfigure, canPay }: { data: ApPosition; canConfigure: boolean; canPay: boolean }) {
  const { money, moneyCompact } = useMoney()
  const t = useTranslations('ap.cockpit')
  const [showConfig, setShowConfig] = useState(false)
  const [drillWeek, setDrillWeek] = useState<number | null>(null)
  const [entity, setEntity] = useState<{ id: string; name: string } | null>(null)

  const overduePct = data.outstanding > 0 ? Math.round((data.overdue / data.outstanding) * 100) : 0
  const gear = canConfigure ? (
    <button
      type="button"
      onClick={() => setShowConfig(true)}
      title={t('configure')}
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-slate-400 transition-colors hover:text-teal-600 dark:hover:text-teal-400"
    >
      <SlidersHorizontal size={14} />
      {t('configure')}
    </button>
  ) : undefined

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Vitals */}
      <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile icon={Wallet} accent="indigo" label={t('stats.openPayables')} value={moneyCompact(data.outstanding)} />
        <StatTile icon={TriangleAlert} accent="red" label={t('stats.overdue')} value={moneyCompact(data.overdue)} sub={t('stats.overdueSub', { count: data.overdueCount, pct: overduePct })} tone={data.overdue > 0 ? 'negative' : 'neutral'} />
        <StatTile icon={CalendarClock} accent="amber" label={t('stats.dueThisWeek')} value={moneyCompact(data.dueThisWeek)} tone="warning" />
        <StatTile icon={CalendarRange} accent="sky" label={t('stats.next30')} value={moneyCompact(data.dueNext30)} />
        <StatTile icon={Timer} accent="violet" label={t('stats.dpo')} value={t('stats.days', { n: data.dpo })} sub={t('stats.dpoSub')} />
      </div>

      {/* Planner + right column — fill remaining height */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3">
        <CockpitPanel title={t('panels.payRun')} icon={ListChecks} actions={gear} bodyClassName="min-h-0 overflow-hidden p-0" className="min-h-0 lg:col-span-2">
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
            restrictToSafe={data.payPlan.restrictToSafe}
            deferredThisWeek={data.payPlan.deferredThisWeek}
          />
        </CockpitPanel>

        <div className="flex min-h-0 flex-col gap-5">
          <CockpitPanel title={t('panels.aging')} icon={ListOrdered} hint={`${moneyCompact(data.outstanding)} · ${data.summary.pctCurrent.toFixed(0)}% ${t('current')}`} className="shrink-0">
            <AgingBars buckets={data.summary.buckets} accent="text-red-600 dark:text-red-400" />
          </CockpitPanel>

          <CockpitPanel title={t('panels.schedule')} icon={CalendarRange} hint={t('panels.scheduleHint', { weeks: data.horizonWeeks })} className="shrink-0">
            <ScheduleBars
              weeks={data.weeks.map((w) => ({ label: w.label.split(' – ')[0]!, amount: w.amount }))}
              barClass="bg-red-400 dark:bg-red-500"
              onSelect={(i) => setDrillWeek(i)}
            />
          </CockpitPanel>

          <CockpitPanel title={t('panels.byVendor')} icon={Building2} bodyClassName="min-h-0 overflow-hidden p-0" className="min-h-0 flex-1">
            <div className="h-full overflow-y-auto">
              {data.byVendor.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{t('noPayables')}</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white dark:bg-slate-900">
                    <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                      <th className="px-4 py-2 text-left font-medium">{t('vendor')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('overdueCol')}</th>
                      <th className="px-4 py-2 text-right font-medium">{t('openCol')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byVendor.map((v) => (
                      <tr
                        key={v.partyId ?? v.partyName}
                        onClick={v.partyId ? () => setEntity({ id: v.partyId!, name: v.partyName }) : undefined}
                        className={`border-b border-slate-50 last:border-0 dark:border-slate-800/60 ${v.partyId ? 'cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50' : ''}`}
                      >
                        <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{v.partyName}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {v.overdue > 0 ? <span className="text-red-600 dark:text-red-400">{moneyCompact(v.overdue)}</span> : <span className="text-slate-300 dark:text-slate-600">—</span>}
                        </td>
                        <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(v.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </CockpitPanel>
        </div>
      </div>

      {drillWeek !== null && data.timeline[drillWeek] ? (
        <CashWeekFlyout
          week={data.timeline[drillWeek]!}
          initialSide="ap"
          categories={data.categories}
          weekIndex={drillWeek}
          canPayRun={canPay}
          onClose={() => setDrillWeek(null)}
        />
      ) : null}
      {entity ? <EntityDrawer party={entity.id} name={entity.name} side="ap" onClose={() => setEntity(null)} /> : null}
      {showConfig ? (
        <ApSelectionConfigDrawer
          onClose={() => setShowConfig(false)}
          title={t('configTitle')}
          description={t('configDescription')}
          weeklyCap={data.payPlan.weeklyCap}
          restrictToSafe={data.payPlan.restrictToSafe}
          dpo={data.dpo}
        />
      ) : null}
    </div>
  )
}
