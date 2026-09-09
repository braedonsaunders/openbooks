import { Badge, cn } from '@openbooks/ui'
import { ReportDrillLink } from './ReportDrillLink'
import { Table, TableBody, TableCell, TableRow } from './ReportTable'
import type { ReportDrillTarget } from '../../../lib/report-drill'

/**
 * A two-column statement body whose rows are HETEROGENEOUS: section headings,
 * indented lines, subtotals, totals and placeholders, in whatever order the
 * statement calls for.
 *
 * The `table` block deliberately models a uniform column set over a
 * collection, which is the right shape for a list and the wrong shape for this.
 * Rather than grow the block vocabulary with row-kind unions — reinventing a
 * statement renderer badly — the loader flattens the statement into an ordered
 * row list and this component renders it. Same call as the statement matrix.
 *
 * Shared deliberately: cash flow (direct), cash flow (indirect) and trial
 * balance all have this shape, so a per-page component would be three copies.
 */

export interface StatementRow {
  key: string
  /** A full-width row (section heading, placeholder) — no value column. */
  span?: boolean
  label: string
  labelClassName?: string
  value?: string
  valueClassName?: string
  /** Named presentation state decided by the loader, never a comparison here. */
  tone?: 'default' | 'negative'
  drill?: ReportDrillTarget
  rowClassName?: string
}

const TONE_CLASS = 'text-red-600 dark:text-red-400'
const LINK_CLASS = 'hover:text-teal-700 hover:underline dark:hover:text-teal-300'

export function StatementRows({ rows }: { rows: StatementRow[] }) {
  return (
    <Table>
      <TableBody>
        {rows.map((row) => {
          if (row.span) {
            return (
              <TableRow key={row.key} className={row.rowClassName}>
                <TableCell colSpan={2} className={row.labelClassName}>
                  {row.label}
                </TableCell>
              </TableRow>
            )
          }
          const value = row.value ?? ''
          return (
            <TableRow key={row.key} className={row.rowClassName}>
              <TableCell className={row.labelClassName}>{row.label}</TableCell>
              <TableCell className={cn(row.valueClassName, row.tone === 'negative' && TONE_CLASS)}>
                {row.drill ? (
                  <ReportDrillLink target={row.drill} className={LINK_CLASS}>
                    {value}
                  </ReportDrillLink>
                ) : (
                  value
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** The "reconciled / off by X" chip some statements show under the filter bar. */
export function ReconciliationNote({
  label,
  status,
  reconciled,
}: {
  label: string
  status: string
  reconciled: boolean
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span>{label}</span>
      <Badge variant={reconciled ? 'success' : 'destructive'}>{status}</Badge>
    </div>
  )
}
