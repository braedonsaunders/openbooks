import { getMoneyFormatter } from '@/lib/money-server'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { Eye } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { getRecordType, listColumnMeta } from '@openbooks/customization'
import { SearchInput } from './search-input'
import { FilterChips } from './filter-bar'
import { ShowInactivesToggle } from './show-inactives-toggle'
import { Pagination } from './pagination'
import { SortTh } from './sortable-th'
import { ViewsMenu } from './views-menu'
import { buildListDrawerHref, parseListParams, pickString } from '../lib/list-params'
import { allowedSubsidiaryIds } from '../lib/subsidiaries'
import { loadFieldDefs } from '../lib/custom-fields'
import { resolveListView } from '../lib/customization/resolve'
import { columnDescriptors, type ListColDesc } from '../lib/customization/list-query'
import { entityListSource } from '../lib/list/entity-sources'

/**
 * The universal ENTITY list — the non-`documents` twin of RecordListView. Renders
 * any plain-table list registered in lib/list/entity-sources (customers, projects)
 * with the same machinery: search + status/billing filter chips + saved-view
 * switcher, a sortable table whose cells are typed from the customization
 * registry, and pagination. Column set, order, labels, filters and sort come
 * from the resolved saved view — so list customization works here too.
 *
 * The page owns only its header (title/new button) and the drawer.
 */

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'secondary' | 'warning' | 'outline' | 'destructive'> = {
  customer: 'success',
  prospect: 'warning',
  quoted: 'secondary',
  awarded: 'warning',
  active: 'success',
  substantially_complete: 'default',
  closed: 'outline',
  cancelled: 'destructive',
}

export async function EntityListView({
  recordType,
  orgId,
  userId,
  canManage,
  sp,
  drawer,
  emptyAction,
}: {
  recordType: string
  orgId: string
  userId: string
  canManage: boolean
  sp: Record<string, string | string[] | undefined>
  drawer?: ReactNode
  emptyAction?: ReactNode
}) {
  const { money } = await getMoneyFormatter()
  const source = entityListSource(recordType)
  const meta = getRecordType(recordType)
  if (!source || !meta) throw new Error(`no entity list source registered for record type "${recordType}"`)
  const basePath = source.basePath

  const t = await getTranslations()
  const tCommon = await getTranslations('common')
  const tCustom = await getTranslations('customization')
  const label = (key: string) => {
    try {
      return t(key as never)
    } catch {
      return key
    }
  }

  // Custom (cf_*) list columns come from the field defs with showInList set.
  const headerDefs = await loadFieldDefs(source.customFieldTable)
  const showInListDefs = headerDefs.filter((d) => d.config.showInList)

  const resolvedView = await resolveListView({
    orgId,
    userId,
    recordType,
    viewId: pickString(sp.view),
    showInListDefs,
  })
  const view = resolvedView.view
  const viewName = resolvedView.row?.name ?? tCustom('views.defaultName')

  const allowedSorts = meta.listColumns.filter((c) => c.sortable && c.sortKey).map((c) => c.sortKey!) as string[]
  const viewSortKey = view.sort ? listColumnMeta(recordType, view.sort.column)?.sortKey : undefined
  const defaultSort =
    viewSortKey && allowedSorts.includes(viewSortKey) ? viewSortKey : (allowedSorts[0] ?? 'name')
  const params = parseListParams(sp, {
    sort: defaultSort,
    dir: view.sort?.dir ?? 'asc',
    perPage: view.perPage ?? 25,
    allowedSorts,
  })

  const requestedStatus = pickString(sp.status)
  const viewOwnsStatus = view.filters.some((filter) => filter.key === 'status')
  const defaultStatus = viewOwnsStatus ? undefined : source.defaultStatus
  const status = requestedStatus === 'all' ? undefined : (requestedStatus ?? defaultStatus)
  const billing = pickString(sp.billing)
  const showInactive = pickString(sp.showInactive) === 'true'

  const labels: Record<string, string> = { actions: tCommon('labels.actions') }
  for (const c of meta.listColumns) labels[c.key] = label(c.labelKey)

  const cols = columnDescriptors(recordType, view, showInListDefs, source.builtInExpr, labels, source.alias)
  const selectCols = sql.join(
    cols.filter((c) => c.expr).map((c) => sql`${c.expr} as ${sql.raw(`"${c.key}"`)}`),
    sql`, `,
  )
  const allowedSubs = await allowedSubsidiaryIds(userId)
  const adhoc = { q: params.q, status, billing, showInactive }
  const where = source.where(view, adhoc, orgId, allowedSubs)
  // Counts ignore the ad-hoc status selection so every status remains visible
  // in the picker, while retaining saved-view scope and entity de-duplication.
  const countView = { ...view, filters: view.filters.filter((filter) => filter.key !== 'status') }
  const countWhere = source.where(countView, { showInactive }, orgId, allowedSubs)
  const orderExpr = source.sorts[params.sort] ?? source.defaultSort
  const aliasSql = sql.raw(source.alias)
  const tableSql = sql.raw(`${source.table} ${source.alias}`)
  const statusExpr = source.statusExpr ?? sql`${aliasSql}.status`

  const [rowsRes, statusCounts, totalRow] = await Promise.all([
    db.execute(sql`
      select ${aliasSql}.id${source.extraSelect ? sql`, ${source.extraSelect}` : sql``}, ${selectCols}
        from ${tableSql}
        ${source.baseJoins}
       where ${where}
       order by ${orderExpr} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select ${statusExpr} as status, count(*) as n from ${tableSql}
        ${source.baseJoins}
       where ${countWhere}
       group by ${statusExpr}`) as any,
    db.execute(sql`
      select count(*) as n from ${tableSql}
        ${source.baseJoins}
       where ${where}`) as any,
  ])
  const rows = rowsRes.rows as any[]
  const total = statusCounts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filteredTotal = Number(totalRow.rows[0].n)

  // Enum value → display label, resolved from any list filter that carries an
  // option set (status, project_type…). Lets both the chips and the table
  // cells show localized labels instead of raw codes.
  const optionLabel = (colKey: string, value: string): string => {
    const f = meta.listFilters.find((flt) => flt.key === colKey)
    const opt = f?.options?.find((o) => o.value === value)
    return opt ? (opt.labelKey ? label(opt.labelKey) : opt.value) : value.replace(/_/g, ' ')
  }

  // Status chips: registry option set (value + labelKey) with data counts.
  const statusFilterMeta = meta.listFilters.find((f) => f.key === 'status')
  const statusCountByValue = new Map(statusCounts.rows.map((r: any) => [String(r.status), Number(r.n)]))
  const statusOptions = (statusFilterMeta?.options ?? []).map((o) => ({
    value: o.value,
    label: o.labelKey ? label(o.labelKey) : o.value,
    count: Number(statusCountByValue.get(o.value) ?? 0),
  }))
  const billingFilterMeta = meta.listFilters.find((f) => f.key === 'project_type')
  const billingOptions = (billingFilterMeta?.options ?? []).map((o) => ({
    value: o.value,
    label: o.labelKey ? label(o.labelKey) : o.value,
  }))

  const openHref = (id: string) =>
    buildListDrawerHref(basePath, sp, source.drawerParam, id)

  const cell = (row: any, c: ListColDesc) => {
    const v = row[c.key]
    switch (c.kind) {
      case 'reference': {
        const href = openHref(String(row.id))
        return (
          <TableCell key={c.key} className="font-medium">
            <Link
              href={href as any}
              title={String(v ?? '')}
              className="block max-w-[18rem] truncate text-teal-700 hover:underline dark:text-teal-300"
            >
              {String(v ?? '')}
            </Link>
          </TableCell>
        )
      }
      case 'amount':
        return (
          <TableCell key={c.key} className="text-right tabular-nums">
            {v == null || v === '' ? <span className="text-slate-400">—</span> : money(v)}
          </TableCell>
        )
      case 'status':
        return (
          <TableCell key={c.key}>
            <Badge variant={STATUS_VARIANT[String(v)] ?? 'secondary'}>{optionLabel(c.key, String(v))}</Badge>
          </TableCell>
        )
      case 'date':
        return (
          <TableCell key={c.key} className="whitespace-nowrap text-slate-600 dark:text-slate-400">
            {v == null || v === '' ? <span className="text-slate-400">—</span> : String(v)}
          </TableCell>
        )
      case 'custom': {
        const def = showInListDefs.find((d) => d.key === c.defKey)
        let display: string
        if (Array.isArray(v)) display = v.join(', ')
        else if (def?.fieldType === 'boolean') display = v ? tCommon('labels.yes') : tCommon('labels.no')
        else display = v != null && v !== '' ? String(v) : '—'
        return <TableCell key={c.key} className="text-slate-700 dark:text-slate-300">{display}</TableCell>
      }
      case 'actions':
        return (
          <TableCell key={c.key} className="w-px whitespace-nowrap px-2 text-center" style={{ width: 44 }}>
            <Link
              href={openHref(String(row.id)) as any}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-teal-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-teal-300"
              aria-label={tCommon('actions.open')}
              title={tCommon('actions.open')}
            >
              <Eye size={15} />
            </Link>
          </TableCell>
        )
      default: {
        const hasOptions = meta.listFilters.some((f) => f.key === c.key && f.options?.length)
        const display = v == null || v === '' ? '—' : hasOptions ? optionLabel(c.key, String(v)) : String(v)
        return (
          <TableCell key={c.key} className={v == null || v === '' ? 'text-slate-400' : 'text-slate-600 dark:text-slate-400'}>
            <span className="block max-w-[16rem] truncate" title={display}>{display}</span>
          </TableCell>
        )
      }
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={tCommon('actions.search')} />
        {statusOptions.length ? (
          <FilterChips
            basePath={basePath}
            currentParams={sp}
            paramKey="status"
            label={tCommon('labels.status')}
            options={statusOptions}
            defaultValue={defaultStatus}
          />
        ) : null}
        {billingOptions.length ? (
          <FilterChips basePath={basePath} currentParams={sp} paramKey="billing" label={billingFilterMeta ? label(billingFilterMeta.labelKey) : ''} options={billingOptions} />
        ) : null}
        {source.hasInactive ? <ShowInactivesToggle basePath={basePath} currentParams={sp} /> : null}
        <ViewsMenu
          available={resolvedView.available}
          currentId={resolvedView.row?.id ?? null}
          currentName={viewName}
          recordType={recordType}
          basePath={basePath}
          currentParams={sp}
          canManage={canManage}
        />
      </div>
      {total === 0 ? (
        <div className="mt-4">
          <EmptyState title={tCommon('empty.title')} description={tCommon('empty.description')} action={emptyAction} />
        </div>
      ) : (
        <div className="mt-3">
          <Table>
            <TableHeader>
              <TableRow>
                {cols.map((c) =>
                  c.sortable && c.sortKey ? (
                    <SortTh
                      key={c.key}
                      basePath={basePath}
                      currentParams={sp}
                      column={c.sortKey}
                      sort={params.sort}
                      dir={params.dir}
                      align={c.kind === 'amount' ? 'right' : undefined}
                    >
                      {c.label}
                    </SortTh>
                  ) : (
                    <TableHead
                      key={c.key}
                      className={c.kind === 'amount' ? 'text-right' : c.kind === 'actions' ? 'w-px px-2 text-center' : undefined}
                      style={c.kind === 'actions' ? { width: 64 } : c.width ? { width: c.width } : undefined}
                    >
                      {c.label}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>{cols.map((c) => cell(row, c))}</TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath={basePath} currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </div>
      )}
      {drawer}
    </>
  )
}
