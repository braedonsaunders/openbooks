import { clearSetupChildren, setupNavigationKeys } from '../../../../../lib/setup/navigation'
import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatDecimal } from '../../../../../lib/money-format'
import { minorToMajor } from '../../../../../lib/setup/money-fields'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { Badge } from '@openbooks/ui'
import { requireBandsReadScope } from '@openbooks/engine/hrm/compensation'
import { RegisteredListTable } from '../../../../../components/registered-list-table'
import { ShowInactivesToggle } from '../../../../../components/show-inactives-toggle'
import { ListFilterSelect } from '../../../../../components/list-filter-select'
import { SearchInput } from '../../../../../components/search-input'
import { mergeHref, parseListParams, parsePrefixedListParams, pickString } from '../../../../../lib/list-params'
import { setupParentScope } from '../../../../../lib/setup/parent-scope'
import { setupEntityForFeatureState, setupChildEntities, resolveSetupEntityGate, setupOptionLabel, toSnake, type SetupColumn, type SetupEntity } from '../../../../../lib/setup/registry'
import { setupEntitySubsidiaryFilter } from '../../../../../lib/setup/subsidiary-scope'
import { setupEntityClientDescriptor } from '../../../../../lib/setup/types'
import { resolveDynamicSetupOptions, setupOptionsContext } from '../../../../../lib/setup/dynamic-options'
import { loadRefOptions, orderExpr } from '../../../../../lib/setup/ref-options'
import { setupReadProjection, setupReadSource } from '../../../../../lib/setup/read-shape'
import { isFeatureEnabled, subsidiaryFeatureEnabled, resolvedFeatureState } from '../../../../../lib/features'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'
import { NewSetupButton, SetupDrawer } from '../../../../../components/viewspec/native-widgets.client'
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
  minorUnits?: Record<string, number>,
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
    case 'money': {
      if (raw == null || raw === '') return '—'
      // Storage minors render as operator majors with the code beside them.
      // An unknown precision names its units instead of guessing a figure.
      const code = String(row[toSnake(col.currencyField ?? 'currency')] ?? '')
      const exponent = code ? minorUnits?.[code.toUpperCase()] : undefined
      const minorNote = t('moneyMinorUnitsNote')
      if (exponent === undefined) return `${String(raw)} ${code} (${minorNote})`.trim()
      const major = minorToMajor(raw as string | number, exponent)
      if (major == null) return `${String(raw)} ${code} (${minorNote})`.trim()
      return `${formatDecimal(locale, major, { minimumFractionDigits: exponent, maximumFractionDigits: exponent })} ${code}`.trim()
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
export function setupRecordTabs({ entity, row, orgId, actorId, sp, basePath, canManage, allowedSubsidiaryIds, features, t, mutationBasePath, navigationPrefix }: {
  mutationBasePath?: string
  navigationPrefix?: string
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
  const navigation = setupNavigationKeys(navigationPrefix)
  return (entity.recordChildren ?? setupChildEntities(entity.key))
    .filter((child) => resolveSetupEntityGate(child, features).enabled)
    .map((child) => {
      const binding = child.parentRecords!.find((owner) => owner.entityKey === entity.key)!
      const scopeKey = child.fields.find((field) => field.key === binding.fieldKey)?.refScopeField
      const scopeField = child.fields.find((field) => field.key === scopeKey && field.kind === 'ref')
      const ownerScopeField = entity.fields.find((field) => field.key === scopeKey && field.kind === 'ref' && field.ref === scopeField?.ref)
      const scopeValue = scopeKey && ownerScopeField ? row[toSnake(scopeKey)] ?? row[scopeKey] : undefined
      // A child of a scoped reference inherits that scope from its owning
      // record. Choosing it again could create a contradictory relationship.
      const inheritedFilter = scopeField && typeof scopeValue === 'string' && scopeValue
        ? { fieldKey: scopeField.key, value: scopeValue } : undefined
      return {
        key: child.key,
        label: t(child.titleKey ?? `entities.${child.key}.title`),
        content: pickString(sp[navigation.tab]) === child.key ? (
          <SetupEntitySection
            entity={{ ...child, ...(entity.readOnly ? { readOnly: true } : {}), columns: child.columns.filter((column) => column.key !== binding.fieldKey) }}
            orgId={orgId}
            actorId={actorId}
            searchParams={sp}
            basePath={basePath}
            canManage={canManage}
            allowedSubsidiaryIds={allowedSubsidiaryIds}
            parent={{ recordKey: entity.key, value: String(row[binding.valueKey ?? entity.idColumn ?? 'id']) }}
            fixedFilter={inheritedFilter}
            rowParam={navigation.childRow}
            paramPrefix={navigation.childPrefix}
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
  detailsLabel,
  recordTitle,
  additionalRecordTabs = [],
  groupRuleTabs = false,
  ruleDetailsLabel,
  childTabIntroductions,
  contained = false,
}: {
  entity: SetupEntity;
  /** Host program work areas share the persisted native record's drawer shell. */
  additionalRecordTabs?: { key: string; label: string; content: React.ReactNode }[]
  detailsLabel?: string
  groupRuleTabs?: boolean
  ruleDetailsLabel?: string
  /** Context remains inside the owning child tab alongside its native editor. */
  childTabIntroductions?: Record<string, React.ReactNode>
  recordTitle?: string
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
  /** A module work area pins its controls and scrolls only the records. */
  contained?: boolean
}) {
  const multiCurrency = await isFeatureEnabled(orgId, 'multiCurrency')
  const gated = setupEntityForFeatureState(baseEntity, {
    multiSubsidiary: await subsidiaryFeatureEnabled(orgId),
    equipment: await isFeatureEnabled(orgId, 'equipment'),
    fieldTickets: await isFeatureEnabled(orgId, 'fieldTickets'),
    einvoicing: await isFeatureEnabled(orgId, 'einvoicing'),
  })
  const scopedEntity = gated.key === 'item-rate-books' && !multiCurrency
    ? { ...gated, fields: gated.fields.filter((field) => field.key !== 'currency') }
    : gated
  const entity = resolveDynamicSetupOptions(scopedEntity, await setupOptionsContext(orgId, scopedEntity))
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
  const listOptions = { sort: 'default', dir: 'asc' as const, allowedSorts: ['default', ...entity.columns.map((column) => column.key)], perPage: 25 }
  const list = paramPrefix ? parsePrefixedListParams(sp, paramPrefix, listOptions) : parseListParams(sp, listOptions)
  const parentScope = setupParentScope(entity, parent)
  const children = entity.recordChildren ?? setupChildEntities(entity.key)
  const closeParams = new URLSearchParams()
  for (const [key, value] of Object.entries(sp)) {
    const scalar = pickString(value)
    if (scalar !== undefined) closeParams.set(key, scalar)
  }
  closeParams.delete(rowParam)
  if (children.length) {
    closeParams.delete(setupNavigationKeys(paramPrefix).tab)
    clearSetupChildren(closeParams, paramPrefix)
  }
  const closeHref = mergeHref(basePath, Object.fromEntries(closeParams), {})

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
  // The same employer lens applies to standalone and nested band history.
  const bandScope = entity.key === 'hrm-pay-bands'
    ? await requireBandsReadScope(orgId, actorId ?? '') : null
  const bandPredicate = bandScope === null ? sql`` : sql`and
    (employer_subsidiary_id is null or employer_subsidiary_id = any(${`{${[...bandScope].join(',')}}`}::uuid[]))`
  const rowFilter = sql`where 1 = 1
    ${inheritedScope}
    ${bandPredicate}
    ${fixedPredicate}
    ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
    ${parentScope ? sql`and ${parentScope.predicate}` : sql``}
    ${entity.hasActive && !showInactive ? sql`and is_active` : sql``}
    ${visibleRowIds !== undefined ? sql`and ${sql.raw(idColumn)} = any (${`{${[...visibleRowIds].join(',')}}`}::uuid[])` : sql``}
    ${filterClauses.length ? sql.join(filterClauses, sql` `) : sql``}
    ${list.q && searchColumns.length ? sql`and (${sql.join(searchColumns, sql` or `)})` : sql``}`

  const refOptions = await loadRefOptions(entity, orgId, allowedSubsidiaryIds)
  const sortedColumn = entity.columns.find((column) => column.key === list.sort)
  const sortField = sortedColumn ? sql.raw(toSnake(sortedColumn.key)) : undefined
  const sortLabels = sortedColumn?.ref ? refOptions[sortedColumn.ref] ?? [] : []
  // Reference columns sort by their authorized display labels, not opaque ids.
  const sortValue = sortField && sortLabels.length ? sql`case ${sql.join(sortLabels.map((option) =>
    sql`when cast(${sortField} as text) = ${option.value} then ${option.label}`), sql` `)}
    else cast(${sortField} as text) end` : sortField
  const order = sortValue ? sql`${sortValue} ${sql.raw(list.dir)} nulls last, ${sql.raw(idColumn)}`
    : sql`${sql.raw(orderExpr(entity))}, ${sql.raw(idColumn)}`
  const [rowsRes, countRes] = await Promise.all([
    drawerOnly ? Promise.resolve({ rows: [] }) : db.execute(sql`
      select ${setupReadProjection(entity)} from ${setupReadSource(entity)} ${rowFilter}
       order by ${order}
       limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
    drawerOnly ? Promise.resolve({ rows: [] }) : db.execute(sql`select count(*)::int as n from ${sql.raw(entity.table)} ${rowFilter}`),
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
  // Authoritative precisions for money columns, from the currency options
  // resolved beside the rows — the same map the drawer converts with.
  const currencyMinorUnits: Record<string, number> = {}
  for (const option of refOptions.currencies ?? []) {
    if (typeof option.minorUnits === 'number') currencyMinorUnits[option.value] = option.minorUnits
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
             ${bandPredicate}
             ${fixedPredicate}
             ${visibleRowIds !== undefined ? sql`and ${sql.raw(idColumn)} = any (${`{${[...visibleRowIds].join(',')}}`}::uuid[])` : sql``}
             limit 1`)
          return selected.rows[0] ? { creating: false, row: selected.rows[0] } : null
        })()
    : null

  const features = children.length ? await resolvedFeatureState(orgId) : {}
  const childTabs = setupRecordTabs({
    navigationPrefix: paramPrefix,
    entity, row: open?.row ?? null, orgId, actorId, sp, basePath,
    canManage, allowedSubsidiaryIds, features, t, mutationBasePath,
  }).map(tab => childTabIntroductions?.[tab.key] && tab.content ? {
    ...tab,
    content: <div className="space-y-6">{childTabIntroductions[tab.key]}{tab.content}</div>,
  } : tab)

  const rateBookDrawerData = open && entity.key === 'item-rate-books'
    ? await (async () => {
        const bookId = open.row ? String(open.row.id) : null
        const [versionResult, itemsResult, orgResult] = await Promise.all([
          bookId
            ? db.execute<{ id: string; effective_from: string; effective_to: string | null; labor_derivation_policy: 'explicit' | 'time_type_multipliers' | null }>(sql`
                select v.id, v.effective_from, v.effective_to, p.derivation_policy as labor_derivation_policy
                  from item_rate_versions v
                  left join labor_rate_version_policies p on p.org_id = v.org_id and p.version_id = v.id
                 where v.org_id = ${orgId} and v.rate_book_id = ${bookId} and v.status = 'active'
                 order by v.effective_from desc
                 limit 1`)
            : Promise.resolve({ rows: [] as { id: string; effective_from: string; effective_to: string | null; labor_derivation_policy: 'explicit' | 'time_type_multipliers' | null }[] }),
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
          latestEffectiveTo: version?.effective_to ? String(version.effective_to).slice(0, 10) : null,
          latestLaborDerivationPolicy: version?.labor_derivation_policy ?? null,
          lines: linesResult.rows.map((line): RateBookLine => ({
            itemId: String(line.item_id),
            unitCode: String(line.unit_code),
            unitName: String(line.unit_name),
            baseQuantity: String(line.base_quantity),
            costRate: line.cost_rate == null ? '' : String(line.cost_rate),
            billRate: line.bill_rate == null ? '' : String(line.bill_rate),
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
    <div className={contained ? 'flex h-full min-h-0 flex-col gap-4' : 'space-y-4'}>
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
      <div className="flex shrink-0 flex-wrap items-center gap-2">
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

      <div className={contained ? 'min-h-0 flex-1 overflow-hidden' : undefined}>
        <RegisteredListTable<Record<string, unknown>>
          source="setup_configuration_records"
          contained={contained}
          rows={rows}
          rowKey={(row) => String(row[idColumn])}
          empty={t('empty')}
          state={{ total, page: list.page, perPage: list.perPage }}
          basePath={basePath}
          currentParams={sp}
          pageParamKey={pageParam}
          sort={list.sort} dir={list.dir}
          sortParamKey={paramPrefix ? `${paramPrefix}Sort` : 'sort'}
          dirParamKey={paramPrefix ? `${paramPrefix}Dir` : 'dir'}
          searchable={false}
          showPerPage={false}
          columns={entity.columns.map((column, index) => ({
            key: column.key,
            sortKey: column.key,
            align: ['number', 'money', 'percent'].includes(column.kind) ? 'right' as const : 'left' as const,
            header: t(column.labelKey ?? `fields.${column.key}`),
            cell: (row) => {
              const content = renderColumn?.(column, row) ??
                renderCell(column, row, refLabels, t, locale, currencyMinorUnits)
              return (canWriteEntity || (canManage && entity.readOnly)) && (index === 0 || entity.key === 'item-rate-books') ? (
                <Link href={mergeHref(basePath, sp, { [rowParam]: String(row[idColumn]) })}
                  className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                  {content}
                </Link>
              ) : content
            },
          }))}
        />
      </div>

      </> : null}

      {open && canWriteEntity && entity.key === 'item-rate-books' && rateBookDrawerData ? (
        <RateBookDrawer
          row={open.row as Record<string, unknown> | null}
          latestEffectiveFrom={rateBookDrawerData.latestEffectiveFrom}
          latestEffectiveTo={rateBookDrawerData.latestEffectiveTo}
          latestLaborDerivationPolicy={rateBookDrawerData.latestLaborDerivationPolicy}
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
          navigationPrefix={paramPrefix}
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
          navigationPrefix={paramPrefix}
          row={open.row}
          members={[]}
          refOptions={refOptions}
          closeHref={closeHref}
          fixedValues={parentScope || fixedFilter ? {
            ...parentScope?.fixedValues,
            ...(fixedFilter ? { [fixedFilter.fieldKey]: fixedFilter.value } : {}),
          } : undefined}
          stacked={stacked}
          nestedTabs={groupRuleTabs ? additionalRecordTabs : [...childTabs, ...additionalRecordTabs]}
          ruleTabs={groupRuleTabs ? childTabs : undefined}
          ruleDetailsLabel={ruleDetailsLabel}
          detailsLabel={detailsLabel}
          recordTitle={recordTitle}
          mutationBasePath={mutationBasePath}
        />
      ) : null}
    </div>
  )
}
