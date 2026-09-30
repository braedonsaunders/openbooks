import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "../../reports/ReportTable"
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
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <SharedTable className="w-full text-sm">
        <SharedTableHeader>
          <SharedTableRow className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <SharedTableHead className="px-4 py-2 font-medium">{columns.fiscalYear}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 font-medium">{columns.version}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 font-medium">{columns.status}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 text-right font-medium">{columns.totalExpense}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 text-right font-medium">{columns.effectiveRate}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 font-medium">{columns.created}</SharedTableHead>
          </SharedTableRow>
        </SharedTableHeader>
        <SharedTableBody>
          {rows.length === 0 ? (
            <SharedTableRow>
              <SharedTableCell colSpan={6} className="px-4 py-10 text-center text-slate-400 italic">
                {emptyText}
              </SharedTableCell>
            </SharedTableRow>
          ) : (
            rows.map((row) => (
              <SharedTableRow
                key={row.id}
                className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
              >
                <SharedTableCell className="px-4 py-2.5">
                  <a
                    className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                    href={row.href}
                  >
                    {row.fiscalYearLabel}
                  </a>
                </SharedTableCell>
                <SharedTableCell className="px-4 py-2.5 tabular-nums">{row.versionLabel}</SharedTableCell>
                <SharedTableCell className="px-4 py-2.5">
                  <Badge variant={row.statusVariant}>{row.statusLabel}</Badge>
                </SharedTableCell>
                <SharedTableCell className="px-4 py-2.5 text-right tabular-nums">{row.totalExpense}</SharedTableCell>
                <SharedTableCell className="px-4 py-2.5 text-right tabular-nums">{row.effectiveRateText}</SharedTableCell>
                <SharedTableCell className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{row.created}</SharedTableCell>
              </SharedTableRow>
            ))
          )}
        </SharedTableBody>
      </SharedTable>
    </div>
  )
}
