import type { ExportData } from './report-pdf'

/** CSV has no paper header, so its accounting basis travels with each row. */
export function withReportBookColumn(data: ExportData, book: { label: string; value: string }): ExportData {
  return { ...data, groups: data.groups.map((group) => ({
    ...group,
    columns: [book.label, ...group.columns],
    rows: group.rows.map((row) => [book.value, ...row]),
    ...(group.money ? { money: [false, ...group.money] } : {}),
    ...(group.align ? { align: ['left' as const, ...group.align] } : {}),
  })) }
}
