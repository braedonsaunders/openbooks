import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { earnedValueByProject, type ProjectEarnedValue } from '@openbooks/engine/src/projects/earned-value.ts'
import { roundDecimal } from '@openbooks/engine/src/projects/earned-value-math.ts'
import type { Authz } from './authz'
import type { ExportData } from './report-pdf'
import { pgTextArrayLiteral } from './pg-array'

/**
 * The Earned value report: per project and task as of a date — budget at
 * completion, percent complete and its basis, earned value, actual cost, CPI,
 * estimate to complete, estimate at completion and variance at completion.
 * The figures are the earned-value engine's; this module only selects the
 * projects the reader may see and lays the rows out for screen and export.
 */

export interface EarnedValueReportRow {
  key: string
  kind: 'project' | 'task'
  projectId: string
  project: string
  /** Null on the project total row. */
  task: string | null
  basis: ProjectEarnedValue['tasks'][number]['basis'] | null
  percentComplete: string | null
  budgetAtCompletion: string
  earnedValue: string
  actualCost: string
  costPerformanceIndex: string | null
  estimateToComplete: string
  estimateAtCompletion: string
  varianceAtCompletion: string
}

export async function earnedValueProjectOptions(authz: Authz): Promise<{ id: string; label: string }[]> {
  const allowed = authz.allowedSubsidiaryIds
  const scope = allowed === null
    ? sql``
    : allowed.size === 0
      ? sql`and false`
      : sql`and subsidiary_id = any(${pgTextArrayLiteral([...allowed])}::uuid[])`
  const rows = (await db.execute<{ id: string; code: string | null; name: string }>(sql`
    select id, code, name from projects
     where org_id = ${authz.user.orgId} and is_active ${scope}
     order by code nulls last, name, id
     limit 2000`)).rows
  return rows.map((row) => ({ id: row.id, label: row.code ? `${row.code} · ${row.name}` : row.name }))
}

/** Earned value for the selected project (or every active project) the reader may see. */
export async function earnedValueReport(
  authz: Authz,
  input: { asOf: string; projectId?: string; search?: string },
): Promise<{ projects: ProjectEarnedValue[]; rows: EarnedValueReportRow[] }> {
  const projects = await earnedValueByProject(authz.user.orgId, {
    asOf: input.asOf,
    projectIds: input.projectId ? [input.projectId] : undefined,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    activeOnly: !input.projectId,
  })
  const search = input.search?.trim().toLocaleLowerCase() ?? ''
  const label = (code: string | null, name: string) => (code ? `${code} · ${name}` : name)
  const rows = projects.flatMap((project): EarnedValueReportRow[] => {
    const projectLabel = label(project.projectCode, project.projectName)
    const tasks = project.tasks.filter((task) =>
      !search || projectLabel.toLocaleLowerCase().includes(search) || label(task.code, task.name).toLocaleLowerCase().includes(search))
    if (search && tasks.length === 0) return []
    return [
      {
        key: project.projectId,
        kind: 'project' as const,
        projectId: project.projectId,
        project: projectLabel,
        task: null,
        basis: null,
        percentComplete: project.totals.percentComplete,
        budgetAtCompletion: project.totals.budgetAtCompletion,
        earnedValue: project.totals.earnedValue,
        actualCost: project.totals.actualCost,
        costPerformanceIndex: project.totals.costPerformanceIndex,
        estimateToComplete: project.totals.estimateToComplete,
        estimateAtCompletion: project.totals.estimateAtCompletion,
        varianceAtCompletion: project.totals.varianceAtCompletion,
      },
      ...tasks.map((task) => ({
        key: `${project.projectId}:${task.taskId}`,
        kind: 'task' as const,
        projectId: project.projectId,
        project: projectLabel,
        task: label(task.code, task.name),
        basis: task.basis,
        percentComplete: task.percentComplete,
        budgetAtCompletion: task.budgetAtCompletion,
        earnedValue: task.earnedValue,
        actualCost: task.actualCost,
        costPerformanceIndex: task.costPerformanceIndex,
        estimateToComplete: task.estimateToComplete,
        estimateAtCompletion: task.estimateAtCompletion,
        varianceAtCompletion: task.varianceAtCompletion,
      })),
    ]
  })
  return { projects, rows }
}

export const ratio = (value: string | null, places: number): string => (value == null ? '—' : roundDecimal(value, places))

/** The report as the shared paper/PDF/XLSX/CSV shape. */
export async function earnedValueExportData(
  authz: Authz,
  p: URLSearchParams,
  period: { to: string },
): Promise<ExportData> {
  const t = await getTranslations('reports.earnedValue')
  const projectParam = p.get('project')
  const projectId = projectParam && /^[0-9a-f-]{36}$/i.test(projectParam) ? projectParam : undefined
  const { rows } = await earnedValueReport(authz, { asOf: period.to, projectId, search: p.get('q') ?? undefined })
  return {
    title: t('title'),
    dateRangeLabel: t('asOf', { date: period.to }),
    summary: [],
    groups: [{
      kind: 'results',
      title: t('title'),
      columns: [
        t('columns.project'), t('columns.task'), t('columns.basis'), t('columns.percent'), t('columns.bac'),
        t('columns.ev'), t('columns.ac'), t('columns.cpi'), t('columns.etc'), t('columns.eac'), t('columns.vac'),
      ],
      align: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
      money: [false, false, false, false, true, true, true, false, true, true, true],
      rows: rows.map((row) => [
        row.project,
        row.task ?? t('projectTotal'),
        row.basis ? t(`basis.${row.basis}`) : '',
        ratio(row.percentComplete, 1),
        row.budgetAtCompletion,
        row.earnedValue,
        row.actualCost,
        ratio(row.costPerformanceIndex, 2),
        row.estimateToComplete,
        row.estimateAtCompletion,
        row.varianceAtCompletion,
      ]),
    }],
  }
}
