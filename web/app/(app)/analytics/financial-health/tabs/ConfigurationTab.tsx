'use client'

import { Cog, Target, Percent, LineChart } from 'lucide-react'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { Panel } from '../../_ui/Panel'

/**
 * Configuration — surfaces the benchmark targets and forecast defaults the
 * dashboard uses. Read-only for now (persisting per-org overrides is planned);
 * mirrors Gantry's Configuration tab so the numbers behind the grades are
 * transparent.
 */
export function ConfigurationTab({ data }: { data: HealthData }) {
  void data
  const benchmarks: { label: string; value: string; note: string }[] = [
    { label: 'Gross Margin Target', value: '40%', note: 'Benchmark for the Gross Margin grade' },
    { label: 'Operating Margin Target', value: '15%', note: 'Benchmark for the Operating Margin grade' },
    { label: 'EBITDA Margin Target', value: '20%', note: 'Operating target + 5 points' },
    { label: 'Net Margin Target', value: '10%', note: 'Bottom-line profitability benchmark' },
    { label: 'ROA / ROE / ROIC', value: '8% / 15% / 12%', note: 'Return benchmarks (need balance-sheet data)' },
    { label: 'Revenue / GP per Employee', value: '$200K / $80K', note: 'Workforce productivity benchmarks' },
  ]
  const forecastDefaults: { label: string; value: string }[] = [
    { label: 'Default method', value: 'Exponential Smoothing (ETS)' },
    { label: 'Default horizon', value: '6 months' },
    { label: 'Default confidence', value: '90%' },
    { label: 'Seasonality', value: 'Auto-detect' },
  ]

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Panel title="Benchmark Targets" icon={Target} bodyClassName="p-0">
        <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
          {benchmarks.map((b) => (
            <li key={b.label} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                  <Percent size={13} className="text-slate-400" />
                  {b.label}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{b.note}</p>
              </div>
              <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">{b.value}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="space-y-5">
        <Panel title="Forecast Defaults" icon={LineChart} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {forecastDefaults.map((d) => (
              <li key={d.label} className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-slate-600 dark:text-slate-300">{d.label}</span>
                <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{d.value}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="About these settings" icon={Cog}>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Benchmark targets drive the letter grades on the Ratios tab and the composite health score. They ship with
            sensible defaults; per-organization overrides (and persisted forecast preferences) are planned.
          </p>
        </Panel>
      </div>
    </div>
  )
}
