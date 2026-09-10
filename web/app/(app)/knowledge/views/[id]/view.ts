import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { isUuid, parseListParams } from '../../../../../lib/list-params'
import { dateTime } from '../../../../../lib/format'
import { requirePermission } from '../../../../../lib/authz'
import { canRunReportEntity } from '../../../../../lib/report-authz'
import { loadView, runView } from '../../../../../lib/views'
import type { ReportRunResult } from '@openbooks/reports'
import { orgBranding } from '../../../../../lib/report-pdf'
import {
  page,
  pageHeader,
  pagination,
  paper,
  ref,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'

export const PER_PAGE = 50

/**
 * Slice a run result to one page of rows, preserving group boundaries (a page
 * can straddle sections). The summary band keeps the FULL run's figures so
 * "Rows: 1,234" stays truthful while the table shows 50 at a time.
 */
export function paginateResult(result: ReportRunResult, page: number, perPage: number): ReportRunResult {
  const start = (page - 1) * perPage
  const end = start + perPage
  let offset = 0
  const groups = result.groups
    .map((g) => {
      const gStart = offset
      offset += g.rows.length
      const from = Math.max(start - gStart, 0)
      const to = Math.min(end - gStart, g.rows.length)
      if (from >= g.rows.length || to <= 0) return null
      return { ...g, rows: g.rows.slice(from, to) }
    })
    .filter((g): g is NonNullable<typeof g> => g !== null)
  // An empty page (out of range) keeps the first group shell so the header row
  // still renders; the empty state below covers the zero-rows case.
  return { ...result, groups: groups.length ? groups : result.groups.slice(0, 1) }
}

/**
 * A saved view's run page, split into a loader and a spec.
 *
 * Its header is `DetailHeader` with an action cluster that includes a
 * permission-gated edit button, so the whole cluster is one component and the
 * loader decides. The body is a conditional pair — an empty paper, or the
 * result table — expressed as two blocks with complementary flags.
 */

export interface SavedViewRunData {
  /** A stale link renders the page's own not-found state, not the app shell's. */
  notFound: boolean
  /** Complementary to `notFound`: `when` omits, it cannot choose. */
  found: boolean
  viewId: string
  name: string
  scope: string
  scopeLabel: string
  subtitle: string
  backHref: string
  backLabel: string
  canEdit: boolean
  headerLabels: { exportPdf: string; exportXlsx: string; exportCsv: string; edit: string }
  typeLabel: string
  lastUpdated: string
  rowsRange: string | null
  isEmpty: boolean
  hasRows: boolean
  showPager: boolean
  company: string
  description: string
  emptyTitle: string
  emptyDescription: string
  result: unknown
  drillTarget: unknown
  currentParams: Record<string, string | string[] | undefined>
  currentPage: number
  perPage: number
  total: number
  basePath: string
}

export async function loadSavedViewRun(
  params: { id: string },
  searchParams: Record<string, string | string[] | undefined>,
): Promise<SavedViewRunData> {
  const t = await getTranslations('knowledge.views')
  const tReports = await getTranslations('reports')
  const tc = await getTranslations('common')
  const authz = await requirePermission('reports.read')
  const { id } = await params
  const sp = await searchParams
  const listParams = parseListParams(sp, { sort: 'updated', dir: 'desc', perPage: PER_PAGE, allowedSorts: ['updated'] as const })

  const view = isUuid(id)
    ? await loadView(authz.user.orgId, id, authz.user.id, authz.permissions)
    : null

  // Not found renders its own header and empty state rather than a 404: the
  // native page does the same, so a reader who follows a stale link sees the
  // page explain itself instead of the app's error shell.
  if (!view) {
    return {
      notFound: true,
      found: false,
      viewId: '',
      name: t('run.notFoundTitle'),
      scope: '',
      scopeLabel: '',
      subtitle: t('run.notFoundDescription'),
      backHref: '/knowledge/views',
      backLabel: t('run.backToList'),
      canEdit: false,
      headerLabels: { exportPdf: '', exportXlsx: '', exportCsv: '', edit: '' },
      typeLabel: '',
      lastUpdated: '',
      rowsRange: null,
      isEmpty: false,
      hasRows: false,
      showPager: false,
      company: '',
      description: '',
      emptyTitle: t('run.notFoundTitle'),
      emptyDescription: t('run.notFoundDescription'),
      result: null,
      drillTarget: null,
      currentParams: searchParams,
      currentPage: 1,
      perPage: PER_PAGE,
      total: 0,
      basePath: '/knowledge/views',
    }
  }

  // A shared view never widens what its reader may see: payroll / optional-
  // module entities keep the same gate the report surfaces enforce.
  if (!(await canRunReportEntity(authz, view.query))) notFound()

  const canEdit = authz.permissions.has('*') || view.owner_id === authz.user.id
  const [result, branding] = await Promise.all([
    runView(authz.user.orgId, view.query),
    orgBranding(authz.user.orgId),
  ])
  const paged = paginateResult(result, listParams.page, PER_PAGE)
  const from = result.rowCount === 0 ? 0 : (listParams.page - 1) * PER_PAGE + 1
  const to = Math.min(listParams.page * PER_PAGE, result.rowCount)

  const entityLabel = tReports.has(`catalog.entities.${view.query.entity}.label`)
    ? tReports(`catalog.entities.${view.query.entity}.label`)
    : view.query.entity

  const currentParams = Object.fromEntries(Object.entries(sp).filter(([, v]) => v !== undefined)) as Record<string, string>


  return {
    notFound: false,
    found: true,
    viewId: view.id,
    name: view.name,
    scope: view.scope,
    scopeLabel: t(`list.scope.${view.scope}` as never),
    subtitle: view.description || t('run.refreshHint'),
    backHref: '/knowledge/views',
    backLabel: t('run.backToList'),
    canEdit,
    headerLabels: {
      exportPdf: t('studio.exportPdf'),
      exportXlsx: t('studio.exportXlsx'),
      exportCsv: t('studio.exportCsv'),
      edit: t('run.editSearch'),
    },
    typeLabel: `${tc('labels.type')}: ${entityLabel}`,
    lastUpdated: t('run.lastUpdated', { when: dateTime(view.updated_at) }),
    rowsRange:
      result.rowCount > 0 ? t('run.rowsRange', { from, to, total: result.rowCount }) : null,
    isEmpty: result.rowCount === 0,
    hasRows: result.rowCount > 0,
    showPager: true,
    company: branding.orgName,
    description: view.description || '',
    emptyTitle: t('run.emptyTitle'),
    emptyDescription: t('run.emptyDescription'),
    result: paged,
    drillTarget: { kind: 'custom', source: 'view', id: view.id, label: view.name },
    currentParams,
    currentPage: listParams.page,
    perPage: PER_PAGE,
    total: result.rowCount,
    basePath: `/knowledge/views/${view.id}`,
  }
}

const f = ref<SavedViewRunData>()

export function savedViewRunSpec(data: SavedViewRunData): PageSpec {
  return page({
    layout: 'list',
    header: [
      {
        ...pageHeader({
          title: f('name'),
          description: f('subtitle'),
          back: { href: f('backHref'), label: f('backLabel') },
        }),
        when: f('notFound'),
      },
      {
        ...widgetBlock('saved-view-header', {
        viewId: data.viewId,
        name: data.name,
        scope: data.scope,
        scopeLabel: data.scopeLabel,
        subtitle: data.subtitle,
        backHref: data.backHref,
        backLabel: data.backLabel,
        canEdit: data.canEdit,
          labels: data.headerLabels,
        }),
        when: f('found'),
      },
      {
        ...widgetBlock('saved-view-meta', {
          typeLabel: data.typeLabel,
          lastUpdated: data.lastUpdated,
          rowsRange: data.rowsRange,
        }),
        when: f('found'),
      },
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f('notFound'),
      },
      {
        ...paper({
          company: f('company'),
          title: f('name'),
          periodPhrase: f('description'),
          blocks: [
            widgetBlock('empty-state', {
              title: data.emptyTitle,
              description: data.emptyDescription,
            }),
          ],
        }),
        when: f('isEmpty'),
      },
      {
        ...widgetBlock('result-view', {
          company: data.company,
          title: data.name,
          description: data.description,
          result: data.result,
          drillTarget: data.drillTarget,
        }),
        when: f('hasRows'),
      },
      {
        ...pagination({
          basePath: f('basePath'),
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
          // The native pager is unwrapped here.
          bare: true,
        }),
        when: f('showPager'),
      },
    ],
  })
}
