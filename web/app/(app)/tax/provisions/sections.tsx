import { RegisteredListTable } from '../../../../components/registered-list-table'
import { Badge } from '@openbooks/ui'

/** Native record cells and actions compose the shared table primitives. */

export interface ProvisionRunListColumns {
  fiscalYear: string
  version: string
  status: string
  totalExpense: string
  effectiveRate: string
  created: string
}

export interface ProvisionRunListRow {
  id: string
  href: string
  fiscalYearLabel: string
  versionLabel: string
  statusLabel: string
  statusVariant: 'success' | 'secondary' | 'outline'
  totalExpense: string
  effectiveRateText: string
  created: string
}

export function ProvisionRunsTable({
  columns,
  emptyText,
  rows,
}: {
  columns: ProvisionRunListColumns
  emptyText: string
  rows: ProvisionRunListRow[]
}) {
  return (
    <RegisteredListTable
      source="tax_provisions"
      rows={rows}
      rowKey={(row) => row.id}
      empty={emptyText}
      rowClassName={() =>
        'border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40'
      }
      columns={[
        {
          key: 'column_0',
          header: <>{columns.fiscalYear}</>,
          headerClassName: 'px-4 py-2 font-medium',
          className: 'px-4 py-2.5',
          cell: (row) => (
            <>
              <a
                className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                href={row.href}
              >
                {row.fiscalYearLabel}
              </a>
            </>
          ),
          search: (row) =>
            Object.values(row)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_1',
          header: <>{columns.version}</>,
          headerClassName: 'px-4 py-2 font-medium',
          className: 'px-4 py-2.5 tabular-nums',
          cell: (row) => <>{row.versionLabel}</>,
          search: (row) =>
            Object.values(row)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_2',
          header: <>{columns.status}</>,
          headerClassName: 'px-4 py-2 font-medium',
          className: 'px-4 py-2.5',
          cell: (row) => (
            <>
              <Badge variant={row.statusVariant}>{row.statusLabel}</Badge>
            </>
          ),
          search: (row) =>
            Object.values(row)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_3',
          header: <>{columns.totalExpense}</>,
          headerClassName: 'px-4 py-2 text-right font-medium',
          className: 'px-4 py-2.5 text-right tabular-nums',
          cell: (row) => <>{row.totalExpense}</>,
          search: (row) =>
            Object.values(row)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_4',
          header: <>{columns.effectiveRate}</>,
          headerClassName: 'px-4 py-2 text-right font-medium',
          className: 'px-4 py-2.5 text-right tabular-nums',
          cell: (row) => <>{row.effectiveRateText}</>,
          search: (row) =>
            Object.values(row)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
        {
          key: 'column_5',
          header: <>{columns.created}</>,
          headerClassName: 'px-4 py-2 font-medium',
          className: 'px-4 py-2.5 text-slate-500 dark:text-slate-400',
          cell: (row) => <>{row.created}</>,
          search: (row) =>
            Object.values(row)
              .filter(
                (value) =>
                  typeof value === 'string' || typeof value === 'number',
              )
              .join(' '),
        },
      ]}
    />
  )
}
