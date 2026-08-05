'use client'

import { Info, LineChart } from 'lucide-react'
import type { HealthData } from '../../../../../lib/analytics/health-data'
import { Panel } from '../../_ui/Panel'
import { ConfigEditor } from '../../_ui/ConfigEditor'

/**
 * Configuration — the benchmark targets behind the letter grades on the Ratios
 * tab and the composite health score, editable per organization. Saving
 * recomputes every grade and the score with the new targets.
 */
export function ConfigurationTab({ data }: { data: HealthData }) {
  const b = data.benchmarks
  const forecastDefaults: { label: string; value: string }[] = [
    { label: 'Default method', value: 'Exponential Smoothing (ETS)' },
    { label: 'Default horizon', value: '6 months' },
    { label: 'Default confidence', value: '90%' },
    { label: 'Seasonality', value: 'Auto-detect' },
  ]

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <ConfigEditor
        dashboard="financialHealth"
        fields={[
          { key: 'grossMarginTarget', label: 'Gross margin target (%)', help: 'Benchmark for the Gross Margin grade', min: 0, max: 100, step: 1 },
          { key: 'operatingMarginTarget', label: 'Operating margin target (%)', help: 'Benchmark for the Operating Margin grade', min: 0, max: 100, step: 1 },
          { key: 'ebitdaMarginTarget', label: 'EBITDA margin target (%)', help: 'Benchmark for the EBITDA Margin grade', min: 0, max: 100, step: 1 },
          { key: 'netMarginTarget', label: 'Net margin target (%)', help: 'Bottom-line profitability benchmark', min: 0, max: 100, step: 1 },
          { key: 'roaTarget', label: 'Return on assets target (%)', help: 'Benchmark for the ROA grade (needs balance-sheet data)', min: 0, max: 100, step: 1 },
          { key: 'roeTarget', label: 'Return on equity target (%)', help: 'Benchmark for the ROE grade (needs balance-sheet data)', min: 0, max: 100, step: 1 },
          { key: 'roicTarget', label: 'Return on invested capital target (%)', help: 'Benchmark for the ROIC grade (needs balance-sheet data)', min: 0, max: 100, step: 1 },
          { key: 'revenuePerEmployee', label: 'Revenue per employee ($)', help: 'Workforce productivity benchmark', min: 0, max: 10_000_000, step: 5_000 },
          { key: 'gpPerEmployee', label: 'Gross profit per employee ($)', help: 'Workforce productivity benchmark', min: 0, max: 10_000_000, step: 5_000 },
        ]}
        values={{
          grossMarginTarget: Math.round(b.grossMargin * 100),
          operatingMarginTarget: Math.round(b.operatingMargin * 100),
          ebitdaMarginTarget: Math.round(b.ebitdaMargin * 100),
          netMarginTarget: Math.round(b.netMargin * 100),
          roaTarget: Math.round(b.roa * 100),
          roeTarget: Math.round(b.roe * 100),
          roicTarget: Math.round(b.roic * 100),
          revenuePerEmployee: b.revenuePerEmployee,
          gpPerEmployee: b.gpPerEmployee,
        }}
        defaults={{
          grossMarginTarget: 40,
          operatingMarginTarget: 15,
          ebitdaMarginTarget: 20,
          netMarginTarget: 10,
          roaTarget: 8,
          roeTarget: 15,
          roicTarget: 12,
          revenuePerEmployee: 200_000,
          gpPerEmployee: 80_000,
        }}
      />

      <div className="space-y-5">
        <Panel title="How grades are computed" icon={Info}>
          <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
            <p>
              Each ratio is scored against its target: a value at or above target earns an A, and the grade
              steps down as it falls below (B ≥ 80%, C ≥ 60%, D ≥ 40% of target). Cost ratios invert — lower is
              better. The composite health score averages the category scores.
            </p>
            <p className="text-slate-500 dark:text-slate-400">
              Adjusting a target here re-grades the Ratios tab and recomputes the health score the moment you save.
            </p>
          </div>
        </Panel>
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
      </div>
    </div>
  )
}
