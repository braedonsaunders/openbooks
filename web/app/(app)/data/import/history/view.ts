import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  badge,
  column,
  field,
  page,
  pageHeader,
  ref,
  rootRef,
  table,
  text,
  widget,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { dateTime } from '../../../../../lib/format'

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
}

export interface ImportHistoryRow {
  id: string
  when: string
  resourceLabel: string
  fileName: string | null
  format: string
  status: string
  /** The native page shows failures outlined and everything else as success. */
  statusVariant: 'outline' | 'success'
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
  emptyLabel: string
  columnWhen: string
  columnResource: string
  columnFormat: string
  columnStatus: string
  columnRows: string
  columnBy: string
  rows: ImportHistoryRow[]
}

export async function loadImportHistory(): Promise<ImportHistoryData> {
  const authz = await requirePermission('data.import')
  const t = await getTranslations('data')

  const result = await db.execute<JobRow>(sql`
    select j.id, j.resource_key, j.resource_label, j.format, j.file_name, j.status,
           j.total_rows, j.created_count, j.updated_count, j.failed_count, j.created_at,
           u.name as actor_name
      from import_jobs j
      left join users u on u.id = j.created_by
     where j.org_id = ${authz.user.orgId}
     order by j.created_at desc
     limit 200`)

  return {
    title: t('history.title'),
    description: t('history.description'),
    importLabel: t('nav.import'),
    importHref: '/data/import',
    emptyLabel: t('history.empty'),
    columnWhen: t('history.when'),
    columnResource: t('history.resource'),
    columnFormat: t('history.format'),
    columnStatus: t('history.status'),
    columnRows: t('history.rows'),
    columnBy: t('history.by'),
    rows: result.rows.map((j) => ({
      id: j.id,
      when: dateTime(j.created_at),
      resourceLabel: j.resource_label ?? j.resource_key,
      fileName: j.file_name,
      format: j.format,
      status: j.status,
      statusVariant: j.status === 'failed' ? 'outline' : 'success',
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
        actions: [widget('link-button', { href: f('importHref'), label: f('importLabel') })],
      }),
    ],
    body: [
      table({
        variant: 'app',
        rows: f('rows'),
        rowKey: item('id'),
        empty: { title: f('emptyLabel') },
        columns: [
          column(rootF('columnWhen'), text(item('when')), { className: 'whitespace-nowrap' }),
          column(
            rootF('columnResource'),
            widgetCell('resource-cell', { label: item('resourceLabel'), fileName: item('fileName') }),
          ),
          column(rootF('columnFormat'), text(item('format')), { className: 'uppercase' }),
          column(rootF('columnStatus'), badge(item('status'), { variant: item('statusVariant') })),
          column(
            rootF('columnRows'),
            widgetCell('row-counts-cell', {
              created: item('created'),
              updated: item('updated'),
              failed: item('failed'),
            }),
            { align: 'right', className: 'tabular-nums' },
          ),
          column(rootF('columnBy'), text(item('actor')), { className: 'text-muted-foreground' }),
        ],
      }),
    ],
  })
}
