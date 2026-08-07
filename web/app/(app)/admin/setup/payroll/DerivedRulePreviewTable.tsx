'use client'

import { TableCell, TableRow } from '@openbooks/ui'
import { PagedTable } from '../../../../../components/paged-table'
import { useMoney } from '../../../../../components/money-provider'

/**
 * The rows a derived earnings rule WOULD pay over a period — one line per
 * employee per day, exactly the facts the pay run would price. Rendered with
 * the shared PagedTable so this reads like every other table in the product.
 */

export interface PreviewRow {
  employeePartyId: string
  employeeName: string
  jobTitle: string | null
  day: string
  quantity: string
  amount: string
  projectId: string | null
  projectName: string | null
}

export function DerivedRulePreviewTable({
  rows,
  total,
  labels,
}: {
  rows: PreviewRow[]
  /** Exact engine total — never re-summed here, floats do not add up money. */
  total: string
  labels: {
    employee: string
    jobTitle: string
    day: string
    project: string
    quantity: string
    amount: string
    total: string
    empty: string
  }
}) {
  const { money } = useMoney()

  return (
    <PagedTable
      rows={rows}
      rowKey={(row, index) => `${row.employeePartyId}-${row.day}-${row.projectId ?? ''}-${index}`}
      pageSize={25}
      searchable
      empty={<p className="p-4 text-sm text-slate-500 dark:text-slate-400">{labels.empty}</p>}
      columns={[
        {
          key: 'employee',
          header: labels.employee,
          cell: (row) => row.employeeName,
          search: (row) => row.employeeName,
        },
        {
          key: 'jobTitle',
          header: labels.jobTitle,
          cell: (row) => row.jobTitle ?? '—',
          search: (row) => row.jobTitle ?? '',
        },
        { key: 'day', header: labels.day, cell: (row) => row.day, search: (row) => row.day },
        {
          key: 'project',
          header: labels.project,
          cell: (row) => row.projectName ?? '—',
          search: (row) => row.projectName ?? '',
        },
        {
          key: 'quantity',
          header: labels.quantity,
          align: 'right',
          cell: (row) => Number(row.quantity).toLocaleString('en-US', { maximumFractionDigits: 2 }),
        },
        { key: 'amount', header: labels.amount, align: 'right', cell: (row) => money(row.amount) },
      ]}
      footer={
        <TableRow className="font-medium">
          <TableCell colSpan={5}>{labels.total}</TableCell>
          <TableCell className="text-right tabular-nums">{money(total)}</TableCell>
        </TableRow>
      }
    />
  )
}
