import type { ReactNode } from 'react'
import Link from 'next/link'
import { ListDrawerLink } from '../../../../components/list-drawer-link'
import { useTranslations } from 'next-intl'
import { Badge } from '@openbooks/ui'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import type { PortfolioAwardRow } from '../../../../lib/hrm/benefits-workspace'

/**
 * Portfolio operational lists over the prepared list sources: the shared
 * PagedTable composition with search and client paging, fed by
 * loader-resolved rows. Record counts use the shared pagination summary;
 * a truncated service window retains its population notice outside rows.
 */

import { ListFilterSelect } from '../../../../components/list-filter-select'
import type { UnifiedProgramRow, AwardTableText, ProgramTableText } from '../../../../lib/hrm/benefits-portfolio'

export type { AwardTableText, ProgramTableText }

/** Closed ranges read "from – to"; an open-ended range reads "From <date>". */
export function useEffectiveRangeLabel(): (from: string | null, to: string | null) => string {
  const t = useTranslations('hrm')
  return (from, to) => from === null || from === '' ? '—' : to ? `${from} – ${to}` : t('portfolio.effectiveOpen', { date: from })
}

function programColumns(
  text: ProgramTableText,
  effectiveRange: (from: string | null, to: string | null) => string,
): PagedColumn<UnifiedProgramRow>[] {
  return [
    {
      key: 'program',
      header: text.program,
      cell: (row) => (
        <ListDrawerLink
          href={row.programHref as never}
          className="font-medium text-teal-700 underline-offset-2 hover:underline dark:text-teal-300"
        >
          {row.name}
        </ListDrawerLink>
      ),
    },
    { key: 'family', header: text.family, cell: (row) => row.familyLabel },
    {
      key: 'value',
      header: text.value,
      align: 'right',
      className: 'tabular-nums',
      cell: (row) => <span className="tabular-nums">{row.valueLabel}</span>,
    },
    {
      key: 'effective',
      header: text.effective,
      className: 'whitespace-nowrap tabular-nums',
      cell: (row) => (
        <span className="whitespace-nowrap tabular-nums">
          {effectiveRange(row.effectiveFrom, row.effectiveTo)}
        </span>
      ),
    },
    {
      key: 'status',
      header: text.status,
      cell: (row) => <Badge variant={row.statusVariant}>{row.statusLabel}</Badge>,
    },
  ]
}

function awardColumns(text: AwardTableText): PagedColumn<PortfolioAwardRow>[] {
  return [
    { key: 'program', header: text.program, cell: (row) => row.programCode },
    {
      key: 'recipient',
      header: text.recipient,
      cell: (row) => (
        <Link
          href={row.awardHref as never}
          className="font-medium text-teal-700 underline-offset-2 hover:underline dark:text-teal-300"
        >
          {row.recipientLabel}
        </Link>
      ),
    },
    {
      key: 'period',
      header: text.period,
      className: 'whitespace-nowrap tabular-nums',
      cell: (row) => (
        <span className="tabular-nums">
          {row.periodTo ? `${row.periodFrom} – ${row.periodTo}` : row.periodFrom}
        </span>
      ),
    },
    {
      key: 'value',
      header: text.value,
      align: 'right',
      className: 'tabular-nums',
      cell: (row) => <span className="tabular-nums">{row.valueLabel}</span>,
    },
    {
      key: 'status',
      header: text.status,
      cell: (row) => <Badge variant={row.statusVariant}>{row.statusLabel}</Badge>,
    },
  ]
}

function emptyBlock(title: string, description: string) {
  return (
    <div>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  )
}

export function ProgramPortfolioTable({
  rows,
  text,
  total,
  truncated,
  typeFilter,
  statusFilter,
}: {
  rows: UnifiedProgramRow[]
  text: ProgramTableText
  total: number
  truncated: boolean
  typeFilter?: { label: string; allLabel: string; options: { value: string; label: string }[]; currentParams: Record<string, string | undefined> }
  statusFilter?: { label: string; allLabel: string; options: { value: string; label: string }[]; currentParams: Record<string, string | undefined> }
}) {
  const effectiveRange = useEffectiveRangeLabel()
  return (
    <PagedTable
      prepared
      searchable
      source="hrm_benefit_programs"
      rows={rows}
      rowKey={(row) => row.id}
      searchText={(row) => `${row.code} ${row.name} ${row.familyLabel} ${row.statusLabel}`}
      toolbarAfter={typeFilter || statusFilter ? <>
        {typeFilter ? <ListFilterSelect basePath="/hrm/benefits" currentParams={typeFilter.currentParams} paramKey="type" label={typeFilter.label} allLabel={typeFilter.allLabel} options={typeFilter.options} /> : null}
        {statusFilter ? <ListFilterSelect basePath="/hrm/benefits" currentParams={statusFilter.currentParams} paramKey="status" label={statusFilter.label} allLabel={statusFilter.allLabel} options={statusFilter.options} /> : null}
      </> : undefined}
      columns={programColumns(text, effectiveRange)}
      empty={emptyBlock(text.emptyTitle, text.emptyDescription)}
      paginationNote={truncated ? `${text.truncatedLabel} · ${text.totalLabel} ${total}` : undefined}
    />
  )
}

export function AwardPortfolioTable({
  rows,
  text,
  total,
  truncated,
  toolbarAfter,
}: {
  rows: PortfolioAwardRow[]
  text: AwardTableText
  total: number
  truncated: boolean
  /** Controls sharing the search row, e.g. a drawer's period picker. */
  toolbarAfter?: ReactNode
}) {
  return (
    <PagedTable
      prepared
      searchable
      source="hrm_benefit_awards"
      rows={rows}
      rowKey={(row) => row.id}
      searchText={(row) => `${row.programCode} ${row.programName} ${row.recipientLabel} ${row.statusLabel}`}
      toolbarAfter={toolbarAfter}
      columns={awardColumns(text)}
      empty={emptyBlock(text.emptyTitle, text.emptyDescription)}
      paginationNote={truncated ? `${text.truncatedLabel} · ${text.totalLabel} ${total}` : undefined}
    />
  )
}

/** Cross-program delivery uses one queue for grants and native payroll benefit movements. */
export function BenefitDeliveryTable({ rows, text }: { rows: import('../../../../lib/hrm/benefits-portfolio').BenefitDeliveryRow[]; text: AwardTableText }) {
  return <PagedTable prepared searchable source="hrm_benefit_program_activity" rows={rows} rowKey={row => row.id}
    searchText={row => `${row.programName} ${row.employeeName} ${row.statusLabel}`}
    columns={[
      { key: 'program', header: text.program, cell: row => <Link href={row.programHref as never} className="font-medium text-teal-700 hover:underline">{row.programName}</Link> },
      { key: 'employee', header: text.recipient, cell: row => <Link href={row.employeeHref as never} className="text-teal-700 hover:underline">{row.employeeName}</Link> },
      { key: 'date', header: text.period, cell: row => <span className="tabular-nums">{row.onDate}</span> },
      { key: 'amount', header: text.value, align: 'right', cell: row => <span className="tabular-nums">{row.valueLabel}</span> },
      { key: 'status', header: text.status, cell: row => <Badge variant={row.statusVariant}>{row.statusLabel}</Badge> },
      { key: 'record', header: '', cell: row => row.recordHref ? <Link href={row.recordHref as never} className="text-teal-700 hover:underline">{row.recordLabel}</Link> : '—' },
    ]} empty={emptyBlock(text.emptyTitle,text.emptyDescription)} />
}
