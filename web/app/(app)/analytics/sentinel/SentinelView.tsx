'use client'

import { useAnalyticsTab, AnalyticsTabContent } from '../use-analytics-tab'

import { RecordTabs } from '@/components/module-home/record-tabs'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../../reports/ReportTable"
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  AlertTriangle, BarChart3, CalendarDays, CheckCircle2, Copy, FileWarning, Flag, Ghost,
  History, Info, ListOrdered, Scale, ShieldAlert, SlidersHorizontal, Sigma, Zap, Database, Download,
} from 'lucide-react'
import { cn, Badge, Drawer } from '@openbooks/ui'
import type { SentinelData, FlaggedDoc, DuplicateGroup } from '../../../../lib/analytics/sentinel-data'
import { RISK_SCORE_BANDS } from '../../../../lib/analytics/sentinel-scoring'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { Chart } from '../_ui/charts'
import { DrillDrawer, type DrillTarget } from '../_ui/DrillDrawer'
import { ConfigEditor } from '../_ui/ConfigEditor'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { exportCsv } from '../_ui/exportCsv'
import { useSort } from '../_ui/useSort'
import { TxnLink } from '../../reports/TxnLink'
import { escapeTooltipHtml, toChartNumber } from '../_ui/format'
import { useMoney } from '../../../../components/money-provider'
import { createMoneyFormatter, type MoneyValue } from '../../../../lib/money-format'
import { countLabel, dateLabel, decimalLabel } from '@/lib/format'
import { throwApiErrorIfNotOk } from '../../../../lib/api-error'
import { InteractiveTableRow } from '@/components/interactive-table-row'

/* ------------------------------------------------------------------ helpers */

const TABS = ['overview', 'benford', 'analysis', 'detection', 'vendors', 'audit', 'config'] as const
/** Viewer-locale integer grouping: one hook so every tab shares it. */
function useNum() {
  const locale = useLocale()
  return (n: number) => countLabel(n, locale)
}

/** Per-record money: a transaction amount always renders in ITS currency,
 * never the org currency. Translated consolidations use the presentation
 * formatter instead. Formatters are memoized per currency. */
function useTxnMoney() {
  const locale = useLocale()
  const cache = useRef(new Map<string, ReturnType<typeof createMoneyFormatter>>())
  return useCallback(
    (value: MoneyValue, currency: string) => {
      let fmt = cache.current.get(currency)
      if (!fmt) {
        fmt = createMoneyFormatter(locale, currency)
        cache.current.set(currency, fmt)
      }
      return fmt.money(value)
    },
    [locale],
  )
}

/** Locale-aware percent for ratios (0-1) — never toFixed + '%'. */
function useRatioPct() {
  const locale = useLocale()
  return useCallback(
    (ratio: number, digits = 1) =>
      new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(ratio),
    [locale],
  )
}

/** Locale-aware decimal with fixed fraction digits (MAD, seconds) — never toFixed. */
function useDecimals() {
  const locale = useLocale()
  return useCallback(
    (n: number, digits: number) =>
      new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n),
    [locale],
  )
}

/** Locale-aware calendar-day label for an ISO date — never raw ISO. */
function useDayLabel() {
  const locale = useLocale()
  return useCallback((isoDate: string) => dateLabel(new Date(`${isoDate}T00:00:00Z`), locale), [locale])
}

/** Severity, match and action codes always render translated, never raw. */
function useCodeWords() {
  const t = useTranslations('analytics.sentinel')
  const severity = useCallback(
    (code: string) =>
      code === 'critical' ? t('severity.critical')
      : code === 'high' ? t('severity.high')
      : code === 'medium' ? t('severity.medium')
      : code,
    [t],
  )
  const matchType = useCallback(
    (code: string) =>
      code === 'name+address' ? t('ghost.matchBoth')
      : code === 'address' ? t('ghost.matchAddress')
      : code === 'name' ? t('ghost.matchName')
      : code,
    [t],
  )
  const auditAction = useCallback(
    (code: string) => {
      const action = code.toLowerCase()
      return action === 'delete' ? t('auditAction.delete')
        : action === 'update' ? t('auditAction.update')
        : action === 'insert' ? t('auditAction.insert')
        : code
    },
    [t],
  )
  return useMemo(() => ({ severity, matchType, auditAction }), [severity, matchType, auditAction])
}

interface BenfordDrillDocument {
  date: string
  entryId: string | null
  docKind: string | undefined
  docId: string | null
  docNumber: string | null
  partyName: string | null
  amount: string
  currency?: string
}

interface BenfordDrillData {
  count: number
  total: string
  documents: BenfordDrillDocument[]
}



function RiskPill({ score }: { score: number }) {
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold tabular-nums', score >= 80 ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400' : score >= 60 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300')}>{score}</span>
}

/** Overall-risk gauge (Risk-meter, inverted: high = red). */
function RiskGauge({ score }: { score: number }) {
  const t = useTranslations('analytics.sentinel')
  // Band cut-offs come from the shared severity model, so the gauge and the
  // dashboard tiles agree on what a score means.
  const color = score >= RISK_SCORE_BANDS.high ? '#ef4444' : score >= RISK_SCORE_BANDS.elevated ? '#f97316' : score >= RISK_SCORE_BANDS.moderate ? '#f59e0b' : '#10b981'
  const label = score >= RISK_SCORE_BANDS.high ? t('risk.high') : score >= RISK_SCORE_BANDS.elevated ? t('risk.elevated') : score >= RISK_SCORE_BANDS.moderate ? t('risk.moderate') : t('risk.low')
  const arcLength = 141.37
  const offset = arcLength * (1 - Math.min(score, 100) / 100)
  return (
    <div className="flex h-full items-center gap-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <svg width="92" height="52" viewBox="0 0 100 55" className="shrink-0">
        <path d="M 5 50 A 45 45 0 0 1 95 50" fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round" className="text-slate-200 dark:text-slate-700" />
        <path d="M 5 50 A 45 45 0 0 1 95 50" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={arcLength} strokeDashoffset={offset} style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
      </svg>
      <div className="min-w-0">
        <p className="text-xl font-bold tabular-nums" style={{ color }}>{score}</p>
        <p className="text-[10px] font-bold tracking-wider" style={{ color }}>{label}</p>
        <p className="text-[10px] text-slate-400 dark:text-slate-500">{t('risk.caption')}</p>
      </div>
    </div>
  )
}

const KNOWN_KINDS = ['vendor_bill', 'vendor_credit', 'vendor_payment', 'check', 'expense_report', 'journal', 'customer_credit'] as const

function DocCell({ f }: { f: { docId: string; docNumber: string; kind: string } }) {
  const t = useTranslations('analytics.sentinel')
  const kindLabel = (k: string) => (KNOWN_KINDS as readonly string[]).includes(k) ? t(`kind.${k}`) : k
  return (
    <TxnLink entryId={f.docId} docKind={f.kind} docId={f.docId} className="font-medium text-teal-600 hover:underline dark:text-teal-400">
      {f.docNumber || kindLabel(f.kind)}
      <span className="ml-1.5 text-[10px] uppercase tracking-wide text-slate-400">{kindLabel(f.kind)}</span>
    </TxnLink>
  )
}

const FLAG_BADGE_CLS: Record<FlaggedDoc['flagType'], string> = {
  duplicate: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400',
  weekend: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-400',
  rsf: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400',
  zscore: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400',
  trap: 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400',
  sequential: 'bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-400',
}
const FLAGGED_TYPES = Object.keys(FLAG_BADGE_CLS)

function FlaggedTable({ items, showReason = true }: { items: FlaggedDoc[]; showReason?: boolean }) {
  const t = useTranslations('analytics.sentinel')
  const txnMoney = useTxnMoney()
  const dayLabel = useDayLabel()
  return (
    <div className="max-h-128 overflow-y-auto">
      <SharedTable className="w-full text-sm">
        <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
          <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.date')}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.document')}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.party')}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.currency')}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.amount')}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.flag')}</SharedTableHead>
            {showReason ? <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.reason')}</SharedTableHead> : null}
            <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.risk')}</SharedTableHead>
          </SharedTableRow>
        </SharedTableHeader>
        <SharedTableBody>
          {items.length ? items.map((f, i) => (
            <SharedTableRow key={`${f.docId}-${f.flagType}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
              <SharedTableCell className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{dayLabel(f.date)}</SharedTableCell>
              <SharedTableCell className="px-4 py-2"><DocCell f={f} /></SharedTableCell>
              <SharedTableCell className="max-w-44 truncate px-4 py-2 text-slate-600 dark:text-slate-300" title={f.partyName}>{f.partyName || '—'}</SharedTableCell>
              <SharedTableCell className="px-4 py-2 text-xs font-semibold tabular-nums text-slate-500 dark:text-slate-400">{f.currency}</SharedTableCell>
              <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{txnMoney(f.amount, f.currency)}</SharedTableCell>
              <SharedTableCell className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', FLAG_BADGE_CLS[f.flagType])}>{t(`flag.${f.flagType}`)}</span></SharedTableCell>
              {showReason ? <SharedTableCell className="max-w-72 truncate px-4 py-2 text-xs text-slate-400 dark:text-slate-500" title={f.reason}>{f.reason}</SharedTableCell> : null}
              <SharedTableCell className="px-4 py-2 text-right"><RiskPill score={f.riskScore} /></SharedTableCell>
            </SharedTableRow>
          )) : (
            <SharedTableRow><SharedTableCell colSpan={showReason ? 8 : 7} className="px-4 py-10 text-center text-sm text-slate-400"><CheckCircle2 size={20} className="mx-auto mb-1.5 text-emerald-500" />{t('empty.nothingFlagged')}</SharedTableCell></SharedTableRow>
          )}
        </SharedTableBody>
      </SharedTable>
    </div>
  )
}

function SubPills<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { key: T; label: string; count?: number }[] }) {
  const num = useNum()
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o.key} type="button" onClick={() => onChange(o.key)} className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors', value === o.key ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500 dark:bg-teal-950/50 dark:text-teal-300' : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800')}>
          {o.label}
          {o.count != null ? <span className={cn('rounded-full px-1.5 text-[10px] font-bold tabular-nums', o.count > 0 ? 'bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400' : 'bg-slate-100 text-slate-400 dark:bg-slate-800')}>{num(o.count)}</span> : null}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------- conformity codes to words */

/** Benford conformity travels as a code; every tab maps it the same way. */
function useConformLabel() {
  const t = useTranslations('analytics.sentinel')
  return (v: string) =>
    v === 'excellent' ? t('benford.excellent')
    : v === 'acceptable' ? t('benford.acceptable')
    : v === 'marginal' ? t('benford.marginal')
    : v === 'nonConforming' ? t('benford.nonConforming')
    : v === 'insufficient' ? t('benford.insufficient')
    : v
}

/* ------------------------------------------------------------------- shell */

export function SentinelView({ data: initialData, canConfigure }: { data: SentinelData; canConfigure?: boolean }) {
  const t = useTranslations('analytics.sentinel')
  const num = useNum()
  const dec = useDecimals()
  // Translated consolidations render in the presentation currency they were
  // translated into; transaction evidence renders in its own currency below.
  const presFmt = useMoney(data.meta.presentationCurrency)
  const money = (n: MoneyValue) => presFmt.moneyCompact(n)
  const conformLabel = useConformLabel()
  const read = useAnalyticsTab('sentinel', { data: initialData }, TABS)
  const { tab, setTab } = read
  const { data } = read.props
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const s = data.summary

  return (
    <div className="space-y-5">
      {/* Full-dataset proof banner — the anti-"artificial subset" statement. */}
      <p className="flex items-center gap-2 rounded-lg bg-slate-50 px-3.5 py-2 text-xs text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
        <Database size={13} className="shrink-0 text-teal-500" />
        {t('banner.pre')}<span className="font-semibold text-slate-700 dark:text-slate-200">{t('banner.ledger')}</span>
        {` `}{t('banner.stats', { docs: num(data.meta.totalDocs), amount: money(data.meta.totalAmount), days: num(data.meta.days), seconds: dec(data.meta.queryMs / 1000, 1) })}
      </p>
      <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>{t('basis.note', { currency: data.meta.presentationCurrency })}</span>
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <RiskGauge score={s.overallRiskScore} />
        <KpiCard icon={Flag} accent={s.flaggedCount > 0 ? 'red' : 'emerald'} label={t('kpi.flagged')} value={num(s.flaggedCount)} sub={t('sub.atRisk', { amount: money(s.totalAtRisk) })} tone={s.flaggedCount > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={Copy} accent="amber" label={t('kpi.duplicatePairs')} value={num(s.duplicateCount)} sub={money(s.totalDuplicateAmount)} tone={s.duplicateCount > 0 ? 'negative' : 'neutral'} />
        <KpiCard icon={BarChart3} accent={s.benfordConformity === 'nonConforming' ? 'red' : s.benfordConformity === 'marginal' ? 'amber' : 'emerald'} label={t('kpi.benford')} value={conformLabel(s.benfordConformity)} sub={t('sub.twoD', { value: conformLabel(s.benford2DConformity) })} />
        <KpiCard icon={ShieldAlert} accent={s.ghostCount + s.sequentialGroups > 0 ? 'red' : 'emerald'} label={t('kpi.shellSignals')} value={num(s.ghostCount + s.sequentialGroups)} sub={t('sub.ghostsSequential', { ghosts: s.ghostCount, sequential: s.sequentialGroups })} tone={s.ghostCount + s.sequentialGroups > 0 ? 'negative' : 'positive'} />
      </div>
      {s.excludedDetectors.length > 0 ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{t('risk.excludedNote', { detectors: s.excludedDetectors.join(', ') })}</span>
        </p>
      ) : null}

      <RecordTabs label={t('title')} tabs={TABS.map((k) => ({ key: k, label: t(`tabs.${k}`), count: k === 'detection' ? s.flaggedCount : undefined }))} active={tab} onChange={setTab}>
      <AnalyticsTabContent loading={read.loading} error={read.error} retry={read.retry}>
      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} /> : null}
        {tab === 'benford' ? <BenfordTab data={data} /> : null}
        {tab === 'analysis' ? <AnalysisTab data={data} /> : null}
        {tab === 'detection' ? <DetectionTab data={data} /> : null}
        {tab === 'vendors' ? <VendorsTab data={data} onDrill={setDrill} /> : null}
        {tab === 'audit' ? <AuditTab data={data} /> : null}
        {tab === 'config' ? <ConfigTab data={data} canEdit={canConfigure ?? false} /> : null}
      </div>
            </AnalyticsTabContent>
      </RecordTabs>

      <DrillDrawer target={drill} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} />
    </div>
  )
}

/* ---------------------------------------------------------------- Overview */

function OverviewTab({ data }: { data: SentinelData }) {
  const t = useTranslations('analytics.sentinel')
  const num = useNum()
  const dec = useDecimals()
  const pct = useRatioPct()
  const conformLabel = useConformLabel()
  const words = useCodeWords()
  const s = data.summary
  const b = data.benford1D
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Panel title={t('panels.benfordFirstDigit')} icon={BarChart3} hint={t('panels.benfordHint', { amounts: num(b.totalTransactions), mad: dec(b.mad, 4), conformity: conformLabel(b.conformity) })}>
            <Chart
              height={230}
              option={{
                grid: { top: 24, bottom: 24, left: 45, right: 12 },
                legend: { top: 0 },
                tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => pct(Number(v)) },
                xAxis: { type: 'category', data: b.digits.map((d) => String(d.digit)) },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => pct(v, 0) } },
                series: [
                  { name: t('chart.observed'), type: 'bar', data: b.digits.map((d) => ({ value: d.observed, itemStyle: { color: d.isAnomaly ? '#ef4444' : '#14b8a6' } })) },
                  { name: t('chart.expectedBenford'), type: 'line', data: b.digits.map((d) => d.expected), symbolSize: 6, lineStyle: { width: 2, type: 'dashed', color: '#64748b' }, itemStyle: { color: '#64748b' } },
                ],
              }}
            />
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{b.message}</p>
          </Panel>
          <Panel title={t('panels.highestRiskFlags')} icon={Flag} hint={t('panels.highestRiskHint')} bodyClassName="p-0">
            <FlaggedTable items={data.flagged.slice(0, 10)} />
          </Panel>
        </div>
        <div className="space-y-5">
          <Panel title={t('panels.topRiskAreas')} icon={AlertTriangle} bodyClassName="p-0">
            {s.topRiskAreas.length ? (
              <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
                {s.topRiskAreas.map((a) => (
                  <li key={a.area} className="flex items-start gap-2.5 px-4 py-3">
                    <AlertTriangle size={15} className={cn('mt-0.5 shrink-0', a.severity === 'critical' ? 'text-rose-500' : a.severity === 'high' ? 'text-amber-500' : 'text-sky-500')} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">{a.area}<Badge variant={a.severity === 'critical' ? 'destructive' : a.severity === 'high' ? 'warning' : 'secondary'}>{words.severity(a.severity)}</Badge></div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{a.message}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 px-4 py-6 text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={15} />{t('empty.noElevatedRisk')}</p>
            )}
          </Panel>
          <Panel title={t('panels.detectorSummary')} icon={ShieldAlert}>
            <div className="grid grid-cols-2 gap-2 text-center">
              {[
                { label: t('detectors.duplicates'), value: num(s.duplicateCount), active: s.duplicateCount > 0 },
                { label: t('flag.weekend'), value: num(s.weekendCount), active: s.weekendCount > 0 },
                { label: t('flag.rsf'), value: num(s.rsfCount), active: s.rsfCount > 0 },
                { label: t('flag.zscore'), value: num(s.zScoreCount), active: s.zScoreCount > 0 },
                { label: t('flag.sequential'), value: num(s.sequentialGroups), active: s.sequentialGroups > 0 },
                { label: t('detectors.ghostVendors'), value: num(s.ghostCount), active: s.ghostCount > 0 },
                { label: t('flag.trap'), value: num(s.trapCount), active: s.trapCount > 0 },
                { label: t('detectors.auditEvents'), value: num(data.auditTrail.total), active: data.auditTrail.deletes > 0 },
              ].map((tile) => (
                <div key={tile.label} className={cn('rounded-lg p-2.5', tile.active ? 'bg-slate-100 dark:bg-slate-800' : 'bg-slate-50/60 dark:bg-slate-800/40')}>
                  <p className="text-lg font-bold tabular-nums text-slate-800 dark:text-slate-200">{tile.value}</p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500">{tile.label}</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- Benford */

function BenfordTab({ data }: { data: SentinelData }) {
  const t = useTranslations('analytics.sentinel')
  const num = useNum()
  const presFmt = useMoney(data.meta.presentationCurrency)
  const txnMoney = useTxnMoney()
  const ratioPct = useRatioPct()
  const dec = useDecimals()
  // Digit amounts are transaction sums in the slice currency; trap totals
  // are translated consolidations in the presentation currency.
  const digitMoney = (n: MoneyValue, ccy: string) => txnMoney(n, ccy)
  const money = (n: MoneyValue) => presFmt.moneyCompact(n)
  const conformLabel = useConformLabel()
  const [sub, setSub] = useState<'1d' | '2d' | 'trap'>('1d')
  const [drill, setDrill] = useState<{ digit: number; dim: '1d' | '2d' } | null>(null)
  // Benford runs one distribution per document currency: the pills pick the
  // slice, defaulting to the largest. The legacy top-level shape is the
  // fallback for an empty period.
  const slices = data.benford1D.byCurrency
  const [ccy, setCcy] = useState<string | undefined>(slices[0]?.currency)
  const activeCcy = slices.some((s) => s.currency === ccy) ? ccy : slices[0]?.currency
  const b1 = slices.find((s) => s.currency === activeCcy) ?? data.benford1D
  const b2 = data.benford2D.byCurrency.find((s) => s.currency === activeCcy) ?? data.benford2D
  const trap = data.thresholdTrap
  return (
    <div className="space-y-4">
      <SubPills value={sub} onChange={setSub} options={[
        { key: '1d', label: t('benford.firstDigit1D') },
        { key: '2d', label: t('benford.firstTwoDigits2D'), count: b2.anomalies.length },
        { key: 'trap', label: t('benford.thresholdTrap'), count: trap.total },
      ]} />
      {sub !== 'trap' && slices.length > 0 ? (
        <SubPills value={activeCcy ?? ''} onChange={setCcy} options={slices.map((s) => ({ key: s.currency, label: s.currency, count: s.totalTransactions }))} />
      ) : null}
      {drill ? <BenfordDrill digit={drill.digit} dim={drill.dim} currency={sub === 'trap' ? undefined : activeCcy} presCcy={data.meta.presentationCurrency} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} /> : null}

      {sub === '1d' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard icon={Sigma} accent="sky" label={t('kpi.amountsAnalyzed')} value={num(b1.totalTransactions)} sub={t('sub.everyDocument')} />
            <KpiCard icon={Scale} accent={b1.conformity === 'nonConforming' ? 'red' : b1.conformity === 'marginal' ? 'amber' : 'emerald'} label={t('kpi.conformity')} value={conformLabel(b1.conformity)} sub={t('sub.madValue', { value: dec(b1.mad, 4) })} />
            <KpiCard icon={AlertTriangle} accent="amber" label={t('kpi.deviatingDigits')} value={num(b1.digits.filter((d) => d.isAnomaly).length)} sub={t('sub.offExpected25')} />
            <KpiCard icon={BarChart3} accent="violet" label={t('kpi.digit1Share')} value={ratioPct(b1.digits[0]?.observed ?? 0)} sub={t('sub.expected301')} />
          </div>
          <Panel title={t('panels.observedVsExpected')} icon={BarChart3}>
            <Chart
              height={280}
              option={{
                grid: { top: 24, bottom: 24, left: 45, right: 12 },
                legend: { top: 0 },
                tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => ratioPct(Number(v), 2) },
                xAxis: { type: 'category', data: b1.digits.map((d) => String(d.digit)) },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => ratioPct(v, 0) } },
                series: [
                  { name: t('chart.observed'), type: 'bar', data: b1.digits.map((d) => ({ value: d.observed, itemStyle: { color: d.isAnomaly ? '#ef4444' : '#14b8a6' } })) },
                  { name: t('chart.expected'), type: 'line', data: b1.digits.map((d) => d.expected), symbolSize: 6, lineStyle: { width: 2, type: 'dashed', color: '#64748b' }, itemStyle: { color: '#64748b' } },
                ],
              }}
            />
          </Panel>
          <Panel title={t('panels.digitDetail')} icon={ListOrdered} hint={t('panels.digitDetailHint')} bodyClassName="p-0">
            <SharedTable className="w-full text-sm">
              <SharedTableHeader>
                <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.digit')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.count')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.amount')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('chart.observed')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('chart.expected')}</SharedTableHead>
                  <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.deviation')}</SharedTableHead>
                </SharedTableRow>
              </SharedTableHeader>
              <SharedTableBody>
                {b1.digits.map((d) => (
                  <InteractiveTableRow key={d.digit} onClick={() => setDrill({ digit: d.digit, dim: '1d' })} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30" noAnimate>
                    <SharedTableCell className="px-4 py-2 font-bold text-slate-800 dark:text-slate-200">{d.digit}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{num(d.count)}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{digitMoney(d.amount, activeCcy ?? data.meta.presentationCurrency)}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{ratioPct(d.observed, 2)}</SharedTableCell>
                    <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-400">{ratioPct(d.expected, 2)}</SharedTableCell>
                    <SharedTableCell className={cn('px-4 py-2 text-right font-semibold tabular-nums', d.isAnomaly ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400')}>{d.deviationPct > 0 ? '+' : ''}{ratioPct(Math.abs(d.deviationPct) / 100)}</SharedTableCell>
                  </InteractiveTableRow>
                ))}
              </SharedTableBody>
            </SharedTable>
          </Panel>
        </div>
      ) : null}

      {sub === '2d' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard icon={Sigma} accent="sky" label={t('kpi.amountsAnalyzed')} value={num(b2.totalTransactions)} sub={t('sub.twoDigitPairs')} />
            <KpiCard icon={Scale} accent={b2.conformity === 'nonConforming' ? 'red' : b2.conformity === 'marginal' ? 'amber' : 'emerald'} label={t('kpi.conformity')} value={conformLabel(b2.conformity)} sub={t('sub.madValue', { value: dec(b2.mad, 4) })} />
            <KpiCard icon={AlertTriangle} accent={b2.anomalies.length > 0 ? 'amber' : 'emerald'} label={t('kpi.anomalousPairs')} value={num(b2.anomalies.length)} sub={t('sub.offExpected50')} />
            <KpiCard icon={FileWarning} accent={data.summary.approvalLimitRisk ? 'red' : 'emerald'} label={t('kpi.approvalLimitRisk')} value={data.summary.approvalLimitRisk ? t('yes') : t('no')} sub={t('sub.seeThresholdTrap')} />
          </div>
          <Panel title={t('panels.twoDigitDistribution')} icon={BarChart3}>
            <Chart
              height={280}
              option={{
                grid: { top: 24, bottom: 24, left: 45, right: 12 },
                legend: { top: 0 },
                tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => ratioPct(Number(v), 2) },
                xAxis: { type: 'category', data: b2.digits.map((d) => String(d.digit)), axisLabel: { interval: 9 } },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => ratioPct(v, 1) } },
                series: [
                  { name: t('chart.observed'), type: 'bar', barCategoryGap: '10%', data: b2.digits.map((d) => ({ value: d.observed, itemStyle: { color: d.isAnomaly && d.count >= 5 ? '#ef4444' : '#14b8a6' } })) },
                  { name: t('chart.expected'), type: 'line', data: b2.digits.map((d) => d.expected), symbol: 'none', lineStyle: { width: 1.5, type: 'dashed', color: '#64748b' } },
                ],
              }}
            />
          </Panel>
          {b2.anomalies.length ? (
            <Panel title={t('panels.anomalousPairs')} icon={AlertTriangle} bodyClassName="p-0">
              <SharedTable className="w-full text-sm">
                <SharedTableHeader>
                  <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.digits')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.count')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.amount')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.deviation')}</SharedTableHead>
                  </SharedTableRow>
                </SharedTableHeader>
                <SharedTableBody>
                  {b2.anomalies.slice(0, 15).map((d) => (
                    <SharedTableRow key={d.digit} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <SharedTableCell className="px-4 py-2 font-bold text-slate-800 dark:text-slate-200">{d.digit}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{num(d.count)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{digitMoney(d.amount, activeCcy ?? data.meta.presentationCurrency)}</SharedTableCell>
                      <SharedTableCell className={cn('px-4 py-2 text-right font-semibold tabular-nums', 'text-rose-600 dark:text-rose-400')}>{d.deviationPct > 0 ? '+' : ''}{ratioPct(Math.abs(d.deviationPct) / 100, 0)}</SharedTableCell>
                    </SharedTableRow>
                  ))}
                </SharedTableBody>
              </SharedTable>
            </Panel>
          ) : null}
        </div>
      ) : null}

      {sub === 'trap' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard icon={FileWarning} accent={trap.total > 0 ? 'red' : 'emerald'} label={t('kpi.trapAmounts')} value={num(trap.total)} sub={t('sub.ending99')} tone={trap.total > 0 ? 'negative' : 'positive'} />
            <KpiCard icon={Scale} accent="amber" label={t('kpi.totalValue')} value={money(trap.totalAmount)} sub={t('sub.limitGaming')} />
            {trap.byTrap.map((bt) => (
              <KpiCard key={bt.trap} icon={Zap} accent="violet" label={t('kpi.endsIn', { ending: bt.trap })} value={num(bt.count)} sub={money(bt.amount)} />
            ))}
          </div>
          <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>{t('trapNote')}</span>
          </p>
          {trap.unavailable ? (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{trap.unavailable}</span>
            </p>
          ) : null}
          <Panel title={t('panels.thresholdTrapDocs')} icon={FileWarning} bodyClassName="p-0">
            <FlaggedTable items={trap.items} showReason={false} />
          </Panel>
        </div>
      ) : null}
    </div>
  )
}

/** Benford digit → transactions drill (scoped to the active currency slice). */
function BenfordDrill({ digit, dim, currency, presCcy, from, to, onClose }: { digit: number; dim: '1d' | '2d'; currency?: string; presCcy: string; from: string; to: string; onClose: () => void }) {
  const t = useTranslations('analytics.sentinel')
  const locale = useLocale()
  const num = useNum()
  const fmtDate = (d: string) => dateLabel(new Date(d + 'T00:00:00Z'), locale)
  const txnMoney = useTxnMoney()
  // Drill rows carry their own currency; the summed total is only shown for
  // a single-currency drill, never for a mixed-currency one.
  const money = (n: string, ccy: string) => txnMoney(n, ccy)
  const [data, setData] = useState<BenfordDrillData | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const scope = currency ? `&currency=${encodeURIComponent(currency)}` : ''
    fetch(`/api/analytics/sentinel/benford?digit=${digit}&dim=${dim}&from=${from}&to=${to}${scope}`)
      .then(async (r) => {
        await throwApiErrorIfNotOk(r, t('drill.loadFailed'))
        return r.json()
      })
      .then((j) => { if (live) setData(j) })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : t('drill.loadFailed')) })
    return () => { live = false }
  }, [digit, dim, currency, from, to, t])


  return (
    <Drawer open onClose={onClose} size="lg" title={`${dim === '2d' ? t('drill.firstTwoDigits') : t('drill.leadingDigit')}: ${digit}`} description={data ? `${currency ? t('drill.documentsTotal', { count: num(data.count), total: money(String(data.total), currency) }) : t('drill.documentsCount', { count: num(data.count) })}${data.count > data.documents.length ? ` (${t('drill.top', { count: data.documents.length })})` : ''}` : t('loading')} bodyClassName="overflow-hidden flex flex-col p-0">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="p-6 text-center text-sm text-slate-400">{error}</p>
        ) : !data ? (
          <p className="p-6 text-center text-sm text-slate-400">{t('loading')}</p>
        ) : data.documents.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-400">{t('drill.noDocuments', { digit })}</p>
        ) : (
          <SharedTable className="w-full text-sm">
            <SharedTableHeader className="sticky top-0 z-10 bg-white dark:bg-slate-900">
              <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.date')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.document')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.party')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.currency')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.amount')}</SharedTableHead>
              </SharedTableRow>
            </SharedTableHeader>
            <SharedTableBody>
              {data.documents.map((d, k) => (
                <SharedTableRow key={k} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                  <SharedTableCell className="px-4 py-1.5 whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">{fmtDate(d.date)}</SharedTableCell>
                  <SharedTableCell className="px-4 py-1.5"><TxnLink entryId={d.entryId ?? ''} docKind={d.docKind} docId={d.docId} className="font-medium text-slate-700 hover:text-teal-600 dark:text-slate-200 dark:hover:text-teal-400">{d.docNumber || d.docKind}</TxnLink></SharedTableCell>
                  <SharedTableCell className="max-w-48 truncate px-4 py-1.5 text-slate-500 dark:text-slate-400" title={d.partyName ?? undefined}>{d.partyName || '—'}</SharedTableCell>
                  <SharedTableCell className="px-4 py-1.5 text-xs font-semibold tabular-nums text-slate-500 dark:text-slate-400">{d.currency ?? '—'}</SharedTableCell>
                  <SharedTableCell className="px-4 py-1.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(d.amount, d.currency ?? presCcy)}</SharedTableCell>
                </SharedTableRow>
              ))}
            </SharedTableBody>
          </SharedTable>
        )}
      </div>
    </Drawer>
  )
}

/* ---------------------------------------------------------------- Analysis */

function AnalysisTab({ data }: { data: SentinelData }) {
  const t = useTranslations('analytics.sentinel')
  const locale = useLocale()
  const num = useNum()
  const presFmt = useMoney(data.meta.presentationCurrency)
  const txnMoney = useTxnMoney()
  const dayLabel = useDayLabel()
  const [sub, setSub] = useState<'rsf' | 'zscore' | 'calendar'>('rsf')

  const calendarOption = useMemo(() => {
    // Chart coordinates cross into numbers here via toChartNumber — the only
    // sanctioned crossing. Calendar amounts are translated consolidations.
    const byYear = new Map<string, [string, number][]>()
    for (const c of data.calendar) {
      const y = c.date.slice(0, 4)
      if (!byYear.has(y)) byYear.set(y, [])
      byYear.get(y)!.push([c.date, toChartNumber(c.amount)])
    }
    const years = [...byYear.keys()].sort().slice(-2) // show up to 2 most recent years
    const max = Math.max(...data.calendar.map((c) => toChartNumber(c.amount)), 1)
    return {
      tooltip: { formatter: (p: { data: [string, number] }) => `${escapeTooltipHtml(p.data[0])}<br/>${presFmt.money(p.data[1])}` },
      visualMap: { min: 0, max, orient: 'horizontal' as const, left: 'center', top: 0, inRange: { color: ['#e2e8f0', '#99f6e4', '#14b8a6', '#f59e0b', '#ef4444'] }, formatter: (v: number) => presFmt.moneyCompact(v) },
      calendar: years.map((y, i) => ({
        range: y, top: 60 + i * 150, left: 40, right: 10, cellSize: ['auto', 13] as [string, number],
        itemStyle: { borderColor: 'rgba(148,163,184,0.15)', borderWidth: 1 },
        splitLine: { lineStyle: { color: 'rgba(148,163,184,0.4)' } },
        dayLabel: { color: '#94a3b8', fontSize: 10 }, monthLabel: { color: '#94a3b8', fontSize: 10 }, yearLabel: { color: '#64748b', fontSize: 12 },
      })),
      series: years.map((y, i) => ({ type: 'heatmap' as const, coordinateSystem: 'calendar' as const, calendarIndex: i, data: byYear.get(y) })),
    }
  }, [data.calendar, presFmt])

  return (
    <div className="space-y-4">
      <SubPills value={sub} onChange={setSub} options={[
        { key: 'rsf', label: t('analysis.rsfFull'), count: data.rsf.total },
        { key: 'zscore', label: t('flag.zscore'), count: data.zscore.total },
        { key: 'calendar', label: t('analysis.calendar') },
      ]} />

      {sub === 'rsf' ? (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span><span className="font-semibold">{t('flag.rsf')}</span>{t('analysis.rsfNote', { months: data.config.baselineMonths, threshold: data.config.rsfThreshold })}</span>
          </p>
          {data.rsf.unavailable ? (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{data.rsf.unavailable}</span>
            </p>
          ) : null}
          <Panel title={t('panels.rsfAnomalies', { count: num(data.rsf.total) })} icon={Scale} bodyClassName="p-0">
            <div className="max-h-128 overflow-y-auto">
              <SharedTable className="w-full text-sm">
                <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
                  <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.date')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.document')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.vendor')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.currency')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.amount')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.secondLargest')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('flag.rsf')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.risk')}</SharedTableHead>
                  </SharedTableRow>
                </SharedTableHeader>
                <SharedTableBody>
                  {data.rsf.items.map((r, i) => (
                    <SharedTableRow key={`${r.docId}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <SharedTableCell className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{dayLabel(r.date)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2"><DocCell f={r} /></SharedTableCell>
                      <SharedTableCell className="max-w-44 truncate px-4 py-2 text-slate-600 dark:text-slate-300" title={r.partyName}>{r.partyName}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-xs font-semibold tabular-nums text-slate-500 dark:text-slate-400">{r.currency}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{txnMoney(r.amount, r.currency)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-400">{txnMoney(r.secondLargest, r.currency)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right font-bold tabular-nums text-amber-600 dark:text-amber-400">{decimalLabel(r.rsf, locale, 1, 1)}×</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right"><RiskPill score={r.riskScore} /></SharedTableCell>
                    </SharedTableRow>
                  ))}
                </SharedTableBody>
              </SharedTable>
            </div>
          </Panel>
        </div>
      ) : null}

      {sub === 'zscore' ? (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span><span className="font-semibold">{t('analysis.zscoreWord')}</span>{t('analysis.zscoreNote', { months: data.config.baselineMonths, threshold: data.config.zscoreThreshold })}</span>
          </p>
          {data.zscore.unavailable ? (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{data.zscore.unavailable}</span>
            </p>
          ) : null}
          <Panel title={t('panels.zscoreAnomalies', { count: num(data.zscore.total) })} icon={Sigma} bodyClassName="p-0">
            <div className="max-h-128 overflow-y-auto">
              <SharedTable className="w-full text-sm">
                <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
                  <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.date')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.document')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.party')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.currency')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.amount')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.partyAvg')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.z')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.risk')}</SharedTableHead>
                  </SharedTableRow>
                </SharedTableHeader>
                <SharedTableBody>
                  {data.zscore.items.map((z, i) => (
                    <SharedTableRow key={`${z.docId}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <SharedTableCell className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{dayLabel(z.date)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2"><DocCell f={z} /></SharedTableCell>
                      <SharedTableCell className="max-w-44 truncate px-4 py-2 text-slate-600 dark:text-slate-300" title={z.partyName}>{z.partyName}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-xs font-semibold tabular-nums text-slate-500 dark:text-slate-400">{z.currency}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{txnMoney(z.amount, z.currency)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-400">{txnMoney(z.vendorAvg, z.currency)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right font-bold tabular-nums text-sky-600 dark:text-sky-400">{decimalLabel(z.zScore, locale, 1, 1)}σ</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right"><RiskPill score={z.riskScore} /></SharedTableCell>
                    </SharedTableRow>
                  ))}
                </SharedTableBody>
              </SharedTable>
            </div>
          </Panel>
        </div>
      ) : null}

      {sub === 'calendar' ? (
        <Panel title={t('panels.spendCalendar')} icon={CalendarDays} hint={t('panels.spendCalendarHint')}>
          <Chart option={(calendarOption)} height={Math.min(2, new Set(data.calendar.map((c) => c.date.slice(0, 4))).size) * 150 + 80} />
        </Panel>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- Detection */

function DetectionTab({ data }: { data: SentinelData }) {
  const t = useTranslations('analytics.sentinel')
  const num = useNum()
  const today = useBusinessToday()
  const presFmt = useMoney(data.meta.presentationCurrency)
  const txnMoney = useTxnMoney()
  const dayLabel = useDayLabel()
  const ratioPct = useRatioPct()
  const words = useCodeWords()
  // Consolidated duplicate value renders translated; pair and member
  // amounts render in their own transaction currency.
  const money = (n: MoneyValue) => presFmt.moneyCompact(n)
  const [sub, setSub] = useState<'flagged' | 'duplicates' | 'weekend' | 'sequential' | 'ghost'>('flagged')
  const s = data.summary
  const kindLabel = (k: string) => (KNOWN_KINDS as readonly string[]).includes(k) ? t(`kind.${k}`) : k
  return (
    <div className="space-y-4">
      <SubPills value={sub} onChange={setSub} options={[
        { key: 'flagged', label: t('detection.allFlagged'), count: s.flaggedCount },
        { key: 'duplicates', label: t('detectors.duplicates'), count: s.duplicateCount },
        { key: 'weekend', label: t('flag.weekend'), count: s.weekendCount },
        { key: 'sequential', label: t('flag.sequential'), count: s.sequentialGroups },
        { key: 'ghost', label: t('detectors.ghostVendors'), count: s.ghostCount },
      ]} />

      {sub === 'flagged' ? (
        <Panel
          title={t('panels.allFlaggedDocs', { top: num(Math.min(300, s.flaggedCount)), total: num(s.flaggedCount) })}
          icon={Flag}
          bodyClassName="p-0"
          actions={
            <button
              type="button"
              onClick={() => exportCsv('flagged-documents', [t('table.date'), t('table.document'), t('csv.kind'), t('table.party'), t('table.amount'), t('table.flag'), t('table.risk'), t('table.reason')], data.flagged.map((f) => [f.date, f.docNumber, f.kind, f.partyName, f.amount, f.flagType, f.riskScore, f.reason]), today)}
              className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              <Download size={11} /> {t('csv.label')}
            </button>
          }
        >
          <FlaggedTable items={data.flagged} />
        </Panel>
      ) : null}

      {sub === 'duplicates' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <KpiCard icon={Copy} accent="red" label={t('kpi.duplicatePairs')} value={num(data.duplicates.total)} sub={t('sub.allMatchingPairs')} tone="negative" />
            <KpiCard icon={Scale} accent="amber" label={t('kpi.valueAtRisk')} value={money(s.totalDuplicateAmount)} sub={t('sub.sumPairAmounts')} />
            <KpiCard icon={Info} accent="slate" label={t('kpi.rule')} value={t('duplicates.ruleValue', { days: data.config.duplicateDays! })} sub={data.duplicates.unavailable ?? t('duplicates.ruleNote', { min: money(data.config.duplicateMinAmount!) })} />
          </div>
          {data.duplicates.unavailable ? (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{data.duplicates.unavailable}</span>
            </p>
          ) : null}
          <Panel title={t('panels.potentialDuplicates')} icon={Copy} hint={t('panels.duplicatesHint')} bodyClassName="p-0">
            <div className="max-h-128 overflow-y-auto">
              <SharedTable className="w-full text-sm">
                <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
                  <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.vendor')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.members')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.currency')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.amount')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.span')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.confidence')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.risk')}</SharedTableHead>
                  </SharedTableRow>
                </SharedTableHeader>
                <SharedTableBody>
                  {data.duplicates.groups.map((g: DuplicateGroup) => (
                    <SharedTableRow key={g.groupId} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <SharedTableCell className="max-w-44 truncate px-4 py-2 font-medium text-slate-800 dark:text-slate-200" title={g.partyName}>{g.partyName}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2">
                        <span className="flex flex-wrap gap-1.5">
                          {g.members.slice(0, 8).map((m) => (
                            <TxnLink key={m.docId} entryId={m.docId} docKind={g.kind} docId={m.docId} className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:border-teal-400 hover:text-teal-600 dark:border-slate-700 dark:text-slate-300 dark:hover:text-teal-400">
                              <span className="font-semibold">{m.docNumber || kindLabel(g.kind)}</span>
                              {` · `}<span className="tabular-nums">{dayLabel(m.date)}</span>
                            </TxnLink>
                          ))}
                          {g.count > 8 ? <span className="px-2 py-1 text-xs text-slate-400">{t('sequential.more', { count: g.count - 8 })}</span> : null}
                        </span>
                        {g.sameReference && g.members[0]?.reference ? <span className="mt-1 block text-[10px] text-slate-400">{t('duplicates.sharedReference', { reference: g.members[0].reference })}</span> : null}
                      </SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-xs font-semibold tabular-nums text-slate-500 dark:text-slate-400">{g.currency}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{txnMoney(g.amount, g.currency)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{t('duplicates.spanDays', { days: num(g.dateSpanDays) })}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{ratioPct(g.confidence, 0)}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right"><RiskPill score={g.riskScore} /></SharedTableCell>
                    </SharedTableRow>
                  ))}
                </SharedTableBody>
              </SharedTable>
            </div>
          </Panel>
        </div>
      ) : null}

      {sub === 'weekend' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard icon={CalendarDays} accent="violet" label={t('kpi.weekendDocuments')} value={num(data.weekend.total)} sub={money(data.weekend.totalAmount)} />
            <KpiCard icon={CalendarDays} accent="sky" label={t('kpi.saturday')} value={num(data.weekend.saturday)} sub={t('sub.documents')} />
            <KpiCard icon={CalendarDays} accent="amber" label={t('kpi.sunday')} value={num(data.weekend.sunday)} sub={t('sub.higherRiskWeighting')} />
            <KpiCard icon={Info} accent="slate" label={t('kpi.signal')} value={t('weekend.signalValue')} sub={t('weekend.signalNote')} />
          </div>
          <Panel title={t('panels.weekendDated')} icon={CalendarDays} bodyClassName="p-0">
            <FlaggedTable items={data.weekend.items} showReason={false} />
          </Panel>
        </div>
      ) : null}

      {sub === 'sequential' ? (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span><span className="font-semibold">{t('sequential.indicatorTitle')}</span>{t('sequential.indicatorNote1')}<em>{t('sequential.only')}</em>{t('sequential.indicatorNote2')}</span>
          </p>
          <div className="space-y-4">
            {data.sequential.length ? data.sequential.map((g, i) => (
              <Panel key={`${g.partyId}-${g.currency}-${i}`} title={g.partyName} icon={ListOrdered} actions={<span className="flex items-center gap-1.5"><Badge variant="secondary">{g.currency}</Badge><Badge variant={g.riskLevel === 'high' ? 'destructive' : 'warning'}>{words.severity(g.riskLevel)} · {g.riskScore}</Badge></span>}>
                <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">{g.reason}{t('sequential.runTotal', { total: presFmt.money(g.totalAmount), first: dayLabel(g.firstDate), last: dayLabel(g.lastDate) })}</p>
                <div className="flex flex-wrap gap-1.5">
                  {g.invoices.map((inv) => (
                    <TxnLink key={inv.docId} entryId={inv.docId} docKind="vendor_bill" docId={inv.docId} className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:border-teal-400 hover:text-teal-600 dark:border-slate-700 dark:text-slate-300 dark:hover:text-teal-400">
                      <span className="font-semibold">#{inv.reference}</span> · {txnMoney(inv.amount, inv.currency)} {inv.currency} · <span className="tabular-nums">{dayLabel(inv.date)}</span>
                    </TxnLink>
                  ))}
                  {g.count > g.invoices.length ? <span className="px-2 py-1 text-xs text-slate-400">{t('sequential.more', { count: g.count - g.invoices.length })}</span> : null}
                </div>
              </Panel>
            )) : (
              <Panel title={t('panels.sequentialRuns')} icon={ListOrdered}><p className="py-6 text-center text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={18} className="mx-auto mb-1.5" />{t('empty.noSequential')}</p></Panel>
            )}
          </div>
        </div>
      ) : null}

      {sub === 'ghost' ? (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span><span className="font-semibold">{t('ghost.title')}</span>{t('ghost.note')}</span>
          </p>
          {data.ghosts.length ? (
            <Panel title={t('panels.ghostMatches', { top: num(Math.min(50, data.summary.ghostCount)), total: num(data.summary.ghostCount) })} icon={Ghost} bodyClassName="p-0">
              <SharedTable className="w-full text-sm">
                <SharedTableHeader>
                  <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.vendor')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.employee')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.match')}</SharedTableHead>
                    <SharedTableHead className="px-4 py-2 text-right font-medium">{t('table.risk')}</SharedTableHead>
                  </SharedTableRow>
                </SharedTableHeader>
                <SharedTableBody>
                  {data.ghosts.map((g, i) => (
                    <SharedTableRow key={i} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <SharedTableCell className="px-4 py-2 font-medium text-slate-800 dark:text-slate-200">{g.vendorName}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-slate-600 dark:text-slate-300">{g.employeeName}</SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-center"><Badge variant={g.matchType === 'name' ? 'warning' : 'destructive'}>{words.matchType(g.matchType)}</Badge></SharedTableCell>
                      <SharedTableCell className="px-4 py-2 text-right"><RiskPill score={g.riskScore} /></SharedTableCell>
                    </SharedTableRow>
                  ))}
                </SharedTableBody>
              </SharedTable>
            </Panel>
          ) : (
            <Panel title={t('panels.ghostVendors')} icon={Ghost}><p className="py-6 text-center text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={18} className="mx-auto mb-1.5" />{t('empty.noGhostMatches')}</p></Panel>
          )}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ Vendors */

function VendorsTab({ data, onDrill }: { data: SentinelData; onDrill: (t: DrillTarget) => void }) {
  const t = useTranslations('analytics.sentinel')
  // The roll-up sums translated findings, so it renders presentation money.
  const presFmt = useMoney(data.meta.presentationCurrency)
  const money0 = (n: MoneyValue) => presFmt.money(n)
  const { sorted, SortTh } = useSort(data.vendorRisk, { key: 'compositeScore', dir: 'desc' })
  return (
    <Panel title={t('panels.vendorRiskRollup')} icon={ShieldAlert} hint={t('panels.vendorRiskHint')} bodyClassName="p-0">
      <div className="max-h-144 overflow-y-auto">
        <SharedTable className="w-full text-sm">
          <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
            <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <SortTh label={t('table.party')} col="partyName" align="left" defaultDir="asc" />
              <SortTh label={t('table.flags')} col="flagCount" />
              <SortTh label={t('table.flaggedAmount')} col="totalAmount" />
              <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.flagTypes')}</SharedTableHead>
              <SortTh label={t('table.riskScore')} col="compositeScore" />
            </SharedTableRow>
          </SharedTableHeader>
          <SharedTableBody>
            {sorted.map((v, i) => (
              <InteractiveTableRow
                key={`${v.partyId}-${i}`}
                onClick={v.partyId ? () => onDrill({ kind: 'party', id: v.partyId!, name: v.partyName, sub: t('vendors.drillSub', { flags: v.flagCount, amount: money0(v.totalAmount) }) }) : undefined}
                className={cn('border-b border-slate-50 last:border-0 dark:border-slate-800/60', v.partyId && 'cursor-pointer hover:bg-slate-50/60 dark:hover:bg-slate-800/30')} noAnimate
              >
                <SharedTableCell className="max-w-56 truncate px-4 py-2 font-medium text-slate-800 dark:text-slate-200" title={v.partyName}>{v.partyName}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{v.flagCount}</SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(v.totalAmount)}</SharedTableCell>
                <SharedTableCell className="px-4 py-2">
                  <span className="flex flex-wrap gap-1">
                    {v.flagTypes.map((ft) => (
                      <span key={ft} className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', FLAG_BADGE_CLS[ft as FlaggedDoc['flagType']] ?? 'bg-slate-100 text-slate-600')}>{(FLAGGED_TYPES as readonly string[]).includes(ft) ? t(`flag.${ft}`) : ft}</span>
                    ))}
                  </span>
                </SharedTableCell>
                <SharedTableCell className="px-4 py-2 text-right"><RiskPill score={v.compositeScore} /></SharedTableCell>
              </InteractiveTableRow>
            ))}
          </SharedTableBody>
        </SharedTable>
      </div>
    </Panel>
  )
}

/* --------------------------------------------------------------- Audit Trail */

function AuditTab({ data }: { data: SentinelData }) {
  const t = useTranslations('analytics.sentinel')
  const num = useNum()
  const words = useCodeWords()
  const a = data.auditTrail
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiCard icon={History} accent="sky" label={t('kpi.auditEvents')} value={num(a.total)} sub={t('sub.inPeriod')} />
        <KpiCard icon={AlertTriangle} accent={a.deletes > 0 ? 'red' : 'emerald'} label={t('kpi.deletions')} value={num(a.deletes)} sub={t('sub.recordsRemoved')} tone={a.deletes > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={ShieldAlert} accent={a.sensitiveChanges > 0 ? 'amber' : 'emerald'} label={t('kpi.sensitiveChanges')} value={num(a.sensitiveChanges)} sub={t('sub.bankingContactAddress')} />
      </div>
      <p className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>{t('auditNote')}</span>
      </p>
      <Panel title={t('panels.highRiskAudit')} icon={History} bodyClassName="p-0">
        <div className="max-h-128 overflow-y-auto">
          <SharedTable className="w-full text-sm">
            <SharedTableHeader className="sticky top-0 bg-white dark:bg-slate-900">
              <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.when')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.table')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-center font-medium">{t('table.action')}</SharedTableHead>
                <SharedTableHead className="px-4 py-2 text-left font-medium">{t('table.change')}</SharedTableHead>
              </SharedTableRow>
            </SharedTableHeader>
            <SharedTableBody>
              {a.events.length ? a.events.map((e) => (
                <SharedTableRow key={e.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <SharedTableCell className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{e.displayAt}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 font-medium text-slate-700 dark:text-slate-300">{e.tableName}</SharedTableCell>
                  <SharedTableCell className="px-4 py-2 text-center"><Badge variant={e.action.toLowerCase() === 'delete' ? 'destructive' : 'secondary'}>{words.auditAction(e.action)}</Badge></SharedTableCell>
                  <SharedTableCell className="max-w-96 truncate px-4 py-2 text-xs text-slate-400 dark:text-slate-500" title={e.summary}>{e.summary || '—'}</SharedTableCell>
                </SharedTableRow>
              )) : (
                <SharedTableRow><SharedTableCell colSpan={4} className="px-4 py-10 text-center text-sm text-slate-400"><CheckCircle2 size={20} className="mx-auto mb-1.5 text-emerald-500" />{t('empty.noAuditEvents')}</SharedTableCell></SharedTableRow>
              )}
            </SharedTableBody>
          </SharedTable>
        </div>
      </Panel>
    </div>
  )
}

/* ----------------------------------------------------------- Configuration */

/** Read-only rendering of the severity model, generated from the payload's
 * scoring object — the same object the loader scores with. No prose here
 * restates it; the numbers below ARE the model. */
function ScoringPanel({ data }: { data: SentinelData }) {
  // Full catalog paths, like ConfigEditor: the rubric stores absolute keys.
  const root = useTranslations()
  const t = useTranslations('analytics.sentinel')
  const num = useNum()
  const pct = useRatioPct()
  const ccy = data.meta.presentationCurrency
  const cfg = data.config as unknown as Record<string, string | number>
  const rowLabel = (rule: {
    labelKey: string
    params: Record<string, string | number>
    confidence?: number
    share?: number
  }): string => {
    const p: Record<string, string | number> = { ...rule.params }
    if (typeof p.tierKey === 'string') {
      p.tier = root(p.tierKey, { currency: ccy })
      delete p.tierKey
    }
    if (typeof p.matchKey === 'string') {
      p.match = root(p.matchKey)
      delete p.matchKey
    }
    if (typeof p.countKey === 'string') {
      p.count = num(Number(cfg[p.countKey] ?? 0))
      delete p.countKey
    }
    if (rule.confidence != null) p.pct = pct(rule.confidence, 0)
    if (rule.share != null) p.pct = pct(rule.share, 0)
    return root(rule.labelKey, p)
  }
  return (
    <Panel title={t('scoring.title')} icon={Scale}>
      <p className="mb-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{t('scoring.note')}</p>
      <div className="space-y-4">
        {Object.values(data.scoring).map((section) => (
          <div key={section.titleKey}>
            <p className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-200">{root(section.titleKey)}</p>
            <ul className="space-y-0.5">
              {Object.values(section.rules).map((rule) => (
                <li key={`${rule.labelKey}|${JSON.stringify(rule.params)}`} className="text-xs tabular-nums text-slate-600 dark:text-slate-300">
                  {rowLabel(rule)}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function ConfigTab({ data, canEdit }: { data: SentinelData; canEdit: boolean }) {
  const t = useTranslations('analytics.sentinel')
  const num = useNum()
  const dec = useDecimals()
  const presFmt = useMoney(data.meta.presentationCurrency)
  const money = (n: MoneyValue) => presFmt.moneyCompact(n)
  const c = data.config
  const floor = c.duplicateMinAmount === '' ? null : (c.duplicateMinAmount as string)
  const items = [
    {
      label: t('detectors.duplicates'),
      value: floor
        ? t('config.duplicatesValue', { days: num(c.duplicateDays), floor: money(floor) })
        : t('config.duplicatesValueUnset', { days: num(c.duplicateDays), unset: t('config.unsetValue') }),
      note: t('config.duplicatesNote'),
    },
    { label: t('config.benfordConformity'), value: t('config.benfordNote'), note: t('config.benfordNote') },
    { label: t('flag.rsf'), value: t('config.rsfValue', { threshold: c.rsfThreshold }), note: t('config.rsfNote', { floor: money(c.rsfBaselineFloor as string), months: num(c.baselineMonths) }) },
    { label: t('analysis.zscoreWord'), value: t('config.zscoreValue', { threshold: c.zscoreThreshold }), note: t('config.zscoreNote', { sigma: money(c.zscoreSigmaFloor as string), minTxns: num(c.zscoreMinBaseline) }) },
    { label: t('config.sequentialRuns'), value: t('config.sequentialValue', { count: num(c.sequentialMinCount), days: num(c.sequentialMinDays) }), note: t('config.sequentialNote', { days: num(c.sequentialHighRiskDays) }) },
    { label: t('benford.thresholdTrap'), value: t('config.trapValue', { band: c.trapBandPercent }), note: t('config.trapNote') },
    { label: t('flag.weekend'), value: 'Sat / Sun', note: t('config.weekendNote') },
  ]
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <ConfigEditor dashboard="sentinel" canEdit={canEdit} />
        <Panel title={t('panels.detectorThresholds')} icon={SlidersHorizontal} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {items.map((i) => (
              <li key={i.label} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{i.label}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{i.note}</p>
                </div>
                <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">{i.value}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <ScoringPanel data={data} />
      </div>
      <Panel title={t('panels.completeCoverage')} icon={Database}>
        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <p>{t('coverage.intro')}<span className="font-semibold">{t('coverage.ledger')}</span>{t('coverage.introTail')}</p>
          <ul className="list-disc space-y-1 pl-5 text-slate-500 dark:text-slate-400">
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('coverage.benfordBold')}</span>{t('coverage.benfordItem')}</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('coverage.rszBold')}</span>{t('coverage.rszItem')}</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('flag.sequential')}</span>{t('coverage.sequentialItem')}</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('detectors.duplicates')}</span>{t('coverage.duplicatesItem')}</li>
          </ul>
          <p>{t('coverage.outro', { docs: num(data.meta.totalDocs), amount: money(data.meta.totalAmount), days: num(data.meta.days), seconds: dec(data.meta.queryMs / 1000, 1) })}</p>
        </div>
      </Panel>
    </div>
  )
}
