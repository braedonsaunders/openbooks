import 'server-only'

import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { FieldValueMap, FormSection } from '@openbooks/forms-core'
import type { FormField } from '@openbooks/forms-core'
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
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { buildListDrawerHref, parseListParams, pickString } from '../../../../lib/list-params'
import { dateTime } from '../../../../lib/format'
import { can, requirePermission } from '../../../../lib/authz'
import {
  inTypeAudience,
  loadRecord,
  loadRecordTypeByKey,
  resolveEntityLabels,
} from '../../../../lib/records'
import {
  RECORD_STATUSES,
  formatFieldValue,
  isNumericField,
  lintRecordFields,
  listableFields,
  type RecordStatus,
} from '../../../../lib/record-schema'
import { getMoneyFormatter } from '../../../../lib/money-server'

/**
 * The auto-generated module for one published record type, split into a loader
 * and a spec.
 *
 * Its columns come from DATA — the type's first five listable fields — so the
 * spec builder maps the loader's column descriptors to `column()` defs and the
 * loader flattens each row's cells onto a `cells.<fieldId>` map the columns
 * bind by matching id. Field ids are forms-core identifiers (no dots), so the
 * paths stay one clean segment. A fully fixed column list would need a new
 * vocabulary entry per record type; generating from loader data keeps one spec
 * describing every module. (The compliance matrix made the opposite call, but
 * its columns carry per-cell policy logic — these are plain formatted text.)
 *
 * The header create action is omitted at build time when the reader may not
 * create, rather than gated by `when`: a `when`-off widget still leaves the
 * header's actions wrapper div, which the native page does not render.
 */

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  active: 'success',
  draft: 'secondary',
  inactive: 'outline',
}

const LINK = 'text-teal-700 hover:underline dark:text-teal-300'
const NUMBER_CELL = 'font-mono text-[13px] font-semibold'
const MUTED = 'text-slate-500 dark:text-slate-400'
const NUMERIC_CELL = 'tabular-nums'
const DASH_CLASS = 'text-slate-400 dark:text-slate-500'

export interface RecordModuleColumn {
  id: string
  label: string
  align: 'left' | 'right'
  cellClassName?: string
}

export interface RecordModuleRow {
  id: string
  number: string
  numberHref: string
  cells: Record<string, string>
  statusLabel: string
  statusVariant: 'success' | 'secondary' | 'outline'
  created: string
}

export interface RecordModuleData {
  basePath: string
  typeKey: string
  typeName: string
  newRecordProps: { typeKey: string; typeName: string }
  title: string
  description: string
  canCreate: boolean
  searchPlaceholder: string
  statusLabel: string
  statusOptions: { value: string; label: string; count: number }[]
  filterChips: { paramKey: string; label: string; options: { value: string; label: string; count: number }[] }[]
  currentParams: Record<string, string | string[] | undefined>
  emptyTitle: string
  emptyDescription: string
  isEmpty: boolean
  hasRows: boolean
  columns: RecordModuleColumn[]
  columnStatus: string
  columnCreated: string
  rows: RecordModuleRow[]
  filteredTotal: number
  currentPage: number
  perPage: number
  sort: string
  dir: string
  drawerOpen: boolean
  drawerProps: ({
    typeKey: string
    typeName: string
    sections: FormSection[]
    record: { id: string; recordNumber: string; data: FieldValueMap; status: RecordStatus }
    canEdit: boolean
  } & { remountKey: string }) | null
}

export async function loadRecordModule(
  sp: Record<string, string | string[] | undefined>,
  typeKey: string,
): Promise<RecordModuleData> {
  const authz = await requirePermission('records.read')
  const display = await getMoneyFormatter(authz.user.orgId)
  const t = await getTranslations('records')
  const tc = await getTranslations('common')

  const type = await loadRecordTypeByKey(authz.user.orgId, typeKey)
  if (!type || type.status !== 'published' || !inTypeAudience(authz.user.roles.map(({ key }) => key), type.allowed_roles)) {
    notFound()
  }
  const lint = lintRecordFields(type.fields, type.name)
  if (!lint.success) {
    notFound()
  }
  const sections = lint.sections
  const canCreate = can(authz, 'records.create')

  const basePath = `/records/${typeKey}`
  const columns = listableFields(sections).slice(0, 5)
  const filterFields = columns
    .filter((f) => (f.type === 'select' || f.type === 'radio') && (f.validation?.options?.length ?? 0) > 0)
    .slice(0, 3)

  const listParams = parseListParams(sp, {
    sort: 'created',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['number', 'created', ...columns.map((f) => f.id)],
  })
  const status = pickString(sp.status)
  const showInactive = pickString(sp.showInactive) === 'true'
  const recId = typeof sp.rec === 'string' ? sp.rec : undefined

  const activeFieldFilters = filterFields
    .map((f) => ({ field: f, value: pickString(sp[`f_${f.id}`]) }))
    .filter((x): x is { field: FormField; value: string } => Boolean(x.value))

  const scope = sql`r.org_id = ${authz.user.orgId} and r.type_key = ${typeKey}`
  let where = sql`${scope}
    ${showInactive || status === 'inactive' ? sql`` : sql` and r.status <> 'inactive'`}
    ${status ? sql` and r.status = ${status}` : sql``}
    ${listParams.q ? sql` and (r.search_text ilike ${'%' + listParams.q.toLowerCase() + '%'} or r.record_number ilike ${'%' + listParams.q + '%'})` : sql``}`
  for (const { field, value } of activeFieldFilters) {
    where = sql`${where} and r.data->>${field.id} = ${value}`
  }

  const sortColumn =
    listParams.sort === 'number'
      ? sql`r.record_number`
      : listParams.sort === 'created'
        ? sql`r.created_at`
        : (() => {
            const f = columns.find((c) => c.id === listParams.sort)!
            return isNumericField(f)
              ? sql`nullif(r.data->>${f.id}, '')::numeric`
              : sql`r.data->>${f.id}`
          })()

  const [rows, statusCounts, filterCounts] = await Promise.all([
    (db.execute(sql`
      select r.id, r.record_number, r.data, r.status, r.created_at
        from custom_records r
       where ${where}
       order by ${sortColumn} ${listParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last, r.created_at desc
       limit ${listParams.perPage} offset ${(listParams.page - 1) * listParams.perPage}
    `)),
    (db.execute(sql`
      select r.status, count(*) as n from custom_records r
       where ${scope} ${showInactive || status === 'inactive' ? sql`` : sql`and r.status <> 'inactive'`}
       group by r.status
    `)),
    Promise.all(
      filterFields.map(
        (f) =>
          (db.execute(sql`
            select r.data->>${f.id} as v, count(*) as n
             from custom_records r
             where ${scope}
               ${showInactive || status === 'inactive' ? sql`` : sql`and r.status <> 'inactive'`}
               and r.data->>${f.id} is not null
             group by 1
          `)),
      ),
    ),
  ])
  const total = statusCounts.rows.reduce((a: number, r) => a + Number(r.n), 0)
  const filtered = Boolean(status || listParams.q || activeFieldFilters.length > 0)
  const filteredTotal = filtered
    ? Number(
        ((await db.execute(sql`select count(*) as n from custom_records r where ${where}`)) as any)
          .rows[0].n,
      )
    : total

  const labels = await resolveEntityLabels(
    sections,
    rows.rows.map((r: any) => r.data),
  )

  const openRecord = recId ? await loadRecord(authz.user.orgId, typeKey, recId) : null

  const statusOptions = statusCounts.rows.map((r: any) => ({
    value: r.status,
    label: (RECORD_STATUSES as readonly string[]).includes(r.status)
      ? tc(`status.${r.status}`)
      : String(r.status),
    count: Number(r.n),
  }))

  return {
    basePath,
    typeKey,
    typeName: type.name,
    newRecordProps: { typeKey, typeName: type.name },
    title: type.plural_name,
    description: type.description ?? t('module.defaultDescription', { pluralName: type.plural_name }),
    canCreate,
    searchPlaceholder: t('module.searchPlaceholder', { pluralName: type.plural_name.toLowerCase() }),
    statusLabel: tc('labels.status'),
    statusOptions,
    filterChips: filterFields.map((f) => {
      const counts = new Map<string, number>(
        (filterCounts[filterFields.indexOf(f)]?.rows ?? []).map((r) => [
          String(r.v),
          Number(r.n),
        ]),
      )
      return {
        paramKey: `f_${f.id}`,
        label: f.label,
        options: (f.validation?.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
          count: counts.get(o.value) ?? 0,
        })),
      }
    }),
    currentParams: sp,
    emptyTitle: t('module.emptyTitle', { pluralName: type.plural_name.toLowerCase() }),
    emptyDescription: canCreate
      ? t('module.emptyCreate', { typeName: type.name.toLowerCase() })
      : t('module.emptyNoAccess'),
    isEmpty: total === 0,
    hasRows: total > 0,
    columns: columns.map((f) => ({
      id: f.id,
      label: f.label,
      align: isNumericField(f) ? 'right' : 'left',
      cellClassName: isNumericField(f) ? NUMERIC_CELL : undefined,
    })),
    columnStatus: tc('labels.status'),
    columnCreated: tc('labels.created'),
    rows: rows.rows.map((r: any) => {
      const data = (r.data ?? {}) as Record<string, unknown>
      const cells: Record<string, string> = {}
      for (const f of columns) cells[f.id] = formatFieldValue(f, data[f.id], labels, display)
      return {
        id: String(r.id),
        number: String(r.record_number),
        numberHref: buildListDrawerHref(basePath, sp, 'rec', String(r.id)),
        cells,
        statusLabel: (RECORD_STATUSES as readonly string[]).includes(r.status)
          ? tc(`status.${r.status}`)
          : String(r.status),
        statusVariant: STATUS_VARIANT[r.status] ?? 'secondary',
        created: dateTime(r.created_at),
      }
    }),
    filteredTotal,
    currentPage: listParams.page,
    perPage: listParams.perPage,
    sort: listParams.sort,
    dir: listParams.dir,
    drawerOpen: Boolean(openRecord),
    drawerProps: openRecord
      ? {
          // Remount when deep-linking straight to another record, so view/edit
          // mode and field values reset — the registry strips this into a key.
          remountKey: String(openRecord.id),
          typeKey,
          typeName: type.name,
          sections,
          record: {
            id: openRecord.id,
            recordNumber: openRecord.record_number,
            data: openRecord.data,
            status: openRecord.status,
          },
          canEdit: canCreate,
        }
      : null,
  }
}

const f = ref<RecordModuleData>()
const item = field
const rootF = rootRef<RecordModuleData>()

export function recordModuleSpec(data: RecordModuleData): PageSpec {
  return page({
    route: '/records/[typeKey]',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        // WidgetSlot renders a bare Fragment, so a `when`-off widget leaves no
        // wrapper div behind — matching the native header with no actions.
        actions: [widget('new-record', data.newRecordProps, f('canCreate'))],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: data.basePath,
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.statusLabel,
          options: data.statusOptions,
        }),
        widgetBlock('show-inactives-toggle', {
          basePath: data.basePath,
          currentParams: data.currentParams,
        }),
        ...data.filterChips.map((fc) =>
          widgetBlock('filter-chips', {
            basePath: data.basePath,
            currentParams: data.currentParams,
            paramKey: fc.paramKey,
            label: fc.label,
            options: fc.options,
          }),
        ),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          description: data.emptyDescription,
          action: data.canCreate ? 'new-record' : null,
          actionProps: data.newRecordProps,
        }),
        when: f('isEmpty'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          sorting: { basePath: f('basePath'), sort: f('sort'), dir: f('dir') },
          columns: [
            column('#', link(item('number'), item('numberHref'), LINK), {
              sort: 'number',
              className: NUMBER_CELL,
            }),
            ...data.columns.map((c) =>
              column(
                c.label,
                text(item(`cells.${c.id}`), { fallback: '—', fallbackClassName: DASH_CLASS }),
                { sort: c.id, align: c.align, ...(c.cellClassName ? { className: c.cellClassName } : {}) },
              ),
            ),
            column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
            column(rootF('columnCreated'), text(item('created')), {
              sort: 'created',
              className: MUTED,
            }),
          ],
        }),
        when: f('hasRows'),
      },
      {
        ...pagination({
          basePath: f('basePath'),
          total: f('filteredTotal'),
          page: f('currentPage'),
          perPage: f('perPage'),
        }),
        when: f('hasRows'),
      },
      widgetBlock('record-drawer', { drawer: data.drawerProps }, f('drawerOpen')),
    ],
  })
}
