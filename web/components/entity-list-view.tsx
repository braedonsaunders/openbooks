import { getMoneyFormatter } from '@/lib/money-server'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { Eye } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { getRecordType, listColumnMeta, recordTypeForFeatureState } from '@openbooks/customization'
import { isFeatureEnabled } from '../lib/features'
import { SearchInput } from './search-input'
import { FilterChips } from './filter-bar'
import { ShowInactivesToggle } from './show-inactives-toggle'
import { Pagination } from './pagination'
import { SortTh } from './sortable-th'
import { ViewsMenu } from './views-menu'
import { buildListDrawerHref, parseListParams, pickString } from '../lib/list-params'
import { allowedSubsidiaryIds } from '../lib/subsidiaries'
import { loadFieldDefs } from '../lib/custom-fields'
import { AmbiguousListViewDefaultError, resolveListView } from '../lib/customization/resolve'
import { displayListViewName } from '../lib/customization/display'
import { columnDescriptors, type ListColDesc } from '../lib/customization/list-query'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import {
  customerBaseJoins,
  customerBuiltInExpr,
  customerSorts,
  customerStatusExpr,
  employeeBaseJoins,
  employeeBuiltInExpr,
  employeeSorts,
  EMPLOYEE_HRM_FILTER_KEYS,
} from '../lib/customization/entity-list-query'
import { entityListSource, entityOrderClause, plannedPageClauses } from '../lib/list/entity-sources'
import { ReportDrillLink } from '../app/(app)/reports/ReportDrillLink'
import { resolvePeriod } from '../lib/periods'
import { DRILL_LINK_CLASS } from './viewspec/tone'

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
  // The relationship lifecycle reads as one ramp: unqualified → worked → won.
  lead: 'outline',
  customer: 'success',
  prospect: 'warning',
  quoted: 'secondary',
  awarded: 'warning',
  active: 'success',
  substantially_complete: 'default',
  closed: 'outline',
  cancelled: 'destructive',
}

/** Quick filters that read the CRM profile joins (see customerBaseJoins). */
const CUSTOMER_CRM_QUICK_FILTERS = new Set(['status_id', 'owner_user_id', 'territory_id'])

/** Quick filters that read the employment joins (see employeeBaseJoins). */
const EMPLOYEE_HRM_QUICK_FILTERS = new Set<string>(EMPLOYEE_HRM_FILTER_KEYS)

export async function EntityListView({
  recordType,
  orgId,
  userId,
  canManage,
  sp,
  drawer,
  emptyAction,
  formatValue,
  crmAccountsVisible = true,
  hrmEmploymentVisible = true,
  scopePredicate,
}: {
  recordType: string
  /** Additional trusted server-side authorization, shared by rows AND counts.
   * It only narrows the source's mandatory tenant/entity predicate. */
  scopePredicate?: SQL
  orgId: string
  userId: string
  canManage: boolean
  /**
   * `crm.accounts.read`, resolved by the page. The customer list spans the
   * relationship lifecycle only for a viewer who may READ relationships;
   * without it the list collapses to the AR customer roll, because leads and
   * prospects are CRM records and `parties.read` alone has never been enough
   * to see one. Resolved by the caller rather than read here: this renders
   * inside tests and background paths where `cookies()` has no request scope.
   */
  crmAccountsVisible?: boolean
  /**
   * `hrm.employment.read`, resolved by the slot. The employee list's
   * employment filters and columns belong to the HRM read surface: a
   * viewer holding only `parties.read` sees the roster without them.
   * Resolved by the caller rather than read here, the way
   * `crmAccountsVisible` already is.
   */
  hrmEmploymentVisible?: boolean
  sp: Record<string, string | string[] | undefined>
  drawer?: ReactNode
  emptyAction?: ReactNode
  formatValue?: (row: Record<string, unknown>, columnKey: string, value: unknown) => ReactNode
}) {
  const { money } = await getMoneyFormatter()
  const source = entityListSource(recordType)
  const catalog = getRecordType(recordType)
  const [inventoryOn, crmFeatureOn, hrmFeatureOn] = await Promise.all([
    isFeatureEnabled(orgId, 'inventory'),
    recordType === 'customer' ? isFeatureEnabled(orgId, 'crm') : Promise.resolve(true),
    recordType === 'employee' ? isFeatureEnabled(orgId, 'hrm') : Promise.resolve(true),
  ])
  const crmOn = recordType === 'customer' ? crmFeatureOn && crmAccountsVisible : crmFeatureOn
  // The employment filters and columns belong to the HRM read surface: the
  // feature switch plus the employment read grant. Either off, they are
  // absent from the roster — never rendered empty.
  const hrmOn = recordType === 'employee' ? hrmFeatureOn && hrmEmploymentVisible : true
  const meta = catalog
    ? recordTypeForFeatureState(catalog, { inventory: inventoryOn, crm: crmOn, hrm: hrmOn })
    : catalog
  if (!source || !meta) throw new Error(`no entity list source registered for record type "${recordType}"`)
  const basePath = source.basePath
  const builtInExpr = recordType === 'customer'
    ? customerBuiltInExpr(crmOn)
    : recordType === 'employee' ? employeeBuiltInExpr(hrmOn) : source.builtInExpr
  const sorts = recordType === 'customer'
    ? customerSorts(crmOn)
    : recordType === 'employee' ? employeeSorts(hrmOn) : source.sorts

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
  const headerDefs = source.customFieldTable
    ? await loadFieldDefs(source.customFieldTable, source.customFieldKind)
    : []
  const showInListDefs = headerDefs.filter((d) => d.config.showInList)

  let resolvedView
  try {
    resolvedView = await resolveListView({
      orgId,
      userId,
      recordType,
      viewId: pickString(sp.view),
      showInListDefs,
    })
  } catch (error) {
    // Next.js error.tsx sanitizes thrown messages to a digest. Catch here so
    // the operator sees the named remedy, the way HRM leave renders refusals.
    if (error instanceof AmbiguousListViewDefaultError) {
      return (
        <>
          <PageHeader title={tCustom('views.defaultName')} description={error.message} />
          <EmptyState description={error.message} />
        </>
      )
    }
    throw error
  }
  const view = resolvedView.view
  const viewName = displayListViewName(resolvedView.row?.name, tCustom('views.defaultName'))

  const allowedSorts = meta.listColumns.filter((c) => c.sortable && c.sortKey).map((c) => c.sortKey!) as string[]
  const viewSortKey = view.sort ? listColumnMeta(recordType, view.sort.column)?.sortKey : undefined
  // A saved view wins; otherwise the record type's declared default; otherwise
  // the first sortable column ascending.
  const metaDefault = meta.defaultSort && allowedSorts.includes(meta.defaultSort.sortKey)
    ? meta.defaultSort
    : undefined
  // Column AND direction move together. A seeded org default nobody edited
  // resolves to the LIVE registry default in resolveListView, so `view.sort`
  // here already follows the registry for untouched seeds; only genuinely
  // edited views carry a stored direction. A view whose stored column has
  // since left the registry (or lost `sortable`) must surrender its direction
  // with it — keeping the direction alone silently paired "name" with a dated
  // column's `desc` and listed customers Z→A.
  const viewSort = viewSortKey && allowedSorts.includes(viewSortKey)
    ? { sortKey: viewSortKey, dir: view.sort!.dir }
    : undefined
  const effectiveSort = viewSort ?? metaDefault
  const params = parseListParams(sp, {
    sort: effectiveSort?.sortKey ?? allowedSorts[0] ?? 'name',
    dir: effectiveSort?.dir ?? 'asc',
    perPage: view.perPage ?? 25,
    allowedSorts,
  })

  const showInactive = pickString(sp.showInactive) === 'true'

  // The CRM segments/filters vanish with the lifecycle they read — their
  // option loaders would query crm_account_statuses for an org that has no
  // CRM, and their predicates would reference joins that are not in the FROM.
  // The employment filters vanish the same way while HRM is off.
  const quickFilterDefs = recordType === 'customer' && !crmOn
    ? source.quickFilters.filter((quick) => !CUSTOMER_CRM_QUICK_FILTERS.has(quick.filterKey))
    : recordType === 'employee' && !hrmOn
      ? source.quickFilters.filter((quick) => !EMPLOYEE_HRM_QUICK_FILTERS.has(quick.filterKey))
      : source.quickFilters

  const quickValues: Record<string, string | undefined> = {}
  const quickDefaults: Record<string, string | undefined> = {}
  for (const quick of quickFilterDefs) {
    const requested = pickString(sp[quick.paramKey])
    const defaultValue = view.filters.some((filter) => filter.key === quick.filterKey)
      ? undefined
      : quick.defaultValue
    quickDefaults[quick.filterKey] = defaultValue
    quickValues[quick.filterKey] = requested === 'all' ? undefined : (requested ?? defaultValue)
  }

  const labels: Record<string, string> = { actions: tCommon('labels.actions') }
  for (const c of meta.listColumns) labels[c.key] = label(c.labelKey)

  const cols = columnDescriptors(recordType, view, showInListDefs, builtInExpr, labels, source.customFieldAlias ?? source.alias)
  const selectCols = sql.join(
    cols.filter((c) => c.expr).map((c) => sql`${c.expr} as ${sql.raw(`"${c.key}"`)}`),
    sql`, `,
  )
  const [allowedSubs, today] = await Promise.all([
    allowedSubsidiaryIds(userId, orgId),
    businessToday(orgId),
  ])
  const currentPeriod = source.columnDrill
    ? await resolvePeriod('this_period', { today, orgId })
    : null
  const adhoc = {
    q: params.q,
    filters: quickValues,
    showInactive,
    crmEnabled: recordType === 'customer' ? crmOn : undefined,
    hrmEnabled: recordType === 'employee' ? hrmOn : undefined,
  }
  const narrow = (predicate: SQL) => scopePredicate ? sql`(${predicate}) and (${scopePredicate})` : predicate
  const where = narrow(source.where(view, adhoc, orgId, allowedSubs))
  // Counts ignore the ad-hoc status selection so every status remains visible
  // in the picker, while retaining saved-view scope and entity de-duplication.
  const countFilterKey = source.countFilterKey ?? 'status'
  const countView = { ...view, filters: view.filters.filter((filter) => filter.key !== countFilterKey) }
  // The count's adhoc must carry the SAME feature context as the page's, or
  // the two disagree about which shape the query has: the customer builder
  // reads `crmEnabled` to decide both the status expression and the
  // role-or-profile membership clause, and a count that assumes CRM is on
  // emits a predicate over joins the CRM-off FROM never made.
  const countWhere = narrow(source.where(
    countView,
    { showInactive, filters: {}, crmEnabled: adhoc.crmEnabled, hrmEnabled: adhoc.hrmEnabled },
    orgId,
    allowedSubs,
  ))
  const orderExpr = sorts[params.sort] ?? source.defaultSort
  const aliasSql = sql.raw(source.alias)
  const idExpr = source.idExpr ?? sql`${aliasSql}.id`
  const tableSql = typeof source.table === 'function'
    ? sql`${source.table(orgId)} ${sql.raw(source.alias)}`
    : sql.raw(`${source.table} ${source.alias}`)
  const statusExpr = recordType === 'customer'
    ? customerStatusExpr(crmOn)
    : (source.statusExpr ?? sql`${aliasSql}.status`)
  const baseJoins = recordType === 'customer'
    ? customerBaseJoins(crmOn)
    : recordType === 'employee'
      ? employeeBaseJoins(hrmOn, today, allowedSubs)
      : (typeof source.baseJoins === 'function' ? source.baseJoins(allowedSubs, today) : source.baseJoins)
  const countJoinsSource = source.countJoins ?? source.baseJoins
  const countJoins = recordType === 'customer'
    ? customerBaseJoins(crmOn)
    : recordType === 'employee'
      ? employeeBaseJoins(hrmOn, today, allowedSubs)
      : (typeof countJoinsSource === 'function' ? countJoinsSource(allowedSubs, today) : countJoinsSource)

  // Planned page ids for sorts SQL cannot serve without a per-row scan (see
  // `orderedPageIds`): the page reads by id membership ordered by array
  // position, so no query on this path touches journal lines per row.
  const plannedIds = source.orderedPageIds
    ? await source.orderedPageIds({ orgId, sort: params.sort, dir: params.dir, tableSql, baseJoins, where })
    : null
  const planned = plannedIds ? plannedPageClauses(plannedIds, idExpr) : null
  const pageWhere = planned ? planned.where : where
  const pageOrder = planned ? planned.order : entityOrderClause(source, orderExpr, params.dir)
  const [rowsRes, statusCounts, totalRow, loadedQuickOptions] = await Promise.all([
    (db.execute(sql`
      select ${idExpr} as id${source.extraSelect ? sql`, ${source.extraSelect}` : sql``}, ${selectCols}
        from ${tableSql}
        ${baseJoins}
       where ${pageWhere}
       order by ${pageOrder}
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `)),
    source.statusCounts === false
      ? Promise.resolve({ rows: [] })
      // A CRM-off customer list has one constant status bucket ('customer'):
      // grouping by a constant is a Postgres 42601, so count it ungrouped
      // instead of skipping the facet (F-t11-001).
      : recordType === 'customer' && !crmOn
        ? (db.execute(sql`
            select ${statusExpr} as status, count(*) as n from ${tableSql}
              ${countJoins}
             where ${countWhere}`))
        : (db.execute(sql`
            select ${statusExpr} as status, count(*) as n from ${tableSql}
              ${countJoins}
             where ${countWhere}
             group by ${statusExpr}`)),
    db.execute<{ n: string }>(sql`
      select count(*) as n from ${tableSql}
        ${countJoins}
       where ${where}`),
    // Static registry options come first; a loader appends tenant-defined
    // values (custom project types) that no static set can name. No filter
    // mixes both today except billing/project_type, so merging is a no-op
    // everywhere else (F-t11-003).
    Promise.all(quickFilterDefs.map(async (quick) => {
      const filterMeta = meta.listFilters.find((filter) => filter.key === quick.filterKey)
      const statics = (filterMeta?.options ?? []).map((option) => ({
        value: option.value,
        label: option.labelKey ? label(option.labelKey) : option.value.replace(/_/g, ' '),
      }))
      if (!quick.loadOptions) return statics
      const seen = new Set(statics.map((option) => option.value))
      const loaded = await quick.loadOptions(orgId, allowedSubs)
      return [...statics, ...loaded.filter((option) => !seen.has(option.value))]
    })),
  ])
  const rows = rowsRes.rows as Record<string, unknown>[]
  // Server-computed display values (project actual cost reads the same
  // profile-driven reader as the cockpit). Runs after the page fetch so it
  // touches only displayed rows; SQL serves counts, and sort-by-actual pages
  // arrive pre-ordered from `orderedPageIds` (same reader, so order ties).
  if (source.enrichRows) await source.enrichRows(orgId, rows)
  const filteredTotal = Number(totalRow.rows[0]?.n ?? 0)
  const total = filteredTotal

  // Enum value → display label, resolved from any list filter that carries an
  // option set (status, project_type…). Lets both the chips and the table
  // cells show localized labels instead of raw codes. Tenant-loaded options
  // (custom project-type names) fill the gaps the static set cannot name.
  const optionLabel = (colKey: string, value: string): string => {
    const f = meta.listFilters.find((flt) => flt.key === colKey)
    const opt = f?.options?.find((o) => o.value === value)
    if (opt) return opt.labelKey ? label(opt.labelKey) : opt.value
    const loaded = quickFilterDefs
      .map((quick, index) => ({ quick, options: loadedQuickOptions[index] ?? [] }))
      .find(({ quick }) => quick.filterKey === colKey)
      ?.options.find((o) => o.value === value)
    if (loaded) return loaded.label
    return value.replace(/_/g, ' ')
  }

  const statusCountByValue = new Map(statusCounts.rows.map((r) => [String(r.status), Number(r.n)]))
  // DB-seeded status names (opportunity stages) reach the picker as English
  // labels; render them through the source's catalog hook when it names this
  // filter, so the picker button matches the translated table cells.
  const translateStatusOption = (rawLabel: string): string =>
    source.statusDisplayName ? source.statusDisplayName(rawLabel, label) : rawLabel
  const quickFilters = quickFilterDefs.map((quick, index) => {
    const filterMeta = meta.listFilters.find((filter) => filter.key === quick.filterKey)
    const options = loadedQuickOptions[index] ?? []
    const named = source.statusFilterKey && quick.filterKey === source.statusFilterKey
      ? options.map((option) => ({ ...option, label: translateStatusOption(String(option.label)) }))
      : options
    return {
      ...quick,
      label: filterMeta ? label(filterMeta.labelKey) : quick.filterKey.replace(/_/g, ' '),
      options: quick.filterKey === countFilterKey
        ? named.map((option) => ({ ...option, count: Number(statusCountByValue.get(option.value) ?? 0) }))
        : named,
    }
  })

  const openHref = (id: string, row?: unknown) => {
    const sourceRow = row && typeof row === 'object' ? row as Record<string, unknown> : null
    if (sourceRow && source.rowHref) return source.rowHref(sourceRow)
    const target = sourceRow && source.drawerTarget ? source.drawerTarget(sourceRow) : { param: source.drawerParam, id }
    return buildListDrawerHref(basePath, sp, target.param, target.id)
  }

  const cell = (row: Record<string, unknown>, c: ListColDesc) => {
    const v = row[c.key]
    switch (c.kind) {
      case 'reference': {
        const href = openHref(String(row.id), row)
        const hasOptions = meta.listFilters.some((f) => f.key === c.key && f.options?.length)
        const display = v == null || v === ''
          ? ''
          : hasOptions ? optionLabel(c.key, String(v)) : String(v)
        return (
          <TableCell key={c.key} className="font-medium">
            <Link
              href={(href)}
              title={display}
              className="block max-w-[18rem] truncate text-teal-700 hover:underline dark:text-teal-300"
            >
              {display}
            </Link>
          </TableCell>
        )
      }
      case 'amount': {
        // Amount cells come from numeric columns (driver strings/numbers);
        // String() round-trips both exactly, so formatting is unchanged.
        const rowCurrency = source.currencyField ? row[source.currencyField] : undefined
        // A `<key>Error` companion (e.g. project actualError) is per-row
        // error state, not a value: the cell renders an amber em-dash
        // carrying the reason instead of a fake zero.
        const rowError = row[`${c.key}Error`]
        const formatted = rowError != null && rowError !== ''
          ? <span className="text-amber-600 dark:text-amber-400" title={String(rowError)}>—</span>
          : v == null || v === ''
            ? <span className="text-slate-400">—</span>
            : money(String(v), source.currencyField ? { currency: typeof rowCurrency === 'string' ? rowCurrency : undefined } : undefined)
        const drill = currentPeriod && source.columnDrill && v != null && v !== ''
          ? source.columnDrill(row, c.key, {
              from: currentPeriod.from,
              to: currentPeriod.to,
              period: currentPeriod.presetId,
            })
          : null
        return (
          <TableCell key={c.key} className="text-right tabular-nums">
            {drill ? (
              <ReportDrillLink target={drill} className={DRILL_LINK_CLASS}>
                {formatted}
              </ReportDrillLink>
            ) : formatted}
          </TableCell>
        )
      }
      case 'status':
        return (
          <TableCell key={c.key}>
            <Badge variant={source.statusVariant?.(row, v, c.key) ?? STATUS_VARIANT[String(v)] ?? 'secondary'}>{source.statusDisplayName ? source.statusDisplayName(String(v), label) : optionLabel(c.key, String(v))}</Badge>
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
              href={(openHref(String(row.id), row))}
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
        const display = formatValue?.(row, c.key, v)
          ?? (v == null || v === '' ? '—' : hasOptions ? optionLabel(c.key, String(v)) : String(v))
        return (
          <TableCell key={c.key} className={v == null || v === '' ? 'text-slate-400' : 'text-slate-600 dark:text-slate-400'}>
            <span className="block max-w-[16rem] truncate" title={typeof display === 'string' ? display : undefined}>{display}</span>
          </TableCell>
        )
      }
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={tCommon('actions.search')} />
        {quickFilters.map((filter) => filter.options.length > 1 ? (
          <FilterChips
            key={filter.paramKey}
            basePath={basePath}
            currentParams={sp}
            paramKey={filter.paramKey}
            label={filter.label}
            options={filter.options}
            defaultValue={quickDefaults[filter.filterKey]}
          />
        ) : null)}
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
                <TableRow key={String(row.id)}>{cols.map((c) => cell(row, c))}</TableRow>
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
