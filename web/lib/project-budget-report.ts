import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { subsidiaryVisibleFilter } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import {
  projectBudgetComparison,
  type BudgetComparison,
} from '@openbooks/engine/src/projects/budget-baselines.ts'
import type { Authz } from './authz'
import type { ExportData } from './report-pdf'

/**
 * The Project budget vs actual report: for one project, each task's original
 * (sold) budget, current working budget and actual hours and cost through a
 * date, with the variance against each budget. The figures are the engine's
 * budget comparison; this module selects the projects the reader may see and
 * lays the rows out for screen and export.
 */

export interface ProjectBudgetReportRow {
  key: string
  kind: 'task' | 'unassigned' | 'total'
  task: string
  originalHours: string | null
  currentHours: string
  actualHours: string
  originalCost: string | null
  currentCost: string
  actualCost: string
  varianceToOriginal: string | null
  varianceToCurrent: string | null
  originalPrice: string | null
  currentPrice: string
}

export async function projectBudgetProjectOptions(authz: Authz): Promise<{ id: string; label: string }[]> {
  const rows = (await db.execute<{ id: string; code: string | null; name: string }>(sql`
    select id, code, name from projects
     where org_id = ${authz.user.orgId} and is_active
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds)}
     order by code nulls last, name, id
     limit 2000`)).rows
  return rows.map((row) => ({ id: row.id, label: row.code ? `${row.code} · ${row.name}` : row.name }))
}

/** The comparison laid out as task rows, the unassigned bucket and a total row. */
export function projectBudgetRows(comparison: BudgetComparison, labels: { unassigned: string; total: string }): ProjectBudgetReportRow[] {
  const rows: ProjectBudgetReportRow[] = comparison.rows.map((row) => ({
    key: row.taskId ?? 'task',
    kind: 'task',
    task: row.code ? `${row.code} · ${row.name}` : row.name,
    originalHours: row.original?.hours ?? null,
    currentHours: row.current.hours,
    actualHours: row.actual.hours,
    originalCost: row.original?.cost ?? null,
    currentCost: row.current.cost,
    actualCost: row.actual.cost,
    varianceToOriginal: row.variance.costToOriginal,
    varianceToCurrent: row.variance.costToCurrent,
    originalPrice: row.original?.price ?? null,
    currentPrice: row.current.price,
  }))
  const unassigned = comparison.unassigned
  if (unassigned.hours !== '0.0000' || unassigned.cost !== '0.0000') {
    rows.push({
      key: 'unassigned',
      kind: 'unassigned',
      task: labels.unassigned,
      originalHours: null,
      currentHours: '0.0000',
      actualHours: unassigned.hours,
      originalCost: null,
      currentCost: '0.0000',
      actualCost: unassigned.cost,
      // No budget of its own: the overrun it adds shows in the total row.
      varianceToOriginal: null,
      varianceToCurrent: null,
      originalPrice: null,
      currentPrice: '0.0000',
    })
  }
  const totals = comparison.totals
  rows.push({
    key: 'total',
    kind: 'total',
    task: labels.total,
    originalHours: totals.original?.hours ?? null,
    currentHours: totals.current.hours,
    actualHours: totals.actual.hours,
    originalCost: totals.original?.cost ?? null,
    currentCost: totals.current.cost,
    actualCost: totals.actual.cost,
    varianceToOriginal: totals.variance.costToOriginal,
    varianceToCurrent: totals.variance.costToCurrent,
    originalPrice: totals.original?.price ?? null,
    currentPrice: totals.current.price,
  })
  return rows
}

/** The report as the shared paper/PDF/XLSX/CSV shape. */
export async function projectBudgetExportData(
  authz: Authz,
  p: URLSearchParams,
  period: { to: string },
): Promise<ExportData> {
  const t = await getTranslations('reports.projectBudget')
  const projectParam = p.get('project')
  const options = await projectBudgetProjectOptions(authz)
  const projectId = projectParam && options.some((option) => option.id === projectParam) ? projectParam : null
  const columns = [
    t('columns.task'), t('columns.originalHours'), t('columns.currentHours'), t('columns.actualHours'),
    t('columns.originalCost'), t('columns.currentCost'), t('columns.actualCost'),
    t('columns.varianceToOriginal'), t('columns.varianceToCurrent'),
    t('columns.originalPrice'), t('columns.currentPrice'),
  ]
  if (!projectId) {
    return {
      title: t('title'),
      dateRangeLabel: t('asOf', { date: period.to }),
      summary: [],
      groups: [{ kind: 'results', title: t('chooseProject'), columns, rows: [] }],
    }
  }
  const comparison = await projectBudgetComparison(authz.user.orgId, projectId, {
    asOf: period.to,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  })
  const rows = projectBudgetRows(comparison, { unassigned: t('unassigned'), total: t('total') })
  return {
    title: `${t('title')} — ${comparison.projectName}`,
    dateRangeLabel: t('asOf', { date: comparison.asOf }),
    summary: [
      ...(comparison.price.original !== null ? [{ label: t('summary.originalPrice'), value: comparison.price.original, money: true }] : []),
      { label: t('summary.currentPrice'), value: comparison.price.current, money: true },
      { label: t('summary.invoicedToDate'), value: comparison.price.invoicedToDate ?? '0.0000', money: true },
    ],
    groups: [{
      kind: 'results',
      title: comparison.projectName,
      columns,
      align: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
      money: [false, false, false, false, true, true, true, true, true, true, true],
      rows: rows.map((row) => [
        row.task,
        row.originalHours ?? '',
        row.currentHours,
        row.actualHours,
        row.originalCost ?? '',
        row.currentCost,
        row.actualCost,
        row.varianceToOriginal ?? '',
        row.varianceToCurrent ?? '',
        row.originalPrice ?? '',
        row.currentPrice,
      ]),
    }],
  }
}
