'use client'

import { cn } from '@openbooks/ui'
import { Gauge } from './Gauge'
import { scoreTone, type ScoreBands } from './format'

export interface ScoreBar {
  label: string
  score: number
}

/**
 * The Financial Health Score panel: the big gauge plus a stacked set of
 * category progress bars (Profitability / Efficiency / Operations) and an
 * emphasised Overall bar — the composite scorecard from the Health tab.
 */
export function HealthScore({
  score,
  scoreLabel,
  categories,
  overallLabel,
  bands,
}: {
  score: number
  scoreLabel: string
  categories: ScoreBar[]
  overallLabel: string
  /** Tone cut-offs for the 0–100 scale, from the caller's own configuration. */
  bands: ScoreBands
}) {
  return (
    <div className="flex flex-col items-center gap-5">
      <Gauge value={score} label={scoreLabel} size={200} bands={bands} />
      <div className="w-full space-y-3">
        {categories.map((c) => (
          <Bar key={c.label} label={c.label} score={c.score} bands={bands} />
        ))}
        <div className="border-t border-slate-100 pt-3 dark:border-slate-800">
          <Bar label={overallLabel} score={score} emphasis bands={bands} />
        </div>
      </div>
    </div>
  )
}

function Bar({ label, score, emphasis, bands }: { label: string; score: number; emphasis?: boolean; bands: ScoreBands }) {
  const tone = scoreTone(score, bands)
  const pct = Math.min(100, Math.max(0, score))
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className={cn('text-slate-600 dark:text-slate-300', emphasis ? 'text-sm font-semibold' : 'text-xs')}>
          {label}
        </span>
        <span className={cn('font-bold tabular-nums', emphasis ? 'text-sm' : 'text-xs', tone.text)}>
          {Math.round(score)}
        </span>
      </div>
      <div
        className={cn(
          'overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800',
          emphasis ? 'h-2.5' : 'h-1.5',
        )}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            backgroundColor: tone.hex,
            transition: 'width 700ms cubic-bezier(0.22,0.61,0.36,1)',
          }}
        />
      </div>
    </div>
  )
}
