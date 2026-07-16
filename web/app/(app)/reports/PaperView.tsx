'use client'

import { cn } from '@openbooks/ui'

/**
 * The ONE on-screen renderer for the unified report shape — the common
 * `{ title, groups }` contract that BOTH engines emit (statements via
 * statementViewToExportData, custom reports via ReportRunResult). It draws the
 * result as a printed "sheet of paper" (centred company/title/period header,
 * section tables, right-aligned tabular numbers) so the in-app view matches the
 * PDF. Used by the report editor's live preview and, going forward, by the
 * standard report pages — so standard and custom reports look identical.
 */

export type PaperCell = string | number | null | undefined

export type PaperGroup = {
  title?: string
  subtitle?: string
  columns: string[]
  rows: PaperCell[][]
  align?: ('left' | 'right' | 'center')[]
  isEmpty?: boolean
}

export type PaperData = {
  title: string
  periodPhrase?: string
  note?: string
  groups: PaperGroup[]
}

function isNumericCell(v: string | number | null | undefined): boolean {
  if (typeof v === 'number') return true
  if (typeof v !== 'string') return false
  return /^-?[$(]?-?[\d,]+(\.\d+)?\)?%?$/.test(v.trim())
}

function fmt(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return v
}

/** A totals-ish row: the export adapters push the grand total as the last row. */
function isLastRow(rows: unknown[], i: number): boolean {
  return i === rows.length - 1 && rows.length > 1
}

export function PaperView({
  company,
  data,
  emptyLabel,
}: {
  company: string
  data: PaperData
  emptyLabel: string
}) {
  return (
    <div className="mx-auto w-full max-w-4xl rounded-lg border border-slate-200 bg-white px-6 py-8 text-slate-900 shadow-sm sm:px-10 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100">
      <header className="mb-6 space-y-0.5 text-center">
        <div className="text-base font-semibold">{company}</div>
        <div className="text-xl font-bold tracking-tight">{data.title}</div>
        {data.periodPhrase ? <div className="text-sm text-slate-500 dark:text-slate-400">{data.periodPhrase}</div> : null}
        {data.note ? <div className="text-xs text-slate-400 italic dark:text-slate-500">{data.note}</div> : null}
      </header>

      <div className="space-y-7">
        {data.groups.map((group, gi) => {
          const showTitle = group.title && (data.groups.length > 1 || !!group.subtitle)
          const alignOf = (ci: number, cell: PaperCell): 'left' | 'right' | 'center' =>
            group.align?.[ci] ?? (isNumericCell(cell) ? 'right' : 'left')
          return (
            <section key={gi} className="space-y-1.5">
              {showTitle ? (
                <div className="flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold">{group.title}</h3>
                  {group.subtitle ? <span className="text-xs text-slate-500 dark:text-slate-400">{group.subtitle}</span> : null}
                </div>
              ) : null}
              {group.isEmpty || group.rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400 italic">{emptyLabel}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-slate-300 dark:border-slate-600">
                        {group.columns.map((c, ci) => (
                          <th
                            key={ci}
                            className={cn(
                              'px-2 py-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400',
                              (group.align?.[ci] ?? (ci === 0 ? 'left' : 'right')) === 'right' ? 'text-right' : 'text-left',
                            )}
                          >
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row, ri) => {
                        const total = isLastRow(group.rows, ri)
                        return (
                          <tr
                            key={ri}
                            className={cn(
                              'border-b border-slate-100 dark:border-slate-800/70',
                              total && 'border-t-2 border-slate-300 font-semibold dark:border-slate-600',
                            )}
                          >
                            {row.map((cell, ci) => {
                              const a = alignOf(ci, cell)
                              const numeric = a === 'right'
                              return (
                                <td
                                  key={ci}
                                  className={cn(
                                    'px-2 py-1',
                                    a === 'right' && 'text-right tabular-nums',
                                    a === 'center' && 'text-center',
                                    numeric && typeof cell === 'number' && cell < 0 && 'text-red-600 dark:text-red-400',
                                  )}
                                >
                                  {fmt(cell)}
                                </td>
                              )
                            })}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
