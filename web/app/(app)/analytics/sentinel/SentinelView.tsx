'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertTriangle, BarChart3, CalendarDays, CheckCircle2, Copy, FileWarning, Flag, Ghost,
  History, Info, ListOrdered, Scale, ShieldAlert, SlidersHorizontal, Sigma, Zap, Database, Download,
} from 'lucide-react'
import { cn, Badge, Drawer } from '@openbooks/ui'
import type { SentinelData, FlaggedDoc } from '../../../../lib/analytics/sentinel-data'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { Chart } from '../_ui/charts'
import { DrillDrawer, type DrillTarget } from '../_ui/DrillDrawer'
import { ConfigEditor } from '../_ui/ConfigEditor'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { exportCsv } from '../_ui/exportCsv'
import { useSort } from '../_ui/useSort'
import { TxnLink } from '../../reports/TxnLink'
import { useAnalyticsMoney } from '../_ui/format'

/* ------------------------------------------------------------------ helpers */

const TABS = ['overview', 'benford', 'analysis', 'detection', 'vendors', 'audit', 'config'] as const
type Tab = (typeof TABS)[number]
const num = (n: number) => n.toLocaleString('en-US')

function riskTone(score: number) {
  if (score >= 80) return { text: 'text-rose-600 dark:text-rose-400', hex: '#ef4444', badge: 'destructive' as const }
  if (score >= 60) return { text: 'text-amber-600 dark:text-amber-400', hex: '#f59e0b', badge: 'warning' as const }
  return { text: 'text-slate-500 dark:text-slate-400', hex: '#94a3b8', badge: 'secondary' as const }
}

function RiskPill({ score }: { score: number }) {
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold tabular-nums', score >= 80 ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400' : score >= 60 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300')}>{score}</span>
}

/** Overall-risk gauge (Risk-meter, inverted: high = red). */
function RiskGauge({ score }: { score: number }) {
  const t = useTranslations('analytics.sentinel')
  const color = score >= 60 ? '#ef4444' : score >= 40 ? '#f97316' : score >= 20 ? '#f59e0b' : '#10b981'
  const label = score >= 60 ? t('risk.high') : score >= 40 ? t('risk.elevated') : score >= 20 ? t('risk.moderate') : t('risk.low')
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
  const fmtMoney = useAnalyticsMoney()
  const money0 = (n: number) => fmtMoney(n)
  return (
    <div className="max-h-128 overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white dark:bg-slate-900">
          <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <th className="px-4 py-2 text-left font-medium">{t('table.date')}</th>
            <th className="px-4 py-2 text-left font-medium">{t('table.document')}</th>
            <th className="px-4 py-2 text-left font-medium">{t('table.party')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('table.amount')}</th>
            <th className="px-4 py-2 text-center font-medium">{t('table.flag')}</th>
            {showReason ? <th className="px-4 py-2 text-left font-medium">{t('table.reason')}</th> : null}
            <th className="px-4 py-2 text-right font-medium">{t('table.risk')}</th>
          </tr>
        </thead>
        <tbody>
          {items.length ? items.map((f, i) => (
            <tr key={`${f.docId}-${f.flagType}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
              <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{f.date}</td>
              <td className="px-4 py-2"><DocCell f={f} /></td>
              <td className="max-w-44 truncate px-4 py-2 text-slate-600 dark:text-slate-300" title={f.partyName}>{f.partyName || '—'}</td>
              <td className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{money0(f.amount)}</td>
              <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', FLAG_BADGE_CLS[f.flagType])}>{t(`flag.${f.flagType}`)}</span></td>
              {showReason ? <td className="max-w-72 truncate px-4 py-2 text-xs text-slate-400 dark:text-slate-500" title={f.reason}>{f.reason}</td> : null}
              <td className="px-4 py-2 text-right"><RiskPill score={f.riskScore} /></td>
            </tr>
          )) : (
            <tr><td colSpan={showReason ? 7 : 6} className="px-4 py-10 text-center text-sm text-slate-400"><CheckCircle2 size={20} className="mx-auto mb-1.5 text-emerald-500" />{t('empty.nothingFlagged')}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function SubPills<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { key: T; label: string; count?: number }[] }) {
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

/* ------------------------------------------------------------------- shell */

export function SentinelView({ data }: { data: SentinelData }) {
  const t = useTranslations('analytics.sentinel')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const conformLabel = (v: string) => v === 'Conforming' ? t('benford.conforming') : v === 'Marginal' ? t('benford.marginal') : v === 'Non-Conforming' ? t('benford.nonConforming') : v
  const [tab, setTab] = useState<Tab>('overview')
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const s = data.summary

  return (
    <div className="space-y-5">
      {/* Full-dataset proof banner — the anti-"artificial subset" statement. */}
      <p className="flex items-center gap-2 rounded-lg bg-slate-50 px-3.5 py-2 text-xs text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
        <Database size={13} className="shrink-0 text-teal-500" />
        {t('banner.pre')}<span className="font-semibold text-slate-700 dark:text-slate-200">{t('banner.ledger')}</span>
        {` `}{t('banner.stats', { docs: num(data.meta.totalDocs), amount: money(data.meta.totalAmount), days: num(data.meta.days), seconds: (data.meta.queryMs / 1000).toFixed(1) })}
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <RiskGauge score={s.overallRiskScore} />
        <KpiCard icon={Flag} accent={s.flaggedCount > 0 ? 'red' : 'emerald'} label={t('kpi.flagged')} value={num(s.flaggedCount)} sub={t('sub.atRisk', { amount: money(s.totalAtRisk) })} tone={s.flaggedCount > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={Copy} accent="amber" label={t('kpi.duplicatePairs')} value={num(s.duplicateCount)} sub={money(s.totalDuplicateAmount)} tone={s.duplicateCount > 0 ? 'negative' : 'neutral'} />
        <KpiCard icon={BarChart3} accent={s.benfordConformity === 'Non-Conforming' ? 'red' : s.benfordConformity === 'Marginal' ? 'amber' : 'emerald'} label={t('kpi.benford')} value={conformLabel(s.benfordConformity)} sub={t('sub.twoD', { value: s.benford2DConformity })} />
        <KpiCard icon={ShieldAlert} accent={s.ghostCount + s.sequentialGroups > 0 ? 'red' : 'emerald'} label={t('kpi.shellSignals')} value={num(s.ghostCount + s.sequentialGroups)} sub={t('sub.ghostsSequential', { ghosts: s.ghostCount, sequential: s.sequentialGroups })} tone={s.ghostCount + s.sequentialGroups > 0 ? 'negative' : 'positive'} />
      </div>

      <div className="-mx-1 overflow-x-auto">
        <div className="flex min-w-max gap-0.5 border-b border-slate-200 px-1 dark:border-slate-800">
          {TABS.map((k) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={cn('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors', tab === k ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>
              {t(`tabs.${k}`)}
              {k === 'detection' && s.flaggedCount > 0 ? <span className="rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">{num(s.flaggedCount)}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} /> : null}
        {tab === 'benford' ? <BenfordTab data={data} /> : null}
        {tab === 'analysis' ? <AnalysisTab data={data} /> : null}
        {tab === 'detection' ? <DetectionTab data={data} /> : null}
        {tab === 'vendors' ? <VendorsTab data={data} onDrill={setDrill} /> : null}
        {tab === 'audit' ? <AuditTab data={data} /> : null}
        {tab === 'config' ? <ConfigTab data={data} /> : null}
      </div>

      <DrillDrawer target={drill} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} />
    </div>
  )
}

/* ---------------------------------------------------------------- Overview */

function OverviewTab({ data }: { data: SentinelData }) {
  const t = useTranslations('analytics.sentinel')
  const s = data.summary
  const b = data.benford1D
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Panel title={t('panels.benfordFirstDigit')} icon={BarChart3} hint={t('panels.benfordHint', { amounts: num(b.totalTransactions), mad: b.mad.toFixed(4), conformity: b.conformity })}>
            <Chart
              height={230}
              option={{
                grid: { top: 24, bottom: 24, left: 45, right: 12 },
                legend: { top: 0 },
                tooltip: { trigger: 'axis', valueFormatter: (v: any) => `${(Number(v) * 100).toFixed(1)}%` },
                xAxis: { type: 'category', data: b.digits.map((d) => String(d.digit)) },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` } },
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
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">{a.area}<Badge variant={a.severity === 'critical' ? 'destructive' : a.severity === 'high' ? 'warning' : 'secondary'}>{a.severity}</Badge></div>
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
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const conformLabel = (v: string) => v === 'Conforming' ? t('benford.conforming') : v === 'Marginal' ? t('benford.marginal') : v === 'Non-Conforming' ? t('benford.nonConforming') : v
  const [sub, setSub] = useState<'1d' | '2d' | 'trap'>('1d')
  const [drill, setDrill] = useState<{ digit: number; dim: '1d' | '2d' } | null>(null)
  const b1 = data.benford1D
  const b2 = data.benford2D
  const trap = data.thresholdTrap
  return (
    <div className="space-y-4">
      <SubPills value={sub} onChange={setSub} options={[
        { key: '1d', label: t('benford.firstDigit1D') },
        { key: '2d', label: t('benford.firstTwoDigits2D'), count: b2.anomalies.length },
        { key: 'trap', label: t('benford.thresholdTrap'), count: trap.total },
      ]} />
      {drill ? <BenfordDrill digit={drill.digit} dim={drill.dim} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} /> : null}

      {sub === '1d' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard icon={Sigma} accent="sky" label={t('kpi.amountsAnalyzed')} value={num(b1.totalTransactions)} sub={t('sub.everyDocument')} />
            <KpiCard icon={Scale} accent={b1.conformity === 'Non-Conforming' ? 'red' : b1.conformity === 'Marginal' ? 'amber' : 'emerald'} label={t('kpi.conformity')} value={conformLabel(b1.conformity)} sub={`MAD ${b1.mad.toFixed(4)}`} />
            <KpiCard icon={AlertTriangle} accent="amber" label={t('kpi.deviatingDigits')} value={num(b1.digits.filter((d) => d.isAnomaly).length)} sub={t('sub.offExpected25')} />
            <KpiCard icon={BarChart3} accent="violet" label={t('kpi.digit1Share')} value={`${((b1.digits[0]?.observed ?? 0) * 100).toFixed(1)}%`} sub={t('sub.expected301')} />
          </div>
          <Panel title={t('panels.observedVsExpected')} icon={BarChart3}>
            <Chart
              height={280}
              option={{
                grid: { top: 24, bottom: 24, left: 45, right: 12 },
                legend: { top: 0 },
                tooltip: { trigger: 'axis', valueFormatter: (v: any) => `${(Number(v) * 100).toFixed(2)}%` },
                xAxis: { type: 'category', data: b1.digits.map((d) => String(d.digit)) },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` } },
                series: [
                  { name: t('chart.observed'), type: 'bar', data: b1.digits.map((d) => ({ value: d.observed, itemStyle: { color: d.isAnomaly ? '#ef4444' : '#14b8a6' } })) },
                  { name: t('chart.expected'), type: 'line', data: b1.digits.map((d) => d.expected), symbolSize: 6, lineStyle: { width: 2, type: 'dashed', color: '#64748b' }, itemStyle: { color: '#64748b' } },
                ],
              }}
            />
          </Panel>
          <Panel title={t('panels.digitDetail')} icon={ListOrdered} hint={t('panels.digitDetailHint')} bodyClassName="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">{t('table.digit')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.count')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.amount')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('chart.observed')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('chart.expected')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.deviation')}</th>
                </tr>
              </thead>
              <tbody>
                {b1.digits.map((d) => (
                  <tr key={d.digit} onClick={() => setDrill({ digit: d.digit, dim: '1d' })} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                    <td className="px-4 py-2 font-bold text-slate-800 dark:text-slate-200">{d.digit}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{num(d.count)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(d.amount)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{(d.observed * 100).toFixed(2)}%</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-400">{(d.expected * 100).toFixed(2)}%</td>
                    <td className={cn('px-4 py-2 text-right font-semibold tabular-nums', d.isAnomaly ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400')}>{d.deviationPct > 0 ? '+' : ''}{d.deviationPct.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      ) : null}

      {sub === '2d' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard icon={Sigma} accent="sky" label={t('kpi.amountsAnalyzed')} value={num(b2.totalTransactions)} sub={t('sub.twoDigitPairs')} />
            <KpiCard icon={Scale} accent={b2.conformity === 'Non-Conforming' ? 'red' : b2.conformity === 'Marginal' ? 'amber' : 'emerald'} label={t('kpi.conformity')} value={conformLabel(b2.conformity)} sub={`MAD ${b2.mad.toFixed(4)}`} />
            <KpiCard icon={AlertTriangle} accent={b2.anomalies.length > 0 ? 'amber' : 'emerald'} label={t('kpi.anomalousPairs')} value={num(b2.anomalies.length)} sub={t('sub.offExpected50')} />
            <KpiCard icon={FileWarning} accent={data.summary.approvalLimitRisk ? 'red' : 'emerald'} label={t('kpi.approvalLimitRisk')} value={data.summary.approvalLimitRisk ? t('yes') : t('no')} sub={t('sub.seeThresholdTrap')} />
          </div>
          <Panel title={t('panels.twoDigitDistribution')} icon={BarChart3}>
            <Chart
              height={280}
              option={{
                grid: { top: 24, bottom: 24, left: 45, right: 12 },
                legend: { top: 0 },
                tooltip: { trigger: 'axis', valueFormatter: (v: any) => `${(Number(v) * 100).toFixed(2)}%` },
                xAxis: { type: 'category', data: b2.digits.map((d) => String(d.digit)), axisLabel: { interval: 9 } },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(1)}%` } },
                series: [
                  { name: t('chart.observed'), type: 'bar', barCategoryGap: '10%', data: b2.digits.map((d) => ({ value: d.observed, itemStyle: { color: d.isAnomaly && d.count >= 5 ? '#ef4444' : '#14b8a6' } })) },
                  { name: t('chart.expected'), type: 'line', data: b2.digits.map((d) => d.expected), symbol: 'none', lineStyle: { width: 1.5, type: 'dashed', color: '#64748b' } },
                ],
              }}
            />
          </Panel>
          {b2.anomalies.length ? (
            <Panel title={t('panels.anomalousPairs')} icon={AlertTriangle} bodyClassName="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">{t('table.digits')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.count')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.amount')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.deviation')}</th>
                  </tr>
                </thead>
                <tbody>
                  {b2.anomalies.slice(0, 15).map((d) => (
                    <tr key={d.digit} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2 font-bold text-slate-800 dark:text-slate-200">{d.digit}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{num(d.count)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money(d.amount)}</td>
                      <td className={cn('px-4 py-2 text-right font-semibold tabular-nums', 'text-rose-600 dark:text-rose-400')}>{d.deviationPct > 0 ? '+' : ''}{d.deviationPct.toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
          <Panel title={t('panels.thresholdTrapDocs')} icon={FileWarning} bodyClassName="p-0">
            <FlaggedTable items={trap.items} showReason={false} />
          </Panel>
        </div>
      ) : null}
    </div>
  )
}

/** Benford digit → transactions drill (). */
function BenfordDrill({ digit, dim, from, to, onClose }: { digit: number; dim: '1d' | '2d'; from: string; to: string; onClose: () => void }) {
  const t = useTranslations('analytics.sentinel')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    fetch(`/api/analytics/sentinel/benford?digit=${digit}&dim=${dim}&from=${from}&to=${to}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => { if (live) setData(j) })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [digit, dim, from, to])
  const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

  return (
    <Drawer open onClose={onClose} size="lg" title={`${dim === '2d' ? t('drill.firstTwoDigits') : t('drill.leadingDigit')}: ${digit}`} description={data ? `${t('drill.documentsTotal', { count: num(data.count), total: money(data.total) })}${data.count > data.documents.length ? ` (${t('drill.top', { count: data.documents.length })})` : ''}` : t('loading')} bodyClassName="overflow-hidden flex flex-col p-0">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="p-6 text-center text-sm text-slate-400">{t('error.loadFailed')}</p>
        ) : !data ? (
          <p className="p-6 text-center text-sm text-slate-400">{t('loading')}</p>
        ) : data.documents.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-400">{t('drill.noDocuments', { digit })}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('table.date')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('table.document')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('table.party')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('table.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {data.documents.map((d: any, k: number) => (
                <tr key={k} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                  <td className="px-4 py-1.5 whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">{fmtDate(d.date)}</td>
                  <td className="px-4 py-1.5"><TxnLink entryId={d.entryId ?? ''} docKind={d.docKind} docId={d.docId} className="font-medium text-slate-700 hover:text-teal-600 dark:text-slate-200 dark:hover:text-teal-400">{d.docNumber || d.docKind}</TxnLink></td>
                  <td className="max-w-48 truncate px-4 py-1.5 text-slate-500 dark:text-slate-400" title={d.partyName}>{d.partyName || '—'}</td>
                  <td className="px-4 py-1.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(d.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Drawer>
  )
}

/* ---------------------------------------------------------------- Analysis */

function AnalysisTab({ data }: { data: SentinelData }) {
  const t = useTranslations('analytics.sentinel')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const money0 = (n: number) => fmtMoney(n)
  const [sub, setSub] = useState<'rsf' | 'zscore' | 'calendar'>('rsf')

  const calendarOption = useMemo(() => {
    const byYear = new Map<string, [string, number][]>()
    for (const c of data.calendar) {
      const y = c.date.slice(0, 4)
      if (!byYear.has(y)) byYear.set(y, [])
      byYear.get(y)!.push([c.date, c.amount])
    }
    const years = [...byYear.keys()].sort().slice(-2) // show up to 2 most recent years
    const max = Math.max(...data.calendar.map((c) => c.amount), 1)
    return {
      tooltip: { formatter: (p: any) => `${p.data[0]}<br/>${money0(p.data[1])}` },
      visualMap: { min: 0, max, orient: 'horizontal' as const, left: 'center', top: 0, inRange: { color: ['#e2e8f0', '#99f6e4', '#14b8a6', '#f59e0b', '#ef4444'] }, formatter: (v: any) => money(Number(v)) },
      calendar: years.map((y, i) => ({
        range: y, top: 60 + i * 150, left: 40, right: 10, cellSize: ['auto', 13] as [string, number],
        itemStyle: { borderColor: 'rgba(148,163,184,0.15)', borderWidth: 1 },
        splitLine: { lineStyle: { color: 'rgba(148,163,184,0.4)' } },
        dayLabel: { color: '#94a3b8', fontSize: 10 }, monthLabel: { color: '#94a3b8', fontSize: 10 }, yearLabel: { color: '#64748b', fontSize: 12 },
      })),
      series: years.map((y, i) => ({ type: 'heatmap' as const, coordinateSystem: 'calendar' as const, calendarIndex: i, data: byYear.get(y) })),
    }
  }, [data.calendar])

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
            <span><span className="font-semibold">{t('flag.rsf')}</span>{t('analysis.rsfNote')}</span>
          </p>
          <Panel title={t('panels.rsfAnomalies', { count: num(data.rsf.total) })} icon={Scale} bodyClassName="p-0">
            <div className="max-h-128 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">{t('table.date')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('table.document')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('table.vendor')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.amount')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.secondLargest')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('flag.rsf')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.risk')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rsf.items.map((r, i) => (
                    <tr key={`${r.docId}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{r.date}</td>
                      <td className="px-4 py-2"><DocCell f={r} /></td>
                      <td className="max-w-44 truncate px-4 py-2 text-slate-600 dark:text-slate-300" title={r.partyName}>{r.partyName}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{money0(r.amount)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-400">{money0(r.secondLargest)}</td>
                      <td className="px-4 py-2 text-right font-bold tabular-nums text-amber-600 dark:text-amber-400">{r.rsf.toFixed(1)}×</td>
                      <td className="px-4 py-2 text-right"><RiskPill score={r.riskScore} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      ) : null}

      {sub === 'zscore' ? (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span><span className="font-semibold">{t('analysis.zscoreWord')}</span>{t('analysis.zscoreNote')}</span>
          </p>
          <Panel title={t('panels.zscoreAnomalies', { count: num(data.zscore.total) })} icon={Sigma} bodyClassName="p-0">
            <div className="max-h-128 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">{t('table.date')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('table.document')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('table.party')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.amount')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.partyAvg')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.z')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.risk')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.zscore.items.map((z, i) => (
                    <tr key={`${z.docId}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{z.date}</td>
                      <td className="px-4 py-2"><DocCell f={z} /></td>
                      <td className="max-w-44 truncate px-4 py-2 text-slate-600 dark:text-slate-300" title={z.partyName}>{z.partyName}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{money0(z.amount)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-400">{money0(z.vendorAvg)}</td>
                      <td className="px-4 py-2 text-right font-bold tabular-nums text-sky-600 dark:text-sky-400">{z.zScore.toFixed(1)}σ</td>
                      <td className="px-4 py-2 text-right"><RiskPill score={z.riskScore} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      ) : null}

      {sub === 'calendar' ? (
        <Panel title={t('panels.spendCalendar')} icon={CalendarDays} hint={t('panels.spendCalendarHint')}>
          <Chart option={calendarOption as any} height={Math.min(2, new Set(data.calendar.map((c) => c.date.slice(0, 4))).size) * 150 + 80} />
        </Panel>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- Detection */

function DetectionTab({ data }: { data: SentinelData }) {
  const t = useTranslations('analytics.sentinel')
  const today = useBusinessToday()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const money0 = (n: number) => fmtMoney(n)
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
              onClick={() => exportCsv('flagged-documents', [t('table.date'), t('table.document'), t('csv.kind'), t('table.party'), t('table.amount'), t('table.flag'), t('table.risk'), t('table.reason')], data.flagged.map((f) => [f.date, f.docNumber, f.kind, f.partyName, Math.round(f.amount), f.flagType, f.riskScore, f.reason]), today)}
              className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              <Download size={11} /> CSV
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
            <KpiCard icon={Info} accent="slate" label={t('kpi.rule')} value={t('duplicates.ruleValue')} sub={t('duplicates.ruleNote', { min: money(100) })} />
          </div>
          <Panel title={t('panels.potentialDuplicates')} icon={Copy} hint={t('panels.duplicatesHint')} bodyClassName="p-0">
            <div className="max-h-128 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">{t('table.vendor')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('table.doc1')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('table.doc2')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.amount')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.daysApart')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.confidence')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.risk')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.duplicates.pairs.map((p, i) => (
                    <tr key={`${p.docId1}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="max-w-44 truncate px-4 py-2 font-medium text-slate-800 dark:text-slate-200" title={p.partyName}>{p.partyName}</td>
                      <td className="px-4 py-2">
                        <TxnLink entryId={p.docId1} docKind={p.kind} docId={p.docId1} className="text-teal-600 hover:underline dark:text-teal-400">{p.docNumber1 || kindLabel(p.kind)}</TxnLink>
                        <span className="block text-[10px] tabular-nums text-slate-400">{p.date1}</span>
                      </td>
                      <td className="px-4 py-2">
                        <TxnLink entryId={p.docId2} docKind={p.kind} docId={p.docId2} className="text-teal-600 hover:underline dark:text-teal-400">{p.docNumber2 || kindLabel(p.kind)}</TxnLink>
                        <span className="block text-[10px] tabular-nums text-slate-400">{p.date2}</span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{money0(p.amount)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{p.daysBetween}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{Math.round(p.confidence * 100)}%{p.sameMemo ? <span className="ml-1 text-[10px] text-rose-500">{t('duplicates.sameMemo')}</span> : null}</td>
                      <td className="px-4 py-2 text-right"><RiskPill score={p.riskScore} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
              <Panel key={`${g.partyId}-${i}`} title={g.partyName} icon={ListOrdered} actions={<Badge variant={g.riskLevel === 'high' ? 'destructive' : 'warning'}>{g.riskLevel} · {g.riskScore}</Badge>}>
                <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">{g.reason}{t('sequential.runTotal', { total: money0(g.totalAmount), first: g.firstDate, last: g.lastDate })}</p>
                <div className="flex flex-wrap gap-1.5">
                  {g.invoices.map((inv) => (
                    <TxnLink key={inv.docId} entryId={inv.docId} docKind="vendor_bill" docId={inv.docId} className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:border-teal-400 hover:text-teal-600 dark:border-slate-700 dark:text-slate-300 dark:hover:text-teal-400">
                      <span className="font-semibold">#{inv.reference}</span> · {money(inv.amount)} · <span className="tabular-nums">{inv.date}</span>
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
            <Panel title={t('panels.ghostMatches', { count: data.ghosts.length })} icon={Ghost} bodyClassName="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">{t('table.vendor')}</th>
                    <th className="px-4 py-2 text-left font-medium">{t('table.employee')}</th>
                    <th className="px-4 py-2 text-center font-medium">{t('table.match')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('table.risk')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ghosts.map((g, i) => (
                    <tr key={i} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-200">{g.vendorName}</td>
                      <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{g.employeeName}</td>
                      <td className="px-4 py-2 text-center"><Badge variant={g.matchType === 'name' ? 'warning' : 'destructive'}>{g.matchType}</Badge></td>
                      <td className="px-4 py-2 text-right"><RiskPill score={g.riskScore} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
  const fmtMoney = useAnalyticsMoney()
  const money0 = (n: number) => fmtMoney(n)
  const { sorted, SortTh } = useSort(data.vendorRisk, { key: 'compositeScore', dir: 'desc' })
  return (
    <Panel title={t('panels.vendorRiskRollup')} icon={ShieldAlert} hint={t('panels.vendorRiskHint')} bodyClassName="p-0">
      <div className="max-h-144 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white dark:bg-slate-900">
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <SortTh label={t('table.party')} col="partyName" align="left" defaultDir="asc" />
              <SortTh label={t('table.flags')} col="flagCount" />
              <SortTh label={t('table.flaggedAmount')} col="totalAmount" />
              <th className="px-4 py-2 text-left font-medium">{t('table.flagTypes')}</th>
              <SortTh label={t('table.riskScore')} col="compositeScore" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((v, i) => (
              <tr
                key={`${v.partyId}-${i}`}
                onClick={v.partyId ? () => onDrill({ kind: 'party', id: v.partyId!, name: v.partyName, sub: t('vendors.drillSub', { flags: v.flagCount, amount: money0(v.totalAmount) }) }) : undefined}
                className={cn('border-b border-slate-50 last:border-0 dark:border-slate-800/60', v.partyId && 'cursor-pointer hover:bg-slate-50/60 dark:hover:bg-slate-800/30')}
              >
                <td className="max-w-56 truncate px-4 py-2 font-medium text-slate-800 dark:text-slate-200" title={v.partyName}>{v.partyName}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{v.flagCount}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(v.totalAmount)}</td>
                <td className="px-4 py-2">
                  <span className="flex flex-wrap gap-1">
                    {v.flagTypes.map((ft) => (
                      <span key={ft} className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', FLAG_BADGE_CLS[ft as FlaggedDoc['flagType']] ?? 'bg-slate-100 text-slate-600')}>{(FLAGGED_TYPES as readonly string[]).includes(ft) ? t(`flag.${ft}`) : ft}</span>
                    ))}
                  </span>
                </td>
                <td className="px-4 py-2 text-right"><RiskPill score={v.compositeScore} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

/* --------------------------------------------------------------- Audit Trail */

function AuditTab({ data }: { data: SentinelData }) {
  const t = useTranslations('analytics.sentinel')
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
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('table.when')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('table.table')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('table.action')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('table.change')}</th>
              </tr>
            </thead>
            <tbody>
              {a.events.length ? a.events.map((e) => (
                <tr key={e.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{e.at.slice(0, 16).replace('T', ' ')}</td>
                  <td className="px-4 py-2 font-medium text-slate-700 dark:text-slate-300">{e.tableName}</td>
                  <td className="px-4 py-2 text-center"><Badge variant={e.action.toLowerCase() === 'delete' ? 'destructive' : 'secondary'}>{e.action}</Badge></td>
                  <td className="max-w-96 truncate px-4 py-2 text-xs text-slate-400 dark:text-slate-500" title={e.summary}>{e.summary || '—'}</td>
                </tr>
              )) : (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-400"><CheckCircle2 size={20} className="mx-auto mb-1.5 text-emerald-500" />{t('empty.noAuditEvents')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

/* ----------------------------------------------------------- Configuration */

function ConfigTab({ data }: { data: SentinelData }) {
  const t = useTranslations('analytics.sentinel')
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const c = data.config
  const items = [
    { label: t('detectors.duplicates'), value: `≤${c.duplicateDays}d · ≥${money(c.duplicateMinAmount!)}`, note: t('config.duplicatesNote') },
    { label: t('config.benfordConformity'), value: 'MAD (Nigrini)', note: t('config.benfordNote') },
    { label: t('flag.rsf'), value: '≥10×', note: t('config.rsfNote', { floor: money(100) }) },
    { label: t('analysis.zscoreWord'), value: '|z| ≥ 3', note: t('config.zscoreNote', { sigma: money(10) }) },
    { label: t('config.sequentialRuns'), value: `≥${c.sequentialMinCount} refs · ≥${c.sequentialMinDays} days`, note: t('config.sequentialNote') },
    { label: t('benford.thresholdTrap'), value: '99 / 999 / 9999', note: t('config.trapNote') },
    { label: t('flag.weekend'), value: 'Sat / Sun', note: t('config.weekendNote') },
  ]
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <ConfigEditor
          dashboard="sentinel"
          fields={[
            { key: 'duplicateDays', label: t('config.fields.duplicateDays.label'), help: t('config.fields.duplicateDays.help'), min: 1, max: 90, step: 1 },
            { key: 'duplicateMinAmount', label: t('config.fields.duplicateMinAmount.label'), help: t('config.fields.duplicateMinAmount.help'), min: 0, max: 100_000, step: 50 },
            { key: 'sequentialMinCount', label: t('config.fields.sequentialMinCount.label'), help: t('config.fields.sequentialMinCount.help'), min: 2, max: 50, step: 1 },
            { key: 'sequentialMinDays', label: t('config.fields.sequentialMinDays.label'), help: t('config.fields.sequentialMinDays.help'), min: 1, max: 365, step: 1 },
          ]}
          values={c}
          defaults={{ duplicateDays: 14, duplicateMinAmount: 100, sequentialMinCount: 3, sequentialMinDays: 7 }}
        />
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
          <p>{t('coverage.outro', { docs: num(data.meta.totalDocs), amount: money(data.meta.totalAmount), days: num(data.meta.days), seconds: (data.meta.queryMs / 1000).toFixed(1) })}</p>
        </div>
      </Panel>
    </div>
  )
}
