import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getLocale, getTranslations } from 'next-intl/server'
import { decimalLabel } from '../../../../../lib/format'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { ShowInactivesToggle } from '../../../../../components/show-inactives-toggle'
import { ListFilterSelect } from '../../../../../components/list-filter-select'
import { SearchInput } from '../../../../../components/search-input'
import { Pagination } from '../../../../../components/pagination'
import { mergeHref, parseListParams, pickString } from '../../../../../lib/list-params'
import { setupEntityForFeatureState, setupOptionLabel, toSnake, type SetupColumn, type SetupEntity } from '../../../../../lib/setup/registry'
import { resolveDynamicSetupOptions } from '../../../../../lib/setup/dynamic-options'
import { loadRefOptions, orderExpr } from '../../../../../lib/setup/ref-options'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../../../lib/features'
import { NewSetupButton, SetupDrawer } from './SetupDrawer'
import { RateBookDrawer, type RateBookLine, type RateBookItemOption } from './RateBookDrawer'

/**
 * Registry-driven list + drawer for one configuration entity, mountable under
 * ANY base path (not just /admin/setup). The setup workspace, the Inventory
 * module, and the Items catalog all render the same generic CRUD surface —
 * only `basePath` changes, so search / pagination / drawer links stay local to
 * the host page. Reads the standard `q` / `showInactive` / `row` params.
 */

/** Render one table cell for a column, given the raw (snake-keyed) row. */
export function renderCell(
  col: SetupColumn,
  row: Record<string, unknown>,
  refLabels: Record<string, Map<string, string>>,
  t: (k: string) => string,
  locale: string,
) {
  const raw = row[toSnake(col.key)]
  const option = col.options?.find((candidate) => candidate.value === String(raw))
  switch (col.kind) {
    case 'badge-active':
      return (
        <Badge variant={raw ? 'success' : 'outline'}>
          {raw ? t('statusActive') : t('statusArchived')}
        </Badge>
      )
    case 'badge':
      return (
        <Badge variant={raw === 'builtin' ? 'secondary' : 'default'}>
          {option ? setupOptionLabel(option, t) : raw == null || raw === '' ? '—' : String(raw)}
        </Badge>
      )
    case 'boolean':
      return raw ? t('yes') : '—'
    case 'percent':
      return raw == null || raw === '' ? '—' : `${Number(raw)}%`
    case 'number': {
      if (raw == null || raw === '') return '—'
      const num = Number(raw)
      // Locale-formatted, trailing zeros trimmed (1.7500 → 1.75, 40.0000 → 40).
      return Number.isFinite(num)
        ? decimalLabel(num, locale, 0, 4)
        : String(raw)
    }
    case 'date':
      return raw ? String(raw) : '—'
    case 'ref': {
      const label = col.ref ? refLabels[col.ref]?.get(String(raw)) : undefined
      return label ?? (raw ? String(raw) : '—')
    }
    case 'code':
      return raw ? <span className="font-mono text-xs">{String(raw)}</span> : '—'
    case 'text':
    default:
      return raw == null || raw === '' ? '—' : String(raw)
  }
}

export async function SetupEntitySection({
  entity: baseEntity,
  orgId,
  searchParams: sp,
  basePath,
  canManage,
  allowedSubsidiaryIds = null,
  hideHeader = false,
}: {
  entity: SetupEntity
  orgId: string
  searchParams: Record<string, string | string[] | undefined>
  basePath: string
  canManage: boolean
  // Subsidiary-scoped callers only see their vendors in ref pickers (NULL
  // subsidiary stays org-wide visible) — without this the remittance-vendor
  // listbox cannot scope its options (F-t08-015).
  allowedSubsidiaryIds?: ReadonlySet<string> | null
  /** Re-homed module tabs own their single page header and create action. */
  hideHeader?: boolean
}) {
  const multiCurrency = await isFeatureEnabled(orgId, 'multiCurrency')
  const gated = setupEntityForFeatureState(baseEntity, {
    multiSubsidiary: await subsidiaryFeatureEnabled(orgId),
    equipment: await isFeatureEnabled(orgId, 'equipment'),
    fieldTickets: await isFeatureEnabled(orgId, 'fieldTickets'),
  })
  const entity = resolveDynamicSetupOptions(
    gated.key === 'item-rate-books' && !multiCurrency
      ? { ...gated, fields: gated.fields.filter((field) => field.key !== 'currency') }
      : gated,
  )
  const t = await getTranslations('admin.setup')
  const locale = await getLocale()
  const rowParam = typeof sp.row === 'string' ? sp.row : undefined
  const showInactive = pickString(sp.showInactive) === 'true'
  const list = parseListParams(sp, { sort: 'default', allowedSorts: ['default'] as const, perPage: 25 })
  const closeHref = mergeHref(basePath, sp, { row: undefined })

  const searchColumns = entity.columns.map(
    (column) => sql`cast(${sql.raw(toSnake(column.key))} as text) ilike ${`%${list.q ?? ''}%`}`,
  )
  // Enum dropdown filters (`f_<key>` params). Only registry-declared option
  // values are honoured, so the raw param never reaches SQL unchecked.
  const activeFilters = (entity.filters ?? []).flatMap((filter) => {
    const value = pickString(sp[`f_${filter.key}`])
    if (!value || !filter.options.some((option) => option.value === value)) return []
    return [{ filter, value }]
  })
  const filterClauses = activeFilters.map(({ filter, value }) =>
    filter.nullMatchesAll
      ? sql`and (${sql.raw(toSnake(filter.key))} = ${value} or ${sql.raw(toSnake(filter.key))} is null)`
      : sql`and ${sql.raw(toSnake(filter.key))} = ${value}`,
  )
  const rowFilter = sql`where 1 = 1
    ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
    ${entity.hasActive && !showInactive ? sql`and is_active` : sql``}
    ${filterClauses.length ? sql.join(filterClauses, sql` `) : sql``}
    ${list.q && searchColumns.length ? sql`and (${sql.join(searchColumns, sql` or `)})` : sql``}`

  const [rowsRes, countRes, refOptions] = await Promise.all([
    (db.execute(sql`
      select * from ${sql.raw(entity.table)} ${rowFilter}
       order by ${sql.raw(orderExpr(entity))}
       limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`)),
    (db.execute(sql`select count(*)::int as n from ${sql.raw(entity.table)} ${rowFilter}`)),
    loadRefOptions(entity, orgId, allowedSubsidiaryIds),
  ])
  const rows = (rowsRes.rows)
  const total = Number(countRes.rows[0]?.n ?? 0)

  const refLabels: Record<string, Map<string, string>> = {}
  for (const [source, opts] of Object.entries(refOptions)) {
    refLabels[source] = new Map(opts.map((o) => [o.value, o.label]))
  }

  const idColumn = entity.idColumn ?? 'id'
  const open = rowParam
    ? rowParam === 'new'
      ? { creating: true, row: (null) }
      : await (async () => {
          const selected = ((await db.execute(sql`
            select * from ${sql.raw(entity.table)}
             where ${sql.raw(idColumn)} = ${rowParam}
             ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
             limit 1`)))
          return { creating: false, row: selected.rows[0] ?? null }
        })()
    : null

  const rateBookDrawerData = open && entity.key === 'item-rate-books'
    ? await (async () => {
        const bookId = open.row ? String(open.row.id) : null
        const [versionResult, itemsResult, orgResult] = await Promise.all([
          bookId
            ? db.execute<{ id: string; effective_from: string }>(sql`
                select id, effective_from
                  from item_rate_versions
                 where org_id = ${orgId} and rate_book_id = ${bookId} and status = 'active'
                 order by effective_from desc
                 limit 1`)
            : Promise.resolve({ rows: [] as { id: string; effective_from: string }[] }),
          db.execute<{ id: string; code: string | null; name: string; kind: string; unit: string | null; is_active: boolean }>(sql`
            select id, code, name, kind, unit, is_active
              from items
             where org_id = ${orgId}
             order by is_active desc, name, code`),
          db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id = ${orgId}`),
        ])
        const version = versionResult.rows[0]
        const linesResult = version
          ? await db.execute<{
              item_id: string; unit_code: string; unit_name: string; base_quantity: string;
              cost_rate: string | null; bill_rate: string | null; time_type_bill_rates: Record<string, string> | null;
              base_unit: string | null; pricing_policy: string | null; invoice_presentation: string | null;
            }>(sql`
              select line.item_id, line.unit_code, line.unit_name, line.base_quantity,
                     line.cost_rate, line.bill_rate, line.time_type_bill_rates,
                     coalesce(pin.base_unit, profile.base_unit) as base_unit,
                     coalesce(pin.pricing_policy, profile.pricing_policy) as pricing_policy,
                     coalesce(pin.invoice_presentation, profile.invoice_presentation) as invoice_presentation
                from item_rate_lines line
                left join item_rate_version_profiles pin
                  on pin.org_id = line.org_id and pin.version_id = line.version_id and pin.item_id = line.item_id
                left join item_rate_profiles profile
                  on profile.org_id = line.org_id and profile.item_id = line.item_id
               where line.org_id = ${orgId} and line.version_id = ${version.id}
               order by line.sort_order, line.item_id, line.unit_code`)
          : { rows: [] }
        return {
          latestEffectiveFrom: version?.effective_from ? String(version.effective_from).slice(0, 10) : null,
          lines: linesResult.rows.map((line): RateBookLine => ({
            itemId: String(line.item_id),
            unitCode: String(line.unit_code),
            unitName: String(line.unit_name),
            baseQuantity: String(line.base_quantity),
            costRate: line.cost_rate == null ? '0' : String(line.cost_rate),
            billRate: line.bill_rate == null ? '0' : String(line.bill_rate),
            baseUnit: line.base_unit ? String(line.base_unit) : String(line.unit_code),
            pricingPolicy: line.pricing_policy ? String(line.pricing_policy) : 'capped_ladder',
            invoicePresentation: line.invoice_presentation ? String(line.invoice_presentation) : 'rate_components',
            timeTypeBillRates: line.time_type_bill_rates ?? {},
          })),
          items: itemsResult.rows.map((item): RateBookItemOption => ({
            id: String(item.id), code: item.code, name: item.name, kind: item.kind,
            unit: item.unit, isActive: item.is_active,
          })),
          baseCurrency: String(orgResult.rows[0]?.base_currency ?? open.row?.currency ?? 'USD'),
        }
      })()
    : null

  return (
    <div className="space-y-4">
      {!hideHeader ? <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t(`entities.${entity.key}.title`)}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t(`entities.${entity.key}.description`)}
            {entity.docSlug ? (
              <>
                {' '}
                <Link
                  href={`/docs/${entity.docSlug}`}
                  className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                >
                  {t('learnMore')}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        {canManage ? <NewSetupButton entityKey={entity.key} label={t('new')} basePath={basePath} /> : null}
      </div> : null}

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={t('searchPlaceholder')} />
        {(entity.filters ?? []).map((filter) => (
          <ListFilterSelect
            key={filter.key}
            basePath={basePath}
            currentParams={sp}
            paramKey={`f_${filter.key}`}
            label={t(`fields.${filter.key}`)}
            allLabel={t('filterAll')}
            options={filter.options.map((option) => ({ value: option.value, label: setupOptionLabel(option, t) }))}
          />
        ))}
        {entity.hasActive ? <ShowInactivesToggle basePath={basePath} currentParams={sp} /> : null}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <Table>
          <TableHeader>
            <TableRow>
              {entity.columns.map((c) => (
                <TableHead key={c.key}>{t(`fields.${c.key}`)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={entity.columns.length} className="text-slate-500 dark:text-slate-400">
                  {t('empty')}
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((row) => (
              <TableRow key={String(row[idColumn])}>
                {entity.columns.map((c, i) => (
                  <TableCell key={c.key}>
                    {canManage && (i === 0 || entity.key === 'item-rate-books') ? (
                      <Link
                        href={mergeHref(basePath, sp, { row: String(row[idColumn]) })}
                        className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {renderCell(c, row, refLabels, t, locale)}
                      </Link>
                    ) : (
                      renderCell(c, row, refLabels, t, locale)
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {total > 0 ? (
        <Pagination basePath={basePath} currentParams={sp} total={total} page={list.page} perPage={list.perPage} />
      ) : null}

      {open && canManage && entity.key === 'item-rate-books' && rateBookDrawerData ? (
        <RateBookDrawer
          row={open.row as Record<string, unknown> | null}
          latestEffectiveFrom={rateBookDrawerData.latestEffectiveFrom}
          lines={rateBookDrawerData.lines}
          items={rateBookDrawerData.items}
          currencies={refOptions.currencies ?? []}
          baseCurrency={rateBookDrawerData.baseCurrency}
          multiCurrency={multiCurrency}
          closeHref={closeHref}
        />
      ) : open && canManage ? (
        <SetupDrawer
          entity={entity}
          row={open.row}
          members={[]}
          refOptions={refOptions}
          closeHref={closeHref}
        />
      ) : null}
    </div>
  )
}
