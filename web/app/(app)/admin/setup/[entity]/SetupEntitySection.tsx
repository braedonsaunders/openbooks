import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatDecimal } from '../../../../../lib/money-format'
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
import { mergeHref, parseListParams, parsePrefixedListParams, pickString } from '../../../../../lib/list-params'
import { setupParentScope } from '../../../../../lib/setup/parent-scope'
import { setupEntityForFeatureState, setupChildEntities, resolveSetupEntityGate, setupOptionLabel, toSnake, type SetupColumn, type SetupEntity } from '../../../../../lib/setup/registry'
import { setupEntitySubsidiaryFilter } from '../../../../../lib/setup/subsidiary-scope'
import { setupEntityClientDescriptor } from '../../../../../lib/setup/types'
import { resolveDynamicSetupOptions } from '../../../../../lib/setup/dynamic-options'
import { loadRefOptions, orderExpr } from '../../../../../lib/setup/ref-options'
import { setupReadProjection, setupReadSource } from '../../../../../lib/setup/read-shape'
import { isFeatureEnabled, subsidiaryFeatureEnabled, resolvedFeatureState } from '../../../../../lib/features'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'
import { NewSetupButton, SetupDrawer } from './SetupDrawer'
import { RateBookDrawer, type RateBookLine, type RateBookItemOption } from './RateBookDrawer'
import { ConstructionRateScheduleEditor } from './ConstructionRateScheduleEditor'
import { listScheduleLines } from '@openbooks/engine/src/hrm/construction/rates.ts'
import { can, getAuthz } from '../../../../../lib/authz'

/**
 * Registry-driven list + drawer for one configuration entity, mountable under
 * ANY base path (not just /admin/setup). The setup workspace, the Inventory
 * module, and the Items catalog all render the same generic CRUD surface —
 * only `basePath` changes, so search / pagination / drawer links stay local to
 * the host page. Reads the standard `q` / `showInactive` params and the
 * drawer key (`row` by default, namespaced per section on multi-section
 * hosts through `rowParam`).
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
      return raw == null || raw === '' ? '—' : `${formatDecimal(locale, String(raw), { maximumFractionDigits: 4 })}%`
    case 'number': {
      if (raw == null || raw === '') return '—'
      // Locale-formatted, trailing zeros trimmed (1.7500 → 1.75, 40.0000 → 40).
      return formatDecimal(locale, String(raw), { maximumFractionDigits: 4 })
    }
    case 'date':
      return raw ? String(raw) : '—'
    case 'ref': {
      const label = col.ref ? refLabels[col.ref]?.get(String(raw)) : undefined
      return label ?? (raw ? String(raw) : '—')
    }
    case 'code':
      return raw ? (
        <span className="font-mono text-xs">{String(raw)}</span>
      ) : (
        '—'
      );
    case 'text':
    default:
      return raw == null || raw === '' ? '—' : String(raw)
  }
}

/** Shared child-tab composition for standalone setup and rehomed workspaces. */
export function setupRecordTabs({ entity, row, orgId, actorId, sp, basePath, canManage, allowedSubsidiaryIds, features, t, mutationBasePath }: {
  mutationBasePath?: string
  entity: SetupEntity
  row: Record<string, unknown> | null
  orgId: string
  actorId?: string
  sp: Record<string, string | string[] | undefined>
  basePath: string
  canManage: boolean
  allowedSubsidiaryIds: ReadonlySet<string> | null
  features: Parameters<typeof resolveSetupEntityGate>[1]
  t: (key: string) => string
}) {
  if (!row) return []
  return (entity.recordChildren ?? setupChildEntities(entity.key))
    .filter((child) => resolveSetupEntityGate(child, features).enabled)
    .map((child) => {
      const binding = child.parentRecords!.find((owner) => owner.entityKey === entity.key)!
      return {
        key: child.key,
        label: t(child.titleKey ?? `entities.${child.key}.title`),
        content: pickString(sp.setupTab) === child.key ? (
          <SetupEntitySection
            entity={{ ...child, ...(entity.readOnly ? { readOnly: true } : {}), columns: child.columns.filter((column) => column.key !== binding.fieldKey) }}
            orgId={orgId}
            actorId={actorId}
            searchParams={sp}
            basePath={basePath}
            canManage={canManage}
            allowedSubsidiaryIds={allowedSubsidiaryIds}
            parent={{ recordKey: entity.key, value: String(row[binding.valueKey ?? entity.idColumn ?? 'id']) }}
            rowParam="childRow"
            paramPrefix="child"
            stacked
            mutationBasePath={mutationBasePath}
          />
        ) : null,
      }
    })
}

export async function SetupEntitySection({
  entity: baseEntity,
  orgId,
  actorId,
  searchParams: sp,
  basePath,
  canManage,
  allowedSubsidiaryIds = null,
  hideHeader = false,
  rowParam = 'row',
  visibleRowIds,
  renderColumn,
  parent,
  paramPrefix,
  stacked = false,
  drawerOnly = false,
  mutationBasePath,
  fixedFilter,
}: {
  entity: SetupEntity;
  /** Server-side presentation slot; list querying and drawers remain shared. */
  renderColumn?: (
    column: SetupColumn,
    row: Record<string, unknown>,
  ) => React.ReactNode;
  orgId: string
  actorId?: string
  searchParams: Record<string, string | string[] | undefined>
  basePath: string
  canManage: boolean
  // Subsidiary-scoped callers only see their vendors in ref pickers (NULL
  // subsidiary stays org-wide visible) — without this the remittance-vendor
  // listbox cannot scope its options.
  allowedSubsidiaryIds?: ReadonlySet<string> | null
  // Rehomed sections whose rows carry caller-dependent visibility (rate
  // schedules anchored to another subsidiary's projects): the host slot
  // resolves the visible ids through the owning engine service and the
  // section reads only those rows. Undefined keeps every other entity on
  // the plain org-wide read.
  visibleRowIds?: ReadonlySet<string>
  /** Re-homed module tabs own their single page header and create action. */
  hideHeader?: boolean
  /** URL key this section's New/edit drawer reads and writes. A host page
   *  mounting several sections gives each its own key (CK-09) so one URL
   *  opens exactly one drawer; single-section surfaces keep `row`. */
  rowParam?: string
  /** An authorized owning record limits both list and edit-row queries. */
  parent?: { recordKey: string; value: string }
  /** Child search, pagination and inactive state must not change the parent list. */
  paramPrefix?: string
  stacked?: boolean
  /** Compose the shared record editor under a host-owned unified list. */
  drawerOnly?: boolean
  mutationBasePath?: string
  /** A server-authorized reference filter keeps record links within the native list. */
  fixedFilter?: { fieldKey: string; value: string }
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
  const drawerEntity = setupEntityClientDescriptor(entity)
  // Command-owned entities mutate through their domain command: the marker's
  // permission (funds.manage) gates the mutation UI, derived from the same
  // discriminant the drawer, the CRUD refusal, and the command route honor.
  // Read gates are untouched — pages require funds.read, never manage.
  const commandPermission = entity.command?.permission
  const currentAuthz = entity.writePermission || commandPermission ? await getAuthz() : null
  // Command-owned mutation authority comes from the marker alone — never
  // stacked with canManage/admin.setup.manage. Generic entities keep their
  // existing authority path; reader visibility is unchanged.
  const canWriteEntity = commandPermission
    ? Boolean(currentAuthz && can(currentAuthz, commandPermission))
    : canManage && !entity.readOnly && (!entity.writePermission || Boolean(currentAuthz && can(currentAuthz, entity.writePermission)))
  const t = await getTranslations('admin.setup')
  const locale = await getLocale()
  const rawRow = sp[rowParam]
  const openRow = typeof rawRow === 'string' ? rawRow : undefined
  const qParam = paramPrefix ? `${paramPrefix}Q` : 'q'
  const pageParam = paramPrefix ? `${paramPrefix}Page` : 'page'
  const inactiveParam = paramPrefix ? `${paramPrefix}ShowInactive` : 'showInactive'
  const showInactive = pickString(sp[inactiveParam]) === 'true'
  const listOptions = { sort: 'default', allowedSorts: ['default'] as const, perPage: 25 }
  const list = paramPrefix ? parsePrefixedListParams(sp, paramPrefix, listOptions) : parseListParams(sp, listOptions)
  const parentScope = setupParentScope(entity, parent)
  const children = entity.recordChildren ?? setupChildEntities(entity.key)
  const closeHref = mergeHref(basePath, sp, {
    [rowParam]: undefined,
    ...(children.length ? { setupTab: undefined, childRow: undefined, childQ: undefined, childPage: undefined, childShowInactive: undefined } : {}),
  })

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
  const idColumn = entity.idColumn ?? 'id'
  const fixedField = fixedFilter ? entity.fields.find((field) => field.key === fixedFilter.fieldKey && field.kind === 'ref') : undefined
  if (fixedFilter && !fixedField) throw new Error('Setup record filter must name a declared reference field')
  const fixedPredicate = fixedFilter ? sql`and ${sql.raw(toSnake(fixedFilter.fieldKey))}=${fixedFilter.value}` : sql``
  const inheritedScope = baseEntity.fields.some((field) => ['worker-employments', 'benefit-plans', 'benefit-enrollment-configuration'].includes(field.ref ?? ''))
    ? setupEntitySubsidiaryFilter(entity, allowedSubsidiaryIds) : sql``
  const rowFilter = sql`where 1 = 1
    ${inheritedScope}
    ${fixedPredicate}
    ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
    ${parentScope ? sql`and ${parentScope.predicate}` : sql``}
    ${entity.hasActive && !showInactive ? sql`and is_active` : sql``}
    ${visibleRowIds !== undefined ? sql`and ${sql.raw(idColumn)} = any (${`{${[...visibleRowIds].join(',')}}`}::uuid[])` : sql``}
    ${filterClauses.length ? sql.join(filterClauses, sql` `) : sql``}
    ${list.q && searchColumns.length ? sql`and (${sql.join(searchColumns, sql` or `)})` : sql``}`

  const [rowsRes, countRes, refOptions] = await Promise.all([
    drawerOnly ? Promise.resolve({ rows: [] }) : db.execute(sql`
      select ${setupReadProjection(entity)} from ${setupReadSource(entity)} ${rowFilter}
       order by ${sql.raw(orderExpr(entity))}
       limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
    drawerOnly ? Promise.resolve({ rows: [] }) : db.execute(sql`select count(*)::int as n from ${sql.raw(entity.table)} ${rowFilter}`),
    loadRefOptions(entity, orgId, allowedSubsidiaryIds),
  ])
  const rows = rowsRes.rows;
  const total = Number(countRes.rows[0]?.n ?? 0)

  const refLabels: Record<string, Map<string, string>> = {}
  for (const [source, opts] of Object.entries(refOptions)) {
    const scopeField = entity.fields.find((field) => field.ref === source && field.refScopeField)?.refScopeField
    const boundScope = scopeField ? parentScope?.fixedValues[scopeField] ?? fixedFilter?.value : undefined
    const scopedOptions = boundScope === undefined ? opts : opts.filter((option) => option.scopeValue == null || option.scopeValue === String(boundScope))
    refLabels[source] = new Map(scopedOptions.map((option) => [option.value, option.label]))
  }

  const open = openRow
    ? openRow === 'new'
      ? entity.allowCreate !== false && !entity.readOnly ? { creating: true, row: null } : null
      : await (async () => {
          const selected = await db.execute(sql`
            select ${setupReadProjection(entity)} from ${setupReadSource(entity)}
             where ${sql.raw(idColumn)} = ${openRow}
             ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
             ${parentScope ? sql`and ${parentScope.predicate}` : sql``}
             ${inheritedScope}
             ${fixedPredicate}
             ${visibleRowIds !== undefined ? sql`and ${sql.raw(idColumn)} = any (${`{${[...visibleRowIds].join(',')}}`}::uuid[])` : sql``}
             limit 1`)
          return selected.rows[0] ? { creating: false, row: selected.rows[0] } : null
        })()
    : null

  const features = children.length ? await resolvedFeatureState(orgId) : {}
  const childTabs = setupRecordTabs({
    entity, row: open?.row ?? null, orgId, actorId, sp, basePath,
    canManage, allowedSubsidiaryIds, features, t, mutationBasePath,
  })

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

  const rateScheduleScopeOptions = open && !open.creating && entity.key === 'construction-rate-schedules'
    ? await (async () => {
        const [subsidiaries, departments, projects, locations] = await Promise.all([
          db.execute<{ value: string; label: string }>(sql`
            select id::text as value, name as label from subsidiaries
             where org_id = ${orgId} and is_active
             ${subsidiaryVisibleFilter(sql`id`, allowedSubsidiaryIds)} order by name`),
          db.execute<{ value: string; label: string }>(sql`
            select id::text as value, coalesce(nullif(code, ''), name) as label from departments
             where org_id = ${orgId} and is_active
             ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)} order by code nulls last, name`),
          db.execute<{ value: string; label: string }>(sql`
            select id::text as value, case when coalesce(code, '') <> '' then code || ' · ' || name else name end as label from projects
             where org_id = ${orgId} and is_active
             ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)} order by code nulls last, name`),
          db.execute<{ value: string; label: string }>(sql`
            select id::text as value, coalesce(nullif(code, ''), name) as label from locations
             where org_id = ${orgId} and is_active
             ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)} order by code nulls last, name`),
        ])
        return {
          subsidiaries: subsidiaries.rows,
          departments: departments.rows,
          projects: projects.rows,
          locations: locations.rows,
        }
      })()
    : null

  const rateScheduleEditorData = open && !open.creating && entity.key === 'construction-rate-schedules' && actorId
    ? await listScheduleLines(db, { orgId, actorId, scheduleId: String(open.row?.id ?? '') })
    : null

  return (
    <div className="space-y-4">
      {!hideHeader && !drawerOnly ? (
        <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t(entity.titleKey ?? `entities.${entity.key}.title`)}
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
        {canWriteEntity && entity.allowCreate !== false ? (
            <NewSetupButton entityKey={entity.key} label={t('new')} basePath={basePath} rowParam={rowParam} />
          ) : null}
      </div>
      ) : null}

      {!drawerOnly ? <>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={t('searchPlaceholder')} paramKey={qParam} pageParamKey={pageParam} />
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
        {entity.hasActive ? (
          <ShowInactivesToggle basePath={basePath} currentParams={sp} paramKey={inactiveParam} pageParamKey={pageParam} />
        ) : null}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <Table>
          <TableHeader>
            <TableRow>
              {entity.columns.map((c) => (
                <TableHead key={c.key}>{t(c.labelKey ?? `fields.${c.key}`)}</TableHead>
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
                    {(canWriteEntity || (canManage && entity.readOnly)) && (i === 0 || entity.key === 'item-rate-books') ? (
                      <Link
                        href={mergeHref(basePath, sp, { [rowParam]: String(row[idColumn]) })}
                        className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {renderColumn?.(c, row) ??
                          renderCell(c, row, refLabels, t, locale)}
                      </Link>
                    ) : (
                      (renderColumn?.(c, row) ??
                      renderCell(c, row, refLabels, t, locale))
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {total > 0 ? (
        <Pagination basePath={basePath} currentParams={sp} total={total} page={list.page} perPage={list.perPage} pageParamKey={pageParam} />
      ) : null}

      </> : null}

      {open && canWriteEntity && entity.key === 'item-rate-books' && rateBookDrawerData ? (
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
      ) : open && canWriteEntity && entity.key === 'construction-rate-schedules' && open.row && rateScheduleScopeOptions && rateScheduleEditorData ? (
        <SetupDrawer
          key={`${entity.key}:${String(open.row?.[idColumn] ?? 'new')}`}
          entity={drawerEntity}
          row={open.row}
          members={[]}
          refOptions={refOptions}
          closeHref={closeHref}
          nestedTab={{
            key: 'schedule-rates',
            label: t('constructionRateEditor.tab'),
            content: (
              <ConstructionRateScheduleEditor row={open.row} scopeOptions={rateScheduleScopeOptions} initialData={rateScheduleEditorData} />
            ),
          }}
        />
      ) : open && (canWriteEntity || (canManage && entity.readOnly && !open.creating)) ? (
        <SetupDrawer
          key={`${entity.key}:${String(open.row?.[idColumn] ?? 'new')}`}
          entity={drawerEntity}
          row={open.row}
          members={[]}
          refOptions={refOptions}
          closeHref={closeHref}
          fixedValues={parentScope?.fixedValues ?? (fixedFilter ? { [fixedFilter.fieldKey]: fixedFilter.value } : undefined)}
          stacked={stacked}
          nestedTabs={childTabs}
          mutationBasePath={mutationBasePath}
        />
      ) : null}
    </div>
  )
}
