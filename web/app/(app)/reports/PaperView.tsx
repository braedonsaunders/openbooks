'use client'

import Link from 'next/link'
import { useFormatter } from 'next-intl'
import { useMoney } from '@/components/money-provider'
import { cn } from '@openbooks/ui'
import { ReportPaper } from './ReportPaper'
import { ReportDrillLink } from './ReportDrillLink'
import type { ReportDrillTarget } from '../../../lib/report-drill'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  reportTotalRowClass,
} from './ReportTable'

/**
 * The ONE on-screen renderer for the unified report shape — the common
 * `{ title, groups }` contract that BOTH engines emit (statements via
 * statementViewToExportData, custom reports via ReportRunResult). It draws the
 * result as a printed "sheet of paper" (centred company/title/period header,
 * section tables, right-aligned tabular numbers) so the in-app view matches the
 * PDF. Used by the report editor's live preview AND the standard report pages,
 * so standard and custom reports look identical.
 *
 * Fidelity for statement pages: optional per-cell drill `links`, per-column
 * `money` flags (currency-formatted; counts/percents left plain), and negative
 * colouring — so a flattened page keeps its drill-through and polish.
 */

export type PaperCell = string | number | null | undefined

export type PaperGroup = {
  title?: string
  subtitle?: string
  columns: string[]
  rows: PaperCell[][]
  align?: ('left' | 'right' | 'center')[]
  /** Per-column: format the cell as currency (else plain number/text). */
  money?: boolean[]
  /** Per-cell drill href (parallel to `rows`); null/absent ⇒ plain cell. */
  links?: (string | null | undefined)[][]
  /** Per-cell report drill target (parallel to `rows`). */
  drills?: (ReportDrillTarget | null | undefined)[][]
  /** Explicit total row. Ordinary custom result sets must not style their last data row as a total. */
  totalRowIndex?: number
  isEmpty?: boolean
}

export type PaperData = {
  title: string
  periodPhrase?: string
  note?: string
  summary?: { label: string; value: PaperCell }[]
  groups: PaperGroup[]
  /** Custom reports use one source-row drill target for every numeric result. */
  defaultDrillTarget?: ReportDrillTarget
}

function isNumericCell(v: PaperCell): boolean {
  if (typeof v === 'number') return true
  if (typeof v !== 'string') return false
  return /^-?[$(]?-?[\d,]+(\.\d+)?\)?%?$/.test(v.trim())
}

export function PaperView({
  company,
  data,
  emptyLabel,
  currency = '',
}: {
  company: string
  data: PaperData
  emptyLabel: string
  currency?: string
}) {
  const format = useFormatter()
  const { money } = useMoney()
  const fmt = (value: PaperCell, isMoney: boolean): string => {
    if (value === null || value === undefined || value === '') return ''
    if (typeof value !== 'number') return value
    return isMoney
      ? money(value, { currency: currency || undefined, accounting: true })
      : format.number(value, { maximumFractionDigits: 2 })
  }
  const wide = data.groups.some((group) => group.columns.length > 5)
  return (
    <ReportPaper company={company} title={data.title} periodPhrase={data.periodPhrase} note={data.note} wide={wide}>
      {data.summary?.length ? (
        <div className="mb-6 grid grid-flow-col auto-cols-fr divide-x divide-slate-200 border-y border-slate-200 py-3 dark:divide-slate-700 dark:border-slate-700">
          {data.summary.map((item, index) => (
            <div key={index} className="min-w-0 px-3 text-center">
              <div className="truncate text-xs text-slate-500 dark:text-slate-400">{item.label}</div>
              <div className="truncate font-semibold tabular-nums">
                {data.defaultDrillTarget && isNumericCell(item.value) ? (
                  <ReportDrillLink target={data.defaultDrillTarget} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">
                    {fmt(item.value, false)}
                  </ReportDrillLink>
                ) : fmt(item.value, false)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="space-y-7">
        {data.groups.map((group, gi) => {
          const showTitle = group.title && (data.groups.length > 1 || !!group.subtitle)
          const alignOf = (ci: number, cell: PaperCell): 'left' | 'right' | 'center' =>
            group.align?.[ci] ?? (isNumericCell(cell) ? 'right' : 'left')
          return (
            <section key={gi} className="space-y-1.5">
              {showTitle ? (
                <div className="flex items-baseline gap-2">
                  <h3 className="pt-2 text-xs font-semibold tracking-wide uppercase">{group.title}</h3>
                  {group.subtitle ? <span className="text-xs text-slate-500 dark:text-slate-400">{group.subtitle}</span> : null}
                </div>
              ) : null}
              {group.isEmpty || group.rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400 italic">{emptyLabel}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {group.columns.map((c, ci) => (
                        <TableHead
                          key={ci}
                          className={cn(
                            (group.align?.[ci] ?? (ci === 0 ? 'left' : 'right')) === 'right' ? 'text-right' : 'text-left',
                          )}
                        >
                          {c}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.rows.map((row, ri) => {
                      const total = group.totalRowIndex === ri
                      return (
                        <TableRow
                          key={ri}
                          className={cn(total && reportTotalRowClass, total && 'font-semibold')}
                        >
                          {row.map((cell, ci) => {
                            const a = alignOf(ci, cell)
                            const isMoney = !!group.money?.[ci]
                            const negative = typeof cell === 'number' && cell < 0
                            const href = group.links?.[ri]?.[ci]
                            const drill = group.drills?.[ri]?.[ci]
                              ?? (isNumericCell(cell) ? data.defaultDrillTarget : undefined)
                            const text = fmt(cell, isMoney)
                            return (
                              <TableCell
                                key={ci}
                                className={cn(
                                  a === 'right' && 'text-right tabular-nums',
                                  a === 'center' && 'text-center',
                                  negative && 'text-red-600 dark:text-red-400',
                                )}
                              >
                                {drill ? (
                                  <ReportDrillLink target={drill} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">
                                    {text}
                                  </ReportDrillLink>
                                ) : href ? (
                                  <Link href={href} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">
                                    {text}
                                  </Link>
                                ) : (
                                  text
                                )}
                              </TableCell>
                            )
                          })}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </section>
          )
        })}
      </div>
    </ReportPaper>
  )
}
