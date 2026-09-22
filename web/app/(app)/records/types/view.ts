import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
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
} from '@braedonsaunders/appkit-viewspec'
import { buildListDrawerHref, parseListParams, pickString } from '../../../../lib/list-params'
import { dateTime } from '../../../../lib/format'
import { requirePermission } from '../../../../lib/authz'
import { loadRecordTypeById, subsidiaryDeclaredTypeIds, type RecordTypeRow } from '../../../../lib/records'
import { pgTextArrayLiteral } from '../../../../lib/pg-array'
import { RECORD_TYPE_STATUSES } from '../../../../lib/record-schema'

/**
 * Custom record types, split into a loader and a spec.
 *
 * Its two conditional cells — a record count that links only once the type is
 * published, and an "in nav" badge that becomes an em-dash otherwise — are
 * conditional PAIRS, not presence. `when` omits a block; it cannot choose
 * between two. Both are components, which is the same answer given to the
 * purchasing hero's empty state and aging's party cell.
 *
 * Five of seven columns sort, so this is also the widest use of the sorting
 * config so far.
 */

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  published: 'success',
  draft: 'secondary',
  archived: 'outline',
}

const SORT_COLUMNS = {
  name: sql`t.name`,
  key: sql`t.key`,
  status: sql`t.status`,
  records: sql`record_count`,
  updated: sql`t.updated_at`,
} as const

export interface RecordTypeListRow {
  id: string
  name: string
  href: string
  key: string
  fieldCount: string
  recordCount: string
  recordsHref: string
  recordsLinked: boolean
  inNav: boolean
  inNavLabel: string
  statusLabel: string
  statusVariant: 'success' | 'secondary' | 'outline'
  updated: string
}

export interface RecordTypesData {
  title: string
  description: string
  backHref: string
  backLabel: string
  searchPlaceholder: string
  statusLabel: string
  statusOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  emptyTitle: string
  emptyDescription: string
  isEmpty: boolean
  hasRows: boolean
  columnName: string
  columnKey: string
  columnFields: string
  columnRecords: string
  columnInNav: string
  columnStatus: string
  columnUpdated: string
  rows: RecordTypeListRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: string
  drawerOpen: boolean
  drawerProps: Record<string, unknown> | null
}

export async function loadRecordTypes(
  sp: Record<string, string | string[] | undefined>,
): Promise<RecordTypesData> {
  const authz = await requirePermission('records.manage_types')
  const t = await getTranslations('records')
  const tc = await getTranslations('common')
  const tHub = await getTranslations('admin.hub')
  const typeId = typeof sp.type === 'string' ? sp.type : undefined
  // Unsaved create: `?type=new` renders the builder drawer over a blank form.
  // Nothing is read or written for the id itself — the type exists only after
  // an explicit Save POSTs /api/records/types.
  const isCreate = typeId === 'new'
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['name', 'key', 'status', 'records', 'updated'] as const,
  })
  const status = pickString(sp.status)

  const where = sql`t.org_id = ${authz.user.orgId}
    ${status ? sql` and t.status = ${status}` : sql``}
    ${params.q ? sql` and (t.name ilike ${'%' + params.q + '%'} or t.plural_name ilike ${'%' + params.q + '%'} or t.key ilike ${'%' + params.q + '%'})` : sql``}`

  // A subsidiary-restricted type manager sees only the records their fence
  // admits: types that declare subsidiary_id count in-fence rows; field-less
  // types stay org-visible unless a row still carries a JSON subsidiary_id
  // outside the fence (dropping the field must not unscope those rows).
  const fence = authz.allowedSubsidiaryIds
  const scopedTypeIds =
    fence === null
      ? null
      : subsidiaryDeclaredTypeIds(
          (
            await db.execute<{ id: string; name: string; fields: unknown }>(sql`
              select id, name, fields from custom_record_types where org_id = ${authz.user.orgId}`)
          ).rows,
        )
  const countScope =
    fence === null || scopedTypeIds === null
      ? sql``
      : sql`and (
          cr.data ->> ${'subsidiary_id'} = any(${pgTextArrayLiteral([...fence])}::text[])
          or (
            not (t.id = any(${`{${scopedTypeIds.join(',')}}`}::uuid[]))
            and cr.data ->> ${'subsidiary_id'} is null
          )
        )`

  const [types, counts, openType, roles] = await Promise.all([
    db.execute(sql`
      select t.id, t.key, t.name, t.plural_name, t.icon_key, t.status, t.show_in_nav,
             t.updated_at,
             (select coalesce(sum(coalesce(jsonb_array_length(elem->'fields'), 1)), 0)
                from jsonb_array_elements(t.fields) elem) as field_count,
             (select count(*) from custom_records cr where cr.type_id = t.id ${countScope}) as record_count
        from custom_record_types t
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}`),
    db.execute<{ status: string; n: string }>(sql`
      select t.status, count(*) as n from custom_record_types t
       where t.org_id = ${authz.user.orgId}
       group by t.status`),
    typeId && !isCreate ? loadRecordTypeById(authz.user.orgId, typeId) : Promise.resolve(null),
    typeId
      ? db.execute<{ key: string; name: string }>(sql`
          select key, name from app_roles where org_id = ${authz.user.orgId} order by name`)
      : null,
  ])
  const total = counts.rows.reduce((a: number, r) => a + Number(r.n), 0)
  const filteredTotal =
    status || params.q
      ? Number(
          (
            await db.execute<{ n: string }>(
              sql`select count(*) as n from custom_record_types t where ${where}`,
            )
          ).rows[0]!.n,
        )
      : total

  const statusText = (value: string) =>
    (RECORD_TYPE_STATUSES as readonly string[]).includes(value) ? t(`typeStatus.${value}`) : value

  return {
    title: t('types.title'),
    description: t('types.description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    searchPlaceholder: t('types.searchPlaceholder'),
    statusLabel: tc('labels.status'),
    statusOptions: counts.rows.map((r) => ({
      value: String(r.status),
      label: statusText(String(r.status)),
      count: Number(r.n),
    })),
    currentParams: sp,
    emptyTitle: t('types.empty.title'),
    emptyDescription: t('types.empty.description'),
    isEmpty: total === 0,
    hasRows: total > 0,
    columnName: tc('labels.name'),
    columnKey: t('types.columns.key'),
    columnFields: t('types.columns.fields'),
    columnRecords: t('types.columns.records'),
    columnInNav: t('types.columns.inNav'),
    columnStatus: tc('labels.status'),
    columnUpdated: tc('labels.updated'),
    rows: types.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      href: buildListDrawerHref('/records/types', sp, 'type', String(row.id)),
      key: String(row.key),
      fieldCount: String(Number(row.field_count)),
      recordCount: String(Number(row.record_count)),
      recordsHref: `/records/${row.key}`,
      recordsLinked: row.status === 'published',
      inNav: Boolean(row.show_in_nav) && row.status === 'published',
      inNavLabel: t('types.shownInNav'),
      statusLabel: statusText(String(row.status)),
      statusVariant: STATUS_VARIANT[String(row.status)] ?? 'secondary',
      updated: dateTime(String(row.updated_at)),
    })),
    total: filteredTotal,
    currentPage: params.page,
    perPage: params.perPage,
    sort: params.sort,
    dir: params.dir,
    drawerOpen: Boolean(openType) || isCreate,
    drawerProps: openType
      ? {
          type: serializeType(openType),
          roles: (roles?.rows ?? []) as { key: string; name: string }[],
        }
      : isCreate
        ? {
            type: BLANK_TYPE,
            roles: (roles?.rows ?? []) as { key: string; name: string }[],
            createMode: true,
          }
        : null,
  }
}

/**
 * Unsaved-create seed: the drawer edits this blank in memory and POSTs it on
 * Save. `updated_at` is empty because no revision exists yet — autosave never
 * runs in create mode (see TypeBuilderDrawer).
 */
const BLANK_TYPE = {
  id: '',
  key: '',
  name: '',
  pluralName: '',
  iconKey: 'grid',
  description: null,
  fields: [],
  status: 'draft',
  showInNav: false,
  allowedRoles: null,
  sortOrder: 0,
  updated_at: '',
} as const

/** Plain-JSON shape for the client drawer (see RecordTypePayload). */
function serializeType(t: RecordTypeRow) {
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    pluralName: t.plural_name,
    iconKey: t.icon_key,
    description: t.description,
    fields: t.fields,
    status: t.status,
    showInNav: t.show_in_nav,
    allowedRoles: t.allowed_roles,
    sortOrder: t.sort_order,
    updated_at: t.updated_at,
  }
}

const f = ref<RecordTypesData>()
const item = field
const rootF = rootRef<RecordTypesData>()

const MUTED = 'text-slate-500 dark:text-slate-400'
const LINK = 'text-teal-700 hover:underline dark:text-teal-300'

export function recordTypesSpec(data: RecordTypesData): PageSpec {
  return page({
    route: '/records/types',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
        actions: [widget('new-record-type')],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/records/types',
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.statusLabel,
          options: data.statusOptions,
        }),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          description: data.emptyDescription,
          action: 'new-record-type',
        }),
        when: f('isEmpty'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          sorting: { basePath: '/records/types', sort: f('sort'), dir: f('dir') },
          columns: [
            column(rootF('columnName'), link(item('name'), item('href'), LINK), {
              sort: 'name',
              className: 'font-medium',
            }),
            column(rootF('columnKey'), text(item('key')), {
              sort: 'key',
              className: 'font-mono text-[13px] text-slate-500 dark:text-slate-400',
            }),
            column(rootF('columnFields'), text(item('fieldCount')), { className: 'tabular-nums' }),
            column(
              rootF('columnRecords'),
              widgetCell('record-count-cell', {
                count: item('recordCount'),
                href: item('recordsHref'),
                linked: item('recordsLinked'),
              }),
              { sort: 'records', align: 'right', className: 'tabular-nums' },
            ),
            column(
              rootF('columnInNav'),
              widgetCell('in-nav-cell', { shown: item('inNav'), label: item('inNavLabel') }),
            ),
            column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') }), {
              sort: 'status',
            }),
            column(rootF('columnUpdated'), text(item('updated')), { sort: 'updated', className: MUTED }),
          ],
        }),
        when: f('hasRows'),
      },
      {
        ...pagination({
          basePath: '/records/types',
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
        }),
        when: f('hasRows'),
      },
      widgetBlock('type-builder-drawer', { drawer: data.drawerProps }, f('drawerOpen')),
    ],
  })
}
