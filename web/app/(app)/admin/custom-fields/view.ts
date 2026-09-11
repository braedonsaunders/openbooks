import 'server-only'

import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { documentRevisionSql } from '@openbooks/engine/src/document-revision.ts'
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
import { requirePermission } from '../../../../lib/authz'
import { buildListDrawerHref, parseListParams, pickString, isUuid } from '../../../../lib/list-params'
import { disabledCustomFieldTargets } from '../../../../lib/customization/gates'

/**
 * Custom field definitions, split into a loader and a spec.
 *
 * Same admin-list archetype as API keys, with a filter-chip bar. The one new
 * behaviour it forced: an affix whose value is empty must render NOTHING
 * rather than an empty span — the target cell is
 * `{table}{kind ? <span>:{kind}</span> : null}`, and most rows have no kind.
 *
 * The visibility gating (disabled targets, notFound on a hidden or missing
 * definition) stays in the loader. It is authorization, not presentation, and
 * a spec must never be able to express or bypass it.
 */

// field_type enum value → admin.customFields.types.* message key. Unknown
// values (shouldn't happen) render the raw code.
const TYPE_KEYS: Record<string, string> = {
  text: 'text',
  long_text: 'longText',
  number: 'number',
  currency: 'currency',
  date: 'date',
  boolean: 'boolean',
  select: 'select',
  multi_select: 'multiSelect',
  reference: 'reference',
}

export interface CustomFieldRow {
  id: string
  label: string
  href: string
  key: string
  targetTable: string
  targetKindSuffix: string
  typeLabel: string
  required: string
  statusLabel: string
  statusVariant: 'success' | 'outline'
}

export interface CustomFieldsData {
  title: string
  description: string
  backHref: string
  backLabel: string
  searchPlaceholder: string
  targetFilterLabel: string
  targetOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  emptyLabel: string
  columnField: string
  columnKey: string
  columnTarget: string
  columnType: string
  columnRequired: string
  columnStatus: string
  rows: CustomFieldRow[]
  total: number
  currentPage: number
  perPage: number
  drawerOpen: boolean
  drawerDef: Record<string, unknown> | null
  hiddenKinds: string[]
  hiddenTables: string[]
}

export async function loadCustomFields(
  sp: Record<string, string | string[] | undefined>,
): Promise<CustomFieldsData> {
  const authz = await requirePermission('admin.custom_fields.manage')
  const t = await getTranslations('admin.customFields')
  const tCommon = await getTranslations('common')
  const tHub = await getTranslations('admin.hub')
  const params = parseListParams(sp, { sort: 'target', allowedSorts: ['target'] as const, perPage: 100 })
  const target = pickString(sp.target)
  const fieldId = pickString(sp.field)
  if (fieldId && fieldId !== 'new' && !isUuid(fieldId)) notFound()
  const orgId = authz.user.orgId
  const hidden = await disabledCustomFieldTargets(orgId)
  if (target && hidden.tables.includes(target)) notFound()

  const kindHide =
    hidden.kinds.length === 0
      ? sql`true`
      : sql`(target_kind is null or target_kind not in (${sql.join(hidden.kinds.map((k) => sql`${k}`), sql`, `)}))`
  const tableHide =
    hidden.tables.length === 0
      ? sql`true`
      : sql`not (target_kind is null and target_table in (${sql.join(hidden.tables.map((x) => sql`${x}`), sql`, `)}))`

  const where = sql`org_id = ${orgId} and ${kindHide} and ${tableHide}
    ${target ? sql` and target_table = ${target}` : sql``}
    ${params.q ? sql` and (label ilike ${'%' + params.q + '%'} or key ilike ${'%' + params.q + '%'})` : sql``}`

  const [defs, counts, totalRow, open] = await Promise.all([
    db.execute(sql`
      select id, target_table, target_kind, key, label, field_type, config, is_required, is_active, sort_order
        from custom_field_defs where ${where}
       order by target_table, target_kind nulls first, sort_order, label
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}`),
    db.execute<{ target_table: string; n: string }>(sql`
      select target_table, count(*) as n from custom_field_defs
       where org_id = ${orgId} and ${kindHide} and ${tableHide} group by 1`),
    db.execute<{ n: string }>(sql`select count(*) as n from custom_field_defs where ${where}`),
    fieldId && fieldId !== 'new'
      ? db.execute(sql`
          select custom_field_defs.*, ${documentRevisionSql(sql`updated_at`)} as updated_at
            from custom_field_defs where id = ${fieldId} and org_id = ${orgId}`)
      : null,
  ])

  const openRow = (open?.rows[0] as Record<string, unknown> | undefined) ?? null
  if (fieldId && fieldId !== 'new' && !openRow) notFound()
  if (
    openRow &&
    (hidden.kinds.includes(openRow.target_kind as string) ||
      (openRow.target_kind == null && hidden.tables.includes(openRow.target_table as string)))
  ) {
    notFound()
  }

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    searchPlaceholder: t('searchPlaceholder'),
    targetFilterLabel: t('targetFilter'),
    targetOptions: counts.rows.map((r) => ({
      value: String(r.target_table),
      label: String(r.target_table),
      count: Number(r.n),
    })),
    currentParams: sp,
    emptyLabel: t('empty'),
    columnField: t('table.field'),
    columnKey: t('table.key'),
    columnTarget: t('table.target'),
    columnType: t('table.type'),
    columnRequired: t('table.required'),
    columnStatus: t('table.status'),
    rows: defs.rows.map((d) => ({
      id: String(d.id),
      label: String(d.label),
      href: buildListDrawerHref('/admin/custom-fields', sp, 'field', String(d.id)),
      key: String(d.key),
      targetTable: String(d.target_table),
      targetKindSuffix: d.target_kind ? `:${d.target_kind}` : '',
      typeLabel: TYPE_KEYS[String(d.field_type)]
        ? t(`types.${TYPE_KEYS[String(d.field_type)]}.label`)
        : String(d.field_type),
      required: d.is_required ? tCommon('labels.yes') : '',
      statusLabel: d.is_active ? t('statusActive') : t('statusArchived'),
      statusVariant: d.is_active ? 'success' : 'outline',
    })),
    total: Number(totalRow.rows[0]?.n ?? 0),
    currentPage: params.page,
    perPage: params.perPage,
    drawerOpen: Boolean(fieldId),
    drawerDef: openRow,
    hiddenKinds: hidden.kinds,
    hiddenTables: hidden.tables,
  }
}

const f = ref<CustomFieldsData>()
const item = field
const rootF = rootRef<CustomFieldsData>()

const MUTED = 'text-slate-500 dark:text-slate-400'
const LINK = 'font-medium text-teal-700 hover:underline dark:text-teal-300'

export function customFieldsSpec(data: CustomFieldsData): PageSpec {
  return page({
    route: '/admin/custom-fields',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
        actions: [widget('new-custom-field')],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/admin/custom-fields',
          currentParams: data.currentParams,
          paramKey: 'target',
          label: data.targetFilterLabel,
          options: data.targetOptions,
        }),
      ]),
    ],
    body: [
      table({
        variant: 'app',
        rows: f('rows'),
        rowKey: item('id'),
        emptyRow: { text: f('emptyLabel'), colSpan: 6, className: MUTED },
        columns: [
          column(rootF('columnField'), link(item('label'), item('href'), LINK)),
          column(rootF('columnKey'), text(item('key')), { className: 'font-mono text-xs text-slate-500' }),
          column(
            rootF('columnTarget'),
            text(item('targetTable'), { suffix: { field: item('targetKindSuffix'), className: 'text-slate-400' } }),
            { className: 'font-mono text-xs' },
          ),
          column(rootF('columnType'), badge(item('typeLabel'), { variant: 'secondary' })),
          column(rootF('columnRequired'), text(item('required'))),
          column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
        ],
      }),
      pagination({
        basePath: '/admin/custom-fields',
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
      }),
      widgetBlock(
        'custom-field-drawer',
        { def: data.drawerDef, hiddenKinds: data.hiddenKinds, hiddenTables: data.hiddenTables },
        f('drawerOpen'),
      ),
    ],
  })
}
