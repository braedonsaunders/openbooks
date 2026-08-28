'use client'

import { useMoney } from '@/components/money-provider'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Landmark,
  Wallet,
  TriangleAlert,
  Flame,
  ShieldCheck,
  RefreshCw,
  ArrowLeftRight,
  Route,
  Waypoints,
  AreaChart,
  CalendarRange,
  Building2,
  SlidersHorizontal,
} from 'lucide-react'
import { Button, cn } from '@openbooks/ui'
import { cmp as compareMoney } from '@openbooks/engine/src/money.ts'
import type { PageLayoutPrefs } from '@openbooks/schema'
import type { CashPosition } from '../../../../lib/cash/cash-position'
import { LayoutMenu } from '../../../../components/page-layout/LayoutMenu'
import { usePageLayout } from '../../../../components/page-layout/use-page-layout'
import { StatTile, CockpitPanel } from '../../../../components/cockpit/ui'
import { CashTimeline } from '../../analytics/_ui/CashTimeline'
import { Chart, cashBridgeOption, cashForecastOption } from '../../analytics/_ui/charts'
import { formatExactRatio } from '../../analytics/_ui/format'
import { Vital } from '../../analytics/_ui/Vital'
import { CashForecastConfigDrawer } from './CashForecastConfigDrawer'

const HORIZONS = [4, 8, 12] as const

/** Orderable panels; the FIRST visible one renders as the hero (⅔ width). */
const PANEL_KEYS = ['timeline', 'forecast', 'bridge', 'health', 'accounts'] as const
type PanelKey = (typeof PANEL_KEYS)[number]
/** Toggle-only pseudo-panel: the StatTile vitals strip. */
const STATS_KEY = 'stats'
const PAGE_KEY = 'banking-cash'

/**
 * Cash control center — whole-company liquidity. The panel set is per-user
 * customizable (reorder + show/hide, persisted in user_page_layouts): the
 * first visible panel owns the ⅔ hero zone at full height, the rest stack in
 * the scrollable right rail. Default: the weekly cash-position TABLE with its
 * per-transaction flyout is the hero. Forecast model configured here; the AP
 * pay rule on the AP cockpit. One shared engine everywhere.
 */
export function CashCockpit({
  data,
  layoutPrefs,
  canConfigure,
  canPayRun,
  canCollectionRun,
}: {
  data: CashPosition
  layoutPrefs: PageLayoutPrefs
  canConfigure: boolean
  canPayRun: boolean
  canCollectionRun: boolean
}) {
  const { money, moneyCompact } = useMoney()
  const t = useTranslations('banking.cash')
  const tCharts = useTranslations('analytics.charts')
  const router = useRouter()
  const searchParams = useSearchParams()
  const [showConfig, setShowConfig] = useState(false)
  const pushHorizon = (h: number) => {
    // Merge into the current query so the subsidiary view (?sub=) survives.
    const next = new URLSearchParams(searchParams?.toString())
    next.set('horizon', String(h))
    router.push(`/banking/cash?${next.toString()}` as never)
  }

  // -- per-user layout (shared kit) -----------------------------------------
  const layout = usePageLayout(PAGE_KEY, layoutPrefs, PANEL_KEYS)
  const { hidden, toggle, move, reset } = layout
  const order = layout.order as PanelKey[]
  const visible = layout.visible as PanelKey[]
  const heroKey = visible[0]
  const railKeys = visible.slice(1)
  const statsHidden = hidden.has(STATS_KEY)

  const lowestDate = new Date(data.lowestWeek + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const scheduling = compareMoney(data.apSettings.weeklyCap, '0.0000') > 0 || data.apSettings.restrictToSafe
  const runwayTone = data.runwayStatus === 'critical' ? 'negative' : data.runwayStatus === 'caution' ? 'warning' : 'positive'
  const bridgeLabels = {
    start: tCharts('bridge.start'),
    inflows: tCharts('bridge.inflows'),
    outflows: tCharts('bridge.outflows'),
    projectedEnd: tCharts('bridge.projectedEnd'),
  }
  const forecastLabels = {
    endingCash: tCharts('weekly.endingCash'),
    lowest: tCharts('weekly.lowest'),
    in: tCharts('weekly.in'),
    out: tCharts('weekly.out'),
    net: tCharts('weekly.net'),
    ending: tCharts('weekly.ending'),
  }
  const bridge = useMemo(
    () => cashBridgeOption(data.startingCash, data.totalInflows, data.totalOutflows, data.projectedEnd, moneyCompact, bridgeLabels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.startingCash, data.totalInflows, data.totalOutflows, data.projectedEnd, moneyCompact],
  )
  const forecast = useMemo(() => cashForecastOption(data.weeks, moneyCompact, forecastLabels), [data.weeks, moneyCompact])

  // Distinct menu labels — the timeline table and forecast chart share a
  // panel title on the page, which would be ambiguous in the layout list.
  const panelLabel = (key: string) =>
    key === STATS_KEY || key === 'health' || key === 'timeline' || key === 'forecast'
      ? t(`layout.${key}`)
      : t(`panels.${key}`)

  // -- panel renderers (hero = ⅔ zone at full height, rail = stacked) -------
  const renderPanel = (key: PanelKey, hero: boolean) => {
    const chartHeight = hero ? 320 : 180
    const panelCls = hero ? 'min-h-[24rem] lg:col-span-2' : 'shrink-0'
    switch (key) {
      case 'timeline':
        return (
          <CockpitPanel
            key={key}
            title={t('panels.timeline')}
            icon={CalendarRange}
            hint={scheduling ? t('panels.timelineHintScheduled') : t('panels.timelineHint', { weeks: data.horizonWeeks })}
            bodyClassName={hero ? 'min-h-0 overflow-hidden p-0' : 'p-0'}
            className={panelCls}
          >
            <div className={hero ? 'h-full overflow-y-auto' : 'max-h-80 overflow-y-auto'}>
              <CashTimeline
                weeks={data.weeks}
                categories={data.categories}
                weeklyCap={data.apSettings.weeklyCap}
                restrictToSafe={data.apSettings.restrictToSafe}
                deferredBeyondHorizon={data.deferredBeyondHorizon}
                canPayRun={canPayRun}
                canCollectionRun={canCollectionRun}
              />
            </div>
          </CockpitPanel>
        )
      case 'forecast':
        return (
          <CockpitPanel key={key} title={t('panels.forecast')} icon={AreaChart} hint={t('panels.forecastHint')} className={panelCls}>
            <Chart option={forecast} height={chartHeight} />
          </CockpitPanel>
        )
      case 'bridge':
        return (
          <CockpitPanel key={key} title={t('panels.bridge')} icon={Waypoints} className={panelCls}>
            <Chart option={bridge} height={chartHeight} />
          </CockpitPanel>
        )
      case 'health':
        return (
          <div key={key} className={cn('grid grid-cols-1 gap-3', hero ? 'content-start lg:col-span-2' : 'shrink-0')}>
            <Vital icon={Flame} ring="from-violet-500 to-fuchsia-500" label={t('vitals.burnRate')} value={moneyCompact(data.burnRate)} hint={t('vitals.burnRateHint')} badge={t('vitals.weekly')} />
            <Vital icon={ShieldCheck} ring="from-sky-500 to-blue-500" label={t('vitals.arCoverage')} value={data.arCoverage === null ? '—' : `${formatExactRatio(data.arCoverage)}×`} hint={t('vitals.arCoverageHint')} />
            <Vital icon={RefreshCw} ring="from-teal-500 to-emerald-500" label={t('vitals.cashCycle')} value={`${data.dso} / ${data.dpo}`} hint={t('vitals.cashCycleHint')} split />
          </div>
        )
      case 'accounts':
        return (
          <CockpitPanel key={key} title={t('panels.accounts')} icon={Building2} bodyClassName="p-0" className={panelCls}>
            {data.bankAccounts.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{t('noAccounts')}</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {data.bankAccounts.map((b) => (
                    <tr key={b.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2.5">
                        <Link href={(`/banking/${b.id}`)} className="font-medium text-slate-700 hover:text-teal-700 dark:text-slate-300 dark:hover:text-teal-300">
                          {b.name}
                        </Link>
                        {b.number ? <span className="ml-2 text-xs text-slate-400">{b.number}</span> : null}
                      </td>
                      <td className={cn('px-4 py-2.5 text-right font-medium tabular-nums', compareMoney(b.balance, '0.0000') < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-200')}>{money(b.balance)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-200 bg-slate-50/50 dark:border-slate-700 dark:bg-slate-800/30">
                    <td className="px-4 py-2.5 font-semibold text-slate-800 dark:text-slate-100">{t('totalCash')}</td>
                    <td className={cn('px-4 py-2.5 text-right font-bold tabular-nums', compareMoney(data.startingCash, '0.0000') < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{money(data.startingCash)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </CockpitPanel>
        )
    }
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
              onClick={() => pushHorizon(h)}
              className={cn('rounded-md px-3 py-1 text-sm font-medium transition-colors', h === data.horizonWeeks ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100' : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100')}
            >
              {t('weeks', { n: h })}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <LayoutMenu
            title={t('layout.title')}
            triggerLabel={t('layout.customize')}
            resetLabel={t('layout.reset')}
            rows={[
              { key: STATS_KEY, label: panelLabel(STATS_KEY), hidden: statsHidden, orderable: false },
              ...order.map((key) => ({ key, label: panelLabel(key), hidden: hidden.has(key) })),
            ]}
            onToggle={toggle}
            onMove={move}
            onReset={reset}
          />
          {canConfigure ? (
            <Button variant="outline" size="sm" onClick={() => setShowConfig(true)}>
              <SlidersHorizontal size={14} />
              {t('configure')}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Vitals */}
      {!statsHidden ? (
        <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile icon={Landmark} accent="indigo" label={t('stats.currentCash')} value={moneyCompact(data.startingCash)} tone={compareMoney(data.startingCash, '0.0000') < 0 ? 'negative' : 'neutral'} />
          <StatTile icon={Wallet} accent="sky" label={t('stats.projectedEnd')} value={moneyCompact(data.projectedEnd)} sub={t('stats.netSub', { amount: moneyCompact(data.netChange) })} tone={compareMoney(data.netChange, '0.0000') >= 0 ? 'positive' : 'negative'} />
          <StatTile icon={Route} accent="violet" label={t('stats.runway')} value={data.runwayWeeks === null ? '∞' : t('weeks', { n: formatExactRatio(data.runwayWeeks, 1) })} sub={t(`status.${data.runwayStatus}`)} tone={runwayTone} />
          <StatTile icon={TriangleAlert} accent={compareMoney(data.lowestCash, '0.0000') < 0 ? 'red' : 'amber'} label={t('stats.lowest')} value={moneyCompact(data.lowestCash)} sub={t('stats.lowestSub', { date: lowestDate })} tone={compareMoney(data.lowestCash, '0.0000') < 0 ? 'negative' : 'neutral'} />
          <StatTile icon={ArrowLeftRight} accent={compareMoney(data.netChange, '0.0000') >= 0 ? 'emerald' : 'red'} label={t('stats.netFlow')} value={moneyCompact(data.netChange)} tone={compareMoney(data.netChange, '0.0000') >= 0 ? 'positive' : 'negative'} />
        </div>
      ) : null}

      {compareMoney(data.lowestCash, '0.0000') < 0 ? (
        <p className="flex shrink-0 items-start gap-2 rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-800 dark:bg-red-950/30 dark:text-red-300">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            {t.rich('negativeAlert', {
              amount: money(data.lowestCash),
              date: lowestDate,
              ap: (chunks) => <Link href={('/ap')} className="font-semibold underline decoration-red-300 underline-offset-2 hover:text-red-900 dark:hover:text-red-200">{chunks}</Link>,
              ar: (chunks) => <Link href={('/ar')} className="font-semibold underline decoration-red-300 underline-offset-2 hover:text-red-900 dark:hover:text-red-200">{chunks}</Link>,
            })}
          </span>
        </p>
      ) : null}

      {/* first visible panel = hero (⅔, full height) + supporting rail */}
      {visible.length === 0 ? (
        <p className="flex flex-1 items-center justify-center text-sm text-slate-400 dark:text-slate-500">{t('layout.empty')}</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3">
          {heroKey ? renderPanel(heroKey, true) : null}
          {railKeys.length > 0 ? (
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">{railKeys.map((k) => renderPanel(k, false))}</div>
          ) : null}
        </div>
      )}

      {showConfig ? (
        <CashForecastConfigDrawer
          onClose={() => setShowConfig(false)}
          title={t('configTitle')}
          description={t('configDescription')}
          asOf={data.asOf}
          horizonWeeks={data.horizonWeeks}
          dso={data.dso}
          dpo={data.dpo}
          weeklyCap={data.apSettings.weeklyCap}
          restrictToSafe={data.apSettings.restrictToSafe}
          vendorOptions={data.vendorOptions}
          accountOptions={data.accountOptions}
          initialCategories={data.categories.map((c) => ({ id: c.id, name: c.name, direction: c.direction, method: c.method }))}
        />
      ) : null}
    </div>
  )
}
