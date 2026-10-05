import 'server-only'

import { registeredListTable } from '../../../../../lib/list/prepared-spec'
import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import {
  badge,
  column,
  field,
  page,
  pageHeader,
  pagination,
  ref,
  rootRef,
  text,
  widget,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../../lib/authz'
import { dateTime } from '../../../../../lib/format'
import { dataWorkspaceNavigation } from '../../../../../lib/setup/data-workspace'
import { parseListParams } from '../../../../../lib/list-params'
import { transferMetadataScope } from '../../../../../lib/data-io/transfer-store'

/** Authorized import history on the shared server-paged record list. */

const HISTORY_SORTS = {
  created_at: sql`j.created_at`,
  resource: sql`coalesce(j.resource_label, j.resource_key)`,
  format: sql`j.format`,
  status: sql`j.status`,
  actor: sql`u.name`,
}

type JobRow = {
  id: string
  resource_key: string
  resource_label: string | null
  format: string
  file_name: string | null
  status: string
  total_rows: number
  created_count: number
  updated_count: number
  failed_count: number
  created_at: string
  actor_name: string | null
  transfer_id: string | null
}

export interface ImportHistoryRow {
  id: string
  when: string
  resourceLabel: string
  fileName: string | null
  format: string
  status: string
  statusVariant: 'outline' | 'success' | 'secondary'
  href: string | null
  created: number
  updated: number
  failed: number
  actor: string
}

export interface ImportHistoryData {
  title: string
  description: string
  importLabel: string
  importHref: string
  backHref: string
  backLabel: string
  emptyLabel: string
  columnWhen: string
  columnResource: string
  columnFormat: string
  columnStatus: string
  columnRows: string
  columnBy: string
  rows: ImportHistoryRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: 'asc' | 'desc'
  search: { placeholder: string }
  currentParams: Record<string, string | string[] | undefined>
}

export async function loadImportHistory(sp: Record<string, string | string[] | undefined> = {}): Promise<ImportHistoryData> {
  const authz = await requirePermission('data.import')
  const t = await getTranslations('data')
  const tCatalog = await getTranslations()
  const navigation = dataWorkspaceNavigation(authz.permissions)
  const locale = await getLocale()
  const params = parseListParams(sp, {
    sort: 'created_at',
    allowedSorts: Object.keys(HISTORY_SORTS) as (keyof typeof HISTORY_SORTS)[],
    perPage: 50,
  })
  // Whole-company evidence requires the same unrestricted audit grant as the
  // company audit log. Other operators see their own transfer history.
  const visibility = authz.allowedSubsidiaryIds === null && can(authz, 'admin.audit.read')
    ? sql`true` : sql`j.created_by = ${authz.user.id}${authz.allowedSubsidiaryIds === null ? sql`` : sql`and exists (
        select 1 from data_transfer_jobs visible where visible.org_id=j.org_id and visible.id=j.id
        and ${transferMetadataScope(authz.allowedSubsidiaryIds, sql`visible.scope`)})`}`
  const search = params.q
    ? sql`and concat_ws(' ', j.resource_label, j.resource_key, j.file_name, j.format, j.status, u.name)
        ilike ${`%${params.q.replace(/[\\%_]/g, '\\$&')}%`}`
    : sql``
  const where = sql`j.org_id = ${authz.user.orgId} and ${visibility} ${search}`
  const count = await db.execute<{ total: string }>(sql`
    select count(*)::text as total from import_jobs j
    left join users u on u.id = j.created_by
    where ${where}`)

  const result = await db.execute<JobRow>(sql`
    select j.id, j.resource_key, j.resource_label, j.format, j.file_name, j.status,
           j.total_rows, j.created_count, j.updated_count, j.failed_count, j.created_at,
           u.name as actor_name, d.id as transfer_id
      from import_jobs j
      left join users u on u.id = j.created_by
      left join data_transfer_jobs d on d.org_id=j.org_id and d.id=j.id and d.actor_id=${authz.user.id}
     where ${where}
     order by ${HISTORY_SORTS[params.sort]} ${sql.raw(params.dir)}, j.id ${sql.raw(params.dir)}
     limit ${params.perPage} offset ${(params.page - 1) * params.perPage}`)

  return {
    title: t('history.title'),
    description: t('history.description'),
    importLabel: t('nav.import'),
    importHref: '/data/import',
    backHref: navigation.backHref,
    backLabel: tCatalog(navigation.backLabelKey),
    emptyLabel: params.q ? tCatalog('common.empty.title') : t('history.empty'),
    columnWhen: t('history.when'),
    columnResource: t('history.resource'),
    columnFormat: t('history.format'),
    columnStatus: t('history.status'),
    columnRows: t('history.rows'),
    columnBy: t('history.by'),
    total: Number(count.rows[0]?.total ?? 0),
    currentPage: params.page,
    perPage: params.perPage,
    sort: params.sort,
    dir: params.dir,
    search: { placeholder: tCatalog('ui.search.placeholder') },
    currentParams: sp,
    rows: result.rows.map((j) => ({
      id: j.id,
      when: dateTime(j.created_at, locale),
      resourceLabel: j.resource_label ?? j.resource_key,
      fileName: j.file_name,
      format: j.format,
      status:
        j.status === 'committed'
          ? t('history.jobStatus.committed')
          : j.status === 'failed'
            ? t('history.jobStatus.failed')
            : t.has(`transfer.states.${j.status}`) ? t(`transfer.states.${j.status}`) : j.status,
      statusVariant: j.status === 'committed' ? 'success' : j.status === 'failed' || j.status === 'cancelled' ? 'outline' : 'secondary',
      href: j.transfer_id ? `/data/import?transfer=${j.transfer_id}` : null,
      created: j.created_count,
      updated: j.updated_count,
      failed: j.failed_count,
      actor: j.actor_name ?? '—',
    })),
  }
}

const f = ref<ImportHistoryData>()
const item = field
const rootF = rootRef<ImportHistoryData>()

export function importHistorySpec(): PageSpec {
  return page({
    route: '/data/import/history',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
        actions: [
          widget('link-button', {
            href: f('importHref'),
            label: f('importLabel'),
          }),
        ],
      }),
    ],
    body: [
      registeredListTable('data_import_history', {
        variant: 'app',
        rows: f('rows'),
        rowKey: item('id'),
        empty: { title: f('emptyLabel') },
        sorting: { basePath: '/data/import/history', sort: f('sort'), dir: f('dir') },
        columns: [
          column(rootF('columnWhen'), text(item('when')), {
            className: 'whitespace-nowrap',
            sort: 'created_at',
          }),
          column(
            rootF('columnResource'),
            widgetCell('resource-cell', {
              label: item('resourceLabel'),
              fileName: item('fileName'),
              href: item('href'),
            }),
            { sort: 'resource' },
          ),
          column(rootF('columnFormat'), text(item('format')), {
            className: 'uppercase',
            sort: 'format',
          }),
          column(
            rootF('columnStatus'),
            badge(item('status'), { variant: item('statusVariant') }),
            { sort: 'status' },
          ),
          column(
            rootF('columnRows'),
            widgetCell('row-counts-cell', {
              created: item('created'),
              updated: item('updated'),
              failed: item('failed'),
            }),
            { align: 'right', className: 'tabular-nums' },
          ),
          column(rootF('columnBy'), text(item('actor')), {
            className: 'text-muted-foreground',
            sort: 'actor',
          }),
        ],
      }, [
        widget('list-toolbar', {
          basePath: '/data/import/history',
          currentParams: f('currentParams'),
          search: f('search'),
        }),
      ]),
      pagination({
        basePath: '/data/import/history',
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
        bare: true,
      }),
    ],
  })
}
