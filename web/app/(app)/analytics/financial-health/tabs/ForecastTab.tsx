'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../../../reports/ReportTable"
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { LineChart, Cog, Stethoscope, Table2, TriangleAlert } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { EmptyState, Select } from '@openbooks/ui'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { Panel, SegToggle } from '../../_ui/Panel'
import { ForecastChart } from '../../_ui/charts'
import { useAnalyticsMoney, toChartNumber } from '../../_ui/format'
import { cmp } from '@openbooks/engine/money'
import { applyForecastAdjustment, applyForecastMethod, checkSignDomain, diagnostics, type ForecastMethod, type Seasonality, type SignDomain } from '../../_ui/forecast'
import { UnknownConfidenceError } from '../../../../../lib/analytics/forecast-levels'

type Metric = 'revenue' | 'gm' | 'opinc'
const METRIC_KEY: Record<Metric, 'revenue' | 'grossProfit' | 'operatingIncome'> = {
  revenue: 'revenue',
  gm: 'grossProfit',
  opinc: 'operatingIncome',
}
/**
 * Each metric declares the sign domain its projection may take. Revenue is
 * nonnegative: a projection below zero is the model's trend carried past the
 * domain's edge, never attainable revenue, and must carry the caveat below.
 * Margins and operating income can genuinely print negative, so they never
 * breach.
 */
const METRIC_DOMAIN: Record<Metric, SignDomain> = {
  revenue: 'nonnegative',
  gm: 'any',
  opinc: 'any',
}
/** Translated metric name for the caveat copy (kpi catalog). */
const METRIC_KPI: Record<Metric, 'revenue' | 'grossProfit' | 'operatingIncome'> = {
  revenue: 'revenue',
  gm: 'grossProfit',
  opinc: 'operatingIncome',
}

const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const

/**
 * Labels for the projected buckets on monthly cadence, stepping calendar
 * months from the last history point's month. Non-monthly calendars never
 * reach this path: the server sends their declared future period names with
 * the series. Month names and the year template come from the catalog,
 * never English.
 */
function futureLabels(
  lastMonth: string,
  horizon: number,
  t: (key: string, values?: Record<string, string>) => string,
): string[] {
  const [y, m] = lastMonth.split('-').map(Number)
  const out: string[] = []
  for (let i = 1; i <= horizon; i++) {
    const d = new Date(Date.UTC(y!, m! - 1 + i, 1))
    const month = t(`monthsShort.${MONTH_KEYS[d.getUTCMonth()]!}`)
    out.push(t('monthYear', { month, yy: String(d.getUTCFullYear()).slice(2) }))
  }
  return out
}

const SELECT = 'h-8 w-full text-sm'

const isMethod = (v: string): v is ForecastMethod =>
  v === 'ets' || v === 'ets_damped' || v === 'linear' || v === 'seasonal' || v === 'moving_avg' || v === 'arima'
const isSeasonality = (v: string): v is Seasonality =>
  v === 'auto' || v === 'none' || v === 'monthly' || v === 'quarterly'

export function ForecastTab({ data }: { data: HealthData }) {
  const locale = useLocale()
  const fmtMoney = useAnalyticsMoney()
  const t = useTranslations('analytics.financialHealth.forecast')
  const tc = useTranslations('analytics.common')
  const to = useTranslations('analytics.financialHealth.config.options')
  const tk = useTranslations('analytics.financialHealth.kpi')
  const fp = data.forecast
  const [metric, setMetric] = useState<Metric>('revenue')
  const [method, setMethod] = useState(fp.defaultMethod)
  const [horizon, setHorizon] = useState(fp.defaultHorizon)
  const [confidence, setConfidence] = useState(fp.defaultConfidence)
  const [seasonality, setSeasonality] = useState(fp.defaultSeasonality)
  const [adjustment, setAdjustment] = useState(fp.defaultAdjustment)

  const fmtPercent = (n: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(n)

  // Every configured level is validated before it reaches the model: an
  // unknown confidence has no band multiplier, so the tab refuses with the
  // valid levels instead of printing a band under a false name. The server
  // only emits declared option codes, so this fires on corrupt input alone.
  const invalid = useMemo(() => (
    !isMethod(method) || !fp.methods.includes(method) ? { field: t('field.method'), level: method, levels: fp.methods.map((m) => to(`forecastMethod.${m}`)).join(', ') }
      : !fp.horizons.includes(horizon) ? { field: t('field.horizon'), level: String(horizon), levels: fp.horizons.map((h) => t('horizonMonths', { count: h })).join(', ') }
        : !fp.confidences.includes(confidence) ? { field: t('field.confidence'), level: String(confidence), levels: fp.confidences.map((c) => t('confidencePct', { count: c })).join(', ') }
          : !isSeasonality(seasonality) || !fp.seasonalities.includes(seasonality) ? { field: t('field.seasonality'), level: seasonality, levels: fp.seasonalities.map((s) => to(`forecastSeasonality.${s}`)).join(', ') }
            : !fp.adjustments.some((a) => a.code === adjustment) ? { field: t('field.adjustment'), level: adjustment, levels: fp.adjustments.map((a) => to(`forecastAdjustment.${a.code}`)).join(', ') }
              : null
  ), [method, horizon, confidence, seasonality, adjustment, fp, t, to])
  const adjValue = fp.adjustments.find((a) => a.code === adjustment)?.value

  // Memoized chain: `result` below can only be compiled when its `series`
  // dep holds a stable identity across renders.
  const hist = useMemo(
    () => data.monthly.filter((p) => cmp(p.revenue, '0') !== 0 || cmp(p.cogs, '0') !== 0),
    [data.monthly],
  )
  // The forecaster is a statistical model (smoothing/regression with
  // confidence bands): it consumes the documented one-way chart projection
  // of ledger history, like every other chart. Ratios pass through
  // unchanged; only money crosses the projection.
  const series = useMemo(
    () => hist.map((p) => {
      const v = p[METRIC_KEY[metric]]
      return typeof v === 'number' ? v : toChartNumber(v)
    }),
    [hist, metric],
  )

  // An unknown confidence level is a refusal, never the not-enough-history
  // empty state: the caught error carries the offending level, and the
  // branch below renders it with the levels that would work.
  const outcome = useMemo(() => {
    if (invalid || adjValue === undefined || series.length < 3) return null
    try {
      const r = applyForecastMethod(
        series,
        method as ForecastMethod,
        horizon,
        seasonality as Seasonality,
        confidence,
        null,
        {
          modelParams: {
            alpha: fp.model.alpha,
            beta: fp.model.beta,
            gamma: fp.model.gamma,
            dampedPhi: fp.model.dampedPhi,
            ma1: fp.model.ma1,
            minCorrelation: fp.model.minCorrelation,
            minPeriods: fp.model.minPeriods,
          },
          periodsPerYear: fp.periodsPerYear,
        },
      )
      r.values = applyForecastAdjustment(r.values, adjValue)
      return { result: r }
    } catch (e) {
      if (e instanceof UnknownConfidenceError) return { error: e }
      throw e
    }
  }, [series, invalid, adjValue, method, horizon, seasonality, confidence, fp])
  const result = outcome && 'result' in outcome ? outcome.result : null
  const confidenceError = outcome && 'error' in outcome ? outcome.error : null

  // The caveat input: whether the DISPLAYED (post-adjustment) central
  // projection leaves the metric's sign domain, and where it first does.
  const breach = useMemo(
    () => checkSignDomain(result?.values ?? [], METRIC_DOMAIN[metric]),
    [result, metric],
  )

  if (invalid || adjValue === undefined) {
    return (
      <Panel title={t('title')} icon={LineChart}>
        <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
          {t('unknownLevel', { field: invalid?.field ?? t('field.adjustment'), level: invalid?.level ?? adjustment, levels: invalid?.levels ?? '' })}
        </p>
      </Panel>
    )
  }

  // Non-monthly calendars label each projected bucket with the declared
  // fiscal period names the server sent. Too few (or none) declared means
  // the chart refuses by name — stepping calendar months would print buckets
  // the organization cannot reconcile to its periods. Settings stay on
  // screen offering only the horizons the declaration covers, so the
  // operator can pick a shorter horizon instead of only declaring periods.
  const declaredCount = fp.futurePeriodNames?.length
  const short = declaredCount !== undefined && declaredCount < horizon
  const offeredHorizons = declaredCount === undefined ? fp.horizons : fp.horizons.filter((h) => h <= declaredCount)

  if (confidenceError) {
    return (
      <Panel title={t('title')} icon={LineChart}>
        <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
          {t('unknownLevel', { field: t('field.confidence'), level: String(confidenceError.level), levels: fp.confidences.map((c) => t('confidencePct', { count: c })).join(', ') })}
        </p>
      </Panel>
    )
  }

  if (series.length < 3 || !result) {
    return <EmptyState icon={<LineChart size={28} />} title={t('emptyTitle')} description={t('emptyDescription')} />
  }

  const diag = diagnostics(series, result)
  const histLabels = hist.map((p) => p.label)
  const futLabels = (fp.futurePeriodNames ?? futureLabels(hist[hist.length - 1]!.month, horizon, (key, values) => tc(key, values))).slice(0, horizon)
  const labels = [...histLabels, ...futLabels]
  const N = series.length
  const history = [...series, ...Array(horizon).fill(null)]
  const forecast = [...Array(N - 1).fill(null), series[N - 1], ...result.values]
  const low = [...Array(N).fill(null), ...result.low]
  const high = [...Array(N).fill(null), ...result.high]

  const totalForecast = result.values.reduce((a, b) => a + b, 0)
  const endValue = result.values[horizon - 1]!
  const lastActual = series[N - 1]!
  // No base to grow from means no growth rate — never a 0% stand-in.
  const growth = lastActual !== 0 ? (endValue - lastActual) / Math.abs(lastActual) : null
  // Attached to every forecast surface below: the first out-of-domain month
  // and the translated metric name for the caveat copy.
  const breachMonth = breach.breached ? futLabels[breach.firstIndex]! : ''
  const metricName = tk(METRIC_KPI[metric])
  const modelName = to(`forecastMethod.${method}`)

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
      <div className="space-y-5 lg:col-span-3">
        {short && declaredCount !== undefined ? (
          <Panel title={t('title')} icon={LineChart}>
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <LineChart size={28} className="text-slate-300 dark:text-slate-600" />
              <p className="max-w-lg text-sm text-slate-500 dark:text-slate-400">
                {declaredCount > 0 ? t('shortFuturePeriods', { have: declaredCount, need: horizon }) : t('noFuturePeriods')}
              </p>
              {declaredCount > 0 ? (
                <p className="max-w-lg text-sm text-slate-500 dark:text-slate-400">
                  {t('shortHorizonHint', { have: declaredCount })}
                </p>
              ) : null}
              <Link href="/admin/setup/period-close" className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800">{t('declarePeriods')}</Link>
            </div>
          </Panel>
        ) : (
        <>
        <Panel
          title={t('title')}
          icon={LineChart}
          actions={
            <SegToggle
              value={metric}
              onChange={setMetric}
              options={[
                { value: 'revenue', label: tk('revenue') },
                { value: 'gm', label: tk('grossProfit') },
                { value: 'opinc', label: tk('operatingIncome') },
              ]}
            />
          }
        >
          {breach.breached ? (
            <p className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                <strong className="font-semibold">{t('domainCaveatTitle')}</strong>
                {' '}{t('domainCaveat', { metric: metricName, model: modelName, month: breachMonth })}
              </span>
            </p>
          ) : null}
          <ForecastChart labels={labels} history={history} forecast={forecast} low={low} high={high} height={320} />
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            <Stat label={t('total', { count: horizon })} value={fmtMoney(totalForecast, { compact: true })} />
            <Stat label={t('monthN', { count: horizon })} value={fmtMoney(endValue, { compact: true })} />
            <Stat label={t('growth')} value={growth === null ? '—' : breach.breached ? `${fmtPercent(growth)} *` : fmtPercent(growth)} tone={growth === null ? undefined : growth >= 0 ? 'pos' : 'neg'} />
          </div>
          {breach.breached ? (
            <p className="mt-2 text-[11px] leading-snug text-slate-400 dark:text-slate-500">
              {`* ${t('domainGrowthNote', { metric: metricName })}`}
            </p>
          ) : null}
        </Panel>

        <Panel title={t('detail')} icon={Table2} bodyClassName="p-0">
          <div className="max-h-72 overflow-y-auto">
            <SharedTable className="w-full text-sm">
              <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
                <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.month')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.forecast')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.low')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.high')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.conf')}</SharedTableHead>
                </SharedTableRow>
              </SharedTableHeader>
              <SharedTableBody>
                {result.values.map((v, i) => {
                  const outOfDomain = breach.breached && i >= breach.firstIndex
                  return (
                    <SharedTableRow key={i} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <SharedTableCell className="px-4 py-2 text-slate-700 dark:text-slate-300">{outOfDomain ? `⚠ ${futLabels[i]}` : futLabels[i]}</SharedTableCell>
                      <SharedTableCell className={`px-4 py-2 text-right font-medium tabular-nums ${outOfDomain ? 'text-amber-700 dark:text-amber-300' : 'text-slate-800 dark:text-slate-200'}`}>{fmtMoney(v)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtMoney(result.low[i]!)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtMoney(result.high[i]!)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-400 dark:text-slate-500">{t('confidencePct', { count: confidence })}</SharedTableCell>
                    </SharedTableRow>
                  )
                })}
              </SharedTableBody>
            </SharedTable>
          </div>
          {breach.breached ? (
            <p className="px-4 py-2 text-[11px] leading-snug text-slate-400 dark:text-slate-500">
              {`⚠ ${t('domainTableNote', { month: breachMonth })}`}
            </p>
          ) : null}
        </Panel>
        </>
        )}
      </div>

      <div className="space-y-5">
        <Panel title={t('settings')} icon={Cog}>
          <div className="space-y-3">
            <Field label={t('field.method')}>
              <Select value={method} onChange={(e) => setMethod(e.target.value)} triggerClassName={SELECT}>
                {fp.methods.filter(isMethod).map((m) => <option key={m} value={m}>{to(`forecastMethod.${m}`)}</option>)}
              </Select>
            </Field>
            <Field label={t('field.horizon')}>
              <Select value={String(horizon)} onChange={(e) => setHorizon(Number(e.target.value))} triggerClassName={SELECT} disabled={offeredHorizons.length === 0}>
                {offeredHorizons.map((h) => <option key={h} value={String(h)}>{t('horizonMonths', { count: h })}</option>)}
              </Select>
            </Field>
            <Field label={t('field.confidence')}>
              <Select value={String(confidence)} onChange={(e) => setConfidence(Number(e.target.value))} triggerClassName={SELECT}>
                {fp.confidences.map((c) => <option key={c} value={String(c)}>{t('confidencePct', { count: c })}</option>)}
              </Select>
            </Field>
            <Field label={t('field.seasonality')}>
              <Select value={seasonality} onChange={(e) => setSeasonality(e.target.value)} triggerClassName={SELECT}>
                {fp.seasonalities.filter(isSeasonality).map((s) => <option key={s} value={s}>{to(`forecastSeasonality.${s}`)}</option>)}
              </Select>
            </Field>
            <Field label={t('field.adjustment')}>
              <Select value={adjustment} onChange={(e) => setAdjustment(e.target.value)} triggerClassName={SELECT}>
                {fp.adjustments.map((a) => <option key={a.code} value={a.code}>{to(`forecastAdjustment.${a.code}`)}</option>)}
              </Select>
            </Field>
          </div>
        </Panel>

        <Panel title={t('diagnostics')} icon={Stethoscope} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            <Diag label={t('diag.mape')} value={fmtPercent(diag.mape / 100)} />
            <Diag label={t('diag.rmse')} value={fmtMoney(diag.rmse, { compact: true })} />
            <Diag label={t('diag.r2')} value={new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(diag.r2)} />
            <Diag label={t('diag.trend')} value={t(`trend.${diag.trendDir === 'Upward' ? 'up' : diag.trendDir === 'Downward' ? 'down' : 'flat'}`)} />
            <Diag label={t('diag.seasonality')} value={result.seasonal ? t('seasonDetected', { period: result.seasonalPeriod }) : t('seasonNone')} />
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
