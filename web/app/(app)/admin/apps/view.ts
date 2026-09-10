import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import {
  badge,
  column,
  field,
  grid,
  link,
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
import { buildListDrawerHref, parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { dateTime } from '../../../../lib/format'
import { isAppPublished, listAppFiles } from '../../../../lib/apps/store'
import type { AppManifest } from '../../../../lib/apps/manifest'
import type { AppDrawer } from './AppDrawer'

/**
 * Installed apps, split into a loader and a spec.
 *
 * An admin list page — search bar, status filter chips, an app-variant table
 * with an in-table spanning empty row, pagination, and the app flyout
 * (`?app=<key>`). The table decomposes into a `table` block exactly like the
 * sibling api-keys list: every cell is one element (the status badge owns its
 * own variant), so no composite cell component is needed.
 *
 * The flyout is the whole AppDrawer — a three-tab client workspace (overview
 * form, file browser + editor, runs log) whose rows are per-row client state.
 * It stays one widget rather than a decomposed drawer, the same doctrine as
 * every other drawer widget. Its server inputs (files, runs, isPublished)
 * travel through the loader result as data.
 *
 * The page's gates are the load-bearing part for conformance: the harness
 * tenant must hold `apps.manage` (it does — the harness user is an admin)
 * and the `apps` feature must be enabled (it is — default-on and the sim
 * org sets no override).
 */

type AppDrawerProps = Parameters<typeof AppDrawer>[0]

export interface AdminAppRow {
  key: string
  name: string
  href: string
  versionLabel: string
  endpointCount: number
  runCount: number
  statusLabel: string
  statusVariant: 'success' | 'outline'
  updated: string
}

export interface AdminAppsData {
  title: string
  description: string
  backHref: string
  backLabel: string
  libraryHref: string
  libraryLabel: string
  searchPlaceholder: string
  statusLabel: string
  statusOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  emptyLabel: string
  columnName: string
  columnKey: string
  columnVersion: string
  columnEndpoints: string
  columnRuns: string
  columnStatus: string
  columnUpdated: string
  rows: AdminAppRow[]
  total: number
  currentPage: number
  perPage: number
  /** Present only while a drawer key is in the query and resolves to an app. */
  drawerOpen: boolean
  drawer: AppDrawerProps | null
}

export async function loadAdminApps(
  sp: Record<string, string | string[] | undefined>,
): Promise<AdminAppsData> {
  const authz = await requirePermission('apps.manage')
  // /admin/apps is a separate route segment from /apps, so the apps layout
  // gate does not cover it. A disabled module must not keep an admin door open.
  await requireFeatureEnabled(authz.user.orgId, 'apps')
  const tHub = await getTranslations('admin.hub')
  const tApps = await getTranslations('apps')
  const tAdminApps = await getTranslations('apps.admin')
  const orgId = authz.user.orgId
  const params = parseListParams(sp, {
    sort: 'name',
    allowedSorts: ['name'] as const,
    perPage: 50,
  })
  const status = pickString(sp.status)
  const appKey = pickString(sp.app)

  const where = sql`a.org_id = ${orgId}
    ${status ? sql` and a.status = ${status}` : sql``}
    ${params.q ? sql` and (a.name ilike ${'%' + params.q + '%'} or a.key ilike ${'%' + params.q + '%'})` : sql``}`

  const [apps, statuses, totalRow] = await Promise.all([
    (db.execute(sql`
      select a.key, a.name, a.description, a.status,
             a.granted_permissions as "grantedPermissions", a.updated_at as "updatedAt",
             v.version, v.manifest,
             (select count(*) from app_runs r where r.app_id = a.id and r.org_id = a.org_id) as run_count
        from apps a left join app_versions v on v.id = a.active_version_id and v.org_id = a.org_id
       where ${where}
       order by a.name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `)),
    (db.execute(sql`select status, count(*) as n from apps where org_id = ${orgId} group by 1`)),
    (db.execute(sql`select count(*) as n from apps a where ${where}`)),
  ])

  // Drawer payload for the selected app.
  let drawer: {
    app: Record<string, unknown>
    files: Awaited<ReturnType<typeof listAppFiles>>
    runs: Record<string, unknown>[]
    isPublished: boolean
  } | null = null
  if (appKey) {
    const detail = ((await db.execute(sql`
      select a.id, a.key, a.name, a.description, a.icon_key as "iconKey", a.status,
             a.granted_permissions as "grantedPermissions",
             v.version, v.manifest
        from apps a left join app_versions v on v.id = a.active_version_id and v.org_id = a.org_id
       where a.org_id = ${orgId} and a.key = ${appKey} limit 1
    `)))
    const app = detail.rows[0]
    if (app) {
      const [files, runs, published] = await Promise.all([
        listAppFiles(orgId, appKey).catch(() => []),
        (db.execute(sql`
          select endpoint, status, units, logs, error_message, duration_ms, at
            from app_runs where app_id = ${app.id} and org_id = ${orgId} order by at desc limit 25`)),
        isAppPublished(appKey),
      ])
      drawer = {
        app,
        files,
        runs: runs.rows,
        isPublished: published,
      }
    }
  }

  const total = Number(totalRow.rows[0]?.n ?? 0)
  const endpointCount = (m: unknown) => (m as AppManifest | null)?.endpoints?.length ?? 0

  return {
    title: tAdminApps('title'),
    description: tAdminApps('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    libraryHref: '/apps/library',
    libraryLabel: tApps('actions.library'),
    searchPlaceholder: tAdminApps('searchPlaceholder'),
    statusLabel: tAdminApps('status'),
    statusOptions: statuses.rows.map((r: any) => ({
      value: r.status,
      label: tAdminApps(`statuses.${r.status}`),
      count: Number(r.n),
    })),
    currentParams: sp,
    emptyLabel: tAdminApps('empty'),
    columnName: tAdminApps('columns.name'),
    columnKey: tAdminApps('columns.key'),
    columnVersion: tAdminApps('columns.version'),
    columnEndpoints: tAdminApps('columns.endpoints'),
    columnRuns: tAdminApps('columns.runs'),
    columnStatus: tAdminApps('columns.status'),
    columnUpdated: tAdminApps('columns.updated'),
    rows: apps.rows.map((a: any) => ({
      key: String(a.key),
      name: String(a.name),
      href: buildListDrawerHref('/admin/apps', sp, 'app', String(a.key)),
      versionLabel: a.version ? `v${a.version}` : '—',
      endpointCount: endpointCount(a.manifest),
      runCount: Number(a.run_count),
      statusLabel: tAdminApps(`statuses.${a.status}`),
      statusVariant: (a.status === 'installed' ? 'success' : 'outline') as 'success' | 'outline',
      updated: dateTime(a.updatedAt),
    })),
    total,
    currentPage: params.page,
    perPage: params.perPage,
    drawerOpen: Boolean(appKey && drawer),
    drawer: drawer
      ? {
          app: drawer.app as unknown as AppDrawerProps['app'],
          files: drawer.files,
          runs: drawer.runs as unknown as AppDrawerProps['runs'],
          isPublished: drawer.isPublished,
        }
      : null,
  }
}

const f = ref<AdminAppsData>()
const item = field
const rootF = rootRef<AdminAppsData>()

const EMPTY_ROW_CLASS = 'py-10 text-center text-sm text-slate-500'
const LINK_CLASS = 'font-medium text-teal-700 hover:underline dark:text-teal-300'
const MUTED = 'text-xs text-slate-500'

export function adminAppsSpec(data: AdminAppsData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
        actions: [
          widget('apps-library-button', {
            href: data.libraryHref,
            label: data.libraryLabel,
          }),
          widget('apps-toolbar'),
        ],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/admin/apps',
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.statusLabel,
          options: data.statusOptions,
        }),
      ]),
    ],
    body: [
      table({
        variant: 'app',
        rows: f('rows'),
        rowKey: item('key'),
        emptyRow: { text: f('emptyLabel'), colSpan: 7, className: EMPTY_ROW_CLASS },
        columns: [
          column(rootF('columnName'), link(item('name'), item('href'), LINK_CLASS)),
          column(
            rootF('columnKey'),
            widgetCell('app-key-cell', { appKey: item('key') }),
          ),
          column(rootF('columnVersion'), text(item('versionLabel'))),
          column(rootF('columnEndpoints'), text(item('endpointCount')), {
            className: 'tabular-nums',
          }),
          column(rootF('columnRuns'), text(item('runCount')), {
            className: 'tabular-nums',
          }),
          column(
            rootF('columnStatus'),
            badge(item('statusLabel'), { variant: item('statusVariant') }),
          ),
          column(rootF('columnUpdated'), text(item('updated')), {
            className: MUTED,
          }),
        ],
      }),
      pagination({
        basePath: '/admin/apps',
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
        // The native pager sits directly under the table — no `mt-3` spacer.
        bare: true,
      }),
      widgetBlock('app-drawer', { drawer: data.drawer }, f('drawerOpen')),
    ],
  })
}
