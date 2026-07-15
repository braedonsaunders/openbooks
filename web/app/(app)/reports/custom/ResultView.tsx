'use client'

import { useTranslations } from 'next-intl'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import type { ReportRunResult } from '@openbooks/reports'

/** Right-align numeric-looking cells (money/counts) in tabular-nums. */
function isNumericCell(v: string | number | null | undefined): boolean {
  if (typeof v === 'number') return true
  if (typeof v !== 'string') return false
  return /^-?\d[\d,]*(\.\d+)?$/.test(v.trim())
}

/**
 * Render a ReportRunResult exactly as the engine shapes it: a summary band of
 * key figures, then one section per group (rows mode with a groupBy yields
 * several; summarize/plain rows yield one). Shared by the studio live preview
 * and the run/view page.
 */
export function ResultView({ result }: { result: ReportRunResult }) {
  const t = useTranslations('reports.custom.resultView')
  return (
    <div className="space-y-5">
      {result.summary.length > 0 ? (
        <div className="flex flex-wrap gap-4">
          {result.summary.map((s, i) => (
            <div
              key={i}
              className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/60"
            >
              <div className="text-xs text-slate-500 dark:text-slate-400">{s.label}</div>
              <div className="text-lg font-semibold text-slate-900 tabular-nums dark:text-slate-100">
                {typeof s.value === 'number' ? s.value.toLocaleString() : s.value}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {result.groups.map((group, gi) => (
        <div key={gi} className="space-y-2">
          {result.groups.length > 1 || group.title !== 'Results' ? (
            <div className="flex items-baseline gap-2">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{group.title}</h3>
              {group.subtitle ? (
                <span className="text-xs text-slate-500 dark:text-slate-400">{group.subtitle}</span>
              ) : null}
            </div>
          ) : null}
          {group.isEmpty ? (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              {t('noRows')}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {group.columns.map((c, ci) => (
                      <TableHead key={ci}>{c}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.rows.map((row, ri) => (
                    <TableRow key={ri}>
                      {row.map((cell, ci) => (
                        <TableCell
                          key={ci}
                          className={
                            isNumericCell(cell)
                              ? 'text-right tabular-nums'
                              : undefined
                          }
                        >
                          {cell ?? <span className="text-slate-400">—</span>}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
