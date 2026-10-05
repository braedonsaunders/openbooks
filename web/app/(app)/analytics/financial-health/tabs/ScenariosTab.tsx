'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FlaskConical, Crosshair, ChartColumnBig } from 'lucide-react'
import { cn, Select } from '@openbooks/ui'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { GroupedBar } from '../../_ui/charts'
import { useAnalyticsMoney, useRatioFormat, toChartNumber } from '../../_ui/format'
import { add, canonicalDecimal, cmp, div, mulDecimal, neg } from '@openbooks/engine/money'

interface Inputs {
  growth: string
  price: string
  cogs: string
  opex: string
}

/**
 * Scenario starting points as typed percentage strings. Growth scales volume,
 * price scales operating revenue per unit, and the cost rows scale their own
 * base — the volume input maps onto growth-driven COGS scaling.
 */
const TEMPLATES: Record<string, Inputs> = {
  recession: { growth: '-15', price: '-5', cogs: '-5', opex: '-10' },
  growth: { growth: '20', price: '5', cogs: '10', opex: '15' },
  cost_cut: { growth: '0', price: '0', cogs: '-10', opex: '-20' },
  price_war: { growth: '-10', price: '-15', cogs: '0', opex: '0' },
  expansion: { growth: '30', price: '0', cogs: '25', opex: '30' },
  stagflation: { growth: '0', price: '5', cogs: '15', opex: '10' },
}

const TEMPLATE_KEYS = Object.keys(TEMPLATES)

const ZERO_INPUTS: Inputs = { growth: '0', price: '0', cogs: '0', opex: '0' }
const INPUT_KEYS = ['growth', 'price', 'cogs', 'opex'] as const

const NUM = 'h-8 w-20 rounded-md border border-slate-200 bg-white px-2 text-right text-sm text-slate-700 tabular-nums dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200'

/** A percentage-point input as an exact scale factor (15 → 1.1500). */
function factorOf(percent: string): string {
  return add('1', div(percent, '100'))
}

export function ScenariosTab({ data }: { data: HealthData }) {
  const fmtMoney = useAnalyticsMoney()
  const fmtRatio = useRatioFormat()
  const t = useTranslations('analytics.financialHealth.scenarios')
  const fig = data.figures
  const bands = data.bands.scenario
  const [inp, setInp] = useState<Inputs>(ZERO_INPUTS)

  const parsed = useMemo(() => {
    const out = {} as Record<keyof Inputs, string | null>
    for (const key of INPUT_KEYS) out[key] = canonicalDecimal(inp[key].trim(), 4)
    return out
  }, [inp])
  const invalidKey = INPUT_KEYS.find((key) => parsed[key] === null)

  const scenario = useMemo(() => {
    if (invalidKey) return null
    // Operating revenue moves with volume and price; other income is
    // non-operating and stays put. With every input at 0 each factor is
    // exactly 1, so the scenario reproduces the baseline money to the unit.
    const fV = factorOf(parsed.growth!)
    const fP = factorOf(parsed.price!)
    const opRev = mulDecimal(mulDecimal(fig.operatingRevenue, fV), fP)
    const revenue = add(opRev, fig.otherIncome)
    const cogs = mulDecimal(mulDecimal(fig.cogs, fV), factorOf(parsed.cogs!))
    const opex = mulDecimal(fig.opex, factorOf(parsed.opex!))
    const grossProfit = add(revenue, neg(cogs))
    const operatingIncome = add(add(opRev, neg(cogs)), neg(opex))
    // The baseline's own reconciling tax (income tax booked outside
    // operating income) carries over unchanged, exactly as the margin flow
    // reconciles it — so at-0 net income equals the baseline net income.
    const reconcilingTax = add(fig.netIncome, neg(add(add(fig.operatingIncome, fig.otherIncome), neg(fig.otherExpense))))
    const netIncome = add(add(add(operatingIncome, fig.otherIncome), neg(fig.otherExpense)), reconcilingTax)
    // Breakeven is the engine's definition: operating expenses over gross
    // margin, null without a positive margin — never a stand-in.
    const gm = cmp(revenue, '0') > 0 ? div(grossProfit, revenue) : null
    const breakeven = gm !== null && cmp(gm, '0') > 0 ? div(opex, gm) : null
    const safety = breakeven !== null && cmp(revenue, '0') > 0 ? div(add(revenue, neg(breakeven)), revenue) : null
    const risk = safety === null ? 'unknown'
      : cmp(safety, '0') < 0 ? 'critical'
        : cmp(safety, bands.comfort) >= 0 ? 'low'
          : cmp(safety, bands.safety) >= 0 ? 'moderate' : 'high'
    return { revenue, cogs, opex, grossProfit, operatingIncome, netIncome, gm, breakeven, safety, risk }
  }, [parsed, invalidKey, fig, bands])

  const grossMargin = Object.values(data.ratios).flat().find((r) => r.id === 'gross_margin')
  const baseGm = grossMargin?.value ?? null
  const baseSafety = fig.breakevenRevenue !== null && cmp(fig.revenue, '0') > 0
    ? div(add(fig.revenue, neg(fig.breakevenRevenue)), fig.revenue)
    : null

  const money = (n: string) => fmtMoney(n, { compact: true })
  const pct = (n: string | null) => (n === null ? null : fmtRatio(n, 'pct'))
  const signedMoney = (cur: string, base: string) => {
    const d = add(cur, neg(base))
    return `${cmp(d, '0') >= 0 ? '+' : ''}${money(d)}`
  }
  const toneOf = (cur: string, base: string) => (cmp(add(cur, neg(base)), '0') >= 0 ? 'positive' as const : 'negative' as const)

  const refusal = invalidKey ? t('invalidInput', { field: t(`fields.${invalidKey}`) }) : null

  return (
    <div className="space-y-5">
      {refusal ? (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-relaxed text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          {refusal}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={FlaskConical} accent="sky" label={t('kpi.revenue')} value={scenario ? money(scenario.revenue) : '—'} sub={scenario ? signedMoney(scenario.revenue, fig.revenue) : '—'} tone={scenario ? toneOf(scenario.revenue, fig.revenue) : undefined} />
        <KpiCard icon={FlaskConical} accent="teal" label={t('kpi.grossMargin')} value={scenario && scenario.gm !== null ? (pct(scenario.gm) ?? '—') : '—'} sub={scenario && scenario.gm !== null && baseGm !== null ? `${cmp(add(scenario.gm, neg(baseGm)), '0') >= 0 ? '+' : ''}${pct(add(scenario.gm, neg(baseGm))) ?? '—'}` : '—'} tone={scenario && scenario.gm !== null && baseGm !== null ? toneOf(scenario.gm, baseGm) : undefined} />
        <KpiCard icon={FlaskConical} accent="violet" label={t('kpi.operatingIncome')} value={scenario ? money(scenario.operatingIncome) : '—'} sub={scenario ? signedMoney(scenario.operatingIncome, fig.operatingIncome) : '—'} tone={scenario ? toneOf(scenario.operatingIncome, fig.operatingIncome) : undefined} />
        <KpiCard icon={FlaskConical} accent="amber" label={t('kpi.safetyMargin')} value={scenario && scenario.safety !== null ? (pct(scenario.safety) ?? '—') : '—'} sub={scenario && scenario.safety !== null && baseSafety !== null ? `${cmp(add(scenario.safety, neg(baseSafety)), '0') >= 0 ? '+' : ''}${pct(add(scenario.safety, neg(baseSafety))) ?? '—'}` : t('baselineSub')} tone={scenario && scenario.safety !== null && baseSafety !== null ? toneOf(scenario.safety, baseSafety) : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
        {/* Builder */}
        <Panel title={t('builder')} icon={FlaskConical}>
          <div className="space-y-4">
            <div>
              <span className="mb-1 block text-xs font-semibold text-slate-500 dark:text-slate-400">{t('template')}</span>
              <Select value="" placeholder={t('custom')} onChange={(e) => e.target.value && setInp(TEMPLATES[e.target.value]!)} triggerClassName="h-8 w-full text-sm">
                <option value="">{t('custom')}</option>
                {TEMPLATE_KEYS.map((k) => <option key={k} value={k}>{t(`templates.${k}`)}</option>)}
              </Select>
            </div>
            <ScenGroup title={t('revenueGroup')} color="text-emerald-500">
              <Row label={t('fields.growth')} value={inp.growth} onChange={(v) => setInp((s) => ({ ...s, growth: v }))} />
              <Row label={t('fields.price')} value={inp.price} onChange={(v) => setInp((s) => ({ ...s, price: v }))} />
            </ScenGroup>
            <ScenGroup title={t('costsGroup')} color="text-red-500">
              <Row label={t('fields.cogs')} value={inp.cogs} onChange={(v) => setInp((s) => ({ ...s, cogs: v }))} />
              <Row label={t('fields.opex')} value={inp.opex} onChange={(v) => setInp((s) => ({ ...s, opex: v }))} />
            </ScenGroup>
            <button type="button" onClick={() => setInp(ZERO_INPUTS)} className="w-full rounded-md border border-slate-200 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              {t('reset')}
            </button>
          </div>
        </Panel>

        {/* Comparison */}
        <div className="lg:col-span-2">
          <Panel title={t('impact')} icon={ChartColumnBig}>
            <GroupedBar
              labels={[t('chart.revenue'), t('chart.grossProfit'), t('chart.opIncome'), t('chart.netIncome')]}
              height={320}
              series={[
                { name: t('chart.baseline'), data: [fig.revenue, fig.grossProfit, fig.operatingIncome, fig.netIncome].map(toChartNumber), color: '#94a3b8' },
                { name: t('chart.scenario'), data: scenario ? [scenario.revenue, scenario.grossProfit, scenario.operatingIncome, scenario.netIncome].map(toChartNumber) : [0, 0, 0, 0], color: '#0d9488' },
              ]}
            />
          </Panel>
        </div>

        {/* Thresholds */}
        <Panel title={t('thresholds')} icon={Crosshair} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            <Threshold label={t('threshold.breakeven')} value={scenario?.breakeven == null ? '—' : money(scenario.breakeven)} />
            <Threshold label={t('threshold.safety')} value={scenario?.safety == null ? '—' : (pct(scenario.safety) ?? '—')} />
            <Threshold label={t('threshold.net')} value={scenario ? money(scenario.netIncome) : '—'} tone={scenario ? (cmp(scenario.netIncome, '0') >= 0 ? 'pos' : 'neg') : undefined} />
            <li className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-slate-500 dark:text-slate-400">{t('risk')}</span>
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold capitalize', RISK[scenario?.risk ?? 'unknown'])}>{t(`riskLevels.${scenario?.risk ?? 'unknown'}`)}</span>
            </li>
          </ul>
        </Panel>
      </div>
    </div>
  )
}

const RISK: Record<string, string> = {
  low: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  moderate: 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  high: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  critical: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  unknown: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
}

function ScenGroup({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div>
      <p className={cn('mb-1.5 text-xs font-semibold', color)}>{title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function Row({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-600 dark:text-slate-300">{label}</span>
      <input type="number" className={NUM} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function Threshold({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <li className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>
      <span className={cn('text-sm font-semibold tabular-nums', tone === 'pos' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'neg' ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-200')}>{value}</span>
    </li>
  )
}
