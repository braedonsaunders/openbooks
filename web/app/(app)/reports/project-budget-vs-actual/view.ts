import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  column,
  field,
  ref,
  rootRef,
  spanRow,
  table,
  text,
  textBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { getMoneyFormatter } from '@/lib/money-server'
import { statementReportSpec } from '@/lib/reports/statement-report-spec'
import { projectBudgetComparison } from '@openbooks/engine/src/projects/budget-baselines.ts'
import { requirePermission } from '../../../../lib/authz'
import { requireProjectsFeature } from '../../../../lib/projects-gate'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, REPORT_PARAM_KEYS } from '../../../../lib/report-filters'
import { projectBudgetProjectOptions, projectBudgetRows } from '../../../../lib/project-budget-report'

/**
 * Project budget vs actual, split into a loader and a spec like the other
 * statement reports. For the chosen project it lays out each task's original
 * (sold) budget, current working budget and actual hours and cost through the
 * period's end date; the figures are the engine's budget comparison.
 */

type Columns = Record<
  'task' | 'originalHours' | 'currentHours' | 'actualHours' | 'originalCost' | 'currentCost' | 'actualCost'
  | 'varianceToOriginal' | 'varianceToCurrent' | 'originalPrice' | 'currentPrice',
  string
>

interface DisplayRow extends Columns {
  key: string
}

export interface ProjectBudgetData {
  title: string
  description: string
  backHref: string
  backLabel: string
  company: string
  asOfPhrase: string
  baselineNote: string
  priceNote: string
  primaryFilter: { paramKey: string; label: string; value: string; options: { value: string; label: string }[] }
  exportParams: Record<string, string | undefined>
  columns: Columns
  rows: DisplayRow[]
  total: DisplayRow | null
  empty: string
}

const blank = (value: string | null, format: (v: string) => string) => (value === null ? '—' : format(value))

/** Hours without trailing fractional zeros ("24.0000" → "24"). */
function hours(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

export async function loadProjectBudgetReport(sp: Record<string, string | undefined>): Promise<ProjectBudgetData> {
  const authz = await requirePermission('reports.read')
  const orgId = authz.user.orgId
  await requireProjectsFeature(orgId)
  const t = await getTranslations('reports.projectBudget')
  const tr = await getTranslations('reports')
  const { money } = await getMoneyFormatter()
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId })
  const options = await projectBudgetProjectOptions(authz)
  const projectId = options.some((option) => option.id === q.dims.projectId) ? q.dims.projectId : undefined
  const org = await orgInfo(orgId)
  const comparison = projectId
    ? await projectBudgetComparison(orgId, projectId, { asOf: period.to, allowedSubsidiaryIds: authz.allowedSubsidiaryIds })
    : null
  const rows = comparison ? projectBudgetRows(comparison, { unassigned: t('unassigned'), total: t('total') }) : []
  const display = rows.map((row): DisplayRow => ({
    key: row.key,
    task: row.task,
    originalHours: blank(row.originalHours, hours),
    currentHours: hours(row.currentHours),
    actualHours: hours(row.actualHours),
    originalCost: blank(row.originalCost, money),
    currentCost: row.kind === 'unassigned' ? '—' : money(row.currentCost),
    actualCost: money(row.actualCost),
    varianceToOriginal: blank(row.varianceToOriginal, money),
    varianceToCurrent: blank(row.varianceToCurrent, money),
    originalPrice: blank(row.originalPrice, money),
    currentPrice: row.kind === 'unassigned' ? '—' : money(row.currentPrice),
  }))
  const total = display.length > 0 && rows[rows.length - 1]!.kind === 'total' ? display.pop()! : null
  const original = comparison?.original ?? null

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/reports',
    backLabel: tr('hub.title'),
    company: org?.name ?? '',
    asOfPhrase: comparison ? `${comparison.projectName} · ${t('asOf', { date: period.to })}` : t('asOf', { date: period.to }),
    baselineNote: !comparison
      ? ''
      : original
        ? original.sourceDocumentNumber
          ? t('originalFromSource', { source: original.sourceDocumentNumber, date: original.createdAt.slice(0, 10) })
          : t('originalFromWbs', { date: original.createdAt.slice(0, 10) })
        : t('noOriginal'),
    priceNote: comparison
      ? t('priceNote', {
          original: comparison.price.original === null ? '—' : money(comparison.price.original),
          current: money(comparison.price.current),
          invoiced: money(comparison.price.invoicedToDate ?? '0'),
        })
      : '',
    primaryFilter: {
      paramKey: REPORT_PARAM_KEYS.project,
      label: t('columns.project'),
      value: projectId ?? '',
      options: [{ value: '', label: t('chooseProject') }, ...options.map((option) => ({ value: option.id, label: option.label }))],
    },
    exportParams: sp,
    columns: {
      task: t('columns.task'),
      originalHours: t('columns.originalHours'),
      currentHours: t('columns.currentHours'),
      actualHours: t('columns.actualHours'),
      originalCost: t('columns.originalCost'),
      currentCost: t('columns.currentCost'),
      actualCost: t('columns.actualCost'),
      varianceToOriginal: t('columns.varianceToOriginal'),
      varianceToCurrent: t('columns.varianceToCurrent'),
      originalPrice: t('columns.originalPrice'),
      currentPrice: t('columns.currentPrice'),
    },
    rows: display,
    total,
    empty: projectId ? t('empty') : t('chooseProjectHint'),
  }
}

const f = ref<ProjectBudgetData>()
const rootF = rootRef<ProjectBudgetData>()
const item = field
const AMOUNTS = [
  'originalHours', 'currentHours', 'actualHours', 'originalCost', 'currentCost', 'actualCost',
  'varianceToOriginal', 'varianceToCurrent', 'originalPrice', 'currentPrice',
] as const

export function projectBudgetSpec(data: ProjectBudgetData): PageSpec {
  return statementReportSpec({
    route: '/reports/project-budget-vs-actual',
    header: {
      title: f('title'),
      description: f('description'),
      back: { href: f('backHref'), label: f('backLabel') },
    },
    filters: [{
      controls: { period: true, asOf: true },
      options: { primaryFilter: f('primaryFilter') },
    }],
    exportMenu: { kind: 'project-budget-vs-actual', params: data.exportParams },
    paper: {
      company: f('company'),
      title: f('title'),
      periodPhrase: f('asOfPhrase'),
      wide: true,
    },
    blocks: [
      textBlock(f('baselineNote'), { tone: 'muted', className: 'mb-3' }),
      table({
        variant: 'report',
        rows: f('rows'),
        rowKey: item('key'),
        emptyRow: { text: f('empty'), colSpan: 11 },
        columns: [
          column(rootF('columns.task'), text(item('task')), { className: 'font-medium' }),
          ...AMOUNTS.map((key) => column(rootF(`columns.${key}`), text(item(key)), { align: 'right', className: 'tabular-nums' })),
        ],
        ...(data.total
          ? {
              trailing: [spanRow({
                label: f('total.task'),
                labelColSpan: 1,
                className: 'border-t border-slate-300 font-semibold dark:border-slate-700',
                cells: AMOUNTS.map((key) => ({ cell: text(f(`total.${key}`)), align: 'right' as const, className: 'tabular-nums' })),
              })],
            }
          : {}),
      }),
      textBlock(f('priceNote'), { tone: 'muted', className: 'mt-3' }),
    ],
  })
}
