'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "@openbooks/ui"
import { useMoney } from '@/components/money-provider'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { cmp as compareMoney, div as divideMoney } from '@openbooks/engine/src/money/money.ts'
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
import { TableDrilldownButton } from '../../../../components/table-drilldown-button'
import { CashWeekFlyout } from '../../analytics/_ui/CashWeekFlyout'
import { formatExactPercent } from '../../analytics/_ui/format'
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

  const overduePct = compareMoney(data.outstanding, '0.0000') > 0
    ? formatExactPercent(divideMoney(data.overdue, data.outstanding))
    : '0%'
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
        <StatTile icon={TriangleAlert} accent="red" label={t('stats.overdue')} value={moneyCompact(data.overdue)} sub={t('stats.overdueSub', { count: data.overdueCount, pct: overduePct })} tone={compareMoney(data.overdue, '0.0000') > 0 ? 'negative' : 'neutral'} />
        <StatTile icon={CalendarClock} accent="amber" label={t('stats.dueThisWeek')} value={moneyCompact(data.dueThisWeek)} tone="warning" />
        <StatTile icon={CalendarRange} accent="sky" label={t('stats.next30')} value={moneyCompact(data.dueNext30)} />
        <StatTile icon={Timer} accent="violet" label={t('stats.dpo')} value={data.dpo === null ? '—' : t('stats.days', { n: data.dpo })} sub={data.dpo === null ? t('stats.dpoEmpty') : t('stats.dpoSub')} />
      </div>

      {data.unavailableCategories.length > 0 ? (
        <p className="flex shrink-0 items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>{t('refusedAlert', { names: data.unavailableCategories.map((r) => r.name).join(', ') })}</span>
        </p>
      ) : null}

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
            canPay={canPay}
          />
        </CockpitPanel>

        {/* Supporting rail — scrolls as a column (the banking/purchasing home
            idiom) so the panels below the fold stay reachable on short
            viewports instead of the vendor table collapsing to nothing. */}
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
          <CockpitPanel title={t('panels.aging')} icon={ListOrdered} hint={`${moneyCompact(data.outstanding)} · ${formatExactPercent(data.summary.pctCurrent)} ${t('current')}`} className="shrink-0">
            <AgingBars buckets={data.summary.buckets} accent="text-red-600 dark:text-red-400" />
          </CockpitPanel>

          <CockpitPanel title={t('panels.schedule')} icon={CalendarRange} hint={t('panels.scheduleHint', { weeks: data.horizonWeeks })} className="shrink-0">
            <ScheduleBars
              weeks={data.weeks.map((w) => ({ label: w.label.split(' – ')[0]!, amount: w.amount }))}
              barClass="bg-red-400 dark:bg-red-500"
              onSelect={(i) => setDrillWeek(i)}
            />
          </CockpitPanel>

          {/* Grows into the rail's leftover height, but never collapses: below
              its floor the rail scrolls instead of squeezing the table away. */}
          <CockpitPanel title={t('panels.byVendor')} icon={Building2} bodyClassName="min-h-0 overflow-hidden p-0" className="min-h-80 flex-1">
            <div className="h-full overflow-y-auto">
              {data.byVendor.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{t('noPayables')}</p>
              ) : (
                <SharedTable className="w-full text-sm">
                  <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
                    <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                      <SharedTableHead className="px-4 py-2 text-left font-medium">{t('vendor')}</SharedTableHead>
                      <SharedTableHead className="px-3 py-2 text-right font-medium">{t('overdueCol')}</SharedTableHead>
                      <SharedTableHead className="px-4 py-2 text-right font-medium">{t('openCol')}</SharedTableHead>
                    </SharedTableRow>
                  </SharedTableHeader>
                  <SharedTableBody>
                    {data.byVendor.map((v) => (
                      <SharedTableRow
                        key={v.partyId ?? v.partyName}
                        className="border-b border-slate-50 last:border-0 dark:border-slate-800/60"
                      >
                        <SharedTableCell className="px-4 py-2 text-slate-700 dark:text-slate-300">
                          {v.partyId ? (
                            <TableDrilldownButton onActivate={() => setEntity({ id: v.partyId!, name: v.partyName })}>
                              {v.partyName}
                            </TableDrilldownButton>
                          ) : v.partyName}
                        </SharedTableCell>
                        <SharedTableCell className="px-3 py-2 text-right tabular-nums">
                          {compareMoney(v.overdue, '0.0000') > 0 ? <span className="text-red-600 dark:text-red-400">{moneyCompact(v.overdue)}</span> : <span className="text-slate-300 dark:text-slate-600">—</span>}
                        </SharedTableCell>
                        <SharedTableCell className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(v.amount)}</SharedTableCell>
                      </SharedTableRow>
                    ))}
                  </SharedTableBody>
                </SharedTable>
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
          horizonWeeks={data.horizonWeeks}
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
          dpo={data.dpo}
          canEdit={canConfigure}
        />
      ) : null}
    </div>
  )
}
