import Link from 'next/link'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import type { StatementView } from '../../../lib/statement-matrix'
import type { StatementBasis, StatementDimFilter } from '../../../lib/statement-matrix'
import { buildDrillHref, type ReportScale } from '../../../lib/report-filters'
import { formatCell, isNegative } from '../../../lib/statement-format'

/**
 * Renders a multi-column statement view (P&L, Balance Sheet, …) as a table:
 * account rows indented by depth and linked to their register, section headers,
 * subtotals with a top rule, and grand totals in bold with a double rule.
 *
 * When `drill` is supplied, EVERY amount value becomes a link to the journal
 * lines behind it (account subtree or section types × the column's period /
 * dimension / basis), carrying a `back` link to this exact report.
 */
export function StatementMatrixTable({
  view,
  scale = 'actual',
  periodQs = '',
  drill,
}: {
  view: StatementView
  scale?: ReportScale
  /** Query string appended to account-name drill-through links. */
  periodQs?: string
  /** Enables per-value drill-through to /reports/detail. */
  drill?: { dims: StatementDimFilter; basis: StatementBasis; back: string; backLabel: string }
}) {
  const cols = view.columns
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-[16rem]" />
            {cols.map((c) => (
              <TableHead
                key={c.key}
                className={cn(
                  'text-right whitespace-nowrap tabular-nums',
                  c.kind !== 'amount' && 'text-slate-500 dark:text-slate-400',
                )}
              >
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.lines.map((l, i) => {
            if (l.kind === 'section') {
              return (
                <TableRow key={i}>
                  <TableCell
                    colSpan={cols.length + 1}
                    className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-900 dark:text-slate-300"
                  >
                    {l.label}
                  </TableCell>
                </TableRow>
              )
            }
            const isTotal = l.kind === 'subtotal' || l.kind === 'total'
            const weight = l.kind === 'total' || l.emphasis ? 'font-bold' : isTotal ? 'font-semibold' : ''
            const topRule = isTotal ? 'border-t border-slate-300 dark:border-slate-600' : ''
            const doubleRule = l.kind === 'total' ? 'border-b-[3px] border-double border-slate-400 dark:border-slate-500' : ''
            return (
              <TableRow key={i} className={cn(topRule, doubleRule)}>
                <TableCell
                  className={cn(
                    weight,
                    l.depth === 1 && 'pl-8',
                    l.depth >= 2 && 'pl-12',
                    l.kind === 'account' && !l.depth && 'pl-4',
                  )}
                >
                  {l.kind === 'account' && l.accountId ? (
                    <Link href={`/accounts/${l.accountId}${periodQs}`} className="hover:text-teal-700 dark:hover:text-teal-300">
                      {l.number && <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{l.number}</span>}
                      {l.label}
                    </Link>
                  ) : (
                    l.label
                  )}
                </TableCell>
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
                  return (
                    <TableCell
                      key={c.key}
                      className={cn('text-right whitespace-nowrap tabular-nums', weight, neg && 'text-red-600 dark:text-red-400')}
                    >
                      {v === undefined ? (
                        ''
                      ) : href ? (
                        <Link href={href} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">
                          {formatCell(v, c.kind, scale)}
                        </Link>
                      ) : (
                        formatCell(v, c.kind, scale)
                      )}
                    </TableCell>
                  )
                })}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
