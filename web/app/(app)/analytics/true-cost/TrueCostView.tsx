'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import {
  AlertTriangle, Building2, Calculator, ChartArea, CheckCircle2, Clock, Coins, DollarSign,
  Grid3X3, Info, Layers, Package, Percent, Pin, PlusCircle, RotateCcw, Scale, SlidersHorizontal,
  TrendingDown, TrendingUp, Trophy, UserRound, Wand2, Gauge as GaugeIcon, Download,
} from 'lucide-react'
import { cn, Select, Drawer } from '@openbooks/ui'
import type { CustomCategory, TrueCostData, TrueCostProfile } from '../../../../lib/analytics/true-cost-data'
import { KpiCard } from '../_ui/KpiCard'
import { Panel } from '../_ui/Panel'
import { Donut, Chart } from '../_ui/charts'
import { DrillDrawer, type DrillTarget } from '../_ui/DrillDrawer'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { exportCsv } from '../_ui/exportCsv'
import { useAnalyticsMoney } from '../_ui/format'
import { useMoney } from '@/components/money-provider'

/* ------------------------------------------------------------------ helpers */

type Tab = 'overview' | 'categories' | 'matrix' | 'absorption' | 'selling' | 'trends' | 'config'

/**
 * Which tabs each surface owns. The BUILDER (categories/matrix/config) lives in
 * the Setup "Overhead Model" workspace — the single source of truth for the
 * rate-engine config; the analytics dashboard is a read-only consumer
 * (overview/absorption/selling/trends) that links to Setup to configure.
 */
export type TrueCostMode = 'analytics' | 'setup'
const MODE_TABS: Record<TrueCostMode, readonly Tab[]> = {
  analytics: ['overview', 'absorption', 'selling', 'trends'],
  setup: ['categories', 'matrix', 'config'],
}
const useRate = () => {
  const { money } = useMoney()
  const t = useTranslations('analytics.trueCost')
  return (value: number) => t('formats.perHour', {
    amount: money(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  })
}
const useWholeNumber = () => {
  const format = useFormatter()
  return (value: number) => format.number(Math.round(value), { maximumFractionDigits: 0 })
}
const usePercent = () => {
  const format = useFormatter()
  return (value: number, fractionDigits = 0) => format.number(value / 100, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
}
const FALLBACK = '#94a3b8'

/** Pill wrapper for inline filter selects (the .srb-filter). */
function FilterPill({ icon: Icon, children }: { icon: typeof Building2; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full border border-slate-200 bg-white py-0.5 pl-2 pr-0.5 dark:border-slate-700 dark:bg-slate-900">
      <Icon size={11} className="shrink-0 text-slate-400" />
      {children}
    </span>
  )
}
/** Select trigger styled to sit borderless inside a FilterPill. */
const PILL_TRIGGER = 'h-6 rounded-full border-0 bg-transparent px-1.5 text-xs shadow-none dark:bg-transparent'

const ALLOCATION_BASE_KEYS = [
  'billed_hours', 'total_hours', 'labor_dollars', 'headcount',
  'revenue', 'direct_cost', 'square_feet', 'units', 'custom',
] as const

/* ---------------------------------------------------------- API mutations */

async function apiCall(path: string, init: RequestInit): Promise<boolean> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })
  return res.ok
}
const pinAccount = (groupId: string, accountId: string) =>
  apiCall(`/api/account-groups/${groupId}/pins`, { method: 'POST', body: JSON.stringify({ accountId }) })
const unpinAccount = (groupId: string, accountId: string) =>
  apiCall(`/api/account-groups/${groupId}/pins?accountId=${accountId}`, { method: 'DELETE' })
const patchGroup = (groupId: string, body: { name?: string; color?: string; match?: object }) =>
  apiCall(`/api/account-groups/${groupId}`, { method: 'PATCH', body: JSON.stringify(body) })

/** Read the full engine config, apply a mutation to the ACTIVE profile, PUT it back. */
type TrueCostConfigResponse = { activeProfileId: string; profiles: TrueCostProfile[] }

async function mutateActiveProfile(mutate: (profile: TrueCostProfile) => void): Promise<boolean> {
  const res = await fetch('/api/analytics/true-cost/config')
  if (!res.ok) return false
  const cfg = await res.json() as TrueCostConfigResponse
  const profile = cfg.profiles.find((p) => p.id === cfg.activeProfileId) ?? cfg.profiles[0]
  if (!profile) return false
  mutate(profile)
  return apiCall('/api/analytics/true-cost/config', { method: 'PUT', body: JSON.stringify(cfg) })
}
/** Set the active profile, then PUT. */
async function switchProfile(activeProfileId: string): Promise<boolean> {
  const res = await fetch('/api/analytics/true-cost/config')
  if (!res.ok) return false
  const cfg = await res.json() as TrueCostConfigResponse
  cfg.activeProfileId = activeProfileId
  return apiCall('/api/analytics/true-cost/config', { method: 'PUT', body: JSON.stringify(cfg) })
}

/* ------------------------------------------------------------------- shell */

type CellRef = { catId: string; deptId: string }

export function TrueCostView({ data, mode = 'analytics' }: { data: TrueCostData; mode?: TrueCostMode }) {
  const rate = useRate()
  const whole = useWholeNumber()
  const percent = usePercent()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const t = useTranslations('analytics.trueCost')
  const router = useRouter()
  const tabs = MODE_TABS[mode]
  const [tab, setTab] = useState<Tab>(tabs[0]!)
  const [openCatId, setOpenCatId] = useState<string | null>(null)
  const [openDeptId, setOpenDeptId] = useState<string | null>(null)
  const [cell, setCell] = useState<CellRef | null>(null)
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const k = data.kpis
  const under = k.gap < 0
  // Cross-surface navigation: a builder tab requested from the read-only
  // analytics surface routes to the Setup workspace (and vice versa).
  const goTo = (t: Tab) => {
    if (tabs.includes(t)) setTab(t)
    else router.push(mode === 'analytics' ? '/admin/setup/overhead' : '/analytics/true-cost')
  }

  return (
    <div className="space-y-5">
      {mode === 'analytics' ? (
        /* Hero — the 5 KPIs verbatim (dashboard surface only) */
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiCard
            icon={GaugeIcon} accent="sky" label={t('hero.compositeRate')} value={rate(k.compositeRate)}
            sub={k.compositeRateChangePct == null ? t('hero.compositeSubDefault') : t('hero.vsPrior', { arrow: k.compositeRateChangePct > 0 ? '↑' : '↓', change: percent(Math.abs(k.compositeRateChangePct), 1) })}
            tone={k.compositeRateChangePct != null && k.compositeRateChangePct > 0 ? 'negative' : 'neutral'}
          />
          <KpiCard icon={Package} accent="red" label={t('hero.totalOverhead')} value={money(k.totalOverhead)} sub={t('hero.accountsCount', { count: k.overheadAccounts })} />
          <KpiCard icon={Coins} accent="emerald" label={t('hero.overheadApplied')} value={money(k.burdenApplied)} sub={t('hero.recovered')} tone="positive" />
          <KpiCard icon={Scale} accent={under ? 'red' : 'emerald'} label={t('hero.absorption')} value={`${k.gap < 0 ? '−' : '+'}${money(Math.abs(k.gap))}`} sub={under ? t('hero.underAbsorbed') : t('hero.overAbsorbed')} tone={under ? 'negative' : 'positive'} />
          <KpiCard icon={Clock} accent="amber" label={t('hero.billedHours')} value={whole(k.billedHours)} sub={t('hero.utilizationPct', { pct: percent(k.utilization * 100) })} />
        </div>
      ) : null}

      <div className="-mx-1 overflow-x-auto">
        <div className="flex min-w-max items-center gap-0.5 border-b border-slate-200 px-1 dark:border-slate-800">
          {tabs.map((key) => (
            <button key={key} type="button" onClick={() => setTab(key)} className={cn('-mb-px shrink-0 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors', tab === key ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>
              {t(`tabs.${key}`)}
            </button>
          ))}
          {mode === 'analytics' ? (
            <button type="button" onClick={() => router.push('/admin/setup/overhead')} className="-mb-px ml-auto flex shrink-0 items-center gap-1 px-3.5 py-2 text-xs font-medium text-teal-600 hover:underline dark:text-teal-400">
              <SlidersHorizontal size={12} aria-hidden /> {t('configureInSetup')}
            </button>
          ) : null}
        </div>
      </div>

      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} goTo={goTo} openCat={setOpenCatId} openDept={setOpenDeptId} /> : null}
        {tab === 'categories' ? <CategoriesTab data={data} openCat={setOpenCatId} /> : null}
        {tab === 'matrix' ? <MatrixTab data={data} onDrill={setCell} /> : null}
        {tab === 'absorption' ? <AbsorptionTab data={data} /> : null}
        {tab === 'selling' ? <SellingTab data={data} /> : null}
        {tab === 'trends' ? <TrendsTab data={data} /> : null}
        {tab === 'config' ? <ConfigTab data={data} /> : null}
      </div>

      {openCatId ? <CategoryFlyout catId={openCatId} data={data} onClose={() => setOpenCatId(null)} onDrillAccount={setDrill} /> : null}
      {openDeptId ? <DeptFlyout deptId={openDeptId} data={data} onClose={() => setOpenDeptId(null)} /> : null}
      {cell ? <CellFlyout cell={cell} data={data} onClose={() => setCell(null)} /> : null}
      <DrillDrawer target={drill} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} />
    </div>
  )
}

/* ---------------------------------------------------------------- Overview */

function OverviewTab({ data, goTo, openCat, openDept }: { data: TrueCostData; goTo: (t: Tab) => void; openCat: (id: string) => void; openDept: (id: string) => void }) {
  const t = useTranslations('analytics.trueCost')
  const rate = useRate()
  const whole = useWholeNumber()
  const percent = usePercent()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const money0 = (n: number) => fmtMoney(n)
  const k = data.kpis
  const cats = data.categories

  return (
    <div className="space-y-5">
      <Panel
        title={t('panels.rateComposition')}
        icon={Layers}
        actions={
          <span className="flex items-center gap-2">
            {data.unassigned.length > 0 ? (
              <button type="button" onClick={() => goTo('categories')} className="flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle size={12} />
                <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">{whole(data.unassigned.length)}</span>
                {t('actions.unassigned')}
              </button>
            ) : null}
            <button type="button" onClick={() => goTo('categories')} className="rounded-md border border-teal-500/50 px-2.5 py-1 text-xs font-medium text-teal-600 hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-teal-950/40">{t('actions.manage')}</button>
          </span>
        }
        bodyClassName="p-0"
      >
        {/* Summary strip */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 bg-slate-50/60 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/30">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{t('summary.compositeRate')}</p>
            <p className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{rate(k.compositeRate)}</p>
          </div>
          <div className="flex gap-6 text-right">
            <div><p className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{t('summary.periodBurden')}</p><p className="text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-200">{money0(k.totalOverhead)}</p></div>
            <div><p className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{t('summary.billedHours')}</p><p className="text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-200">{whole(k.billedHours)}</p></div>
            <div><p className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{t('summary.categories')}</p><p className="text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-200">{whole(cats.length)}</p></div>
          </div>
        </div>

        {/* Segmented composition bar */}
        {k.compositeRate > 0 ? (
          <div className="px-4 pt-3">
            <div className="flex h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              {cats.map((c) => (
                <div key={c.id} title={`${c.name} ${rate(c.rate)}`} style={{ width: `${Math.max(0, (c.rate / k.compositeRate) * 100)}%`, backgroundColor: c.color ?? FALLBACK }} />
              ))}
            </div>
          </div>
        ) : null}

        {/* Category cards grid with mini donuts */}
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
          {cats.map((c) => {
            const pct = k.compositeRate > 0 ? (c.rate / k.compositeRate) * 100 : 0
            const deptSlices = data.departments.map((d) => ({ value: c.byDept[d.id]?.amount ?? 0 })).filter((s) => s.value > 0)
            return (
              <button key={c.id} type="button" onClick={() => openCat(c.id)} className="rounded-xl bg-slate-50/80 p-3 text-left transition-all hover:bg-white hover:shadow dark:bg-slate-800/40 dark:hover:bg-slate-800">
                <div className="flex items-center gap-3">
                  <MiniDonut color={c.color ?? FALLBACK} slices={deptSlices.length ? deptSlices.map((s) => s.value) : [1]} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-200">{c.name}</p>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500">{t(c.categoryType === 'expense' ? 'cards.typeExpense' : c.categoryType === 'time' ? 'cards.typeTime' : 'cards.typeCustom')} · {percent(pct)}</p>
                  </div>
                  <p className="text-base font-bold tabular-nums text-slate-900 dark:text-slate-100">{rate(c.rate)}</p>
                </div>
                <div className="mt-2.5 flex justify-between border-t border-slate-200/70 pt-2 text-center dark:border-slate-700/60">
                  <span className="flex-1"><span className="block text-[9px] uppercase text-slate-400">{t('cards.period')}</span><span className="text-xs font-semibold tabular-nums text-slate-600 dark:text-slate-300">{money(c.totalAmount)}</span></span>
                  {c.categoryType === 'expense'
                    ? <span className="flex-1"><span className="block text-[9px] uppercase text-slate-400">{t('cards.accounts')}</span><span className="text-xs font-semibold tabular-nums text-slate-600 dark:text-slate-300">{whole(c.accounts.length)}</span></span>
                    : <span className="flex-1"><span className="block text-[9px] uppercase text-slate-400">{t('cards.source')}</span><span className="text-xs font-semibold capitalize text-slate-600 dark:text-slate-300">{c.categoryType === 'time' ? t('cards.timesheets') : c.categoryType}</span></span>}
                  <span className="flex-1"><span className="block text-[9px] uppercase text-slate-400">{t('cards.base')}</span><span className="text-xs font-semibold text-slate-600 dark:text-slate-300">{t('cards.baseHours')}</span></span>
                </div>
              </button>
            )
          })}
        </div>

        <div className="flex gap-5 border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-xs text-slate-400 dark:border-slate-800 dark:bg-slate-800/30 dark:text-slate-500">
          <span className="flex items-center gap-1.5"><Building2 size={12} />{t('footer.departments', { count: data.departments.length })}</span>
          <span className="flex items-center gap-1.5"><UserRound size={12} />{t('footer.employees', { count: Math.round(k.employeeCount) })}</span>
          <span className="flex items-center gap-1.5"><Clock size={12} />{t('footer.hoursWorked', { count: Math.round(k.totalHours) })}</span>
        </div>
      </Panel>

      <Panel title={t('panels.rateByDepartment')} icon={Building2} actions={<button type="button" onClick={() => goTo('matrix')} className="text-xs font-medium text-teal-600 hover:underline dark:text-teal-400">{t('actions.viewFullMatrix')}</button>}>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          {data.departments.map((d) => (
            <button key={d.id} type="button" onClick={() => openDept(d.id)} className="rounded-lg bg-slate-50/80 p-3 text-center transition-all hover:bg-white hover:shadow dark:bg-slate-800/40 dark:hover:bg-slate-800">
              <p className="truncate text-xs font-medium text-slate-500 dark:text-slate-400" title={d.name}>{d.name}</p>
              <p className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{rate(d.composite)}</p>
              <p className="text-[10px] text-slate-400 dark:text-slate-500">{t('absorption.hrsShort', { count: Math.round(d.billedHours) })}</p>
            </button>
          ))}
        </div>
      </Panel>
    </div>
  )
}

/** Tiny SVG donut for category cards (dept split in the category colour). */
function MiniDonut({ color, slices }: { color: string; slices: number[] }) {
  const total = slices.reduce((s, v) => s + v, 0) || 1
  const r = 16, cx = 22, cy = 22, sw = 8
  const circ = 2 * Math.PI * r
  const offsets = slices.map((_, index) => slices.slice(0, index).reduce((sum, value) => sum + value, 0) / total)
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" className="shrink-0 -rotate-90">
      {slices.map((v, i) => {
        const frac = v / total
        const dash = frac * circ
        return (
          <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeOpacity={1 - i * 0.18} strokeWidth={sw} strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={-offsets[i]! * circ} />
        )
      })}
    </svg>
  )
}

/* --------------------------------------------------------- Category flyout */

function CategoryFlyout({ catId, data, onClose, onDrillAccount }: { catId: string; data: TrueCostData; onClose: () => void; onDrillAccount: (t: DrillTarget) => void }) {
  const t = useTranslations('analytics.trueCost')
  const rate = useRate()
  const { currency } = useMoney()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const money0 = (n: number) => fmtMoney(n)
  const router = useRouter()
  const cat = data.categories.find((c) => c.id === catId)
  const [busy, setBusy] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [name, setName] = useState(cat?.name ?? '')
  const [color, setColor] = useState(cat?.color ?? FALLBACK)
  const [pattern, setPattern] = useState(cat?.match.namePattern ?? '')
  if (!cat) return null

  const dirty = name !== cat.name || color !== (cat.color ?? FALLBACK) || pattern !== (cat.match.namePattern ?? '')
  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true)
    await fn()
    router.refresh()
    setBusy(false)
  }
  const setAllocation = (patch: Record<string, unknown>) =>
    run(() => mutateActiveProfile((profile) => { profile.categorySettings ??= {}; profile.categorySettings[cat.id] = { ...profile.categorySettings[cat.id], ...patch } }))

  const baseLabel = (ALLOCATION_BASE_KEYS as readonly string[]).includes(cat.allocationBase)
    ? t(`bases.${cat.allocationBase}`)
    : cat.allocationBase
  const methodLabel = cat.allocationMethod === 'simple'
    ? t('allocation.simple')
    : cat.allocationMethod === 'weighted'
      ? t('allocation.weighted')
      : t('allocation.stepped')
  const isExpense = cat.categoryType === 'expense'
  const typeNoteKey = ({ time: 'drawer.noteTime', manual: 'drawer.noteManual', derived: 'drawer.noteDerived', formula: 'drawer.noteFormula' } as Record<string, string>)[cat.categoryType]

  return (
    <Drawer open onClose={onClose} size="lg" title={cat.name} description={t('drawer.description', { total: money0(cat.totalAmount), rateDisplay: cat.rateDisplay, base: baseLabel, method: methodLabel })} bodyClassName="p-0 overflow-y-auto">
      {/* Definition / edit — account-group categories only */}
      {isExpense ? (
        <div className="border-b border-slate-100 dark:border-slate-800">
          <button type="button" onClick={() => setEditOpen(!editOpen)} className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40">
            <span className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Wand2 size={14} className="text-slate-400" />{t('drawer.definition')}</span>
            <span className="text-xs text-teal-600 dark:text-teal-400">{editOpen ? t('drawer.hide') : t('drawer.edit')}</span>
          </button>
          {editOpen ? (
            <div className="space-y-2.5 border-t border-slate-100 bg-slate-50/60 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/30">
              <div className="flex items-center gap-2">
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-950" aria-label={t('drawer.colourAria')} />
                <input value={name} onChange={(e) => setName(e.target.value)} className="h-8 flex-1 rounded-md border border-slate-200 bg-white px-2.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" placeholder={t('drawer.namePlaceholder')} />
              </div>
              <div>
                <p className="mb-1 text-[11px] text-slate-400 dark:text-slate-500">{t('drawer.autoMatchRule')}</p>
                <input value={pattern} onChange={(e) => setPattern(e.target.value)} className="h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" placeholder={t('drawer.patternPlaceholder')} />
              </div>
              <div className="flex justify-end">
                <button type="button" disabled={!dirty || busy} onClick={() => run(() => patchGroup(cat.id, { name, color, match: { ...cat.match, namePattern: pattern || undefined } }))} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
                  {busy ? t('drawer.saving') : t('drawer.save')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="border-b border-slate-100 bg-slate-50/40 px-4 py-3 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:bg-slate-800/20 dark:text-slate-400">
          {typeNoteKey ? t(typeNoteKey) : t('drawer.computedBurden')}
        </p>
      )}

      {/* Allocation settings */}
      <div className="space-y-2.5 border-b border-slate-100 bg-slate-50/40 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/20">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t('allocation.title')}</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] text-slate-500 dark:text-slate-400">
            {t('allocation.base')}
            <Select value={cat.allocationBase} disabled={busy} onChange={(e) => setAllocation({ allocationBase: e.target.value })} className="mt-0.5 w-full" triggerClassName="h-7 text-xs">
              {ALLOCATION_BASE_KEYS.map((k) => <option key={k} value={k}>{t(`bases.${k}`)}</option>)}
            </Select>
          </label>
          <label className="text-[11px] text-slate-500 dark:text-slate-400">
            {t('allocation.method')}
            <Select value={cat.allocationMethod} disabled={busy} onChange={(e) => setAllocation({ allocationMethod: e.target.value })} className="mt-0.5 w-full" triggerClassName="h-7 text-xs">
              <option value="simple">{t('allocation.simple')}</option>
              <option value="weighted">{t('allocation.weighted')}</option>
              <option value="stepped">{t('allocation.stepped')}</option>
            </Select>
          </label>
          <label className="text-[11px] text-slate-500 dark:text-slate-400">
            {t('allocation.rateFormat')}
            <Select value={cat.rateFormat} disabled={busy} onChange={(e) => setAllocation({ rateFormat: e.target.value })} className="mt-0.5 w-full" triggerClassName="h-7 text-xs">
              <option value="per_hour">{t('allocation.perHour', { currency })}</option>
              <option value="percent_labor">{t('allocation.percentLabor')}</option>
              <option value="percent_cost">{t('allocation.percentCost')}</option>
              <option value="per_fte">{t('allocation.perFte', { currency })}</option>
              <option value="per_unit">{t('allocation.perUnit', { currency })}</option>
            </Select>
          </label>
          <label className="flex items-end gap-1.5 pb-1 text-[11px] text-slate-500 dark:text-slate-400">
            <input type="checkbox" checked={cat.includeInComposite} disabled={busy} onChange={(e) => setAllocation({ includeInComposite: e.target.checked })} className="h-3.5 w-3.5 rounded border-slate-300" />
            {t('allocation.includeInComposite')}
          </label>
        </div>
        <p className="text-[11px] text-slate-400 dark:text-slate-500">{t('allocation.rateFormula', { base: baseLabel, method: methodLabel, rate: cat.rateDisplay })}</p>
      </div>

      {/* Per-department rates */}
      <div className="border-b border-slate-100 p-4 dark:border-slate-800">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{t('allocation.rateByDepartment')}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {data.departments.map((d) => (
            <div key={d.id} className="rounded-lg bg-slate-50 p-2 text-center dark:bg-slate-800/50">
              <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">{d.name}</p>
              <p className="text-sm font-bold tabular-nums" style={{ color: cat.color ?? undefined }}>{rate(cat.byDept[d.id]?.rate ?? 0)}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Included accounts — account-group categories only */}
      {isExpense ? (
      <div className="border-b border-slate-100 dark:border-slate-800">
        <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">{t('accountsPanel.included', { count: cat.accounts.length })}</p>
        <table className="w-full text-sm">
          <tbody>
            {cat.accounts.map((a) => (
              <tr key={a.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                <td className="px-4 py-2">
                  <button type="button" onClick={() => onDrillAccount({ kind: 'account', id: a.id, name: a.name, sub: a.number ? t('drill.accountSub', { number: a.number }) : undefined })} className="text-left text-slate-700 hover:text-teal-600 dark:text-slate-300 dark:hover:text-teal-400" title={t('accountsPanel.viewTransactions')}>
                    {a.number ? <span className="mr-2 text-xs tabular-nums text-slate-400">{a.number}</span> : null}
                    {a.name}
                  </button>
                </td>
                <td className="px-2 py-2 text-center">
                  {a.pinned
                    ? <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-semibold text-teal-700 dark:bg-teal-950/50 dark:text-teal-400"><Pin size={9} />{t('accountsPanel.pinned')}</span>
                    : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">{t('accountsPanel.rule')}</span>}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">{money0(a.amount)}</td>
                <td className="py-2 pl-1 pr-3 text-right">
                  <span className="inline-flex items-center gap-1">
                    <Select
                      value=""
                      disabled={busy}
                      onChange={(e) => { const v = e.target.value; if (v) void run(() => pinAccount(v, a.id)) }}
                      className="w-28"
                      triggerClassName="h-6 px-1.5 text-[11px]"
                      aria-label={t('accountsPanel.moveAria', { name: a.name })}
                    >
                      <option value="">{t('accountsPanel.moveTo')}</option>
                      {data.categories.filter((c) => c.id !== cat.id).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </Select>
                    {a.pinned ? (
                      <button type="button" disabled={busy} title={t('accountsPanel.unpinTitle')} onClick={() => run(() => unpinAccount(cat.id, a.id))} className="rounded-md border border-slate-200 px-1.5 py-1 text-[10px] text-slate-500 hover:text-rose-500 dark:border-slate-700">{t('accountsPanel.unpin')}</button>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      ) : null}

      {/* Add accounts (from unassigned) — account-group categories only */}
      {isExpense && data.unassigned.length ? (
        <div className="p-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{t('accountsPanel.addUnassigned')}</p>
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {data.unassigned.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span className="min-w-0 truncate text-slate-600 dark:text-slate-300">{u.number ? <span className="mr-2 text-xs tabular-nums text-slate-400">{u.number}</span> : null}{u.name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums text-slate-400">{money(u.amount)}</span>
                  <button type="button" disabled={busy} onClick={() => run(() => pinAccount(cat.id, u.id))} className="rounded-md border border-teal-500/50 px-2 py-0.5 text-[11px] font-medium text-teal-600 hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-teal-950/40">{t('accountsPanel.add')}</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Drawer>
  )
}

/* ------------------------------------------------------ Dept + cell drills */

function DeptFlyout({ deptId, data, onClose }: { deptId: string; data: TrueCostData; onClose: () => void }) {
  const t = useTranslations('analytics.trueCost')
  const rate = useRate()
  const fmtMoney = useAnalyticsMoney()
  const money0 = (n: number) => fmtMoney(n)
  const dept = data.departments.find((d) => d.id === deptId)
  if (!dept) return null
  const rows = data.categories
    .map((c) => ({ c, r: c.byDept[deptId]?.rate ?? 0, amt: c.byDept[deptId]?.amount ?? 0 }))
    .filter((x) => x.amt !== 0)
    .sort((a, b) => b.r - a.r)
  return (
    <Drawer open onClose={onClose} size="md" title={dept.name} description={t('deptFlyout.description', { billed: Math.round(dept.billedHours), total: Math.round(dept.totalHours) })} bodyClassName="p-0 overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white dark:bg-slate-900">
          <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <th className="px-4 py-2 text-left font-medium">{t('deptFlyout.colCategory')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('deptFlyout.colExpense')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('deptFlyout.colRate')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ c, r, amt }) => (
            <tr key={c.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
              <td className="px-4 py-2">
                <span className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: c.color ?? FALLBACK }} />
                  {c.name}
                </span>
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{money0(amt)}</td>
              <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-200">{rate(r)}</td>
            </tr>
          ))}
          <tr className="bg-slate-50/70 font-bold dark:bg-slate-800/40">
            <td className="px-4 py-2.5 text-slate-900 dark:text-slate-100">{t('deptFlyout.composite')}</td>
            <td className="px-4 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(rows.reduce((s, x) => s + x.amt, 0))}</td>
            <td className="px-4 py-2.5 text-right tabular-nums text-slate-900 dark:text-slate-100">{rate(dept.composite)}</td>
          </tr>
        </tbody>
      </table>
    </Drawer>
  )
}

function CellFlyout({ cell, data, onClose }: { cell: CellRef; data: TrueCostData; onClose: () => void }) {
  const t = useTranslations('analytics.trueCost')
  const rate = useRate()
  const whole = useWholeNumber()
  const percent = usePercent()
  const fmtMoney = useAnalyticsMoney()
  const money0 = (n: number) => fmtMoney(n)
  const cat = data.categories.find((c) => c.id === cell.catId)
  const dept = data.departments.find((d) => d.id === cell.deptId)
  if (!cat || !dept) return null
  const deptShare = data.kpis.billedHours > 0 ? dept.billedHours / data.kpis.billedHours : 0
  const cellData = cat.byDept[dept.id] ?? { amount: 0, rate: 0 }
  const rows = cat.accounts
    .map((a) => {
      const tagged = a.deptAmounts[dept.id] ?? 0
      const allocated = a.untaggedAmount * deptShare
      return { a, tagged, allocated, total: tagged + allocated }
    })
    .filter((x) => Math.abs(x.total) > 0)
    .sort((x, y) => y.total - x.total)
  const taggedSum = rows.reduce((s, x) => s + x.tagged, 0)
  const allocatedSum = rows.reduce((s, x) => s + x.allocated, 0)

  return (
    <Drawer open onClose={onClose} size="lg" title={`${cat.name} — ${dept.name}`} description={t('cellFlyout.description')} bodyClassName="p-0 overflow-y-auto">
      {/* Rate math strip */}
      <div className="grid grid-cols-3 gap-px border-b border-slate-100 bg-slate-100 dark:border-slate-800 dark:bg-slate-800">
        {[
          { label: t('cellFlyout.expenseInDept'), value: money0(cellData.amount) },
          { label: t('cellFlyout.deptBilledHours'), value: whole(dept.billedHours) },
          { label: t('cellFlyout.rate'), value: rate(cellData.rate) },
        ].map((s, i) => (
          <div key={i} className="bg-white p-3.5 text-center dark:bg-slate-900">
            <p className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{s.value}</p>
            <p className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{s.label}</p>
          </div>
        ))}
      </div>
      {cat.categoryType === 'expense' ? (
        <>
          <p className="border-b border-slate-100 bg-slate-50/60 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/30 dark:text-slate-400">
            {t('cellFlyout.expenseMath', { direct: money0(taggedSum), dept: dept.name, allocated: money0(allocatedSum), share: percent(deptShare * 100, 1), billed: Math.round(dept.billedHours) })}
          </p>
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('cellFlyout.colAccount')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('cellFlyout.colDeptTagged')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('cellFlyout.colAllocated')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('cellFlyout.colTotal')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('cellFlyout.colRateHr')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ a, tagged, allocated, total }) => (
                <tr key={a.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{a.number ? <span className="mr-2 text-xs tabular-nums text-slate-400">{a.number}</span> : null}{a.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{tagged ? money0(tagged) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-400">{allocated ? money0(allocated) : '—'}</td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-200">{money0(total)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{rate(dept.billedHours > 0 ? total / dept.billedHours : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="px-4 py-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {cat.categoryType === 'time'
            ? t('cellFlyout.timeMath', { dept: dept.name, billed: Math.round(dept.billedHours) })
            : t('cellFlyout.otherMath', { amount: money0(cellData.amount), dept: dept.name, billed: Math.round(dept.billedHours) })}
        </p>
      )}
    </Drawer>
  )
}

/* -------------------------------------------------------------- Categories */

function CategoriesTab({ data, openCat }: { data: TrueCostData; openCat: (id: string) => void }) {
  const t = useTranslations('analytics.trueCost')
  const rate = useRate()
  const whole = useWholeNumber()
  const fmtMoney = useAnalyticsMoney()
  const money0 = (n: number) => fmtMoney(n)
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const categoryTypeLabel = (type: TrueCostData['categories'][number]['categoryType']) => {
    if (type === 'expense') return t('cards.typeExpense')
    if (type === 'time') return t('cards.typeTime')
    if (type === 'manual') return t('custom.typeManual')
    if (type === 'derived') return t('custom.typeDerived')
    return t('custom.typeFormula')
  }
  const assign = async (groupId: string, accountId: string) => {
    setBusy(true)
    await pinAccount(groupId, accountId)
    router.refresh()
    setBusy(false)
  }
  return (
    <div className="space-y-5">
      <Panel
        title={t('panels.overheadCategories')}
        icon={Layers}
        hint={t('hints.clickToInspect')}
        actions={
          <Link href="/admin/setup/account-groups" className="rounded-md border border-teal-500/50 px-2.5 py-1 text-xs font-medium text-teal-600 hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-teal-950/40">
            <PlusCircle size={11} className="mr-1 inline" />{t('actions.newCategory')}
          </Link>
        }
        bodyClassName="p-0"
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <th className="px-4 py-2 text-left font-medium">{t('deptFlyout.colCategory')}</th>
              <th className="px-4 py-2 text-left font-medium">{t('cards.type')}</th>
              <th className="px-4 py-2 text-left font-medium">{t('cards.base')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('cards.accounts')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('deptFlyout.colExpense')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('deptFlyout.colRate')}</th>
            </tr>
          </thead>
          <tbody>
            {data.categories.map((c) => (
              <tr key={c.id} onClick={() => openCat(c.id)} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40">
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-2.5">
                    <span className="grid h-7 w-7 place-items-center rounded-lg" style={{ backgroundColor: `${c.color ?? FALLBACK}22`, color: c.color ?? FALLBACK }}><Layers size={13} /></span>
                    <span className="font-medium text-slate-800 dark:text-slate-200">{c.name}</span>
                  </span>
                </td>
                <td className="px-4 py-2.5"><span className="rounded-md bg-sky-50 px-2 py-0.5 text-[11px] font-medium capitalize text-sky-700 dark:bg-sky-950/50 dark:text-sky-400" style={{ borderLeft: `3px solid ${c.color ?? FALLBACK}` }}>{categoryTypeLabel(c.categoryType)}</span></td>
                <td className="px-4 py-2.5 text-xs text-slate-400 dark:text-slate-500">{t(`bases.${c.allocationBase}`)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{c.categoryType === 'expense' ? whole(c.accounts.length) : '—'}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">{money0(c.totalAmount)}</td>
                <td className="px-4 py-2.5 text-right font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{rate(c.rate)}</td>
              </tr>
            ))}
            <tr className="bg-slate-50/70 font-semibold dark:bg-slate-800/40">
              <td className="px-4 py-2.5 text-slate-800 dark:text-slate-200">{t('deptFlyout.composite')}</td>
              <td /><td /><td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{whole(data.kpis.overheadAccounts)}</td>
              <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-slate-800 dark:text-slate-200">{money0(data.kpis.totalOverhead)}</td>
              <td className="px-4 py-2.5 text-right font-mono font-bold tabular-nums text-slate-900 dark:text-slate-100">{rate(data.kpis.compositeRate)}</td>
            </tr>
          </tbody>
        </table>
      </Panel>

      {data.unassigned.length ? (
        <Panel title={t('panels.unassignedAccounts')} icon={AlertTriangle} hint={t('hints.assignToCategory')} bodyClassName="p-0">
          <table className="w-full text-sm">
            <tbody>
              {data.unassigned.map((a) => (
                <tr key={a.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{a.number ? <span className="mr-2 text-xs tabular-nums text-slate-400">{a.number}</span> : null}{a.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-amber-700 dark:text-amber-400">{money0(a.amount)}</td>
                  <td className="w-52 px-4 py-1.5 text-right">
                    <Select
                      value=""
                      disabled={busy}
                      onChange={(e) => { const v = e.target.value; if (v) void assign(v, a.id) }}
                      className="w-44"
                      triggerClassName="h-7 text-xs"
                      aria-label={t('accountsPanel.assignAria', { name: a.name })}
                    >
                      <option value="">{t('accountsPanel.assignTo')}</option>
                      {data.categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
              <tr className="bg-amber-50/60 font-semibold dark:bg-amber-950/20">
                <td className="px-4 py-2 text-amber-800 dark:text-amber-300">{t('categories.notInComposite')}</td>
                <td className="px-4 py-2 text-right tabular-nums text-amber-800 dark:text-amber-300">{money0(data.unassigned.reduce((s, a) => s + a.amount, 0))}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </Panel>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ Matrix */

function MatrixTab({ data, onDrill }: { data: TrueCostData; onDrill: (c: CellRef) => void }) {
  const t = useTranslations('analytics.trueCost')
  const today = useBusinessToday()
  const rate = useRate()
  const { currency } = useMoney()
  const rates = data.categories.map((c) => c.rate).filter((r) => r > 0)
  const avg = rates.length ? rates.reduce((s, v) => s + v, 0) / rates.length : 0
  const cellTone = (r: number) => {
    if (r === 0) return 'text-slate-300 dark:text-slate-600'
    if (r < avg * 0.85) return 'text-emerald-600 dark:text-emerald-400'
    if (r > avg * 1.15) return 'text-rose-600 dark:text-rose-400'
    return 'text-slate-600 dark:text-slate-300'
  }
  return (
    <Panel
      title={t('panels.rateMatrix')}
      icon={Grid3X3}
      actions={
        <span className="flex items-center gap-3 text-[11px] text-slate-400 dark:text-slate-500">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500" />{t('matrix.belowAvg')}</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-slate-400" />{t('matrix.average')}</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-rose-500" />{t('matrix.aboveAvg')}</span>
          <button
            type="button"
            onClick={() => exportCsv('burden-rate-matrix', [t('deptFlyout.colCategory'), t('cards.base'), ...data.departments.map((d) => t('matrix.deptWithCurrency', { name: d.name, currency })), t('matrix.overallWithCurrency', { currency })], [
              ...data.categories.map((c) => [c.name, t('matrix.cellBase'), ...data.departments.map((d) => (c.byDept[d.id]?.rate ?? 0).toFixed(2)), c.rate.toFixed(2)]),
              [t('matrix.totalBurden'), t('matrix.cellBase'), ...data.departments.map((d) => d.composite.toFixed(2)), data.kpis.compositeRate.toFixed(2)],
            ], today)}
            className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 font-medium text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <Download size={11} /> {t('matrix.csv')}
          </button>
        </span>
      }
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <th className="px-4 py-2 text-left font-medium">{t('deptFlyout.colCategory')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('cards.base')}</th>
              {data.departments.map((d) => (
                <th key={d.id} className="whitespace-nowrap px-3 py-2 text-right font-medium">{d.name}</th>
              ))}
              <th className="px-4 py-2 text-right font-bold">{t('matrix.colOverall')}</th>
            </tr>
          </thead>
          <tbody>
            {data.categories.map((c) => (
              <tr key={c.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                <td className="whitespace-nowrap px-4 py-2">
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: c.color ?? FALLBACK }} />
                    <span className="font-medium text-slate-800 dark:text-slate-200">{c.name}</span>
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">{t('matrix.cellBase')}</td>
                {data.departments.map((d) => {
                  const r = c.byDept[d.id]?.rate ?? 0
                  return (
                    <td key={d.id} className="p-0 text-right">
                      <button
                        type="button"
                        onClick={() => onDrill({ catId: c.id, deptId: d.id })}
                        className={cn('w-full px-3 py-2 text-right tabular-nums transition-colors hover:bg-teal-50 dark:hover:bg-teal-950/40', cellTone(r))}
                        title={t('matrix.cellTitle', { cat: c.name, dept: d.name })}
                      >
                        {rate(r)}
                      </button>
                    </td>
                  )
                })}
                <td className="bg-slate-50/70 px-4 py-2 text-right font-semibold tabular-nums text-slate-800 dark:bg-slate-800/40 dark:text-slate-200">{rate(c.rate)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-slate-200 bg-slate-50/70 font-bold dark:border-slate-700 dark:bg-slate-800/40">
              <td className="px-4 py-2.5 text-slate-900 dark:text-slate-100">{t('matrix.totalBurden')}</td>
              <td />
              {data.departments.map((d) => (
                <td key={d.id} className="px-3 py-2.5 text-right tabular-nums text-slate-900 dark:text-slate-100">{rate(data.totals.byDept[d.id] ?? 0)}</td>
              ))}
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-900 dark:text-slate-100">{rate(data.totals.overall)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
        {t('matrix.footnote')}
      </p>
    </Panel>
  )
}

/* -------------------------------------------------------------- Absorption */

const PRESETS = ['full_rate', 'full_hours', 'full_cut', 'balanced', 'rate_hours', 'conservative'] as const
type PresetKey = (typeof PRESETS)[number]
const PRESET_MIX: Record<PresetKey, { rate: number; hours: number; cost: number; util: number }> = {
  full_rate: { rate: 100, hours: 0, cost: 0, util: 0 },
  full_hours: { rate: 0, hours: 100, cost: 0, util: 0 },
  full_cut: { rate: 0, hours: 0, cost: 100, util: 0 },
  balanced: { rate: 34, hours: 33, cost: 33, util: 0 },
  rate_hours: { rate: 50, hours: 50, cost: 0, util: 0 },
  conservative: { rate: 20, hours: 10, cost: 10, util: 5 },
}

function AbsorptionTab({ data }: { data: TrueCostData }) {
  const t = useTranslations('analytics.trueCost')
  const rate = useRate()
  const whole = useWholeNumber()
  const percent = usePercent()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const k = data.kpis
  const gap = Math.abs(Math.min(0, k.gap)) // the shortfall to recover
  const [rateAdj, setRateAdj] = useState(0)
  const [hoursAdj, setHoursAdj] = useState(0)
  const [costAdj, setCostAdj] = useState(0)
  const [utilAdj, setUtilAdj] = useState(0)
  const [months, setMonths] = useState(6)
  const under = k.gap < 0

  const model = useMemo(() => {
    const utilGain = Math.min(1 - k.utilization, utilAdj / 100)
    const utilRecovery = k.totalOverhead * utilGain
    const remaining = Math.max(0, gap - utilRecovery)
    const viaRate = remaining * (rateAdj / 100)
    const viaHours = remaining * (hoursAdj / 100)
    const viaCost = remaining * (costAdj / 100)
    const recovered = utilRecovery + viaRate + viaHours + viaCost
    const newGap = Math.min(0, k.gap) + recovered
    const rateBump = k.billedHours > 0 ? viaRate / k.billedHours : 0
    const extraHours = k.compositeRate > 0 ? viaHours / k.compositeRate : 0
    const costCutPct = k.totalOverhead > 0 ? (viaCost / k.totalOverhead) * 100 : 0
    const newAbsorption = k.totalOverhead > 0 ? ((k.burdenApplied + recovered) / k.totalOverhead) * 100 : 100
    return { recovered, newGap, rateBump, extraHours, costCutPct, newAbsorption, utilRecovery, coverage: gap > 0 ? (recovered / gap) * 100 : 100 }
  }, [k, gap, rateAdj, hoursAdj, costAdj, utilAdj])

  const applyPreset = (key: PresetKey) => { const set = PRESET_MIX[key]; setRateAdj(set.rate); setHoursAdj(set.hours); setCostAdj(set.cost); setUtilAdj(set.util) }
  const chargedRate = k.billedHours > 0 ? k.burdenApplied / k.billedHours : 0

  const levers: { labelKey: string; descKey: string; icon: typeof DollarSign; value: number; set: (n: number) => void; max: number; suffix: string; impact: string }[] = [
    { labelKey: 'absorption.leverRaiseLabel', descKey: 'absorption.leverRaiseDesc', icon: DollarSign, value: rateAdj, set: setRateAdj, max: 100, suffix: t('absorption.suffixOfGap'), impact: t('absorption.impactRate', { value: rate(model.rateBump) }) },
    { labelKey: 'absorption.leverHoursLabel', descKey: 'absorption.leverHoursDesc', icon: Clock, value: hoursAdj, set: setHoursAdj, max: 100, suffix: t('absorption.suffixOfGap'), impact: t('absorption.impactHours', { count: Math.round(model.extraHours) }) },
    { labelKey: 'absorption.leverCutLabel', descKey: 'absorption.leverCutDesc', icon: TrendingDown, value: costAdj, set: setCostAdj, max: 100, suffix: t('absorption.suffixOfGap'), impact: t('absorption.impactCost', { value: percent(model.costCutPct, 1) }) },
    { labelKey: 'absorption.leverUtilLabel', descKey: 'absorption.leverUtilDesc', icon: Percent, value: utilAdj, set: setUtilAdj, max: Math.max(1, Math.round((1 - k.utilization) * 100)), suffix: t('absorption.suffixPpGained'), impact: t('absorption.impactUtil', { value: money(model.utilRecovery) }) },
  ]

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={GaugeIcon} accent="sky" label={t('absorption.avgChargedRate')} value={rate(chargedRate)} sub={t('absorption.breakEven', { rate: rate(k.compositeRate) })} />
        <KpiCard icon={Percent} accent="violet" label={t('hero.absorption')} value={percent(k.absorptionPct, 1)} sub={under ? t('hero.underAbsorbed') : t('hero.overAbsorbed')} tone={under ? 'negative' : 'positive'} />
        <KpiCard icon={under ? AlertTriangle : CheckCircle2} accent={under ? 'red' : 'emerald'} label={t('absorption.gap')} value={`${k.gap >= 0 ? '+' : '−'}${money(Math.abs(k.gap))}`} sub={t('absorption.gapMath', { hours: Math.round(k.billedHours), depts: data.departments.length })} tone={under ? 'negative' : 'positive'} />
        <KpiCard icon={under ? TrendingDown : TrendingUp} accent={under ? 'red' : 'emerald'} label={t('absorption.gapPerHour')} value={`${k.gapPerHour >= 0 ? '+' : '−'}${rate(Math.abs(k.gapPerHour))}`} sub={t('absorption.perBilledHour')} tone={under ? 'negative' : 'positive'} />
      </div>

      {!under ? (
        <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"><CheckCircle2 size={15} />{t('absorption.fullyAbsorbed')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/40">
            <span className="mr-1 text-xs text-slate-400 dark:text-slate-500">{t('absorption.quickScenarios')}</span>
            {PRESETS.map((key) => (
              <button key={key} type="button" onClick={() => applyPreset(key)} className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-teal-400 hover:text-teal-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">{t(`presets.${key}`)}</button>
            ))}
            <button type="button" onClick={() => { setRateAdj(0); setHoursAdj(0); setCostAdj(0); setUtilAdj(0) }} className="ml-auto rounded-md border border-slate-200 p-1.5 text-slate-400 hover:text-slate-600 dark:border-slate-700" title={t('actions.reset')}><RotateCcw size={13} /></button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {levers.map((l) => {
              const Icon = l.icon
              return (
                <div key={l.labelKey} className={cn('rounded-xl border bg-white p-4 shadow-sm dark:bg-slate-900', l.value > 0 ? 'border-teal-400 dark:border-teal-600' : 'border-slate-200/80 dark:border-slate-800')}>
                  <div className="mb-3 flex items-center gap-2.5">
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300"><Icon size={16} /></span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t(l.labelKey)}</p>
                      <p className="truncate text-[11px] text-slate-400 dark:text-slate-500">{t(l.descKey)}</p>
                    </div>
                  </div>
                  <input type="range" min={0} max={l.max} value={l.value} onChange={(e) => l.set(Number(e.target.value))} className="w-full accent-teal-500" />
                  <div className="mt-1 flex items-center justify-between text-xs">
                    <span className="text-slate-400">{l.suffix}</span>
                    <span className="font-bold tabular-nums text-slate-800 dark:text-slate-200">{whole(l.value)}</span>
                  </div>
                  <p className={cn('mt-2.5 rounded-md px-2 py-1.5 text-center text-[11px] font-semibold', l.value > 0 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'bg-slate-50 text-slate-400 dark:bg-slate-800/60 dark:text-slate-500')}>{l.impact}</p>
                </div>
              )
            })}
          </div>

          <Panel title={t('panels.recoveryPlan')} icon={Scale} bodyClassName="p-0">
            <div className="grid grid-cols-2 gap-px border-b border-slate-100 bg-slate-100 dark:border-slate-800 dark:bg-slate-800 sm:grid-cols-5">
              {[
                { label: t('absorption.planRecovered'), value: money(model.recovered) },
                { label: t('absorption.planRemainingGap'), value: `${model.newGap >= 0 ? '+' : '−'}${money(Math.abs(model.newGap))}` },
                { label: t('absorption.planNewAbsorption'), value: percent(model.newAbsorption, 1) },
                { label: t('absorption.planRateSurcharge'), value: `+${rate(model.rateBump)}` },
                { label: t('absorption.planExtraBillableHrs'), value: whole(model.extraHours) },
              ].map((s) => (
                <div key={s.label} className="bg-white p-3.5 text-center dark:bg-slate-900">
                  <p className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{s.value}</p>
                  <p className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{s.label}</p>
                </div>
              ))}
            </div>
            <div className="p-4">
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="text-slate-500 dark:text-slate-400">{t('absorption.gapCoverage')}</span>
                <span className="text-base font-bold tabular-nums text-slate-800 dark:text-slate-200">{percent(Math.min(100, model.coverage))}</span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div className={cn('h-full rounded-full transition-all', model.coverage >= 100 ? 'bg-emerald-500' : model.coverage >= 60 ? 'bg-teal-500' : 'bg-amber-500')} style={{ width: `${Math.min(100, model.coverage)}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-slate-400 dark:text-slate-500"><span>{money(0)}</span><span>{t('absorption.gapOf', { amount: money(gap) })}</span></div>
            </div>
            <div className="border-t border-slate-100 p-4 dark:border-slate-800">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('absorption.timeline')}</p>
                <span className="flex gap-1">
                  {[3, 6, 12].map((m) => (
                    <button key={m} type="button" onClick={() => setMonths(m)} className={cn('rounded-md border px-2 py-1 text-xs font-medium', months === m ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400')}>{t('absorption.monthShort', { months: m })}</button>
                  ))}
                </span>
              </div>
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {Array.from({ length: months }, (_, i) => {
                  const per = model.recovered / months
                  const cum = per * (i + 1)
                  const done = cum >= gap
                  return (
                    <div key={i} className={cn('min-w-18 flex-1 rounded-lg border p-2 text-center', done ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30' : 'border-slate-200 dark:border-slate-700')}>
                      <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">{t('absorption.monthCell', { n: i + 1 })}</p>
                      <p className="text-[10px] tabular-nums text-slate-400 dark:text-slate-500">{money(per)}</p>
                      <p className={cn('text-[10px] font-bold tabular-nums', done ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500')}>{percent(gap > 0 ? Math.min(100, (cum / gap) * 100) : 100)}</p>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="border-t border-slate-100 dark:border-slate-800">
              <p className="bg-slate-50/70 px-4 py-2 text-xs font-semibold text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">{t('absorption.contributionByDept')}</p>
              <table className="w-full text-sm">
                <tbody>
                  {data.departments.map((d) => {
                    const contribution = k.gapPerHour * d.billedHours
                    const pct = Math.abs(k.gap) > 0 ? (Math.abs(contribution) / Math.abs(k.gap)) * 100 : 0
                    return (
                      <tr key={d.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                        <td className="px-4 py-2 font-medium text-slate-700 dark:text-slate-300">{d.name}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{t('absorption.hrsShort', { count: Math.round(d.billedHours) })}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{rate(d.composite)}</td>
                        <td className={cn('px-4 py-2 text-right font-semibold tabular-nums', contribution < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>{contribution < 0 ? '−' : '+'}{money(Math.abs(contribution))}</td>
                        <td className="w-40 px-4 py-2">
                          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-rose-400" style={{ width: `${Math.min(100, pct)}%` }} /></div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ Selling Rate */

interface CostRow { name: string; type: 'percent_labor' | 'percent_subtotal' | 'flat'; value: number }

function SellingTab({ data }: { data: TrueCostData }) {
  const t = useTranslations('analytics.trueCost')
  const rate = useRate()
  const percent = usePercent()
  const format = useFormatter()
  const { currency } = useMoney()
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const k = data.kpis
  const emp = data.labor

  const [laborSource, setLaborSource] = useState<'employee' | 'manual'>('employee')
  const [laborDept, setLaborDept] = useState('')
  const [laborTitle, setLaborTitle] = useState('')
  const [laborAgg, setLaborAgg] = useState<'average' | 'median' | 'weighted'>('weighted')
  const [laborManual, setLaborManual] = useState(45)
  const [burdenSource, setBurdenSource] = useState('all')
  const [burdenManual, setBurdenManual] = useState(k.compositeRate)
  const [costs, setCosts] = useState<CostRow[]>([{ name: t('selling.defaultAdditionalName'), type: 'percent_labor', value: 10 }])
  const [marginType, setMarginType] = useState<'margin' | 'markup'>('margin')
  const [margin, setMargin] = useState(25)
  const [otMult, setOtMult] = useState(1.5)
  const [dtMult, setDtMult] = useState(2)

  const titles = useMemo(() => [...new Set(emp.employees.map((e) => e.title))].sort(), [emp.employees])

  const laborPool = useMemo(() => emp.employees.filter((e) => (!laborDept || e.deptId === laborDept) && (!laborTitle || e.title === laborTitle)), [emp.employees, laborDept, laborTitle])
  const laborRate = useMemo(() => {
    if (laborSource === 'manual') return laborManual
    if (!laborPool.length) return 0
    if (laborAgg === 'average') return laborPool.reduce((s, e) => s + e.rate, 0) / laborPool.length
    if (laborAgg === 'median') {
      const sorted = [...laborPool].sort((a, b) => a.rate - b.rate)
      return sorted[Math.floor(sorted.length / 2)]?.rate ?? 0
    }
    const h = laborPool.reduce((s, e) => s + e.hours, 0)
    return h > 0 ? laborPool.reduce((s, e) => s + e.rate * e.hours, 0) / h : 0
  }, [laborSource, laborManual, laborPool, laborAgg])
  const laborMin = laborPool.length ? Math.min(...laborPool.map((e) => e.rate)) : 0
  const laborMax = laborPool.length ? Math.max(...laborPool.map((e) => e.rate)) : 0

  const burdenRate = burdenSource === 'manual' ? burdenManual : burdenSource === 'all' ? k.compositeRate : (data.totals.byDept[burdenSource] ?? k.compositeRate)
  const burdenDeptName = burdenSource === 'all' ? t('selling.allDepartments') : burdenSource === 'manual' ? t('selling.manual') : data.departments.find((d) => d.id === burdenSource)?.name ?? '—'

  const subtotal = laborRate + burdenRate
  const additional = costs.reduce((s, c) => s + (c.type === 'percent_labor' ? laborRate * (c.value / 100) : c.type === 'percent_subtotal' ? subtotal * (c.value / 100) : c.value), 0)
  const totalCost = subtotal + additional
  const sellingRate = marginType === 'margin' ? (margin < 100 ? totalCost / (1 - margin / 100) : totalCost) : totalCost * (1 + margin / 100)
  const profit = sellingRate - totalCost
  const grossMargin = sellingRate > 0 ? (profit / sellingRate) * 100 : 0
  const markup = totalCost > 0 ? (profit / totalCost) * 100 : 0
  const seg = (v: number) => (sellingRate > 0 ? `${Math.max(0, (v / sellingRate) * 100)}%` : '0%')
  const premium = (mult: number) => {
    const cost = laborRate * mult + burdenRate + additional
    return marginType === 'margin' ? (margin < 100 ? cost / (1 - margin / 100) : cost) : cost * (1 + margin / 100)
  }

  const setCost = (i: number, patch: Partial<CostRow>) => setCosts(costs.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const costAmount = (c: CostRow) => (c.type === 'percent_labor' ? laborRate * (c.value / 100) : c.type === 'percent_subtotal' ? subtotal * (c.value / 100) : c.value)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Calculator} accent="sky" label={t('selling.sellingRate')} value={rate(sellingRate)} sub={t('selling.costMultiple', { multiple: format.number(totalCost > 0 ? sellingRate / totalCost : 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })} />
        <KpiCard icon={Layers} accent="violet" label={t('selling.totalCost')} value={rate(totalCost)} sub={t('selling.costStack')} />
        <KpiCard icon={DollarSign} accent="emerald" label={t('selling.profitPerHour')} value={rate(profit)} sub={t('selling.per1kHours', { money: money(profit * 1000) })} tone="positive" />
        <KpiCard icon={Percent} accent="amber" label={t('selling.grossMargin')} value={percent(grossMargin)} sub={t('selling.markupPct', { markup: percent(markup) })} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Builder */}
        <div className="lg:col-span-7">
          <Panel title={t('panels.sellingBuilder')} icon={Calculator} actions={<button type="button" onClick={() => { setLaborSource('employee'); setLaborDept(''); setLaborTitle(''); setLaborAgg('weighted'); setBurdenSource('all'); setCosts([{ name: t('selling.defaultAdditionalName'), type: 'percent_labor', value: 10 }]); setMargin(25); setMarginType('margin') }} className="rounded-md border border-slate-200 p-1.5 text-slate-400 hover:text-slate-600 dark:border-slate-700" title={t('actions.reset')}><RotateCcw size={13} /></button>} bodyClassName="p-0">
            {/* Direct Labor */}
            <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-950/50 dark:text-sky-400"><UserRound size={15} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t('selling.directLabor')}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">
                    {laborSource === 'manual' ? t('selling.manualEntry') : laborPool.length ? t('selling.weightedFrom', { count: laborPool.length, min: rate(laborMin), max: rate(laborMax) }) : t('selling.noMatchingEmployees')}
                  </p>
                </div>
                <p className="text-base font-bold tabular-nums text-slate-900 dark:text-slate-100">{rate(laborRate)}</p>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-11">
                <FilterPill icon={Wand2}>
                  <Select value={laborSource} onChange={(e) => setLaborSource(e.target.value as 'employee' | 'manual')} className="w-32" triggerClassName={PILL_TRIGGER} aria-label={t('selling.labourSource')}>
                    <option value="employee">{t('selling.fromEmployees')}</option>
                    <option value="manual">{t('selling.manualEntryOption')}</option>
                  </Select>
                </FilterPill>
                {laborSource === 'employee' ? (
                  <>
                    <FilterPill icon={Building2}>
                      <Select value={laborDept} onChange={(e) => setLaborDept(e.target.value)} className="w-28" triggerClassName={PILL_TRIGGER} aria-label={t('selling.departmentFilter')}>
                        <option value="">{t('selling.allDepts')}</option>
                        {data.departments.map((d) => (<option key={d.id} value={d.id}>{d.name}</option>))}
                      </Select>
                    </FilterPill>
                    <FilterPill icon={UserRound}>
                      <Select value={laborTitle} onChange={(e) => setLaborTitle(e.target.value)} className="w-40" triggerClassName={PILL_TRIGGER} aria-label={t('selling.labourClassFilter')}>
                        <option value="">{t('selling.allLabourClasses')}</option>
                        {titles.map((ti) => (<option key={ti} value={ti}>{ti}</option>))}
                      </Select>
                    </FilterPill>
                    <FilterPill icon={Calculator}>
                      <Select value={laborAgg} onChange={(e) => setLaborAgg(e.target.value as 'average' | 'median' | 'weighted')} className="w-26" triggerClassName={PILL_TRIGGER} aria-label={t('selling.aggregation')}>
                        <option value="average">{t('selling.average')}</option>
                        <option value="median">{t('selling.median')}</option>
                        <option value="weighted">{t('selling.weighted')}</option>
                      </Select>
                    </FilterPill>
                    <span className="rounded-full bg-sky-50 px-2 py-1 text-[11px] font-medium text-sky-700 dark:bg-sky-950/50 dark:text-sky-400">{t('selling.employeesCount', { count: laborPool.length })}</span>
                  </>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-slate-500">
                    <span>{currency}</span><input type="number" value={laborManual} step={0.5} onChange={(e) => setLaborManual(Number(e.target.value) || 0)} className="h-7 w-20 rounded-md border border-slate-200 bg-white px-2 text-right text-xs tabular-nums dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" /><span>{t('selling.perHour')}</span>
                  </span>
                )}
              </div>
            </div>

            {/* Overhead Burden */}
            <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-950/50 dark:text-violet-400"><Layers size={15} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t('selling.overheadBurden')}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">{burdenDeptName}</p>
                </div>
                <p className="text-base font-bold tabular-nums text-slate-900 dark:text-slate-100">{rate(burdenRate)}</p>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-11">
                <FilterPill icon={Building2}>
                  <Select value={burdenSource} onChange={(e) => setBurdenSource(e.target.value)} className="w-60" triggerClassName={PILL_TRIGGER} aria-label={t('selling.overheadSource')}>
                    <option value="all">{t('selling.allDepartmentsRate', { rate: rate(k.compositeRate) })}</option>
                    {data.departments.map((d) => (<option key={d.id} value={d.id}>{d.name} ({rate(data.totals.byDept[d.id] ?? 0)})</option>))}
                    <option value="manual">{t('selling.manualEntryOption')}</option>
                  </Select>
                </FilterPill>
                {burdenSource === 'manual' ? (
                  <span className="flex items-center gap-1 text-xs text-slate-500">
                    <span>{currency}</span><input type="number" value={burdenManual.toFixed(2)} step={0.5} onChange={(e) => setBurdenManual(Number(e.target.value) || 0)} className="h-7 w-20 rounded-md border border-slate-200 bg-white px-2 text-right text-xs tabular-nums dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" /><span>{t('selling.perHour')}</span>
                  </span>
                ) : null}
              </div>
            </div>

            {/* Additional Costs */}
            <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-pink-100 text-pink-600 dark:bg-pink-950/50 dark:text-pink-400"><PlusCircle size={15} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t('selling.additionalCosts')}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">{t('selling.gaFees')}</p>
                </div>
                <p className="text-base font-bold tabular-nums text-slate-900 dark:text-slate-100">{rate(additional)}</p>
              </div>
              <div className="mt-2 space-y-1.5 pl-11">
                {costs.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input value={c.name} onChange={(e) => setCost(i, { name: e.target.value })} placeholder={t('selling.namePlaceholder')} className="h-7 w-24 rounded-md border border-slate-200 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
                    <Select value={c.type} onChange={(e) => setCost(i, { type: e.target.value as CostRow['type'] })} className="w-32" triggerClassName="h-7 text-xs" aria-label={t('selling.costBasis')}>
                      <option value="percent_labor">{t('allocation.percentLabor')}</option>
                      <option value="percent_subtotal">{t('selling.percentSubtotal')}</option>
                      <option value="flat">{t('selling.flatPerHour', { currency })}</option>
                    </Select>
                    <input type="number" value={c.value} step={0.5} onChange={(e) => setCost(i, { value: Number(e.target.value) || 0 })} className="h-7 w-16 rounded-md border border-slate-200 bg-white px-2 text-right text-xs tabular-nums dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
                    <span className="flex-1 text-right text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">{rate(costAmount(c))}</span>
                    <button type="button" onClick={() => setCosts(costs.filter((_, j) => j !== i))} aria-label={t('selling.removeCostComponent', { name: c.name || t('selling.unnamedCostComponent') })} className="rounded-md bg-rose-50 px-1.5 py-1 text-[10px] text-rose-500 hover:bg-rose-100 dark:bg-rose-950/40">✕</button>
                  </div>
                ))}
                <button type="button" onClick={() => setCosts([...costs, { name: '', type: 'flat', value: 0 }])} className="w-full rounded-md border border-dashed border-slate-200 py-1 text-xs text-teal-600 hover:bg-teal-50/50 dark:border-slate-700 dark:text-teal-400">{t('selling.addCostComponent')}</button>
              </div>
            </div>

            {/* Target Margin */}
            <div className="flex items-center gap-3 border-b border-amber-100 bg-amber-50/70 px-4 py-3 dark:border-amber-900/40 dark:bg-amber-950/20">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-200/70 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400"><Percent size={15} /></span>
              <div className="min-w-32">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-300">{t('selling.targetMargin')}</p>
                <Select value={marginType} onChange={(e) => setMarginType(e.target.value as 'margin' | 'markup')} className="mt-0.5 w-24" triggerClassName="h-6 text-xs" aria-label={t('selling.marginMode')}>
                  <option value="margin">{t('selling.margin')}</option>
                  <option value="markup">{t('selling.markup')}</option>
                </Select>
              </div>
              <input type="range" min={0} max={50} value={margin} onChange={(e) => setMargin(Number(e.target.value))} className="flex-1 accent-amber-500" />
              <p className="w-12 text-right text-lg font-bold tabular-nums text-amber-800 dark:text-amber-300">{percent(margin)}</p>
            </div>

            {/* Stacked bar */}
            <div className="bg-slate-50/60 px-4 py-3 dark:bg-slate-800/30">
              <div className="flex h-6 overflow-hidden rounded-lg text-[9px] font-semibold text-white">
                <div className="grid place-items-center bg-sky-500" style={{ width: seg(laborRate) }}>{t('selling.segLabor')}</div>
                <div className="grid place-items-center bg-violet-500" style={{ width: seg(burdenRate) }}>{t('selling.segOverhead')}</div>
                <div className="grid place-items-center bg-pink-500" style={{ width: seg(additional) }}>{t('selling.segPlusCosts')}</div>
                <div className="grid place-items-center bg-emerald-500" style={{ width: seg(profit) }}>{t('selling.segProfit')}</div>
              </div>
              <div className="mt-1.5 flex justify-center gap-4 text-[10px] text-slate-400 dark:text-slate-500">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-sky-500" />{t('selling.segLabor')}</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-violet-500" />{t('selling.segOverhead')}</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-pink-500" />{t('selling.legendAdditional')}</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500" />{t('selling.segProfit')}</span>
              </div>
            </div>

            {/* Totals */}
            <div className="space-y-1 border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-sm dark:border-slate-800 dark:bg-slate-800/30">
              {[
                [t('selling.rowLaborCost'), rate(laborRate)], [t('selling.rowOverheadCost'), rate(burdenRate)], [t('selling.rowAdditionalCosts'), rate(additional)],
              ].map(([l, v]) => (
                <div key={l} className="flex justify-between"><span className="text-xs text-slate-500 dark:text-slate-400">{l}</span><span className="font-medium tabular-nums text-slate-700 dark:text-slate-200">{v}</span></div>
              ))}
              <div className="flex justify-between border-t border-slate-200 pt-1.5 dark:border-slate-700"><span className="text-xs font-bold text-slate-700 dark:text-slate-200">{t('selling.rowTotalCost')}</span><span className="font-bold tabular-nums text-slate-900 dark:text-slate-100">{rate(totalCost)}</span></div>
              <div className="flex justify-between"><span className="text-xs text-slate-500 dark:text-slate-400">{t('selling.rowProfitMargin')}</span><span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">+{rate(profit)}</span></div>
            </div>

            {/* Final rate banner */}
            <div className="flex items-center justify-between bg-gradient-to-r from-teal-700 to-teal-500 px-4 py-3.5 text-white">
              <div>
                <p className="text-xs opacity-90">{t('selling.sellingRate')}</p>
                <p className="text-[10px] opacity-70">{marginType === 'margin' ? t('selling.bannerSubMargin', { margin: percent(margin) }) : t('selling.bannerSubMarkup', { margin: percent(margin) })}</p>
              </div>
              <p className="text-2xl font-bold tabular-nums">{rate(sellingRate)}</p>
            </div>

            {/* Premium rates */}
            <div className="grid grid-cols-2 gap-3 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
              {[{ label: t('selling.overtime'), mult: otMult, set: setOtMult }, { label: t('selling.doubleTime'), mult: dtMult, set: setDtMult }].map((p) => (
                <div key={p.label} className="flex items-center gap-2 text-xs">
                  <span className="w-20 text-slate-500 dark:text-slate-400">{p.label}</span>
                  <input type="number" value={p.mult} step={0.1} min={1} max={3} onChange={(e) => p.set(Number(e.target.value) || 1)} className="h-7 w-14 rounded-md border border-slate-200 bg-white px-1.5 text-center tabular-nums dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
                  <span className="text-slate-400">×</span>
                  <span className="flex-1 rounded-md bg-slate-50 px-2 py-1 text-right font-semibold tabular-nums text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">{rate(premium(p.mult))}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        {/* Right: Margin Explorer + Cost Breakdown */}
        <div className="space-y-5 lg:col-span-5">
          <Panel title={t('panels.marginExplorer')} icon={SlidersHorizontal}>
            <div className="text-center">
              <p className="text-4xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{percent(margin)}</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">{t('selling.explorerTarget', { mode: marginType === 'margin' ? t('selling.margin') : t('selling.markup') })}</p>
            </div>
            <input type="range" min={0} max={50} value={margin} onChange={(e) => setMargin(Number(e.target.value))} className="my-3 w-full accent-teal-500" />
            <div className="grid grid-cols-2 gap-2.5">
              {[
                [t('selling.sellingRate'), rate(sellingRate), 'text-sky-600 dark:text-sky-400'],
                [t('selling.profitPerHour'), rate(profit), 'text-emerald-600 dark:text-emerald-400'],
                [t('selling.markupPctLabel'), percent(markup), ''],
                [t('selling.per1kLabel'), money(profit * 1000), ''],
              ].map(([l, v, tone]) => (
                <div key={l as string} className="rounded-lg bg-slate-50/80 p-2.5 text-center dark:bg-slate-800/40">
                  <p className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{l}</p>
                  <p className={cn('text-base font-bold tabular-nums', (tone as string) || 'text-slate-800 dark:text-slate-200')}>{v}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {[15, 20, 25, 30, 35, 40].map((m) => (
                <button key={m} type="button" onClick={() => setMargin(m)} className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', margin === m ? 'border-teal-500 bg-teal-500 text-white' : 'border-slate-200 text-slate-500 hover:border-teal-400 dark:border-slate-700 dark:text-slate-400')}>{percent(m)}</button>
              ))}
            </div>
          </Panel>
          <Panel title={t('panels.costBreakdown')} icon={ChartArea}>
            <Donut
              height={230}
              data={[
                { name: t('selling.directLabor'), value: laborRate },
                { name: t('selling.overheadBurden'), value: burdenRate },
                { name: t('selling.legendAdditional'), value: additional },
                { name: t('selling.segProfit'), value: profit },
              ].filter((s) => s.value > 0)}
            />
          </Panel>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ Trends */

type TrendMode = 'composite' | 'category' | 'department'

function TrendsTab({ data }: { data: TrueCostData }) {
  const t = useTranslations('analytics.trueCost')
  const rate = useRate()
  const whole = useWholeNumber()
  const format = useFormatter()
  const signedPercent = (value: number, fractionDigits = 0) => format.number(value / 100, {
    style: 'percent',
    signDisplay: 'exceptZero',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
  const [mode, setMode] = useState<TrendMode>('composite')
  const active = data.monthly.filter((m) => m.billedHours > 0)
  const current = active.at(-1)?.rate ?? 0
  const prev = active.at(-2)?.rate ?? current
  const change = prev > 0 ? ((current - prev) / prev) * 100 : 0
  const avg = active.length ? active.reduce((s, m) => s + m.rate, 0) / active.length : 0
  const min = active.length ? Math.min(...active.map((m) => m.rate)) : 0
  const max = active.length ? Math.max(...active.map((m) => m.rate)) : 0

  const monthLabel = (value: string) => {
    const match = /^(\d{4})-(\d{2})/.exec(value)
    if (!match) return value
    return format.dateTime(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)), {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    })
  }
  const labels = [...data.monthly.map((m) => monthLabel(m.month)), ...data.forecast.map((f) => monthLabel(f.month))]
  const chartOption = (() => {
    const base = {
      grid: { top: 28, bottom: 26, left: 52, right: 14 },
      legend: { top: 0, type: 'scroll' as const },
      tooltip: { trigger: 'axis' as const, valueFormatter: (v: unknown) => (v == null ? '—' : rate(Number(v))) },
      xAxis: { type: 'category' as const, data: labels },
      yAxis: { type: 'value' as const, axisLabel: { formatter: (v: number) => rate(v) } },
    }
    if (mode === 'composite') {
      return {
        ...base,
        series: [
          { name: t('trends.seriesComposite'), type: 'line' as const, areaStyle: { opacity: 0.12 }, data: [...data.monthly.map((m) => m.rate), ...data.forecast.map(() => null)], lineStyle: { width: 2, color: '#14b8a6' }, itemStyle: { color: '#14b8a6' } },
          { name: t('trends.seriesForecast'), type: 'line' as const, data: [...data.monthly.map((month, i) => (i === data.monthly.length - 1 ? month.rate : null)), ...data.forecast.map((f) => f.rate)], lineStyle: { width: 2, type: 'dashed' as const, color: '#14b8a6' }, itemStyle: { color: '#14b8a6' }, symbol: 'diamond' },
        ],
      }
    }
    if (mode === 'category') {
      return {
        ...base,
        series: data.categories.map((c) => ({
          name: c.name, type: 'line' as const,
          data: [...data.monthly.map((m) => m.byCategory[c.key] ?? 0), ...data.forecast.map(() => null)],
          lineStyle: { width: 1.5, color: c.color ?? undefined }, itemStyle: { color: c.color ?? undefined }, symbolSize: 4,
        })),
      }
    }
    return {
      ...base,
      series: data.departments.map((d) => ({
        name: d.name, type: 'line' as const,
        data: [...data.monthly.map((m) => m.byDept[d.id] ?? 0), ...data.forecast.map(() => null)],
        lineStyle: { width: 1.5 }, symbolSize: 4,
      })),
    }
  })()

  const movers = (() => {
    if (active.length < 2) return []
    const last = active.at(-1)!
    const before = active.at(-2)!
    return data.categories.map((c) => {
      const curr = last.byCategory[c.key] ?? 0
      const prior = before.byCategory[c.key] ?? 0
      return { cat: c, curr, change: prior > 0 ? ((curr - prior) / prior) * 100 : curr > 0 ? 100 : 0 }
    }).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 6)
  })()

  const lastActiveMonth = active.at(-1)
  const priorActiveMonth = active.at(-2)
  const scorecard = [...data.departments].sort((a, b) => a.composite - b.composite).map((d, i) => {
      const curr = lastActiveMonth?.byDept[d.id] ?? d.composite
      const prior = priorActiveMonth?.byDept[d.id] ?? curr
      return { d, rank: i + 1, change: prior > 0 ? ((curr - prior) / prior) * 100 : 0 }
    })
  const maxComposite = Math.max(...data.departments.map((d) => d.composite), 1)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={GaugeIcon} accent="sky" label={t('trends.currentRate')} value={rate(current)} sub={t('trends.latestMonth')} />
        <KpiCard icon={change > 0 ? TrendingUp : TrendingDown} accent={change > 0 ? 'red' : 'emerald'} label={t('trends.monthChange')} value={signedPercent(change, 1)} sub={t('trends.vsPriorMonth')} tone={change > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={Scale} accent="violet" label={t('trends.periodAverage')} value={rate(avg)} sub={t('trends.monthsCount', { count: active.length })} />
        <KpiCard icon={ChartArea} accent="amber" label={t('trends.range')} value={`${rate(min)}–${rate(max)}`} sub={t('trends.monthlyComposite')} />
      </div>

      <Panel
        title={t('panels.compositeTrend')}
        icon={ChartArea}
        actions={
          <span className="flex gap-1">
            {(['composite', 'category', 'department'] as TrendMode[]).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={cn('rounded-md border px-2 py-1 text-[11px] font-medium capitalize', mode === m ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400')}>{m === 'composite' ? t('trends.modeComposite') : m === 'category' ? t('trends.modeByCategory') : t('trends.modeByDepartment')}</button>
            ))}
          </span>
        }
      >
        <Chart option={chartOption as never} height={300} />
      </Panel>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title={t('panels.biggestMovers')} icon={TrendingUp} hint={t('hints.movers')} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {movers.map((m, i) => (
              <li key={m.cat.id} className="px-4 py-2.5">
                <div className="flex items-center gap-2 text-sm">
                  <span className="w-5 text-xs font-semibold text-slate-300 dark:text-slate-600">#{whole(i + 1)}</span>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: m.cat.color ?? FALLBACK }} />
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-700 dark:text-slate-300">{m.cat.name}</span>
                  <span className="tabular-nums text-slate-500 dark:text-slate-400">{rate(m.curr)}</span>
                  <span className={cn('w-16 text-right text-xs font-bold tabular-nums', m.change > 0 ? 'text-rose-600 dark:text-rose-400' : m.change < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400')}>{signedPercent(m.change)}</span>
                </div>
                <div className="ml-7 mt-1 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className={cn('h-full rounded-full', m.change > 0 ? 'bg-rose-400' : 'bg-emerald-400')} style={{ width: `${Math.min(100, Math.abs(m.change))}%` }} />
                </div>
              </li>
            ))}
            {!movers.length ? <li className="px-4 py-6 text-center text-sm text-slate-400">{t('trends.notEnoughHistory')}</li> : null}
          </ul>
        </Panel>
        <Panel title={t('panels.deptScorecard')} icon={Trophy} hint={t('hints.scorecard')} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {scorecard.map(({ d, rank, change: ch }) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold', rank === 1 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400' : rank === 2 ? 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300' : rank === 3 ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400' : 'bg-slate-100 text-slate-400 dark:bg-slate-800')}>{whole(rank)}</span>
                <span className="w-28 truncate font-medium text-slate-700 dark:text-slate-300">{d.name}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className="h-full rounded-full bg-teal-400" style={{ width: `${(d.composite / maxComposite) * 100}%` }} />
                </div>
                <span className="w-20 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-200">{rate(d.composite)}</span>
                <span className={cn('w-14 text-right text-xs font-semibold tabular-nums', ch > 0 ? 'text-rose-500' : ch < 0 ? 'text-emerald-500' : 'text-slate-400')}>{signedPercent(ch)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- Configuration */

/** Composite method + active-profile switcher ( + getActiveProfile). */
function CompositePanel({ data }: { data: TrueCostData }) {
  const t = useTranslations('analytics.trueCost')
  const rate = useRate()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<boolean>) => { setBusy(true); await fn(); router.refresh(); setBusy(false) }
  const [newProfile, setNewProfile] = useState('')

  return (
    <Panel title={t('panels.compositeProfiles')} icon={SlidersHorizontal}>
      <div className="space-y-3">
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
          {t('config.compositeMethod')}
          <Select value={data.config.compositeMethod} disabled={busy} onChange={(e) => run(() => mutateActiveProfile((p) => { p.compositeMethod = e.target.value as TrueCostProfile['compositeMethod'] }))} className="mt-1 w-full" triggerClassName="h-8 text-sm">
            <option value="sum">{t('config.methodSum')}</option>
            <option value="weighted">{t('config.methodWeighted')}</option>
            <option value="cascading">{t('config.methodCascading')}</option>
          </Select>
          <span className="mt-1 block text-[11px] text-slate-400 dark:text-slate-500">{t('config.currentComposite', { rate: rate(data.kpis.compositeRate) })}</span>
        </label>

        <div>
          <p className="mb-1 text-xs font-medium text-slate-600 dark:text-slate-300">{t('config.activeProfile')}</p>
          <div className="flex flex-wrap gap-1.5">
            {data.config.profiles.map((p) => (
              <button key={p.id} type="button" disabled={busy} onClick={() => run(() => switchProfile(p.id))}
                className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', p.id === data.config.activeProfileId ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400')}>
                {p.name}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input value={newProfile} onChange={(e) => setNewProfile(e.target.value)} placeholder={t('config.newProfilePlaceholder')} className="h-7 w-40 rounded-md border border-slate-200 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
            <button type="button" disabled={busy || !newProfile.trim()} onClick={() => { const name = newProfile.trim(); setNewProfile(''); void run(async () => {
              const res = await fetch('/api/analytics/true-cost/config'); if (!res.ok) return false
              const cfg = await res.json() as TrueCostConfigResponse
              const active = cfg.profiles.find((p) => p.id === cfg.activeProfileId) ?? cfg.profiles[0]
              if (!active) return false
              const id = `profile_${Math.random().toString(36).slice(2, 10)}`
              cfg.profiles.push({ ...active, id, name })
              cfg.activeProfileId = id
              return apiCall('/api/analytics/true-cost/config', { method: 'PUT', body: JSON.stringify(cfg) })
            }) }} className="rounded-md border border-teal-500/50 px-2 py-1 text-[11px] font-medium text-teal-600 hover:bg-teal-50 disabled:opacity-40 dark:text-teal-400 dark:hover:bg-teal-950/40">{t('config.duplicateActive')}</button>
          </div>
          <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">{t('config.profileNote')}</p>
        </div>
      </div>
    </Panel>
  )
}

function ConfigTab({ data }: { data: TrueCostData }) {
  const t = useTranslations('analytics.trueCost')
  const rate = useRate()
  const compositeMethod = data.config.compositeMethod === 'sum'
    ? t('config.valueSum')
    : data.config.compositeMethod === 'weighted'
      ? t('config.valueWeighted')
      : t('config.valueCascading')
  const items = [
    { label: t('config.itemMethod'), value: compositeMethod, note: t('config.noteMethod') },
    { label: t('config.itemCategories'), value: t('config.categoryCount', { count: data.categories.length }), note: t('config.noteCategories') },
    { label: t('config.itemCentres'), value: t('config.departmentCount', { count: data.departments.length }), note: t('config.noteCentres') },
    { label: t('config.itemBases'), value: t('config.basesValue', { count: ALLOCATION_BASE_KEYS.length }), note: t('config.noteBases') },
    { label: t('config.itemNonBillable'), value: t('config.nonBillableIncluded'), note: t('config.noteNonBillable') },
    { label: t('config.itemDirectLabour'), value: t('config.directExcluded'), note: t('config.noteDirect') },
    { label: t('config.itemAbsorptionModel'), value: data.hasBurdenGL ? t('config.glApplied') : t('config.utilizationOnly'), note: data.hasBurdenGL ? t('config.noteAbsorptionGl') : t('config.noteAbsorptionUtil') },
    { label: t('config.itemLabourRates'), value: t('config.labourRatesValue', { count: data.labor.count }), note: t('config.noteLabourRates', { min: rate(data.labor.min), max: rate(data.labor.max), weighted: rate(data.labor.weighted) }) },
  ]
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <CompositePanel data={data} />
        <CustomCategoryManager data={data} />
      </div>
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Panel title={t('panels.modelAssumptions')} icon={SlidersHorizontal} bodyClassName="p-0">
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
      <Panel title={t('panels.howItWorks')} icon={Info}>
        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <p>{t('config.howIntro')}</p>
          <ul className="list-disc space-y-1 pl-5 text-slate-500 dark:text-slate-400">
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('config.howCategories')}</span> → {t('config.howCategoriesBody')}</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('config.howMatrix')}</span> → {t('config.howMatrixBody')}</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('config.howLabourRates')}</span> → {t('config.howLabourRatesBody')}</li>
            <li><span className="font-medium text-slate-700 dark:text-slate-200">{t('config.howGapModeler')}</span> → {t('config.howGapModelerBody')}</li>
          </ul>
        </div>
      </Panel>
    </div>
    </div>
  )
}

/** Manage config-driven custom categories: manual / derived / formula. */
function CustomCategoryManager({ data }: { data: TrueCostData }) {
  const t = useTranslations('analytics.trueCost')
  const { currency } = useMoney()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<'manual' | 'derived' | 'formula'>('manual')
  const [fixedTotal, setFixedTotal] = useState('')
  const [sourceCategory, setSourceCategory] = useState('')
  const [percentage, setPercentage] = useState('10')
  const [formula, setFormula] = useState('')

  const run = async (fn: () => Promise<boolean>) => { setBusy(true); await fn(); router.refresh(); setBusy(false) }
  const add = () => {
    const cat: CustomCategory = { id: `cat_${crypto.randomUUID().slice(0, 8)}`, name: name.trim(), type, color: '#64748b', allocationBase: 'billed_hours', rateFormat: 'per_hour', includeInComposite: true }
    if (type === 'manual') cat.manualConfig = { entryMode: 'fixed_total', fixedTotal: Number(fixedTotal) || 0 }
    else if (type === 'derived') cat.derivedConfig = { sourceCategory, percentage: Number(percentage) || 0, allocationBase: 'same' }
    else cat.formulaConfig = { formula }
    setName(''); setFixedTotal(''); setFormula('')
    void run(() => mutateActiveProfile((p) => { p.customCategories ??= []; p.customCategories.push(cat) }))
  }
  const remove = (id: string) => run(() => mutateActiveProfile((p) => { p.customCategories = (p.customCategories ?? []).filter((c: CustomCategory) => c.id !== id) }))
  const addDisabled = busy || !name.trim() || (type === 'manual' && !(Number(fixedTotal) > 0)) || (type === 'derived' && !sourceCategory) || (type === 'formula' && !formula.trim())
  const typeLabel = (value: string) => value === 'manual'
    ? t('custom.typeManual')
    : value === 'derived'
      ? t('custom.typeDerived')
      : t('custom.typeFormula')

  return (
    <Panel title={t('panels.customCategories')} icon={PlusCircle} hint={t('hints.customTypes')}>
      {data.config.customCategories.length ? (
        <ul className="mb-3 divide-y divide-slate-50 dark:divide-slate-800/60">
          {data.config.customCategories.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
              <span className="min-w-0"><span className="font-medium text-slate-800 dark:text-slate-200">{c.name}</span><span className="ml-2 text-xs text-slate-400">{typeLabel(c.type)}</span></span>
              <button type="button" disabled={busy} onClick={() => remove(c.id)} className="shrink-0 rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:text-rose-500 dark:border-slate-700">{t('custom.remove')}</button>
            </li>
          ))}
        </ul>
      ) : <p className="mb-3 text-xs text-slate-400 dark:text-slate-500">{t('custom.empty')}</p>}
      <div className="space-y-2 rounded-lg border border-slate-100 p-3 dark:border-slate-800">
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('drawer.namePlaceholder')} className="h-7 flex-1 rounded-md border border-slate-200 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
          <Select value={type} onChange={(e) => setType(e.target.value as typeof type)} className="w-28" triggerClassName="h-7 text-xs"><option value="manual">{t('custom.typeManual')}</option><option value="derived">{t('custom.typeDerived')}</option><option value="formula">{t('custom.typeFormula')}</option></Select>
        </div>
        {type === 'manual' && <input type="number" value={fixedTotal} onChange={(e) => setFixedTotal(e.target.value)} placeholder={t('custom.fixedTotalPlaceholder', { currency })} className="h-7 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-xs tabular-nums dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />}
        {type === 'derived' && <div className="flex gap-2">
          <Select value={sourceCategory} onChange={(e) => setSourceCategory(e.target.value)} className="flex-1" triggerClassName="h-7 text-xs"><option value="">{t('custom.sourceCategory')}</option>{data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          <input type="number" value={percentage} onChange={(e) => setPercentage(e.target.value)} title={t('custom.pctOfSource')} className="h-7 w-16 rounded-md border border-slate-200 bg-white px-2 text-right text-xs tabular-nums dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
        </div>}
        {type === 'formula' && <input value={formula} onChange={(e) => setFormula(e.target.value)} placeholder={t('custom.formulaPlaceholder')} className="h-7 w-full rounded-md border border-slate-200 bg-white px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />}
        <button type="button" disabled={addDisabled} onClick={add} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 hover:bg-teal-700">{t('custom.add')}</button>
        <p className="text-[11px] leading-snug text-slate-400 dark:text-slate-500">
          {t('custom.formulaHelpPre')}
          <code>base.revenue</code>, <code>base.billed_hours</code>, <code>base.labor_dollars</code>,{' '}
          <code>base.headcount</code>, <code>base.direct_cost</code> {t('custom.formulaHelpAnd')} <code>cat.&lt;id&gt;</code>.
        </p>
      </div>
    </Panel>
  )
}
