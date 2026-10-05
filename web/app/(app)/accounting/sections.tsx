import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../reports/ReportTable"
import { cn } from '@openbooks/ui'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { Gauge } from '../analytics/_ui/Gauge'

/**
 * The accounting cockpit's bespoke panel bodies, extracted from page.tsx.
 *
 * ViewSpec composes the grid and the panels; the bodies below stay components
 * shared by the page and the widget registry so they cannot drift. Each is a verbatim move
 * of the native markup (class strings transcribed, never retyped) with the
 * loader-resolved values passed in as props — the spec binds, the loader
 * computes.
 */

/** The tone of a score under the organization's configured score bands, resolved by the loader. */
export type HealthTone = 'good' | 'warn' | 'bad'

export interface HealthCategoryRow {
  key: string
  label: string
  score: number
  tone: HealthTone
}

export interface HealthRatioRow {
  id: string
  label: string
  calc: string
  value: string
  benchmark: string
  grade: string
  score: number
  tone: HealthTone
}

function toneClass(tone: HealthTone, kind: 'text' | 'bar' | 'chip'): string {
  const classes: Record<HealthTone, Record<typeof kind, string>> = {
    good: { text: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' },
    warn: { text: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500', chip: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' },
    bad: { text: 'text-red-600 dark:text-red-400', bar: 'bg-red-500', chip: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300' },
  }
  return classes[tone][kind]
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
  showFullAnalysisLink,
}: {
  gaugeValue: number
  gaugeLabel: string
  categories: HealthCategoryRow[]
  ratios: HealthRatioRow[]
  ratioLabels: { ratio: string; value: string; benchmark: string; grade: string }
  fullAnalysisLabel: string
  /** financial-health requires reports.read: without it the footer link is a
   * dead end, so it stays hidden (the tab bar hides it the same way). */
  showFullAnalysisLink: boolean
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
                <span className={cn('text-sm font-bold tabular-nums', toneClass(c.tone, 'text'))}>
                  {Math.round(c.score)}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <span
                    className={cn('block h-full rounded-full', toneClass(c.tone, 'bar'))}
                    style={{ width: `${Math.min(100, Math.max(2, c.score))}%` }}
                  />
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <SharedTable className="w-full text-sm">
        <SharedTableHeader className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <SharedTableHead className="px-4 py-2 text-left font-medium">{ratioLabels.ratio}</SharedTableHead>
            <SharedTableHead className="px-3 py-2 text-right font-medium">{ratioLabels.value}</SharedTableHead>
            <SharedTableHead className="px-3 py-2 text-right font-medium">{ratioLabels.benchmark}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 text-center font-medium">{ratioLabels.grade}</SharedTableHead>
          </SharedTableRow>
        </SharedTableHeader>
        <SharedTableBody>
          {ratios.map((r) => (
            <SharedTableRow key={r.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
              <SharedTableCell className="px-4 py-2">
                <span className="font-medium text-slate-700 dark:text-slate-200">{r.label}</span>
                <span className="ml-2 hidden text-xs text-slate-400 sm:inline dark:text-slate-500">{r.calc}</span>
              </SharedTableCell>
              <SharedTableCell className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">{r.value}</SharedTableCell>
              <SharedTableCell className="px-3 py-2 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{r.benchmark}</SharedTableCell>
              <SharedTableCell className="px-4 py-2 text-center">
                <span className={cn('inline-block w-8 rounded-full py-0.5 text-[11px] font-bold', toneClass(r.tone, 'chip'))}>
                  {r.grade}
                </span>
              </SharedTableCell>
            </SharedTableRow>
          ))}
        </SharedTableBody>
      </SharedTable>
      {showFullAnalysisLink ? (
        <div className="border-t border-slate-100 px-4 py-2.5 dark:border-slate-800">
          <Link
            href={'/analytics/financial-health' as never}
            className="inline-flex items-center gap-1 text-xs font-medium text-teal-600 hover:underline dark:text-teal-400"
          >
            {fullAnalysisLabel} <ArrowUpRight size={12} />
          </Link>
        </div>
      ) : null}
    </>
  )
}

export type AttentionItem = { tone: 'negative' | 'warning'; text: string; href: string }
