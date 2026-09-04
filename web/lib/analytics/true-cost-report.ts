import 'server-only'
import { requireReportAuthz } from '../report-execution-context'
import { getTranslations } from 'next-intl/server'
import { trueCostData } from './true-cost-data'
import type { ExportData } from '../report-pdf'

/** One output contract for paper, spreadsheet, CSV, PDF and scheduled runs. */
export async function trueCostExportData(orgId: string, period: { from: string; to: string; label: string }): Promise<ExportData> {
  const authz = await requireReportAuthz(orgId)
  const [data, t] = await Promise.all([trueCostData(orgId, period, authz.allowedSubsidiaryIds), getTranslations('analytics.trueCost')])
  return {
    title: t('title'), dateRangeLabel: period.label,
    summary: [
      { label: t('summary.compositeRate'), value: data.kpis.compositeRate, money: true },
      { label: t('summary.periodBurden'), value: data.kpis.totalOverhead, money: true },
      { label: t('summary.billedHours'), value: data.kpis.billedHours },
    ],
    groups: [
      { kind: 'results', title: t('panels.overheadCategories'),
        columns: [t('deptFlyout.colCategory'), t('deptFlyout.colExpense'), t('deptFlyout.colRate')],
        rows: data.categories.map((row) => [row.name, row.totalAmount, row.rateDisplay]),
        money: [false, true, false] },
      { kind: 'results', title: t('panels.rateMatrix'),
        columns: [t('deptFlyout.colCategory'), ...data.departments.map((d) => d.name), t('matrix.colOverall')],
        rows: data.categories.map((row) => [row.name, ...data.departments.map((d) => row.byDept[d.id]?.rate ?? 0), row.rawRate]),
        money: [false, ...data.departments.map(() => true), true] },
      { kind: 'results', title: t('panels.rateByDepartment'),
        columns: [t('selling.departmentFilter'), t('summary.billedHours'), t('summary.compositeRate')],
        rows: data.departments.map((row) => [row.name, row.billedHours, row.composite]), money: [false, false, true] },
      { kind: 'results', title: t('panels.compositeTrend'),
        columns: [t('cards.period'), t('summary.periodBurden'), t('summary.billedHours'), t('summary.compositeRate')],
        rows: data.monthly.map((row) => [row.label, row.burden, row.billedHours, row.rate]), money: [false, true, false, true] },
      { kind: 'results', title: t('panels.unassignedAccounts'),
        columns: [t('cards.accounts'), t('deptFlyout.colExpense')],
        rows: data.unassigned.map((row) => [`${row.number ?? ''} ${row.name}`.trim(), row.amount]), money: [false, true] },
    ],
  }
}
