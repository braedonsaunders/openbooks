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
import { FilterChips, SearchSelectFilter } from './filter-bar'
import { DateRangeFilter } from './date-range-filter'
import { Pagination } from './pagination'
import { SortTh } from './sortable-th'
import { ViewsMenu } from './views-menu'
import { DocTypeBadge } from './doc-type-badge'
import { docTypeMeta } from './doc-type-badge'
import { buildListDrawerHref, parseListParams, pickString } from '../lib/list-params'
import { allowedSubsidiaryIds } from '../lib/subsidiaries'
import { loadFieldDefs } from '../lib/custom-fields'
import { resolveListView } from '../lib/customization/resolve'
import { columnDescriptors, documentWhere, type ListColDesc } from '../lib/customization/list-query'
import { listSource } from '../lib/list/sources'
import { RelatedPartyLink } from './related-party-link'

/**
 * The universal record list — one component that renders EVERY documents-backed
 * list (bills, invoices, orders, payments, receipts…): search + status/type
 * filter chips + saved-view switcher, a sortable table whose cells are typed
 * from the customization registry (reference → drawer link, entity → drill-
 * through, amount → currency, status → badge, custom fields), and pagination.
 *
 * The page owns only its header (title/description/new button) and the drawer;
 * everything list-shaped lives here. Column set, order, labels, filters and sort
 * come from the resolved saved view — so customization works everywhere for free.
 */

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  approved: 'success',
  paid: 'success',
  pending_approval: 'warning',
  partially_paid: 'warning',
  draft: 'secondary',
  calculated: 'warning',
  committed: 'default',
  voided: 'outline',
  reversed: 'outline',
  cancelled: 'outline',
  rejected: 'outline',
}

const STATUS_KEYS: Record<string, string> = {
  draft: 'draft',
  calculated: 'calculated',
  committed: 'committed',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  rejected: 'rejected',
  posted: 'posted',
  paid: 'paid',
  partially_paid: 'partiallyPaid',
  voided: 'voided',
  reversed: 'reversed',
  cancelled: 'cancelled',
}

export async function RecordListView({
  recordType,
  basePath,
  orgId,
  userId,
  canManage,
  sp,
  drawer,
  emptyAction,
  renderRowActions,
}: {
  recordType: string
  basePath: string
  orgId: string
  userId: string
  canManage: boolean
  sp: Record<string, string | string[] | undefined>
  /** Page-resolved flyout (rendered when e.g. ?doc=/?payment= is set). */
  drawer?: ReactNode
  /** Action shown in the empty state (usually the New button). */
  emptyAction?: ReactNode
  /** Per-row actions for the `_actions` column, if the view includes it. */
  renderRowActions?: (row: any) => ReactNode
}) {
  const { money } = await getMoneyFormatter()
  const source = listSource(recordType)
  const meta = getRecordType(recordType)
  if (!source || !meta) throw new Error(`no list source registered for record type "${recordType}"`)

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
  const statusLabel = (status: string) => {
    const key = STATUS_KEYS[status]
    return key ? tCommon(`status.${key}`) : status.replace(/_/g, ' ')
  }

  // Custom (cf_*) list columns come from the field defs with showInList set.
  const headerDefs = await loadFieldDefs('documents', recordType)
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
    viewSortKey && allowedSorts.includes(viewSortKey)
      ? viewSortKey
      : allowedSorts.includes('date')
        ? 'date'
        : (allowedSorts[0] ?? 'date')
  const params = parseListParams(sp, {
    sort: defaultSort,
    dir: view.sort?.dir ?? 'desc',
    perPage: view.perPage ?? 25,
    allowedSorts,
  })

  const status = pickString(sp.status)
  const kindParamKey = source.kindParamKey ?? 'kind'
  const kind = source.multiKind ? pickString(sp[kindParamKey]) : undefined
  const from = source.dateRange ? pickString(sp.from) : undefined
  const to = source.dateRange ? pickString(sp.to) : undefined
  const extraQuickValues: Record<string, string | undefined> = {}
  for (const quick of source.quickFilters ?? []) extraQuickValues[quick.filterKey] = pickString(sp[quick.paramKey])

  const labels: Record<string, string> = { actions: tCommon('labels.actions') }
  for (const c of meta.listColumns) labels[c.key] = label(c.labelKey)

  const cols = columnDescriptors(recordType, view, showInListDefs, source.builtInExpr, labels)
  const selectCols = sql.join(
    cols.filter((c) => c.expr).map((c) => sql`${c.expr} as ${sql.raw(`"${c.key}"`)}`),
    sql`, `,
  )
  const joins = source.joins ?? sql``
  // Role-based subsidiary visibility (null = unrestricted).
  const allowedSubs = await allowedSubsidiaryIds(userId)
  const whereBuilder = source.where ?? documentWhere
  const where = whereBuilder(source.kinds, view, { q: params.q, status, kind, from, to, filters: extraQuickValues }, orgId, allowedSubs)
  const statusCountView = { ...view, filters: view.filters.filter((filter) => filter.key !== 'status') }
  const statusCountWhere = whereBuilder(source.kinds, statusCountView, { kind, from, to, filters: extraQuickValues }, orgId, allowedSubs)
  const kindCountView = { ...view, filters: view.filters.filter((filter) => filter.key !== 'transaction_kind') }
  const kindCountWhere = whereBuilder(source.kinds, kindCountView, { status, from, to, filters: extraQuickValues }, orgId, allowedSubs)
  const orderExpr = source.sorts[params.sort] ?? sql`d.document_date`

  const [rowsRes, statusCounts, totalRow] = await Promise.all([
    (db.execute(sql`
      select d.id, d.kind, d.currency${source.extraSelect ? sql`, ${source.extraSelect}` : sql``}, ${selectCols}
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
        ${joins}
       where ${where}
       order by ${orderExpr} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `)),
    (db.execute(sql`
      select d.status, count(*) as n from documents d
       where ${statusCountWhere}
       group by d.status`)),
    db.execute(sql`
      select count(*) as n from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
        ${joins}
       where ${where}`) as any,
  ])
  const rows = rowsRes.rows as any[]
  const total = statusCounts.rows.reduce((a: number, r) => a + Number(r.n), 0)
  const filteredTotal = Number(totalRow.rows[0].n)

  const statusOptions = statusCounts.rows.map((r) => ({
    value: String(r.status),
    label: statusLabel(String(r.status)),
    count: Number(r.n),
  }))

  const extraQuickFilters = await Promise.all((source.quickFilters ?? []).map(async (quick) => {
    const filterMeta = meta.listFilters.find((filter) => filter.key === quick.filterKey)
    const options = quick.loadOptions ? await quick.loadOptions(orgId, allowedSubs) : (filterMeta?.options ?? []).map((option) => ({
      value: option.value,
      label: option.labelKey ? label(option.labelKey) : option.value.replace(/_/g, ' '),
    }))
    return {
      ...quick,
      label: filterMeta ? label(filterMeta.labelKey) : quick.filterKey.replace(/_/g, ' '),
      options,
    }
  }))

  // Optional kind chips for mixed-kind lists (e.g. bills + credits).
  let kindOptions: { value: string; label: string; count: number }[] = []
  if (source.multiKind) {
    const kindCounts = ((await db.execute(sql`
      select d.kind, count(*) as n from documents d
       where ${kindCountWhere}
       group by d.kind`)))
    const countByKind = new Map(kindCounts.rows.map((r) => [r.kind, Number(r.n)]))
    kindOptions = source.kinds.map((k) => ({
      value: k,
      label: tCommon(`transactionTypes.${docTypeMeta(k).labelKey}` as never),
      count: Number(countByKind.get(k) ?? 0),
    }))
  }

  const openHref = (id: string) =>
    buildListDrawerHref(basePath, sp, source.drawerParam, id)

  const optionLabel = (columnKey: string, value: string) => {
    const option = meta.listFilters.find((filter) => filter.key === columnKey)?.options?.find((item) => item.value === value)
    return option ? (option.labelKey ? label(option.labelKey) : option.value) : value.replace(/_/g, ' ')
  }

  const cell = (row: any, c: ListColDesc) => {
    const v = row[c.key]
    // Entity drill-through columns (party → vendor/customer/employee, funding
    // account → account) declared by the source.
    const linkFn = source.links?.[c.key]
    if (linkFn) {
      const href = linkFn(row)
      return (
        <TableCell key={c.key}>
          {href && v && typeof href !== 'string' && href.kind === 'party' ? (
            <RelatedPartyLink
              partyId={href.id}
              role={href.role}
              className="text-teal-700 hover:underline dark:text-teal-300"
            >
              {String(v)}
            </RelatedPartyLink>
          ) : href && v && typeof href === 'string' ? (
            <Link href={(href)} className="text-teal-700 hover:underline dark:text-teal-300">
              {String(v)}
            </Link>
          ) : (
            <span className="text-slate-400">{v != null && v !== '' ? String(v) : '—'}</span>
          )}
        </TableCell>
      )
    }
    switch (c.kind) {
      case 'reference':
        return (
          <TableCell key={c.key} className="font-mono text-[13px] font-semibold">
            <div className="flex items-center gap-2">
              {source.multiKind ? <DocTypeBadge kind={row.kind} /> : null}
              <Link
                href={(openHref(String(row.id)))}
                className="text-teal-700 hover:underline dark:text-teal-300"
              >
                {String(v ?? '')}
              </Link>
            </div>
          </TableCell>
        )
      case 'amount':
        return (
          <TableCell key={c.key} className="text-right tabular-nums">
            {v == null || v === '' ? <span className="text-slate-400">—</span> : money(v, { currency: row.currency })}
          </TableCell>
        )
      case 'status':
        return (
          <TableCell key={c.key}>
            <Badge variant={STATUS_VARIANT[String(v)] ?? 'secondary'}>{statusLabel(String(v))}</Badge>
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
            {renderRowActions ? renderRowActions(row) : (
              <Link
                href={(openHref(String(row.id)))}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-teal-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-teal-300"
                aria-label={tCommon('actions.open')}
                title={tCommon('actions.open')}
              >
                <Eye size={15} />
              </Link>
            )}
          </TableCell>
        )
      default:
        return (
          <TableCell key={c.key} className={v == null || v === '' ? 'text-slate-400' : ''}>
            {v != null && v !== '' ? optionLabel(c.key, String(v)) : '—'}
          </TableCell>
        )
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={tCommon('actions.search')} />
        {source.multiKind ? (
          <FilterChips basePath={basePath} currentParams={sp} paramKey={kindParamKey} label={tCommon('labels.type')} options={kindOptions} />
        ) : null}
        {source.hideStatusFilter ? null : (
          <FilterChips basePath={basePath} currentParams={sp} paramKey="status" label={tCommon('labels.status')} options={statusOptions} />
        )}
        {extraQuickFilters.map((filter) => filter.options.length ? (
          filter.searchSelect ? (
            <SearchSelectFilter key={filter.paramKey} paramKey={filter.paramKey} label={filter.label} options={filter.options} />
          ) : (
            <FilterChips
              key={filter.paramKey}
              basePath={basePath}
              currentParams={sp}
              paramKey={filter.paramKey}
              label={filter.label}
              options={filter.options}
            />
          )
        ) : null)}
        {source.dateRange ? (
          <DateRangeFilter
            fromLabel={tCommon('labels.from')}
            toLabel={tCommon('labels.to')}
            clearLabel={tCommon('actions.clear')}
          />
        ) : null}
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
          <EmptyState
            title={tCommon('empty.title')}
            description={tCommon('empty.description')}
            action={emptyAction}
          />
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
