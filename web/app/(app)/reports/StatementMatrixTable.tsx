import Link from 'next/link'
import { cn } from '@openbooks/ui'
import type { StatementView } from '../../../lib/statement-matrix'
import type { StatementBasis, StatementDimFilter } from '../../../lib/statement-matrix'
import { buildDrillHref, type ReportScale } from '../../../lib/report-filters'
import { currencySymbol, formatCell, isNegative } from '../../../lib/statement-format'

/**
 * Renders a multi-column statement view (P&L, Balance Sheet, …) as a clean,
 * paper-style statement — no card chrome, no zebra: just a ruled header, section
 * headings, indented account rows, and bold subtotal/total rows with a rule
 * above (double rule below the grand total). The currency symbol shows on the
 * first row and on total rows (GAAP convention). Every amount drills through.
 */
export function StatementMatrixTable({
  view,
  scale = 'actual',
  currency,
  drill,
}: {
  view: StatementView
  scale?: ReportScale
  /** Currency code (e.g. 'CAD') → symbol shown on first + total rows. */
  currency?: string
  drill?: { dims: StatementDimFilter; basis: StatementBasis; back: string; backLabel: string }
}) {
  const cols = view.columns
  const sym = currencySymbol(currency)
  let firstAmountShown = false

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="border-b border-slate-300 dark:border-slate-600">
            <th className="min-w-[16rem] py-2 pr-4 text-left font-semibold text-slate-500 dark:text-slate-400" />
            {cols.map((c) => (
              <th
                key={c.key}
                className={cn(
                  'py-2 pl-4 text-right font-semibold whitespace-nowrap',
                  c.kind === 'amount' ? 'text-slate-600 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500',
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.lines.map((l, i) => {
            if (l.kind === 'section') {
              return (
                <tr key={i}>
                  <td
                    colSpan={cols.length + 1}
                    className="pt-4 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
                  >
                    {l.label}
                  </td>
                </tr>
              )
            }
            const isSub = l.kind === 'subtotal'
            const isTotal = l.kind === 'total'
            const isTotalish = isSub || isTotal
            const weight = isTotal || l.emphasis ? 'font-semibold text-slate-900 dark:text-slate-100' : isSub ? 'font-medium' : ''
            const showSym = isTotalish || !firstAmountShown
            if (l.values?.some((v) => typeof v === 'number')) firstAmountShown = true

            return (
              <tr
                key={i}
                className={cn(
                  isTotalish && '[&>td]:border-t [&>td]:border-slate-300 dark:[&>td]:border-slate-600',
                  isTotal && '[&>td]:border-b-[3px] [&>td]:border-double [&>td]:border-slate-400 dark:[&>td]:border-slate-500',
                )}
              >
                <td
                  className={cn(
                    'py-1 pr-4',
                    weight,
                    l.depth === 1 && 'pl-6',
                    l.depth === 2 && 'pl-10',
                    l.depth >= 3 && 'pl-14',
                  )}
                >
                  {l.kind === 'account' && l.accountId ? (
                    <Link href={`/accounts/${l.accountId}`} className="hover:text-teal-700 dark:hover:text-teal-300">
                      {l.number && <span className="mr-1.5 font-mono text-xs text-slate-400 dark:text-slate-500">{l.number}</span>}
                      {l.label}
                    </Link>
                  ) : (
                    l.label
                  )}
                </td>
                {cols.map((c, ci) => {
                  const v = l.values?.[ci]
                  const href =
                    drill && v !== undefined
                      ? buildDrillHref({
                          accountId: l.accountId,
                          drillTypes: l.drillTypes,
                          column: c,
                          mode: view.mode,
                          reportDims: drill.dims,
                          basis: drill.basis,
                          back: drill.back,
                          backLabel: drill.backLabel,
                          label: `${l.label} · ${c.label}`,
                        })
                      : null
                  const neg = v !== undefined && isNegative(v, c.kind)
                  const text = v === undefined ? '' : formatCell(v, c.kind, scale, c.kind === 'amount' && showSym ? sym : '')
                  return (
                    <td
                      key={c.key}
                      className={cn('py-1 pl-4 text-right whitespace-nowrap', weight, neg && 'text-red-600 dark:text-red-400')}
                    >
                      {href ? (
                        <Link href={href} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">
                          {text}
                        </Link>
                      ) : (
                        text
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
