'use client'

import { useState } from 'react'
import { Info } from 'lucide-react'
import { Popover, cn } from '@openbooks/ui'
import { fmtValue, GRADE_STYLE, GRADE_TINT, type ValueFormat } from './format'

export interface RatioCardData {
  id: string
  value: number | null
  format: ValueFormat
  benchmark: number
  inverse?: boolean
  calc: string
  noData?: boolean
  noDataMsg?: string
  grade: string | null
}

export interface RatioDef {
  label: string
  formula: string
  desc: string
  interpret: string
}

/**
 * A single graded ratio tile. Colour-tinted by letter grade, shows the value
 * and its benchmark, and opens a detail popover (formula, interpretation,
 * the actual numerator/denominator) on click — mirroring Gantry's "click any
 * ratio for details" affordance.
 */
export function RatioCard({ data, def }: { data: RatioCardData; def: RatioDef }) {
  const [open, setOpen] = useState(false)
  const unavailable = data.noData || data.value === null
  const displayValue = unavailable ? 'N/A' : fmtValue(data.value, data.format)
  const benchmarkDisplay = fmtValue(data.benchmark, data.format)

  const card = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      className={cn(
        'group w-full rounded-lg border p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none',
        unavailable
          ? 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40'
          : GRADE_TINT[data.grade ?? 'F'],
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-xs font-medium text-slate-500 dark:text-slate-400">{def.label}</span>
        {unavailable ? (
          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-500 dark:bg-slate-700 dark:text-slate-300">
            N/A
          </span>
        ) : (
          <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-bold', GRADE_STYLE[data.grade ?? 'F'])}>
            {data.grade}
          </span>
        )}
      </div>
      <div className="mt-1 text-lg font-bold text-slate-900 tabular-nums dark:text-slate-100">{displayValue}</div>
      {unavailable ? (
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
          <Info size={11} />
          <span className="truncate">{data.noDataMsg ?? 'Data not available'}</span>
        </div>
      ) : (
        <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">Benchmark: {benchmarkDisplay}</div>
      )}
    </button>
  )

  return (
    <Popover trigger={card} open={open} onOpenChange={setOpen} align="start" side="bottom" className="w-80">
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{def.label}</h4>
          {!unavailable && (
            <span className={cn('rounded px-2 py-0.5 text-xs font-bold', GRADE_STYLE[data.grade ?? 'F'])}>
              {data.grade}
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-slate-900 tabular-nums dark:text-slate-100">{displayValue}</span>
          <span className="text-xs text-slate-400">vs {benchmarkDisplay} target</span>
        </div>
        <dl className="space-y-2 text-xs">
          <div>
            <dt className="font-semibold text-slate-500 uppercase dark:text-slate-400">Formula</dt>
            <dd className="mt-0.5 font-mono text-slate-700 dark:text-slate-300">{def.formula}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500 uppercase dark:text-slate-400">What it means</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">{def.desc}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500 uppercase dark:text-slate-400">Interpretation</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">{def.interpret}</dd>
          </div>
          <div className="border-t border-slate-100 pt-2 dark:border-slate-800">
            <dt className="font-semibold text-slate-500 uppercase dark:text-slate-400">This period</dt>
            <dd className="mt-0.5 font-mono text-slate-700 dark:text-slate-300">{data.calc}</dd>
          </div>
        </dl>
      </div>
    </Popover>
  )
}
