'use client'

import { useMemo, useState } from 'react'
import { LineChart, Cog, Stethoscope, Table2 } from 'lucide-react'
import { EmptyState, Select } from '@openbooks/ui'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { Panel, SegToggle } from '../../_ui/Panel'
import { ForecastChart } from '../../_ui/charts'
import { useAnalyticsMoney } from '../../_ui/format'
import { applyForecastMethod, applyForecastAdjustment, diagnostics, type ForecastMethod, type Seasonality } from '../../_ui/forecast'

type Metric = 'revenue' | 'gm' | 'opinc'
const METRIC_KEY: Record<Metric, 'revenue' | 'grossProfit' | 'operatingIncome'> = {
  revenue: 'revenue',
  gm: 'grossProfit',
  opinc: 'operatingIncome',
}

function futureLabels(lastMonth: string, horizon: number): string[] {
  const [y, m] = lastMonth.split('-').map(Number)
  const out: string[] = []
  for (let i = 1; i <= horizon; i++) {
    const d = new Date(Date.UTC(y!, m! - 1 + i, 1))
    out.push(`${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} '${String(d.getUTCFullYear()).slice(2)}`)
  }
  return out
}

const SELECT = 'h-8 w-full text-sm'

export function ForecastTab({ data }: { data: HealthData }) {
  const fmtMoney = useAnalyticsMoney()
  const [metric, setMetric] = useState<Metric>('revenue')
  const [method, setMethod] = useState<ForecastMethod>('ets')
  const [horizon, setHorizon] = useState(6)
  const [confidence, setConfidence] = useState(90)
  const [seasonality, setSeasonality] = useState<Seasonality>('auto')
  const [adjustment, setAdjustment] = useState(0)

  const hist = data.monthly.filter((p) => p.revenue !== 0 || p.cogs !== 0)
  const series = hist.map((p) => p[METRIC_KEY[metric]])

  const result = useMemo(() => {
    if (series.length < 3) return null
    const r = applyForecastMethod(series, method, horizon, seasonality, confidence)
    r.values = applyForecastAdjustment(r.values, adjustment)
    return r
  }, [series, method, horizon, seasonality, confidence, adjustment])

  if (series.length < 3 || !result) {
    return <EmptyState icon={<LineChart size={28} />} title="Not enough history" description="Forecasting needs at least 3 months of activity in the selected period." />
  }

  const diag = diagnostics(series, result)
  const histLabels = hist.map((p) => p.label)
  const futLabels = futureLabels(hist[hist.length - 1]!.month, horizon)
  const labels = [...histLabels, ...futLabels]
  const N = series.length
  const history = [...series, ...Array(horizon).fill(null)]
  const forecast = [...Array(N - 1).fill(null), series[N - 1], ...result.values]
  const low = [...Array(N).fill(null), ...result.low]
  const high = [...Array(N).fill(null), ...result.high]

  const totalForecast = result.values.reduce((a, b) => a + b, 0)
  const endValue = result.values[horizon - 1]!
  const lastActual = series[N - 1]!
  const growth = lastActual !== 0 ? (endValue - lastActual) / Math.abs(lastActual) : 0

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
      <div className="space-y-5 lg:col-span-3">
        <Panel
          title="Multi-Metric Forecast"
          icon={LineChart}
          actions={
            <SegToggle
              value={metric}
              onChange={setMetric}
              options={[
                { value: 'revenue', label: 'Revenue' },
                { value: 'gm', label: 'Gross Margin' },
                { value: 'opinc', label: 'Op Income' },
              ]}
            />
          }
        >
          <ForecastChart labels={labels} history={history} forecast={forecast} low={low} high={high} height={320} />
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            <Stat label={`${horizon}-mo Total`} value={fmtMoney(totalForecast, { compact: true })} />
            <Stat label={`Month ${horizon}`} value={fmtMoney(endValue, { compact: true })} />
            <Stat label="Projected Growth" value={`${(growth * 100).toFixed(1)}%`} tone={growth >= 0 ? 'pos' : 'neg'} />
          </div>
        </Panel>

        <Panel title="Monthly Forecast Detail" icon={Table2} bodyClassName="p-0">
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-slate-900">
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Month</th>
                  <th className="px-4 py-2 text-right font-medium">Forecast</th>
                  <th className="px-4 py-2 text-right font-medium">Low</th>
                  <th className="px-4 py-2 text-right font-medium">High</th>
                  <th className="px-4 py-2 text-right font-medium">Conf.</th>
                </tr>
              </thead>
              <tbody>
                {result.values.map((v, i) => (
                  <tr key={i} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{futLabels[i]}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{fmtMoney(v)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtMoney(result.low[i]!)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtMoney(result.high[i]!)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-400 dark:text-slate-500">{confidence}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="space-y-5">
        <Panel title="Forecast Settings" icon={Cog}>
          <div className="space-y-3">
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value as ForecastMethod)} triggerClassName={SELECT}>
                <option value="ets">Exponential Smoothing (ETS)</option>
                <option value="linear">Linear Regression</option>
                <option value="seasonal">Seasonal Decomposition</option>
                <option value="moving_avg">Moving Average</option>
                <option value="arima">ARIMA-style</option>
              </Select>
            </Field>
            <Field label="Horizon">
              <Select value={String(horizon)} onChange={(e) => setHorizon(Number(e.target.value))} triggerClassName={SELECT}>
                {[3, 6, 12, 24].map((h) => <option key={h} value={String(h)}>{h} Months</option>)}
              </Select>
            </Field>
            <Field label="Confidence">
              <Select value={String(confidence)} onChange={(e) => setConfidence(Number(e.target.value))} triggerClassName={SELECT}>
                {[80, 90, 95, 99].map((c) => <option key={c} value={String(c)}>{c}%</option>)}
              </Select>
            </Field>
            <Field label="Seasonality">
              <Select value={seasonality} onChange={(e) => setSeasonality(e.target.value as Seasonality)} triggerClassName={SELECT}>
                <option value="auto">Auto-detect</option>
                <option value="none">None</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </Select>
            </Field>
            <Field label="Adjustment">
              <Select value={String(adjustment)} onChange={(e) => setAdjustment(Number(e.target.value))} triggerClassName={SELECT}>
                <option value="0">None</option>
                <option value="-0.05">Pessimistic (−5%)</option>
                <option value="-0.1">Recession (−10%)</option>
                <option value="0.05">Optimistic (+5%)</option>
                <option value="0.1">High Growth (+10%)</option>
              </Select>
            </Field>
          </div>
        </Panel>

        <Panel title="Model Diagnostics" icon={Stethoscope} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            <Diag label="MAPE" value={`${diag.mape.toFixed(1)}%`} />
            <Diag label="RMSE" value={fmtMoney(diag.rmse, { compact: true })} />
            <Diag label="R²" value={diag.r2.toFixed(3)} />
            <Diag label="Trend" value={diag.trendDir} />
            <Diag label="Seasonality" value={diag.seasonLabel} />
          </ul>
        </Panel>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-500 dark:text-slate-400">{label}</span>
      {children}
    </label>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/60 py-2 dark:border-slate-800 dark:bg-slate-800/30">
      <p className="text-[11px] text-slate-400 dark:text-slate-500">{label}</p>
      <p className={tone === 'pos' ? 'text-sm font-bold text-emerald-600 dark:text-emerald-400' : tone === 'neg' ? 'text-sm font-bold text-red-600 dark:text-red-400' : 'text-sm font-bold text-slate-800 tabular-nums dark:text-slate-200'}>{value}</p>
    </div>
  )
}

function Diag({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between px-4 py-2">
      <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>
      <span className="text-sm font-semibold text-slate-800 tabular-nums dark:text-slate-200">{value}</span>
    </li>
  )
}
