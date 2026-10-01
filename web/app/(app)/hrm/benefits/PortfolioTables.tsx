import Link from 'next/link'
import { Badge, TableCell, TableRow } from '@openbooks/ui'
import { PreparedPagedTable, type PreparedTableRow } from '../../../../components/prepared-paged-table'
import type { PortfolioAwardRow } from '../../../../lib/hrm/benefits-workspace'

/**
 * Portfolio operational lists over the prepared list sources: the shared
 * PagedTable composition with search and client paging, fed by
 * loader-resolved rows. Statuses render the shared Badge; names link to
 * their drawers. A truncated service window names itself in the footer —
 * the footer carries the true population beside the visible page, never a
 * silent first page pretending to be everything.
 */

import { ListFilterSelect } from '../../../../components/list-filter-select'
import type { UnifiedProgramRow, AwardTableText, ProgramTableText } from '../../../../lib/hrm/benefits-portfolio'

export type { AwardTableText, ProgramTableText }

function programCells(row: UnifiedProgramRow): PreparedTableRow {
  return {
    id: row.id,
    searchText: `${row.code} ${row.name} ${row.familyLabel} ${row.statusLabel}`,
    cells: [
      <Link
        key="name"
        href={row.programHref as never}
        className="font-medium text-teal-700 underline-offset-2 hover:underline dark:text-teal-300"
      >
        {row.name}
      </Link>,
      row.familyLabel,
      <span key="value" className="tabular-nums">
        {row.valueLabel}
      </span>,
      <span key="effective" className="tabular-nums">
        {row.effectiveTo ? `${row.effectiveFrom} – ${row.effectiveTo}` : `${row.effectiveFrom} – …`}
      </span>,
      <Badge key="status" variant={row.statusVariant}>
        {row.statusLabel}
      </Badge>,
    ],
  }
}

function awardCells(row: PortfolioAwardRow): PreparedTableRow {
  return {
    id: row.id,
    searchText: `${row.programCode} ${row.programName} ${row.recipientLabel} ${row.statusLabel}`,
    cells: [
      row.programCode,
      <Link
        key="recipient"
        href={row.awardHref as never}
        className="font-medium text-teal-700 underline-offset-2 hover:underline dark:text-teal-300"
      >
        {row.recipientLabel}
      </Link>,
      <span key="period" className="tabular-nums">
        {row.periodTo ? `${row.periodFrom} – ${row.periodTo}` : row.periodFrom}
      </span>,
      <span key="value" className="tabular-nums">
        {row.valueLabel}
      </span>,
      <Badge key="status" variant={row.statusVariant}>
        {row.statusLabel}
      </Badge>,
    ],
  }
}

function emptyBlock(title: string, description: string) {
  return (
    <div>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  )
}

function footerBlock(totalLabel: string, total: number, truncatedLabel: string, truncated: boolean) {
  return (
    <TableRow>
      <TableCell colSpan={5} className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
        {totalLabel} · {total}
        {truncated ? ` · ${truncatedLabel}` : ''}
      </TableCell>
    </TableRow>
  )
}

export function ProgramPortfolioTable({
  rows,
  text,
  total,
  truncated,
  typeFilter,
}: {
  rows: UnifiedProgramRow[]
  text: ProgramTableText
  total: number
  truncated: boolean
  typeFilter?: { label: string; allLabel: string; options: { value: string; label: string }[]; currentParams: Record<string, string | undefined> }
}) {
  return (
    <PreparedPagedTable
      source="hrm_benefit_programs"
      rows={rows.map(programCells)}
      toolbarAfter={typeFilter ? <ListFilterSelect basePath="/hrm/benefits" currentParams={typeFilter.currentParams} paramKey="type" label={typeFilter.label} allLabel={typeFilter.allLabel} options={typeFilter.options} /> : undefined}
      columns={[
        { key: 'program', header: text.program },
        { key: 'family', header: text.family },
        { key: 'value', header: text.value, align: 'right', className: 'tabular-nums' },
        { key: 'effective', header: text.effective, className: 'tabular-nums' },
        { key: 'status', header: text.status },
      ]}
      empty={emptyBlock(text.emptyTitle, text.emptyDescription)}
      footer={footerBlock(text.totalLabel, total, text.truncatedLabel, truncated)}
    />
  )
}

export function AwardPortfolioTable({
  rows,
  text,
  total,
  truncated,
}: {
  rows: PortfolioAwardRow[]
  text: AwardTableText
  total: number
  truncated: boolean
}) {
  return (
    <PreparedPagedTable
      source="hrm_benefit_awards"
      rows={rows.map(awardCells)}
      columns={[
        { key: 'program', header: text.program },
        { key: 'recipient', header: text.recipient },
        { key: 'period', header: text.period, className: 'tabular-nums' },
        { key: 'value', header: text.value, align: 'right', className: 'tabular-nums' },
        { key: 'status', header: text.status },
      ]}
      empty={emptyBlock(text.emptyTitle, text.emptyDescription)}
      footer={footerBlock(text.totalLabel, total, text.truncatedLabel, truncated)}
    />
  )
}
