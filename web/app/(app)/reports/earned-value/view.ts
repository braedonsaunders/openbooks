import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  column,
  field,
  ref,
  rootRef,
  table,
  text,
  textBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { getMoneyFormatter } from '@/lib/money-server'
import { statementReportSpec } from '@/lib/reports/statement-report-spec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, REPORT_PARAM_KEYS } from '../../../../lib/report-filters'
import { earnedValueProjectOptions, earnedValueReport, ratio } from '../../../../lib/earned-value-report'

/**
 * Earned value, split into a loader and a spec like the other statement
 * reports: the figures are the earned-value engine's, so the loader calls it
 * and the page only lays out its terms — one total row per project followed
 * by its tasks, as of the period's end date.
 */

interface EarnedValueRow {
  key: string
  project: string
  task: string
  basis: string
  percent: string
  bac: string
  ev: string
  ac: string
  cpi: string
  etc: string
  eac: string
  vac: string
}

export interface EarnedValueData {
  title: string
  description: string
  backHref: string
  backLabel: string
  company: string
  asOfPhrase: string
  note: string
  searchPlaceholder: string
  primaryFilter: { paramKey: string; label: string; value: string; options: { value: string; label: string }[] }
  exportParams: Record<string, string | undefined>
  columns: Record<'project' | 'task' | 'basis' | 'percent' | 'bac' | 'ev' | 'ac' | 'cpi' | 'etc' | 'eac' | 'vac', string>
  rows: EarnedValueRow[]
  empty: string
}

export async function loadEarnedValueReport(sp: Record<string, string | undefined>): Promise<EarnedValueData> {
  await requirePermission('reports.read')
  // Task-level project cost is project data: the reader also needs projects.read.
  const authz = await requirePermission('projects.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'projectProgress')
  const t = await getTranslations('reports.earnedValue')
  const tr = await getTranslations('reports')
  const { money } = await getMoneyFormatter()
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId })
  const projectOptions = await earnedValueProjectOptions(authz)
  const projectId = projectOptions.some((option) => option.id === q.dims.projectId) ? q.dims.projectId : undefined
  const { rows } = await earnedValueReport(authz, { asOf: period.to, projectId, search: sp.q })
  const org = await orgInfo(orgId)

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/reports',
    backLabel: tr('hub.title'),
    company: org?.name ?? '',
    asOfPhrase: t('asOf', { date: period.to }),
    note: t('note'),
    searchPlaceholder: t('search'),
    primaryFilter: {
      paramKey: REPORT_PARAM_KEYS.project,
      label: t('columns.project'),
      value: projectId ?? '',
      options: [{ value: '', label: t('allProjects') }, ...projectOptions.map((option) => ({ value: option.id, label: option.label }))],
    },
    exportParams: sp,
    columns: {
      project: t('columns.project'),
      task: t('columns.task'),
      basis: t('columns.basis'),
      percent: t('columns.percent'),
      bac: t('columns.bac'),
      ev: t('columns.ev'),
      ac: t('columns.ac'),
      cpi: t('columns.cpi'),
      etc: t('columns.etc'),
      eac: t('columns.eac'),
      vac: t('columns.vac'),
    },
    rows: rows.map((row) => ({
      key: row.key,
      project: row.kind === 'project' ? row.project : '',
      task: row.task ?? t('projectTotal'),
      basis: row.basis ? t(`basis.${row.basis}`) : '',
      percent: row.percentComplete == null ? '—' : `${ratio(row.percentComplete, 1)}%`,
      bac: money(row.budgetAtCompletion),
      ev: money(row.earnedValue),
      ac: money(row.actualCost),
      cpi: ratio(row.costPerformanceIndex, 2),
      etc: money(row.estimateToComplete),
      eac: money(row.estimateAtCompletion),
      vac: money(row.varianceAtCompletion),
    })),
    empty: t('empty'),
  }
}

const f = ref<EarnedValueData>()
const rootF = rootRef<EarnedValueData>()
const item = field
const amount = (name: string, header: Parameters<typeof column>[0]) =>
  column(header, text(item(name)), { align: 'right', className: 'tabular-nums' })

export function earnedValueSpec(data: EarnedValueData): PageSpec {
  return statementReportSpec({
    route: '/reports/earned-value',
    header: {
      title: f('title'),
      description: f('description'),
      back: { href: f('backHref'), label: f('backLabel') },
    },
    filters: [{
      controls: { search: true, period: true, asOf: true },
      options: {
        searchPlaceholder: f('searchPlaceholder'),
        primaryFilter: f('primaryFilter'),
      },
    }],
    exportMenu: { kind: 'earned-value', params: data.exportParams },
    paper: {
      company: f('company'),
      title: f('title'),
      periodPhrase: f('asOfPhrase'),
      wide: true,
    },
    blocks: [
      table({
        variant: 'report',
        rows: f('rows'),
        rowKey: item('key'),
        emptyRow: { text: f('empty'), colSpan: 11 },
        columns: [
          column(rootF('columns.project'), text(item('project')), { className: 'font-medium' }),
          column(rootF('columns.task'), text(item('task'))),
          column(rootF('columns.basis'), text(item('basis')), { className: 'text-slate-500' }),
          amount('percent', rootF('columns.percent')),
          amount('bac', rootF('columns.bac')),
          amount('ev', rootF('columns.ev')),
          amount('ac', rootF('columns.ac')),
          amount('cpi', rootF('columns.cpi')),
          amount('etc', rootF('columns.etc')),
          amount('eac', rootF('columns.eac')),
          amount('vac', rootF('columns.vac')),
        ],
      }),
      textBlock(f('note'), { tone: 'muted', className: 'mt-3' }),
    ],
  })
}
