'use client'

import { useMemo, useState } from 'react'
import { FlaskConical, Crosshair, ChartColumnBig } from 'lucide-react'
import { cn, Select } from '@openbooks/ui'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { GroupedBar } from '../../_ui/charts'
import { useAnalyticsMoney, fmtPct } from '../../_ui/format'

interface Inputs {
  growth: number
  price: number
  cogs: number
  opex: number
}

// Template values are the (rev growth / price / cogs / opex; its volume
// input maps onto our growth-driven COGS scaling).
const TEMPLATES: Record<string, { label: string; inputs: Inputs }> = {
  recession: { label: '📉 Recession', inputs: { growth: -15, price: -5, cogs: -5, opex: -10 } },
  growth: { label: '📈 Growth Push', inputs: { growth: 20, price: 5, cogs: 10, opex: 15 } },
  cost_cut: { label: '✂️ Cost Cutting', inputs: { growth: 0, price: 0, cogs: -10, opex: -20 } },
  price_war: { label: '⚔️ Price War', inputs: { growth: -10, price: -15, cogs: 0, opex: 0 } },
  expansion: { label: '🚀 Expansion', inputs: { growth: 30, price: 0, cogs: 25, opex: 30 } },
  stagflation: { label: '📊 Stagflation', inputs: { growth: 0, price: 5, cogs: 15, opex: 10 } },
}

const NUM = 'h-8 w-20 rounded-md border border-slate-200 bg-white px-2 text-right text-sm text-slate-700 tabular-nums dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200'

export function ScenariosTab({ data }: { data: HealthData }) {
  const fmtMoney = useAnalyticsMoney()
  const f = data.figures
  const [inp, setInp] = useState<Inputs>({ growth: 0, price: 0, cogs: 0, opex: 0 })

  const scenario = useMemo(() => {
    const vol = inp.growth / 100
    const price = inp.price / 100
    const revenue = f.revenue * (1 + vol) * (1 + price)
    const cogs = f.cogs * (1 + vol) * (1 + inp.cogs / 100)
    const opex = f.opex * (1 + inp.opex / 100)
    const grossProfit = revenue - cogs
    const operatingIncome = grossProfit - opex
    const netIncome = operatingIncome - f.otherExpense
    const gmPct = revenue > 0 ? grossProfit / revenue : 0
    const breakeven = gmPct > 0 ? opex / gmPct : null
    const safety = breakeven !== null && revenue > 0 ? (revenue - breakeven) / revenue : null
    // Risk tiers: low ≥ 0.30, moderate ≥ 0.10 safety margin.
    const risk = safety === null ? 'unknown' : safety >= 0.3 ? 'low' : safety >= 0.1 ? 'moderate' : safety >= 0 ? 'high' : 'critical'
    return { revenue, cogs, opex, grossProfit, operatingIncome, netIncome, gmPct, breakeven, safety, risk }
  }, [inp, f])

  const baseGm = f.revenue > 0 ? f.grossProfit / f.revenue : 0
  const baseBreakeven = baseGm > 0 ? f.opex / baseGm : null
  const baseSafety = baseBreakeven !== null && f.revenue > 0 ? (f.revenue - baseBreakeven) / f.revenue : null

  const delta = (cur: number, base: number) => cur - base
  const money = (n: number) => fmtMoney(n, { compact: true })

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={FlaskConical} accent="sky" label="Revenue" value={money(scenario.revenue)} sub={`${delta(scenario.revenue, f.revenue) >= 0 ? '+' : ''}${money(delta(scenario.revenue, f.revenue))}`} tone={delta(scenario.revenue, f.revenue) >= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={FlaskConical} accent="teal" label="Gross Margin" value={fmtPct(scenario.gmPct)} sub={`${(scenario.gmPct - baseGm) >= 0 ? '+' : ''}${fmtPct(scenario.gmPct - baseGm)}`} tone={scenario.gmPct - baseGm >= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={FlaskConical} accent="violet" label="Operating Income" value={money(scenario.operatingIncome)} sub={`${delta(scenario.operatingIncome, f.operatingIncome) >= 0 ? '+' : ''}${money(delta(scenario.operatingIncome, f.operatingIncome))}`} tone={delta(scenario.operatingIncome, f.operatingIncome) >= 0 ? 'positive' : 'negative'} />
        <KpiCard icon={FlaskConical} accent="amber" label="Safety Margin" value={scenario.safety === null ? '—' : fmtPct(scenario.safety)} sub={baseSafety !== null && scenario.safety !== null ? `${scenario.safety - baseSafety >= 0 ? '+' : ''}${fmtPct(scenario.safety - baseSafety)}` : 'baseline'} tone={scenario.safety !== null && baseSafety !== null && scenario.safety - baseSafety >= 0 ? 'positive' : 'negative'} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
        {/* Builder */}
        <Panel title="Scenario Builder" icon={FlaskConical}>
          <div className="space-y-4">
            <div>
              <span className="mb-1 block text-xs font-semibold text-slate-500 dark:text-slate-400">Template</span>
              <Select value="" placeholder="Custom Scenario" onChange={(e) => e.target.value && setInp(TEMPLATES[e.target.value].inputs)} triggerClassName="h-8 w-full text-sm">
                <option value="">Custom Scenario</option>
                {Object.entries(TEMPLATES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
              </Select>
            </div>
            <ScenGroup title="Revenue" color="text-emerald-500">
              <Row label="Growth %" value={inp.growth} onChange={(v) => setInp((s) => ({ ...s, growth: v }))} />
              <Row label="Price Δ %" value={inp.price} onChange={(v) => setInp((s) => ({ ...s, price: v }))} />
            </ScenGroup>
            <ScenGroup title="Costs" color="text-red-500">
              <Row label="COGS Δ %" value={inp.cogs} onChange={(v) => setInp((s) => ({ ...s, cogs: v }))} />
              <Row label="OpEx Δ %" value={inp.opex} onChange={(v) => setInp((s) => ({ ...s, opex: v }))} />
            </ScenGroup>
            <button type="button" onClick={() => setInp({ growth: 0, price: 0, cogs: 0, opex: 0 })} className="w-full rounded-md border border-slate-200 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              Reset to baseline
            </button>
          </div>
        </Panel>

        {/* Comparison */}
        <div className="lg:col-span-2">
          <Panel title="Projected Impact" icon={ChartColumnBig}>
            <GroupedBar
              labels={['Revenue', 'Gross Profit', 'Op Income', 'Net Income']}
              height={320}
              series={[
                { name: 'Baseline', data: [f.revenue, f.grossProfit, f.operatingIncome, f.netIncome], color: '#94a3b8' },
                { name: 'Scenario', data: [scenario.revenue, scenario.grossProfit, scenario.operatingIncome, scenario.netIncome], color: '#0d9488' },
              ]}
            />
          </Panel>
        </div>

        {/* Thresholds */}
        <Panel title="Key Thresholds" icon={Crosshair} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            <Threshold label="Breakeven Revenue" value={scenario.breakeven === null ? '—' : money(scenario.breakeven)} />
            <Threshold label="Safety Margin" value={scenario.safety === null ? '—' : fmtPct(scenario.safety)} />
            <Threshold label="Net Income" value={money(scenario.netIncome)} tone={scenario.netIncome >= 0 ? 'pos' : 'neg'} />
            <li className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-slate-500 dark:text-slate-400">Risk Level</span>
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold capitalize', RISK[scenario.risk])}>{scenario.risk}</span>
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

function Row({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-600 dark:text-slate-300">{label}</span>
      <input type="number" className={NUM} value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} />
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
