'use client'

import { Info, LineChart } from 'lucide-react'
import { Panel } from '../../_ui/Panel'
import { ConfigEditor } from '../../_ui/ConfigEditor'

/**
 * Configuration — the benchmark targets behind the letter grades on the Ratios
 * tab and the composite health score, editable per organization. Saving
 * recomputes every grade and the score with the new targets.
 */
export function ConfigurationTab({ canEdit }: { canEdit: boolean }) {
  const forecastDefaults: { label: string; value: string }[] = [
    { label: 'Default method', value: 'Exponential Smoothing (ETS)' },
    { label: 'Default horizon', value: '6 months' },
    { label: 'Default confidence', value: '90%' },
    { label: 'Seasonality', value: 'Auto-detect' },
  ]

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <ConfigEditor dashboard="financialHealth" canEdit={canEdit} />

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
