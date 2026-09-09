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
  type PageSpec,
} from '@openbooks/viewspec'
import { buildListDrawerHref, parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { dateTime } from '../../../../lib/format'
import { BUILT_IN_SCRIPT_KINDS, customRecordTypeKey, isCustomRecordKind } from '../../../../lib/script-kinds'

/**
 * User scripts, split into a loader and a spec.
 *
 * Same admin-list archetype again, and it needed no new vocabulary. The two
 * label resolvers the native page defines inline — trigger enum → message key,
 * and document kind → either a built-in label or a published custom record
 * type's name — run in the loader and reach the spec as plain strings.
 */

// Enum value → message key under admin.scripts. Unknown values render verbatim.
const TRIGGER_KEYS: Record<string, string> = {
  before_submit: 'beforeSubmit',
  before_post: 'beforePost',
  after_post: 'afterPost',
  before_void: 'beforeVoid',
  scheduled: 'scheduled',
  endpoint: 'endpoint',
  bulk: 'bulk',
  client: 'client',
}

export interface ScriptRow {
  id: string
  name: string
  href: string
  trigger: string
  kind: string
  runCount: string
  lastRun: string
  statusLabel: string
  statusVariant: 'success' | 'outline'
}

export interface ScriptsData {
  title: string
  description: string
  backHref: string
  backLabel: string
  searchPlaceholder: string
  triggerFilterLabel: string
  triggerOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  emptyLabel: string
  columnScript: string
  columnTrigger: string
  columnKind: string
  columnRuns: string
  columnLastRun: string
  columnStatus: string
  rows: ScriptRow[]
  total: number
  currentPage: number
  perPage: number
  drawerOpen: boolean
  drawerScript: Record<string, unknown> | null
  drawerRuns: Record<string, unknown>[]
  customTypes: { key: string; name: string }[]
}

export async function loadScripts(
  sp: Record<string, string | string[] | undefined>,
): Promise<ScriptsData> {
  const authz = await requirePermission('scripts.manage')
  await requireFeatureEnabled(authz.user.orgId, 'scripts')
  const orgId = authz.user.orgId
  const t = await getTranslations('admin.scripts')
  const tHub = await getTranslations('admin.hub')
  const params = parseListParams(sp, { sort: 'name', allowedSorts: ['name'] as const, perPage: 50 })
  const trigger = pickString(sp.trigger)
  const scriptId = pickString(sp.script)

  const where = sql`org_id = ${orgId}
    ${trigger ? sql` and trigger_point = ${trigger}` : sql``}
    ${params.q ? sql` and name ilike ${'%' + params.q + '%'}` : sql``}`

  const [scripts, triggers, totalRow, open, runs, customTypes] = await Promise.all([
    db.execute(sql`
      select s.*, (select count(*) from script_runs r where r.script_id = s.id) as run_count,
             (select max(r.at) from script_runs r where r.script_id = s.id) as last_run
        from user_scripts s where ${where}
       order by s.trigger_point, s.sort_order, s.name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}`),
    db.execute<{ trigger_point: string; n: string }>(sql`
      select trigger_point, count(*) as n from user_scripts where org_id = ${orgId} group by 1`),
    db.execute<{ n: string }>(sql`select count(*) as n from user_scripts where ${where}`),
    scriptId && scriptId !== 'new'
      ? db.execute(sql`select * from user_scripts where id = ${scriptId} and org_id = ${orgId}`)
      : null,
    scriptId && scriptId !== 'new'
      ? db.execute(sql`
          select status, error_message, logs, duration_ms, at, target_kind
            from script_runs where script_id = ${scriptId} and org_id = ${orgId} order by at desc limit 20`)
      : null,
    db.execute<{ key: string; name: string }>(sql`
      select key, name from custom_record_types
       where org_id = ${orgId} and status = 'published' order by name`),
  ])

  const customTypeName = new Map<string, string>(
    customTypes.rows.map((r) => [String(r.key), String(r.name)]),
  )
  const builtInKindKey = new Map(BUILT_IN_SCRIPT_KINDS.map((k) => [k.value, k.labelKey]))

  const triggerLabel = (v: string) =>
    TRIGGER_KEYS[v] ? t(`triggers.${TRIGGER_KEYS[v]}`) : v.replace('_', ' ')
  const kindLabel = (v: string) => {
    if (isCustomRecordKind(v)) return customTypeName.get(customRecordTypeKey(v)) ?? customRecordTypeKey(v)
    const labelKey = builtInKindKey.get(v)
    return labelKey ? t(labelKey) : v
  }

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    searchPlaceholder: t('searchPlaceholder'),
    triggerFilterLabel: t('triggerFilter'),
    triggerOptions: triggers.rows.map((r) => ({
      value: String(r.trigger_point),
      label: triggerLabel(String(r.trigger_point)),
      count: Number(r.n),
    })),
    currentParams: sp,
    emptyLabel: t('empty'),
    columnScript: t('table.script'),
    columnTrigger: t('table.trigger'),
    columnKind: t('table.kind'),
    columnRuns: t('table.runs'),
    columnLastRun: t('table.lastRun'),
    columnStatus: t('table.status'),
    rows: scripts.rows.map((s) => ({
      id: String(s.id),
      name: String(s.name),
      href: buildListDrawerHref('/admin/scripts', sp, 'script', String(s.id)),
      trigger: triggerLabel(String(s.trigger_point)),
      kind: s.document_kind ? kindLabel(String(s.document_kind)) : t('allKinds'),
      runCount: String(s.run_count),
      lastRun: s.last_run ? dateTime(String(s.last_run)) : '',
      statusLabel: s.is_active ? t('statusActive') : t('statusDisabled'),
      statusVariant: s.is_active ? 'success' : 'outline',
    })),
    total: Number(totalRow.rows[0]?.n ?? 0),
    currentPage: params.page,
    perPage: params.perPage,
    drawerOpen: Boolean(scriptId),
    drawerScript: (open?.rows[0] as Record<string, unknown> | undefined) ?? null,
    drawerRuns: (runs?.rows as Record<string, unknown>[] | undefined) ?? [],
    customTypes: customTypes.rows.map((r) => ({ key: String(r.key), name: String(r.name) })),
  }
}

const f = ref<ScriptsData>()
const item = field
const rootF = rootRef<ScriptsData>()

const MUTED = 'text-slate-500 dark:text-slate-400'
const LINK = 'font-medium text-teal-700 hover:underline dark:text-teal-300'

export function scriptsSpec(data: ScriptsData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
        actions: [widget('new-script')],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/admin/scripts',
          currentParams: data.currentParams,
          paramKey: 'trigger',
          label: data.triggerFilterLabel,
          options: data.triggerOptions,
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
          column(rootF('columnScript'), link(item('name'), item('href'), LINK)),
          column(rootF('columnTrigger'), badge(item('trigger'), { variant: 'secondary' })),
          column(rootF('columnKind'), text(item('kind')), { className: MUTED }),
          column(rootF('columnRuns'), text(item('runCount')), {
            align: 'right',
            className: 'tabular-nums',
          }),
          column(rootF('columnLastRun'), text(item('lastRun')), { className: MUTED }),
          column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
        ],
      }),
      pagination({
        basePath: '/admin/scripts',
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
      }),
      widgetBlock(
        'script-drawer',
        { script: data.drawerScript, runs: data.drawerRuns, customTypes: data.customTypes },
        f('drawerOpen'),
      ),
    ],
  })
}
