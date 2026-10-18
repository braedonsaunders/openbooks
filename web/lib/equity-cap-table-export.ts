import type { CapTableView } from '@openbooks/engine/equity'
import type { ExportData } from './report-pdf'

export type CapTableExportFormat = 'pdf' | 'xlsx' | 'csv'
export type CapTableExportBasis = 'class' | 'holder'

export interface CapTableExportLabels {
  title: string
  dateRange: string
  class: string
  kind: (kind: 'common' | 'preferred') => string
  holder: string
  authorized: string
  outstanding: string
  asConverted: string
  awards: string
  pool: string
  fullyDiluted: string
  outstandingPercent: string
  fullyDilutedPercent: string
  options: string
  rsus: string
  warrants: string
  totalOutstanding: string
  totalFullyDiluted: string
  poolUnallocated: string
}

export function capTableExportHref(subsidiaryId: string, asOf: string, by: CapTableExportBasis): string {
  const query = new URLSearchParams({ subsidiaryId, asOf, by })
  return `/api/equity/cap-table/export?${query}`
}

/**
 * The as-of cap table as export data, on the basis the page shows: by class
 * (authorized, outstanding, as converted, awards, pool, fully diluted and
 * ownership) or by holder (shares per class, awards and ownership). Share
 * counts and percentages travel as the exact strings the engine computed;
 * nothing crosses a float.
 */
export function capTableExportData(view: CapTableView, by: CapTableExportBasis, labels: CapTableExportLabels): ExportData {
  const { table } = view
  const summary = [
    { label: labels.totalOutstanding, value: table.totals.outstanding },
    { label: labels.totalFullyDiluted, value: table.totals.fullyDiluted },
    { label: labels.poolUnallocated, value: table.totals.poolAvailable },
  ]
  if (by === 'class') {
    return {
      title: labels.title,
      dateRangeLabel: labels.dateRange,
      summary,
      groups: [{
        kind: 'results',
        title: labels.title,
        columns: [labels.class, labels.authorized, labels.outstanding, labels.asConverted, labels.awards, labels.pool, labels.fullyDiluted, labels.outstandingPercent, labels.fullyDilutedPercent],
        rows: table.classes.map((row) => [
          `${row.code} · ${row.name} (${labels.kind(row.kind)})`, row.authorized, row.outstanding, row.asConvertedOutstanding,
          row.awardsOutstanding, row.poolAvailable, row.fullyDiluted, `${row.outstandingPercent}%`, `${row.fullyDilutedPercent}%`,
        ]),
        align: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
      }],
    }
  }
  return {
    title: labels.title,
    dateRangeLabel: labels.dateRange,
    summary,
    groups: [{
      kind: 'results',
      title: labels.title,
      columns: [labels.holder, ...table.classes.map((row) => row.code), labels.options, labels.rsus, labels.warrants, labels.fullyDiluted, labels.outstandingPercent, labels.fullyDilutedPercent],
      rows: table.holders.map((row) => [
        view.parties[row.holderPartyId] ?? row.holderPartyId,
        ...table.classes.map((shareClass) => row.sharesByClass[shareClass.shareClassId] ?? '0'),
        row.options, row.rsus, row.warrants, row.fullyDiluted, `${row.outstandingPercent}%`, `${row.fullyDilutedPercent}%`,
      ]),
      align: ['left', ...table.classes.map(() => 'right' as const), 'right', 'right', 'right', 'right', 'right', 'right'],
    }],
  }
}
