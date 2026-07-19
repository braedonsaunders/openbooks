'use client'

import { useEffect, useMemo, useState } from 'react'
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
import { exportCsv } from '../_ui/exportCsv'
import { useSort } from '../_ui/useSort'
import { TxnLink } from '../../reports/TxnLink'
import { fmtMoney } from '../_ui/format'

/* ------------------------------------------------------------------ helpers */

const TABS = ['overview', 'benford', 'analysis', 'detection', 'vendors', 'audit', 'config'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview', benford: 'Benford', analysis: 'Analysis', detection: 'Detection',
  vendors: 'Vendors', audit: 'Audit Trail', config: 'Configuration',
}

const money = (n: number) => fmtMoney(n, { compact: true })
const money0 = (n: number) => fmtMoney(n)
const num = (n: number) => n.toLocaleString('en-US')

function riskTone(score: number) {
  if (score >= 80) return { text: 'text-rose-600 dark:text-rose-400', hex: '#ef4444', badge: 'destructive' as const }
  if (score >= 60) return { text: 'text-amber-600 dark:text-amber-400', hex: '#f59e0b', badge: 'warning' as const }
  return { text: 'text-slate-500 dark:text-slate-400', hex: '#94a3b8', badge: 'secondary' as const }
}

function RiskPill({ score }: { score: number }) {
  const t = riskTone(score)
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold tabular-nums', score >= 80 ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400' : score >= 60 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300')}>{score}</span>
}

/** Overall-risk gauge (Gantry risk-meter, inverted: high = red). */
function RiskGauge({ score }: { score: number }) {
  const color = score >= 60 ? '#ef4444' : score >= 40 ? '#f97316' : score >= 20 ? '#f59e0b' : '#10b981'
  const label = score >= 60 ? 'HIGH RISK' : score >= 40 ? 'ELEVATED' : score >= 20 ? 'MODERATE' : 'LOW RISK'
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
        <p className="text-[10px] text-slate-400 dark:text-slate-500">integrity risk</p>
      </div>
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  vendor_bill: 'Bill', vendor_credit: 'Credit', vendor_payment: 'Payment', check: 'Check',
  expense_report: 'Expense', journal: 'Journal', customer_credit: 'Cust. Credit',
}

function DocCell({ f }: { f: { docId: string; docNumber: string; kind: string } }) {
  return (
    <TxnLink entryId={f.docId} docKind={f.kind} docId={f.docId} className="font-medium text-teal-600 hover:underline dark:text-teal-400">
      {f.docNumber || KIND_LABEL[f.kind] || f.kind}
      <span className="ml-1.5 text-[10px] uppercase tracking-wide text-slate-400">{KIND_LABEL[f.kind] ?? f.kind}</span>
    </TxnLink>
  )
}

const FLAG_BADGE: Record<FlaggedDoc['flagType'], { label: string; cls: string }> = {
  duplicate: { label: 'Duplicate', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400' },
  weekend: { label: 'Weekend', cls: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-400' },
  rsf: { label: 'RSF', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400' },
  zscore: { label: 'Z-Score', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400' },
  trap: { label: '99-Trap', cls: 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400' },
  sequential: { label: 'Sequential', cls: 'bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-400' },
}

function FlaggedTable({ items, showReason = true }: { items: FlaggedDoc[]; showReason?: boolean }) {
  return (
    <div className="max-h-128 overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white dark:bg-slate-900">
          <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <th className="px-4 py-2 text-left font-medium">Date</th>
            <th className="px-4 py-2 text-left font-medium">Document</th>
            <th className="px-4 py-2 text-left font-medium">Party</th>
            <th className="px-4 py-2 text-right font-medium">Amount</th>
            <th className="px-4 py-2 text-center font-medium">Flag</th>
            {showReason ? <th className="px-4 py-2 text-left font-medium">Reason</th> : null}
            <th className="px-4 py-2 text-right font-medium">Risk</th>
          </tr>
        </thead>
        <tbody>
          {items.length ? items.map((f, i) => (
            <tr key={`${f.docId}-${f.flagType}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
              <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{f.date}</td>
              <td className="px-4 py-2"><DocCell f={f} /></td>
              <td className="max-w-44 truncate px-4 py-2 text-slate-600 dark:text-slate-300" title={f.partyName}>{f.partyName || '—'}</td>
              <td className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{money0(f.amount)}</td>
              <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', FLAG_BADGE[f.flagType].cls)}>{FLAG_BADGE[f.flagType].label}</span></td>
              {showReason ? <td className="max-w-72 truncate px-4 py-2 text-xs text-slate-400 dark:text-slate-500" title={f.reason}>{f.reason}</td> : null}
              <td className="px-4 py-2 text-right"><RiskPill score={f.riskScore} /></td>
            </tr>
          )) : (
            <tr><td colSpan={showReason ? 7 : 6} className="px-4 py-10 text-center text-sm text-slate-400"><CheckCircle2 size={20} className="mx-auto mb-1.5 text-emerald-500" />Nothing flagged</td></tr>
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
  const [tab, setTab] = useState<Tab>('overview')
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const s = data.summary

  return (
    <div className="space-y-5">
      {/* Full-dataset proof banner — the anti-"artificial subset" statement. */}
      <p className="flex items-center gap-2 rounded-lg bg-slate-50 px-3.5 py-2 text-xs text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
        <Database size={13} className="shrink-0 text-teal-500" />
        Analyzed across your <span className="font-semibold text-slate-700 dark:text-slate-200">complete ledger</span>:
        {' '}{num(data.meta.totalDocs)} documents · {money(data.meta.totalAmount)} · {num(data.meta.days)} days · in {(data.meta.queryMs / 1000).toFixed(1)}s — no caps or date-range limits.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <RiskGauge score={s.overallRiskScore} />
        <KpiCard icon={Flag} accent={s.flaggedCount > 0 ? 'red' : 'emerald'} label="Flagged" value={num(s.flaggedCount)} sub={`${money(s.totalAtRisk)} at risk`} tone={s.flaggedCount > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={Copy} accent="amber" label="Duplicate Pairs" value={num(s.duplicateCount)} sub={money(s.totalDuplicateAmount)} tone={s.duplicateCount > 0 ? 'negative' : 'neutral'} />
        <KpiCard icon={BarChart3} accent={s.benfordConformity === 'Non-Conforming' ? 'red' : s.benfordConformity === 'Marginal' ? 'amber' : 'emerald'} label="Benford" value={s.benfordConformity} sub={`2D: ${s.benford2DConformity}`} />
        <KpiCard icon={ShieldAlert} accent={s.ghostCount + s.sequentialGroups > 0 ? 'red' : 'emerald'} label="Shell Signals" value={num(s.ghostCount + s.sequentialGroups)} sub={`${s.ghostCount} ghosts · ${s.sequentialGroups} sequential`} tone={s.ghostCount + s.sequentialGroups > 0 ? 'negative' : 'positive'} />
      </div>

      <div className="-mx-1 overflow-x-auto">
        <div className="flex min-w-max gap-0.5 border-b border-slate-200 px-1 dark:border-slate-800">
          {TABS.map((k) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={cn('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors', tab === k ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>
              {TAB_LABEL[k]}
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
  const s = data.summary
  const b = data.benford1D
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Panel title="Benford's Law — First Digit" icon={BarChart3} hint={`${num(b.totalTransactions)} amounts · MAD ${b.mad.toFixed(4)} · ${b.conformity}`}>
            <Chart
              height={230}
              option={{
                grid: { top: 24, bottom: 24, left: 45, right: 12 },
                legend: { top: 0 },
                tooltip: { trigger: 'axis', valueFormatter: (v: any) => `${(Number(v) * 100).toFixed(1)}%` },
                xAxis: { type: 'category', data: b.digits.map((d) => String(d.digit)) },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` } },
                series: [
                  { name: 'Observed', type: 'bar', data: b.digits.map((d) => ({ value: d.observed, itemStyle: { color: d.isAnomaly ? '#ef4444' : '#14b8a6' } })) },
                  { name: 'Expected (Benford)', type: 'line', data: b.digits.map((d) => d.expected), symbolSize: 6, lineStyle: { width: 2, type: 'dashed', color: '#64748b' }, itemStyle: { color: '#64748b' } },
                ],
              }}
            />
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{b.message}</p>
          </Panel>
          <Panel title="Highest-Risk Flags" icon={Flag} hint="Across all detectors · click a document to open it" bodyClassName="p-0">
            <FlaggedTable items={data.flagged.slice(0, 10)} />
          </Panel>
        </div>
        <div className="space-y-5">
          <Panel title="Top Risk Areas" icon={AlertTriangle} bodyClassName="p-0">
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
              <p className="flex items-center gap-2 px-4 py-6 text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={15} />No elevated risk areas</p>
            )}
          </Panel>
          <Panel title="Detector Summary" icon={ShieldAlert}>
            <div className="grid grid-cols-2 gap-2 text-center">
              {[
                { label: 'Duplicates', value: num(s.duplicateCount), active: s.duplicateCount > 0 },
                { label: 'Weekend', value: num(s.weekendCount), active: s.weekendCount > 0 },
                { label: 'RSF', value: num(s.rsfCount), active: s.rsfCount > 0 },
                { label: 'Z-Score', value: num(s.zScoreCount), active: s.zScoreCount > 0 },
                { label: 'Sequential', value: num(s.sequentialGroups), active: s.sequentialGroups > 0 },
                { label: 'Ghost Vendors', value: num(s.ghostCount), active: s.ghostCount > 0 },
                { label: '99-Trap', value: num(s.trapCount), active: s.trapCount > 0 },
                { label: 'Audit Events', value: num(data.auditTrail.total), active: data.auditTrail.deletes > 0 },
              ].map((t) => (
                <div key={t.label} className={cn('rounded-lg p-2.5', t.active ? 'bg-slate-100 dark:bg-slate-800' : 'bg-slate-50/60 dark:bg-slate-800/40')}>
                  <p className="text-lg font-bold tabular-nums text-slate-800 dark:text-slate-200">{t.value}</p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500">{t.label}</p>
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
  const [sub, setSub] = useState<'1d' | '2d' | 'trap'>('1d')
  const [drill, setDrill] = useState<{ digit: number; dim: '1d' | '2d' } | null>(null)
  const b1 = data.benford1D
  const b2 = data.benford2D
  const trap = data.thresholdTrap
  return (
    <div className="space-y-4">
      <SubPills value={sub} onChange={setSub} options={[
        { key: '1d', label: 'First Digit (1D)' },
        { key: '2d', label: 'First Two Digits (2D)', count: b2.anomalies.length },
        { key: 'trap', label: 'Threshold Trap', count: trap.total },
      ]} />
      {drill ? <BenfordDrill digit={drill.digit} dim={drill.dim} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} /> : null}

      {sub === '1d' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard icon={Sigma} accent="sky" label="Amounts Analyzed" value={num(b1.totalTransactions)} sub="every document, no caps" />
            <KpiCard icon={Scale} accent={b1.conformity === 'Non-Conforming' ? 'red' : b1.conformity === 'Marginal' ? 'amber' : 'emerald'} label="Conformity" value={b1.conformity} sub={`MAD ${b1.mad.toFixed(4)}`} />
            <KpiCard icon={AlertTriangle} accent="amber" label="Deviating Digits" value={num(b1.digits.filter((d) => d.isAnomaly).length)} sub=">25% off expected" />
            <KpiCard icon={BarChart3} accent="violet" label="Digit 1 Share" value={`${((b1.digits[0]?.observed ?? 0) * 100).toFixed(1)}%`} sub="expected 30.1%" />
          </div>
          <Panel title="Observed vs Expected Distribution" icon={BarChart3}>
            <Chart
              height={280}
              option={{
                grid: { top: 24, bottom: 24, left: 45, right: 12 },
                legend: { top: 0 },
                tooltip: { trigger: 'axis', valueFormatter: (v: any) => `${(Number(v) * 100).toFixed(2)}%` },
                xAxis: { type: 'category', data: b1.digits.map((d) => String(d.digit)) },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` } },
                series: [
                  { name: 'Observed', type: 'bar', data: b1.digits.map((d) => ({ value: d.observed, itemStyle: { color: d.isAnomaly ? '#ef4444' : '#14b8a6' } })) },
                  { name: 'Expected', type: 'line', data: b1.digits.map((d) => d.expected), symbolSize: 6, lineStyle: { width: 2, type: 'dashed', color: '#64748b' }, itemStyle: { color: '#64748b' } },
                ],
              }}
            />
          </Panel>
          <Panel title="Digit Detail" icon={ListOrdered} hint="Click a digit to see the transactions behind it" bodyClassName="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Digit</th>
                  <th className="px-4 py-2 text-right font-medium">Count</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 text-right font-medium">Observed</th>
                  <th className="px-4 py-2 text-right font-medium">Expected</th>
                  <th className="px-4 py-2 text-right font-medium">Deviation</th>
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
            <KpiCard icon={Sigma} accent="sky" label="Amounts Analyzed" value={num(b2.totalTransactions)} sub="first-two-digit pairs" />
            <KpiCard icon={Scale} accent={b2.conformity === 'Non-Conforming' ? 'red' : b2.conformity === 'Marginal' ? 'amber' : 'emerald'} label="Conformity" value={b2.conformity} sub={`MAD ${b2.mad.toFixed(4)}`} />
            <KpiCard icon={AlertTriangle} accent={b2.anomalies.length > 0 ? 'amber' : 'emerald'} label="Anomalous Pairs" value={num(b2.anomalies.length)} sub=">50% off expected, n≥5" />
            <KpiCard icon={FileWarning} accent={data.summary.approvalLimitRisk ? 'red' : 'emerald'} label="Approval-Limit Risk" value={data.summary.approvalLimitRisk ? 'Yes' : 'No'} sub="see Threshold Trap" />
          </div>
          <Panel title="First-Two-Digit Distribution (10–99)" icon={BarChart3}>
            <Chart
              height={280}
              option={{
                grid: { top: 24, bottom: 24, left: 45, right: 12 },
                legend: { top: 0 },
                tooltip: { trigger: 'axis', valueFormatter: (v: any) => `${(Number(v) * 100).toFixed(2)}%` },
                xAxis: { type: 'category', data: b2.digits.map((d) => String(d.digit)), axisLabel: { interval: 9 } },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(1)}%` } },
                series: [
                  { name: 'Observed', type: 'bar', barCategoryGap: '10%', data: b2.digits.map((d) => ({ value: d.observed, itemStyle: { color: d.isAnomaly && d.count >= 5 ? '#ef4444' : '#14b8a6' } })) },
                  { name: 'Expected', type: 'line', data: b2.digits.map((d) => d.expected), symbol: 'none', lineStyle: { width: 1.5, type: 'dashed', color: '#64748b' } },
                ],
              }}
            />
          </Panel>
          {b2.anomalies.length ? (
            <Panel title="Anomalous Digit Pairs" icon={AlertTriangle} bodyClassName="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">Digits</th>
                    <th className="px-4 py-2 text-right font-medium">Count</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    <th className="px-4 py-2 text-right font-medium">Deviation</th>
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
            <KpiCard icon={FileWarning} accent={trap.total > 0 ? 'red' : 'emerald'} label="Trap Amounts" value={num(trap.total)} sub="ending 99 / 999 / 9999" tone={trap.total > 0 ? 'negative' : 'positive'} />
            <KpiCard icon={Scale} accent="amber" label="Total Value" value={money(trap.totalAmount)} sub="potential limit-gaming" />
            {trap.byTrap.map((t) => (
              <KpiCard key={t.trap} icon={Zap} accent="violet" label={`Ends in ${t.trap}`} value={num(t.count)} sub={money(t.amount)} />
            ))}
          </div>
          <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>Amounts just below round thresholds ($x99, $x999, $x9999) can indicate purchases engineered to stay under an approval limit. Recurrent traps from the same requester or vendor warrant review.</span>
          </p>
          <Panel title="Threshold-Trap Documents" icon={FileWarning} bodyClassName="p-0">
            <FlaggedTable items={trap.items} showReason={false} />
          </Panel>
        </div>
      ) : null}
    </div>
  )
}

/** Benford digit → transactions drill (Gantry openBenford1DDigitFlyout). */
function BenfordDrill({ digit, dim, from, to, onClose }: { digit: number; dim: '1d' | '2d'; from: string; to: string; onClose: () => void }) {
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
    <Drawer open onClose={onClose} size="lg" title={`${dim === '2d' ? 'First two digits' : 'Leading digit'}: ${digit}`} description={data ? `${num(data.count)} documents · ${money(data.total)}${data.count > data.documents.length ? ` (top ${data.documents.length})` : ''}` : 'Loading…'} bodyClassName="overflow-hidden flex flex-col p-0">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="p-6 text-center text-sm text-slate-400">Could not load transactions.</p>
        ) : !data ? (
          <p className="p-6 text-center text-sm text-slate-400">Loading…</p>
        ) : data.documents.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-400">No documents lead with {digit}.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Date</th>
                <th className="px-4 py-2 text-left font-medium">Document</th>
                <th className="px-4 py-2 text-left font-medium">Party</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
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
        { key: 'rsf', label: 'Relative Size Factor', count: data.rsf.total },
        { key: 'zscore', label: 'Z-Score', count: data.zscore.total },
        { key: 'calendar', label: 'Calendar' },
      ]} />

      {sub === 'rsf' ? (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span><span className="font-semibold">RSF</span> = amount ÷ the vendor&apos;s historical 2nd-largest transaction (36-month baseline, computed in one window-function pass). RSF ≥ 10 means a transaction wildly out of scale for that vendor — a classic error/fraud signal.</span>
          </p>
          <Panel title={`RSF Anomalies (${num(data.rsf.total)})`} icon={Scale} bodyClassName="p-0">
            <div className="max-h-128 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">Date</th>
                    <th className="px-4 py-2 text-left font-medium">Document</th>
                    <th className="px-4 py-2 text-left font-medium">Vendor</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    <th className="px-4 py-2 text-right font-medium">2nd Largest</th>
                    <th className="px-4 py-2 text-right font-medium">RSF</th>
                    <th className="px-4 py-2 text-right font-medium">Risk</th>
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
            <span><span className="font-semibold">Z-score</span> measures how many standard deviations a transaction sits from that vendor&apos;s own average (per-vendor baselines over 36 months, one aggregate pass). |z| ≥ 3 flags entity-specific outliers that global thresholds miss.</span>
          </p>
          <Panel title={`Z-Score Anomalies (${num(data.zscore.total)})`} icon={Sigma} bodyClassName="p-0">
            <div className="max-h-128 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">Date</th>
                    <th className="px-4 py-2 text-left font-medium">Document</th>
                    <th className="px-4 py-2 text-left font-medium">Party</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    <th className="px-4 py-2 text-right font-medium">Party Avg</th>
                    <th className="px-4 py-2 text-right font-medium">Z</th>
                    <th className="px-4 py-2 text-right font-medium">Risk</th>
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
        <Panel title="Spend Calendar" icon={CalendarDays} hint="Daily spend intensity — weekend spikes and unusual clusters stand out">
          <Chart option={calendarOption as any} height={Math.min(2, new Set(data.calendar.map((c) => c.date.slice(0, 4))).size) * 150 + 80} />
        </Panel>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- Detection */

function DetectionTab({ data }: { data: SentinelData }) {
  const [sub, setSub] = useState<'flagged' | 'duplicates' | 'weekend' | 'sequential' | 'ghost'>('flagged')
  const s = data.summary
  return (
    <div className="space-y-4">
      <SubPills value={sub} onChange={setSub} options={[
        { key: 'flagged', label: 'All Flagged', count: s.flaggedCount },
        { key: 'duplicates', label: 'Duplicates', count: s.duplicateCount },
        { key: 'weekend', label: 'Weekend', count: s.weekendCount },
        { key: 'sequential', label: 'Sequential', count: s.sequentialGroups },
        { key: 'ghost', label: 'Ghost Vendors', count: s.ghostCount },
      ]} />

      {sub === 'flagged' ? (
        <Panel
          title={`All Flagged Documents (top ${num(Math.min(300, s.flaggedCount))} of ${num(s.flaggedCount)})`}
          icon={Flag}
          bodyClassName="p-0"
          actions={
            <button
              type="button"
              onClick={() => exportCsv('flagged-documents', ['Date', 'Document', 'Kind', 'Party', 'Amount', 'Flag', 'Risk', 'Reason'], data.flagged.map((f) => [f.date, f.docNumber, f.kind, f.partyName, Math.round(f.amount), f.flagType, f.riskScore, f.reason]))}
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
            <KpiCard icon={Copy} accent="red" label="Duplicate Pairs" value={num(data.duplicates.total)} sub="all matching pairs" tone="negative" />
            <KpiCard icon={Scale} accent="amber" label="Value at Risk" value={money(s.totalDuplicateAmount)} sub="sum of pair amounts" />
            <KpiCard icon={Info} accent="slate" label="Rule" value="≤14 days" sub="same vendor + kind + amount, ≥$100" />
          </div>
          <Panel title="Potential Duplicate Pairs" icon={Copy} hint="Both documents open in their native module" bodyClassName="p-0">
            <div className="max-h-128 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-slate-900">
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">Vendor</th>
                    <th className="px-4 py-2 text-left font-medium">Doc 1</th>
                    <th className="px-4 py-2 text-left font-medium">Doc 2</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    <th className="px-4 py-2 text-right font-medium">Days Apart</th>
                    <th className="px-4 py-2 text-right font-medium">Confidence</th>
                    <th className="px-4 py-2 text-right font-medium">Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {data.duplicates.pairs.map((p, i) => (
                    <tr key={`${p.docId1}-${i}`} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="max-w-44 truncate px-4 py-2 font-medium text-slate-800 dark:text-slate-200" title={p.partyName}>{p.partyName}</td>
                      <td className="px-4 py-2">
                        <TxnLink entryId={p.docId1} docKind={p.kind} docId={p.docId1} className="text-teal-600 hover:underline dark:text-teal-400">{p.docNumber1 || KIND_LABEL[p.kind]}</TxnLink>
                        <span className="block text-[10px] tabular-nums text-slate-400">{p.date1}</span>
                      </td>
                      <td className="px-4 py-2">
                        <TxnLink entryId={p.docId2} docKind={p.kind} docId={p.docId2} className="text-teal-600 hover:underline dark:text-teal-400">{p.docNumber2 || KIND_LABEL[p.kind]}</TxnLink>
                        <span className="block text-[10px] tabular-nums text-slate-400">{p.date2}</span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{money0(p.amount)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{p.daysBetween}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{Math.round(p.confidence * 100)}%{p.sameMemo ? <span className="ml-1 text-[10px] text-rose-500">same memo</span> : null}</td>
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
            <KpiCard icon={CalendarDays} accent="violet" label="Weekend Documents" value={num(data.weekend.total)} sub={money(data.weekend.totalAmount)} />
            <KpiCard icon={CalendarDays} accent="sky" label="Saturday" value={num(data.weekend.saturday)} sub="documents" />
            <KpiCard icon={CalendarDays} accent="amber" label="Sunday" value={num(data.weekend.sunday)} sub="higher risk weighting" />
            <KpiCard icon={Info} accent="slate" label="Signal" value="Doc date" sub="accounting date on Sat/Sun" />
          </div>
          <Panel title="Weekend-Dated Documents (top 200 by amount)" icon={CalendarDays} bodyClassName="p-0">
            <FlaggedTable items={data.weekend.items} showReason={false} />
          </Panel>
        </div>
      ) : null}

      {sub === 'sequential' ? (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span><span className="font-semibold">Shell-company indicator:</span> if a vendor&apos;s invoice numbers to you are perfectly sequential over weeks or months, you are likely their <em>only</em> customer. Legitimate vendors have numbering gaps from invoicing others. Detected by scanning every vendor's reference numbers for unbroken runs.</span>
          </p>
          <div className="space-y-4">
            {data.sequential.length ? data.sequential.map((g, i) => (
              <Panel key={`${g.partyId}-${i}`} title={g.partyName} icon={ListOrdered} actions={<Badge variant={g.riskLevel === 'high' ? 'destructive' : 'warning'}>{g.riskLevel} · {g.riskScore}</Badge>}>
                <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">{g.reason} — total {money0(g.totalAmount)} ({g.firstDate} → {g.lastDate})</p>
                <div className="flex flex-wrap gap-1.5">
                  {g.invoices.map((inv) => (
                    <TxnLink key={inv.docId} entryId={inv.docId} docKind="vendor_bill" docId={inv.docId} className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:border-teal-400 hover:text-teal-600 dark:border-slate-700 dark:text-slate-300 dark:hover:text-teal-400">
                      <span className="font-semibold">#{inv.reference}</span> · {money(inv.amount)} · <span className="tabular-nums">{inv.date}</span>
                    </TxnLink>
                  ))}
                  {g.count > g.invoices.length ? <span className="px-2 py-1 text-xs text-slate-400">+{g.count - g.invoices.length} more</span> : null}
                </div>
              </Panel>
            )) : (
              <Panel title="Sequential Invoice Runs" icon={ListOrdered}><p className="py-6 text-center text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={18} className="mx-auto mb-1.5" />No gap-free sequential runs detected</p></Panel>
            )}
          </div>
        </div>
      ) : null}

      {sub === 'ghost' ? (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-sky-50 p-3 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span><span className="font-semibold">Ghost vendors</span> are payee companies controlled by employees. Two-phase matching across the full party registry: employee names against vendor names, and normalized street addresses (line 1 + postal code) shared between a paid vendor and an employee. Name match scores 75, shared address 90, both 95.</span>
          </p>
          {data.ghosts.length ? (
            <Panel title={`Ghost Vendor Matches (${data.ghosts.length})`} icon={Ghost} bodyClassName="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="px-4 py-2 text-left font-medium">Vendor</th>
                    <th className="px-4 py-2 text-left font-medium">Employee</th>
                    <th className="px-4 py-2 text-center font-medium">Match</th>
                    <th className="px-4 py-2 text-right font-medium">Risk</th>
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
            <Panel title="Ghost Vendors" icon={Ghost}><p className="py-6 text-center text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={18} className="mx-auto mb-1.5" />No vendor–employee name or address matches found</p></Panel>
          )}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ Vendors */

function VendorsTab({ data, onDrill }: { data: SentinelData; onDrill: (t: DrillTarget) => void }) {
  const { sorted, SortTh } = useSort(data.vendorRisk, { key: 'compositeScore', dir: 'desc' })
  return (
    <Panel title="Vendor Risk Roll-Up" icon={ShieldAlert} hint="Parties ranked by flag severity across all detectors · click a row for that party's transactions" bodyClassName="p-0">
      <div className="max-h-144 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white dark:bg-slate-900">
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <SortTh label="Party" col="partyName" align="left" defaultDir="asc" />
              <SortTh label="Flags" col="flagCount" />
              <SortTh label="Flagged Amount" col="totalAmount" />
              <th className="px-4 py-2 text-left font-medium">Flag Types</th>
              <SortTh label="Risk Score" col="compositeScore" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((v, i) => (
              <tr
                key={`${v.partyId}-${i}`}
                onClick={v.partyId ? () => onDrill({ kind: 'party', id: v.partyId!, name: v.partyName, sub: `${v.flagCount} flags · ${money0(v.totalAmount)} flagged` }) : undefined}
                className={cn('border-b border-slate-50 last:border-0 dark:border-slate-800/60', v.partyId && 'cursor-pointer hover:bg-slate-50/60 dark:hover:bg-slate-800/30')}
              >
                <td className="max-w-56 truncate px-4 py-2 font-medium text-slate-800 dark:text-slate-200" title={v.partyName}>{v.partyName}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{v.flagCount}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(v.totalAmount)}</td>
                <td className="px-4 py-2">
                  <span className="flex flex-wrap gap-1">
                    {v.flagTypes.map((t) => (
                      <span key={t} className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', FLAG_BADGE[t as FlaggedDoc['flagType']]?.cls ?? 'bg-slate-100 text-slate-600')}>{FLAG_BADGE[t as FlaggedDoc['flagType']]?.label ?? t}</span>
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
  const a = data.auditTrail
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiCard icon={History} accent="sky" label="Audit Events" value={num(a.total)} sub="in period" />
        <KpiCard icon={AlertTriangle} accent={a.deletes > 0 ? 'red' : 'emerald'} label="Deletions" value={num(a.deletes)} sub="records removed" tone={a.deletes > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={ShieldAlert} accent={a.sensitiveChanges > 0 ? 'amber' : 'emerald'} label="Sensitive Changes" value={num(a.sensitiveChanges)} sub="banking / contact / address" />
      </div>
      <p className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>Native audit log. Most records in this ledger were bulk-migrated, so change history begins at go-live — the trail grows as users work in openbooks.</span>
      </p>
      <Panel title="High-Risk Audit Events" icon={History} bodyClassName="p-0">
        <div className="max-h-128 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">When</th>
                <th className="px-4 py-2 text-left font-medium">Table</th>
                <th className="px-4 py-2 text-center font-medium">Action</th>
                <th className="px-4 py-2 text-left font-medium">Change</th>
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
                <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-400"><CheckCircle2 size={20} className="mx-auto mb-1.5 text-emerald-500" />No high-risk audit events in this period</td></tr>
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
  const c = data.config
  const items = [
    { label: 'Duplicates', value: `≤${c.duplicateDays}d · ≥$${c.duplicateMinAmount}`, note: 'Same vendor + document kind + amount; credits excluded; confidence by memo/date proximity' },
    { label: 'Benford conformity', value: 'MAD (Nigrini)', note: '1D bands 0.006/0.012/0.015 · 2D bands 0.0012/0.0022/0.0033' },
    { label: 'RSF', value: '≥10×', note: 'Amount ÷ vendor 2nd-largest over a 36-month baseline ($100 baseline floor)' },
    { label: 'Z-score', value: '|z| ≥ 3', note: 'Per-vendor mean/σ baseline, ≥5 transactions and σ > $10' },
    { label: 'Sequential runs', value: `≥${c.sequentialMinCount} refs · ≥${c.sequentialMinDays} days`, note: 'Gap-free vendor reference numbers; 30+ day spans rank high risk' },
    { label: 'Threshold trap', value: '99 / 999 / 9999', note: 'Whole-dollar endings (.00 or .99 cents) just under round limits' },
    { label: 'Weekend', value: 'Sat / Sun', note: 'Accounting document date (migrated data carries import timestamps, so system created-time is not meaningful here)' },
  ]
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <ConfigEditor
          dashboard="sentinel"
          fields={[
            { key: 'duplicateDays', label: 'Duplicate window (days)', help: 'Same vendor, kind and amount within this many days flags a pair', min: 1, max: 90, step: 1 },
            { key: 'duplicateMinAmount', label: 'Duplicate minimum ($)', help: 'Pairs below this amount are ignored', min: 0, max: 100_000, step: 50 },
            { key: 'sequentialMinCount', label: 'Sequential run minimum', help: 'Gap-free invoice-number runs need at least this many documents', min: 2, max: 50, step: 1 },
            { key: 'sequentialMinDays', label: 'Sequential span (days)', help: 'Runs spread over fewer days are treated as batch entry, not a flag', min: 1, max: 365, step: 1 },
          ]}
          values={c}
          defaults={{ duplicateDays: 14, duplicateMinAmount: 100, sequentialMinCount: 3, sequentialMinDays: 7 }}
        />
        <Panel title="Detector Thresholds" icon={SlidersHorizontal} bodyClassName="p-0">
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
      <Panel title="Complete coverage" icon={Database}>
        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <p>Every check runs across your <span className="font-semibold">complete ledger</span> — no 30-day windows, no per-vendor shortcuts, no sampling. Nothing is skipped:</p>
          <ul className="list-disc space-y-1 pl-5 text-slate-500 dark:text-slate-400">
            <li><span className="font-medium text-slate-700 dark:text-slate-200">Benford</span> — flags amounts whose leading digits don’t follow natural spending patterns.</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">Relative size &amp; z-score</span> — compares each transaction to that vendor’s own history to surface outliers.</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">Sequential runs</span> — catches suspiciously unbroken sequences of vendor reference numbers.</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">Duplicates</span> — compares every pair of transactions to catch repeated or split payments.</li>
          </ul>
          <p>This period: {num(data.meta.totalDocs)} documents ({money(data.meta.totalAmount)}) across {num(data.meta.days)} days, analyzed in {(data.meta.queryMs / 1000).toFixed(1)}s. Detail tables show the top matches per check; the counts and distributions always cover everything.</p>
        </div>
      </Panel>
    </div>
  )
}
