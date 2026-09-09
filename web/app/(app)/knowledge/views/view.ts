import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field,
  grid,
  page,
  pageHeader,
  pagination,
  ref,
  rootRef,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { dateTime } from '../../../../lib/format'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { REPORT_ENTITIES } from '@openbooks/reports'
import { loadViews } from '../../../../lib/views'
import { orgBranding } from '../../../../lib/report-pdf'

/**
 * Saved views, split into a loader and a spec.
 *
 * Filtering, sorting and paging happen in memory here because the source list
 * is permission-filtered before it is sliced — a detail the spec never sees and
 * must not be able to influence. Per-row edit rights are resolved here too and
 * reach the row as a plain boolean.
 */

const PER_PAGE = 25

const SCOPE_VARIANT: Record<string, 'secondary' | 'outline'> = {
  shared: 'secondary',
  private: 'outline',
}

export interface SavedViewRow {
  id: string
  name: string
  href: string
  description: string | null
  source: string
  scopeLabel: string
  scopeVariant: 'secondary' | 'outline'
  updated: string
  runHref: string
  editHref: string
  canEdit: boolean
}

export interface ViewsData {
  title: string
  description: string
  backHref: string
  backLabel: string
  searchPlaceholder: string
  scopeLabel: string
  scopeAllLabel: string
  scopeOptions: { value: string; label: string }[]
  currentParams: Record<string, string>
  emptyTitle: string
  emptyDescription: string
  hasRows: boolean
  isEmpty: boolean
  columnName: string
  columnSource: string
  columnScope: string
  columnUpdated: string
  columnActions: string
  runLabel: string
  editLabel: string
  rows: SavedViewRow[]
  total: number
  currentPage: number
  perPage: number
  canCreate: boolean
  studioOpen: boolean
  studioProps: Record<string, unknown> | null
}

export async function loadViewsPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<ViewsData> {
  const t = await getTranslations('knowledge.views')
  const tReports = await getTranslations('reports')
  const tNav = await getTranslations('nav')
  const tc = await getTranslations('common')
  const authz = await requirePermission('reports.read')
  const canCreate = authz.permissions.has('reports.create') || authz.permissions.has('*')
  const params = parseListParams(sp, {
    sort: 'updated',
    dir: 'desc',
    perPage: PER_PAGE,
    allowedSorts: ['updated', 'name'] as const,
  })
  const scopeFilter = pickString(sp.scope) ?? 'all'

  const [all, branding, inventoryEnabled] = await Promise.all([
    loadViews(authz.user.orgId, authz.user.id, authz.permissions),
    orgBranding(authz.user.orgId),
    isFeatureEnabled(authz.user.orgId, 'inventory'),
  ])
  const q = params.q?.toLowerCase()
  const filtered = all.filter((s) => {
    if (scopeFilter !== 'all' && s.scope !== scopeFilter) return false
    if (q && !s.name.toLowerCase().includes(q) && !s.description?.toLowerCase().includes(q)) return false
    return true
  })
  const sorted = [...filtered].sort((a, b) => {
    if (params.sort === 'name') {
      return params.dir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
    }
    return params.dir === 'asc'
      ? new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
      : new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  })
  const total = sorted.length
  const pageRows = sorted.slice((params.page - 1) * PER_PAGE, params.page * PER_PAGE)

  const openId = pickString(sp.view)
  const openView = openId ? (all.find((s) => s.id === openId) ?? null) : null
  const isAdmin = authz.permissions.has('*')

  const currentParams = Object.fromEntries(
    Object.entries(sp).filter(([, v]) => v !== undefined),
  ) as Record<string, string>

  return {
    title: t('list.title'),
    description: t('list.description'),
    backHref: '/dashboard',
    backLabel: tNav('modules.dashboard'),
    searchPlaceholder: t('list.searchPlaceholder'),
    scopeLabel: t('list.scopeLabel'),
    scopeAllLabel: t('list.scopeAll'),
    scopeOptions: [
      { value: 'shared', label: t('list.scopeShared') },
      { value: 'private', label: t('list.scopePrivate') },
    ],
    currentParams,
    emptyTitle: t('list.emptyTitle'),
    emptyDescription: t('list.emptyDescription'),
    hasRows: total > 0,
    isEmpty: total === 0,
    columnName: t('list.columns.name'),
    columnSource: t('list.columns.source'),
    columnScope: t('list.columns.scope'),
    columnUpdated: t('list.columns.updated'),
    columnActions: tc('labels.actions'),
    runLabel: t('list.runAction'),
    editLabel: t('list.editAction'),
    rows: pageRows.map((s) => ({
      id: s.id,
      name: s.name,
      href: `/knowledge/views/${s.id}`,
      description: s.description,
      source: tReports.has(`catalog.entities.${s.query.entity}.label`)
        ? tReports(`catalog.entities.${s.query.entity}.label`)
        : s.query.entity,
      scopeLabel: t(`list.scope.${s.scope}` as never),
      scopeVariant: SCOPE_VARIANT[s.scope] ?? 'outline',
      updated: dateTime(s.updated_at),
      runHref: `/knowledge/views/${s.id}`,
      editHref: `/knowledge/views?view=${s.id}`,
      canEdit: isAdmin || s.owner_id === authz.user.id,
    })),
    total,
    currentPage: params.page,
    perPage: PER_PAGE,
    canCreate,
    studioOpen: Boolean(openView),
    studioProps: openView
      ? {
          view: openView,
          canCreate,
          canAdmin: isAdmin || openView.owner_id === authz.user.id,
          company: branding.orgName,
          inventoryEnabled,
          hiddenEntityKeys: REPORT_ENTITIES.filter(
            (e) => e.requiredPermission && !can(authz, e.requiredPermission),
          ).map((e) => e.key),
        }
      : null,
  }
}

const f = ref<ViewsData>()
const item = field
const rootF = rootRef<ViewsData>()

export function viewsSpec(data: ViewsData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
        actions: [widget('new-saved-view', {}, f('canCreate'))],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/knowledge/views',
          currentParams: data.currentParams,
          paramKey: 'scope',
          label: data.scopeLabel,
          allLabel: data.scopeAllLabel,
          options: data.scopeOptions,
        }),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f('isEmpty'),
      },
      {
        ...grid('overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800', [
          table({
            variant: 'app',
            rows: f('rows'),
            rowKey: item('id'),
            columns: [
              column(
                rootF('columnName'),
                widgetCell('view-name-cell', {
                  name: item('name'),
                  href: item('href'),
                  description: item('description'),
                }),
              ),
              column(rootF('columnSource'), text(item('source')), {
                className: 'text-slate-600 dark:text-slate-300',
              }),
              column(rootF('columnScope'), badge(item('scopeLabel'), { variant: item('scopeVariant') })),
              column(rootF('columnUpdated'), text(item('updated')), {
                className: 'text-slate-500 dark:text-slate-400',
              }),
              column(
                rootF('columnActions'),
                widgetCell('view-actions-cell', {
                  runHref: item('runHref'),
                  runLabel: rootF('runLabel'),
                  editHref: item('editHref'),
                  editLabel: rootF('editLabel'),
                  canEdit: item('canEdit'),
                }),
                { headerClassName: 'w-24' },
              ),
            ],
          }),
        ]),
        when: f('hasRows'),
      },
      pagination({
        basePath: '/knowledge/views',
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
        bare: true,
      }),
      widgetBlock('view-studio', { studio: data.studioProps }, f('studioOpen')),
    ],
  })
}
