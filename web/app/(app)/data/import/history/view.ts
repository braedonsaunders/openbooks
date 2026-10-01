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

/**
 * Import history, split into a loader and a spec.
 *
 * First conversion of an APP-variant list page rather than a report paper.
 * They are not interchangeable: the app table brings card chrome, a sticky
 * header and row entrance staggering, and its empty case is the shared
 * EmptyState rather than a centred paragraph. The `variant` on the table block
 * selects the whole primitive set.
 */

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
}

export async function loadImportHistory(sp: Record<string, string | string[] | undefined> = {}): Promise<ImportHistoryData> {
  const authz = await requirePermission('data.import')
  const t = await getTranslations('data')
  const tCatalog = await getTranslations()
  const navigation = dataWorkspaceNavigation(authz.permissions)
  const locale = await getLocale()
  const params = parseListParams(sp, { sort: 'created_at', allowedSorts: ['created_at'], perPage: 50 })
  // Whole-company evidence requires the same unrestricted audit grant as the
  // company audit log. Other operators see their own transfer history.
  const visibility = authz.allowedSubsidiaryIds === null && can(authz, 'admin.audit.read')
    ? sql`true` : sql`j.created_by = ${authz.user.id}${authz.allowedSubsidiaryIds === null ? sql`` : sql`and exists (
        select 1 from data_transfer_jobs visible where visible.org_id=j.org_id and visible.id=j.id
        and ${transferMetadataScope(authz.allowedSubsidiaryIds, sql`visible.scope`)})`}`
  const count = await db.execute<{ total: string }>(sql`select count(*)::text as total from import_jobs j where j.org_id=${authz.user.orgId} and ${visibility}`)

  const result = await db.execute<JobRow>(sql`
    select j.id, j.resource_key, j.resource_label, j.format, j.file_name, j.status,
           j.total_rows, j.created_count, j.updated_count, j.failed_count, j.created_at,
           u.name as actor_name, d.id as transfer_id
      from import_jobs j
      left join users u on u.id = j.created_by
      left join data_transfer_jobs d on d.org_id=j.org_id and d.id=j.id and d.actor_id=${authz.user.id}
     where j.org_id = ${authz.user.orgId} and ${visibility}
     order by j.created_at desc, j.id desc limit ${params.perPage} offset ${(params.page - 1) * params.perPage}`)

  return {
    title: t('history.title'),
    description: t('history.description'),
    importLabel: t('nav.import'),
    importHref: '/data/import',
    backHref: navigation.backHref,
    backLabel: tCatalog(navigation.backLabelKey),
    emptyLabel: t('history.empty'),
    columnWhen: t('history.when'),
    columnResource: t('history.resource'),
    columnFormat: t('history.format'),
    columnStatus: t('history.status'),
    columnRows: t('history.rows'),
    columnBy: t('history.by'),
    total: Number(count.rows[0]?.total ?? 0),
    currentPage: params.page,
    perPage: params.perPage,
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
        columns: [
          column(rootF('columnWhen'), text(item('when')), {
            className: 'whitespace-nowrap',
          }),
          column(
            rootF('columnResource'),
            widgetCell('resource-cell', {
              label: item('resourceLabel'),
              fileName: item('fileName'),
              href: item('href'),
            }),
          ),
          column(rootF('columnFormat'), text(item('format')), {
            className: 'uppercase',
          }),
          column(
            rootF('columnStatus'),
            badge(item('status'), { variant: item('statusVariant') }),
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
          }),
        ],
      }),
    ],
  })
}
