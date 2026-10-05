'use client'

import { useTranslations } from 'next-intl'
import { Layers, Percent, AreaChart, PieChart, ArrowLeftRight, Waypoints } from 'lucide-react'
import { cn } from '@openbooks/ui'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { decimalRatio } from '../../../../../lib/reports/decimals'
import { add, cmp, mulDecimal, neg } from '@openbooks/engine/money'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { Waterfall, TrendChart, Donut } from '../../_ui/charts'
import { useAnalyticsMoney, useRatioFormat, toChartNumber } from '../../_ui/format'

export interface MarginBridge {
  priorGrossProfit: string;
  priorGm: string;
  deltaGm: string;
  volumeEffect: string;
  rateEffect: string;
  /** Current gross profit minus the reconciled bridge; named on the chart whenever it is nonzero. */
  residual: string;
}

/**
 * The YoY gross-margin bridge in exact decimals: volume effect = Δrevenue ×
 * prior GM, rate effect = current revenue × ΔGM. Null without prior-period
 * revenue or a current engine margin — the caller shows its reason instead
 * of dividing by a stand-in.
 */
export function buildMarginBridge(
  current: { revenue: string; grossProfit: string },
  prior: { revenue: string; grossProfit: string } | null,
  currentGm: string | null,
): MarginBridge | null {
  if (prior === null || currentGm === null) return null;
  if (cmp(prior.revenue, '0') <= 0) return null;
  const priorGm = decimalRatio(prior.grossProfit, prior.revenue);
  if (priorGm === null) return null;
  const volumeEffect = mulDecimal(add(current.revenue, neg(prior.revenue)), priorGm);
  const deltaGm = add(currentGm, neg(priorGm));
  const rateEffect = mulDecimal(current.revenue, deltaGm);
  const residual = add(current.grossProfit, neg(add(add(prior.grossProfit, volumeEffect), rateEffect)));
  return { priorGrossProfit: prior.grossProfit, priorGm, deltaGm, volumeEffect, rateEffect, residual };
}

export function MarginTab({ data }: { data: HealthData }) {
  const fmtMoney = useAnalyticsMoney()
  const fmtRatio = useRatioFormat()
  const t = useTranslations('analytics.financialHealth.margin')
  const fig = data.figures
  const byId = new Map(Object.values(data.ratios).flat().map((r) => [r.id, r]))
  const gm = byId.get('gross_margin')
  const opm = byId.get('operating_margin')
  const net = byId.get('net_margin')
  const cogsRatio = byId.get('cogs_ratio')

  const pct = (n: string | null | undefined) => (n == null ? null : fmtRatio(n, 'pct'))

  // The gross-margin volume/rate bridge, in exact decimals: volume effect =
  // Δrevenue × prior GM, rate effect = current revenue × ΔGM. Either margin
  // missing leaves the bridge ungraded with its reason — never a stand-in.
  const pnl = Object.fromEntries(data.pnlSummary.map((l) => [l.key, l]))
  const bridge = buildMarginBridge(
    { revenue: fig.revenue, grossProfit: fig.grossProfit },
    pnl.revenue?.prior != null && pnl.grossProfit?.prior != null
      ? { revenue: pnl.revenue.prior, grossProfit: pnl.grossProfit.prior }
      : null,
    gm?.value ?? null,
  )
  const priorGm = bridge?.priorGm ?? null
  const curGm = gm?.value ?? null

  const bridgeSteps = bridge
    ? [
      { label: t('bridgeSteps.prior'), amount: toChartNumber(bridge.priorGrossProfit), kind: 'start' as const },
      { label: t('bridgeSteps.volume'), amount: toChartNumber(bridge.volumeEffect), kind: 'deduct' as const },
      { label: t('bridgeSteps.rate'), amount: toChartNumber(bridge.rateEffect), kind: 'deduct' as const },
      ...(cmp(bridge.residual, '0') !== 0
        ? [{ label: t('bridgeSteps.residual'), amount: toChartNumber(bridge.residual), kind: 'deduct' as const }]
        : []),
      { label: t('bridgeSteps.current'), amount: toChartNumber(fig.grossProfit), kind: 'total' as const },
    ]
    : []

  const allocation = [
    { key: 'cogs', name: t('allocationNames.cogs'), amount: fig.cogs },
    { key: 'opex', name: t('allocationNames.opex'), amount: fig.opex },
    { key: 'other', name: t('allocationNames.other'), amount: fig.otherExpense },
    { key: 'net', name: t('allocationNames.net'), amount: fig.netIncome },
  ]
    .filter((d) => cmp(d.amount, '0') > 0)
    .map((d) => ({ name: d.name, value: toChartNumber(d.amount) }))

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Percent} accent="teal" label={t('kpi.grossMargin')} value={pct(gm?.value) ?? '—'} sub={fmtMoney(fig.grossProfit, { compact: true })} />
        <KpiCard icon={Percent} accent="violet" label={t('kpi.operatingMargin')} value={pct(opm?.value) ?? '—'} sub={fmtMoney(fig.operatingIncome, { compact: true })} />
        <KpiCard icon={Percent} accent={net?.value == null ? 'slate' : cmp(net.value, '0') >= 0 ? 'emerald' : 'red'} label={t('kpi.netMargin')} value={pct(net?.value) ?? '—'} sub={fmtMoney(fig.netIncome, { compact: true })} tone={net?.value == null ? undefined : cmp(net.value, '0') >= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={Layers} accent="amber" label={t('kpi.cogsRatio')} value={pct(cogsRatio?.value) ?? '—'} sub={fmtMoney(fig.cogs, { compact: true })} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title={t('flow')} icon={Waypoints} hint={t('flowHint')}>
            <Waterfall steps={data.marginFlow.map((s) => ({ label: s.label, amount: toChartNumber(s.amount), kind: s.kind }))} height={260} />
          </Panel>
        </div>
        <Panel title={t('summary')} icon={Percent} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {data.marginFlow.map((s) => (
              <li key={s.key} className="flex items-center justify-between px-4 py-2.5">
                <span className={cn('text-sm', s.kind === 'subtotal' || s.kind === 'total' || s.kind === 'start' ? 'font-semibold text-slate-800 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400')}>{s.label}</span>
                <span className="flex items-baseline gap-2">
                  <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">{fmtMoney(s.amount, { compact: true })}</span>
                  <span className="w-12 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{pct(s.pctOfRevenue) ?? '—'}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel
            title={t('bridge')}
            icon={ArrowLeftRight}
            hint={bridge ? t('bridgeHint', { from: pct(priorGm) ?? '—', to: pct(curGm) ?? '—' }) : undefined}
          >
            {bridge ? (
              <Waterfall steps={bridgeSteps} height={220} />
            ) : (
              <p className="py-6 text-center text-xs text-slate-400">{t('bridgeNoPrior')}</p>
            )}
          </Panel>
        </div>
        <div className="space-y-5">
          <Panel title={t('trends')} icon={AreaChart}>
            <TrendChart
              labels={data.monthly.map((p) => p.label)}
              pctAxis
              height={130}
              series={[
                { name: t('series.gross'), data: data.monthly.map((p) => p.grossMarginPct), color: '#0d9488', pct: true },
                { name: t('series.operating'), data: data.monthly.map((p) => p.operatingMarginPct), color: '#f59e0b', pct: true },
              ]}
            />
          </Panel>
          <Panel title={t('allocation')} icon={PieChart}>
            {allocation.length ? <Donut data={allocation} height={150} /> : <p className="py-6 text-center text-xs text-slate-400">{t('noAllocation')}</p>}
          </Panel>
        </div>
      </div>
    </div>
  )
}
