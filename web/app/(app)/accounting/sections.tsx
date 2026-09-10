import { cn } from '@openbooks/ui'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { Gauge } from '../analytics/_ui/Gauge'

/**
 * The accounting cockpit's bespoke panel bodies, extracted from page.tsx.
 *
 * ViewSpec composes the grid and the panels; the bodies below stay components
 * shared by both render paths so they cannot drift. Each is a verbatim move
 * of the native markup (class strings transcribed, never retyped) with the
 * loader-resolved values passed in as props — the spec binds, the loader
 * computes.
 */

export interface HealthCategoryRow {
  key: string
  label: string
  score: number
}

export interface HealthRatioRow {
  id: string
  label: string
  calc: string
  value: string
  benchmark: string
  grade: string
  score: number
}

/** Score → threshold-tier class, mirroring the native `cn` ternaries. */
function scoreClass(score: number, kind: 'text' | 'bar' | 'chip'): string {
  if (kind === 'text') {
    return score >= 60
      ? 'text-emerald-600 dark:text-emerald-400'
      : score >= 40
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-red-600 dark:text-red-400'
  }
  if (kind === 'bar') {
    return score >= 60 ? 'bg-emerald-500' : score >= 40 ? 'bg-amber-500' : 'bg-red-500'
  }
  return score >= 60
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
    : score >= 40
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
      : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300'
}

/**
 * The Financial Health hero body: gauge + category bars, ratio table, deep-link
 * footer. The native page lays these out bare inside the panel (no sub-panel);
 * the spec passes the same strings the loader resolved.
 */
export function HealthHero({
  gaugeValue,
  gaugeLabel,
  categories,
  ratios,
  ratioLabels,
  fullAnalysisLabel,
}: {
  gaugeValue: number
  gaugeLabel: string
  categories: HealthCategoryRow[]
  ratios: HealthRatioRow[]
  ratioLabels: { ratio: string; value: string; benchmark: string; grade: string }
  fullAnalysisLabel: string
}) {
  return (
    <>
      <div className="flex flex-col items-center gap-2 border-b border-slate-100 px-6 py-5 sm:flex-row sm:gap-8 dark:border-slate-800">
        <Gauge value={gaugeValue} label={gaugeLabel} size={150} thickness={13} showTicks={false} className="shrink-0" />
        <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-1.5 sm:grid-cols-3">
          {categories.map((c) => (
            <div key={c.key}>
              <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
                {c.label}
              </p>
              <div className="flex items-center gap-2">
                <span className={cn('text-sm font-bold tabular-nums', scoreClass(c.score, 'text'))}>
                  {Math.round(c.score)}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <span
                    className={cn('block h-full rounded-full', scoreClass(c.score, 'bar'))}
                    style={{ width: `${Math.min(100, Math.max(2, c.score))}%` }}
                  />
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <th className="px-4 py-2 text-left font-medium">{ratioLabels.ratio}</th>
            <th className="px-3 py-2 text-right font-medium">{ratioLabels.value}</th>
            <th className="px-3 py-2 text-right font-medium">{ratioLabels.benchmark}</th>
            <th className="px-4 py-2 text-center font-medium">{ratioLabels.grade}</th>
          </tr>
        </thead>
        <tbody>
          {ratios.map((r) => (
            <tr key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
              <td className="px-4 py-2">
                <span className="font-medium text-slate-700 dark:text-slate-200">{r.label}</span>
                <span className="ml-2 hidden text-xs text-slate-400 sm:inline dark:text-slate-500">{r.calc}</span>
              </td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">{r.value}</td>
              <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{r.benchmark}</td>
              <td className="px-4 py-2 text-center">
                <span className={cn('inline-block w-8 rounded-full py-0.5 text-[11px] font-bold', scoreClass(r.score, 'chip'))}>
                  {r.grade}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <Link
          href={'/analytics/financial-health' as never}
          className="inline-flex items-center gap-1 text-xs font-medium text-teal-600 hover:underline dark:text-teal-400"
        >
          {fullAnalysisLabel} <ArrowUpRight size={12} />
        </Link>
      </div>
    </>
  )
}

export type AttentionItem = { tone: 'negative' | 'warning'; text: string; href: string }
